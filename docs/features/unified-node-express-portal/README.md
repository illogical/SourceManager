# Unified Node/Express Portal Plan

Status: planning handoff

Scope: `C:/LocalDev/Projects/{SourceManager,DevPlanner,LMApi,MemoryApi,LMEval}`

Baseline inspected: 2026-07-31

## Outcome

Replace SourceManager's per-service process manager with one Node/Express host that:

- serves the SourceManager portal and every configured web application from one HTTP server;
- mounts every API and real-time endpoint under an application-owned path;
- exposes one Tailnet service named `apps` (final name is configurable) to one local port;
- retains separate Git repositories, dependencies, builds, tests, and standalone npm commands;
- reports whether each hosted module loaded, which build and commit is running, and whether the checkout differs;
- preserves project-level fetch/pull/build/reload as the next feature, without keeping child-service start/stop/restart controls.

This is not an npm monorepo. SourceManager discovers sibling repositories below
`SOURCEMANAGER_WORKSPACE_PATH=C:/LocalDev/Projects` and imports each repository's compiled host adapter.

## Necessary changes summary

1. Port SourceManager from Bun/Elysia to Node 22+ and Express 5, replacing `Bun.*`, `bun:test`, and Bun startup scripts.
2. Define a small `HostedApplication` contract. Each repository exports a factory that returns an Express router, initialization/disposal hooks, health/status metadata, and optional WebSocket attachment.
3. Split every application into an import-safe host module and a standalone entry point. Imported modules must not call `listen()`, `process.exit()`, install signal handlers, or assume `process.cwd()` is their repository.
4. Build each frontend for a configurable base path, make browser API/asset/WebSocket URLs mount-aware, and serve the built output from SourceManager.
5. Replace the nested `repos[].services[]` schema with project-level web/API/realtime/build/module declarations. Remove ports, package managers, scripts, child health URLs, lifecycle state, and per-service Tailscale fields.
6. Replace per-service health with host/module/build/Git status. Capture both the checked-out commit and the commit loaded by the running host.
7. Replace unsafe in-process hot module replacement with rebuild plus whole-host restart. A restart-capable Windows wrapper is required so SourceManager can update itself and load newly pulled sibling code.
8. Keep one global Tailscale status/toggle and one advertisement targeting SourceManager's port.

## Planned canonical route map

Routes are case-sensitive in documentation but the host should redirect common lowercase aliases to the canonical display-name paths. API adapters expose app-relative routes so prefixes do not double up.

| Project | Web | API | Realtime |
|---|---|---|---|
| SourceManager | `/SourceManager` (`/` redirects here) | `/api/SourceManager/*` | none initially |
| DevPlanner | `/DevPlanner/*` | `/api/DevPlanner/*` | `/api/DevPlanner/ws` |
| LMApi | `/LMApi/*` | `/api/LMApi/*`; OpenAI compatibility at `/api/LMApi/v1/*` | `/api/LMApi/socket.io/*` |
| MemoryApi | `/MemoryApi/*` | `/api/MemoryApi/*` | none |
| LMEval | `/LMEval/*` | `/api/LMEval/*` | `/api/LMEval/ws` |

The initially requested paths remain available, including `/api/LMApi`. `/LMApi` and
`/api/LMEval` are added because those repositories currently contain a dashboard and an API respectively.

## Artifact index

| File | Purpose |
|---|---|
| [architecture.md](architecture.md) | Target process model, hosted-module contract, lifecycle, reload, status, security, and compatibility decisions |
| [schema-and-routing.md](schema-and-routing.md) | Proposed JSON schema, route ownership, path rules, configuration migration, and example configuration |
| [sourcemanager-migration.md](sourcemanager-migration.md) | Node/Express portal host migration and Bun removal |
| [devplanner-migration.md](devplanner-migration.md) | Elysia-to-Express, WebSocket, SPA base-path, filesystem, and Bun migration |
| [lmapi-migration.md](lmapi-migration.md) | Existing Express extraction, Socket.IO pathing, dashboard assets, and API normalization |
| [memoryapi-migration.md](memoryapi-migration.md) | Existing Express extraction, initialization, static UI, and repository-root fixes |
| [lmeval-migration.md](lmeval-migration.md) | Hono-to-Express, native WebSocket, SPA base-path, LMApi dependency, and npm migration |
| [feature-removal.md](feature-removal.md) | Backend, UI, schema, persistence, tests, and documentation that become removable |
| [tasks.md](tasks.md) | Ordered cross-repository implementation task list, acceptance tests, rollout gates, and worktree notes |

## Key feasibility finding

One managed server is feasible without moving repositories. It is not feasible to preserve each backend as an independently listening server while also claiming one runtime process; reverse proxying would retain all child processes. It is also unsafe to hot-swap arbitrary Node modules after a pull because timers, sockets, database handles, watchers, and module caches cannot be reliably unloaded. The supported hosted update path is therefore:

`fetch/pull -> npm install when needed -> npm run build -> validate adapter -> restart SourceManager -> verify routes -> record loaded commit`

Standalone development remains:

`cd C:/LocalDev/Projects/<Repo> && npm run dev`

That explicit standalone command may start Vite and an API watcher for the selected project; those processes are outside the unified hosted mode and are only run intentionally.

## Out of scope for this plan

- Implementing Git fetch/pull controls now (the architecture preserves the boundary).
- Turning the sibling repositories into npm workspaces or Git submodules.
- Combining source trees, lockfiles, databases, or environment files.
- Removing React/Vite as frontend build tooling. "Node + Express" is the server runtime decision, not a ban on frontend build tools or application libraries.
- Running arbitrary source TypeScript directly from sibling repositories in production.
