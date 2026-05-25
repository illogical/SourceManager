# SO-6A: Tailscale Serve with Per-Service HTTPS Ports

**Status:** Alternative implementation plan  
**Use when:** We want the simplest reliable Tailnet HTTPS exposure for many local web/API/MCP-over-HTTP services on one dev machine.  
**Primary tradeoff:** URLs include explicit HTTPS ports.

---

## Summary

Expose each configured local service through ordinary Tailscale Serve on a unique Tailnet HTTPS port:

```text
https://<machine>.<tailnet>.ts.net:8443 -> http://127.0.0.1:17106
https://<machine>.<tailnet>.ts.net:8444 -> http://127.0.0.1:17116
https://<machine>.<tailnet>.ts.net:8445 -> http://127.0.0.1:17103
```

This avoids port 443 collisions by not trying to put every service on `:443`. Tailscale terminates HTTPS on the Tailnet side, then proxies to each local `http://127.0.0.1:<port>` service.

This plan does not require Docker, custom DNS, a reverse proxy, or Tailscale Services. It is the fastest safe replacement for the current SO-6 assumption that every service can have its own root hostname.

References:

- Tailscale Serve: https://tailscale.com/docs/features/tailscale-serve
- `tailscale serve` CLI: https://tailscale.com/docs/reference/tailscale-cli/serve
- Tailscale Serve examples: https://tailscale.com/docs/reference/examples/serve

---

## Current LocalDev Services

Derived from `data/projects.localdev.example.json`.

| Service ID | Role | Local URL | Proposed Tailnet URL |
|---|---:|---|---|
| `sourcemanager-api` | API/dashboard backend | `http://127.0.0.1:17106` | `https://<machine>.<tailnet>.ts.net:8443` |
| `sourcemanager-web` | Vite web frontend | `http://127.0.0.1:17116` | `https://<machine>.<tailnet>.ts.net:8444` |
| `devplanner-api` | API/backend | `http://127.0.0.1:17103` | `https://<machine>.<tailnet>.ts.net:8445` |
| `devplanner-web` | Vite web frontend | `http://127.0.0.1:5173` | `https://<machine>.<tailnet>.ts.net:8446` |
| `lmapi-api` | API plus dashboard | `http://127.0.0.1:3111` | `https://<machine>.<tailnet>.ts.net:8447` |
| `memoryapi` | API plus review UI | `http://127.0.0.1:17107` | `https://<machine>.<tailnet>.ts.net:8448` |
| `lmeval-api` | API/backend | `http://127.0.0.1:3200` | `https://<machine>.<tailnet>.ts.net:8449` |
| `lmeval-frontend` | Vite web frontend | `http://127.0.0.1:5177` | `https://<machine>.<tailnet>.ts.net:8450` |

Notes:

- Replace `<machine>` with the actual Tailscale machine name, for example `tiny-tower`.
- Replace `<tailnet>` with the actual tailnet DNS name, for example `example.ts.net`.
- MCP is not a separate network protocol in this plan. Only MCP servers using an HTTP, SSE, or Streamable HTTP transport can be exposed. `stdio` MCP servers must be wrapped by an HTTP transport first.

---

## Proposed Config Model

Keep existing fields where possible, but reinterpret them for ordinary Tailscale Serve:

```json
{
  "id": "devplanner-api",
  "displayName": "DevPlanner API",
  "port": 17103,
  "tailnetHostname": "tiny-tower",
  "tailnetDomain": "your-tailnet.ts.net",
  "tailscaleServeEnabled": true,
  "tailscaleServeMode": "https-port",
  "tailscaleServePort": 8445,
  "tailscaleServeTarget": "http://127.0.0.1:17103"
}
```

Recommended type changes:

```typescript
export type TailscaleServeMode = "https-port"

export interface ServiceConfig {
  tailnetHostname?: string       // machine name for ordinary Serve
  tailnetDomain?: string         // tailnet DNS suffix
  tailscaleServeEnabled?: boolean
  tailscaleServeMode?: TailscaleServeMode
  tailscaleServePort?: number    // Tailnet HTTPS listener port
  tailscaleServeTarget?: string  // local upstream URL
}
```

Do not use `tailnetHostname` to mean a per-service hostname in this plan. It means the Tailscale machine name.

---

## CLI Behavior

Enable one service:

```bash
tailscale serve --bg --https=8445 http://127.0.0.1:17103
```

Disable one service:

```bash
tailscale serve --https=8445 off
```

Check current state:

```bash
tailscale status --json
tailscale serve status --json
```

Implementation requirements:

- Always pass command arguments as an array to `Bun.spawn`; never interpolate shell strings.
- Add `--bg` when enabling so the Serve entry persists after SourceManager exits.
- Use `127.0.0.1` in generated targets instead of `localhost` to avoid IPv4/IPv6 ambiguity.
- Validate that each enabled service has a unique `tailscaleServePort`.
- Validate that `tailscaleServePort` is not equal to the local app port unless explicitly allowed.
- Never call `tailscale funnel`.

---

## Backend Work

### 1. Update types

Files:

- `src/types.ts`
- `frontend/src/api/types.ts`

Add:

```typescript
export type TailscaleServeMode = "https-port"

export interface TailscaleServeEntry {
  servePort: number
  targetUrl: string
  source: "serve-status"
}

export interface TailscaleServeCheckResult {
  serviceId: string
  status: "active" | "inactive" | "mismatch" | "unconfigured" | "error"
  expectedUrl: string | null
  expectedServePort: number | null
  expectedTargetUrl: string | null
  actualEntry: TailscaleServeEntry | null
  mismatchReason: string | null
}
```

### 2. Update config validation

Files:

- `src/config.ts`
- `src/services/configEditor.ts`
- `frontend/src/components/Settings.tsx`

Rules:

- `tailscaleServeMode` must be `"https-port"` when set.
- `tailscaleServePort` must be an integer from `1` to `65535`.
- Enabled services require `tailnetHostname`, `tailnetDomain`, `tailscaleServePort`, and `tailscaleServeTarget`.
- `tailscaleServeTarget` must be `http://` or `https://`.
- Warn if two enabled services use the same `tailscaleServePort`.
- Warn if a target host is not localhost or 127.0.0.1.

### 3. Add Tailscale service module

File:

- `src/services/tailscale.ts`

Functions:

```typescript
export async function getMachineStatus(executor): Promise<TailscaleMachineStatus>
export async function getServeStatus(executor): Promise<TailscaleServeEntry[]>
export function checkServiceServe(service, entries, machine): TailscaleServeCheckResult
export async function enableServePort(service, executor): Promise<void>
export async function disableServePort(service, executor): Promise<void>
```

`enableServePort` constructs:

```typescript
["serve", "--bg", `--https=${service.tailscaleServePort}`, service.tailscaleServeTarget]
```

`disableServePort` constructs:

```typescript
["serve", `--https=${service.tailscaleServePort}`, "off"]
```

`expectedUrl` should be:

```text
https://<tailnetHostname>.<tailnetDomain>:<tailscaleServePort>
```

### 4. Add routes

File:

- `src/routes/tailscale.ts`

Routes:

```text
GET  /v1/tailscale/status
POST /v1/tailscale/services/:serviceId/serve/enable
POST /v1/tailscale/services/:serviceId/serve/disable
```

All routes require `X-DevServer-Token`.

Responses:

- `200`: action succeeded or status returned.
- `404`: unknown service ID.
- `422`: service is missing Tailscale fields.
- `409`: requested `tailscaleServePort` conflicts with another enabled service.
- `503`: Tailscale missing, stopped, or login required.
- `500`: CLI command failed.

---

## Frontend Work

Files:

- `frontend/src/api/client.ts`
- `frontend/src/components/TailscaleStatus.tsx`
- `frontend/src/components/TailscalePanel.tsx`
- `frontend/src/components/ServiceCard.tsx`
- `frontend/src/components/Settings.tsx`

Required UI:

- Header-level Tailscale status indicator.
- Per-service Tailnet exposure panel.
- Display expected URL with copy/open affordance.
- Display local target URL and HTTPS serve port.
- Enable/disable button with pending/error states.
- Settings editor field for `tailscaleServePort`.
- Validation warning when two services share the same Tailnet HTTPS port.

The panel copy must make clear that the hostname is the machine name, not a service-specific hostname.

---

## Tests

Backend tests:

- `getMachineStatus` parses `tailscale status --json`.
- `getServeStatus` parses `tailscale serve status --json`.
- `checkServiceServe` returns active when port and target match.
- `checkServiceServe` returns mismatch when port matches but target differs.
- `enableServePort` uses `["serve", "--bg", "--https=8445", "http://127.0.0.1:17103"]`.
- `disableServePort` uses `["serve", "--https=8445", "off"]`.
- Routes reject unauthenticated requests.
- Routes reject duplicated `tailscaleServePort`.
- Tests never run a real `tailscale` binary.
- Tests assert no command contains `funnel`.

Frontend tests:

- Service card shows expected Tailnet HTTPS URL.
- Enable/disable buttons call the correct API client functions.
- Settings validation catches invalid and duplicate HTTPS ports.

---

## Acceptance Criteria

- Every configured service can be assigned a unique Tailnet HTTPS port.
- Enabling a service creates a persistent ordinary Tailscale Serve entry.
- Disabling a service removes only that service's HTTPS port mapping.
- Multiple services can be active on the same machine at the same time.
- All exposed URLs use HTTPS from the client perspective.
- No service attempts to bind Tailnet port `443` unless it is the only enabled service or explicitly configured that way.
- SourceManager reports active/inactive/mismatch status per service.
- `bun test` and `bunx vitest run` pass.

---

## Operational Notes

This plan is the best first implementation because it is transparent and easy to recover from:

```bash
tailscale serve status
tailscale serve --https=8445 off
tailscale serve reset
```

Use `tailscale serve reset` only as a manual recovery command. SourceManager should not call it automatically because it would remove unrelated Serve entries.

