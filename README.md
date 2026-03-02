# SourceManager API

A secure HTTP API that manages Git operations and server process lifecycle for web applications running on a Windows dev machine. Designed to be called by AI agents on remote machines to pull the latest code and restart servers so changes are visible immediately.

**Stack:** Bun + TypeScript + Elysia — runs as a lightweight Windows service on port `17106`.

---

## Overview

SourceManager lets you manage a set of allowlisted Git repositories through a token-authenticated REST API. For each managed project you can:

- Pull the latest code (or switch branches) via a safe update workflow
- Start, stop, and restart the project's development server
- Check live process status, port assignments, and run history
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
  "projects": [
    {
      "id": "my-app",
      "repoPath": "C:\\LocalDev\\Projects\\my-app",
      "defaultBranch": "main",
      "healthUrl": "http://localhost:3000/health",
      "healthMode": "ping",
      "port": 3000,
      "packageManager": "auto",
      "scriptName": "dev",
      "installCommand": "bun install",
      "allowedIps": []
    }
  ]
}
```

**3. Run the server**

```bash
# Development (hot reload)
bun run dev

# Production
bun run start
```

The API starts on port `17106`. Visit `http://localhost:17106/swagger` for interactive docs.

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
| GET | `/v1/projects` | Yes | List all managed projects |
| GET | `/v1/projects/:id` | Yes | Project detail + process state |
| GET | `/v1/projects/:id/status` | Yes | Last 3 run reports |
| GET | `/v1/projects/:id/process` | Yes | Live PID, port, uptime |
| GET | `/v1/projects/:id/logs` | Yes | Recent run log entries (`?n=20`) |
| GET | `/v1/ports` | Yes | All managed ports |
| POST | `/v1/projects/:id/update` | Yes | Git pull/branch switch + install/restart |
| POST | `/v1/projects/:id/start` | Yes | Start the project server |
| POST | `/v1/projects/:id/stop` | Yes | Stop the project server |
| POST | `/v1/projects/:id/restart` | Yes | Restart the project server |

### POST /v1/projects/:id/update

Triggers the full git update workflow: clean-tree check → fetch → checkout → pull (ff-only) → optional install → optional restart → health check.

```json
{
  "branch": "feature/xyz",
  "installMode": "auto",
  "restartMode": "auto",
  "dryRun": false
}
```

All fields are optional. Defaults: branch from config, `installMode=auto`, `restartMode=auto`, `dryRun=false`.

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

## Project Config Reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier used in API paths |
| `repoPath` | Yes | Absolute path to the git repository |
| `defaultBranch` | Yes | Branch to pull when none specified |
| `healthUrl` | Yes | URL to check after updates |
| `healthMode` | No | `ping` (default) or `full` |
| `port` | Yes | Port the project server runs on |
| `packageManager` | No | `auto` (default), `bun`, `npm`, `yarn`, `pnpm` |
| `scriptName` | No | package.json script to run (default: `dev`) |
| `installCommand` | No | Override install command entirely |
| `allowedIps` | No | CIDR IP allowlist for this project |

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

## Process Management

- Only one server process runs per port at any time.
- Starting a project when its port is already in use **auto-kills** the existing process (logged with PID and result).
- Process state (PID, port, started timestamp) is persisted to `data/state.json` and restored across API restarts.
- Stale PIDs (processes that exited while the API was down) are detected and pruned on startup.

---

## Security Notes

- **Rotate your token** periodically. Store it in a secrets manager or Windows Credential Store in production.
- Use `allowedIps` to restrict access by CIDR range if the API is exposed on a shared network.
- The API never executes arbitrary shell commands; all git operations use argument arrays via `Bun.spawn()`.
- Only repos listed in `data/projects.json` can be managed.

---

## Testing

The test suite uses `bun test` (built-in, no extra dependencies) across 89 tests in 6 files.

```bash
bun run test
```

Because Bun 1.x runs all test files in a single process and `mock.module()` patches the global module registry, the test script runs in two separate invocations to prevent route-level mocks from contaminating service-level tests:

1. **Config, middleware, and service tests** — use real temp git repos and real `Bun.serve()` servers; no module mocking.
2. **Route tests** — mock all service modules via `mock.module()` and exercise the update workflow end-to-end through `app.handle()`.

### Test files

| File | Coverage |
|------|----------|
| `tests/config.test.ts` | Config validation: required fields, defaults, duplicate IDs |
| `tests/middleware/auth.test.ts` | IP allowlist matching, token validation |
| `tests/services/git.test.ts` | `gitStatus`, `gitCheckout` (branch name injection guards), `detectDependencyChanges` |
| `tests/services/healthCheck.test.ts` | Ping and full health check modes, connection failure, non-JSON bodies |
| `tests/services/installer.test.ts` | Lockfile detection priority, custom install commands, non-zero exit handling |
| `tests/routes/update.test.ts` | All 9 update workflow paths: dryRun, dirty tree, installMode×3, restartMode×3, auth |

### Watch mode

```bash
bun run test:watch   # watches config, middleware, and service tests
bun test tests/routes --watch  # watch route tests separately
```

---

## File Structure

```
src/
  index.ts              Entry point
  config.ts             Config loader + validation
  types.ts              TypeScript interfaces
  middleware/           Auth + request logging
  routes/               Elysia route handlers
  services/             Git, process, health, logging services

data/
  projects.example.json Example config (committed)
  projects.json         Your config (gitignored)
  state.json            Process state (gitignored)
  logs/                 NDJSON logs (gitignored)

docs/
  SPECIFICATION.md      Design specification
```
