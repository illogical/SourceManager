# LMApi Migration Plan

## Verified current state

- Commit inspected: `f2ebf17` on `main`.
- Already Node + Express 5 in `src/app.ts`, using an explicit `http.Server` and Socket.IO.
- Static HTML dashboards and assets are served at root; browser code uses root-relative `/api`, `/styles`, `/scripts`, `/history`, `/evaluator`, and `/socket.io` paths.
- API routes are currently split between `/api/*`, root `/health`, and OpenAI-compatible `/v1/*`.
- `src/app.ts` loads configuration and initializes database/providers/server pool at module load/start, owns a pruning interval, calls `listen()`, and exits on startup failure.
- It uses `process.cwd()` to locate `src/public`; other services/configuration must be audited for the same assumption.
- It already has a committed npm lockfile. An untracked Bun lockfile is present but Bun is not required by the current scripts/runtime.

## Migration size

This is the lowest-risk backend conversion because Express and a shared HTTP server already exist. The main work is extracting composition/startup, prefixing static/browser paths, and making Socket.IO share SourceManager's server.

## Backend extraction

1. Move router/static composition into `createHostedApplication(context)` without creating or listening on a server.
2. Export an app-relative API router:
   - existing `/api/servers` becomes router `/servers`;
   - existing `/api/chat/...` becomes router `/chat/...`;
   - OpenAI `/v1/chat/completions` remains router `/v1/chat/completions`.
3. Move `ConfigService.loadConfig`, `DbService.initialize`, `ProviderService.initialize`, `ServerPoolService.initialize`, and request-registry pruning into `initialize()`.
4. Return a disposer that clears the prune interval, closes Socket.IO, stops server-pool timers, and closes database resources where supported.
5. Remove `process.exit()` from hosted code and return a typed initialization failure.
6. Resolve public/data/config/log paths from `context.repoRoot` or explicit LMApi configuration.
7. Keep LMApi's request body limit and error middleware scoped to its router so it does not change other applications.

## Socket.IO changes

- Initialize Socket.IO against the shared SourceManager `http.Server` in `attachRealtime()`.
- Configure its hosted path as `/api/LMApi/socket.io`; standalone path may remain `/socket.io`.
- Update browser clients to call `io({ path: realtimePath })` rather than `io()` with the root default.
- Ensure the Socket.IO HTTP polling path does not fall through to a project API or SPA fallback.
- Add a disposer and verify the server has only one connection/upgrade listener per LMApi load.

## Dashboard/static changes

- Serve the dashboard at `/LMApi`, history at `/LMApi/history`, and evaluator at `/LMApi/evaluator`.
- Add a tiny client configuration script or templated HTML values for `webBase`, `apiBase`, and `socketPath`.
- Replace all root-relative stylesheet/script/link/fetch values in the three HTML pages and `modelEvaluator.js`.
- Prefer one shared URL helper rather than manually concatenating dozens of paths.
- Move/copy generated browser assets into a stable build directory if `src/public` should not be treated as production output.

## LMApi compatibility

Canonical hosted routes:

- `/api/LMApi/servers`, `/models`, `/chat/...`, `/prompt-history`, etc.;
- `/api/LMApi/v1/chat/completions` for OpenAI compatibility;
- `/api/LMApi/health` for project status;
- `/LMApi/*` for dashboards.

Existing remote consumers currently configured for `http://host:3111/v1` need their base URL changed. If migration must be staged, add an explicit host-level compatibility alias `/v1 -> /api/LMApi/v1` for one release and log its use. Do not expose two independent implementations.

## npm/Bun notes

- Keep npm, `package-lock.json`, `tsc`, `ts-node` or replace dev with `tsx`.
- Remove the untracked Bun lockfile rather than adopting it, after confirming it contains no intended dependency change.
- Ensure `npm start` uses compiled standalone output and `npm run build` also produces the host export and manifest.
- Validate `better-sqlite3` against the pinned Node LTS/ABI on the Windows host.

## Acceptance criteria

- Importing `dist/host/index.js` has no listener, timer, DB, or provider side effect before initialization.
- Hosted dashboard, history, evaluator, CSS/JS, REST, OpenAI, Socket.IO WebSocket, and polling all work below their prefixes.
- LMEval can use the canonical hosted LMApi URL.
- Standalone `npm run dev`, `npm run build`, and `npm start` retain current behavior.
- A graceful host shutdown closes Socket.IO, intervals, server-pool checks, and database handles.
- Native module install/build passes on the pinned Node version.

