# SourceManager

SourceManager is the Node 24 / Express 5 composition root for the LocalDev application portal. It owns one HTTP server and mounts compiled adapters from independent sibling repositories without turning them into a monorepo.

Canonical hosted paths:

| Project | Web | API | Realtime |
|---|---|---|---|
| SourceManager | `/SourceManager` | `/api/SourceManager` | — |
| DevPlanner | `/DevPlanner` | `/api/DevPlanner` | `/api/DevPlanner/ws` |
| LMApi | `/LMApi` | `/api/LMApi` | `/api/LMApi/socket.io` |
| MemoryApi | `/MemoryApi` | `/api/MemoryApi` | — |
| LMEval | `/LMEval` | `/api/LMEval` | `/api/LMEval/ws` |

Missing or invalid sibling adapters are isolated as unavailable; SourceManager and other valid applications continue loading.

## Requirements

- Node `24.18.1` (pinned in `.node-version` and `.nvmrc`)
- npm 11
- Git
- Tailscale when the global `apps` advertisement is enabled

## Configuration

Copy `.env.example` to `.env` and set:

```text
SOURCEMANAGER_PORT=17106
SOURCEMANAGER_TOKEN=<secret value>
SOURCEMANAGER_WORKSPACE_PATH=C:/LocalDev/Projects
```

Copy `data/projects.example.json` to the gitignored `data/projects.json` only after reviewing the v2 adapter catalog. Configuration contains no secrets. Project, adapter, static, and route paths are validated before listening; repository/module/static symlink escapes are rejected.

The old v1 configuration is never converted in place. `POST /api/SourceManager/config/preview-v1` returns a preview with removed-field warnings. Saving v2 configuration creates a timestamped backup and uses an atomic temporary-file rename.

## Install, build, and run

```powershell
npm ci
npm run build
npm run verify:host
npm start
```

`npm start` executes compiled JavaScript and owns the single configured listener. `npm run dev` builds first and restarts the entire Node host when backend source changes. Individual application HMR remains in each sibling repository's standalone `npm run dev` workflow.

The portal is at `http://127.0.0.1:17106/SourceManager`; `/` redirects there. Public `GET /health` reports host readiness. Management routes require `X-DevServer-Token`:

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/SourceManager/projects` | Module, build, checkout, and working-tree status |
| GET | `/api/SourceManager/events` | Recent project/build/load/config/Tailnet events |
| GET | `/api/SourceManager/config` | v2 configuration and non-secret runtime summary |
| POST | `/api/SourceManager/config/validate` | Validate and diff without writing |
| PUT | `/api/SourceManager/config` | Atomically save v2 configuration |
| POST | `/api/SourceManager/config/preview-v1` | Preview legacy conversion without writing |
| GET | `/api/SourceManager/tailnet` | One global `apps` advertisement status |
| POST | `/api/SourceManager/tailnet/enable` | Enable and persist global advertisement |
| POST | `/api/SourceManager/tailnet/disable` | Drain, disable, and persist advertisement |
| POST | `/api/SourceManager/restart` | Request graceful wrapper restart (exit 75) |
| GET | `/api/SourceManager/openapi.json` | Management OpenAPI document |

The browser token is separately stored as `sm:token` in origin-specific localStorage. Changing `.env` requires a host restart; the Settings page never writes secrets to configuration.

## Hosted adapter contract

Each enabled repository builds `dist/host/index.js`, `dist/host/build-manifest.json`, standalone output, and web assets. Adapters use application-relative Express routers, derive paths from the injected `repoRoot`, attach only their declared realtime path, and dispose every owned resource. See [the adapter guide](docs/features/unified-node-express-portal/host-adapter-guide.md).

The safe update boundary is a whole-host restart. A project is current only when the adapter manifest's `loadedCommit` equals the repository's `checkedOutCommit`. General in-process module hot replacement is unsupported.

## Tests

```powershell
npm test
npm run typecheck
npm run verify:fixture
```

Set `RUN_STANDALONE_CONTRACTS=1` to run the captured phase-0 HTTP/WebSocket contract probes against all five independently running applications. Without it, the live probes are skipped but the baseline coverage test still runs.

## Windows production

The scheduled task runs `scripts/SourceManagerStartup.ps1`, which resolves Node/npm, holds a single-instance lock, runs compiled output, honors restart exit code 75, and applies bounded crash backoff. See [Windows production wrapper](docs/features/unified-node-express-portal/windows-production.md) for installation and verification.

Architecture, decisions, schema, migration steps, and remaining app phases are under [docs/features/unified-node-express-portal](docs/features/unified-node-express-portal/README.md).
