# MemoryApi Migration Plan

## Verified current state

- Commit inspected: `4ec8daa` on `main`.
- Already Node + Express 4 in `src/app/index.ts`.
- `memoryRouter` and `reviewRouter` are mounted at `/api`; static review UI is served from `public`.
- Initialization runs at import time and `app.listen()` occurs in a promise `finally`, including degraded mode.
- Browser code in `public/app.js` uses root-relative `/api/*` paths.
- Configuration, database paths, prompt paths, tags/seeds, public assets, logging, and several services use `process.cwd()`.
- npm scripts/lockfile are present and no Bun runtime references were found.
- The repository has native `sqlite3` and multiple external data backends whose initialization can be slow or degraded.

## Backend extraction

1. Upgrade to Express 5 for host consistency, resolving async/error behavior changes with route tests.
2. Add `createHostedApplication(context)` returning a router and static descriptor without listening.
3. Mount `memoryRouter` and `reviewRouter` directly as app-relative routes; SourceManager adds `/api/MemoryApi`.
4. Move `initializeMemorySystem()` into `initialize()` and return an explicit `ready` or `degraded` status rather than starting regardless without structured state.
5. Add disposal methods for SQLite, Neo4j, Qdrant/SDK clients, background work, and MCP-related resources where applicable.
6. Keep the MCP stdio server as a separate npm command; do not start it from the hosted web adapter.
7. Put standalone listen logic in a compiled `src/standalone.ts` entry point.

## Repository-root refactor

This is mandatory before import into SourceManager. Introduce a `MemoryApiPaths`/config object created from `context.repoRoot`, then inject or expose it to services.

At minimum replace cwd-derived paths for:

- `public` static files;
- production/development/test SQLite databases;
- prompt templates;
- tags/categories/seed samples;
- review queue files;
- logs and reports;
- feedback/query loader relative paths.

CLI/evaluation scripts may continue to interpret CLI-relative arguments from their own cwd, but application services may not. Avoid top-level constants such as `TAGS_FILE = path.join(process.cwd(), ...)` because they are fixed before adapter context exists.

Load `<repoRoot>/.env` into a local configuration object with an explicit `MEMORY_DATA_ENV`. Do not let a generic `PORT` or dotenv side effect overwrite SourceManager/other adapter settings.

## Browser/static changes

- Serve UI at `/MemoryApi` and API at `/api/MemoryApi`.
- Inject an API base into `public/index.html` before `app.js`, or serve a non-secret `/MemoryApi/runtime-config.js`.
- Replace every root-relative `/api/...` fetch in `public/app.js` with the helper.
- Audit absolute asset/link URLs in HTML and CSS.
- Because the UI is not a client-routed SPA, use exact static routes and a 404 rather than a broad SPA fallback.

## Status behavior

Expose adapter status with independent components:

- HTTP/router ready;
- memory-system initialization state;
- SQLite state and selected data environment;
- optional Qdrant/Neo4j/LMStudio connectivity, sanitized;
- last initialization error and retry availability.

SourceManager must not mark the entire host unhealthy merely because an optional MemoryApi backend is degraded. The project card and `/api/MemoryApi/health` should expose the distinction.

## npm notes

- No Bun removal is needed.
- Add host/standalone build outputs and a build manifest to the existing `tsc` build.
- Validate both `sqlite3` and any SDK requirements against the pinned Node version.
- Preserve environment-isolated tests; make host adapter tests use temporary data paths and never the inspected `data/memory.db`.

## Acceptance criteria

- Hosted import does not open databases or start listening before `initialize()`.
- All runtime data stays below MemoryApi's configured data paths, never SourceManager's cwd.
- `/MemoryApi` UI CRUD calls reach `/api/MemoryApi/*` successfully.
- Degraded external services are reported without crashing SourceManager.
- Standalone `npm run dev`, `npm run build`, and `npm start` work.
- Shutdown closes owned resources and permits immediate SourceManager restart.
- Tests prove hosted mode cannot write to SourceManager's `data` directory.

