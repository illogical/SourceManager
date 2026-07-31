# SourceManager Migration Plan

## Verified current state

- Commit inspected: `20ac774` on branch `master`.
- Backend: Bun + Elysia in `src/index.ts`; it owns static hosting, API, Swagger, process startup reconciliation, and per-service Tailscale reconciliation.
- Frontend: React/Vite in `frontend/`; its API client uses root-relative `/v1/*` and `/health` paths.
- Current dev mode uses `concurrently` to run Bun watch plus a separate Vite process.
- Bun APIs exist in Git execution, installation, Tailscale execution/discovery, process management, request logging, and startup file creation.
- Tests are split between `bun:test` and Vitest.
- `scripts/SourceManagerStartup.ps1` locates Bun and launches `bun run dev`.
- Current service/process state is persisted in `data/state.json` and surfaced through lifecycle routes/UI.

## Target repository structure

```text
src/
  app.ts                    # Express composition, no listen
  server.ts                 # shared http.Server creation
  standalone.ts             # only entry point that listens
  host/
    loader.ts               # validates/imports sibling adapters
    contract.ts             # HostedApplication types
    registry.ts             # loaded status and route ownership
    static.ts               # bounded static + SPA mounting
    realtime.ts             # shared upgrade dispatch
    buildManifest.ts
  routes/
    health.ts
    projects.ts             # portal/Git/build/loaded status
    config.ts
    update.ts               # later project-level update workflow
  services/
    git.ts
    npm.ts                  # allowlisted install/build operations
    tailscale.ts            # one global service only
    projectStatus.ts
frontend/
dist/
  host/
  web/
```

## Express migration

1. Create `createSourceManagerApp()` returning an Express app/router without listening.
2. Port Elysia request logging, auth, error mapping, health, config, repo status, and update routes to Express routers.
3. Replace Elysia Swagger generation with an Express-compatible OpenAPI approach. Keep management documentation at `/api/SourceManager/docs` or another unambiguous path.
4. Create one `http.Server` so WebSocket/Socket.IO adapters can attach before `listen()`.
5. Mount the SourceManager management router at `/api/SourceManager` and portal assets at `/SourceManager`.
6. Make the portal API client use an injected `VITE_API_BASE`; its liveness request must not accidentally require the management token if public host health remains separate.
7. Configure React Router/base assets if the portal gains client-side routes.

## Bun-to-Node replacements

| Current use | Node replacement |
|---|---|
| `Bun.spawn` | `node:child_process.spawn`/`execFile` with argument arrays and explicit cwd/environment |
| `Bun.file().exists/text` | `node:fs/promises` `access`/`readFile` |
| `Bun.write` | `writeFile`/`appendFile`; preserve atomic state/config writes |
| `Bun.which` | resolve an exact executable using a small PATH search or maintained dependency |
| `Bun --watch` | `tsx watch`, Node watch mode, or a pinned dev watcher |
| `bunx vite` | local `vite` npm script/binary |
| `bun:test` | Vitest so backend and frontend share one Node-compatible runner |
| `bun-types` / `import.meta.dir` | Node types and `fileURLToPath(import.meta.url)` |
| `bun.lock` | committed `package-lock.json` generated with the pinned npm version |

Remove Bun as the default package-manager fallback. For the v2 hosted schema, update/build execution is npm-only. Retain detection of old Bun lockfiles only long enough to produce a clear migration error.

## Host loader implementation

- Resolve repository roots from the configured workspace and refuse escapes.
- Import compiled adapters deterministically and record load duration/error/build manifest.
- Give each adapter its own context with exact root and route prefixes.
- Initialize before listening so readiness never reports success while required modules are still loading.
- Treat nonessential adapter failure as project `unavailable`; keep portal routes usable.
- Track teardown functions and invoke them in reverse order.
- Use a shared logger with project ID fields, while allowing project-owned file logs below each repository.

## Dashboard simplification

Replace service cards with project cards that show:

- application link(s), API/docs link(s), and configured tags;
- host state and a concise module error;
- loaded commit, checkout commit, branch, dirty state, and build freshness;
- last build/load/update times;
- one global host/Tailnet status header;
- future fetch/pull/build/restart-host actions at project level.

Remove child start, stop, restart, PID, port, command, lifecycle badge, service-level health, and Tailnet controls. Keep the useful app/service grouping visually by showing capabilities (`Web`, `API`, `Realtime`) rather than runnable processes.

## Tailscale simplification

- Keep one global configured service (`apps`) targeting `http://127.0.0.1:<SOURCEMANAGER_PORT>`.
- Reconcile it once after host readiness, not during every project lifecycle transition.
- Provide one status block and one enable/disable control.
- Remove project/service names, targets, desired states, and drain/restore logic.
- A project load failure returns a project-specific 503 page/API response; it does not mutate the Tailscale advertisement.

## Restart-capable Windows operation

Replace the Bun scheduled-task launcher with a Node/npm launcher. It must:

- resolve `node.exe` and `npm.cmd` explicitly;
- start exactly one hosted SourceManager instance at a time;
- restart only for the designated restart exit code or crash policy;
- apply bounded backoff to prevent a boot-failure loop;
- keep transcripts under `data/logs` without secrets;
- report the single listener and loaded module summary;
- stop the exact process tree it owns and verify the port is released.

The production scheduled task should run built output (`npm start`), not a watch server. Interactive `npm run dev` remains a developer workflow.

## Tests and acceptance criteria

- Node-only install/build/start succeeds from a clean checkout.
- No executable Bun reference remains in SourceManager runtime, scripts, tests, or documentation.
- `GET /SourceManager` and an asset request return 200 under the path prefix.
- authenticated `/api/SourceManager/projects` reports all configured module states and both commits.
- a missing/broken sibling adapter marks only that project unavailable.
- duplicate or escaping route/module paths fail validation before listening.
- every SPA fallback is mount-bounded and `/api/*` still returns JSON 404s.
- a mocked adapter timer/WS attachment is disposed on graceful shutdown.
- the wrapper restarts after an update request and the new loaded commit is displayed.
- the one Tailscale service is reconciled only after the host is ready.

