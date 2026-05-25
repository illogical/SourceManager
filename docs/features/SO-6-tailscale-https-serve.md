# SO-6: Tailscale HTTPS Serve — Implementation Plan

**DevPlanner card:** SO-6  
**Priority:** 6 (follows SO-4 JSON config edit UI, which is complete)  
**Status:** Superseded — do not implement as written  

> **Feasibility warning:** This plan should not be implemented directly. It was
> written around an incorrect assumption: that ordinary `tailscale serve` can run
> once per local service and assign each service its own clean Tailnet hostname at
> HTTPS root, such as `https://devplanner.<tailnet>.ts.net` and
> `https://devplanner-api.<tailnet>.ts.net`, all from the same PC. Ordinary
> Tailscale Serve is centered on the host machine's MagicDNS name, so multiple
> local services on one machine must be distinguished by HTTPS port or URL path
> unless Tailscale Services are used.
>
> Use one of the replacement plans instead:
>
> - [SO-6A: Tailscale Serve with Per-Service HTTPS Ports](./SO-6A-tailscale-serve-https-ports.md)
>   for the simplest reliable Tailnet HTTPS implementation.
> - [SO-6B: Tailnet Gateway Path Router](./SO-6B-tailnet-gateway-path-router.md)
>   for one machine hostname with path routing to web/API/MCP-over-HTTP services.
> - [SO-6C: Tailscale Services with Named Tailnet Hostnames](./SO-6C-tailscale-services-named-services.md)
>   for clean names like `https://devplanner.<tailnet>.ts.net` and
>   `https://devplanner-api.<tailnet>.ts.net`.
>
> The most pragmatic implementation order is SO-6A first, then SO-6C if the
> tailnet admin prerequisites for Tailscale Services are acceptable. SO-6B is a
> useful app-shell option, but it has more frontend and streaming-proxy edge
> cases.

---

## Why this plan is not feasible as written

The design below makes several assumptions that do not hold for the target
deployment:

1. **Per-service hostnames are not ordinary Serve hostnames.** Ordinary Tailscale
   Serve exposes services under the Tailscale device's MagicDNS name, for example
   `https://tiny-tower.<tailnet>.ts.net`. It can multiplex by port or path, but it
   does not give every local service a separate root hostname on port 443.
2. **Port 443 cannot host several unrelated root services on one hostname.** If
   every service wants `https://<same-host>/` on port 443, there must be a
   routing discriminator: a different hostname, a different port, or a different
   path.
3. **Clean service names require Tailscale Services.** Names like
   `https://devplanner.<tailnet>.ts.net` and
   `https://devplanner-api.<tailnet>.ts.net` should be modeled with Tailscale
   Services, not plain per-device Serve.
4. **The CLI examples are stale.** This plan uses the older
   `tailscale serve https / <target>` form. New implementation work should verify
   and use the current `tailscale serve` syntax from official Tailscale docs,
   including flags such as `--https=<port>`, `--set-path=<path>`, and
   `--service=svc:<name>` where appropriate.
5. **MCP must be treated by transport.** MCP is not exposed merely by naming it
   "MCP"; only MCP servers with HTTP, SSE, or Streamable HTTP transports can be
   reached through these HTTPS plans. `stdio` MCP servers need an HTTP wrapper.

This file remains as historical context only. A coding agent should start from
SO-6A, SO-6B, or SO-6C instead of using the implementation steps below.

## Objective

Make every configured SourceManager service exposable over private Tailnet HTTPS via
`tailscale serve`. The dashboard must show whether Tailscale is connected on the
host machine, whether each service's serve is active or inactive, and surface any
mismatches between configured and actual state. Controlled enable/disable endpoints
let the user toggle per-service exposure from the UI.

This card **does not** include public `tailscale funnel` support. All exposure is
private Tailnet only.

---

## Decisions (confirmed before writing this plan)

| Decision | Choice |
|---|---|
| Integration approach | CLI adapter wrapping `tailscale` binary (Option A from SO-1) |
| Tailscale minimum version | 1.56+ (supports `tailscale serve https / <url>` syntax) |
| Serve mode | HTTPS at root path (`/`) per service only; no path-based routing |
| Machine-level status | Read via `tailscale status --json` |
| Serve status | Read via `tailscale serve status --json` |
| Enable command | `tailscale serve https / <target>` |
| Disable command | `tailscale serve https off` |
| CLI binary location | Try `tailscale` in PATH first; on Windows also try `C:\Program Files\Tailscale\tailscale.exe` |
| Executor interface | `TailscaleCliExecutor` — injectable fake for tests, real `Bun.spawn` in production |
| No funnel | `tailscale funnel` is out of scope — never run it |
| Machine status endpoint | `GET /v1/tailscale/status` returns machine + per-service serve check results |
| Enable/disable routes | `POST /v1/tailscale/services/:serviceId/serve/enable` and `.../disable` |
| UI: machine status | `TailscaleStatus` indicator in `App.tsx` header — colored dot + label |
| UI: per-service | `TailscalePanel` embedded in `ServiceCard` — expected URL, serve status badge, toggle button |
| Tests | Vitest (node) for service + routes; Vitest (jsdom) for frontend; fake executor only |
| Non-goal | No `tailscale funnel`; no multi-path serve; no Tailscale admin API |

---

## Architecture overview

```
Browser
  │
  ├── GET  /v1/tailscale/status                          → machine + all-service serve check
  ├── POST /v1/tailscale/services/:serviceId/serve/enable   → tailscale serve https / <target>
  └── POST /v1/tailscale/services/:serviceId/serve/disable  → tailscale serve https off

Backend
  src/services/tailscale.ts          ← TailscaleService wrapping TailscaleCliExecutor
  src/routes/tailscale.ts            ← three Elysia routes, auth-guarded
  src/index.ts                       ← register tailscaleRoute

Frontend
  TailscaleStatus (header)           ← machine state: connected/disconnected/error
  TailscalePanel (in ServiceCard)    ← per-service: expected URL, serve badge, toggle
```

Two states are always kept separate and visible:

- **Process lifecycle** (running / stopped / failed) — managed by `processManager`
- **Tailnet exposure** (active / inactive / mismatch) — managed by `TailscaleService`

A service can be running but not Tailnet-exposed, or configured for Tailscale but
currently stopped. Both states must be independently visible in the UI.

---

## TypeScript types

### Backend additions (`src/types.ts`)

```typescript
// ── Tailscale types ────────────────────────────────────────────────────────────

export type TailscaleBackendState =
  | "Running"
  | "Stopped"
  | "NeedsLogin"
  | "NoState"
  | "unknown"

export interface TailscaleMachineStatus {
  installed: boolean
  version: string | null
  backendState: TailscaleBackendState
  tailnetName: string | null          // e.g. "bangus-city.ts.net"
  ipv4: string | null                 // e.g. "100.x.x.x"
  selfHostname: string | null         // e.g. "tiny-tower"
  selfDnsName: string | null          // e.g. "tiny-tower.bangus-city.ts.net."
  loginRequired: boolean
}

export interface TailscaleServeEntry {
  hostname: string                    // e.g. "tiny-tower.bangus-city.ts.net"
  port: number                        // e.g. 443
  path: string                        // e.g. "/"
  targetUrl: string                   // e.g. "http://127.0.0.1:17106"
}

export type TailscaleServeCheckStatus =
  | "active"       // serve is running and matches config
  | "inactive"     // serve is not running; config says it should be off
  | "mismatch"     // serve is running but target/hostname differs from config
  | "unconfigured" // service has no tailnet fields set
  | "error"        // failed to read serve status

export interface TailscaleServeCheckResult {
  serviceId: string
  status: TailscaleServeCheckStatus
  expectedUrl: string | null          // null if unconfigured
  actualEntry: TailscaleServeEntry | null
  mismatchReason: string | null
}

export interface TailscaleStatusResponse {
  machine: TailscaleMachineStatus
  services: TailscaleServeCheckResult[]
}
```

### Frontend additions (`frontend/src/api/types.ts`)

```typescript
export type TailscaleBackendState =
  | "Running"
  | "Stopped"
  | "NeedsLogin"
  | "NoState"
  | "unknown"

export interface TailscaleMachineStatus {
  installed: boolean
  version: string | null
  backendState: TailscaleBackendState
  tailnetName: string | null
  ipv4: string | null
  selfHostname: string | null
  selfDnsName: string | null
  loginRequired: boolean
}

export interface TailscaleServeEntry {
  hostname: string
  port: number
  path: string
  targetUrl: string
}

export type TailscaleServeCheckStatus =
  | "active"
  | "inactive"
  | "mismatch"
  | "unconfigured"
  | "error"

export interface TailscaleServeCheckResult {
  serviceId: string
  status: TailscaleServeCheckStatus
  expectedUrl: string | null
  actualEntry: TailscaleServeEntry | null
  mismatchReason: string | null
}

export interface TailscaleStatusResponse {
  machine: TailscaleMachineStatus
  services: TailscaleServeCheckResult[]
}

export interface TailscaleServeActionResponse {
  success: boolean
  serviceId: string
  action: "enable" | "disable"
  message: string
}
```

---

## Backend: `src/services/tailscale.ts`

This module provides a pure service layer around the Tailscale CLI. It never reads
`cachedConfig` directly; it accepts the relevant `ServiceConfig` values as arguments.

### `TailscaleCliExecutor` interface

```typescript
export interface TailscaleCliExecutorResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface TailscaleCliExecutor {
  run(args: string[]): Promise<TailscaleCliExecutorResult>
}
```

The executor is the only I/O boundary. All service functions accept an executor as
a parameter. This makes them trivially testable with a fake.

### `createRealExecutor(): TailscaleCliExecutor`

Returns an executor that resolves the `tailscale` binary and calls it via
`Bun.spawn`. Resolution order:

1. `tailscale` (if found in PATH via `which` / `where tailscale`)
2. `C:\Program Files\Tailscale\tailscale.exe` (Windows fallback)
3. `/Applications/Tailscale.app/Contents/MacOS/Tailscale` (macOS app bundle fallback)
4. Throw `TailscaleNotInstalledError` if none found

Stdout and stderr are captured as strings. The executor must never swallow errors
that indicate the binary is not available — those should surface as
`{ exitCode: 1, stdout: "", stderr: "<message>" }` so callers can detect
`installed: false`.

### Exported functions

```typescript
export async function getMachineStatus(
  executor: TailscaleCliExecutor,
): Promise<TailscaleMachineStatus>
```

Runs `tailscale status --json`. Parses the JSON output:

- If exit code is non-zero or output is not JSON → `installed: true, backendState: "unknown"`
- If the binary is not found → `installed: false` with all other fields null
- `version` — parsed from `tailscale version` (separate call; only on success)
- `backendState` — from `BackendState` field; normalized to the union type
- `tailnetName` — from `CurrentTailnet.MagicDNSSuffix`
- `ipv4` — first entry in `TailscaleIPs` that matches `/^100\./`
- `selfHostname` — from `Self.HostName`
- `selfDnsName` — from `Self.DNSName` (may have trailing dot; strip it)
- `loginRequired` — true if `BackendState === "NeedsLogin"`

```typescript
export async function getServeStatus(
  executor: TailscaleCliExecutor,
): Promise<TailscaleServeEntry[]>
```

Runs `tailscale serve status --json`. Parses the output:

Expected shape:
```json
{
  "TCP": {},
  "Web": {
    "hostname.tailnet.ts.net:443": {
      "Handlers": {
        "/": { "Proxy": "http://127.0.0.1:17106" }
      }
    }
  },
  "AllowFunnel": {}
}
```

Returns a flat array of `TailscaleServeEntry`. For each key in `Web`:
- Parse hostname and port from the key (e.g. `"tiny-tower.bangus-city.ts.net:443"`)
- For each handler path, extract `Proxy` as `targetUrl`
- Emit one `TailscaleServeEntry` per handler path entry

If `tailscale serve status --json` fails (command not found, daemon stopped, etc.),
return an empty array rather than throwing — the caller treats this as "serve
status unknown."

```typescript
export function checkServiceServe(
  service: Pick<ServiceConfig,
    "id" | "tailnetHostname" | "tailnetDomain" | "tailscaleServeEnabled" |
    "tailscaleServeMode" | "tailscaleServeTarget">,
  entries: TailscaleServeEntry[],
): TailscaleServeCheckResult
```

Pure function — no I/O. Compares configured service fields against live serve
entries.

- If service has no `tailnetHostname` → status `"unconfigured"`, all nullable fields null
- Build `expectedUrl = "https://<tailnetHostname>.<tailnetDomain>"` if both set
- Build `expectedTarget = service.tailscaleServeTarget`
- Find matching entry: `entry.hostname === "<tailnetHostname>.<tailnetDomain>"` and
  `entry.path === "/"`
- If found and `entry.targetUrl === expectedTarget` → status `"active"`
- If found but target differs → status `"mismatch"`, set `mismatchReason`
- If not found and `service.tailscaleServeEnabled === true` → status `"inactive"` (should be active but isn't)
- If not found and `service.tailscaleServeEnabled !== true` → status `"inactive"` (correctly off)

```typescript
export async function enableServe(
  service: Pick<ServiceConfig,
    "id" | "tailnetHostname" | "tailnetDomain" | "tailscaleServeTarget">,
  executor: TailscaleCliExecutor,
): Promise<void>
```

Validates that `tailnetHostname`, `tailnetDomain`, and `tailscaleServeTarget` are
all set. Then runs:

```
tailscale serve https / <tailscaleServeTarget>
```

Throws `TailscaleCommandError` if exit code is non-zero, with the stderr message
included.

```typescript
export async function disableServe(
  service: Pick<ServiceConfig, "id" | "tailnetHostname" | "tailnetDomain">,
  executor: TailscaleCliExecutor,
): Promise<void>
```

Validates that `tailnetHostname` is set. Then runs:

```
tailscale serve https off
```

Throws `TailscaleCommandError` if exit code is non-zero.

### Error types

```typescript
export class TailscaleNotInstalledError extends Error {}
export class TailscaleCommandError extends Error {
  constructor(
    public readonly args: string[],
    public readonly stderr: string,
    public readonly exitCode: number,
  ) { ... }
}
export class TailscaleConfigError extends Error {}
```

---

## Backend: `src/routes/tailscale.ts`

Three routes, all auth-guarded. Uses a module-level `executor` created from
`createRealExecutor()` so it can be replaced in tests via `vi.mock`.

Register via `app.use(tailscaleRoute)` in `src/index.ts`.

### `GET /v1/tailscale/status`

Returns machine status and per-service serve check results for all configured
services that have `tailnetHostname` set.

**Response 200:**
```json
{
  "machine": {
    "installed": true,
    "version": "1.62.1",
    "backendState": "Running",
    "tailnetName": "bangus-city.ts.net",
    "ipv4": "100.101.102.103",
    "selfHostname": "tiny-tower",
    "selfDnsName": "tiny-tower.bangus-city.ts.net",
    "loginRequired": false
  },
  "services": [
    {
      "serviceId": "sourcemanager-api",
      "status": "active",
      "expectedUrl": "https://sourcemanager.bangus-city.ts.net",
      "actualEntry": {
        "hostname": "tiny-tower.bangus-city.ts.net",
        "port": 443,
        "path": "/",
        "targetUrl": "http://localhost:17106"
      },
      "mismatchReason": null
    },
    {
      "serviceId": "devplanner-api",
      "status": "inactive",
      "expectedUrl": "https://devplanner.bangus-city.ts.net",
      "actualEntry": null,
      "mismatchReason": null
    }
  ]
}
```

If Tailscale is not installed, returns 200 with `machine.installed: false` and an
empty `services` array. Never returns 4xx for a not-installed Tailscale — that is
informational, not an error.

### `POST /v1/tailscale/services/:serviceId/serve/enable`

Enables `tailscale serve https / <target>` for the given service.

**Preconditions checked before running the command:**
1. Service exists in config (else 404)
2. Service has `tailnetHostname`, `tailnetDomain`, and `tailscaleServeTarget` set (else 422)
3. Tailscale is installed and daemon is running (else 503)

**Response 200:**
```json
{
  "success": true,
  "serviceId": "sourcemanager-api",
  "action": "enable",
  "message": "tailscale serve enabled for sourcemanager-api"
}
```

**Response 404:** service not found  
**Response 422:** service not configured for Tailscale (missing fields)  
**Response 503:** Tailscale not running or not installed  
**Response 500:** command failed (includes stderr in `message`)

### `POST /v1/tailscale/services/:serviceId/serve/disable`

Disables `tailscale serve https off` for the given service.

**Preconditions:**
1. Service exists in config (else 404)
2. Service has `tailnetHostname` set (else 422)
3. Tailscale is installed (else 503)

**Response 200:**
```json
{
  "success": true,
  "serviceId": "devplanner-api",
  "action": "disable",
  "message": "tailscale serve disabled for devplanner-api"
}
```

Same error responses as enable.

---

## Frontend: `frontend/src/api/client.ts` additions

```typescript
export function getTailscaleStatus(): Promise<TailscaleStatusResponse> {
  return apiFetch<TailscaleStatusResponse>("/v1/tailscale/status")
}

export function enableTailscaleServe(
  serviceId: string,
): Promise<TailscaleServeActionResponse> {
  return apiFetch<TailscaleServeActionResponse>(
    `/v1/tailscale/services/${serviceId}/serve/enable`,
    { method: "POST" },
  )
}

export function disableTailscaleServe(
  serviceId: string,
): Promise<TailscaleServeActionResponse> {
  return apiFetch<TailscaleServeActionResponse>(
    `/v1/tailscale/services/${serviceId}/serve/disable`,
    { method: "POST" },
  )
}
```

---

## Frontend: `TailscaleStatus` component

`frontend/src/components/TailscaleStatus.tsx`

### Props

```typescript
interface TailscaleStatusProps {
  status: TailscaleStatusResponse | null
  loading: boolean
  error: string | null
}
```

### Rendering

A small indicator displayed in the App header (right side). Three visual states:

| Condition | Indicator |
|---|---|
| `loading === true` | Dim dot, "Tailscale …" |
| `error !== null` | Orange dot, "Tailscale error" |
| `!status || !status.machine.installed` | Grey dot, "Tailscale not found" |
| `status.machine.backendState === "NeedsLogin"` | Yellow dot, "Tailscale: login required" |
| `status.machine.backendState === "Running"` | Green dot, IP address or tailnet name |
| otherwise | Red dot, "Tailscale offline" |

Clicking the indicator shows a small tooltip/popover with:
- Version string
- `selfDnsName` (machine's Tailnet DNS name)
- IPv4 address
- Tailnet name

This component does **not** show per-service status — that belongs in `TailscalePanel`.

---

## Frontend: `TailscalePanel` component

`frontend/src/components/TailscalePanel.tsx`

### Props

```typescript
interface TailscalePanelProps {
  serviceId: string
  tailnet: TailnetInfo | null                      // from ServiceSummary (config view)
  serveStatus: TailscaleServeCheckResult | null    // from /v1/tailscale/status
  machineConnected: boolean                        // machine.backendState === "Running"
  onEnable: (serviceId: string) => Promise<void>
  onDisable: (serviceId: string) => Promise<void>
}
```

### Rendering phases

If `tailnet === null` (service not configured for Tailscale), render nothing —
the panel is invisible.

If `tailnet !== null`, render a compact panel below the ServiceCard controls:

```
┌─────────────────────────────────────────────────┐
│  🔗 sourcemanager.bangus-city.ts.net             │
│  [active ●]   http://localhost:17106   [Disable] │
│                                                  │
│  or [inactive ○]                       [Enable]  │
│                                                  │
│  or [mismatch ⚠] actual: http://...:3000 [Fix?] │
└─────────────────────────────────────────────────┘
```

**Status badge colors:**

| `serveStatus.status` | Badge label | Color |
|---|---|---|
| `"active"` | Active | Green |
| `"inactive"` | Inactive | Grey |
| `"mismatch"` | Mismatch | Yellow |
| `"error"` | Error | Red |
| `null` (loading) | — | — |

**Toggle button:**

- If status is `"active"` or `"mismatch"` → show **Disable** button
- If status is `"inactive"` or `"error"` → show **Enable** button
- Button is disabled if `machineConnected === false`
- Button shows loading spinner during action
- On error, show error message below the panel

**Expected URL link:**

If `tailnet.hostname` and `tailnet.domain` are set, show
`https://<hostname>.<domain>` as a clickable external link (opens in new tab).

---

## Wire-up changes

### `App.tsx`

1. Add `tailscaleStatus: TailscaleStatusResponse | null` state, fetched on mount
   via `getTailscaleStatus()` and refreshed every 30 seconds (slower poll than
   repo list, since Tailscale state changes infrequently).
2. Add `tailscaleLoading: boolean` and `tailscaleError: string | null` state.
3. Render `<TailscaleStatus status={tailscaleStatus} loading={tailscaleLoading} error={tailscaleError} />`
   in the header (right side, after the existing settings gear).
4. Pass `tailscaleStatus` down to `RepoList` (or compute a `serveStatusMap:
   Map<serviceId, TailscaleServeCheckResult>` and pass that).
5. After enable/disable actions, call `getTailscaleStatus()` to refresh.

### `ServiceCard.tsx`

1. Add `serveStatus: TailscaleServeCheckResult | null` prop.
2. Add `onEnableTailscale: (serviceId: string) => Promise<void>` prop.
3. Add `onDisableTailscale: (serviceId: string) => Promise<void>` prop.
4. Render `<TailscalePanel ... />` below the controls section if `service.tailnet !== null`.
5. The existing `tailnetUrl` anchor link (already present) becomes the header
   link inside `TailscalePanel` — remove the top-level anchor from `ServiceCard`
   and let `TailscalePanel` own all Tailscale display.

### `RepoList.tsx`

Pass `serveStatus`, `onEnableTailscale`, and `onDisableTailscale` props down from
App to each `ServiceCard` via `RepoList`.

---

## Implementation sequence (strict TDD)

### Step 1 — Backend types (`src/types.ts`)

Add `TailscaleBackendState`, `TailscaleMachineStatus`, `TailscaleServeEntry`,
`TailscaleServeCheckStatus`, `TailscaleServeCheckResult`, and
`TailscaleStatusResponse`.

No tests needed for type-only additions. Run `bun test` to confirm no regressions.

---

### Step 2 — `src/services/tailscale.ts` — executor and machine status

**Write failing tests** (`tests/vitest/services/tailscale.test.ts`):

```typescript
describe("getMachineStatus", () => {
  test("returns installed:false when binary not found")
  test("returns Running state when backendState is Running")
  test("returns NeedsLogin state when backendState is NeedsLogin")
  test("parses tailnetName from MagicDNSSuffix")
  test("parses ipv4 from TailscaleIPs (first 100.x.x.x address)")
  test("parses selfHostname and strips trailing dot from selfDnsName")
  test("returns unknown backendState for unrecognized values")
  test("returns installed:true with unknown state if JSON parse fails")
})
```

Each test constructs a `FakeTailscaleExecutor` returning canned stdout. Never
spawn a real process.

**Implement** `TailscaleCliExecutor`, `createRealExecutor()`, and
`getMachineStatus()`.

**Verify:** `bunx vitest run --project backend` green; `bun test` green.

---

### Step 3 — `src/services/tailscale.ts` — serve status and check

**Write failing tests:**

```typescript
describe("getServeStatus", () => {
  test("returns empty array when serve has no entries")
  test("parses Web handler into TailscaleServeEntry with correct hostname/port/path/target")
  test("handles multiple handlers on multiple hostnames")
  test("returns empty array when command fails")
})

describe("checkServiceServe", () => {
  test("returns unconfigured for service with no tailnetHostname")
  test("returns active when entry matches hostname and target")
  test("returns mismatch when target URL differs from configured")
  test("returns inactive when serveEnabled is true but no entry found")
  test("returns inactive when serveEnabled is false and no entry found")
})
```

**Implement** `getServeStatus()` and `checkServiceServe()`.

**Verify:** targeted tests green; `bun test` green.

---

### Step 4 — `src/services/tailscale.ts` — enable/disable commands

**Write failing tests:**

```typescript
describe("enableServe", () => {
  test("runs correct tailscale serve command with target URL")
  test("throws TailscaleConfigError if tailnetHostname is missing")
  test("throws TailscaleConfigError if tailscaleServeTarget is missing")
  test("throws TailscaleCommandError if exit code is non-zero")
})

describe("disableServe", () => {
  test("runs tailscale serve https off command")
  test("throws TailscaleConfigError if tailnetHostname is missing")
  test("throws TailscaleCommandError if exit code is non-zero")
})
```

Tests use a `FakeTailscaleExecutor` that captures the `args` array and returns a
configurable result. Assert on the exact args array passed.

**Implement** `enableServe()` and `disableServe()`.

**Verify:** targeted tests green; full Vitest suite green; `bun test` green.

---

### Step 5 — `src/routes/tailscale.ts` + register in `src/index.ts`

**Write failing tests** (`tests/vitest/routes/tailscale.test.ts`):

```typescript
describe("GET /v1/tailscale/status", () => {
  test("returns 401 without token")
  test("returns machine status with installed:false when CLI not found")
  test("returns machine status with Running state when Tailscale is active")
  test("returns services array with unconfigured entries for services without tailnetHostname")
  test("returns active status for service with matching serve entry")
  test("returns inactive status for service whose serve entry is missing")
  test("returns mismatch status for service with wrong target in serve entry")
})

describe("POST /v1/tailscale/services/:serviceId/serve/enable", () => {
  test("returns 401 without token")
  test("returns 404 for unknown serviceId")
  test("returns 422 when service has no tailnetHostname")
  test("returns 422 when service has no tailscaleServeTarget")
  test("returns 503 when Tailscale daemon is not running")
  test("returns 200 on success")
  test("returns 500 when tailscale command exits non-zero")
})

describe("POST /v1/tailscale/services/:serviceId/serve/disable", () => {
  test("returns 401 without token")
  test("returns 404 for unknown serviceId")
  test("returns 422 when service has no tailnetHostname")
  test("returns 200 on success")
  test("returns 500 when tailscale command exits non-zero")
})
```

Mock the `tailscale` service module functions using `vi.mock`. Never run real CLI
commands in route tests.

**Implement** routes and register in `src/index.ts`.

**Verify:** targeted tests green; full Vitest suite green; `bun test` green.

---

### Step 6 — Frontend API client additions

**Write failing tests** (`frontend/src/__tests__/client.test.ts` — add to existing):

```typescript
test("getTailscaleStatus() calls GET /v1/tailscale/status with auth header")
test("enableTailscaleServe() calls POST .../serve/enable with auth header")
test("disableTailscaleServe() calls POST .../serve/disable with auth header")
```

**Implement** the three new functions in `frontend/src/api/client.ts`.  
Add the new types to `frontend/src/api/types.ts`.

**Verify:** `bunx vitest run --project frontend` green.

---

### Step 7 — `TailscaleStatus` component

**Write failing tests** (`frontend/src/__tests__/TailscaleStatus.test.tsx`):

```typescript
describe("TailscaleStatus", () => {
  test("shows loading state when loading prop is true")
  test("shows 'not found' state when status is null and not loading")
  test("shows green indicator when backendState is Running")
  test("shows yellow indicator when backendState is NeedsLogin")
  test("shows red indicator for Stopped state")
  test("shows tailnet name or IP when Running")
  test("shows error state when error prop is set")
})
```

**Implement** `TailscaleStatus.tsx` and `TailscaleStatus.module.css`.

**Verify:** `bunx vitest run --project frontend` green.

---

### Step 8 — `TailscalePanel` component

**Write failing tests** (`frontend/src/__tests__/TailscalePanel.test.tsx`):

```typescript
describe("TailscalePanel", () => {
  test("renders nothing when tailnet prop is null")
  test("shows expected Tailnet URL as an external link")
  test("shows 'Active' badge when serveStatus.status is 'active'")
  test("shows 'Inactive' badge when serveStatus.status is 'inactive'")
  test("shows 'Mismatch' badge with mismatchReason when status is 'mismatch'")
  test("shows 'Disable' button when status is active or mismatch")
  test("shows 'Enable' button when status is inactive or error")
  test("Enable button is disabled when machineConnected is false")
  test("shows loading state on button during enable action")
  test("calls onEnable with correct serviceId on Enable click")
  test("calls onDisable with correct serviceId on Disable click")
  test("shows error message when enable action fails")
  test("shows error message when disable action fails")
})
```

Use `vi.mock` for API client; use `vi.useFakeTimers()` is not needed here (no
debounce).

**Implement** `TailscalePanel.tsx` and `TailscalePanel.module.css`.

**Verify:** `bunx vitest run --project frontend` green.

---

### Step 9 — Wire into `App.tsx`, `RepoList.tsx`, and `ServiceCard.tsx`

1. Add `tailscaleStatus` state and 30s polling to `App.tsx`.
2. Render `<TailscaleStatus />` in header.
3. Build `serveStatusMap: Map<string, TailscaleServeCheckResult>` from `tailscaleStatus.services`.
4. Pass map + enable/disable callbacks through `RepoList` → `ServiceCard`.
5. In `ServiceCard`, remove the existing `tailnetUrl` anchor and replace with `<TailscalePanel>`.
6. Update `RepoList` and `ServiceCard` props interfaces accordingly.

**Update existing tests:**

- `frontend/src/__tests__/ServiceCard.test.tsx` — add `serveStatus` prop, update
  snapshot/text assertions that reference the old tailnet anchor; add tests for the
  TailscalePanel render path.
- `frontend/src/__tests__/RepoList.test.tsx` — pass the new props in setup; no
  new behavior tests needed unless existing ones break.

**Verify:** `bunx vitest run --project frontend` green; `bun test` green.

---

### Step 10 — Example JSON and README updates

Update `data/projects.example.json` and `data/projects.localdev.example.json` to
include Tailscale fields (see **Example JSON Updates** section below).

Update `docs/SPECIFICATION.md` — add Tailscale endpoints and field tables.
Update `docs/openapi.yaml` — add `GET /v1/tailscale/status`, enable, and disable
endpoint specs.
Update `README.md` — add "Tailscale Setup" section (see **README additions** below).

---

## Example JSON Updates

### `data/projects.example.json` — add Tailscale fields

Add Tailscale fields to the first service to show a configured example, and leave
the second service without them to show that Tailscale is optional:

```json
{
  "id": "my-web-app-api",
  "displayName": "API",
  "packageManager": "bun",
  "scriptName": "api",
  "port": 8080,
  "healthUrl": "http://localhost:8080/health",
  "healthMode": "full",
  "tags": ["api"],
  "allowedIps": ["192.168.1.0/24"],
  "tailnetHostname": "my-app",
  "tailnetDomain": "your-tailnet.ts.net",
  "tailscaleServeEnabled": false,
  "tailscaleServeMode": "https",
  "tailscaleServeTarget": "http://localhost:8080"
}
```

### `data/projects.localdev.example.json` — add Tailscale fields to all services

Add Tailscale config to each service using the `bangus-city.ts.net` domain:

**sourcemanager-api:**
```json
"tailnetHostname": "sourcemanager",
"tailnetDomain": "bangus-city.ts.net",
"tailscaleServeEnabled": false,
"tailscaleServeMode": "https",
"tailscaleServeTarget": "http://localhost:17106"
```

**devplanner-api:**
```json
"tailnetHostname": "devplanner",
"tailnetDomain": "bangus-city.ts.net",
"tailscaleServeEnabled": false,
"tailscaleServeMode": "https",
"tailscaleServeTarget": "http://localhost:17103"
```

**lmapi-api:**
```json
"tailnetHostname": "lmapi",
"tailnetDomain": "bangus-city.ts.net",
"tailscaleServeEnabled": false,
"tailscaleServeMode": "https",
"tailscaleServeTarget": "http://localhost:17100"
```

**memoryapi:**
```json
"tailnetHostname": "memory",
"tailnetDomain": "bangus-city.ts.net",
"tailscaleServeEnabled": false,
"tailscaleServeMode": "https",
"tailscaleServeTarget": "http://localhost:17107"
```

**lmeval-api:**
```json
"tailnetHostname": "lmeval",
"tailnetDomain": "bangus-city.ts.net",
"tailscaleServeEnabled": false,
"tailscaleServeMode": "https",
"tailscaleServeTarget": "http://localhost:3200"
```

Frontend-only Vite services (`sourcemanager-web`, `devplanner-web`,
`lmeval-frontend`) do not get Tailscale config — they are internal dev helpers,
not services you would want to expose on Tailnet directly.

---

## README additions

Add a **Tailscale** section after the existing **Authentication** section:

```markdown
## Tailscale

SourceManager can expose any configured service over private Tailnet HTTPS using
[Tailscale Serve](https://tailscale.com/kb/1312/serve). When enabled, the service
becomes reachable at `https://<hostname>.<tailnetDomain>` from any machine on your
Tailnet.

### Prerequisites

- Tailscale must be installed and running on the same machine as SourceManager.
- The machine must be logged in: `tailscale login`
- **Tailscale 1.56 or later** is required for the `tailscale serve https / <url>` syntax.
  Check your version: `tailscale version`
- On Windows, `tailscale.exe` must be accessible from PATH, or present at
  `C:\Program Files\Tailscale\tailscale.exe`.
- SourceManager must be able to run `tailscale serve` commands. On Windows, this
  typically requires SourceManager to run as the same user who is logged into
  Tailscale (i.e., the Tailscale desktop app is running in your session).

### Configuring a service

Add Tailscale fields to any service entry in `data/projects.json`:

| Field | Required | Description |
|---|---|---|
| `tailnetHostname` | For Tailscale | Subdomain only (no dots). e.g. `sourcemanager` |
| `tailnetDomain` | For Tailscale | Your Tailnet domain. e.g. `your-tailnet.ts.net` |
| `tailscaleServeEnabled` | No | `true` to mark the service as intended for Tailscale |
| `tailscaleServeMode` | No | Must be `"https"` (the only supported mode) |
| `tailscaleServeTarget` | For Tailscale | Local URL to forward. e.g. `http://localhost:17106` |

The resulting Tailnet URL will be:
`https://<tailnetHostname>.<tailnetDomain>`

For example:
```json
{
  "tailnetHostname": "sourcemanager",
  "tailnetDomain": "your-tailnet.ts.net",
  "tailscaleServeEnabled": false,
  "tailscaleServeMode": "https",
  "tailscaleServeTarget": "http://localhost:17106"
}
```

### Dashboard indicator

The dashboard header shows a Tailscale machine status indicator:

- **Green** — Tailscale is running and connected to your Tailnet
- **Yellow** — Tailscale needs login (`tailscale login`)
- **Grey** — Tailscale is not installed or not found in PATH
- **Red** — Tailscale is installed but the daemon is stopped

Each service card shows a Tailscale panel (when configured) with:
- The expected Tailnet HTTPS URL
- Whether `tailscale serve` is currently active, inactive, or misconfigured
- **Enable** / **Disable** buttons to toggle exposure

### Enable serve for a service via API

```bash
curl -X POST http://localhost:17106/v1/tailscale/services/<serviceId>/serve/enable \
  -H "X-DevServer-Token: <your-token>"
```

### Security

`tailscale serve` exposes services to **all machines on your Tailnet** —
authenticate any web apps independently if they contain sensitive data.
SourceManager never enables public `tailscale funnel`; all exposure is Tailnet-only.
```

---

## Non-goals (explicitly out of scope for SO-6)

- Public `tailscale funnel` support
- Path-based routing (multiple services behind one hostname with different paths)
- Multiple serve modes beyond HTTPS
- Tailscale admin API integration (key management, device inventory, ACL editing)
- Per-service Tailscale login/logout
- MagicDNS or split-DNS setup automation
- Managing external dependency services (Qdrant, Neo4j, Ollama, Docker)

---

## Security constraints

| Constraint | Implementation |
|---|---|
| Allowlisted service IDs only | Enable/disable routes look up service by ID in config; no free-form hostnames or ports from the browser |
| No arbitrary shell exec | Commands are constructed as `string[]` args passed to `Bun.spawn`; no shell interpolation |
| No funnel | `tailscale funnel` is never called; route tests assert that no funnel command appears in any args |
| Auth required | All three endpoints require `X-DevServer-Token` (existing middleware) |
| Target URL from config, not request | `tailscaleServeTarget` comes from `projects.json`; the enable endpoint does not accept a target in the request body |
| Fake executor in tests | All automated tests use `FakeTailscaleExecutor`; no test may run a real `tailscale` process or modify real serve config |

---

## Acceptance criteria

- [ ] `GET /v1/tailscale/status` returns machine status and per-service check results; returns 401 without auth.
- [ ] Machine status correctly reflects installed/running/login-required/not-found states.
- [ ] Per-service check correctly returns active/inactive/mismatch/unconfigured for each service.
- [ ] `POST .../serve/enable` constructs and runs `tailscale serve https / <target>`; returns 404/422/503/500 for respective error conditions.
- [ ] `POST .../serve/disable` constructs and runs `tailscale serve https off`; same error handling.
- [ ] Neither enable nor disable ever constructs a command containing "funnel".
- [ ] `TailscaleStatus` header indicator correctly reflects machine state in all four visual states.
- [ ] `TailscalePanel` shows expected URL, serve status badge, and correct enable/disable button.
- [ ] Enable/disable buttons call the API and show loading/error states correctly.
- [ ] All Vitest tests pass (`bunx vitest run`); all Bun tests pass (`bun test`).
- [ ] No test invokes a real `tailscale` process or requires Tailnet connectivity.
- [ ] `projects.example.json` and `projects.localdev.example.json` are updated with Tailscale fields.
- [ ] README Tailscale section covers prerequisites, field reference, and dashboard indicator.
- [ ] `docs/SPECIFICATION.md` is updated with Tailscale endpoint and config field tables.

---

## Verification commands

```bash
# Backend Vitest tests (node environment)
bunx vitest run --project backend

# Frontend Vitest tests (jsdom environment)
bunx vitest run --project frontend

# Full Vitest suite
bunx vitest run

# Existing Bun tests (must remain green throughout)
bun test

# All suites
bun run test:all
```

---

## File map

**New files:**
- `src/services/tailscale.ts` — CLI executor interface + all service functions
- `src/routes/tailscale.ts` — three Elysia routes
- `frontend/src/components/TailscaleStatus.tsx` — header machine indicator
- `frontend/src/components/TailscaleStatus.module.css`
- `frontend/src/components/TailscalePanel.tsx` — per-service panel
- `frontend/src/components/TailscalePanel.module.css`
- `tests/vitest/services/tailscale.test.ts` — service unit tests
- `tests/vitest/routes/tailscale.test.ts` — route tests
- `frontend/src/__tests__/TailscaleStatus.test.tsx`
- `frontend/src/__tests__/TailscalePanel.test.tsx`

**Modified files:**
- `src/types.ts` — add Tailscale type definitions
- `src/index.ts` — register `tailscaleRoute`
- `frontend/src/api/client.ts` — add three new API functions
- `frontend/src/api/types.ts` — add Tailscale type definitions
- `frontend/src/components/ServiceCard.tsx` — add `TailscalePanel`, remove old tailnet anchor
- `frontend/src/components/RepoList.tsx` — pass Tailscale props through
- `frontend/src/App.tsx` — add `TailscaleStatus` header + 30s polling
- `frontend/src/__tests__/ServiceCard.test.tsx` — update for new props
- `frontend/src/__tests__/RepoList.test.tsx` — update for new props
- `frontend/src/__tests__/client.test.ts` — add three new function tests
- `data/projects.example.json` — add Tailscale fields
- `data/projects.localdev.example.json` — add Tailscale fields
- `docs/SPECIFICATION.md` — add Tailscale endpoints and config fields
- `docs/openapi.yaml` — add Tailscale routes
- `README.md` — add Tailscale setup section
