# DevPlanner Migration Plan

## Verified current state

- Commit inspected: `a383aee` on `main`.
- Backend is an Elysia application in `src/server.ts`, with many route factories and Elysia/OpenAPI validation.
- `src/server.ts` initializes singletons and starts a file watcher at module load, calls `app.listen()`, installs signal handlers, and uses `Bun.file` for production static serving.
- Native Bun WebSocket handling lives at `/api/ws`; `WebSocketService` is typed with Bun's `ServerWebSocket`.
- Frontend uses Vite and `BrowserRouter` without a basename. API and WebSocket clients use root-relative `/api` and `/api/ws`.
- Backend/service code uses `Bun.spawn`, `Bun.spawnSync`, `Bun.file`, and `Bun.write`; tests use `bun:test`.
- `package.json` scripts and Dockerfile are Bun-based. Both `package-lock.json` and Bun lockfiles exist.

## Migration size

This is the largest project migration. Its route layer, validation, WebSocket types, process execution, static hosting, tests, and startup lifecycle are coupled to Bun/Elysia. Convert it before SourceManager removes its compatibility path.

## Backend changes

1. Introduce `src/host.ts` exporting `createHostedApplication(context)`.
2. Port every `src/routes/*.ts` factory from Elysia to `express.Router`. Preserve service-layer behavior and response contracts.
3. Replace Elysia `t.*`/OpenAPI validation with Zod schemas plus explicit Express validation middleware. Generate OpenAPI from the same schemas or maintain a tested document.
4. Move ConfigService initialization behind a factory accepting `repoRoot` and explicit config values.
5. Move `WebSocketService`, `HistoryService`, and `FileWatcherService` initialization into `initialize()`; make repeated factory creation in tests safe.
6. Add `dispose()` to stop the file watcher, heartbeat timers, WebSocket clients, and any dispatch child processes.
7. Remove `app.listen()`, top-level signal handlers, and `process.exit()` from importable files. Put them in `src/standalone.ts` only.
8. Replace production `Bun.file` static responses with SourceManager-owned static mounting; standalone mode uses Express `static`/`sendFile` with an exact repo-root path.
9. Replace Bun process APIs in Git/worktree/dispatch/adapters with `execFileSync`, `spawn`, and `spawnSync`, using argument arrays and preserved timeout/cancellation behavior.
10. Replace Bun file APIs in backups, vault operations, and CLI adapter setup with `node:fs/promises`.

## WebSocket changes

- Replace Elysia/Bun WebSocket route with `ws` attached to the supplied shared `http.Server`.
- In hosted mode own exactly `/api/DevPlanner/ws`; in standalone mode keep `/api/ws`.
- Convert `WebSocketService` to a small application-owned client interface rather than Bun's `ServerWebSocket` type.
- Preserve subscription, unsubscribe, ping/pong, broadcast, close, and client ID semantics.
- Ensure the upgrade handler ignores other paths so LMApi and LMEval can share the server.
- Add upgrade-path tests and two-tab broadcast tests in both standalone and hosted modes.

## Frontend changes

- Make Vite config a function that reads `VITE_PUBLIC_BASE`, `VITE_API_BASE`, and `VITE_REALTIME_PATH`.
- Set hosted Vite `base` to `/DevPlanner/` and standalone base to `/`.
- Set `<BrowserRouter basename={publicBase}>`.
- Replace `const API_BASE = '/api'` with the injected API base.
- Replace the hard-coded `/api/ws` URL with the injected realtime path.
- Fix root asset literals in `frontend/index.html` (favicon and source/build paths).
- Audit anchors, `window.location`, downloads, and generated diff/viewer URLs for root assumptions.
- Restrict the standalone Vite proxy to its local backend; hosted mode has no Vite proxy.

## Filesystem/config changes

The hosted module must never interpret SourceManager's cwd as DevPlanner's root.

- Pass `repoRoot` into ConfigService and derive frontend dist, workspace defaults, backup directories, MCP config, and prompt/config files from it.
- Keep the separately configured DevPlanner content workspace distinct from the repository root.
- Start the file watcher only once and preserve the current `DISABLE_FILE_WATCHER` behavior.
- Load DevPlanner `.env` into a local object rather than globally mutating `process.env` during import.

## npm and Bun removal

- Switch all scripts to npm-invoked local tools (`tsx`, `vite`, `vitest`, `playwright`).
- Remove `elysia`, `@elysiajs/openapi`, `@types/bun`, Bun lockfiles, and Bun Docker base image after parity tests pass.
- Add Express 5, its types, `ws`, Zod middleware/helpers, and any Node watcher dependency chosen for dev.
- Convert `bun:test` suites to Vitest and Bun mocks/temp helpers to Node equivalents.
- Update MCP HTTP launch and verification scripts from Bun subprocess types/APIs to Node child processes.
- Keep the MCP stdio server independently runnable via npm; it is not mounted into the web host.

## Standalone scripts

Target behavior:

```json
{
  "dev": "concurrently -n api,web \"npm:dev:backend\" \"npm:dev:frontend\"",
  "dev:backend": "tsx watch src/standalone.ts",
  "dev:frontend": "npm --prefix frontend run dev",
  "build": "npm run build:backend && npm --prefix frontend run build && npm run build:manifest",
  "start": "node dist/standalone.js",
  "verify:host": "node scripts/verify-host.mjs"
}
```

Use platform-neutral npm syntax; do not retain `NODE_ENV=production ...` shell assignment on Windows. Set it through `cross-env` or the launcher.

## Acceptance criteria

- Existing REST routes and error/status semantics pass contract tests under the new Express router.
- `/DevPlanner`, nested `/DevPlanner/diff|viewer|editor`, assets, direct refresh, API, and WebSocket work through SourceManager.
- Standalone `npm run dev`, `npm run build`, and `npm start` work from the DevPlanner root.
- External file edits still reach clients through the watcher and WebSocket.
- Backup downloads and vault file responses remain correct under a prefixed API.
- No runtime/test/script Bun dependency remains.
- Hosted initialization/disposal leaves no watcher, timer, WebSocket, or subprocess behind.

