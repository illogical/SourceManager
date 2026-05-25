# SourceManager Startup Diagnostics and LMApi Troubleshooting Plan

> **For coding assistant on the dev machine:** Implement this plan in the active SourceManager checkout on the remote dev machine where SourceManager and all managed projects run on `localhost`. The LMApi clone visible to Hermes is reference-only; do not assume it is the active checkout.

**Goal:** Surface actionable failure details when SourceManager cannot start a managed service, then use those details to diagnose why LMApi fails immediately with a generic `API error 500`.

**Architecture:** Keep SourceManager as the control plane, but make lifecycle operations observable end-to-end. Backend routes should return structured, sanitized error payloads; the frontend API client should log and display those payloads; `ProcessManager` should capture spawn diagnostics, early process exits, health-check failures, and recent child-process output.

**Tech stack:** Bun, TypeScript, Elysia backend, React/Vite frontend, Vitest/Bun tests, Windows dev machine, local SourceManager-managed repos.

---

## Current observations / working theory

From the reference SourceManager code:

- `frontend/src/api/client.ts` currently throws `new ApiError(res.status, body)` but the `Error.message` is only `API error ${status}`.
- `src/index.ts` catches unhandled backend exceptions and returns only:
  ```json
  { "error": "Internal server error" }
  ```
- `src/routes/repos.ts` start route calls:
  ```ts
  const result = await processManager.start(repo, service)
  ```
  without local try/catch or route-specific diagnostic context.
- `src/services/processManager.ts` calls `Bun.spawn()` directly via `_spawnProcess(...)`; if `Bun.spawn()` throws, the exception bubbles to Elysia's global error handler and the frontend sees only HTTP 500.
- `ProcessManager` currently starts child services with:
  ```ts
  stdout: "inherit",
  stderr: "inherit",
  ```
  which means useful child-process output may appear only in SourceManager's backend terminal, not in API responses or service logs.
- SourceManager already has `src/services/runLogger.ts` and `GET /v1/repos/:repoId/services/:serviceId/logs`, but that log model appears centered on update runs, not lifecycle/start attempts.

Likely LMApi-specific causes to check once logging is improved:

1. SourceManager's runtime cannot find `npm` / `npm.cmd`.
2. SourceManager's runtime cannot access `C:\LocalDev\Projects\LMApi`.
3. LMApi dependencies are missing in the active checkout.
4. `npm run dev` exits immediately because of a TypeScript/runtime/env error.
5. Port `17100` is occupied or killed incorrectly.
6. LMApi starts but does not answer `http://localhost:17100/health` within 30 seconds.

### Updated diagnosis from the active dev server on 2026-05-25

The current LMApi failure is most consistent with an immediate SourceManager spawn/start exception, not an LMApi health timeout.

Observed locally:

- `data/logs/requests-2026-05-25.ndjson` records immediate failures for:
  - `POST /v1/repos/lmapi/services/lmapi-api/start` at `2026-05-25T22:24:25.535Z`, status `500`, duration `0ms`
  - `POST /v1/repos/lmapi/services/lmapi-api/start` at `2026-05-25T22:30:07.424Z`, status `500`, duration `0ms`
- `data/state.json` contains running DevPlanner entries, but no `lmapi-api` entry. That means SourceManager failed before it registered an LMApi process as `starting`.
- The active config points LMApi at:
  - repo path: `C:\LocalDev\Projects\LMApi`
  - package manager: `npm`
  - script: `dev`
  - port: `17100`
  - health URL: `http://localhost:17100/health`
- The active LMApi checkout exists, has `package.json`, has `node_modules`, has `node_modules\.bin\ts-node.cmd`, and has a `package-lock.json`.
- `where.exe npm` and `where.exe npm.cmd` resolve from this environment; `cmd.exe /c npm --version` works.
- The current SourceManager worktree has an uncommitted change in `src/services/processManager.ts` that changes Windows npm-like starts from `[pm, "run", scriptName]` to a `.cmd` executable form such as `["npm.cmd", "run", scriptName]`.

Working conclusion:

- The generic `API error 500` is probably caused by `Bun.spawn()` throwing before `ProcessManager.start()` creates state.
- The likely specific cause of the original failure is the older running SourceManager process trying to spawn `npm` directly on Windows, before the local `npm.cmd` workaround was applied/reloaded.
- If the running SourceManager has already picked up the `npm.cmd` workaround and still fails, the next most likely causes are: `Bun.spawn(["npm.cmd", ...])` still failing in this runtime, an invalid current working directory from the SourceManager process, or a synchronous error in `detectPackageManager`/port discovery. The current code cannot distinguish these because spawn/preflight exceptions still bubble into the global generic 500 handler.

There is also a separate SourceManager self-management issue:

- `data/projects.json` configures `sourcemanager-api` and `sourcemanager-web` with the same managed port, `17106`.
- `frontend/vite.config.ts` reads `server.frontendPort`, which is currently `17116`, so the SourceManager frontend dev service should be managed on `17116`, not `17106`.
- Port `17106` had two listening PIDs during diagnosis, and raw HTTP requests to `127.0.0.1:17106` accepted TCP but did not return an HTTP response within the timeout. This suggests the self-managed SourceManager API can get into a wedged or ambiguous listener state.
- Managing the SourceManager API from inside the SourceManager API is inherently risky: a restart can kill the process handling the restart request. Treat SourceManager self-management as a distinct design problem from LMApi startup.

---

## Desired behavior

When clicking **Start** for LMApi, the browser console and UI should show something closer to:

```json
{
  "error": "Failed to start service",
  "code": "SERVICE_SPAWN_FAILED",
  "repoId": "lmapi",
  "serviceId": "lmapi-api",
  "repoPath": "C:\\LocalDev\\Projects\\LMApi",
  "command": ["npm", "run", "dev"],
  "cwdExists": true,
  "packageJsonExists": true,
  "resolvedExecutable": null,
  "message": "Failed to spawn npm: executable not found in SourceManager PATH",
  "hint": "Try packageManager=auto, verify where.exe npm, or resolve npm.cmd on Windows.",
  "timestamp": "2026-05-25T...Z"
}
```

For a health timeout, it should show something like:

```json
{
  "error": "Service failed health check",
  "code": "SERVICE_HEALTH_TIMEOUT",
  "repoId": "devplanner",
  "serviceId": "devplanner-api",
  "pid": 12345,
  "port": 17103,
  "healthUrl": "http://localhost:17103/health",
  "lastHealthError": "fetch failed: ECONNREFUSED",
  "recentOutput": ["...last stdout/stderr lines..."],
  "message": "Health check did not pass within 30s"
}
```

---

## Task 1: Reproduce and capture the current failure on the dev machine

**Objective:** Establish a baseline before code changes.

**Files:**

- Read only: active SourceManager repo
- Read only: active LMApi repo

**Steps:**

1. On the dev machine, pull latest SourceManager and LMApi if appropriate:
   ```powershell
   cd C:\LocalDev\Projects\SourceManager
   git status -sb
   git pull --ff-only

   cd C:\LocalDev\Projects\LMApi
   git status -sb
   git pull --ff-only
   ```

2. Start SourceManager from the same terminal/environment normally used for development:
   ```powershell
   cd C:\LocalDev\Projects\SourceManager
   bun run dev
   ```

3. In a separate PowerShell terminal, verify basics:
   ```powershell
   where.exe bun
   where.exe npm
   npm --version
   Test-Path C:\LocalDev\Projects\LMApi
   Test-Path C:\LocalDev\Projects\LMApi\package.json
   Test-Path C:\LocalDev\Projects\LMApi\node_modules
   Test-Path C:\LocalDev\Projects\LMApi\node_modules\.bin\ts-node.cmd
   netstat -ano -p TCP | findstr :17100
   ```

4. Manually test LMApi startup outside SourceManager:
   ```powershell
   cd C:\LocalDev\Projects\LMApi
   npm run dev
   ```

5. In another terminal:
   ```powershell
   curl.exe http://localhost:17100/health
   ```

**Expected outcome:** Know whether LMApi can start manually. If manual startup fails, save the exact terminal output because SourceManager may only be exposing an already-existing LMApi issue.

---

## Task 2: Improve frontend API error messages and browser console logging

**Objective:** Make the browser console show the response body instead of only `API error 500`.

**Files:**

- Modify: `frontend/src/api/client.ts`
- Test: `frontend/src/__tests__/client.test.ts`

**Implementation guidance:**

Update `ApiError` to derive a useful message from response body fields:

```ts
function stringifyApiBody(body: unknown): string {
  if (body == null) return ""
  if (typeof body === "string") return body
  if (typeof body === "object") {
    const record = body as Record<string, unknown>
    const parts = [record.error, record.message, record.code]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    if (parts.length > 0) return parts.join(" — ")
    try {
      return JSON.stringify(body)
    } catch {
      return String(body)
    }
  }
  return String(body)
}

export class ApiError extends Error {
  public readonly detail: string

  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    const detail = stringifyApiBody(body)
    super(detail ? `API error ${status}: ${detail}` : `API error ${status}`)
    this.name = "ApiError"
    this.detail = detail
  }
}
```

In `apiFetch`, log failed responses before throwing:

```ts
if (!res.ok) {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = await res.text()
  }

  console.error("[SourceManager API] request failed", {
    path,
    method: options.method ?? "GET",
    status: res.status,
    body,
  })

  throw new ApiError(res.status, body)
}
```

**Tests to add/update:**

- Existing `client.test.ts` should assert that a 500 with `{ error: "Internal server error" }` produces `API error 500: Internal server error`.
- Add a test for structured body:
  ```ts
  { error: "Failed to start service", code: "SERVICE_SPAWN_FAILED", message: "npm not found" }
  ```
  Expected message includes `Failed to start service`, `npm not found`, and/or `SERVICE_SPAWN_FAILED`.
- Spy on `console.error` and assert it receives status/path/body for non-OK responses.

**Verification:**

```powershell
cd C:\LocalDev\Projects\SourceManager
bun run test:frontend
```

Then reproduce the LMApi start failure and confirm DevTools console includes `[SourceManager API] request failed` with the response body.

---

## Task 3: Add structured backend HTTP errors instead of generic 500s

**Objective:** Let backend code intentionally return diagnostic error payloads without collapsing everything to `{ error: "Internal server error" }`.

**Files:**

- Create: `src/errors.ts`
- Modify: `src/index.ts`
- Test: relevant backend route tests, likely `tests/vitest/routes/repos.test.ts`

**Implementation guidance:**

Create a typed HTTP error:

```ts
export type ErrorCode =
  | "SERVICE_SPAWN_FAILED"
  | "SERVICE_START_FAILED"
  | "SERVICE_HEALTH_TIMEOUT"
  | "SERVICE_EXITED_BEFORE_READY"
  | "REPO_PATH_INVALID"
  | "PACKAGE_MANAGER_NOT_FOUND"
  | "INTERNAL_ERROR"

export interface ErrorPayload {
  error: string
  code: ErrorCode
  message: string
  timestamp: string
  repoId?: string
  serviceId?: string
  repoPath?: string
  command?: string[]
  port?: number
  healthUrl?: string
  pid?: number
  details?: Record<string, unknown>
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: ErrorPayload,
  ) {
    super(payload.message || payload.error)
    this.name = "HttpError"
  }
}

export function makeErrorPayload(input: Omit<ErrorPayload, "timestamp">): ErrorPayload {
  return { ...input, timestamp: new Date().toISOString() }
}
```

Update `src/index.ts` global handler:

```ts
import { HttpError } from "./errors"

// inside .onError(...)
if (error instanceof HttpError) {
  set.status = error.status
  console.error("[SourceManager] HTTP error:", error.payload)
  return error.payload
}

console.error("[SourceManager] Unhandled error:", error)
set.status = 500
return {
  error: "Internal server error",
  code: "INTERNAL_ERROR",
  message: error instanceof Error ? error.message : String(error),
  timestamp: new Date().toISOString(),
}
```

**Important security note:** This is a local dev tool, so detailed error payloads are acceptable. Still, avoid returning full environment variables, tokens, or secrets.

**Verification:**

```powershell
bun run test:backend
```

Manually trigger a route error and verify the JSON response has `error`, `code`, `message`, and `timestamp`.

---

## Task 4: Add preflight diagnostics before spawning a service

**Objective:** Catch common startup problems before `Bun.spawn()` and return specific errors.

**Files:**

- Modify: `src/services/processManager.ts`
- Possibly create: `src/services/startDiagnostics.ts`
- Tests: `tests/vitest/processManager.test.ts`

**Checks to implement:**

For `repo.repoPath`:

```ts
import { access } from "node:fs/promises"
import { join } from "node:path"

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
```

Before spawn, check:

- `repo.repoPath` exists.
- `${repo.repoPath}/package.json` exists.
- chosen package manager is resolvable.
- on Windows, prefer `npm.cmd`, `pnpm.cmd`, `yarn.cmd` when package manager is not Bun.

Package-manager resolution guidance:

```ts
function executableCandidates(pm: string): string[] {
  if (process.platform !== "win32") return [pm]
  if (pm === "npm") return ["npm.cmd", "npm"]
  if (pm === "pnpm") return ["pnpm.cmd", "pnpm"]
  if (pm === "yarn") return ["yarn.cmd", "yarn"]
  if (pm === "bun") return ["bun.exe", "bun"]
  return [pm]
}
```

Resolution can be done by spawning `where.exe` on Windows or `which` elsewhere:

```ts
async function resolveExecutable(pm: string): Promise<{ executable: string | null; checked: string[]; error?: string }> {
  const candidates = executableCandidates(pm)
  for (const candidate of candidates) {
    const probe = process.platform === "win32"
      ? Bun.spawn(["where.exe", candidate], { stdout: "pipe", stderr: "pipe" })
      : Bun.spawn(["which", candidate], { stdout: "pipe", stderr: "pipe" })

    const [stdout, stderr, code] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ])

    if (code === 0 && stdout.trim()) return { executable: candidate, checked: candidates }
  }
  return { executable: null, checked: candidates, error: `Could not resolve executable for ${pm}` }
}
```

If a preflight check fails, do **not** call spawn. Return a failed `StartResult` or throw `HttpError` with fields:

- `repoId`
- `serviceId`
- `repoPath`
- `packageJsonExists`
- `packageManager`
- `resolvedExecutable`
- `checkedExecutables`
- `command`

**Recommended design choice:** Let `ProcessManager.start()` return rich failure results for expected lifecycle failures and reserve thrown `HttpError` for programming/unexpected route-level failures. Either is fine, but be consistent.

**Verification:**

Add tests for:

- missing repo path => `REPO_PATH_INVALID`
- missing package.json => `REPO_PATH_INVALID` or `PACKAGE_JSON_MISSING`
- unresolved `npm` => `PACKAGE_MANAGER_NOT_FOUND`
- Windows `npm` resolves to `npm.cmd` candidate

Run:

```powershell
bun run test:backend
```

---

## Task 5: Catch and return `Bun.spawn()` exceptions with context

**Objective:** If spawn itself throws, return the exact cause instead of a generic 500.

**Files:**

- Modify: `src/services/processManager.ts`
- Modify: `src/routes/repos.ts` if route-level wrapping is preferred
- Tests: `tests/vitest/processManager.test.ts`, `tests/vitest/routes/repos.test.ts`

**Implementation guidance:**

Wrap spawn:

```ts
let proc: { pid: number; exited: Promise<number> }
try {
  proc = this._spawnProcess(command, {
    cwd: repo.repoPath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[ProcessManager] Failed to spawn "${service.id}":`, {
    repoId: repo.id,
    serviceId: service.id,
    repoPath: repo.repoPath,
    command,
    message,
  })

  return {
    success: false,
    message: `Failed to spawn service "${service.id}": ${message}`,
    lifecycleState: "failed",
    diagnostics: {
      code: "SERVICE_SPAWN_FAILED",
      repoId: repo.id,
      serviceId: service.id,
      repoPath: repo.repoPath,
      command,
      message,
    },
  }
}
```

This requires extending `StartResult` to include optional diagnostics:

```ts
interface StartResult {
  success: boolean
  message: string
  lifecycleState?: LifecycleState
  pid?: number
  portKillResult?: { killed: boolean; previousPid: number; error?: string }
  diagnostics?: Record<string, unknown>
}
```

Then include diagnostics in `src/routes/repos.ts` response:

```ts
return {
  serviceId: service.id,
  repoId: repo.id,
  success: result.success,
  message: result.message,
  diagnostics: result.diagnostics ?? null,
  portKillResult: result.portKillResult ?? null,
  lifecycle: await buildLifecycle(service),
}
```

**Alternative:** If `success: false` should map to HTTP 500/409 instead of HTTP 200, throw `HttpError(500, makeErrorPayload(...))` from the route when `!result.success`. For debugging, either approach is usable; for UI semantics, non-2xx is better for failed lifecycle operations.

**Verification:**

Mock `_spawnProcess` to throw `new Error("ENOENT npm")` and assert response/returned result includes `SERVICE_SPAWN_FAILED`, command, repo path, and message.

---

## Task 6: Capture child stdout/stderr into recent service logs

**Objective:** Make early process output visible from the UI/API instead of requiring access to the SourceManager backend terminal.

**Files:**

- Modify: `src/services/processManager.ts`
- Modify or extend: `src/services/runLogger.ts`
- Possibly add: `src/services/serviceLogBuffer.ts`
- Tests: `tests/vitest/processManager.test.ts`

**Minimal implementation approach:**

1. Change spawn options from `inherit` to `pipe`.
2. Stream stdout/stderr lines to:
   - console with prefix `[serviceId stdout]` / `[serviceId stderr]`
   - an in-memory ring buffer per service, e.g. last 200 lines
   - optionally an NDJSON log file under `data/logs/service-${serviceId}-${date}.ndjson`

Example ring buffer shape:

```ts
interface ServiceLogLine {
  timestamp: string
  serviceId: string
  stream: "stdout" | "stderr"
  line: string
}
```

Pseudo-code:

```ts
private serviceLogs = new Map<string, ServiceLogLine[]>()

private appendServiceLog(entry: ServiceLogLine): void {
  const lines = this.serviceLogs.get(entry.serviceId) ?? []
  lines.push(entry)
  this.serviceLogs.set(entry.serviceId, lines.slice(-200))
  console[entry.stream === "stderr" ? "error" : "log"](`[${entry.serviceId} ${entry.stream}] ${entry.line}`)
}

private streamOutput(serviceId: string, stream: ReadableStream<Uint8Array> | null, name: "stdout" | "stderr"): void {
  if (!stream) return
  ;(async () => {
    const textStream = stream.pipeThrough(new TextDecoderStream())
    let pending = ""
    for await (const chunk of textStream as AsyncIterable<string>) {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ""
      for (const line of lines) {
        if (line.trim()) this.appendServiceLog({ timestamp: new Date().toISOString(), serviceId, stream: name, line })
      }
    }
    if (pending.trim()) this.appendServiceLog({ timestamp: new Date().toISOString(), serviceId, stream: name, line: pending })
  })().catch((err) => console.warn(`[ProcessManager] Failed reading ${name} for ${serviceId}:`, err))
}
```

Then call:

```ts
const spawned = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env })
this.streamOutput(service.id, spawned.stdout, "stdout")
this.streamOutput(service.id, spawned.stderr, "stderr")
```

**Endpoint guidance:** Existing route `GET /v1/repos/:repoId/services/:serviceId/logs` currently reads run reports. Consider adding either:

- `GET /v1/repos/:repoId/services/:serviceId/output?n=100`, or
- extend existing logs endpoint to include `kind=output|runs`.

For immediate troubleshooting, even backend console prefixing plus diagnostics response is enough. But the real product should expose recent output in the service card.

**Verification:**

- Start a known failing service.
- Confirm browser can retrieve recent output.
- Confirm SourceManager terminal shows prefixed child output.

---

## Task 7: Make health-check polling report last failure detail

**Objective:** For DevPlanner-style failures where a process starts but never becomes healthy, expose the exact health failure reason.

**Files:**

- Modify: `src/services/processManager.ts`
- Modify: `src/services/healthCheck.ts`
- Tests: `tests/services/healthCheck.test.ts`, `tests/vitest/processManager.test.ts`

**Implementation guidance:**

Currently `pollUntilReady()` calls `_checkHealth(service)` but discards failed health detail until timeout.

Change it to track the most recent failure:

```ts
let lastHealth: Awaited<ReturnType<typeof this._checkHealth>> | null = null

// inside loop
const health = await this._checkHealth(service)
lastHealth = health
if (health.status === "pass") { ... }
```

On timeout:

```ts
await this.setFailed(
  serviceId,
  `Health check did not pass within ${HEALTH_POLL_TIMEOUT_MS / 1000}s. Last health result: ${lastHealth?.detail ?? "no detail"}`,
)
```

Also consider storing these optional fields in `ServiceProcessState`:

```ts
lastHealthStatus?: "pass" | "fail"
lastHealthDetail?: string
lastHealthCheckedAt?: string
```

**Verification:**

Mock health checker to always return:

```ts
{ status: "fail", durationMs: 5, detail: "ECONNREFUSED localhost:17103" }
```

Assert final `lastError` includes the detail.

---

## Task 8: Add LMApi-specific diagnostic checklist to run after logging lands

**Objective:** Use improved SourceManager diagnostics to isolate the LMApi startup issue.

**Commands to run on the dev machine:**

```powershell
cd C:\LocalDev\Projects\LMApi

# Git/dependency sanity
git status -sb
node --version
npm --version
where.exe npm
where.exe npm.cmd
Test-Path package.json
Test-Path node_modules
Test-Path node_modules\.bin\ts-node.cmd

# Script sanity
npm run dev

# Port and health sanity
netstat -ano -p TCP | findstr :17100
curl.exe http://localhost:17100/health
```

**If SourceManager says `PACKAGE_MANAGER_NOT_FOUND`:**

- Confirm SourceManager's process PATH includes npm.
- Prefer resolving `npm.cmd` on Windows.
- Try changing LMApi service `packageManager` to `auto` only if SourceManager's detector picks the right manager.

**If SourceManager says `REPO_PATH_INVALID`:**

- Verify SourceManager config path exactly matches the dev machine checkout path.
- Remember the Hermes reference path is not the active path.

**If SourceManager says `SERVICE_EXITED_BEFORE_READY`:**

- Check recent stdout/stderr output from SourceManager logs.
- Run `npm run dev` manually in the active LMApi checkout.
- Look for missing dependencies, native module build failures, missing env vars, TypeScript errors, DB errors, or port conflicts.

**If SourceManager says `SERVICE_HEALTH_TIMEOUT`:**

- Confirm LMApi listens on `17100`.
- Confirm health route is mounted at `/health`.
- Confirm `curl.exe http://localhost:17100/health` works from the dev machine.
- Check whether LMApi binds to an unexpected host/port.

---

## Task 9: Fix SourceManager self-management and dev hot-reload expectations

**Objective:** Make SourceManager safe to use as the control plane for dev services, including SourceManager itself, without confusing service status, killing the active API process mid-request, or misreporting frontend ports.

**Files:**

- Modify: `data/projects.json` or the editable config defaults used on this dev machine
- Modify: `data/projects.example.json` if the example should teach the correct pattern
- Modify: `src/services/processManager.ts`
- Modify: `src/routes/repos.ts`
- Possibly modify: `src/routes/update.ts`
- Possibly modify LMApi: `package.json` and a dev watcher dependency/config if LMApi should hot-reload under SourceManager

**Current config issue to fix first:**

`sourcemanager-web` is configured as:

```json
{
  "id": "sourcemanager-web",
  "packageManager": "bun",
  "scriptName": "dev:frontend",
  "port": 17106,
  "healthUrl": "http://localhost:17106/health"
}
```

But `frontend/vite.config.ts` reads `server.frontendPort`, and the active config sets `frontendPort` to `17116`. The frontend service should use the frontend dev server port:

```json
{
  "id": "sourcemanager-web",
  "packageManager": "bun",
  "scriptName": "dev:frontend",
  "port": 17116,
  "healthUrl": "http://localhost:17116/",
  "healthMode": "ping"
}
```

**Self-management design guidance:**

- Do not let SourceManager blindly kill whatever owns `server.port` when the service being restarted is the active SourceManager API.
- Add a self-service guard such as `service.id === "sourcemanager-api"` or `repo.repoPath === current SourceManager root && service.port === config.server.port`.
- For `sourcemanager-api`, choose one explicit strategy:
  - **Recommended for now:** mark the API service as externally supervised and make SourceManager display status but disable Start/Stop/Restart from the UI/API with a clear diagnostic message.
  - **Later option:** implement a tiny external supervisor/reloader that SourceManager can ask to restart the API after returning a response.
- Keep `sourcemanager-web` manageable as a normal Vite dev service on `17116`; Vite HMR should reload browser tabs for frontend source changes.
- If SourceManager pulls its own latest code, a frontend update should be picked up by Vite HMR. A backend update requires the backend process to be running under `bun --watch` or an external supervisor; SourceManager should not be responsible for killing and replacing the request-handling API process from inside that same process.

**LMApi hot-reload guidance:**

The active LMApi `dev` script is:

```json
"dev": "ts-node src/app.ts"
```

That starts LMApi but does not restart on TypeScript changes. Decide and implement one of:

- Change LMApi's dev script to a watcher, for example `tsx watch src/app.ts` or `nodemon --watch src --ext ts,json --exec ts-node src/app.ts`.
- Add a new script such as `dev:watch` and configure SourceManager's `lmapi-api.scriptName` to run that script.

Browser auto-reload for LMApi's dashboard is a separate requirement from backend restart:

- If LMApi serves static dashboard files directly from Express, backend restart alone will not automatically refresh an already-open browser tab.
- To satisfy "latest automatically reloaded in any browser that was viewing it", LMApi needs either a Vite-powered frontend/dev server or a small dev-only reload channel, such as Server-Sent Events or WebSocket, that tells dashboard pages to reload after SourceManager completes a pull/restart.
- SourceManager can expose update completion events later, but the minimal first step is: SourceManager restarts LMApi reliably, and LMApi's own dev mode watches/restarts on local file changes.

**Verification:**

```powershell
cd C:\LocalDev\Projects\SourceManager
bun run dev

# SourceManager frontend should answer on 17116
curl.exe http://localhost:17116/

# SourceManager API should answer on 17106
curl.exe http://localhost:17106/health

# LMApi should start through SourceManager and become healthy
curl.exe -H "X-DevServer-Token: <token>" -X POST http://localhost:17106/v1/repos/lmapi/services/lmapi-api/start
curl.exe http://localhost:17100/health
```

Do not include real tokens or LMApi secrets in logs, docs, screenshots, or test fixtures.

---

## Task 10: Add tests and run the full SourceManager suite

**Objective:** Prevent observability fixes from regressing existing SourceManager behavior.

**Files:**

- Tests touched above

**Commands:**

```powershell
cd C:\LocalDev\Projects\SourceManager
bun run test:backend
bun run test:frontend
bun run test:all
```

If `test:all` has pre-existing unrelated failures, record them separately and still verify the new targeted tests pass.

---

## Acceptance criteria

- Browser console shows detailed response body for failed API calls.
- UI/toast error message includes backend `message`/`error`, not just `API error 500`.
- Backend generic 500 response includes at least `code`, `message`, and `timestamp` in local dev.
- Start route returns/throws structured diagnostics for service startup failures.
- Spawn failures include command, cwd/repo path, package manager, and executable resolution info.
- Early process exits include exit code and recent stdout/stderr when available.
- Health timeouts include health URL and last health-check detail.
- LMApi start failure can be categorized as one of:
  - repo path/config problem
  - package manager resolution problem
  - dependency/script/runtime problem
  - port conflict
  - health endpoint mismatch/timeout
- SourceManager frontend status uses the actual Vite dev port (`17116` in the active config), not the API port.
- SourceManager API self-management is guarded: status may be shown, but Start/Stop/Restart cannot kill the process serving the request unless an external supervisor flow exists.
- LMApi's SourceManager-managed dev command either intentionally remains a plain start command or is changed to a watcher command; the decision is explicit in config and docs.

---

## Suggested implementation order

1. Fix the SourceManager config port mismatch for `sourcemanager-web` (`17116`, not `17106`).
2. Add a self-management guard for `sourcemanager-api` so SourceManager does not kill or restart its own request-handling process.
3. Frontend API error logging (`client.ts`) — fastest immediate visibility.
4. Backend structured `HttpError` payloads — turns generic 500 into useful JSON.
5. ProcessManager preflight and spawn try/catch — should categorize the LMApi instant 500.
6. Windows package-manager runner fix — resolve and spawn npm-like commands in a tested way, preferring `npm.cmd`/`pnpm.cmd`/`yarn.cmd` or a `cmd.exe /c` wrapper if Bun requires it.
7. Child stdout/stderr capture — essential for `npm run dev` failures.
8. Health-check failure details — essential for process-started-but-not-ready failures.
9. LMApi dev watcher decision (`dev` vs `dev:watch`) if SourceManager-managed hot reload is required.
10. UI polish for showing diagnostics on service cards/log panels.

---

## Notes for the coding assistant

- Do not rely on Hermes' local/reference clone for active state. Run all diagnosis on the dev machine.
- Be careful not to log secrets. Do not dump full `process.env`; log only PATH if absolutely necessary, and preferably just whether an executable was resolved.
- On Windows, `npm` can be a `.cmd`; `Bun.spawn(["npm", ...])` may fail depending on PATH/shell behavior. Explicitly test `npm.cmd` resolution.
- If `Bun.spawn(["npm.cmd", ...])` is unreliable on Windows, implement a narrow Windows runner for npm-like package managers using `cmd.exe /c npm run <script>` with validated package manager/script values. Do not use a general string-built shell runner.
- The active LMApi `.env` contains secrets. Diagnostic payloads and copied logs must redact environment values and should not include `.env` content.
- Keep changes small and test-backed. The immediate goal is diagnosis, not a full logging platform.
