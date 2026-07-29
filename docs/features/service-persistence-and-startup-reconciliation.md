# Preserve Managed Services and Reconcile on Startup

**Status:** Alternative planning proposal
**Priority:** High
**Scope:** Detached process ownership, durable process output, startup reconciliation, automatic one-time recovery, persistent Tailnet advertisement
**Alternative to:** [Service Stop Functionality Improvement Plan](./service-stop-functionality.md)

---

## Objective

Simplify SourceManager application shutdown by leaving managed services and
their named Tailscale Service advertisements untouched when SourceManager exits.
Managed services should intentionally survive SourceManager, Ctrl+C, and terminal
closure. When SourceManager starts again, it must verify each saved launch
record, reconcile actual local and Tailnet status, and make one recovery attempt
for a previously running service that is no longer available.

This alternative must also preserve a future path for read-only historical and
live terminal-style output. It does not attempt to attach to terminal windows
owned by other applications or users.

---

## Feasibility and Current Implementation Comparison

The model is possible, but it is not the current guaranteed behavior.

| Concern | Current implementation | Gap for this alternative |
|---|---|---|
| Parent shutdown | Managed commands are ordinary `Bun.spawn()` children with inherited stdout/stderr | They share SourceManager's terminal/process lifetime and may receive Ctrl+C or be terminated by the launcher |
| Parent references | SourceManager retains each `Subprocess.exited` promise | No explicit detached process group or `unref()` |
| Saved state | `data/state.json` stores PID, command, port, timestamps, and lifecycle state | A live PID is trusted without verifying process identity, port ownership, and health |
| Stale saved PID | Pruned during `ProcessManager.init()` | A surviving server child may be rediscovered only as an untracked healthy service |
| Startup health | Repository summaries health-check untracked services | Reconciliation is not a single durable operation and does not classify recovered ownership or conflicts |
| Tailnet startup | Healthy desired-on services are restored; unhealthy services are drained | This alternative must not drain merely because SourceManager restarted while a service is recovering |
| Process output | Child stdout/stderr inherit the SourceManager terminal | Output cannot survive terminal closure or be replayed after SourceManager restarts |
| External process | A healthy configured port can be reported as running with `pid: null` | SourceManager cannot recover that terminal's historical or live stdout/stderr and must not claim ownership |

Windows normally sends Ctrl+C to all processes attached to the console. The
implementation must therefore use an independent process group; simply deleting
application shutdown cleanup is not sufficient.

Named Tailscale Services run in the Tailscale daemon and use background mode.
Their advertisement can remain active while SourceManager is offline. If the
local service survives, Tailnet access continues. If it dies, the advertisement
can temporarily point at a dead target until SourceManager returns and
reconciles it.

### What is already implemented

The repository already provides useful parts of this model:

- persisted service PID and lifecycle state
- stale-PID pruning during `ProcessManager.init()`
- health-based reporting for an untracked service
- startup checks that restore desired Tailnet exposure for healthy services
- verified individual service stop using tracked and configured-port PIDs

It does not yet provide detached process groups, a persistent runner, verified
launch identity, durable managed-service output, conflict classification, or the
one-attempt startup recovery state machine. The current behavior is therefore a
partial best-effort hybrid, not the preserve-on-shutdown design.

### Alternative comparison

| Decision area | Stop-on-shutdown plan | Preserve-and-reconcile plan |
|---|---|---|
| SourceManager exit | Drain Tailnet and stop tracked services | Flush SourceManager state only |
| Service continuity | Services intentionally go offline | Verified managed services remain available |
| Tailnet while SourceManager is offline | Advertisements are drained | Advertisements remain enabled |
| Process architecture | Ordinary SourceManager-owned children | Detached persistent per-service runners |
| Startup work | Prune stale state and report stopped/failed | Verify launch records, recover ownership, and attempt one restart |
| Output | Can be captured while SourceManager is alive | Durable combined output continues while SourceManager is offline |
| External healthy listener | Existing stop can control configured-port PID | Ownership conflict; never automatically adopt or kill |
| Primary risk | Shutdown cleanup can fail or time out | Stale advertisement, orphaned runner, or recovery conflict |
| Overall complexity | More shutdown orchestration | More persistent ownership and reconciliation infrastructure |

---

## Selected Behavior

1. Managed services are detached and intentionally survive SourceManager.
2. SourceManager application shutdown does not stop managed services and does
   not drain or disable their Tailnet advertisements.
3. SourceManager's own Tailnet advertisement also remains enabled. Its hostname
   is temporarily unreachable while SourceManager's local port is offline and
   becomes reachable again after startup.
4. A previously running but unavailable service receives one automatic restart
   attempt per SourceManager startup.
5. The UI reports that startup recovery is in progress.
6. SourceManager recovers ownership only from a verified prior launch record.
   It does not generically adopt an arbitrary healthy listener.
7. A healthy listener that cannot be linked to a verified launch record is a
   conflict, even if its health check passes.
8. Process output is a combined, read-only historical and live stream.

---

## Process Ownership Architecture

### Detached per-service runner

Do not detach the package-manager command directly. Add a small SourceManager
service runner that is launched once per service and becomes the stable process
ownership boundary:

```text
SourceManager
    |
    | detached spawn + unref
    v
SourceManager service runner
    |
    | ordinary child process group
    v
package manager -> application child processes
```

The runner must:

- run in a detached Windows process group with no dependency on the
  SourceManager console
- ignore stdin and avoid inherited SourceManager stdout/stderr handles
- receive a generated run manifest rather than arbitrary shell text
- spawn the configured package-manager command with argument arrays
- remain alive while the managed command or its descendants are expected to run
- capture combined stdout/stderr into durable per-run files
- rotate output while SourceManager is offline
- write an authenticated heartbeat/status record containing its run identity,
  runner PID, child PID, start time, command fingerprint, current status, last
  exit result, and active log segment
- stop its owned child process tree when an explicit authenticated stop command
  is received

The runner is an internal lifecycle helper, not a general command-execution
service and not a user-visible interactive shell.

### Verified launch record

Extend persisted process state with a versioned launch record:

```ts
interface ServiceLaunchRecord {
  version: 1
  runId: string
  serviceId: string
  repoId: string
  runnerPid: number
  childPid: number | null
  processCreatedAt: string
  commandFingerprint: string
  repoPath: string
  port: number
  healthUrl: string
  logDirectory: string
  startedAt: string
  lastVerifiedAt: string
  intendedState: "running" | "stopped"
}
```

Store runner manifests, heartbeat/status files, and control requests under a
private runtime directory beneath `data/`. Use random per-run control tokens,
restrict file permissions to the current Windows user, never return tokens from
the API, and redact them from logs.

A launch record is verified only when:

1. the saved runner PID is alive
2. the runner status has the same run ID and service ID
3. process creation identity and command fingerprint match
4. the configured listener belongs to the runner's recorded process tree
5. the configured health check passes

PID liveness alone is never sufficient because Windows can reuse PIDs.

### External-process conflicts

If port and health checks pass but no launch record can be verified:

- report lifecycle `failed`
- use diagnostic code `SERVICE_PROCESS_OWNERSHIP_CONFLICT`
- show the listener PID when safely discoverable
- explain that SourceManager did not launch or cannot verify the process
- preserve any historical logs from the prior SourceManager run as read-only
- do not stop, restart, or adopt the listener automatically

SourceManager cannot reliably attach to another terminal window's existing
stdout/stderr stream or recover its scrollback. Generic adoption would also risk
controlling and later killing the wrong process.

---

## Durable Output and Future Live Display

### Capture format

The runner combines stdout and stderr in arrival order and writes an append-only
per-run stream. Preserve ANSI escape sequences so a future terminal-style
renderer can display colors. The selected combined view does not require
separate stdout and stderr tabs.

Use:

```text
data/logs/services/<serviceId>/<runId>/
  output-0001.log
  output-0002.log
  runner-status.json
```

Requirements:

- rotate by bounded file size while the runner is active
- never rotate by renaming a file currently being tailed without publishing the
  new active segment in runner status
- retain enough segment metadata to resume after SourceManager restarts
- delete expired inactive runs using the existing log-retention policy
- never delete the active run's files
- cap total retained bytes per service and report truncation/retention events
- prevent ANSI control sequences from affecting server logs; sanitize only at
  UI rendering boundaries while preserving the stored bytes

This supersedes the pipe plus in-memory-only capture proposed in
`verify-project-statues.md`. An in-memory ring buffer may still be used as a
cache, but the durable files are the source of truth.

### Read APIs and future streaming

Plan additive interfaces:

```text
GET /v1/repos/:repoId/services/:serviceId/output
GET /v1/repos/:repoId/services/:serviceId/output/stream
```

The first endpoint returns paginated historical chunks with run ID, segment,
cursor, timestamps when available, and truncation metadata. The second uses
Server-Sent Events for read-only appended output and segment-rotation events.
SSE is sufficient because this plan does not allow terminal input.

After SourceManager restarts, it resumes tailing the active segment recorded by
the verified runner. No stdout pipe or terminal reattachment is required.

---

## Startup Reconciliation

Run reconciliation after configuration and persisted state load. API startup
should remain available, but affected services must show an explicit recovery
state until their checks finish.

For every configured service:

### Previously running with a verified runner

1. Verify the launch record and runner heartbeat.
2. Verify process-tree ownership, configured port, and health.
3. If all checks pass, restore lifecycle `running`, retain the original run ID
   and start time, and resume output tailing.
4. Inspect current Tailscale Serve configuration.
5. If the named Service remains advertised with the correct target, display it
   as enabled/connected without changing it.
6. If desired exposure is enabled but observed advertisement is missing or
   mismatched, use the existing bounded Tailnet reconciliation behavior after
   local health passes.

### Previously running but unavailable

1. Set lifecycle to `starting` with:
   - `recoveryAttempt: 1`
   - `recoveryReason: "Restoring service that was running before SourceManager exited"`
2. Ensure no verified owned process remains before starting a replacement.
3. Make exactly one automatic start attempt during this SourceManager startup.
4. Wait for the ordinary readiness check.
5. On success, persist the new verified launch record and show `running`.
6. On failure, show `failed` with `SERVICE_STARTUP_RECOVERY_FAILED`; do not retry
   again until a later SourceManager startup or explicit user Start action.
7. Leave desired Tailnet state enabled. Re-advertise or repair it only after the
   local replacement becomes healthy.

### Healthy listener without a verified record

Report `SERVICE_PROCESS_OWNERSHIP_CONFLICT`. Do not auto-restart because doing so
would require killing an unowned process or creating a port collision.

### Previously stopped

Do not auto-start. If an unowned listener is present, report the same ownership
conflict rather than silently changing intended state.

### Transitional saved state

Treat saved `starting` or `stopping` as interrupted operations. Reconcile the
runner and actual local state first:

- verified and healthy: recover as `running`
- verified but unhealthy: apply the single startup recovery attempt
- unverifiable healthy listener: ownership conflict
- no service: mark `failed` with an interrupted-operation diagnostic

---

## SourceManager Shutdown

SourceManager application shutdown becomes intentionally small:

1. Stop accepting new SourceManager requests.
2. Flush SourceManager-owned state and request/lifecycle logs.
3. Do not signal service runners.
4. Do not stop managed local processes.
5. Do not drain, disable, or rewrite managed Tailnet advertisements.
6. Close the SourceManager HTTP server and exit.

The SourceManager service card's Stop action must use a self-shutdown path that
does not call the ordinary configured-port stop logic against SourceManager's
own PID.

Ctrl+C and SIGTERM should stop SourceManager itself without propagating the
signal to detached service-runner process groups. The development launcher must
also avoid force-killing those detached groups.

This behavior must be clearly visible in the UI and README: stopping
SourceManager does not stop managed applications.

---

## Tailnet Reconciliation and UI

On SourceManager startup:

- inspect actual machine and Serve configuration before displaying Tailnet state
- show the persisted desired toggle as enabled when configured
- show `connected` when the observed advertisement and target match
- show local lifecycle `starting` plus a recovery message during automatic
  process restoration
- do not drain an advertised service merely because SourceManager itself was
  previously offline
- retain the current non-blocking behavior when the Tailscale daemon is
  unavailable

An advertisement can point to a dead local target while SourceManager is
offline. This is an accepted tradeoff of the preserve-on-shutdown model. Once
SourceManager returns, recovery or conflict status must make the condition
visible.

---

## Tests

### Runner and process persistence

1. Spawn options create a detached runner, detach it from terminal stdio, and
   unref it.
2. Runner manifests cannot express arbitrary commands outside validated service
   configuration.
3. Runner survives simulated SourceManager exit and continues its service.
4. Combined output continues writing and rotating while SourceManager is absent.
5. Explicit service Stop terminates only the verified runner-owned process tree.
6. SourceManager application shutdown never signals service runners.

### Launch-record verification

1. Matching runner PID, run ID, creation identity, command fingerprint, process
   tree, port, and health restore `running`.
2. PID reuse or mismatched runner identity is rejected.
3. A healthy unverified listener produces `SERVICE_PROCESS_OWNERSHIP_CONFLICT`.
4. A prior SourceManager log remains readable without granting process ownership.
5. Missing or malformed runner state fails closed without killing a process.

### Startup recovery

1. A previously running unavailable service makes one automatic start attempt.
2. The UI/API report `starting` with a recovery reason during that attempt.
3. Successful recovery creates a new verified launch record and restores
   Tailnet only after health passes.
4. Failed recovery becomes `SERVICE_STARTUP_RECOVERY_FAILED` with no same-startup
   retry loop.
5. A port conflict prevents automatic recovery.
6. Previously stopped services remain stopped.
7. Interrupted `starting` and `stopping` records reconcile from observed state.

### Output

1. stdout and stderr appear in one ordered stream.
2. ANSI sequences are stored and safely rendered.
3. Historical pagination crosses rotated segments without duplication or gaps.
4. SSE resumes from a cursor after disconnect and announces segment rotation.
5. SourceManager restart resumes the active runner output without reattachment.
6. Active logs are protected from retention cleanup and total storage is capped.

### Tailnet

1. Application shutdown issues no drain, disable, clear, or reset commands.
2. A surviving healthy service retains its connected advertisement.
3. Startup displays an already matching advertisement as enabled/connected.
4. Desired-on but missing advertisement is reconciled only after local health.
5. SourceManager's own advertisement remains configured while its port is
   temporarily offline.

### Manual Windows verification

1. Start multiple services through SourceManager and record their runner, child,
   and listener PIDs.
2. Confirm combined output is visible and persisted.
3. Press Ctrl+C in the SourceManager terminal.
4. Confirm SourceManager and its Vite process exit while managed runners,
   services, ports, output files, and Tailnet URLs continue working.
5. Start SourceManager again and confirm verified services retain their original
   run IDs, uptime, Tailnet state, and output history.
6. Stop one runner safely, restart SourceManager, and confirm exactly one
   recovery attempt.
7. Start a configured service manually in another terminal and confirm
   SourceManager reports an ownership conflict without controlling it.
8. Reboot or sign out and document actual behavior. Detached processes are
   designed to survive SourceManager, not guaranteed to survive Windows reboot
   or session termination.

---

## Ramifications and Tradeoffs

### Benefits

- Managed applications and Tailnet access remain available during SourceManager
  updates and restarts.
- SourceManager shutdown becomes fast and does not coordinate every service.
- Durable output supports historical troubleshooting and future live display.
- Verified ownership avoids claiming arbitrary processes.

### Costs

- Overall lifecycle architecture is more complex even though application
  shutdown is simpler.
- A persistent runner and authenticated runtime records must be maintained.
- Tailnet can advertise a dead target while SourceManager is offline.
- Automatic recovery can fail because an unowned process occupies the port.
- Detached services retain their original code, environment, credentials, and
  dependencies until explicitly restarted.
- Output requires bounded rotation even when SourceManager is offline.
- Ctrl+C no longer means "stop everything"; users must stop services explicitly.
- Detachment does not guarantee survival across logout, reboot, power loss, or
  forced machine shutdown.
- A real interactive terminal would still require a more capable persistent PTY
  broker and is outside this plan.

---

## Acceptance Criteria

- SourceManager application shutdown performs no managed-service or managed
  Tailnet stop actions.
- Services started through SourceManager use detached runners and survive
  SourceManager Ctrl+C on the supported Windows environment.
- Each running service has a verified, versioned launch record.
- Startup never trusts PID liveness alone.
- Verified healthy prior runs recover as `running` with continuous output.
- Previously running unavailable services receive exactly one visible automatic
  recovery attempt per SourceManager startup.
- Healthy unverified listeners are conflicts and are never automatically adopted
  or killed.
- Combined historical output survives SourceManager restart and can be streamed
  read-only later without terminal reattachment.
- Existing matching Tailnet advertisements display as enabled/connected after
  startup.
- No implementation uses `tailscale serve reset`.

---

## Recommendation

Choose this alternative when keeping managed development applications available
during frequent SourceManager restarts is more important than making Ctrl+C stop
the entire managed environment.

Choose the stop-on-shutdown plan when users expect terminal closure to clean up
all SourceManager-owned applications and prefer simpler process ownership over
service continuity.

The preserve-on-shutdown alternative simplifies SourceManager exit but is not
the smaller overall implementation. Reliable ownership recovery, offline log
capture, rotation, and safe conflict handling require the detached runner and
verified launch-record design described above.
