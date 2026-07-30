---
title: Dev Server Source Manager API v1 — Spec
type: spec
created: 2026-03-01
updated: 2026-06-01
tags: [openclaw, dev-server, api, git, workflow, security]
project: openclaw
status: active
sources:
  - http://192.168.7.45:17106
  - https://docs.openclaw.ai
owner: scribe
related: []
---

## Goal

- Provide a minimal, least-privilege HTTP API for push-triggered git operations on a Windows dev server, enabling fast feedback with safe pulls, installs, optional restarts, and health feedback — without exposing shell access.
- Enable AI agents on remote development machines to update local copies of managed repos and restart their services so changes are immediately visible.

## Scope

- In scope: managing allowlisted repos and their nested services via config, triggering guarded update flows, process lifecycle (start/stop/restart), reporting per-step statuses, recording NDJSON audit runs.
- Out of scope: arbitrary shell commands, CI/CD deployment automation, write access outside allowlisted repo roots.

## Non-goals

- No write access outside allowlisted repo roots defined in `projects.json`.
- No endpoint that executes arbitrary shell commands supplied by clients.
- No CI/CD deployment orchestration, environment provisioning, or production-grade rollout workflows in v1.

## Requirements

- Allowlisted configuration stored as `projects.json` with repos (identified by `id` and `repoPath`) each containing one or more runnable services (identified by unique `id`, `port`, `healthUrl`).
- Single global token-based authentication for all API clients, with optional CIDR IP allowlists (global or per-service).
- Health URL required per service; support `ping` and `full` health check modes.
- Update endpoint accepts branch selection and mode overrides (install/restart/dry run) while enforcing no CLI injection.
- APIs must report structured step outcomes, duration, and final status for chat-friendly summaries.
- Process lifecycle endpoints: start, stop, and restart services independently of git updates.
- Port conflict safety: refuse to start when the target port belongs to an
  unverified process; never automatically adopt or kill it.
- All requests and all run operations logged to daily-rotating NDJSON files.

## Acceptance criteria

- [ ] GET/POST endpoints work for every allowlisted service, honoring branch defaults and mode flags.
- [ ] Responses include structured step results, duration, and chat-ready summary details.
- [ ] Config-driven security controls (global token, optional IP allowlist) and NDJSON run logs are implemented.
- [ ] Start/stop/restart endpoints manage process state correctly across port conflicts and API restarts.
- [ ] Request logging captures all calls with sanitized payloads.

## Threat model & security controls

- Threats: unauthorized repo updates, arbitrary command execution, attacks from non-allowlisted networks.
- Controls:
  - Environment config defines a single global token; `projects.json` defines optional CIDR-based IP allowlists.
  - API checks caller token via `X-DevServer-Token` header and rejects unknown repos/services.
  - No shell exec path exposed; all git and install/restart commands use `Bun.spawn()` with arg arrays (no user-supplied script, no shell string interpolation).
  - Repos must reside under `SOURCEMANAGER_WORKSPACE_PATH`; `projects.json` lists relative paths only.
  - Branch names validated against `/^[\w./-]+$/` before use in git commands.

## Config schema (`projects.json`)

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
      "repoPath": "myapp",
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
          "installCommand": "bun install",
          "allowedIps": ["203.0.113.0/24"],
          "tags": []
        }
      ]
    }
  ]
}
```

### Server fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `server.frontendPort` | No | `5173` | Local Vite development port |
| `server.allowedIps` | No | `[]` | Global CIDR IP allowlist (empty = all IPs allowed) |

Required runtime environment values are `SOURCEMANAGER_PORT`,
`SOURCEMANAGER_TOKEN`, and `SOURCEMANAGER_WORKSPACE_PATH`.

### Repo fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique repo identifier (slug: `[a-z0-9-]+`) |
| `displayName` | Yes | Human-readable repo name |
| `repoPath` | Yes | Path relative to `SOURCEMANAGER_WORKSPACE_PATH`; absolute paths and `..` traversal are rejected |
| `defaultBranch` | Yes | Branch to pull when none specified in update call |
| `services` | Yes | Non-empty array of service entries |

### Service fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `id` | Yes | — | Globally unique service identifier (slug, across all repos) |
| `displayName` | Yes | — | Human-readable service name |
| `port` | Yes | — | Port the service listens on; used for conflict detection |
| `healthUrl` | Yes | — | URL queried to verify service health |
| `healthMode` | No | `"ping"` | `ping`: expect 2xx; `full`: expect JSON with `status:"ok"` or `ok:true` |
| `packageManager` | No | `"auto"` | `auto` detects from lockfiles: bun.lockb→bun, pnpm-lock.yaml→pnpm, yarn.lock→yarn, package-lock.json→npm |
| `scriptName` | No | `"dev"` | `package.json` script key to run |
| `installCommand` | No | — | Override the install command entirely (split on spaces) |
| `allowedIps` | No | `[]` | Per-service CIDR allowlist |
| `tags` | No | `[]` | Arbitrary string tags for filtering |
| `tailnetHostname` | No | — | Tailscale hostname for this service |
| `tailnetDomain` | No | — | Tailscale domain (e.g. `tail12345.ts.net`) |
| `tailscaleServeEnabled` | No | `false` | Whether Tailscale Serve is active for this service |
| `tailscaleServeMode` | No | — | `"https"` or `"http"` |
| `tailscaleServeTarget` | No | — | Upstream target URL for Tailscale Serve |

## API surface

### Unauthenticated

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | API liveness check (`{ status, version, uptimeMs }`) |
| GET | `/swagger` | Swagger UI — interactive OpenAPI docs |
| GET | `/swagger/json` | Raw OpenAPI 3.x spec (for agent scripts) |

### Authenticated (`X-DevServer-Token` header required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/repos` | List all repos with nested services and lifecycle state |
| GET | `/v1/repos/:repoId` | Single repo detail with all services |
| GET | `/v1/repos/:repoId/services/:serviceId` | Single service detail with lifecycle state |
| GET | `/v1/repos/:repoId/services/:serviceId/logs` | Recent run log entries (`?n=20`, max 100) |
| GET | `/v1/repos/:repoId/services/:serviceId/output` | Durable combined stdout/stderr chunks |
| GET | `/v1/repos/:repoId/services/:serviceId/output/stream` | Read-only SSE output stream |
| POST | `/v1/repos/:repoId/services/:serviceId/start` | Start the service process |
| POST | `/v1/repos/:repoId/services/:serviceId/stop` | Stop the service process (idempotent) |
| POST | `/v1/repos/:repoId/services/:serviceId/restart` | Restart (stop + start) the service |
| POST | `/v1/repos/:repoId/services/:serviceId/update` | Git update workflow (pull/branch switch + install/restart) |

### POST .../update — request body

```json
{
  "branch": "feature/xyz",
  "restartMode": "auto",
  "installMode": "auto",
  "dryRun": false
}
```

All fields optional. Defaults: branch from repo config, `installMode=auto`, `restartMode=auto`, `dryRun=false`.

- `dryRun`: runs precheck only — no fetch/pull/install/restart/health.
- `installMode`:
  - `auto`: run install only if lockfile or `package.json` changed.
  - `always`: re-run install even without changes.
  - `never`: skip install entirely.
- `restartMode`:
  - `auto`: restart only if health check fails post-update.
  - `always`: restart regardless of health.
  - `never`: never restart; health check still runs.

## Lifecycle states

Services transition through: `starting` or `recovering` → `running` | `failed`,
`running` → `stopping` → `stopped` | `failed`, or `stopped`.

| State | Description |
|-------|-------------|
| `starting` | Process spawned; health poll in progress (up to 30s) |
| `recovering` | Verified process is alive but health has not passed; background checks continue |
| `running` | Health check passed; process is live |
| `stopping` | Stop requested; tracked PID and configured port listener are being terminated and verified |
| `stopped` | Not running (never started or cleanly stopped) |
| `failed` | Process exited, lost verified identity, conflicted with another owner, or encountered a definitive launch error |

State, intended state, and versioned runner launch identity are persisted to
`data/state.json` after every change. On API restart, SourceManager verifies the
runner heartbeat, run identity, command fingerprint, listener ownership, and
health. Previously running unavailable services are restored through a
two-worker queue with an independent readiness threshold per service (30 seconds
by default). A verified live process remains `recovering` after the threshold,
keeps intended state Running, and continues background health checks.

## Safe update state machine

1. **Precheck clean tree**: `git status --porcelain`. Abort if dirty; respond with skip.
2. **Fetch**: `git fetch origin`.
3. **Checkout**: `git checkout <branch>`.
4. **Pull**: `git pull --ff-only origin <branch>`; abort/report on failure.
5. **Dependency check**: inspect changed files (ORIG_HEAD..HEAD) for `package*.json` or lockfile changes.
6. **Install**: run install command per `installMode`.
7. **Restart** (if `restartMode=always`): execute restart via ProcessManager.
8. **Health check**: query `healthUrl` per `healthMode`; timeout 5s.
9. **Auto-restart** (if `restartMode=auto` and health fails): restart then re-check health.
10. **Report**: build structured payload, log NDJSON entry.

Each step emits `{ step, status: "pending"|"success"|"failure"|"skipped", message, durationMs }`.

## Process management

- `ProcessManager` tracks detached per-service runners by service ID.
- Port registry: `Map<number, string>` (port → serviceId) enforces one process per port.
- **Port conflict on start**: an unverified listener is reported as
  `SERVICE_PROCESS_OWNERSHIP_CONFLICT` and is never adopted or killed.
- State persisted to `data/state.json` after every change; restored on API startup.
- PID liveness alone is never trusted because Windows can reuse PIDs.
- Runner manifests, authenticated status/heartbeats, and control requests live
  under `data/runtime/services/`; tokens are never returned by the API.
- Combined stdout/stderr is durably rotated under `data/logs/services/` and can
  be read historically or streamed read-only with SSE.
- The development launcher handles Ctrl+C and SIGTERM with a bounded selective
  shutdown. It verifies and protects persistent runner subtrees, terminates
  other SourceManager descendants deepest-first using exact PIDs, and never
  uses Windows `taskkill /T` against the SourceManager root.
- Process state is written with atomic replacement so abrupt launcher or machine
  shutdown cannot leave a partially written `data/state.json`.

## Response payload (update endpoint)

```json
{
  "runId": "uuid",
  "serviceId": "my-app-web",
  "repoId": "my-app",
  "startedAt": "2026-03-01T12:00:00Z",
  "durationMs": 4890,
  "branch": "main",
  "dryRun": false,
  "updated": true,
  "reason": "pulled main successfully",
  "installRun": { "status": "skipped", "reason": "no dependency changes" },
  "restartRun": { "status": "success", "reason": "health failure triggered restart", "durationMs": 320 },
  "healthStatus": "pass",
  "steps": [
    { "step": "precheck", "status": "success", "message": "Working tree is clean", "durationMs": 12 },
    { "step": "fetch",    "status": "success", "message": "Fetched from origin",   "durationMs": 310 },
    { "step": "checkout", "status": "success", "message": "Checked out branch \"main\"", "durationMs": 45 },
    { "step": "pull",     "status": "success", "message": "Already up to date",   "durationMs": 280 }
  ]
}
```

## Logging

- **Request logs** → `data/logs/requests-<date>.ndjson`: every request with method, URL, sanitized body, status, duration, IP.
- **Run logs** → `data/logs/runs-<date>.ndjson`: every update/start/stop/restart with full step data, keyed by `serviceId` and `repoId`.
- Both rotate daily; logs older than 7 days deleted on startup.

## Implementation notes

- Stack: Bun + TypeScript + Elysia (v1.3+) for lightweight Windows-friendly tooling.
- OpenAPI spec auto-generated from Elysia route type definitions via `@elysiajs/swagger`.
- Environment and JSON config are merged synchronously at startup and cached in memory. Restart the API to reload environment values.
- Git operations via `Bun.spawn(["git", ...args], { cwd: repoPath })` — never shell string interpolation.
- `data/projects.json` is gitignored; `data/projects.example.json` is committed as a template.
- Old `projects[]` format detected at startup → `process.exit(1)` with migration message.

## Risks

- **Token leak**: rotate tokens periodically.
- **Git command failures** (merge conflicts/detached HEAD): fail fast and surface details in step results.
- **Health endpoint flakiness**: `restartMode=auto` may over-restart on transient health failures.
- **Port conflicts with external processes**: `netstat -ano` used to detect external PIDs.

## Verification

- [ ] `bun install` completes without errors.
- [ ] `bun run dev` starts on port 17106; banner printed.
- [ ] `GET /health` returns `{ status: "ok" }`.
- [ ] `GET /swagger` renders Swagger UI.
- [ ] `GET /v1/repos` without token → 401.
- [ ] `GET /v1/repos` with valid token → repos list with nested services.
- [ ] `POST /v1/repos/:repoId/services/:serviceId/stop` → process terminated.
- [ ] Logs appear in `data/logs/requests-<date>.ndjson` and `data/logs/runs-<date>.ndjson`.
- [ ] `GET /swagger/json` returns valid OpenAPI 3.x spec.
