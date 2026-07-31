# Configuration Schema and Routing Plan

## Schema objective

Configuration describes repositories and how SourceManager mounts their artifacts. It no longer describes runnable child processes.

Recommended versioned schema:

```json
{
  "schemaVersion": 2,
  "server": {
    "allowedIps": []
  },
  "tailnet": {
    "serviceName": "apps",
    "enabled": true,
    "protocol": "https",
    "port": 443,
    "target": "http://127.0.0.1:17106"
  },
  "projects": [
    {
      "id": "devplanner",
      "displayName": "DevPlanner",
      "repoPath": "DevPlanner",
      "defaultBranch": "main",
      "enabled": true,
      "host": {
        "module": "dist/host/index.js",
        "exportName": "createHostedApplication",
        "contractVersion": 1
      },
      "web": {
        "mountPath": "/DevPlanner",
        "distPath": "frontend/dist",
        "spaFallback": true
      },
      "api": {
        "mountPath": "/api/DevPlanner"
      },
      "realtime": {
        "mountPath": "/api/DevPlanner/ws",
        "protocol": "websocket"
      },
      "build": {
        "script": "build",
        "verifyScript": "verify:host"
      },
      "tags": ["frontend", "api", "websocket"]
    }
  ]
}
```

`SOURCEMANAGER_PORT`, `SOURCEMANAGER_TOKEN`, and
`SOURCEMANAGER_WORKSPACE_PATH` remain environment-owned. The JSON file does not contain secrets.

## Field rules

| Field | Rule |
|---|---|
| `schemaVersion` | Required and exactly `2` for the first unified-host release |
| `repoPath` | Relative path; resolved path must remain under the configured workspace |
| `host.module` | Relative compiled JavaScript path; required for API/realtime apps |
| `web.distPath` | Relative build directory; optional for API-only projects |
| mount paths | Absolute URL paths, unique, no trailing slash, no query/fragment, no traversal |
| `build.script` | npm script name only; no shell command text |
| `tailnet.target` | Must target the one SourceManager listener; not editable per project |
| project IDs | Stable lowercase machine IDs; display names and URL casing are separate |

Remove these v1 fields:

- `server.frontendPort`;
- `repos[].services[]`;
- `packageManager`, `scriptName`, `installCommand` at service level;
- child `port`, `healthUrl`, `healthMode`, and `allowedIps`;
- `tailnetHostname`, `tailnetDomain`, `tailscaleServe*`, `tailnetExposureMode`, and `tailscaleService*` per service.

`build.script` is not process management. It is an allowlisted, short-lived update step, and the implementation always executes `npm run <script>` with an argument array in the owning repository.

## Full LocalDev example

```json
{
  "schemaVersion": 2,
  "server": { "allowedIps": [] },
  "tailnet": {
    "serviceName": "apps",
    "enabled": true,
    "protocol": "https",
    "port": 443,
    "target": "http://127.0.0.1:17106"
  },
  "projects": [
    {
      "id": "sourcemanager",
      "displayName": "SourceManager",
      "repoPath": "SourceManager",
      "defaultBranch": "master",
      "enabled": true,
      "host": { "module": "dist/host/index.js", "contractVersion": 1 },
      "web": { "mountPath": "/SourceManager", "distPath": "frontend/dist", "spaFallback": true },
      "api": { "mountPath": "/api/SourceManager" },
      "build": { "script": "build", "verifyScript": "verify:host" },
      "tags": ["portal", "management", "api"]
    },
    {
      "id": "devplanner",
      "displayName": "DevPlanner",
      "repoPath": "DevPlanner",
      "defaultBranch": "main",
      "enabled": true,
      "host": { "module": "dist/host/index.js", "contractVersion": 1 },
      "web": { "mountPath": "/DevPlanner", "distPath": "frontend/dist", "spaFallback": true },
      "api": { "mountPath": "/api/DevPlanner" },
      "realtime": { "mountPath": "/api/DevPlanner/ws", "protocol": "websocket" },
      "build": { "script": "build", "verifyScript": "verify:host" },
      "tags": ["frontend", "api", "websocket"]
    },
    {
      "id": "lmapi",
      "displayName": "LMApi",
      "repoPath": "LMApi",
      "defaultBranch": "main",
      "enabled": true,
      "host": { "module": "dist/host/index.js", "contractVersion": 1 },
      "web": { "mountPath": "/LMApi", "distPath": "src/public", "spaFallback": false },
      "api": { "mountPath": "/api/LMApi" },
      "realtime": { "mountPath": "/api/LMApi/socket.io", "protocol": "socket.io" },
      "build": { "script": "build", "verifyScript": "verify:host" },
      "tags": ["api", "dashboard", "socket.io"]
    },
    {
      "id": "memoryapi",
      "displayName": "MemoryApi",
      "repoPath": "MemoryApi",
      "defaultBranch": "main",
      "enabled": true,
      "host": { "module": "dist/host/index.js", "contractVersion": 1 },
      "web": { "mountPath": "/MemoryApi", "distPath": "public", "spaFallback": false },
      "api": { "mountPath": "/api/MemoryApi" },
      "build": { "script": "build", "verifyScript": "verify:host" },
      "tags": ["api", "review-ui"]
    },
    {
      "id": "lmeval",
      "displayName": "LMEval",
      "repoPath": "LMEval",
      "defaultBranch": "main",
      "enabled": true,
      "host": { "module": "dist/host/index.js", "contractVersion": 1 },
      "web": { "mountPath": "/LMEval", "distPath": "dist/web", "spaFallback": true },
      "api": { "mountPath": "/api/LMEval" },
      "realtime": { "mountPath": "/api/LMEval/ws", "protocol": "websocket" },
      "build": { "script": "build", "verifyScript": "verify:host" },
      "tags": ["frontend", "api", "websocket"]
    }
  ]
}
```

Use the actually configured default branch rather than blindly copying this example. The inspected SourceManager checkout is on `master`, while its current example says `main`; migration must resolve that discrepancy explicitly.

## Route ownership and matching order

Register in this order:

1. host liveness/readiness;
2. authenticated `/api/SourceManager` management routes;
3. project APIs from longest prefix to shortest;
4. realtime upgrade dispatch table;
5. static assets for each web mount;
6. per-project SPA fallbacks restricted to that web mount;
7. `/` redirect and final 404.

Never use a global `app.get("*")` for one project. Each fallback must be bounded to its own path and must exclude `/api`.

## Base-path rules for frontend code

Every browser application needs a single injected public base:

- Vite `base` controls built asset URLs.
- React Router `basename` controls navigation.
- API clients use an injected API base, not root-relative `/api` or `/v1` literals.
- WebSocket URLs use the injected realtime path with the current origin/protocol.
- HTML anchors, favicons, scripts, styles, downloads, and redirects use base-aware URL helpers.

Recommended compile-time variables:

```text
VITE_PUBLIC_BASE=/DevPlanner/
VITE_API_BASE=/api/DevPlanner
VITE_REALTIME_PATH=/api/DevPlanner/ws
```

Standalone Vite configuration supplies `/`, `/api`, and the current standalone WebSocket path. Hosted builds supply the configured prefixes. Do not maintain separate source branches for these modes.

## API normalization and compatibility

The adapter strips the project namespace by mounting app-relative routers:

- existing DevPlanner `/api/projects` becomes `/api/DevPlanner/projects`;
- existing MemoryApi `/api/review/queue` becomes `/api/MemoryApi/review/queue`;
- existing LMEval `/api/eval/templates` becomes `/api/LMEval/templates`;
- existing LMApi `/api/servers` becomes `/api/LMApi/servers`;
- existing LMApi `/v1/chat/completions` becomes `/api/LMApi/v1/chat/completions`.

During one release, standalone servers may keep old paths and the unified host may provide explicit 308 redirects for browser GET routes. Do not redirect mutation endpoints or WebSockets; update clients and agents to canonical URLs. Preserve a documented optional compatibility alias for LMApi's OpenAI clients if changing their base URL cannot be coordinated immediately.

## Schema migration strategy

1. Add a pure v1-to-v2 preview converter that groups service metadata into one project.
2. Map display name/repo/default branch automatically.
3. Populate mount/module/dist values from a checked-in project catalog, not guesses based on ports.
4. Collapse every per-service Tailscale entry into one global `tailnet` block.
5. Show removed fields and warnings; never silently discard custom install commands.
6. Write v2 atomically only after all adapter artifacts validate.
7. Keep a timestamped backup of v1 config and support read-only rollback to the old release.
8. Do not auto-migrate the user's gitignored `data/projects.json` during the planning phase.

