# LMEval Migration Plan

## Verified current state

- Commit inspected: `8c29a70` on `main`.
- Backend uses Hono plus `@hono/node-server` in `server/index.ts` and attaches `ws` at `/ws/eval`.
- Frontend uses Vite/React and `BrowserRouter` without a basename.
- Browser API paths are root-relative `/api/eval`; LMApi browser calls use `/lmapi`; realtime uses `/ws/eval`.
- Backend services resolve eval/session/prompt/report/Git data from `process.cwd()`.
- `server/ws.ts` uses CommonJS `require('ws')` inside an ESM project and `ws` is not declared directly in the inspected manifest, so availability may currently be accidental/transitive.
- Scripts launch the backend/tests with Bun and `dev` uses shell background `&`, which is non-portable.
- Runtime application code otherwise has little direct Bun API coupling.

## Backend changes

1. Replace Hono route modules with Express 5 routers. Preserve request/response contracts and route tests.
2. Export app-relative routes from `createHostedApplication(context)`: current `/api/eval/templates` becomes router `/templates`, and so on.
3. Move template seeding and Git initialization checks into `initialize()`.
4. Remove the Hono `serve()` call from importable code; standalone owns `listen()`.
5. Replace `require('ws')` fallback with a declared direct `ws` dependency and an ESM import.
6. Attach `ws` to the shared SourceManager server at `/api/LMEval/ws`, with a standalone `/ws/eval` option.
7. Return a disposer that closes WebSocket clients/server and cancels or drains active evaluation work according to an explicit policy.
8. Ensure route errors and async exceptions flow through scoped Express error middleware.

## Repository-root refactor

Create an injected LMEval path/config object and replace cwd constants in:

- `FileService` eval/session directories;
- `GitService` data repository;
- `JudgeService` prompt directory;
- `PresetService` data directory;
- `ReportService` template/output paths;
- seed scripts where host verification imports shared code.

Load `.env` from LMEval's repository into a local object. `PORT` is standalone-only and must not affect SourceManager's listener.

## LMApi dependency

LMEval currently reaches LMApi through a Vite `/lmapi` proxy in the browser and a configured backend base URL. In hosted mode:

- browser LMApi requests use `/api/LMApi/*` directly;
- backend `LmapiClient` uses an injected canonical URL such as `http://127.0.0.1:<hostPort>/api/LMApi` or an explicit Tailnet-safe host origin;
- do not import LMApi service internals, preserving repository/API independence;
- avoid deadlock-prone assumptions: loopback HTTP is acceptable, but timeouts/cancellation remain required;
- SourceManager load order should initialize LMApi before LMEval and show LMEval degraded if the dependency is unavailable.

## Frontend changes

- Set Vite `base=/LMEval/` for hosted builds.
- Set React Router basename from the public base.
- Replace `/api/eval` with injected `/api/LMEval`.
- Replace `/lmapi` with injected `/api/LMApi`.
- Replace `/ws/eval` with injected `/api/LMEval/ws`.
- Update all absolute `navigate`, `Link`, export/download, fetch, favicon, and test expectations for the basename strategy.
- Keep standalone defaults matching current routes so `npm run dev` remains convenient.

## npm and Bun removal

- Replace Bun script invocations with local `tsx`/compiled Node and `concurrently` for standalone dev.
- Replace background `&` with a cross-platform npm concurrency script.
- Remove `@types/bun` and Bun lockfile after npm lock reconciliation.
- Declare `ws` directly.
- Keep Vite/Vitest as npm-invoked tools.
- Add `start` to run compiled standalone output; current manifest lacks a production start command.

## Long-running evaluation policy

A whole-host restart can interrupt evaluations. Before restart:

- expose active job count and cancellability in adapter status;
- refuse automatic restart while non-resumable jobs are active unless explicitly forced;
- persist enough run state to mark interrupted evaluations and allow retry/resume;
- close WebSockets with a restart reason so clients reconnect cleanly;
- verify persisted results before reporting the module disposed.

This policy is required before remote pull/build/restart is enabled.

## Acceptance criteria

- Hosted `/LMEval/*` direct navigation, assets, React routes, API, exports, LMApi calls, and WebSocket events all work.
- Standalone `npm run dev`, `npm run build`, `npm start`, and Node-compatible tests work.
- All data/Git/report paths remain below LMEval's root.
- LMEval becomes degraded, not host-fatal, when LMApi is unavailable.
- Restart policy correctly blocks, cancels, or marks active evaluations interrupted.
- No Bun runtime/tooling dependency remains.

