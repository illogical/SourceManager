---
title: SourceManager — AI Agent Test Instructions
type: guide
---

# SourceManager API — Agent Test Instructions

You are testing the SourceManager API: a Bun/Elysia HTTP service that manages Git operations
and server process lifecycle for web applications running on a Windows dev machine.

## Connection details

| Setting | Value |
|---------|-------|
| Base URL | `<BASE_URL>` (e.g. `http://192.168.x.x:17106` or Tailscale IP) |
| Auth header | `X-DevServer-Token: <API_TOKEN>` |
| OpenAPI spec | `GET <BASE_URL>/swagger/json` |
| Swagger UI | `GET <BASE_URL>/swagger` |

Fetch `/swagger/json` first. Use it as your reference for all request and response shapes
throughout this session.

---

## Phase 1 — Smoke test

Run these steps in order. Report the full response body and HTTP status for each before
proceeding to the next.

### 1.1 — Liveness

```
GET /health
(no auth header)
```

**Expect:** HTTP 200, body `{"status":"ok","version":"1.0.0","uptimeMs":<number>}`

---

### 1.2 — Auth enforcement

```
GET /v1/projects
(no auth header)
```

**Expect:** HTTP 401

```
GET /v1/projects
X-DevServer-Token: <API_TOKEN>
```

**Expect:** HTTP 200, body contains a `projects` array with at least one entry.
Report the `id`, `port`, and `running` fields for each project.

---

### 1.3 — Project detail

```
GET /v1/projects/SourceManager
X-DevServer-Token: <API_TOKEN>
```

**Expect:** HTTP 200. Report the full response body.
Verify `repoPath` points to a real path on the dev machine.

---

### 1.4 — Dry run update (safe — no mutations)

```
POST /v1/projects/SourceManager/update
X-DevServer-Token: <API_TOKEN>
Content-Type: application/json

{"dryRun": true}
```

**Expect:** HTTP 200. Verify all of the following before continuing:

- `dryRun` is `true`
- `steps[0]` is `precheck` with `status: "success"` and message `"Working tree is clean"`
  - If precheck has `status: "failure"`, stop and report the full `message` — the working
    tree has uncommitted changes that must be resolved before any real update can run.
- All other steps have `status: "skipped"`
- `updated` is `false`
- `installRun.status` is `"skipped"`
- `restartRun.status` is `"skipped"`
- A `runId` (UUID) is present

---

### 1.5 — Run log

```
GET /v1/projects/SourceManager/status
X-DevServer-Token: <API_TOKEN>
```

**Expect:** HTTP 200. Verify the dry run from step 1.4 appears in the `runs` array,
identified by matching `runId`. Report the `healthStatus` and `updated` values.

---

**Phase 1 complete.** Report a pass/fail summary before proceeding to Phase 2.

---

## Phase 2 — Branch pull workflow

This phase tests the primary development workflow: pulling a feature branch that was
created and pushed from a client machine, so the dev server reflects the latest changes.

> **How self-update works in dev mode:**
> SourceManager runs with `bun run --watch`, which monitors source files for changes.
> When a git pull lands new source files, Bun's watch daemon detects the change and
> restarts the server automatically — no explicit restart API call is needed.
> The update workflow's health check step confirms the server came back up on its own.
> Use `restartMode: "never"` for SourceManager self-updates.

### 2.1 — Pull the default branch

Before testing a feature branch, confirm a clean pull of the default branch works end-to-end.

```
POST /v1/projects/SourceManager/update
X-DevServer-Token: <API_TOKEN>
Content-Type: application/json

{
  "installMode": "auto",
  "restartMode": "never"
}
```

**Expect:** HTTP 200. Report:
- `updated` — `true` if new commits were pulled, `false` if already up to date (both are valid)
- `reason` — the human-readable outcome message
- Each step in `steps` and its `status`
- `healthStatus` — must be `"pass"` for the test to be considered successful

If `healthStatus` is `"fail"`, report the `health` step's `message` and stop.

---

### 2.2 — Pull a specific feature branch

This is the core scenario: the dev machine checks out and pulls a branch that was created
and pushed from the client side.

```
POST /v1/projects/SourceManager/update
X-DevServer-Token: <API_TOKEN>
Content-Type: application/json

{
  "branch": "<BRANCH_NAME>",
  "installMode": "auto",
  "restartMode": "never"
}
```

Replace `<BRANCH_NAME>` with the name of the branch that was pushed from the client machine.

**Expect:** HTTP 200. Verify:
- `branch` in the response matches `<BRANCH_NAME>`
- `steps` contains `checkout` with `status: "success"` and message confirming the branch name
- `steps` contains `pull` with `status: "success"`
- `updated` is `true` (new commits were pulled)
- If `installMode` was `"auto"` and dependency files changed, `installRun.status` is `"success"`;
  otherwise it is `"skipped"`
- `healthStatus` is `"pass"`

---

### 2.3 — Verify the server restarted with the new code

After a successful pull in dev mode, Bun's `--watch` restarts the process automatically.
Confirm the new version is serving:

```
GET /health
(no auth header)
```

**Expect:** HTTP 200. The server responding at all confirms it came back up.

Optionally, check process state:

```
GET /v1/projects/SourceManager/process
X-DevServer-Token: <API_TOKEN>
```

Report the `running` field and the `startedAt` timestamp of the current process.
If `startedAt` is newer than the timestamp recorded in Phase 1, the restart was observed.

---

### 2.4 — Return to the default branch (cleanup)

After the feature branch test, restore the dev machine to the default branch:

```
POST /v1/projects/SourceManager/update
X-DevServer-Token: <API_TOKEN>
Content-Type: application/json

{
  "branch": "master",
  "installMode": "auto",
  "restartMode": "never"
}
```

**Expect:** HTTP 200, `healthStatus: "pass"`.

---

## Phase 2 complete — report

Summarise the following:

| Check | Result |
|-------|--------|
| Phase 1 all steps passed | |
| Default branch pull succeeded | |
| Feature branch checkout and pull succeeded | |
| `updated: true` on the feature branch pull | |
| `healthStatus: "pass"` after feature branch pull | |
| Server confirmed running after auto-restart | |
| Returned to default branch successfully | |

If any step produced an unexpected result, include the full response body, HTTP status code,
and the step `message` from the failing step in your report.

---

## Reference — update request fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `branch` | string | project's `defaultBranch` | Must match `/^[\w./-]+$/` — no spaces or shell characters |
| `installMode` | `auto` \| `always` \| `never` | `auto` | `auto` installs only when lockfile or `package.json` changed |
| `restartMode` | `auto` \| `always` \| `never` | `auto` | Use `never` for SourceManager self-updates (watch mode restarts automatically) |
| `dryRun` | boolean | `false` | Runs precheck only; skips all mutations |

## Reference — step names and what they mean

| Step | What it does | Failure means |
|------|-------------|---------------|
| `precheck` | `git status --porcelain` | Working tree has uncommitted changes — must be resolved manually |
| `fetch` | `git fetch origin` | Cannot reach the remote (network/auth issue) |
| `checkout` | `git checkout <branch>` | Branch doesn't exist or name is invalid |
| `pull` | `git pull --ff-only origin <branch>` | Merge conflict or diverged history |
| `depCheck` | Diff `ORIG_HEAD..HEAD` for lockfile changes | (informational — never fails) |
| `install` | Runs package manager install | Install command exited non-zero |
| `restart` | Kills and restarts the project process | Process could not be stopped or started |
| `health` | HTTP GET to `healthUrl` with 5 s timeout | Service not responding or returned non-2xx |
| `health-retry` | Re-checks health after auto-restart | Service still not healthy after restart |
