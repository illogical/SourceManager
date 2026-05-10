# SourceManager API

A secure HTTP API that manages Git operations and server process lifecycle for web applications running on a Windows dev machine. Designed to be called by AI agents on remote machines to pull the latest code and restart servers so changes are visible immediately.

**Stack:** Bun + TypeScript + Elysia — runs as a lightweight Windows service on port `17106`.

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
- Each managed project cloned under `C:\LocalDev\Projects\` (or any path you configure)

---

## Setup

**1. Install dependencies**

```bash
bun install
```

**2. Create your config**

```bash
cp data/projects.example.json data/projects.json
```

Edit `data/projects.json`:

```json
{
  "server": {
    "port": 17106,
    "token": "your-strong-secret-token",
    "allowedIps": []
  },
  "repos": [
    {
      "id": "my-app",
      "displayName": "My Application",
      "repoPath": "C:\\LocalDev\\Projects\\my-app",
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

**3. Run the server**

```bash
# Development — file watcher enabled
bun run dev

# Production — no watcher
bun run start
```

The API starts on port `17106`. Visit `http://localhost:17106/swagger` for interactive docs.

> **`bun run dev` uses `--watch` mode.** Bun monitors all source files and automatically
> restarts the server when they change. This is significant for the update workflow: when
> an agent calls `POST /v1/repos/sourcemanager/services/sourcemanager-api/update` to pull
> new code, the changed source files trigger an automatic restart — no explicit `/restart`
> API call is needed. The update workflow's health check step confirms the new version came
> back up. Use `restartMode: "never"` when updating SourceManager itself in dev mode.

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

## Config Reference

### Repo fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique repo identifier (slug: `[a-z0-9-]+`) |
| `displayName` | Yes | Human-readable repo name |
| `repoPath` | Yes | Absolute path to the git repository |
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
bun run test          # bun:test — config, middleware, services, routes (97 tests)
bun run test:vitest   # Vitest — config accessors, processManager, repos routes (43 tests)
bun run test:all      # both suites in sequence
```

Bun's test suite runs in two separate invocations because `mock.module()` patches the global module registry and would otherwise contaminate service-level tests with route-level mocks:

1. **Config, middleware, and service tests** — use real temp git repos; no module mocking.
2. **Route tests** — mock all service modules and exercise the update workflow end-to-end through `app.handle()`.

Vitest runs separately (in `tests/vitest/`) to cover the config accessors, ProcessManager lifecycle state machine, and repos route handlers with vi.mock and fake timers.

### Test files

| File | Runner | Coverage |
|------|--------|----------|
| `tests/config.test.ts` | bun | Config validation: required fields, defaults, duplicate IDs |
| `tests/middleware/auth.test.ts` | bun | IP allowlist matching, token validation |
| `tests/services/git.test.ts` | bun | `gitStatus`, `gitCheckout` (branch injection guards), `detectDependencyChanges` |
| `tests/services/healthCheck.test.ts` | bun | Ping and full health check modes, connection failure, non-JSON bodies |
| `tests/services/installer.test.ts` | bun | Lockfile detection priority, custom install commands, non-zero exit handling |
| `tests/routes/update.test.ts` | bun | All update workflow paths: dryRun, dirty tree, installMode×3, restartMode×3, auth |
| `tests/vitest/config.test.ts` | Vitest | Schema validation, config accessors (`getRepo`, `getService`, `getAllServices`, etc.) |
| `tests/vitest/processManager.test.ts` | Vitest | Lifecycle state machine, health poll, idempotent stop, port tracking |
| `tests/vitest/routes/repos.test.ts` | Vitest | All 7 repos route handlers (GET list/detail/service/logs, POST start/stop/restart) |

### Watch mode

```bash
bun run test:watch   # watches config, middleware, and service tests
bun test tests/routes --watch  # watch route tests separately
```

---

## File Structure

```
src/
  index.ts              Entry point — mounts routes, swagger, error handler
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

data/
  projects.example.json Example config (committed)
  projects.json         Your config (gitignored)
  state.json            Process state (gitignored)
  logs/                 NDJSON logs (gitignored)

docs/
  SPECIFICATION.md      Design specification
  openapi.yaml          OpenAPI reference (auto-generated live at /swagger/json)
  features/             Feature design notes
```
