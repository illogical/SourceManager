---
title: Dev Server Source Manager API v1 — Spec
type: spec
created: 2026-03-01
updated: 2026-03-01
tags: [openclaw, dev-server, api, git, workflow, security]
project: openclaw
status: draft
sources:
  - http://192.168.7.45:17103
  - https://docs.openclaw.ai
owner: scribe
related: []
---

## Goal

- Provide a minimal, least-privilege HTTP API for push-triggered git operations on a Windows dev server, ensuring fast feedback with safe pulls, installs, optional restarts, and health feedback without exposing shell access.

## Scope

- In scope: managing allowlisted repos via the project config, triggering guarded update flows, reporting per-step statuses, recording NDJSON audit runs.
- Out of scope: arbitrary shell commands, CI/CD deployment automation, write access outside allowlisted repo roots.

## Non-goals

- No write access outside allowlisted repo roots defined in `projects.json`.
- No endpoint that executes arbitrary shell commands supplied by clients.
- No CI/CD deployment orchestration, environment provisioning, or production-grade rollout workflows in v1.

## Requirements

- Allowlisted project configuration stored as `projects.json` with required metadata (id, repoPath, defaultBranch, healthUrl...). Only these projects may be updated.
- Token-based authentication for API clients, with optional IP allowlists.
- Health URL required for v1 projects; support `ping` and `full` health check modes, expecting HTTP 200/OK payloads.
- Update endpoint accepts branch selection and mode overrides (install/restart/dry run) while enforcing no CLI injection.
- APIs must report structured step outcomes, duration, and final status for chat-friendly summaries.

## Acceptance criteria

- [ ] GET/POST endpoints work for every allowlisted project, honoring branch defaults and mode flags.
- [ ] Responses include structured step results, duration, and chat-ready summary details.
- [ ] Config-driven security controls (token, optional IP allowlist) and NDJSON run logs are implemented.

## Threat model & security controls

- Threats: unauthorized repo updates, arbitrary command execution, attacks from non-allowlisted networks.
- Controls:
  - Config defines `token` credentials and optional CIDR-based IP allowlist per project or globally.
  - API checks the caller token via TLS (HTTPS fronted) and rejects unknown or disabled projects.
  - No shell exec path exposed; update flows limit operations to git CLI commands computed from config (no user-supplied script).
  - Repos must reside under approved root directories; `projects.json` only lists allowed paths.

## Project config schema (`projects.json`)

```json
{
  "projects": [
    {
      "id": "string",
      "repoPath": "C:\\dev\\repo",
      "defaultBranch": "main",
      "healthUrl": "http://localhost:8000/health",
      "healthMode": "ping|full",
      "installCommand": "bun install",
      "startCommand": "bun start",
      "restartCommand": "bun restart",
      "autoUpdate": true,
      "token": "api-token",
      "allowedIps": ["203.0.113.0/24"]
    }
  ]
}
```

- `healthUrl`: required; service must respond 2xx within 5s. `healthMode` options:
  - `ping`: expect HTTP 200 with empty body (fast). Use for simple status.
  - `full`: expect JSON payload containing a `status`/`ok` field for deeper checks.
- `installCommand`: executed only when installMode dictates (auto/always). Should be idempotent.
- `startCommand`/`restartCommand`: describe how processes restart. Restart behavior controlled through `restartMode`.
- `autoUpdate`: when true, server may run background precondition checks (future feature) but v1 triggers only via POST.

## API surface

### GET /v1/projects

- Lists metadata for allowlisted projects (id, defaultBranch, lastRun timestamp, health status).
- Requires token header `X-DevServer-Token`.

### GET /v1/projects/:id/status

- Returns the latest run report (see response schema below) plus running flag.
- Useful for dashboards or verifying recent health after updates.

### POST /v1/projects/:id/update

- Triggers safe update workflow.
- Body:

```json
{
  "branch": "feature/xyz",         // optional; defaults to config.defaultBranch
  "restartMode": "auto",           // enum auto|always|never
  "installMode": "auto",           // enum auto|always|never
  "dryRun": false
}
```

- `dryRun`: runs all prechecks/fetch/pull without mutating repo; skip install/restart/health.
- `installMode`:
  - `auto`: run install only if dependency tree changed (taints from `git status` output).
  - `always`: re-run install command even without changes.
  - `never`: skip install entirely.
- `restartMode`:
  - `auto`: restart only if service health fails post-update.
  - `always`: restart regardless of health.
  - `never`: never restart; health check still runs unless dryRun.

## Safe update state machine

1. **Precheck clean tree**: `git status --porcelain`. Abort if dirty; respond with skip.
2. **Fetch**: `git fetch origin`.
3. **Checkout**: `git checkout <branch>`.
4. **Pull**: `git pull --ff-only origin <branch>`; abort/report on failure.
5. **Dependency check/install**:
   - Inspect `git status` diff to detect `package*.json` or lockfile changes.
   - Run install command per `installMode`.
6. **Optional restart**:
   - Decide based on `restartMode`.
   - Execute `restartCommand` or no-op if none provided.
7. **Health check**:
   - Query `healthUrl` with configured mode.
   - Expect response per mode; time out after 5s.
8. **Report**: Build structured payload, log NDJSON entry, rotate logs each day.

Each step emits status (`pending|success|failure|skipped`) and descriptive message.

## Failure handling & reporting

- Failures captured with `step`, `error`, `runDurationMs`.
- Example:

```json
{
  "step": "pull",
  "status": "failure",
  "message": "Fast-forward not possible; remote diverged",
  "durationMs": 624
}
```

- Entire report includes `runId`, `startedAt`, `durationMs`, `steps`.
- API stores last three run reports for retrieval via status endpoint.

## Response payload (chat-friendly)

```json
{
  "updated": true,
  "reason": "pulled main successfully",
  "installRun": {
    "status": "skipped",
    "reason": "no dependency changes"
  },
  "restartRun": {
    "status": "success",
    "reason": "auto restart after health regressions"
  },
  "healthStatus": "pass",
  "durationMs": 4890,
  "steps": [ ... ]
}
```

- `updated`: false when skipped (dirty tree, dry run, or already up-to-date).
- `reason`: short summary for chat.
- `installRun`/`restartRun`: include status/ reason and optional duration.
- `healthStatus`: `pass|fail|skipped`.
- `durationMs`: total run length.
- Additional `steps` can be included for debugging.

## Implementation notes

- Stack: Bun + TypeScript for lightweight Windows-friendly tooling.
- Config read from JSON file; refresh into memory on each request or watch file for dev reload.
- Logging: append NDJSON (`runs-<date>.ndjson`) for each execution with timestamped step info. Rotate daily, keep 7 days.
- Git operations executed via Node's `child_process.spawn`; commands limited to allowlisted repo root and standard git/install/restart commands.
- Token validation + optional IP allowlist handled before any git work; reject 401 or 403.

## Risks

- Token leak: rotate tokens periodically and store hashed or via Windows credential store.
- Git command failures (merge conflicts/detached HEAD): fail fast and surface details.
- Health endpoint flakiness: consider caching last known success to avoid constant restarts.

## Verification

- [ ] Project config includes required fields and points to pilot repo with allowlisted path.
- [ ] POST /v1/projects/:id/update (dry run) succeeds, reports clean steps, no installs/restarts.
- [ ] POST with `installMode=auto` after dependency change triggers install command.
- [ ] POST with `restartMode=auto` restarts service only when health fails.
- [ ] Health check respects `healthMode` and fails on non-200/timeout; response logged.
- [ ] Logs rotate daily, and GET /v1/projects/:id/status surfaces last report.

## Key takeaways

- v1 exposes three endpoints to safely orchestrate push-triggered git updates for allowlisted Windows projects.
- Config enforces least privilege: allowlist + token auth, no arbitrary commands, health URL required.
- Response payloads and NDJSON logs provide concise summaries for chat and audit trails.
