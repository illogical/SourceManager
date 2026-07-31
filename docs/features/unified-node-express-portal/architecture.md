# Target Architecture

## Decision

SourceManager becomes the composition root and the only managed HTTP server. Each sibling repository remains independently runnable but additionally produces an importable, compiled host adapter.

```text
Tailscale Service: apps
          |
          v
Node http.Server + Express (SourceManager, one configured port)
  |-- /SourceManager + /api/SourceManager
  |-- /DevPlanner    + /api/DevPlanner    + WS
  |-- /LMApi         + /api/LMApi         + Socket.IO
  |-- /MemoryApi     + /api/MemoryApi
  `-- /LMEval        + /api/LMEval        + WS
          |
          v
C:/LocalDev/Projects/<Repo>/dist/host/index.js
```

There are no loopback proxies to per-project ports in hosted mode. Express mounts middleware and static assets in-process. SourceManager creates and listens on the only `http.Server`.

## Hosted application contract

Define the contract in SourceManager and publish it as a type-only package or copy a versioned interface into each repository. Avoid a runtime dependency that would force a monorepo.

```ts
import type { Router } from "express";
import type { Server } from "node:http";

export interface HostedApplicationContext {
  projectId: string;
  repoRoot: string;
  webBasePath?: string;
  apiBasePath?: string;
  realtimeBasePath?: string;
  hostOrigin: string;
  environment: "development" | "production";
  log: HostLogger;
}

export interface HostedApplication {
  contractVersion: 1;
  router?: Router;                 // app-relative API routes
  static?: { directory: string; spaFallback: boolean };
  initialize?(): Promise<void>;
  attachRealtime?(server: Server): Promise<() => Promise<void> | void>;
  status(): Promise<HostedModuleStatus>;
  dispose?(): Promise<void>;
}

export function createHostedApplication(
  context: HostedApplicationContext,
): HostedApplication | Promise<HostedApplication>;
```

Contract requirements:

- No `listen()` call in an imported module.
- No top-level startup side effects. Configuration and singletons initialize inside the factory or `initialize()`.
- No `process.exit()` or global signal handlers in hosted mode.
- Every file/data/config/log/static path derives from `context.repoRoot`, not the host's `process.cwd()`.
- API routers define paths relative to their external prefix. For example, DevPlanner's router owns `/projects`, not `/api/projects`.
- Realtime adapters attach to the supplied shared server and reject upgrade paths they do not own.
- `dispose()` closes watchers, timers, sockets, database handles, and other owned resources for graceful host shutdown.
- Adapter load failures are isolated: SourceManager marks the project unavailable and continues loading other projects unless the failed project is SourceManager itself.

## Standalone contract

Each repository also has a thin `standalone` entry point:

```ts
const hosted = await createHostedApplication(localContext);
const app = express();
app.use("/api", hosted.router);
mountStandaloneStatic(app, hosted.static);
const server = createServer(app);
await hosted.initialize?.();
await hosted.attachRealtime?.(server);
server.listen(port);
```

Target scripts in every repository:

| Script | Required behavior |
|---|---|
| `npm run dev` | Standalone API plus frontend development experience; watches/restarts only this repo |
| `npm run build` | Produces `dist/host/index.js`, standalone server output, frontend assets, and build metadata |
| `npm start` | Runs the compiled standalone entry point with no TypeScript runtime dependency |
| `npm test` | Runs the repository's Node-compatible tests |
| `npm run verify:host` | Imports the compiled adapter without listening and validates the contract |

## Build and module loading

SourceManager loads compiled JavaScript only. The default adapter path is resolved as:

`<workspacePath>/<repoPath>/<host.module>`

Recommended output: `dist/host/index.js` with a package export named `./host`. Dynamic import must use a `file:` URL derived from the validated absolute path. Node resolves each adapter's dependencies from its own repository, so repositories retain their own `node_modules` and `package-lock.json`.

Before import, SourceManager validates:

1. resolved repository and adapter paths remain below `SOURCEMANAGER_WORKSPACE_PATH`;
2. adapter file exists and is not a symlink escape;
3. contract version is supported;
4. web/API/realtime mount paths are unique and reserved prefixes are rejected;
5. build metadata matches the configured project ID.

Each build writes a non-secret `dist/host/build-manifest.json`:

```json
{
  "contractVersion": 1,
  "projectId": "devplanner",
  "commit": "<full git sha>",
  "builtAt": "<ISO timestamp>",
  "nodeMajor": 22
}
```

## Status model

Child process lifecycle state disappears. Project cards instead show:

| Field | Meaning |
|---|---|
| `hostState` | `loading`, `ready`, `degraded`, `unavailable`, or `disabled` |
| `loadedCommit` | Commit recorded in the adapter build manifest and captured at host boot |
| `checkedOutCommit` | Current repository `HEAD` from a read-only Git query |
| `buildState` | `current`, `stale`, `missing`, or `invalid` |
| `workingTree` | `clean`, `dirty`, or `unknown` |
| `routeChecks` | Internal adapter status plus selected HTTP/WS smoke results |
| `lastLoadedAt` | When the current host imported the adapter |
| `lastError` | Sanitized load/initialization failure |

`loadedCommit !== checkedOutCommit` is the precise signal that the running portal does not represent the current checkout. Do not call a project "running latest" solely because a pull succeeded.

## Reload and update model

Do not attempt general in-process module hot replacement. Imported code can leave timers, watchers, WebSocket listeners, native database handles, and singleton state behind even after cache busting.

The safe update boundary is the whole host:

1. SourceManager performs project Git prechecks and fetch/pull.
2. If package metadata changed, run `npm ci` (or the approved install policy) in that repository.
3. Run `npm run build` in that repository.
4. Validate the new adapter in a short-lived build/verification command.
5. Persist update result outside process memory.
6. Request a graceful SourceManager shutdown with a distinct restart exit code.
7. A Windows wrapper starts `npm start` again.
8. On boot, load all adapters and verify web/API/realtime routes.
9. Display the new `loadedCommit` and the update result.

This preserves remote agent verification. The operational cost is one brief portal outage and interruption of any in-flight work across hosted modules. The portal must warn before restarting when long-running LMEval/LMApi jobs are active.

For interactive source development, `npm run dev` may use `tsx watch` or Node watch mode to restart the entire host when host/backend files change. Vite can run in middleware mode inside the same Node process for SourceManager's portal. Sibling hosted applications should default to compiled assets; developers use the repository's standalone `npm run dev` when they need that app's HMR.

## Startup and shutdown

Startup order:

1. Validate environment and project configuration.
2. Create Express and the shared `http.Server` without listening.
3. Register SourceManager health/auth/portal routes.
4. Load project adapters in deterministic config order.
5. Initialize modules, register routers/static paths, then attach realtime handlers.
6. Start listening.
7. Verify the host route and one application-owned health/status operation per module.
8. Reconcile the one Tailscale advertisement.

Shutdown order is the reverse: stop accepting requests, close realtime adapters, call module disposers, flush logs, then close the server. Enforce timeouts but report which module prevented graceful shutdown.

## Environment isolation

Importing modules into one process makes `process.env` global. Therefore:

- SourceManager loads only its own `.env` automatically.
- Every adapter loads `<repoRoot>/.env` explicitly into a local configuration object; it must not mutate `process.env` as its configuration store.
- Conflicting generic names such as `PORT`, `DATA_DIR`, and `LOG_LEVEL` must not be relied on globally.
- Secrets remain in the owning repository/environment and are never copied into the portal JSON schema or build manifest.
- The host context may pass explicit non-secret mount paths/origin and logger functions.

## Security boundaries

- Retain SourceManager token authentication for portal management/Git endpoints.
- Decide application authentication separately; a single Tailnet endpoint is not authorization by itself.
- Mount management routes before untrusted app catch-alls and never let a SPA fallback consume `/api/*`.
- Apply request-size limits per application, not one accidental global value.
- Validate and normalize route prefixes; reject `..`, encoded slash ambiguities, duplicates, and reserved `/api/SourceManager` ownership.
- Preserve argument-array child execution for Git/npm commands; never accept arbitrary install/build commands from browser input.
- Use one exact Tailscale service name/host, not a wildcard Tailnet allowlist.

## Compatibility decisions

- Node 22 LTS or a later explicitly pinned LTS is the target. Record it in `.nvmrc`/`.node-version` and `engines.node`.
- Express 5 is the target host framework. Standardize MemoryApi from Express 4 during its adapter work.
- React and Vite remain valid frontend tools. Vite is build-time or in-process middleware, not a separately managed hosted service.
- `ws` and Socket.IO remain necessary for real-time protocols; Express alone does not implement WebSocket upgrades.
- Native dependencies such as `better-sqlite3` and `sqlite3` remain in their owning repositories and must be validated against the pinned Node ABI.

