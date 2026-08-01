# Implementation Task List and Rollout

## Phase 0: decisions and safety baseline

- [ ] Confirm Node LTS target (Node 24 confirmed) and pin Node/npm versions in every repo. SourceManager is pinned; sibling pins intentionally land with phases 3–5 so their existing worktrees are not modified by this phase.
- [x] Confirm canonical URL casing and whether temporary lowercase aliases are required.
- [x] Confirm global Tailscale service name `apps` and the resulting Tailnet DNS name/policy grant.
- [x] Decide whether `/v1` remains a temporary LMApi compatibility alias.
- [x] Define restart behavior for active LMApi requests and LMEval evaluations.
- [x] Capture API/browser/WebSocket contract tests against every current standalone app.
- [x] Back up current gitignored SourceManager config; do not overwrite it during schema development.

## Phase 1: shared hosted contract

- [x] Add versioned `HostedApplication` types, context, status, build manifest, logger, and disposer semantics.
- [x] Build a fixture adapter and verify import from a sibling directory with its own dependencies.
- [x] Implement safe repo/module/static path resolution and symlink-escape checks.
- [x] Implement route-prefix validation, collision detection, ordering, and reserved prefixes.
- [x] Implement shared `http.Server` realtime dispatch for `ws` and Socket.IO ownership.
- [x] Add hosted contract verification script usable by every repository.
- [x] Document standalone wrapper pattern and environment isolation.

## Phase 2: build the SourceManager Node/Express host

- [x] Port Elysia management routes/middleware/errors/OpenAPI to Express 5.
- [x] Replace every `Bun.*`, Bun test, Bun type, Bun script, and Bun lock dependency.
- [x] Implement adapter loader/registry, bounded static mounts, realtime attachments, and isolated status.
- [x] Implement v2 config loader/editor/validator and a preview-only v1 converter.
- [x] Mount the five LocalDev projects with the canonical route map.
- [x] Replace frontend service/lifecycle UI with project/capability/build/Git/load cards.
- [x] Replace per-service Tailscale code/UI/config with one global status/toggle.
- [x] Replace process/update state and logs with project/build/load events.
- [x] Add restart-capable Windows npm production wrapper and update scheduled-task docs.
- [x] Add SourceManager host/standalone build manifest (self project).

Implementation note: the active gitignored v1 config remains untouched. The checked-in v2 catalog mounts all five projects, and missing phase 3–5 adapters are reported as isolated `unavailable` modules until those repositories are migrated.

## Phase 3: migrate DevPlanner

- [ ] Port all Elysia route factories and validation/OpenAPI behavior to Express/Zod.
- [ ] Refactor top-level ConfigService/singleton/watcher initialization.
- [ ] Replace Bun WebSocket with `ws` and generic client types.
- [ ] Replace all Bun process/file APIs in runtime, tools, and tests.
- [ ] Add injected repository/content workspace paths and local env configuration.
- [ ] Add Vite base, BrowserRouter basename, API base, and realtime path.
- [ ] Convert tests and scripts from Bun to npm/Vitest/Node.
- [ ] Replace Bun Docker/runtime references where still supported.
- [ ] Add standalone/host outputs, manifest, disposal, and parity tests.

## Phase 4: migrate low-risk Express applications

### LMApi

- [ ] Extract router/factory from `src/app.ts`; isolate startup and listen.
- [ ] Scope initialization, intervals, Socket.IO, DB, providers, and server pool to adapter lifecycle.
- [ ] Normalize app-relative API/OpenAI routes.
- [ ] Prefix dashboard assets/links/fetches and Socket.IO path.
- [ ] Add host/standalone build outputs and manifest.
- [ ] Remove accidental Bun lockfile after dependency review.
- [ ] Verify Node ABI/native DB dependency.

### MemoryApi

- [ ] Upgrade and test Express 5.
- [ ] Extract router/factory and standalone listen.
- [ ] Refactor every application cwd-derived path to injected repo-root/config paths.
- [ ] Make memory initialization/degradation visible in adapter status.
- [ ] Prefix static UI and browser API calls.
- [ ] Add resource disposal and temporary-data host tests.
- [ ] Add host/standalone build outputs and manifest.

## Phase 5: migrate LMEval

- [ ] Port Hono routes/error handling to Express routers.
- [ ] Convert backend services to injected repo-root/config paths.
- [ ] Declare/attach/dispose `ws` on the shared server.
- [ ] Add Vite base and React Router basename.
- [ ] Inject LMEval API, LMApi API, and realtime paths.
- [ ] Replace Bun/background shell scripts with cross-platform npm scripts.
- [ ] Add compiled standalone start, host export, manifest, and Node tests.
- [ ] Implement active-evaluation restart policy.


## Phase 6: project-level Git/update foundation

This phase preserves the original SourceManager objective without implementing broad Git UI scope prematurely.

- [ ] Change update identity from `repoId + serviceId` to `projectId`.
- [ ] Preserve clean-tree, branch validation, fetch, checkout, and fast-forward-only pull safeguards.
- [ ] Detect `package.json`/`package-lock.json` changes and run npm install under an explicit policy.
- [ ] Always build and verify the affected adapter after a code update unless a proven artifact-only rule skips it.
- [ ] Capture old/new checkout/build commits and structured steps.
- [ ] Request one graceful host restart and verify `loadedCommit === checkedOutCommit` after boot.
- [ ] Handle SourceManager self-update through the same wrapper boundary.
- [ ] Surface interrupted/failed update state after restart.

## Phase 7: remove v1 service management

- [ ] Meet every deletion gate in [feature-removal.md](feature-removal.md).
- [ ] Delete ProcessManager, runner state/protocol, child lifecycle endpoints, port registry, and child health restart logic.
- [ ] Delete service lifecycle/Tailnet UI and nested service config/editor/types.
- [ ] Delete per-service Tailscale desired-state/reconcile implementation.
- [ ] Remove old tests and replace them with host/adapter/status/update coverage.
- [ ] Update README, specification, OpenAPI, examples, startup scripts, and historical feature status.
- [ ] Remove v1 compatibility code after the documented rollback window.

## End-to-end acceptance matrix

### Local host

- [ ] Clean `npm ci` and `npm run build` succeeds in all five repositories.
- [ ] `npm start` in SourceManager owns the single configured listener.
- [ ] No configured sibling app owns a hosted-mode TCP listener or child npm process.
- [ ] All web roots, nested SPA refreshes, assets, APIs, downloads, Swagger/docs, WebSockets, Socket.IO polling/upgrades, and LMApi-to-LMEval calls pass.
- [ ] Each project card reports ready/degraded/unavailable accurately.
- [ ] Checkout, build, and loaded commit values are independently verified.

### Standalone parity

- [ ] In each sibling root, `npm run dev` works with expected HMR/realtime behavior.
- [ ] `npm run build && npm start` runs that project independently on its configured standalone port.
- [ ] Standalone paths remain documented and tested, even if hosted prefixes differ.
- [ ] Project tests do not depend on SourceManager being present.

### Tailnet

- [ ] Local SourceManager origin and host health work before advertisement.
- [ ] Exactly one configured Tailscale service/Serve target points to SourceManager.
- [ ] `https://apps.<tailnet>.ts.net/SourceManager` and every configured web/API/realtime path work from a second Tailnet device.
- [ ] One toggle disables/enables the portal as designed; project load status does not create extra advertisements.
- [ ] Authentication, cookies/storage, CORS, WebSocket upgrade, and large/streaming response behavior are verified over HTTPS.

### Update/restart

- [ ] Pulling each repository changes checkout status without falsely changing loaded status.
- [ ] Build failure leaves the old host running and reports the failure.
- [ ] Successful build triggers one graceful restart and loads the new commit.
- [ ] SourceManager self-update restarts through the external wrapper.
- [ ] Active long-running work follows the chosen block/cancel/resume policy.
- [ ] After verification, the scheduled production host is restored and port/PID ownership is confirmed.

## Rollout order and rollback

1. Land standalone-compatible adapters in sibling repos first; do not change current SourceManager config.
2. Land Node/Express SourceManager host behind `SOURCEMANAGER_HOST_MODE=v2`.
3. Run all projects in hosted mode locally while v1 remains available on a separate test port, never the production port simultaneously.
4. Verify the route matrix locally and from a second Tailnet device.
5. Switch the one Tailnet target and scheduled launcher to v2.
6. Observe update/restart and loaded-commit behavior.
7. Remove v1 only after the rollback window.

Rollback restores the prior SourceManager release, v1 config backup, scheduled launcher, and prior Tailscale advertisement. Sibling repositories remain independently runnable throughout, so they do not require source rollback merely to recover availability.

## Inspection baseline and worktree notes

These were pre-existing at inspection time and must not be overwritten or folded into migration commits without owner review:

| Repo | Branch / commit | Existing worktree state |
|---|---|---|
| SourceManager | `master` / `20ac774` | staged modification: `data/projects.localdev.example.json` |
| DevPlanner | `main` / `a383aee` | modified `frontend/vite.config.ts`; untracked `.claude/settings.json` |
| LMApi | `main` / `f2ebf17` | untracked `bun.lock` |
| MemoryApi | `main` / `4ec8daa` | modified `data/memory.db`; untracked `data/dev/`, `data/test/` |
| LMEval | `main` / `8c29a70` | modified `bun.lock` |

Create one branch/PR per repository and one integration tracking issue. Do not make a cross-repository atomic commit assumption; sequence by adapter contract compatibility and keep SourceManager tolerant of missing/older adapters during rollout.

