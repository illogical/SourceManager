# SourceManager API

A secure HTTP API that manages Git operations and server process lifecycle for web applications running on a Windows dev machine. Designed to be called by AI agents on remote machines to pull the latest code and restart servers so changes are visible immediately.

**Stack:** Bun + TypeScript + Elysia (API) + React + Vite (dashboard) — runs as a lightweight Windows development host on port `17106`.

---

## Overview

SourceManager lets you manage a set of allowlisted Git repos through a token-authenticated REST API. Repos contain one or more runnable **services**, each with its own port, health URL, and process lifecycle. For each service you can:

- Pull the latest code (or switch branches) via a safe update workflow
- Start, stop, and restart the service's development server
- Check live process status (starting/running/stopped/failed), port assignments, and run history
- View structured logs for every operation

An OpenAPI spec is served live at `/swagger` for use with agent scripts and tooling.

---

## Prerequisites

- [Bun](https://bun.sh) >= 1.1
- Windows 10/11 (primary target; Linux compatible for testing)
- Git available in PATH
- [Node.js](https://nodejs.org) is not required by SourceManager itself
- Each managed project cloned under `C:\LocalDev\Projects\` (or any path you configure)
- Every managed project runtime and configured package manager available in the
  same user `PATH` (for example Node.js/npm, pnpm, or yarn)

---

## Setup

**1. Install dependencies**

```bash
bun install
```

**2. Create your configuration**

```powershell
Copy-Item data/projects.example.json data/projects.json
Copy-Item .env.example .env
```

On macOS or Linux, use:

```bash
cp data/projects.example.json data/projects.json
cp .env.example .env
```

Set the runtime values in `.env`:

```dotenv
SOURCEMANAGER_PORT=17106
SOURCEMANAGER_TOKEN=replace-with-a-long-random-token
SOURCEMANAGER_WORKSPACE_PATH=C:/LocalDev/Projects
```

Edit `data/projects.json`. Repository paths are relative to the workspace:

```json
{
  "server": {
    "frontendPort": 17116,
    "allowedIps": []
  },
  "repos": [
    {
      "id": "my-app",
      "displayName": "My Application",
      "repoPath": "my-app",
      "defaultBranch": "main",
      "services": [
        {
          "id": "my-app-web",
          "displayName": "Web Server",
          "port": 3000,
          "healthUrl": "http://localhost:3000/health",
          "healthMode": "ping",
          "packageManager": "auto",
          "scriptName": "dev",
          "allowedIps": [],
          "tags": []
        }
      ]
    }
  ]
}
```

**3. Run in development**

```bash
bun run dev
```

This starts two top-level processes with SourceManager's Windows-safe launcher:

| Process | Command | URL |
|---------|---------|-----|
| API | `bun run src/index.ts` | `http://localhost:<SOURCEMANAGER_PORT>` |
| Frontend (Vite HMR) | `bun x vite --config frontend/vite.config.ts` | `http://localhost:<server.frontendPort>` (`5173` if omitted) |

Open the configured frontend URL in your browser. Bun automatically loads
`.env` and an optional `.env.local` override. Vite reads `server.frontendPort` from
`data/projects.json` and proxies `/v1/*`, `/health`, and `/swagger` to
`SOURCEMANAGER_PORT`, so the backend port is defined once. Vite supports hot
reload. For manual backend-only development with source watching, run
`bun run dev:backend` in a separate terminal.

**4. Build and run in production**

```bash
# Start the server (rebuilds a missing or stale frontend automatically)
bun run start
```

`bun run start` rebuilds `frontend/dist` when it is missing or older than the
frontend sources, then serves everything on the configured
`SOURCEMANAGER_PORT`:
- `/` → React dashboard (static files from `frontend/dist/`)
- `/v1/*` → authenticated API
- `/swagger` → interactive OpenAPI docs
- `/health` → liveness check

> **`bun run dev:backend` uses `--watch` mode.** Bun monitors all source files and
> automatically restarts the API when they change. This is significant for the update
> workflow: when an agent calls `POST /v1/repos/sourcemanager/services/sourcemanager-api/update`
> to pull new code, the changed source files trigger an automatic restart — no explicit
> `/restart` API call is needed. Use `restartMode: "never"` when updating SourceManager
> itself in dev mode.

---

## Running on Windows Login

Use the checked-in PowerShell utility to register an interactive Scheduled Task
for your current Windows user. It runs `bun run dev` after logon, so a visible
terminal shows both the backend and Vite output. It does not store your Windows
password or SourceManager token, and it does not require an elevated task.

Install dependencies and create `.env` and `data/projects.json` before
registering the task. Run `bun install` again after pulling dependency changes;
the existing Scheduled Task does not need to be reinstalled for application
updates. Then run:

```powershell
# Register or update the at-logon task
.\scripts\SourceManagerStartup.ps1 Install

# Start it now without signing out
.\scripts\SourceManagerStartup.ps1 Start
```

Manage it with:

```powershell
.\scripts\SourceManagerStartup.ps1 Status
.\scripts\SourceManagerStartup.ps1 Stop
.\scripts\SourceManagerStartup.ps1 Start
.\scripts\SourceManagerStartup.ps1 Uninstall
```

`Install` and `Uninstall` are idempotent. The script resolves its repository and
Bun executable with absolute paths, keeps launcher transcripts under
`data/logs/`, and reports the API and Vite listener status without showing
secrets. Closing the SourceManager terminal ends the dashboard/API session; use
`Start` to open it again. Services started from SourceManager run behind
detached per-service runners, so they and their named Tailnet advertisements
intentionally continue running after Ctrl+C, terminal closure, or a
SourceManager restart.

The task only starts SourceManager. Managed applications remain controlled
through the dashboard or lifecycle API and must be stopped individually when
you want them to exit.

---

## Network and Tailscale Access

Managed applications now run directly on Windows at their configured ports.
The loopback targets in the
[Current LocalDev Service Map](docs/features/SO-6C-tailscale-services-named-services.md#current-localdev-service-map)
remain unchanged and are suitable for Tailscale Services hosted by the same
machine.

Native hosting does not automatically make an application reachable directly
from your LAN:

- A service bound to `127.0.0.1` is available locally and to same-host Tailscale
  forwarding, but not directly to another LAN device.
- Direct LAN access requires that application to bind to `0.0.0.0` or the
  Windows LAN address.
- Windows Defender Firewall must allow only the required TCP port, preferably
  on the Private network profile.
- SourceManager does not change application bind addresses or firewall rules.

Verify named Tailscale HTTPS services from a second Tailnet device because the
service-host machine may not be able to access a Service it hosts through that
Service's hostname.

### Migrating from the removed Docker runtime

If an older SourceManager container still exists, stop and remove it before
installing the Windows startup task:

```powershell
docker stop sourcemanager
docker rm sourcemanager
```

Skip these commands if the old container has already been taken down. Removing
the container does not remove host repositories or SourceManager's host data.
Disable Docker Desktop at logon only if no other project needs it.

Update `.env` so `SOURCEMANAGER_WORKSPACE_PATH` points directly to the Windows
repository directory. Remove any old `.env.local` override that points to
`/workspace/projects`.

---

## Authentication

All `/v1/*` endpoints require the header:

```
X-DevServer-Token: your-strong-secret-token
```

Requests without a valid token receive `401 Unauthorized`.

---

## API Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | API liveness check |
| GET | `/swagger` | No | Swagger UI (interactive docs) |
| GET | `/swagger/json` | No | Raw OpenAPI spec |
| GET | `/v1/repos` | Yes | Read cached repos, lifecycle, availability, and management state |
| GET | `/v1/repos/:repoId` | Yes | Single repo detail |
| GET | `/v1/repos/:repoId/services/:serviceId` | Yes | Service detail + lifecycle state |
| GET | `/v1/repos/:repoId/services/:serviceId/logs` | Yes | Recent run log entries (`?n=20`) |
| GET | `/v1/repos/:repoId/services/:serviceId/output` | Yes | Read durable combined service output |
| GET | `/v1/repos/:repoId/services/:serviceId/output/stream` | Yes | Stream combined output with SSE |
| POST | `/v1/repos/:repoId/services/:serviceId/status/refresh` | Yes | Actively refresh one service and Tailnet status |
| POST | `/v1/repos/:repoId/services/:serviceId/start` | Yes | Start the service |
| POST | `/v1/repos/:repoId/services/:serviceId/stop` | Yes | Stop the service (idempotent) |
| POST | `/v1/repos/:repoId/services/:serviceId/restart` | Yes | Restart the service |
| POST | `/v1/repos/:repoId/services/:serviceId/update` | Yes | Git pull/branch switch + install/restart |
| POST | `/v1/status/refresh` | Yes | Actively refresh every service and Tailnet status |
| GET | `/v1/config` | Yes | Read editable config snapshot (excludes token) |
| POST | `/v1/config/validate` | Yes | Validate proposed config; returns errors + diff |
| POST | `/v1/config/apply` | Yes | Atomically write validated config to disk |
| GET | `/v1/tailscale/status` | Yes | Read Tailscale host and named-Service status |
| POST | `/v1/tailscale/services/:serviceId/service/enable` | Yes | Persist Tailnet intent On and configure/advertise the endpoint |
| POST | `/v1/tailscale/services/:serviceId/service/disable` | Yes | Persist Tailnet intent Off, drain, and remove the endpoint |

### POST /v1/repos/:repoId/services/:serviceId/update

Triggers the full git update workflow: clean-tree check → fetch → checkout → pull (ff-only) → optional install → optional restart → health check.

```json
{
  "branch": "feature/xyz",
  "installMode": "auto",
  "restartMode": "auto",
  "dryRun": false
}
```

All fields are optional. Defaults: branch from repo config, `installMode=auto`, `restartMode=auto`, `dryRun=false`.

| Field | Values | Behavior |
|-------|--------|----------|
| `installMode` | `auto` | Run install only if lockfile/package.json changed |
| | `always` | Always run install |
| | `never` | Skip install |
| `restartMode` | `auto` | Restart only if health check fails after update |
| | `always` | Always restart after update |
| | `never` | Never restart (health check still runs) |
| `dryRun` | `true` | Runs precheck only; skips all mutations |

---

### Config Editing

The Settings page (gear icon) provides a full GUI for editing `data/projects.json`. The config is also editable via API:

**GET `/v1/config`** — returns JSON-owned editable settings plus a read-only
`runtime` summary containing `port`, `workspacePath`, and `tokenConfigured`.
The token value is never returned.

**POST `/v1/config/validate`** — validates proposed edits without writing:
```json
{ "config": { "server": { "frontendPort": 17116, ... }, "repos": [ ... ] } }
```
Returns `{ "validation": { "valid": true, "errors": [], "warnings": [] }, "diff": { "changeCount": 2, "changes": [...] } }`.

**POST `/v1/config/apply`** — validates and atomically writes (temp file + rename).
Returns `{ "success": true, "changeCount": 2 }` or `422` with validation errors.

**Security guarantees:**
- `SOURCEMANAGER_TOKEN` is never sent to the client.
- Environment-owned port and workspace values cannot be changed by the config API.
- Repository paths must be relative and cannot escape the configured workspace.
- `repo.id` and `service.id` are immutable — proposed IDs are ignored; original disk IDs are kept.
- Shell metacharacters (`;`, `&`, `|`, etc.) are rejected in `installCommand`.

**After saving**, restart the Vite development process if `server.frontendPort` changed.

---

## Config Reference

### Server fields

| Field | Required | Description |
|-------|----------|-------------|
| `frontendPort` | No | Vite dev server port for `bun run dev:frontend` (default: `5173`) |
| `allowedIps` | No | CIDR IP allowlist for the API |

Runtime values are configured in environment files:

| Variable | Description |
|----------|-------------|
| `SOURCEMANAGER_PORT` | API and production dashboard port |
| `SOURCEMANAGER_TOKEN` | Shared token expected in `X-DevServer-Token` |
| `SOURCEMANAGER_WORKSPACE_PATH` | Absolute workspace visible to the running process |

### Repo fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique repo identifier (slug: `[a-z0-9-]+`) |
| `displayName` | Yes | Human-readable repo name |
| `repoPath` | Yes | Path relative to `SOURCEMANAGER_WORKSPACE_PATH`; absolute and escaping paths are rejected |
| `defaultBranch` | Yes | Branch to pull when none specified |
| `services` | Yes | Non-empty array of service entries |

### Service fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Globally unique service identifier (slug, across all repos) |
| `displayName` | Yes | Human-readable service name |
| `port` | Yes | Port the service runs on |
| `healthUrl` | Yes | URL to check after updates |
| `healthMode` | No | `ping` (default) or `full` |
| `recoveryTimeoutSeconds` | No | Initial readiness threshold before the service remains Recovering in the background (default `30`, range `1`–`600`) |
| `packageManager` | No | `auto` (default), `bun`, `npm`, `yarn`, `pnpm` |
| `scriptName` | No | package.json script to run (default: `dev`) |
| `installCommand` | No | Override install command entirely |
| `allowedIps` | No | CIDR IP allowlist for this service |
| `tags` | No | Arbitrary string tags |
| `tailnetExposureMode` | No | Set to `tailscale-service` for named-Service exposure |
| `tailscaleServiceName` | No | Named Service slug without the `svc:` prefix |
| `tailscaleServiceEnabled` | No | Persisted desired Tailnet state (default `false`) |
| `tailscaleServiceProtocol` | No | `https` (the only supported protocol) |
| `tailscaleServicePort` | No | Tailnet-facing HTTPS port (default `443`) |
| `tailscaleServiceTarget` | No | Local `http://` or `https://` target forwarded by Tailscale |
| `tailnetDomain` | No | Optional Tailnet DNS suffix used when live machine status cannot supply it |

**`packageManager: "auto"`** detects from lockfiles in the repo root:
`bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm, else → bun.

**`healthMode: "ping"`** expects any `2xx` response within 5 seconds.
**`healthMode: "full"`** expects a JSON body with `status: "ok"` or `ok: true`.

---

## Logs

All operations write to daily-rotated NDJSON files in `data/logs/`:

- `data/logs/requests-<date>.ndjson` — every API request (token values redacted)
- `data/logs/runs-<date>.ndjson` — every update/start/stop/restart operation
- `data/logs/status-observations-<date>.ndjson` — status transitions and manual checks
- `data/logs/services/<service>/<run>/runner-events.ndjson` — sanitized runner supervisor diagnostics

Logs older than 7 days are automatically deleted on startup.

---

## Process Lifecycle

Services transition through six states: `starting` or `recovering` →
`running` | `failed`, `running` → `stopping` → `stopped` | `failed`, or
`stopped`.

- Only one process runs per port at any time.
- Services are launched by detached per-service runners. The runner captures
  combined stdout/stderr in rotated files under `data/logs/services/` and
  survives SourceManager shutdown.
- Starting a service when its port belongs to an unverified process fails with
  `SERVICE_PROCESS_OWNERSHIP_CONFLICT`; SourceManager never adopts or kills it.
- After spawning, health is checked for the service's readiness threshold
  (`recoveryTimeoutSeconds`, default 30). A live verified process remains
  `recovering` and continues checking every two seconds after that threshold.
- Process intent and verified launch identity are persisted to `data/state.json`.
  On startup, SourceManager checks runner identity, process ownership, port, and
  health. A verified survivor is restored without restarting.
- After a Windows reboot or unclean exit, previously running services are
  restored through a two-worker queue. A slow verified runner remains
  `recovering`, keeps intended state Running, and transitions to `running` as
  soon as health passes. Only exit, lost identity, ownership conflict, or a
  definitive launch error marks it failed.
- Availability and management are reported separately in `observedStatus`.
  Health determines whether the dashboard shows Running; signed runner identity,
  heartbeat, and listener ownership determine whether SourceManager can safely
  control it. A healthy listener with a missing supervisor is Running with an
  amber `Control lost` warning, and unsafe lifecycle actions stay disabled.
- A backend coordinator observes all services every ten seconds. Repository GET
  routes return its cached snapshot; manual global and per-service POST refresh
  routes provide explicit progress and completion feedback in the dashboard.
- Stopping SourceManager itself does not stop managed services or drain their
  Tailnet advertisements. The SourceManager service card uses this same
  self-shutdown behavior.

---

## Security Notes

- **Rotate your token** periodically. Store it in a secrets manager or Windows Credential Store in production.
- Use `allowedIps` to restrict access by CIDR range if the API is exposed on a shared network.
- The API never executes arbitrary shell commands; all git operations use argument arrays via `Bun.spawn()`.
- Only repos listed in `data/projects.json` can be managed.

---

## Testing

The project has two test runners:

```bash
bun run test           # bun:test — config, middleware, services, routes (104 tests)
bun run test:vitest    # Vitest — backend + frontend tests (195 passed, 1 skipped)
bun run test:frontend  # Vitest frontend only (64 tests, jsdom)
bun run test:backend   # Vitest backend only (131 passed, 1 skipped)
bun run test:all       # all suites in sequence
```

Bun's test suite runs in two separate invocations because `mock.module()` patches the global module registry and would otherwise contaminate service-level tests with route-level mocks:

1. **Config, middleware, and service tests** — use real temp git repos; no module mocking.
2. **Route tests** — mock all service modules and exercise the update workflow end-to-end through `app.handle()`.

Vitest runs separately to cover the backend config accessors, ProcessManager lifecycle state machine, and repos route handlers with vi.mock and fake timers, as well as all React component tests using jsdom and Testing Library.

### Test files

| File | Runner | Coverage |
|------|--------|----------|
| `tests/config.test.ts` | bun | Config validation: required fields, defaults, duplicate IDs |
| `tests/middleware/auth.test.ts` | bun | IP allowlist matching, token validation |
| `tests/services/git.test.ts` | bun | `gitStatus`, `gitCheckout` (branch injection guards), `detectDependencyChanges` |
| `tests/services/healthCheck.test.ts` | bun | Ping and full health check modes, connection failure, non-JSON bodies |
| `tests/services/installer.test.ts` | bun | Lockfile detection priority, custom install commands, non-zero exit handling |
| `tests/routes/update.test.ts` | bun | All update workflow paths: dryRun, dirty tree, installMode×3, restartMode×3, auth |
| `tests/vitest/config.test.ts` | Vitest/node | Schema validation, config accessors (`getRepo`, `getService`, `getAllServices`, etc.) |
| `tests/vitest/processManager.test.ts` | Vitest/node | Lifecycle state machine, health poll, idempotent stop, port tracking |
| `tests/vitest/routes/repos.test.ts` | Vitest/node | All 7 repos route handlers (GET list/detail/service/logs, POST start/stop/restart) |
| `tests/vitest/services/tailscale.test.ts` | Vitest/node | Named-Service commands, tri-state advertisement, startup repair, and `NoState` verification |
| `frontend/src/__tests__/client.test.ts` | Vitest/jsdom | API client: token helpers, auth errors, request headers, response parsing |
| `frontend/src/__tests__/Settings.test.tsx` | Vitest/jsdom | Token form: save, test-connection, sign-out |
| `frontend/src/__tests__/LifecycleBadge.test.tsx` | Vitest/jsdom | Badge label and colour class for all five lifecycle states |
| `frontend/src/__tests__/ActionButton.test.tsx` | Vitest/jsdom | Loading state, disabled state, variant classes |
| `frontend/src/__tests__/ServiceCard.test.tsx` | Vitest/jsdom | Action dispatch, pending-action lock, error display, Tailnet URL |
| `frontend/src/__tests__/RepoList.test.tsx` | Vitest/jsdom | Fetch on mount, normal/recovery polling, recovery countdown, error banners |

### Watch mode

```bash
bun run test:watch         # watches config, middleware, and service tests
bun test tests/routes --watch  # watch route tests separately
bunx vitest --project frontend  # watch frontend component tests with HMR
```

---

## File Structure

```
src/
  index.ts              Entry point — mounts routes, swagger, static plugin, error handler
  serviceRunner.ts      Detached managed-service runner and durable output capture
  config.ts             Config loader, validation, and accessors
  types.ts              TypeScript interfaces
  middleware/           Auth + request logging
  routes/
    repos.ts            GET/POST /v1/repos/** (list, detail, logs, start/stop/restart)
    update.ts           POST /v1/repos/:repoId/services/:serviceId/update
    health.ts           GET /health
  services/
    processManager.ts   Lifecycle state machine (starting/running/stopping/stopped/failed)
    runnerProtocol.ts   Signed runner manifest/status/control contracts
    serviceOutput.ts    Rotated output reads, SSE streaming, and retention
    startupStatus.ts    Five-second startup reconciliation progress
    applicationLifecycle.ts  SourceManager self-shutdown state
    git.ts              Git operations (status, checkout, pull, diff)
    healthCheck.ts      Health URL polling (ping and full modes)
    installer.ts        Package install with lockfile detection
    runLogger.ts        NDJSON run log read/write
    requestLogger.ts    NDJSON request log write

frontend/
  index.html            Vite HTML entry point
  vite.config.ts        Vite config (dev UI port from JSON, API proxy port from env)
  vitest.config.ts      Vitest config for frontend tests (jsdom)
  tsconfig.json         Frontend TypeScript config
  src/
    main.tsx            React entry point
    App.tsx             App shell (header, settings toggle, conditional views)
    index.css           Global CSS reset
    api/
      client.ts         Typed fetch wrapper with token management
      types.ts          TypeScript types mirroring backend API responses
    components/
      Settings.tsx       Token entry form with test-connection and sign-out
      RepoList.tsx       Grouped service list with 10 s polling
      ServiceCard.tsx    Per-service card: lifecycle badge, controls, Tailnet URL
      LifecycleBadge.tsx State chip (running/starting/stopped/failed)
      ActionButton.tsx   Button with loading, disabled, and variant props
  dist/                 Production build output (gitignored — run frontend:build)

data/
  projects.example.json Example config (committed)
  projects.localdev.example.json Personalized Windows dev-machine example (committed)
  projects.json         Your config (gitignored)
  state.json            Process state (gitignored)
  logs/                 NDJSON logs (gitignored)

scripts/
  SourceManagerStartup.ps1  Windows logon task install/start/stop/status utility

docs/
  SPECIFICATION.md      Design specification
  openapi.yaml          OpenAPI reference (auto-generated live at /swagger/json)
  features/             Feature design notes
```
