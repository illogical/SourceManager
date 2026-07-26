# SourceManager API

A secure HTTP API that manages Git operations and server process lifecycle for web applications running on a Windows dev machine. Designed to be called by AI agents on remote machines to pull the latest code and restart servers so changes are visible immediately.

**Stack:** Bun + TypeScript + Elysia (API) + React + Vite (dashboard) — runs as a lightweight Windows service on port `17106`.

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
- [Node.js](https://nodejs.org) is **not** required — Bun handles everything
- Each managed project cloned under `C:\LocalDev\Projects\` (or any path you configure)

---

## Setup

**1. Install dependencies**

```bash
bun install
```

**2. Create your configuration**

```bash
cp data/projects.example.json data/projects.json
cp .env.example .env
cp .env.local.example .env.local
```

Set the shared runtime values in `.env`:

```dotenv
SOURCEMANAGER_PORT=17106
SOURCEMANAGER_TOKEN=replace-with-a-long-random-token
SOURCEMANAGER_HOST_WORKSPACE_PATH=/Users/your-name/projects
```

`.env.local` maps the local runtime workspace to that host directory:

```dotenv
SOURCEMANAGER_WORKSPACE_PATH=${SOURCEMANAGER_HOST_WORKSPACE_PATH}
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

This starts two processes concurrently:

| Process | Command | URL |
|---------|---------|-----|
| API (Bun `--watch`) | `bun run dev:backend` | `http://localhost:<SOURCEMANAGER_PORT>` |
| Frontend (Vite HMR) | `bun run dev:frontend` | `http://localhost:<server.frontendPort>` (`5173` if omitted) |

Open the configured frontend URL in your browser. Bun automatically loads
`.env` and then `.env.local`. Vite reads `server.frontendPort` from
`data/projects.json` and proxies `/v1/*`, `/health`, and `/swagger` to
`SOURCEMANAGER_PORT`, so the backend port is defined once. Both servers support
hot reload.

**4. Build and run in production**

```bash
# Build the frontend once
bun run frontend:build

# Start the API (serves the built dashboard + API on one port)
bun run start
```

After building, `bun run start` serves everything on the configured
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

## Running with Docker Desktop

The included `Dockerfile` builds the React dashboard and runs the API in a
Debian-based Bun container. `compose.yaml` persists SourceManager state, mounts
the repositories it manages, and uses `restart: unless-stopped` so the container
starts again whenever Docker Desktop starts.

### 1. Create the runtime configuration

The application configuration file is `data/projects.json` (plural). Create it
from the example:

```powershell
Copy-Item data/projects.example.json data/projects.json
Copy-Item .env.example .env
Copy-Item .env.docker.example .env.docker
```

On macOS or Linux, use `cp` instead:

```bash
cp data/projects.example.json data/projects.json
cp .env.example .env
cp .env.docker.example .env.docker
```

Edit `.env`:

```dotenv
SOURCEMANAGER_PORT=17106
SOURCEMANAGER_TOKEN=replace-with-a-long-random-token
SOURCEMANAGER_HOST_WORKSPACE_PATH=C:/LocalDev/Projects
```

`SOURCEMANAGER_HOST_WORKSPACE_PATH` is the absolute host directory containing all managed
repositories. A macOS value could be `/Users/your-name/projects`. Docker mounts
that directory at `/workspace/projects` inside the container.

`.env.docker` supplies the container-specific runtime path:

```dotenv
SOURCEMANAGER_WORKSPACE_PATH=/workspace/projects
```

The same relative `repoPath` values work locally and in Docker:

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

The real `.env`, `.env.local`, and `.env.docker` files are ignored by Git.
The API port, token, and runtime workspace are required environment values.
Legacy `server.port` and `server.token` JSON fields are ignored and are removed
the next time Settings saves the file.

If you use a different API port, set the same `SOURCEMANAGER_PORT` in `.env`;
Compose uses it for both the container and host port. If a managed service must
be reachable from the host, uncomment or add its port under `ports` in
`compose.yaml`, for example:

```yaml
ports:
  - "${SOURCEMANAGER_PORT}:${SOURCEMANAGER_PORT}"
  - "3000:3000"
```

### 2. Build and start

```bash
docker compose --env-file .env --env-file .env.docker up -d --build
docker compose --env-file .env --env-file .env.docker ps
docker compose --env-file .env --env-file .env.docker logs -f sourcemanager
```

Open `http://localhost:17106` (or your configured port). Check the health
endpoint with:

```bash
curl http://localhost:17106/health
```

### 3. Start automatically with Docker Desktop

In Docker Desktop, enable **Settings → General → Start Docker Desktop when you
sign in**. The Compose service already has `restart: unless-stopped`, so after
the first `docker compose up -d`, Docker restarts it whenever Docker Desktop
starts.

Important behavior:

- `docker compose stop` deliberately marks the container as stopped, so it will
  not auto-start again. Run `docker compose up -d` to re-enable it.
- `docker compose down` removes the container. Run `docker compose up -d` to
  recreate it; `data/` and the managed repositories remain on the host.
- SourceManager starts managed services **inside this container**, not directly
  on the Windows/macOS host. Their repository paths and health URLs must be
  valid from inside the container.
- After changing `.env` or `data/projects.json`, recreate the container with
  `docker compose up -d --force-recreate`.

---

## Running on Windows Login

To have SourceManager start automatically when you log into your Windows 11 dev machine, register it as a scheduled task that triggers on user logon. This keeps it running in the background without requiring a third-party service manager.

**1. Build the frontend** (if you haven't already)

```powershell
bun run frontend:build
```

**2. Create the scheduled task**

Open PowerShell as Administrator and run:

```powershell
$action = New-ScheduledTaskAction `
  -Execute "bun" `
  -Argument "run src/index.ts" `
  -WorkingDirectory "C:\LocalDev\Projects\SourceManager"

$trigger = New-ScheduledTaskTrigger -AtLogon

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName "SourceManager" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -RunLevel Highest `
  -Force
```

Adjust `-WorkingDirectory` to match wherever you cloned the repo.

**3. Start it now** (without logging out)

```powershell
Start-ScheduledTask -TaskName "SourceManager"
```

Visit `http://localhost:17106` to confirm the dashboard is up.

**Managing the task**

```powershell
# Stop the service
Stop-ScheduledTask -TaskName "SourceManager"

# Start the service
Start-ScheduledTask -TaskName "SourceManager"

# Remove the task entirely
Unregister-ScheduledTask -TaskName "SourceManager" -Confirm:$false

# View task status
Get-ScheduledTask -TaskName "SourceManager" | Get-ScheduledTaskInfo
```

The task runs as your own user account, so it has access to the same filesystem, PATH, and Git credentials that your normal session uses. `bun` must be available in the system PATH — confirm with `where bun` in a new PowerShell window.

> **Tip:** If you want to update SourceManager itself via the API, make sure the scheduled
> task uses `bun run src/index.ts` (the production entry point, not `--watch`). The API's
> `restartMode` controls will handle the restart after a `git pull`.

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
| GET | `/v1/repos` | Yes | List all repos with services and lifecycle state |
| GET | `/v1/repos/:repoId` | Yes | Single repo detail |
| GET | `/v1/repos/:repoId/services/:serviceId` | Yes | Service detail + lifecycle state |
| GET | `/v1/repos/:repoId/services/:serviceId/logs` | Yes | Recent run log entries (`?n=20`) |
| POST | `/v1/repos/:repoId/services/:serviceId/start` | Yes | Start the service |
| POST | `/v1/repos/:repoId/services/:serviceId/stop` | Yes | Stop the service (idempotent) |
| POST | `/v1/repos/:repoId/services/:serviceId/restart` | Yes | Restart the service |
| POST | `/v1/repos/:repoId/services/:serviceId/update` | Yes | Git pull/branch switch + install/restart |
| GET | `/v1/config` | Yes | Read editable config snapshot (excludes token) |
| POST | `/v1/config/validate` | Yes | Validate proposed config; returns errors + diff |
| POST | `/v1/config/apply` | Yes | Atomically write validated config to disk |

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
| `SOURCEMANAGER_HOST_WORKSPACE_PATH` | Absolute host directory mounted by Docker |
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
| `packageManager` | No | `auto` (default), `bun`, `npm`, `yarn`, `pnpm` |
| `scriptName` | No | package.json script to run (default: `dev`) |
| `installCommand` | No | Override install command entirely |
| `allowedIps` | No | CIDR IP allowlist for this service |
| `tags` | No | Arbitrary string tags |

**`packageManager: "auto"`** detects from lockfiles in the repo root:
`bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm, else → bun.

**`healthMode: "ping"`** expects any `2xx` response within 5 seconds.
**`healthMode: "full"`** expects a JSON body with `status: "ok"` or `ok: true`.

---

## Logs

All operations write to daily-rotated NDJSON files in `data/logs/`:

- `data/logs/requests-<date>.ndjson` — every API request (token values redacted)
- `data/logs/runs-<date>.ndjson` — every update/start/stop/restart operation

Logs older than 7 days are automatically deleted on startup.

---

## Process Lifecycle

Services transition through four states: `starting` → `running` | `failed`, or `stopped`.

- Only one process runs per port at any time.
- Starting a service when its port is already in use **auto-kills** the existing process (logged with PID and result).
- After spawning, a background health poll runs every second (up to 30 s) to transition `starting` → `running` or `failed`.
- Process state is persisted to `data/state.json` and restored across API restarts. Stale PIDs are pruned on startup; any service that was `starting` when SourceManager restarted is marked `failed`.

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
bun run test           # bun:test — config, middleware, services, routes (97 tests)
bun run test:vitest    # Vitest — backend + frontend tests (81 tests)
bun run test:frontend  # Vitest frontend only (38 tests, jsdom)
bun run test:backend   # Vitest backend only (43 tests, node)
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
| `frontend/src/__tests__/client.test.ts` | Vitest/jsdom | API client: token helpers, auth errors, request headers, response parsing |
| `frontend/src/__tests__/Settings.test.tsx` | Vitest/jsdom | Token form: save, test-connection, sign-out |
| `frontend/src/__tests__/LifecycleBadge.test.tsx` | Vitest/jsdom | Badge label and colour class for all four lifecycle states |
| `frontend/src/__tests__/ActionButton.test.tsx` | Vitest/jsdom | Loading state, disabled state, variant classes |
| `frontend/src/__tests__/ServiceCard.test.tsx` | Vitest/jsdom | Action dispatch, pending-action lock, error display, Tailnet URL |
| `frontend/src/__tests__/RepoList.test.tsx` | Vitest/jsdom | Fetch on mount, 10 s polling, AuthError/ApiError banners, action wiring |

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
  config.ts             Config loader, validation, and accessors
  types.ts              TypeScript interfaces
  middleware/           Auth + request logging
  routes/
    repos.ts            GET/POST /v1/repos/** (list, detail, logs, start/stop/restart)
    update.ts           POST /v1/repos/:repoId/services/:serviceId/update
    health.ts           GET /health
  services/
    processManager.ts   Lifecycle state machine (starting/running/stopped/failed)
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

docs/
  SPECIFICATION.md      Design specification
  openapi.yaml          OpenAPI reference (auto-generated live at /swagger/json)
  features/             Feature design notes
```
