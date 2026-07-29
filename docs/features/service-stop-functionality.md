# Service Stop Functionality Improvement Plan

**Status:** Cancelled (used alternative approach)
**Priority:** High
**Scope:** Backend process lifecycle, Tailnet-aware shutdown, lifecycle logs, dashboard stop feedback, SourceManager application shutdown
**Related files:** `src/services/processManager.ts`, `src/services/tailscale.ts`, `src/index.ts`, `src/routes/repos.ts`, `src/types.ts`, `frontend/src/api/types.ts`, `frontend/src/components/*`, `tests/vitest/processManager.test.ts`, `tests/vitest/routes/repos.test.ts`, `frontend/src/__tests__/*`
**Alternative:** [Preserve Managed Services and Reconcile on Startup](./service-persistence-and-startup-reconciliation.md)

---

## Objective

Make SourceManager stop managed services reliably and visibly.

The dashboard already gives useful start feedback by moving services to `starting` while the backend waits for readiness, then `running` when the health check passes. Stop should behave the same way:

1. Move the service to `stopping` immediately after a stop is accepted.
2. Attempt to terminate all process ownership related to the service, including child or external PIDs still listening on the configured port.
3. Verify the service is actually down before reporting `stopped`.
4. Keep actionable logs when a stop cannot be completed.
5. Surface stop failure detail in the API response and frontend.
6. Drain an advertised named Tailscale Service before its local process is stopped.
7. When SourceManager itself shuts down, gracefully drain Tailnet support and stop only the local services that SourceManager currently tracks.

This plan is the **stop-on-shutdown** alternative. A separate plan evaluates
leaving managed services and their Tailnet advertisements running while
SourceManager is offline, then reconciling them when SourceManager starts again.

---

## Current Observations

The initial diagnosis was performed against the active SourceManager checkout on 2026-05-25.

### Evidence from logs

`data/logs/requests-2026-05-25.ndjson` contains successful-looking stop requests for services that still appeared alive afterward:

| Service | Endpoint | Timestamp | HTTP status |
|---|---|---:|---:|
| `devplanner-web` | `POST /v1/repos/devplanner/services/devplanner-web/stop` | `2026-05-25T23:36:11Z` | 200 |
| `devplanner-web` | `POST /v1/repos/devplanner/services/devplanner-web/stop` | `2026-05-25T23:36:53Z` | 200 |
| `lmapi-api` | `POST /v1/repos/lmapi/services/lmapi-api/stop` | `2026-05-25T23:37:14Z` | 200 |

`data/state.json` only retained `devplanner-api` at the time of diagnosis, even though port checks showed other managed service ports still listening.

Live port listeners observed with `netstat -ano -p TCP` included:

| Port | Service | Listener PID |
|---:|---|---:|
| 5173 | `devplanner-web` | 40632 |
| 17100 | `lmapi-api` | 12580 |
| 17103 | `devplanner-api` | 38696 |
| 17106 | `sourcemanager-api` | 33144 |

### Working theory

`ProcessManager.stop(serviceId)` currently kills only the PID stored in SourceManager state and then deletes that state immediately. For npm/Vite-style dev scripts, the tracked package-manager process may not be the process that owns the configured port. A child process can continue listening after the parent is killed.

Once state is deleted, `buildLifecycle()` treats the service as untracked and runs a health check. If the child process still answers, the service is reported as `running` with `pid: null`. This makes the frontend look like stop did not work, while the backend has already discarded the PID it tried to kill.

DevPlanner API likely works because its tracked Bun process owns the server directly. DevPlanner frontend and LMApi likely fail because the tracked package-manager process differs from the long-lived port owner.

---

## Current Stop Behavior

Current backend flow:

```ts
async stop(serviceId: string): Promise<StopResult> {
  const state = this.processes.get(serviceId)
  if (!state) {
    return { success: true, alreadyStopped: true, message: `Service "${serviceId}" was not running` }
  }

  const result = await this.killPid(state.pid)
  this.processes.delete(serviceId)
  this.portMap.delete(state.port)
  await this.saveState()

  if (!result.success) {
    return { success: false, alreadyStopped: false, message: `Stop attempted but may have failed: ${result.error}` }
  }
  return { success: true, alreadyStopped: false, message: `Stopped "${serviceId}" (PID ${state.pid})` }
}
```

Problems:

1. No `stopping` state exists.
2. Stop accepts only `serviceId`, so it cannot reliably check `service.port` or `service.healthUrl` for untracked services.
3. State is deleted before stop verification.
4. The stop result does not include diagnostics.
5. The route returns HTTP 200 even when stop verification may have failed.
6. Lifecycle attempts are not logged to `runs-*.ndjson`.
7. Untracked-but-healthy services are reported as already stopped even if a port listener is still alive.
8. The frontend has no durable stop-progress state; it only shows a local button spinner while the request is pending.

---

## Desired State Machine

Add `stopping` as a first-class lifecycle state.

```text
[stopped]
    |
    | POST /start
    v
[starting] ---- health passes ----> [running]
    |                                |
    | health timeout / exit          | POST /stop
    v                                v
[failed]                         [stopping]
                                     |
                                     | stop verified
                                     v
                                  [stopped]
                                     |
                                     | stop timeout / kill failure
                                     v
                                  [failed]
```

State meanings:

| State | Meaning |
|---|---|
| `starting` | Process has been spawned and readiness polling is in progress. |
| `running` | Health check passed and the service is considered ready. |
| `stopping` | Stop was accepted and SourceManager is trying to terminate the tracked PID and any configured port listener. |
| `stopped` | Service is not tracked and its health/port check is not passing. |
| `failed` | A lifecycle operation failed and `lastError` contains the reason. |

---

## Backend Implementation Plan

### Step 1: Add lifecycle type support for `stopping`

Modify:

- `src/types.ts`
- `frontend/src/api/types.ts`
- `docs/openapi.yaml`
- `docs/SPECIFICATION.md`
- `frontend/src/components/LifecycleBadge.tsx`
- `frontend/src/components/LifecycleBadge.module.css`
- dashboard count helpers in `frontend/src/components/RepoList.tsx`

Change:

```ts
export type LifecycleState = "starting" | "running" | "stopping" | "stopped" | "failed"
```

Backend startup restore behavior:

- If persisted state is `starting`, mark `failed` with `lastError: "SourceManager restarted while service was starting"`.
- If persisted state is `stopping`, mark `failed` with `lastError: "SourceManager restarted while service was stopping"`.
- If persisted state is `running`, keep it only if its PID is alive.
- If PID is stale, prune the state as today.

### Step 2: Change stop API to use service config

Change `ProcessManager.stop(serviceId)` to `ProcessManager.stop(service)`.

Reason:

- The stop flow needs `service.id`, `service.port`, and `service.healthUrl`.
- It must handle untracked services that are still healthy or still listening on the configured port.

Expected route change:

```ts
const { service } = requireService(params.serviceId)
const result = await processManager.stop(service)
```

`restart(repo, service)` should call `await this.stop(service)`.

### Step 3: Represent stop diagnostics

Add typed stop result and diagnostics:

```ts
interface StopAttempt {
  target: "tracked-pid" | "port-pid"
  pid: number
  success: boolean
  error?: string
}

interface StopDiagnostics {
  code?:
    | "SERVICE_STOP_VERIFICATION_FAILED"
    | "SERVICE_STOP_KILL_FAILED"
    | "SERVICE_STOP_PORT_STILL_LISTENING"
  serviceId: string
  port: number
  trackedPid?: number
  portPidBefore?: number | null
  portPidAfter?: number | null
  attempts: StopAttempt[]
  message: string
}

interface StopResult {
  success: boolean
  alreadyStopped: boolean
  message: string
  lifecycleState?: LifecycleState
  diagnostics?: StopDiagnostics
}
```

### Step 4: Add a verified stop flow

Proposed flow:

1. Read current tracked state for `service.id`.
2. Find the current PID listening on `service.port`.
3. If no tracked state and no port PID:
   - Optionally run a health check.
   - If health fails, return `alreadyStopped: true`.
   - If health passes but port PID was not found, return failure with diagnostics because SourceManager cannot identify what to kill.
4. If tracked state exists:
   - Set lifecycle to `stopping`.
   - Persist state immediately.
5. If no tracked state but port PID exists:
   - Create a temporary tracked state with `lifecycleState: "stopping"` if enough metadata is available, or keep diagnostics-only. Prefer temporary state so the frontend can show `stopping`.
6. Kill the tracked PID if present.
7. Re-check the port.
8. If a port PID still exists and differs from the tracked PID, kill the port PID.
9. Poll until stop is verified.
10. On success:
    - Delete service state.
    - Delete `portMap` entry for the port.
    - Save state.
    - Return success with `lifecycleState: "stopped"`.
11. On failure:
    - Keep or set state to `failed`.
    - Set `lastError` to a concise diagnostic message.
    - Save state.
    - Return `success: false` with diagnostics.

### Step 5: Define stop verification

Stop is verified when both conditions are true:

1. No process is listening on `service.port`.
2. `checkHealth(service)` returns `fail`.

Recommended timeout:

```ts
const STOP_POLL_INTERVAL_MS = 250
const STOP_POLL_TIMEOUT_MS = 5_000
```

Polling should collect the last observed values:

- last port PID
- last health status
- last health detail

This prevents generic messages like "stop failed" and allows useful messages like:

```text
Stop verification failed for "lmapi-api": port 17100 is still listening on PID 12580 after 5000ms
```

### Step 6: Improve PID termination on Windows

Current kill logic uses `process.kill(pid, "SIGTERM")`, waits 500ms, then `SIGKILL`.

For Windows child-process trees, consider a narrow platform-specific fallback:

```text
taskkill /PID <pid> /T /F
```

Use this only after the normal kill path does not stop the process. The PID must be numeric and must come from SourceManager state or `netstat`, not user input.

Implementation guidance:

- Keep `killPid(pid)` as the common entry point.
- Add an internal `_killProcessTree(pid)` helper for Windows.
- Make this overridable in tests.
- Do not use a generic shell command string if a direct process invocation can be used.
- Log whether normal kill or process-tree kill was used.

### Step 7: Handle untracked but running services

When a service has no tracked state, `buildLifecycle()` can still report `running` if health passes. Stop must be able to handle that case.

Required behavior:

- If no tracked state but `findPidOnPort(service.port)` returns a PID, stop should attempt to kill that port PID.
- The response should not say `alreadyStopped: true`.
- The diagnostics should mark the attempt as `target: "port-pid"`.

This is especially important after a failed prior stop, SourceManager restart, or when a dev server was started outside SourceManager.

### Step 8: Preserve state until stop verification completes

Do not delete state immediately after sending a kill signal.

Instead:

1. Set `stopping`.
2. Attempt kill(s).
3. Verify down.
4. Delete state only after verification succeeds.

This gives the frontend a stable signal to display and prevents SourceManager from losing diagnostic context during stop.

### Step 9: Update route response semantics

Modify `POST /v1/repos/:repoId/services/:serviceId/stop`:

- Return HTTP 200 when stop succeeds or is truly already stopped.
- Return HTTP 500 or 409 when stop cannot be verified.

Recommended response body:

```json
{
  "serviceId": "lmapi-api",
  "repoId": "lmapi",
  "success": false,
  "alreadyStopped": false,
  "message": "Stop verification failed for \"lmapi-api\": port 17100 is still listening on PID 12580",
  "diagnostics": {
    "code": "SERVICE_STOP_VERIFICATION_FAILED",
    "serviceId": "lmapi-api",
    "port": 17100,
    "trackedPid": 12345,
    "portPidBefore": 12580,
    "portPidAfter": 12580,
    "attempts": [
      { "target": "tracked-pid", "pid": 12345, "success": true },
      { "target": "port-pid", "pid": 12580, "success": false, "error": "Access denied" }
    ],
    "message": "port still listening after timeout"
  },
  "lifecycle": {
    "state": "failed",
    "lastError": "Stop verification failed: port 17100 still listening on PID 12580"
  }
}
```

### Step 10: Add lifecycle logging for stop attempts

The existing `data/logs/runs-*.ndjson` mostly captures update runs. Stop attempts need durable logs too.

Options:

1. Extend `RunReport` to include a `kind: "update" | "start" | "stop" | "restart"` field.
2. Create a new lifecycle log type and write to the same `runs-*.ndjson` file.
3. Create a separate `lifecycle-YYYY-MM-DD.ndjson` file.

Recommended approach for minimal disruption:

- Add a new `LifecycleRunReport` type.
- Add `logLifecycleRun(report)` to `src/services/runLogger.ts`.
- Write to `runs-YYYY-MM-DD.ndjson` if `readRecentLogs()` can safely parse/filter both update and lifecycle entries, or to `lifecycle-YYYY-MM-DD.ndjson` if mixed schemas are too disruptive.

Suggested lifecycle log shape:

```ts
interface LifecycleRunReport {
  kind: "lifecycle"
  action: "start" | "stop" | "restart"
  runId: string
  serviceId: string
  repoId: string
  startedAt: string
  durationMs: number
  status: "success" | "failure" | "skipped"
  reason: string
  steps: StepResult[]
  diagnostics?: Record<string, unknown>
}
```

Stop log steps should include:

| Step | Success message | Failure message |
|---|---|---|
| `inspect` | tracked PID and port PID found | unable to inspect port |
| `mark-stopping` | lifecycle set to stopping | state save failed |
| `kill-tracked-pid` | tracked PID killed or already exited | kill failed |
| `kill-port-pid` | port PID killed or no extra PID | kill failed |
| `verify-stopped` | health failed and port free | health still passes or port still listening |

### Step 11: Improve console logging

Add clear console logs for:

- stop request accepted
- tracked PID before stop
- port PID before stop
- each kill attempt and result
- verification result
- failure diagnostics

Example:

```text
[ProcessManager] Stopping "lmapi-api": tracked PID 12345, port 17100 PID 12580
[ProcessManager] Kill tracked PID 12345 for "lmapi-api": success
[ProcessManager] Kill port PID 12580 for "lmapi-api": failed: Access denied
[ProcessManager] Stop verification failed for "lmapi-api": port 17100 still listening on PID 12580
```

### Step 12: Centralize Tailnet-aware service shutdown

The repository already calls `prepareTailscaleForStop()` before individual stop
and restart routes. Move that ordering into a shared lifecycle coordinator so
routes, update-triggered restarts, and application shutdown cannot accidentally
bypass it.

For each configured service stop:

1. Inspect the observed Tailscale Serve configuration, rather than relying only
   on the saved `tailscaleServiceEnabled` value.
2. If the named Service is advertised, run
   `tailscale serve drain svc:<name>` and await acknowledgement.
3. Immediately begin the existing verified local stop after drain completes.
4. Preserve the endpoint configuration and saved desired-enabled state so a
   later healthy start can advertise it again.
5. If drain fails, attempt to remove only that Service's configured HTTPS
   endpoint, record a structured cleanup warning, and continue the local stop.
6. Never invoke `tailscale serve reset`.

A Tailnet failure must not prevent local lifecycle control. The stop response
and lifecycle log must distinguish:

- local stop success with Tailnet cleanup success
- local stop success with a Tailnet cleanup warning
- local stop failure with or without a Tailnet cleanup warning

### Step 13: Add coordinated SourceManager application shutdown

Add one idempotent application shutdown coordinator used by:

- the SourceManager service card's Stop toggle
- `SIGINT`, including Ctrl+C
- `SIGTERM`

The coordinator must:

1. Mark application state as `shutting_down` and reject new lifecycle, update,
   and Tailnet mutations with `503 SOURCE_MANAGER_SHUTTING_DOWN`.
2. Snapshot only processes currently tracked by `ProcessManager`. Do not stop
   externally started or merely healthy configured services during whole-app
   shutdown.
3. Resolve each tracked process to its service configuration.
4. Run service cleanup pipelines concurrently, while preserving Tailnet drain
   before local process termination within each pipeline.
5. Drain SourceManager's own named Tailnet Service after a UI self-stop response
   has been accepted and before closing the HTTP server. Identify the self
   service by its configured port matching `server.port`; never pass its own PID
   through the ordinary `ProcessManager.stop()` path.
6. Continue all remaining cleanup after an individual Tailnet or process error.
7. Write one structured shutdown summary and close the Elysia server.
8. Enforce a 15-second overall deadline. Log incomplete work, close active HTTP
   connections, and exit when the deadline expires.
9. Treat a second shutdown signal as an immediate forced exit.

The root development command currently gives `concurrently` only a three-second
kill timeout. Increase it to at least 20 seconds when implementing this option
so the backend can use its 15-second cleanup window before the launcher forces
termination.

For the SourceManager service card, the existing stop endpoint becomes a
special self-stop contract:

```json
{
  "serviceId": "sourcemanager-api",
  "success": true,
  "shutdownAccepted": true,
  "message": "SourceManager is shutting down",
  "application": {
    "state": "shutting_down",
    "phase": "accepted"
  },
  "lifecycle": {
    "state": "stopping"
  }
}
```

Return this response with HTTP `202 Accepted`, then schedule cleanup after the
response can be flushed. Ordinary managed-service stops remain synchronous.
SIGKILL, power loss, and other non-catchable termination remain outside the
graceful-shutdown guarantee.

---

## Frontend Implementation Plan

### Step 1: Add `stopping` badge support

Modify:

- `frontend/src/api/types.ts`
- `frontend/src/components/LifecycleBadge.tsx`
- `frontend/src/components/LifecycleBadge.module.css`
- `frontend/src/__tests__/LifecycleBadge.test.tsx`

Add a `stopping` label and style. Use an amber or neutral active style distinct from `starting`.

Suggested label:

```text
stopping
```

### Step 2: Update service card action rules

Modify `frontend/src/components/ServiceCard.tsx`.

Recommended behavior:

| State | Toggle button | Restart | Update |
|---|---|---|---|
| `running` | Stop enabled | enabled | enabled |
| `starting` | Stop enabled | disabled | disabled |
| `stopping` | Stop disabled/loading | disabled | disabled |
| `stopped` | Start enabled | disabled | enabled |
| `failed` | Start enabled | disabled | enabled |

Implementation details:

- `isRunning` should remain true for `running` and `starting`.
- Add `isStopping = state === "stopping"`.
- Toggle label for `stopping` can remain "Stop service", but disabled/loading.
- Do not allow duplicate stop requests while the server reports `stopping`.

### Step 3: Make stop feedback survive request completion

Today `pendingAction` only lasts until the HTTP request returns. If the backend returns quickly while shutdown continues in the background, the button spinner disappears too early.

Preferred backend behavior is to await stop verification before responding. If stop verification stays synchronous, frontend local pending state is enough.

If the backend later makes stop asynchronous, then the frontend should:

- Optimistically update the service to `stopping`, or
- Rely on the returned `lifecycle` object and immediately refresh, then poll more frequently until final state.

For this implementation, keep stop synchronous up to a short timeout and use returned lifecycle plus `fetchRepos()`.

### Step 4: Update summary counts

Modify `frontend/src/components/RepoList.tsx`.

Options:

1. Add `stopping` as a visible count beside running/starting/stopped/failed.
2. Include `stopping` in the existing "Attention" metric with `starting` and `failed`.

Recommended:

- Add `stopping` to per-project counts so the user can see exactly what is happening.
- Keep top-level "Attention" as `failed + starting + stopping`.

### Step 5: Surface stop diagnostics in the card

The frontend `ApiError` already includes detailed response messages. Ensure stop failures appear under the service card via the existing `actionError` area.

If the response includes `diagnostics`, the API client message should include:

- response `message`
- response `diagnostics.code`
- concise error details

Do not dump large diagnostics objects into visible UI. Keep full details in `console.error`.

### Step 6: Show SourceManager application shutdown

Expose additive application `state` and `phase` fields from `/health`. When
self-stop is accepted or polling observes `shutting_down`, the dashboard must:

- show a persistent **SourceManager is shutting down** banner
- disable all lifecycle, update, and Tailnet actions
- stop ordinary refresh errors from replacing the shutdown message
- treat the eventual network disconnect as expected

---

## Test Plan

### Backend unit tests

Add to `tests/vitest/processManager.test.ts`.

Required tests:

1. `stop()` returns `alreadyStopped: true` when no tracked state, no port PID, and health fails.
2. `stop()` sets lifecycle to `stopping` before attempting kills.
3. `stop()` kills the tracked PID for a tracked running service.
4. `stop()` does not delete state until verification succeeds.
5. `stop()` deletes state after port is free and health fails.
6. `stop()` kills a different port PID after killing the tracked PID.
7. `stop()` stops an untracked service by killing the PID found on the configured port.
8. `stop()` returns failure diagnostics when the port is still listening after timeout.
9. `stop()` stores `lastError` when verification fails.
10. `restart()` calls the new `stop(service)` signature before `start(repo, service)`.
11. `init()` converts persisted `stopping` state to `failed` with a restart-related `lastError`.

Useful test hooks:

- `_isProcessAlive`
- `_findPidOnPort`
- `_checkHealth`
- `_spawnProcess`
- Add `_killPid` or `_killProcessTree` as an overridable dependency if needed.

### Backend route tests

Add to `tests/vitest/routes/repos.test.ts`.

Required tests:

1. Stop route passes the full service to `processManager.stop`.
2. Stop route returns `lifecycle` in the response.
3. Stop route returns HTTP 200 for successful stop.
4. Stop route returns HTTP 200 for truly already-stopped service.
5. Stop route returns HTTP 500 or 409 for stop failure.
6. Stop failure response includes `diagnostics`.

### Frontend tests

Add or update:

- `frontend/src/__tests__/LifecycleBadge.test.tsx`
- `frontend/src/__tests__/ServiceCard.test.tsx`
- `frontend/src/__tests__/RepoList.test.tsx`
- `frontend/src/__tests__/client.test.ts`

Required tests:

1. `LifecycleBadge` renders `stopping`.
2. `ServiceCard` disables lifecycle actions while state is `stopping`.
3. `ServiceCard` shows stop action errors.
4. `RepoList` count helpers include `stopping`.
5. API client error detail includes stop failure message and diagnostics code when present.
6. SourceManager self-stop handles HTTP 202 and shows the shutdown banner.
7. All mutations are disabled after application shutdown is accepted.
8. The expected disconnect does not replace the shutdown banner with a generic API error.

### Application shutdown tests

Add focused coordinator and signal-handler tests:

1. Individual stop drains observed Tailnet advertisement before local stop.
2. A non-advertised or non-Tailnet service skips Tailnet commands.
3. Drain failure attempts service-specific endpoint cleanup and still calls local stop.
4. Normal drain preserves endpoint configuration and desired-enabled state.
5. Whole-app shutdown stops tracked services only.
6. Tracked service pipelines run concurrently while maintaining per-service ordering.
7. Self-stop returns HTTP 202 before cleanup and never kills the request-handling PID.
8. Repeated shutdown requests share one in-flight shutdown operation.
9. A second signal forces immediate exit.
10. The 15-second deadline records incomplete cleanup and exits.
11. Mutating endpoints return `503 SOURCE_MANAGER_SHUTTING_DOWN` during cleanup.
12. The structured shutdown report contains Tailnet and process failures without secrets.

---

## Manual Verification Plan

Run on the active Windows dev machine.

### Pre-change baseline

Capture current state:

```powershell
cd C:\LocalDev\Projects\SourceManager
type data\state.json
rg -n "/stop|/start|lmapi|devplanner-web" data\logs
netstat -ano -p TCP
```

Record the PIDs listening on:

- 5173 (`devplanner-web`)
- 17100 (`lmapi-api`)
- 17103 (`devplanner-api`)

### After implementation

1. Start SourceManager normally.
2. Start `devplanner-web` from the dashboard.
3. Confirm state transitions:
   - `stopped` -> `starting` -> `running`
4. Stop `devplanner-web` from the dashboard.
5. Confirm state transitions:
   - `running` -> `stopping` -> `stopped`
6. Confirm no listener remains:

```powershell
netstat -ano -p TCP | findstr :5173
```

7. Start `lmapi-api` from the dashboard.
8. Stop `lmapi-api` from the dashboard.
9. Confirm no listener remains:

```powershell
netstat -ano -p TCP | findstr :17100
```

10. Check lifecycle logs:

```powershell
rg -n "devplanner-web|lmapi-api|stop|SERVICE_STOP" data\logs
```

11. Confirm failed stop behavior by forcing a protected or non-killable process only if a safe test target exists. Do not kill unrelated user processes.

---

## Acceptance Criteria

Backend:

- `LifecycleState` includes `stopping`.
- Stop route uses full `ServiceConfig`, not only `serviceId`.
- Stop immediately persists `stopping` for tracked services.
- Stop attempts to kill the tracked PID.
- Stop checks the configured port after killing the tracked PID.
- Stop attempts to kill a remaining port PID when appropriate.
- Stop can handle untracked services that are still listening on their configured port.
- Stop verifies both port and health before reporting success.
- Stop failure returns non-2xx status with structured diagnostics.
- Stop failure preserves actionable `lastError`.
- Stop success deletes state only after verification succeeds.
- Stop attempts are logged durably with enough detail to diagnose failure.
- An advertised named Tailscale Service is drained before its local process is stopped.
- Tailnet cleanup failure does not prevent the local stop and is returned as a warning.
- Normal stop preserves Tailnet endpoint configuration and desired-enabled state.
- SourceManager UI self-stop, SIGINT, and SIGTERM use one idempotent shutdown coordinator.
- Whole-app shutdown stops only services tracked by SourceManager.
- SourceManager's own Tailnet advertisement is drained before its HTTP server exits.
- Whole-app shutdown is bounded to 15 seconds and a second signal exits immediately.

Frontend:

- Dashboard can render `stopping`.
- Stop button shows in-progress behavior while a service is stopping.
- Duplicate stop/restart/update actions are disabled during `stopping`.
- Summary counts include `stopping`.
- Stop errors are visible on the service card.
- Full stop diagnostics remain available in browser console/API response.
- SourceManager self-stop returns an accepted state before the API exits.
- The dashboard shows "SourceManager is shutting down" and treats disconnect as expected.

Tests:

- Backend ProcessManager tests cover tracked, untracked, child-port, success, and failure stop paths.
- Route tests cover success and failure response semantics.
- Frontend tests cover `stopping` display and disabled action behavior.
- Existing start behavior remains green.

---

## Non-goals

- Do not implement arbitrary process management outside configured services.
- Do not add a general shell execution surface.
- Do not solve SourceManager API self-restart in this work item.
- Do not add live log streaming.
- Do not redesign update/restart workflows beyond adapting them to the new stop signature.
- Do not expose environment variables or secrets in diagnostics.

---

## Suggested Implementation Order

1. Add `stopping` to backend/frontend types and badge rendering.
2. Add tests for stop behavior in `ProcessManager`.
3. Refactor `stop(serviceId)` to `stop(service)`.
4. Add stop diagnostics and verified shutdown polling.
5. Add port PID fallback for child processes.
6. Add Windows process-tree fallback if normal kill is insufficient.
7. Add lifecycle stop logging.
8. Update stop route response semantics and tests.
9. Update frontend stop UI states and tests.
10. Run targeted tests.
11. Manually verify DevPlanner API still stops.
12. Manually verify DevPlanner frontend and LMApi now stop.
13. Add the shared Tailnet-aware lifecycle coordinator.
14. Add SourceManager self-stop and SIGINT/SIGTERM coordination.
15. Add application shutdown state, logging, UI feedback, and deadline tests.

---

## Open Questions

1. Should stop failure use HTTP 500 or 409?
   - Recommendation: use 500 for kill/verification failures and reserve 409 for policy conflicts, such as a protected self-managed SourceManager API.

2. Should lifecycle logs share `runs-*.ndjson` with update logs?
   - Recommendation: use a separate lifecycle schema, but keep the same log directory and update the service logs endpoint to return both if practical.

3. Should stop be synchronous or asynchronous?
   - Recommendation: keep it synchronous with a short timeout for now. The user experience is clearer, and the frontend can display `stopping` during the request and the immediate refresh.

4. Should SourceManager kill process trees by default on Windows?
   - Recommendation: first kill the tracked PID normally, then kill remaining configured port PID, then use process-tree fallback only when needed. This keeps the blast radius tied to configured service ownership.

## Resolved Application Shutdown Decisions

1. **Tailnet stop semantics:** drain advertisement and preserve endpoint
   configuration plus desired-enabled state.
2. **Whole-app process scope:** stop only processes tracked by SourceManager.
3. **SourceManager UI stop:** return HTTP 202, then perform cleanup and exit.
4. **Deadline:** allow 15 seconds, then log incomplete work and force exit.
5. **Alternative behavior:** preserving detached services across SourceManager
   shutdown is specified separately in
   [service-persistence-and-startup-reconciliation.md](./service-persistence-and-startup-reconciliation.md).
