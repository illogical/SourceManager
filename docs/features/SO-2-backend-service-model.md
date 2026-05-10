# SO-2: Backend Service Model — Implementation Plan

**DevPlanner card:** SO-2  
**Priority:** 1 (foundation — all other SO-* cards depend on this)  
**Status:** Upcoming  

---

## Objective

Replace the flat `ProjectConfig` model with a two-tier **repo group → runnable service** model. This is a clean-break change to both the JSON config schema and the API. Every subsequent feature card (SO-3 dashboard, SO-4 config editor, SO-5 scripts, SO-6 Tailscale) depends on this model being correct.

---

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Config schema | **New nested `repos[]` structure** (clean break) | Flat `projects[]` conflates repo identity with process identity; new structure is unambiguous |
| API response | **Change `/v1/projects` → `/v1/repos`** (breaking) | Grouped output with per-service lifecycle state; old flat shape is removed |
| Lifecycle state machine | **Backend health-poll loop** after start | `starting → running / failed` tracked in process manager; UI can render progress without guessing |
| Tailnet metadata | **Included as optional typed fields** in SO-2 | Avoids a second config schema change when SO-6 lands; fields are validated but not acted on in SO-2 |

---

## Config schema — new structure

`data/projects.json` (and `data/projects.example.json`) adopt a nested `repos` array. The old top-level `projects` key is removed.

```jsonc
{
  "server": {
    "port": 17106,
    "token": "replace-with-a-strong-secret-token",
    "allowedIps": []
  },
  "repos": [
    {
      "id": "sourcemanager",
      "displayName": "SourceManager",
      "repoPath": "/Volumes/My Shared Files/Dev/projects/SourceManager",
      "defaultBranch": "main",
      "services": [
        {
          "id": "sourcemanager-api",
          "displayName": "SourceManager API",
          "packageManager": "bun",
          "scriptName": "dev",
          "port": 17106,
          "healthUrl": "http://localhost:17106/health",
          "healthMode": "ping",
          "tags": ["api"],
          "allowedIps": [],
          "tailnetHostname": "sourcemanager",
          "tailnetDomain": "bangus-city.ts.net",
          "tailscaleServeEnabled": false,
          "tailscaleServeMode": "https",
          "tailscaleServeTarget": "http://localhost:17106"
        }
      ]
    }
  ]
}
```

### Field ownership

**Repo-level** (shared across all services in the repo):

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | `string` | ✓ | Unique across all repos; slug-safe (alphanumeric + hyphens) |
| `displayName` | `string` | ✓ | Human-readable label shown in UI |
| `repoPath` | `string` | ✓ | Absolute path to repo root |
| `defaultBranch` | `string` | ✓ | Default git branch for update operations |
| `services` | `ServiceConfig[]` | ✓ | Must have at least one entry |

**Service-level** (per runnable process):

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | `string` | ✓ | Unique across all repos (not just within one repo) |
| `displayName` | `string` | ✓ | Human-readable label |
| `packageManager` | `"auto" \| "bun" \| "npm" \| "yarn" \| "pnpm"` | ✓ | Default: `"auto"` |
| `scriptName` | `string` | ✓ | Package script name (e.g. `"dev"`, `"api"`); no shell characters |
| `port` | `number` | ✓ | 1–65535 |
| `healthUrl` | `string` | ✓ | Must be `http://` or `https://` URL |
| `healthMode` | `"ping" \| "full"` | ✓ | Default: `"ping"` |
| `tags` | `string[]` | ✓ | Service type labels e.g. `["api", "mcp"]` |
| `installCommand` | `string \| null` | — | Override default install command |
| `allowedIps` | `string[]` | ✓ | CIDR strings; empty means no IP restriction |
| `tailnetHostname` | `string` | — | Subdomain only, no dots (e.g. `"sourcemanager"`) |
| `tailnetDomain` | `string` | — | Default `"bangus-city.ts.net"` |
| `tailscaleServeEnabled` | `boolean` | — | Default `false` |
| `tailscaleServeMode` | `"https"` | — | Only `"https"` accepted in MVP |
| `tailscaleServeTarget` | `string` | — | Local URL target (e.g. `"http://localhost:17106"`) |

---

## TypeScript types (`src/types.ts`)

Add the following new types. **Do not remove** `ProjectConfig` or `ProcessState` until existing Bun tests are migrated; mark them `@deprecated` and keep them compiling.

```typescript
// ── Service config ──────────────────────────────────────────────────────────

export interface TailnetServiceConfig {
  hostname: string            // subdomain only, e.g. "sourcemanager"
  domain: string              // e.g. "bangus-city.ts.net"
  serveEnabled: boolean
  serveMode: "https"
  serveTarget: string         // e.g. "http://localhost:17106"
}

export interface ServiceConfig {
  id: string
  displayName: string
  packageManager: "auto" | "bun" | "npm" | "yarn" | "pnpm"
  scriptName: string
  port: number
  healthUrl: string
  healthMode: "ping" | "full"
  tags: string[]
  installCommand?: string | null
  allowedIps: string[]
  // Tailnet metadata — optional; validated but not acted on until SO-6
  tailnetHostname?: string
  tailnetDomain?: string
  tailscaleServeEnabled?: boolean
  tailscaleServeMode?: "https"
  tailscaleServeTarget?: string
}

export interface RepoConfig {
  id: string
  displayName: string
  repoPath: string
  defaultBranch: string
  services: ServiceConfig[]
}

// ── Lifecycle state ─────────────────────────────────────────────────────────

export type LifecycleState = "starting" | "running" | "stopped" | "failed"

export interface ServiceProcessState {
  serviceId: string
  repoId: string
  pid: number
  port: number
  startedAt: string           // ISO 8601
  command: string
  lifecycleState: LifecycleState
  readySince?: string         // ISO 8601; set when health first passes
  lastError?: string          // set when state is "failed"
}

// ── App config (updated) ─────────────────────────────────────────────────────

export interface AppConfig {
  server: ServerConfig        // unchanged
  repos: RepoConfig[]         // replaces projects[]
}
```

---

## Config validation (`src/config.ts`)

### Validation rules

**Server:**
- `server.token` must be non-empty string
- `server.port` must be a number 1–65535
- `server.allowedIps` defaults to `[]`

**Repos array:**
- Must be a non-empty array
- Each repo must have `id`, `displayName`, `repoPath`, `defaultBranch`, and `services`
- Repo `id` must be globally unique and match `/^[a-z0-9-]+$/`
- `services` must be a non-empty array

**Services:**
- `id` must be globally unique across **all** repos (not just within a repo); match `/^[a-z0-9-]+$/`
- `port` must be integer 1–65535
- `healthUrl` must be a valid `http://` or `https://` URL
- `healthMode` must be `"ping"` or `"full"`
- `packageManager` must be one of `"auto" | "bun" | "npm" | "yarn" | "pnpm"`
- `scriptName` must match `/^[a-zA-Z0-9:_-]+$/` (no shell metacharacters)
- `tags` must be an array of non-empty strings
- `allowedIps` must be an array of valid CIDR strings (can be empty)
- **Tailnet fields (if present):**
  - `tailnetHostname` must not contain dots or slashes
  - `tailscaleServeMode` must be `"https"` if present
  - `tailscaleServeTarget` must be a valid `http://` or `https://` URL if present
  - `tailscaleServeEnabled` must be boolean if present

### New accessor functions

```typescript
export function getRepo(id: string): RepoConfig | undefined
export function requireRepo(id: string): RepoConfig         // throws RepoNotFoundError
export function getService(serviceId: string): { repo: RepoConfig; service: ServiceConfig } | undefined
export function requireService(serviceId: string): { repo: RepoConfig; service: ServiceConfig }  // throws ServiceNotFoundError
export function getAllServices(): Array<{ repo: RepoConfig; service: ServiceConfig }>

export class RepoNotFoundError extends Error { constructor(public readonly repoId: string) }
export class ServiceNotFoundError extends Error { constructor(public readonly serviceId: string) }
```

Keep `getProject` / `requireProject` as `@deprecated` aliases pointing to `getService` for the duration of the Bun test migration period.

---

## Process manager — lifecycle state machine (`src/services/processManager.ts`)

### State transitions

```
[stopped]
    │  POST /start
    ▼
[starting] ──── health poll passes ────► [running]
    │                                        │
    │  health timeout / process exits        │  POST /stop or process exits
    ▼                                        ▼
[failed]                               [stopped]
    │
    │  POST /start (retry)
    ▼
[starting]
```

### Changes to `ProcessManager` class

**Rename tracking maps:**
- `processes: Map<string, ServiceProcessState>` (was `ProcessState`)
- `portMap: Map<number, string>` — unchanged (port → serviceId)

**`start(repo: RepoConfig, service: ServiceConfig)`:**
1. Check if already `starting` or `running` → return idempotent success
2. Kill port if in use (existing logic, unchanged)
3. Spawn process using `detectPackageManager` → build command → `Bun.spawn()`
4. Record `ServiceProcessState` with `lifecycleState: "starting"`
5. Save state
6. Launch background health poll (see below); **do not await it**
7. Return immediately with `{ success: true, lifecycleState: "starting", pid }`

**Background health poll loop:**
```typescript
private async pollUntilReady(serviceId: string, service: ServiceConfig, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(1_000)
    const state = this.processes.get(serviceId)
    if (!state || state.lifecycleState !== "starting") return  // stopped externally
    const isAlive = isProcessAlive(state.pid)
    if (!isAlive) {
      this.setFailed(serviceId, "Process exited before becoming ready")
      return
    }
    const health = await checkHealth(service)
    if (health.status === "pass") {
      this.setRunning(serviceId)
      return
    }
  }
  this.setFailed(serviceId, `Health check did not pass within ${timeoutMs}ms`)
}
```

**`stop(serviceId: string)`:**
- If state is already `stopped` or service not tracked: return `{ success: true, alreadyStopped: true }`
- Otherwise: SIGTERM → wait → SIGKILL if needed → remove from map → save state → return `{ success: true, alreadyStopped: false }`

**`restart(repo, service)`:**
- `await stop(serviceId)` → `await start(repo, service)`

**`init()` — state file loading:**
- If loaded state has `lifecycleState: "starting"` and process is still alive → set to `failed` with `lastError: "SourceManager restarted mid-startup"`
- If PID is not alive → remove entry (existing prune behavior, unchanged)
- If loaded state has `lifecycleState: "running"` and PID is alive → keep as `running`

**`getPortEntries()`:** unchanged.

---

## API routes — new structure

All routes live under `/v1/` (auth-guarded, unchanged).

### Removed

| Old route | Notes |
|---|---|
| `GET /v1/projects` | Replaced by `GET /v1/repos` |
| `GET /v1/projects/:id` | Replaced by `GET /v1/repos/:repoId/services/:serviceId` |
| `GET /v1/projects/:id/status` | Merged into service detail |
| `GET /v1/projects/:id/process` | Merged into service detail |
| `GET /v1/projects/:id/logs` | Replaced by `GET /v1/repos/:repoId/services/:serviceId/logs` |
| `POST /v1/projects/:id/update` | Replaced by `POST /v1/repos/:repoId/services/:serviceId/update` |
| `POST /v1/projects/:id/start\|stop\|restart` | Replaced by service lifecycle routes |

### Added

```
GET  /v1/repos
GET  /v1/repos/:repoId
GET  /v1/repos/:repoId/services/:serviceId
GET  /v1/repos/:repoId/services/:serviceId/logs
POST /v1/repos/:repoId/services/:serviceId/start
POST /v1/repos/:repoId/services/:serviceId/stop
POST /v1/repos/:repoId/services/:serviceId/restart
POST /v1/repos/:repoId/services/:serviceId/update
```

### Kept unchanged

```
GET  /health
GET  /v1/ports
GET  /swagger
```

### `GET /v1/repos` response shape

```jsonc
{
  "repos": [
    {
      "id": "sourcemanager",
      "displayName": "SourceManager",
      "repoPath": "/path/to/SourceManager",
      "defaultBranch": "main",
      "services": [
        {
          "id": "sourcemanager-api",
          "displayName": "SourceManager API",
          "port": 17106,
          "healthUrl": "http://localhost:17106/health",
          "healthMode": "ping",
          "packageManager": "bun",
          "scriptName": "dev",
          "tags": ["api"],
          "lifecycle": {
            "state": "running",        // "starting" | "running" | "stopped" | "failed"
            "pid": 12345,
            "startedAt": "2026-05-10T12:00:00.000Z",
            "readySince": "2026-05-10T12:00:04.000Z",
            "uptimeMs": 3600000,
            "command": "bun run dev",
            "lastError": null
          },
          "tailnet": {                  // null if no tailnet fields configured
            "hostname": "sourcemanager",
            "domain": "bangus-city.ts.net",
            "serveEnabled": false,
            "serveMode": "https",
            "serveTarget": "http://localhost:17106"
          }
        }
      ]
    }
  ]
}
```

For a service with no tailnet config:
```jsonc
"tailnet": null
```

For a stopped/never-started service:
```jsonc
"lifecycle": {
  "state": "stopped",
  "pid": null,
  "startedAt": null,
  "readySince": null,
  "uptimeMs": null,
  "command": null,
  "lastError": null
}
```

### `POST /start` response

```jsonc
{
  "serviceId": "sourcemanager-api",
  "repoId": "sourcemanager",
  "success": true,
  "lifecycleState": "starting",   // transitions to "running" or "failed" asynchronously
  "pid": 12345,
  "message": "Service starting; poll /v1/repos/sourcemanager/services/sourcemanager-api for readiness"
}
```

### `POST /stop` response

```jsonc
{
  "serviceId": "sourcemanager-api",
  "success": true,
  "alreadyStopped": false,         // true if was already stopped (idempotent)
  "lifecycleState": "stopped"
}
```

---

## Vitest setup

### Install

```bash
bun add -d vitest
```

No DOM test environment is needed for SO-2 (backend only). A minimal `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/vitest/**/*.test.ts"],
    environment: "node",
  },
})
```

### `package.json` scripts update

```json
{
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "test": "bun test tests/config.test.ts tests/middleware tests/services && bun test tests/routes",
    "test:vitest": "bunx vitest run",
    "test:all": "bun run test && bun run test:vitest",
    "test:watch": "bun test tests/config.test.ts tests/middleware tests/services --watch"
  }
}
```

New Vitest test files go under `tests/vitest/`.

---

## Tests — what to write

### `tests/vitest/config.test.ts` — config validation

```
✓ accepts a valid repo/service config without throwing
✓ throws ConfigError when server.token is missing
✓ throws ConfigError when server.port is 0
✓ throws ConfigError when repos is not an array
✓ throws ConfigError when repos is empty
✓ throws ConfigError when repo is missing id
✓ throws ConfigError when repo id contains invalid characters (e.g. "my app")
✓ throws ConfigError when repo is missing repoPath
✓ throws ConfigError when repo is missing defaultBranch
✓ throws ConfigError when repo services is empty
✓ throws ConfigError when service is missing id
✓ throws ConfigError when service id is not globally unique (duplicate across repos)
✓ throws ConfigError when service port is 0
✓ throws ConfigError when service port is 65536
✓ throws ConfigError when service healthUrl is not http/https
✓ throws ConfigError when service healthMode is not "ping" or "full"
✓ throws ConfigError when service packageManager is unknown value
✓ throws ConfigError when service scriptName contains shell metacharacters (; | & $)
✓ throws ConfigError when tailscaleServeMode is not "https"
✓ throws ConfigError when tailscaleServeTarget is not a valid URL
✓ accepts a service with no tailnet fields
✓ accepts a service with all valid tailnet fields
✓ defaults packageManager to "auto", healthMode to "ping", allowedIps to []
✓ getAllServices() returns flat list with repo reference on each entry
✓ requireService() throws ServiceNotFoundError for unknown id
✓ requireRepo() throws RepoNotFoundError for unknown id
```

### `tests/vitest/processManager.test.ts` — lifecycle state

Use fake/stub implementations for `checkHealth`, `Bun.spawn`, and `isProcessAlive`. Never spawn real processes or call real health URLs in tests.

```
✓ stop() on a service that was never started returns { success: true, alreadyStopped: true }
✓ stop() on a service in "stopped" state returns { success: true, alreadyStopped: true }
✓ stop() on a running service transitions to "stopped" and returns { success: true, alreadyStopped: false }
✓ start() sets lifecycleState to "starting" before health poll completes
✓ start() transitions to "running" when health stub returns "pass"
✓ start() transitions to "failed" when health stub always returns "fail" after timeout
✓ start() transitions to "failed" when process exits before health passes
✓ restart() calls stop then start in sequence
✓ init() sets "starting" state from previous run to "failed" with descriptive lastError
✓ init() prunes entries where PID is not alive
✓ init() preserves "running" entries where PID is alive
✓ start() on a service already in "starting" state is idempotent (returns success, does not double-spawn)
✓ start() on a service already "running" is idempotent
```

### `tests/vitest/routes/repos.test.ts` — route integration

Use Elysia's `.handle()` test helper to exercise routes without a real HTTP server. Mock `processManager` and `checkHealth`.

```
✓ GET /v1/repos returns 200 with repos array
✓ GET /v1/repos returns each repo with services[] containing lifecycle object
✓ GET /v1/repos returns tailnet: null for services with no tailnet config
✓ GET /v1/repos/:repoId returns 200 with single repo
✓ GET /v1/repos/:unknown returns 404
✓ GET /v1/repos/:repoId/services/:serviceId returns 200 with service detail
✓ GET /v1/repos/:repoId/services/:unknown returns 404
✓ POST /v1/repos/:repoId/services/:serviceId/start without auth header returns 401
✓ POST /v1/repos/:repoId/services/:serviceId/start with valid auth returns 200 with lifecycleState "starting"
✓ POST /v1/repos/:repoId/services/:serviceId/stop for already-stopped service returns { success: true, alreadyStopped: true }
✓ POST /v1/repos/:repoId/services/:unknown/start returns 404
```

---

## Implementation sequence (TDD)

Follow strict red → green → refactor for each step.

1. **Read current code** — scan `src/types.ts`, `src/config.ts`, `src/services/processManager.ts`, `src/routes/`, existing Bun tests. Confirm what will break.

2. **Add Vitest** — `bun add -d vitest`, create `vitest.config.ts`, add `test:vitest` script. Run `bunx vitest run` → zero tests, no failures.

3. **Config types + validation (TDD)**
   - Write `tests/vitest/config.test.ts` with all validation tests → RED
   - Update `src/types.ts` (add `RepoConfig`, `ServiceConfig`, `LifecycleState`, `ServiceProcessState`, update `AppConfig`)
   - Rewrite `src/config.ts` validation for new schema; add new accessor functions; keep deprecated `getProject`/`requireProject` stubs → GREEN
   - Run `bun test` to confirm existing tests still pass

4. **Process manager lifecycle (TDD)**
   - Write `tests/vitest/processManager.test.ts` with mocked health/spawn → RED
   - Update `src/services/processManager.ts`: rename tracking map types, add lifecycle states, add health poll loop, make stop idempotent, update `init()` → GREEN
   - Run full test suite

5. **API routes (TDD)**
   - Write `tests/vitest/routes/repos.test.ts` → RED
   - Create `src/routes/repos.ts` (replaces `projects.ts`, `project.ts`, `lifecycle.ts`, `logs.ts` for per-service access)
   - Update `src/index.ts` to mount new routes; remove old project routes → GREEN
   - Keep `src/routes/update.ts` logic working under new route path `POST /v1/repos/:repoId/services/:serviceId/update`

6. **Update example config**
   - Rewrite `data/projects.example.json` to use new nested `repos[]` format
   - Include one repo ("my-web-app") with two services ("web" and "api") to demonstrate the per-process model

7. **Update documentation**
   - `docs/SPECIFICATION.md` — update config schema section, update routes table, update acceptance criteria
   - `docs/openapi.yaml` — add new `/v1/repos*` routes and response schemas; remove old `/v1/projects*` routes

8. **Final verification**
   ```bash
   bun run test:vitest   # all new Vitest tests pass
   bun run test          # all existing Bun tests pass (or note which were intentionally migrated)
   ```

---

## Files to create or modify

| File | Action | Notes |
|---|---|---|
| `src/types.ts` | Modify | Add `RepoConfig`, `ServiceConfig`, `TailnetServiceConfig`, `ServiceProcessState`, `LifecycleState`; update `AppConfig`; deprecate `ProjectConfig` |
| `src/config.ts` | Modify | Rewrite validation for new schema; add new accessors; keep deprecated stubs |
| `src/services/processManager.ts` | Modify | New lifecycle state machine with health poll loop; idempotent stop |
| `src/routes/repos.ts` | **Create** | Replaces `projects.ts` + `project.ts` + `lifecycle.ts` + `logs.ts` for new route hierarchy |
| `src/routes/update.ts` | Modify | Update route prefix from `/projects/:id` to `/repos/:repoId/services/:serviceId` |
| `src/routes/projects.ts` | Delete | Replaced by `repos.ts` |
| `src/routes/project.ts` | Delete | Merged into `repos.ts` |
| `src/routes/lifecycle.ts` | Delete | Merged into `repos.ts` |
| `src/routes/logs.ts` | Delete | Merged into `repos.ts` |
| `src/index.ts` | Modify | Mount `reposRoute` instead of old project routes |
| `data/projects.example.json` | Modify | New nested format |
| `vitest.config.ts` | **Create** | Vitest configuration |
| `package.json` | Modify | Add `test:vitest` and `test:all` scripts; add `vitest` devDependency |
| `tests/vitest/config.test.ts` | **Create** | Vitest config validation tests |
| `tests/vitest/processManager.test.ts` | **Create** | Vitest lifecycle state machine tests |
| `tests/vitest/routes/repos.test.ts` | **Create** | Vitest route integration tests |
| `docs/SPECIFICATION.md` | Modify | Updated schema + routes |
| `docs/openapi.yaml` | Modify | Updated API spec |

---

## Non-goals for SO-2

- No Tailscale enable/disable logic (SO-6 handles that — tailnet fields are typed and validated only)
- No frontend (SO-3)
- No package.json script discovery (SO-5)
- No config editing UI (SO-4)
- No public `tailscale funnel` support anywhere in the codebase
- No arbitrary shell command execution from client input

---

## Migration note

The user's live `data/projects.json` is in the old flat format and **must be migrated** before SourceManager will start. The implementation agent should:

1. Note the migration requirement clearly in the PR/commit message
2. The agent should **not** auto-migrate `data/projects.json` (it is gitignored and contains live credentials)
3. SO-7 (Managed service seed configs) will produce the concrete new `projects.json` entries for the real dev server services

A clear error message should be emitted if SourceManager encounters the old `projects` key at startup, guiding the user to migrate.

---

## Security considerations

- `scriptName` validation (no shell metacharacters) prevents injection via config editing surface (SO-4 will add more validation)
- `repoPath` is validated to exist as a configured allowlisted path — no traversal to arbitrary filesystem paths
- Tailnet hostname/domain validated to prevent injection into future `tailscale serve` CLI calls (SO-6)
- Test stubs ensure Tailscale CLI and process spawning are never called in automated tests
