# SO-6C: Tailscale Services with Named Tailnet Hostnames

**Status:** Alternative implementation plan  
**Use when:** We want clean per-service Tailnet hostnames, each on HTTPS port 443.  
**Primary tradeoff:** Requires Tailscale Services setup, admin approval, and tag-based service-host identity.

---

## Summary

Use Tailscale Services to publish each web/API/MCP-over-HTTP service as a named Tailnet service:

```text
https://devplanner.<tailnet>.ts.net     -> http://127.0.0.1:5173
https://devplanner-api.<tailnet>.ts.net -> http://127.0.0.1:17103
https://lmeval.<tailnet>.ts.net         -> http://127.0.0.1:5177
https://lmeval-api.<tailnet>.ts.net     -> http://127.0.0.1:3200
```

This is the closest match to the original SO-6 intent. Unlike ordinary Tailscale Serve, Tailscale Services are designed to provide named internal resources with MagicDNS names and independent service identities.

References:

- Tailscale Services: https://tailscale.com/docs/features/tailscale-services
- Tailscale Services configuration file: https://tailscale.com/docs/reference/tailscale-services-configuration-file
- `tailscale serve` CLI: https://tailscale.com/docs/reference/tailscale-cli/serve

---

## Naming Convention

Use short, predictable service names:

| Resource kind | Name pattern | Example |
|---|---|---|
| Web/UI | `<project>` | `devplanner.<tailnet>.ts.net` |
| API | `<project>-api` | `devplanner-api.<tailnet>.ts.net` |
| MCP over HTTP | `<project>-mcp` | `devplanner-mcp.<tailnet>.ts.net` |
| Combined API + UI | `<project>` | `lmapi.<tailnet>.ts.net` |

MCP note:

- MCP is an application protocol, not a DNS or transport protocol by itself.
- MCP servers using HTTP, SSE, or Streamable HTTP can be exposed through Tailscale Services.
- `stdio` MCP servers cannot be exposed directly. They need an HTTP transport wrapper first.

All generated URLs must use `https://`.

---

## Current LocalDev Service Map

Derived from `data/projects.localdev.example.json`.

| Service ID | Tailscale Service | Public URL | Local Target |
|---|---|---|---|
| `sourcemanager-web` | `svc:sourcemanager` | `https://sourcemanager.<tailnet>.ts.net` | `http://127.0.0.1:17116` |
| `sourcemanager-api` | `svc:sourcemanager-api` | `https://sourcemanager-api.<tailnet>.ts.net` | `http://127.0.0.1:17106` |
| `devplanner-web` | `svc:devplanner` | `https://devplanner.<tailnet>.ts.net` | `http://127.0.0.1:5173` |
| `devplanner-api` | `svc:devplanner-api` | `https://devplanner-api.<tailnet>.ts.net` | `http://127.0.0.1:17103` |
| `lmapi-api` | `svc:lmapi` | `https://lmapi.<tailnet>.ts.net` | `http://127.0.0.1:3111` |
| `memoryapi` | `svc:memory` | `https://memory.<tailnet>.ts.net` | `http://127.0.0.1:17107` |
| `lmeval-frontend` | `svc:lmeval` | `https://lmeval.<tailnet>.ts.net` | `http://127.0.0.1:5177` |
| `lmeval-api` | `svc:lmeval-api` | `https://lmeval-api.<tailnet>.ts.net` | `http://127.0.0.1:3200` |

Optional aliases can be added later, but the first implementation should avoid duplicate services pointing at the same local target unless there is a concrete need.

---

## Tailscale Prerequisites

This plan requires more than ordinary Tailscale Serve:

1. Tailscale Services must be available on the tailnet.
2. Each service must be defined in the Tailscale admin console or through the Tailscale API.
3. The dev machine must be authenticated with a tag-based identity. Tailscale docs state that a Service host cannot be a normal user-authenticated device.
4. Each advertised Service host may need admin approval unless auto-approval is configured.
5. Client devices must be on a Tailscale version that can discover Tailscale Services. Tailscale docs state clients version 1.94 and later no longer require enabling `accept-routes` for Services.
6. Be aware of the documented no-hairpinning limitation: the service-host machine may not be able to access a Service that it hosts through the Service hostname.
7. Client devices must be granted access to each Service in the tailnet policy file. Auto-approvers only control Service-host advertisement; they do not grant clients permission to connect.

Recommended tailnet policy setup (verified against [Tailscale Services](https://tailscale.com/docs/features/tailscale-services) documentation, last validated Feb 2, 2026):

```json
{
  // Who may assign tag:dev-service-host to the dev machine (required for Service hosts)
  "tagOwners": {
    "tag:dev-service-host": ["autogroup:admin"]
  },

  // Auto-approve Service-host advertisements from tagged dev machines
  "autoApprovers": {
    "services": {
      "svc:sourcemanager": ["tag:dev-service-host"],
      "svc:sourcemanager-api": ["tag:dev-service-host"],
      "svc:devplanner": ["tag:dev-service-host"],
      "svc:devplanner-api": ["tag:dev-service-host"],
      "svc:lmapi": ["tag:dev-service-host"],
      "svc:memory": ["tag:dev-service-host"],
      "svc:lmeval": ["tag:dev-service-host"],
      "svc:lmeval-api": ["tag:dev-service-host"]
    }
  },

  // Grant tailnet members access to each Service on HTTPS port 443
  "grants": [
    {
      "src": ["autogroup:member"],
      "dst": [
        "svc:sourcemanager",
        "svc:sourcemanager-api",
        "svc:devplanner",
        "svc:devplanner-api",
        "svc:lmapi",
        "svc:memory",
        "svc:lmeval",
        "svc:lmeval-api"
      ],
      "ip": ["443"]
    }
  ]
}
```

Policy notes:

- Tailscale policy files use HuJSON (JSON with comments and trailing commas). The admin console visual editor accepts the same structure.
- `tagOwners` keys must use the `tag:` prefix; `autoApprovers.services` keys use `svc:<service-name>` for individual Services, or `tag:<service-tag>` to auto-approve hosts for all Services carrying that tag.
- `autoApprovers.services` approvers can be users, groups, autogroups, or tags. Tag-based approvers are preferred so approval does not break if a user account changes.
- Auto-approver policies apply when Tailscale first receives a Service-host advertisement. Adding or changing auto-approvers does not retroactively approve existing pending hosts — drain, clear, and re-advertise if needed.
- `grants` are required for client access. Destinations use the `svc:` prefix (same name as in the admin console, without repeating `svc:` in the Service definition step). Restrict `src` or split grants if some Services should not be reachable by all members.
- Authenticate the dev machine with `tag:dev-service-host` (for example, a pre-authorized auth key scoped to that tag). User-authenticated devices cannot host Tailscale Services.

---

## Proposed Config Model

Add a Tailscale Services exposure mode:

```json
{
  "id": "devplanner-api",
  "displayName": "DevPlanner API",
  "port": 17103,
  "tailnetExposureMode": "tailscale-service",
  "tailscaleServiceName": "devplanner-api",
  "tailscaleServiceEnabled": true,
  "tailscaleServiceProtocol": "https",
  "tailscaleServicePort": 443,
  "tailscaleServiceTarget": "http://127.0.0.1:17103"
}
```

Suggested types:

```typescript
export type TailnetExposureMode = "tailscale-service"

export interface ServiceConfig {
  tailnetExposureMode?: TailnetExposureMode
  tailscaleServiceName?: string       // without svc:
  tailscaleServiceEnabled?: boolean
  tailscaleServiceProtocol?: "https"
  tailscaleServicePort?: number       // default 443
  tailscaleServiceTarget?: string
}
```

Expected URL:

```text
https://<tailscaleServiceName>.<tailnetDomain>
```

`tailnetDomain` may remain server-level or service-level. Prefer server-level if all services are on the same tailnet.

---

## CLI Behavior

Enable/configure one Tailscale Service endpoint:

```bash
tailscale serve --service=svc:devplanner-api --https=443 http://127.0.0.1:17103
```

Enable/configure web:

```bash
tailscale serve --service=svc:devplanner --https=443 http://127.0.0.1:5173
```

Check status:

```bash
tailscale serve status --json
tailscale serve get-config --all
tailscale status --json
```

Drain before removing or changing a Service host:

```bash
tailscale serve drain svc:devplanner-api
```

Remove an endpoint:

```bash
tailscale serve --service=svc:devplanner-api --https=443 off
```

Remove all endpoint mappings for one Service:

```bash
tailscale serve clear svc:devplanner-api
```

Do not use `tailscale serve reset` from SourceManager because it removes all Service configurations on the host.

---

## Optional Config File Mode

The CLI mode is preferred for interactive operations because it configures and advertises. The config file mode is useful for full reconciliation.

Generated file example:

```json
{
  "version": "0.0.1",
  "services": {
    "svc:devplanner": {
      "endpoints": {
        "tcp:443": "http://127.0.0.1:5173"
      }
    },
    "svc:devplanner-api": {
      "endpoints": {
        "tcp:443": "http://127.0.0.1:17103"
      }
    }
  }
}
```

Apply:

```bash
tailscale serve set-config --all serveconfig.json
tailscale serve advertise svc:devplanner
tailscale serve advertise svc:devplanner-api
```

Use this only after the implementation can safely generate the complete host config. Otherwise, prefer per-service CLI commands to avoid overwriting unrelated services.

---

## Backend Work

Suggested files:

- `src/services/tailscale.ts`
- `src/services/tailscaleServices.ts`
- `src/routes/tailscale.ts`
- `tests/vitest/services/tailscaleServices.test.ts`
- `tests/vitest/routes/tailscaleServices.test.ts`

Functions:

```typescript
export function normalizeServiceName(name: string): string
export function serviceNameToCliName(name: string): `svc:${string}`
export function expectedServiceUrl(name: string, tailnetDomain: string): string
export async function getTailscaleServiceConfig(executor): Promise<TailscaleServiceConfig>
export async function enableTailscaleService(service, executor): Promise<void>
export async function disableTailscaleService(service, executor): Promise<void>
export async function drainTailscaleService(service, executor): Promise<void>
export function checkTailscaleService(service, config, status): TailscaleServiceCheckResult
```

Enable command args:

```typescript
[
  "serve",
  `--service=svc:${service.tailscaleServiceName}`,
  `--https=${service.tailscaleServicePort ?? 443}`,
  service.tailscaleServiceTarget
]
```

Disable command args:

```typescript
[
  "serve",
  `--service=svc:${service.tailscaleServiceName}`,
  `--https=${service.tailscaleServicePort ?? 443}`,
  "off"
]
```

Drain command args:

```typescript
["serve", "drain", `svc:${service.tailscaleServiceName}`]
```

Status checks should read both:

- `tailscale serve get-config --all` for desired host-side endpoint mappings.
- `tailscale status --json` for machine state and service-host capability/approval clues.

---

## API Routes

Add or adapt:

```text
GET  /v1/tailscale/status
POST /v1/tailscale/services/:serviceId/service/enable
POST /v1/tailscale/services/:serviceId/service/disable
POST /v1/tailscale/services/:serviceId/service/drain
```

Response should distinguish:

- local SourceManager service running/stopped
- Tailscale installed/running/login-required
- Tailscale Service configured/not configured
- Service host advertised/pending approval/connected/offline when detectable
- expected URL
- local target URL

Error statuses:

- `404`: service ID not found.
- `422`: missing service name, target, or invalid name.
- `424`: Tailscale Service is not defined or not approved yet when detectable.
- `503`: Tailscale unavailable.
- `500`: CLI command failed.

---

## UI Requirements

Service card panel:

- Show expected clean URL, for example `https://devplanner-api.<tailnet>.ts.net`.
- Show `svc:<name>`.
- Show local target.
- Show endpoint port, normally `443`.
- Show state:
  - not configured
  - configured locally
  - pending approval
  - connected
  - offline
  - mismatch
  - error
- Actions:
  - Enable/configure
  - Drain
  - Disable endpoint

Settings UI:

- `Tailscale Service Name`
- `Service Kind`: web, api, mcp-http, combined
- `Local Target`
- `HTTPS Port`
- `Enabled`

Validation:

- Service names use lowercase letters, numbers, and hyphens.
- Service names must not include `svc:` in config; SourceManager adds it for CLI calls.
- Web service should use `<project>`.
- API service should use `<project>-api`.
- MCP-over-HTTP service should use `<project>-mcp`.

---

## Tests

Unit tests:

- Service name normalization.
- Reject invalid service names.
- Expected URL generation.
- Enable command argument construction.
- Disable command argument construction.
- Drain command argument construction.
- Parse `tailscale serve get-config --all`.
- Detect mismatch when local target differs.
- Detect missing configured endpoint.

Route tests:

- Auth required.
- Missing Tailscale fields returns 422.
- Unknown service returns 404.
- CLI failure returns 500 without leaking shell details.
- No command contains `funnel`.
- No test invokes a real Tailscale binary.

Frontend tests:

- Clean service URL renders.
- Pending approval warning renders.
- Enable/disable/drain buttons call expected API endpoints.

Manual verification:

- Define `svc:devplanner-api` in Tailscale admin console.
- Authenticate the dev machine with `tag:dev-service-host`.
- Run enable from SourceManager.
- Approve host if needed.
- From another Tailnet device, open `https://devplanner-api.<tailnet>.ts.net/health`.
- Confirm host machine hairpin limitation separately; do not require local self-access for pass/fail.

---

## Acceptance Criteria

- SourceManager can configure at least two Tailscale Services on the same dev machine, both using HTTPS port 443.
- `devplanner.<tailnet>.ts.net` reaches DevPlanner web.
- `devplanner-api.<tailnet>.ts.net` reaches DevPlanner API.
- Service status distinguishes pending approval from command failure when Tailscale exposes enough information.
- The implementation never uses ordinary per-machine hostnames as a substitute for service names in this mode.
- The implementation never calls `tailscale funnel`.
- All tests pass.

---

## Recommendation

This is the best end-state if clean Tailnet hostnames are important. It should not be the first implementation unless the tailnet admin prerequisites are already in place. If we need working Tailnet HTTPS quickly, implement SO-6A first, then add SO-6C as an advanced exposure mode.
