---
title: Dev Server Source Manager API v1 — Spec
type: spec
created: 2026-03-01
updated: 2026-03-01
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
- Enable AI agents on remote development machines to update local copies of managed projects and restart their servers so changes are immediately visible.

## Scope

- In scope: managing allowlisted repos via the project config, triggering guarded update flows, process lifecycle (start/stop/restart), reporting per-step statuses, recording NDJSON audit runs.
- Out of scope: arbitrary shell commands, CI/CD deployment automation, write access outside allowlisted repo roots.

## Non-goals

- No write access outside allowlisted repo roots defined in `projects.json`.
- No endpoint that executes arbitrary shell commands supplied by clients.
- No CI/CD deployment orchestration, environment provisioning, or production-grade rollout workflows in v1.

## Requirements

- Allowlisted project configuration stored as `projects.json` with required metadata (`id`, `repoPath`, `defaultBranch`, `healthUrl`, `port`). Only these projects may be updated.
- Single global token-based authentication for all API clients, with optional CIDR IP allowlists.
- Health URL required for v1 projects; support `ping` and `full` health check modes.
- Update endpoint accepts branch selection and mode overrides (install/restart/dry run) while enforcing no CLI injection.
- APIs must report structured step outcomes, duration, and final status for chat-friendly summaries.
- Process lifecycle endpoints: start, stop, and restart project servers independently of git updates.
- Port conflict resolution: auto-kill existing process on the target port with error reporting.
- All requests and all run operations logged to daily-rotating NDJSON files.

## Acceptance criteria

- [ ] GET/POST endpoints work for every allowlisted project, honoring branch defaults and mode flags.
- [ ] Responses include structured step results, duration, and chat-ready summary details.
- [ ] Config-driven security controls (global token, optional IP allowlist) and NDJSON run logs are implemented.
- [ ] Start/stop/restart endpoints manage process state correctly across port conflicts and API restarts.
- [ ] Request logging captures all calls with sanitized payloads.

## Threat model & security controls

- Threats: unauthorized repo updates, arbitrary command execution, attacks from non-allowlisted networks.
- Controls:
  - Config defines a single global `token` and optional CIDR-based IP allowlist (global or per-project).
  - API checks caller token via `X-DevServer-Token` header and rejects unknown or disabled projects.
  - No shell exec path exposed; all git and install/restart commands use `Bun.spawn()` with arg arrays (no user-supplied script, no shell string interpolation).
  - Repos must reside under approved root directories; `projects.json` only lists allowed paths.
  - Branch names validated against `/^[\w./-]+$/` before use in git commands.

## Project config schema (`projects.json`)

```json
{
  "server": {
    "port": 17106,
    "token": "your-secret-token",
    "allowedIps": []
  },
  "projects": [
    {
      "id": "string",
      "repoPath": "C:\\LocalDev\\Projects\\myapp",
      "defaultBranch": "main",
      "healthUrl": "http://localhost:3000/health",
      "healthMode": "ping",
      "port": 3000,
      "packageManager": "auto",
      "scriptName": "dev",
      "installCommand": "bun install",
      "allowedIps": ["203.0.113.0/24"]
    }
  ]
}
```

### Field reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `server.port` | Yes | — | Port this API listens on |
| `server.token` | Yes | — | Global API auth token |
| `server.allowedIps` | No | `[]` | Global CIDR IP allowlist (empty = all IPs allowed) |
| `id` | Yes | — | Unique project identifier used in API paths |
| `repoPath` | Yes | — | Absolute path to the git repository on this machine |
| `defaultBranch` | Yes | — | Branch to pull when none specified in update call |
| `healthUrl` | Yes | — | URL queried after updates to verify service health |
| `healthMode` | No | `"ping"` | `ping`: expect 2xx; `full`: expect JSON with `status:"ok"` or `ok:true` |
| `port` | Yes | — | Port the project server runs on; used for port conflict detection |
| `packageManager` | No | `"auto"` | Package manager to use; `auto` detects from lockfiles |
| `scriptName` | No | `"dev"` | `package.json` script key to run (e.g., `"dev"`, `"start"`) |
| `installCommand` | No | — | Override the install command entirely |
| `allowedIps` | No | `[]` | Per-project CIDR allowlist |

**`packageManager: "auto"` lockfile detection order:**
`bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm, else → bun.

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
| GET | `/v1/projects` | List all managed projects with process state and last run |
| GET | `/v1/projects/:id` | Project detail: config + live process info |
| GET | `/v1/projects/:id/status` | Last 3 run reports |
| GET | `/v1/projects/:id/process` | Live process: PID, port, uptime |
| GET | `/v1/projects/:id/logs` | Recent run log entries (`?n=20`, max 100) |
| GET | `/v1/ports` | All ports managed by this API and their status |
| POST | `/v1/projects/:id/update` | Git update workflow (pull/branch switch + install/restart) |
| POST | `/v1/projects/:id/start` | Start the project's server process |
| POST | `/v1/projects/:id/stop` | Stop the project's server process |
| POST | `/v1/projects/:id/restart` | Restart (stop + start) the project's server |

### POST /v1/projects/:id/update — request body

```json
{
  "branch": "feature/xyz",
  "restartMode": "auto",
  "installMode": "auto",
  "dryRun": false
}
```

All fields optional. Defaults: branch from config, `installMode=auto`, `restartMode=auto`, `dryRun=false`.

- `dryRun`: runs precheck only — no fetch/pull/install/restart/health.
- `installMode`:
  - `auto`: run install only if lockfile or `package.json` changed.
  - `always`: re-run install even without changes.
  - `never`: skip install entirely.
- `restartMode`:
  - `auto`: restart only if health check fails post-update.
  - `always`: restart regardless of health.
  - `never`: never restart; health check still runs.

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

- `ProcessManager` singleton tracks spawned processes by project ID (`Map<string, ProcessState>`).
- Port registry: `Map<number, string>` (port → projectId) enforces one process per port.
- **Port conflict on start**: auto-kills existing process (logged with PID + kill result), then starts new one.
- State persisted to `data/state.json` after every change; restored on API startup.
- Stale PIDs (process exited while API was down) detected via `process.kill(pid, 0)` and pruned on startup.
- On Windows, termination uses `SIGTERM` then `SIGKILL` if still alive after 500ms.
- External processes on managed ports detected via `netstat -ano`.

## Failure handling & reporting

Failures captured per-step with descriptive message. Example:

```json
{
  "step": "pull",
  "status": "failure",
  "message": "Fast-forward not possible; remote diverged",
  "durationMs": 624
}
```

Any step failure short-circuits remaining steps (recorded as `skipped`).

Entire run report includes `runId`, `projectId`, `startedAt`, `durationMs`, `branch`, `dryRun`, `steps`, `installRun`, `restartRun`, `healthStatus`.

## Response payload (update endpoint)

```json
{
  "runId": "uuid",
  "projectId": "my-app",
  "startedAt": "2026-03-01T12:00:00Z",
  "durationMs": 4890,
  "branch": "main",
  "dryRun": false,
  "updated": true,
  "reason": "pulled main successfully",
  "installRun": {
    "status": "skipped",
    "reason": "no dependency changes"
  },
  "restartRun": {
    "status": "success",
    "reason": "health failure triggered restart",
    "durationMs": 320
  },
  "healthStatus": "pass",
  "steps": [
    { "step": "precheck", "status": "success", "message": "Working tree is clean", "durationMs": 12 },
    { "step": "fetch",    "status": "success", "message": "Fetched from origin",   "durationMs": 310 },
    { "step": "checkout", "status": "success", "message": "Checked out branch \"main\"", "durationMs": 45 },
    { "step": "pull",     "status": "success", "message": "Already up to date",   "durationMs": 280 }
  ]
}
```

- `updated`: false when skipped (dirty tree, dry run, or already up-to-date).
- `healthStatus`: `"pass" | "fail" | "skipped"`.

## Logging

- **Request logs** → `data/logs/requests-<date>.ndjson`: every request with method, URL, sanitized body (token fields redacted), status, duration, IP.
- **Run logs** → `data/logs/runs-<date>.ndjson`: every update/start/stop/restart with full step data.
- Both rotate daily; logs older than 7 days deleted on startup.

## Implementation notes

- Stack: Bun + TypeScript + Elysia (v1.4+) for lightweight Windows-friendly tooling.
- OpenAPI spec auto-generated from Elysia route type definitions via `@elysiajs/swagger`; served live at `/swagger` (UI) and `/swagger/json` (raw).
- Config read synchronously at startup via `readFileSync`; cached in memory. Restart API to reload config.
- Git operations via `Bun.spawn(["git", ...args], { cwd: repoPath })` — never shell string interpolation.
- `data/projects.json` is gitignored; `data/projects.example.json` is committed as a template.

## Risks

- **Token leak**: rotate tokens periodically and store hashed or via Windows Credential Store.
- **Git command failures** (merge conflicts/detached HEAD): fail fast and surface details in step results.
- **Health endpoint flakiness**: `restartMode=auto` may over-restart on transient health failures.
- **Port conflicts with external processes**: `netstat -ano` used to detect external PIDs; may not work if unavailable.

## Verification

- [ ] `bun install` completes without errors.
- [ ] `bun run dev` starts on port 17106; banner printed.
- [ ] `GET /health` returns `{ status: "ok" }`.
- [ ] `GET /swagger` renders Swagger UI.
- [ ] `GET /v1/projects` without token → 401.
- [ ] `GET /v1/projects` with valid token → project list.
- [ ] `POST /v1/projects/:id/update` with `dryRun: true` → clean steps, no mutations.
- [ ] `POST /v1/projects/:id/update` with `installMode=auto` after dependency change → install runs.
- [ ] `POST /v1/projects/:id/start` → process spawned, PID + port recorded.
- [ ] `POST /v1/projects/:id/restart` → old process killed, new one started on same port.
- [ ] `POST /v1/projects/:id/stop` → process terminated.
- [ ] Logs appear in `data/logs/requests-<date>.ndjson` and `data/logs/runs-<date>.ndjson`.
- [ ] `GET /v1/projects/:id/status` returns last run report.
- [ ] `GET /swagger/json` returns valid OpenAPI 3.x spec.

## Key takeaways

- v1 exposes 10 endpoints to safely orchestrate git updates and server lifecycle for allowlisted Windows projects.
- Config enforces least privilege: allowlist + global token auth, no arbitrary commands, health URL required.
- Elysia's built-in OpenAPI generation produces the spec live at `/swagger/json` — no separate generation step needed.
- Response payloads and NDJSON logs provide concise summaries for AI agent consumption and audit trails.
