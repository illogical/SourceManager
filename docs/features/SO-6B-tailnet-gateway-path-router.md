# SO-6B: Tailnet Gateway Path Router

**Status:** Alternative implementation plan  
**Use when:** We want one Tailnet HTTPS origin that routes to many local web/API/MCP-over-HTTP services by URL path.  
**Primary tradeoff:** Some frontends and streaming protocols need path-prefix compatibility work.

---

## Summary

Run a local SourceManager-managed gateway process on one localhost port. Tailscale Serve exposes only the gateway. The gateway reverse-proxies path prefixes to local app ports:

```text
https://<machine>.<tailnet>.ts.net/devplanner      -> http://127.0.0.1:5173
https://<machine>.<tailnet>.ts.net/devplanner-api  -> http://127.0.0.1:17103
https://<machine>.<tailnet>.ts.net/lmeval          -> http://127.0.0.1:5177
https://<machine>.<tailnet>.ts.net/lmeval-api      -> http://127.0.0.1:3200
```

Tailscale handles TLS. The gateway handles HTTP path routing. Local apps continue to run on their existing Bun/npm dev ports.

References:

- Tailscale Serve: https://tailscale.com/docs/features/tailscale-serve
- `tailscale serve` CLI: https://tailscale.com/docs/reference/tailscale-cli/serve
- Tailscale Services endpoint types mention path-based L7 routing: https://tailscale.com/docs/features/tailscale-services

---

## Current LocalDev Route Map

Derived from `data/projects.localdev.example.json`.

| Public Path | Role | Local Target | Notes |
|---|---|---|---|
| `/sourcemanager` | SourceManager web | `http://127.0.0.1:17116` | Vite frontend |
| `/sourcemanager-api` | SourceManager API | `http://127.0.0.1:17106` | API and health |
| `/devplanner` | DevPlanner web | `http://127.0.0.1:5173` | Vite frontend; verify health URL currently points to API |
| `/devplanner-api` | DevPlanner API | `http://127.0.0.1:17103` | API and health |
| `/lmapi` | LMApi API plus dashboard | `http://127.0.0.1:3111` | Combined app |
| `/memory` | MemoryApi API plus review UI | `http://127.0.0.1:17107` | Combined app |
| `/lmeval` | LMEval frontend | `http://127.0.0.1:5177` | Vite frontend |
| `/lmeval-api` | LMEval API | `http://127.0.0.1:3200` | API |

Recommended MCP convention:

```text
/<project>-mcp -> HTTP/SSE/Streamable HTTP MCP endpoint
```

Examples:

```text
/devplanner-mcp
/memory-mcp
/lmeval-mcp
```

Do not expose `stdio` MCP servers directly. They need an HTTP transport wrapper before the gateway can route to them.

---

## Proposed Config Model

Add a gateway section at server level:

```json
{
  "server": {
    "port": 17106,
    "frontendPort": 17116,
    "tailnetGateway": {
      "enabled": true,
      "localPort": 18080,
      "tailnetHostname": "tiny-tower",
      "tailnetDomain": "your-tailnet.ts.net",
      "tailscaleServePort": 443
    }
  }
}
```

Add per-service gateway fields:

```json
{
  "id": "devplanner-api",
  "port": 17103,
  "tailnetRouteEnabled": true,
  "tailnetRoutePath": "/devplanner-api",
  "tailnetRouteTarget": "http://127.0.0.1:17103",
  "tailnetRouteStripPrefix": true,
  "tailnetRouteKind": "api"
}
```

Suggested types:

```typescript
export interface TailnetGatewayConfig {
  enabled: boolean
  localPort: number
  tailnetHostname: string
  tailnetDomain: string
  tailscaleServePort: number
}

export type TailnetRouteKind = "web" | "api" | "mcp-http" | "combined"

export interface ServiceConfig {
  tailnetRouteEnabled?: boolean
  tailnetRoutePath?: string
  tailnetRouteTarget?: string
  tailnetRouteStripPrefix?: boolean
  tailnetRouteKind?: TailnetRouteKind
}
```

Expected URL:

```text
https://<tailnetGateway.tailnetHostname>.<tailnetGateway.tailnetDomain><tailnetRoutePath>
```

If `tailscaleServePort` is not `443`, include it in the URL.

---

## Tailscale Serve Setup

The gateway listens locally:

```text
http://127.0.0.1:18080
```

SourceManager enables ordinary Tailscale Serve once for the gateway:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:18080
```

Disable:

```bash
tailscale serve --https=443 off
```

If another Serve entry already owns `443`, use a non-443 HTTPS port:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:18080
```

---

## Gateway Implementation

Add a small gateway server owned by SourceManager.

Suggested files:

- `src/services/tailnetGateway/config.ts`
- `src/services/tailnetGateway/router.ts`
- `src/services/tailnetGateway/server.ts`
- `src/services/tailnetGateway/proxy.ts`
- `src/routes/tailnetGateway.ts`
- `tests/vitest/services/tailnetGateway.test.ts`
- `tests/vitest/routes/tailnetGateway.test.ts`

The gateway can use `Bun.serve`, but the implementation must explicitly support:

- HTTP methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`.
- Request bodies without buffering large uploads unnecessarily.
- Streaming responses for MCP Streamable HTTP and SSE.
- WebSocket upgrade for Vite HMR and other realtime services.
- Redirect rewriting for upstream `Location` headers.
- Cookie path rewriting when upstream apps set path-specific cookies.
- Prefix stripping or preserving per route.

If `Bun.serve` proxy behavior is insufficient for WebSocket or streaming edge cases, use a proven reverse proxy library in a thin Node-compatible gateway process. Do not hand-roll WebSocket frame proxying.

---

## Routing Rules

Route matching:

1. Normalize incoming path.
2. Match the longest configured `tailnetRoutePath` prefix.
3. Reject ambiguous duplicates at config validation time.
4. If `tailnetRouteStripPrefix` is true, remove the matched prefix before forwarding.
5. Preserve query string.
6. Add proxy headers:

```text
X-Forwarded-Host
X-Forwarded-Proto: https
X-Forwarded-Prefix
X-Forwarded-For
```

Default prefix behavior:

| Kind | Strip Prefix | Reason |
|---|---:|---|
| `api` | true | APIs usually expect root-relative routes |
| `mcp-http` | true | MCP endpoints usually expect a fixed root endpoint |
| `web` | false initially | Vite and SPAs often need explicit base path work |
| `combined` | false initially | Combined apps may include root-relative assets |

For production-quality web routing, each frontend should support a configured base path. Without that, `/devplanner` may load but assets or client routes may request `/assets/*` from the gateway root.

---

## Frontend Base Path Requirements

For Vite apps:

- Set `base: "/devplanner/"` for DevPlanner web.
- Set `base: "/sourcemanager/"` for SourceManager web if routing it through the gateway.
- Set `base: "/lmeval/"` for LMEval frontend.
- Configure HMR client host/protocol when needed:

```typescript
server: {
  hmr: {
    protocol: "wss",
    host: "<machine>.<tailnet>.ts.net",
    clientPort: 443,
  },
}
```

If apps cannot be made path-prefix-aware, prefer Plan A or Plan C for those apps.

---

## Backend API

Add management routes:

```text
GET  /v1/tailnet-gateway/status
POST /v1/tailnet-gateway/start
POST /v1/tailnet-gateway/stop
POST /v1/tailnet-gateway/tailscale/enable
POST /v1/tailnet-gateway/tailscale/disable
```

Status response:

```json
{
  "gateway": {
    "enabled": true,
    "running": true,
    "localUrl": "http://127.0.0.1:18080",
    "tailnetUrl": "https://tiny-tower.your-tailnet.ts.net"
  },
  "routes": [
    {
      "serviceId": "devplanner-api",
      "path": "/devplanner-api",
      "target": "http://127.0.0.1:17103",
      "kind": "api",
      "status": "active"
    }
  ]
}
```

---

## UI Requirements

Add a gateway panel to the dashboard:

- Machine Tailnet URL.
- Gateway local port.
- Whether the gateway process is running.
- Whether Tailscale Serve is active for the gateway.
- Route table with each public path and local target.
- Per-route warnings:
  - upstream service stopped
  - duplicate path
  - frontend may not be base-path aware
  - MCP route uses unsupported non-HTTP transport

Each service card should show:

```text
Tailnet path: https://<machine>.<tailnet>.ts.net/devplanner-api
Local target: http://127.0.0.1:17103
```

---

## Tests

Unit tests:

- Longest-prefix route matching.
- Prefix stripping behavior.
- Duplicate route path validation.
- URL construction with and without non-443 Tailnet port.
- Rejection of invalid route paths that do not start with `/`.
- Rejection of non-local targets unless explicitly allowed.

Integration-style tests with fake upstream servers:

- HTTP GET proxy.
- POST body proxy.
- Query string preservation.
- `Location` header rewrite.
- Streaming response is not buffered.
- SSE response remains open.
- WebSocket proxy works for a simple echo server.

Tailscale command tests:

- Enable gateway uses `["serve", "--bg", "--https=443", "http://127.0.0.1:18080"]`.
- Disable gateway uses `["serve", "--https=443", "off"]`.
- No command contains `funnel`.

---

## Acceptance Criteria

- One Tailnet HTTPS URL can route to all configured local HTTP services by path.
- API services work with prefix stripping.
- At least one Vite frontend is verified through the gateway with assets, client routes, and HMR working.
- MCP-over-HTTP streaming endpoints work without response buffering.
- Gateway status appears in the SourceManager dashboard.
- Tailscale Serve is configured only for the gateway port, not once per service.
- All tests pass.

---

## Known Risks

Path routing is convenient but makes frontend compatibility the hard part. Many dev servers assume they live at `/`, and their generated asset URLs, redirects, cookies, WebSocket URLs, and OAuth callback URLs may not work behind `/app-name` until configured.

Use this plan when a single origin matters more than clean service hostnames. Use Plan A for low-risk direct exposure, and Plan C for clean names.
