# SO-6C: Service Registration, Verification, and Dashboard UX

**DevPlanner card:** SO-6C (implementation phase)  
**Priority:** 6 (follows SO-4 config editor, which is complete)  
**Status:** Manual registration in progress — SourceManager automation not yet implemented  
**Depends on:** [SO-6C plan](./SO-6C-tailscale-services-named-services.md), [TailscalePolicyConfiguration.json](../TailscalePolicyConfiguration.json) applied to tailnet  

---

## Summary

The tailnet policy is in place. The next work is **manual registration and verification** of each Tailscale Service in the admin console, followed by **SourceManager automation** that advertises Service hosts via `tailscale serve` and a **dashboard UX** that shows Tailnet availability per service with an enable action.

This document covers:

1. What to do now (register and verify each `svc:*` resource in Tailscale).
2. What SourceManager will automate later (CLI integration on startup and service start).
3. Dashboard UX requirements for Tailnet status and the enable button.

---

## Current state

| Layer | Status |
|---|---|
| Tailnet policy (`tagOwners`, `grants`, `autoApprovers.services`) | Applied |
| Services defined in Tailscale admin console | **Manual — do next** |
| Dev machine authenticated with `tag:dev-service-host` | **Manual — do next** |
| Service hosts advertised via `tailscale serve` | **Manual for now** |
| SourceManager Tailscale CLI integration | Not implemented |
| Dashboard Tailnet status indicator + enable button | Not implemented (placeholder URL link only) |

---

## Phase 1: Register each Service in Tailscale (manual)

Policy alone does not create Services. Each logical resource must be **defined** in the admin console before a host can advertise it.

### Prerequisites

- Tailscale client **v1.86.0+** on the dev machine (v1.94+ recommended on client devices).
- [TailscalePolicyConfiguration.json](../TailscalePolicyConfiguration.json) saved to the tailnet.
- Owner, Admin, or Network admin access to the admin console.

### Step 1: Authenticate the dev machine with a service-host tag

The Windows dev machine that runs SourceManager **cannot** use user-based Tailscale login as a Service host.

1. Admin console → **Settings → Keys** → **Generate auth key**.
2. Enable **Reusable** (optional) and **Ephemeral** (optional per your ops preference).
3. Under **Tags**, add `tag:dev-service-host`.
4. On the dev machine, re-authenticate Tailscale with that key:

```powershell
tailscale up --auth-key=tskey-auth-... --advertise-tags=tag:dev-service-host
```

5. Confirm the machine appears in the admin console with `tag:dev-service-host` (and optionally `tag:server` if you keep that tag for SSH/ACL rules).

Verify tag-based identity:

```powershell
tailscale status --json | jq '.Self.Tags'
```

Expected output includes `"tag:dev-service-host"`.

### Step 2: Define each Service in the admin console

For **each** row in the service map below:

1. Admin console → **Services** → **Advertise** → **Define a Service**.
2. **Name:** the service name **without** the `svc:` prefix (e.g. `devplanner-api`).
3. **Description:** optional human label (e.g. `DevPlanner API — local dev`).
4. **Endpoints:** `tcp:443` (HTTPS Serve terminates TLS on 443).
5. Select **Add service**.

Repeat for all eight Services:

| SourceManager service ID | Admin console name | Tailscale Service | Expected MagicDNS URL |
|---|---|---|---|
| `sourcemanager-web` | `sourcemanager` | `svc:sourcemanager` | `https://sourcemanager.<tailnet>.ts.net` |
| `sourcemanager-api` | `sourcemanager-api` | `svc:sourcemanager-api` | `https://sourcemanager-api.<tailnet>.ts.net` |
| `devplanner-web` | `devplanner` | `svc:devplanner` | `https://devplanner.<tailnet>.ts.net` |
| `devplanner-api` | `devplanner-api` | `svc:devplanner-api` | `https://devplanner-api.<tailnet>.ts.net` |
| `lmapi-api` | `lmapi` | `svc:lmapi` | `https://lmapi.<tailnet>.ts.net` |
| `memoryapi` | `memory` | `svc:memory` | `https://memory.<tailnet>.ts.net` |
| `lmeval-frontend` | `lmeval` | `svc:lmeval` | `https://lmeval.<tailnet>.ts.net` |
| `lmeval-api` | `lmeval-api` | `svc:lmeval-api` | `https://lmeval-api.<tailnet>.ts.net` |

Admin console name must match the `svc:` suffix exactly. SourceManager config will store the same name in `tailscaleServiceName` (without `svc:`).

### Step 3: Advertise a Service host manually (first verification)

Start the local dev process first (SourceManager dashboard or terminal), then advertise:

```powershell
# Example: DevPlanner API listening on 17103
tailscale serve --service=svc:devplanner-api --https=443 http://127.0.0.1:17103
```

Tailscale runs Serve in background mode automatically when using `--service`. Expected CLI output mentions pending approval or immediate availability depending on auto-approvers.

Check local configuration:

```powershell
tailscale serve status --json
tailscale serve get-config --all
tailscale status --json | jq '.Self.CapMap."service-host"'
```

If auto-approvers are working, the host should move to **Connected** in Admin console → **Services** → `<service name>` → **Service hosts** without manual approval. If not, approve the pending host once.

---

## Phase 2: Verify each Service (manual checklist)

Complete this checklist **once per Service** before relying on SourceManager automation. Use a **second device** on the tailnet (tagged `tag:client` or admin) — not the hosting machine (hairpinning limitation).

### Per-service verification

| # | Check | Pass criteria |
|---|---|---|
| 1 | Local process running | Health URL responds on `127.0.0.1:<port>` |
| 2 | Serve config present | `tailscale serve get-config --all` maps `svc:<name>` → correct local target |
| 3 | Host approved | Admin console shows host **Connected** (not Pending / Needs configuration) |
| 4 | MagicDNS resolves | `https://<name>.<tailnet>.ts.net` resolves from a client device |
| 5 | HTTPS reachable | Client GET returns expected response (200/302 acceptable for web; `/health` for APIs) |
| 6 | Grant access | Client device with `tag:client` (or admin) can connect; untagged/unauthorized device cannot |

### Suggested verification order

Start with two Services to validate the full pipeline before registering the rest:

1. **`svc:devplanner-api`** — simple API health endpoint.
2. **`svc:devplanner`** — Vite frontend; confirms static/HMR proxy behavior.

Then register and verify the remaining six Services using the same checklist.

### Rollback / cleanup during verification

```powershell
# Stop accepting new connections, then remove endpoint
tailscale serve drain svc:devplanner-api
tailscale serve --service=svc:devplanner-api --https=443 off
```

Do **not** use `tailscale serve reset` — it clears all Service configurations on the host.

---

## Phase 3: SourceManager automation (planned)

After manual verification succeeds, implement backend integration described in [SO-6C](./SO-6C-tailscale-services-named-services.md). This section captures **when** and **how** SourceManager should invoke Tailscale, beyond the CLI details in that doc.

### Config model

Extend `ServiceConfig` per SO-6C:

```typescript
tailnetExposureMode?: "tailscale-service"
tailscaleServiceName?: string       // without svc: prefix
tailscaleServiceEnabled?: boolean   // opt-in per service
tailscaleServicePort?: number       // default 443
tailscaleServiceTarget?: string     // e.g. http://127.0.0.1:17103
```

Migrate `data/projects.localdev.example.json` entries from legacy `tailnetHostname` / `tailscaleServe*` fields to this model as implementation proceeds.

### When SourceManager runs Tailscale commands

| Trigger | Behavior |
|---|---|
| **SourceManager backend fully started** | Probe Tailscale daemon (`tailscale status --json`). Cache host-level status (connected, tagged, service-host capable). Do **not** block API startup if Tailscale is unavailable — degrade gracefully. |
| **User starts a service** (`POST .../start`) | After local process reaches `running` (health check pass): if `tailscaleServiceEnabled` and Tailnet fields are set, check whether the Service host is already advertised and healthy. If not, run enable command. |
| **User clicks Enable Tailnet in dashboard** | Explicit `POST /v1/tailscale/services/:serviceId/service/enable` regardless of whether the local process is running (enable may fail with a clear error if local target is down). |
| **User stops a service** | Do **not** automatically disable Tailscale Serve by default (Tailnet URL may still be useful for status pages or other local targets). Optional future setting: `tailscaleServiceDisableOnStop`. |
| **SourceManager shutdown** | Do **not** drain or disable Service hosts automatically. |

### Tailnet availability check (before enable)

When deciding whether to run `tailscale serve ...`, SourceManager should treat a Service as **already available** only when **all** of the following hold:

1. Tailscale daemon is running and logged in.
2. `tailscale serve get-config --all` contains an endpoint for `svc:<tailscaleServiceName>` on the configured HTTPS port.
3. Mapped local target matches `tailscaleServiceTarget` (normalize `localhost` ↔ `127.0.0.1`).
4. Host approval state is **Connected** (not Pending, Offline, or Needs configuration) when detectable from `tailscale status --json` / admin API.

If (2) or (3) fails → run enable command.  
If (4) is Pending → surface **pending approval** in UI; do not retry enable in a tight loop.

### Enable command (reference)

```text
tailscale serve --service=svc:<name> --https=443 <tailscaleServiceTarget>
```

SourceManager must never invoke `tailscale funnel` or `tailscale serve reset`.

---

## Phase 4: Dashboard UX (planned)

Extends the existing `ServiceCard` Tailnet URL link with live status and an enable action. Aligns with SO-3 polling (10 s refresh).

### Host-level indicator (optional header strip)

Show once at the top of the dashboard or in Settings:

| State | Label | Detail |
|---|---|---|
| `connected` | Tailscale connected | Machine tagged; CLI reachable |
| `degraded` | Tailscale degraded | Connected but missing `tag:dev-service-host` |
| `unavailable` | Tailscale unavailable | CLI missing, not logged in, or command failed |
| `unknown` | Tailscale unknown | Status not yet fetched |

This is **host-level**, not per-service. Per-service controls remain on each card.

### Per-service Tailnet panel (on `ServiceCard`)

Replace the read-only URL link with a **Tailnet panel** when `tailscaleServiceName` (or legacy `tailnetHostname`) is configured:

```
┌─────────────────────────────────────────────────────────────┐
│ DevPlanner API                                    :17103    │
│ ● running                                                   │
├─────────────────────────────────────────────────────────────┤
│  [Stop]  [Restart]  [Update]                                │
├─────────────────────────────────────────────────────────────┤
│  Tailnet                                                    │
│  ● Available   https://devplanner-api.bangus-city.ts.net ↗  │
│  svc:devplanner-api → http://127.0.0.1:17103                │
│  [Enable Tailnet]  (disabled — already available)           │
└─────────────────────────────────────────────────────────────┘
```

#### Tailnet status indicator

Visual badge next to the expected URL (`LifecycleBadge`-style chip):

| Status | Badge label | Color intent | Meaning |
|---|---|---|---|
| `not_configured` | No Tailnet config | neutral | Service has no Tailscale Service fields in config |
| `unavailable` | Tailscale down | muted/warn | Host-level Tailscale unavailable |
| `local_stopped` | Service stopped | muted | Local process not running; Tailnet may 502 |
| `not_advertised` | Not on Tailnet | warn | Local process running; Serve not configured |
| `pending_approval` | Pending approval | warn | Advertised; admin approval required |
| `connected` | Available | success | Serve configured, approved, target matches |
| `mismatch` | Config mismatch | error | Serve exists but target/port differs from config |
| `error` | Tailnet error | error | Last CLI action failed; show message |

**Available** (`connected`) means the tailnet hostname should work from other devices — not that the local dev server is running (combine with lifecycle badge for full picture).

#### Enable Tailnet button

| Property | Value |
|---|---|
| Label | **Enable Tailnet** |
| Icon | `Wifi` (consistent with existing link) |
| Action | `POST /v1/tailscale/services/:serviceId/service/enable` |
| Enabled when | Status is `not_advertised`, `mismatch`, or `error`; Tailscale host-level is not `unavailable`; no action in flight |
| Disabled when | Status is `connected` (already available via tailnet address), `pending_approval`, `not_configured`, or `unavailable` |
| Loading | While POST in progress; lock button like other card actions |
| Tooltip when disabled | e.g. "Already available on Tailnet", "Tailscale not connected on host", "Awaiting admin approval" |

Do **not** show a Disable button in the first implementation unless explicitly requested — SO-6C lists drain/disable as follow-up actions.

#### Tailnet URL link

- Keep the clickable `https://<name>.<domain>` link when configured.
- Open in new tab (`rel="noreferrer"`).
- Link remains visible in all states except `not_configured`; optionally dim when `not_advertised`.

#### Auto-enable on service start (UX feedback)

When the user clicks **Start service** and backend auto-enables Tailnet:

1. Card shows lifecycle **starting** → **running** as today.
2. Tailnet badge transitions **not_advertised** → loading → **connected** (or **error** / **pending_approval**).
3. No separate user click required if `tailscaleServiceEnabled: true` in config.

If auto-enable fails, show a non-blocking warning on the card: *"Service started but Tailnet enable failed: …"* with **Enable Tailnet** still available.

### API data shape (frontend)

Extend `ServiceSummary` (or nested `tailnet` object):

```typescript
interface TailnetStatus {
  configured: boolean
  serviceName: string | null        // svc: prefix for display
  expectedUrl: string | null        // https://name.domain
  localTarget: string | null
  httpsPort: number | null
  status:
    | "not_configured"
    | "unavailable"
    | "local_stopped"
    | "not_advertised"
    | "pending_approval"
    | "connected"
    | "mismatch"
    | "error"
  lastError: string | null
  canEnable: boolean
}
```

Populate via `GET /v1/repos` (embedded per service) or `GET /v1/tailscale/status` (host + per-service map). Prefer a single poll source to avoid drift.

### Polling

- Reuse RepoList **10 s** interval for Tailnet status.
- After **Enable Tailnet** or **Start service**, immediate refetch (same as start/stop today).

### Settings UI

The existing Tailscale accordion in Settings should migrate to SO-6C fields:

- **Tailscale Service Name** (`tailscaleServiceName`)
- **Local Target** (`tailscaleServiceTarget`)
- **HTTPS Port** (default 443)
- **Auto-enable on start** (`tailscaleServiceEnabled` checkbox)

Validation rules from SO-6C apply (lowercase service names, no `svc:` in config value).

---

## Implementation order

```
1. [NOW]     Register all svc:* Services in admin console
2. [NOW]     Re-auth dev machine with tag:dev-service-host
3. [NOW]     Manual serve + verify devplanner-api, devplanner, then remaining services
4. [NEXT]    Backend: tailscale.ts CLI adapter + status parsing
5. [NEXT]    Backend: /v1/tailscale/* routes
6. [NEXT]    Backend: auto-enable hook on POST .../start
7. [NEXT]    Frontend: Tailnet panel + indicator + Enable button on ServiceCard
8. [NEXT]    Config schema migration + Settings field updates
9. [LATER]   Drain / Disable actions, host-level dashboard strip
```

---

## Acceptance criteria

**Manual phase (before SourceManager code):**

- All eight Services defined in admin console with `tcp:443`.
- Dev machine authenticated with `tag:dev-service-host`.
- At least two Services verified end-to-end from a client device over HTTPS.

**Automation phase:**

- Starting a service with `tailscaleServiceEnabled: true` advertises Tailnet when not already available.
- Dashboard badge shows **Available** when Serve is connected; **Enable Tailnet** is disabled in that state.
- Dashboard badge shows **Not on Tailnet** when local process is running but Serve is missing; **Enable Tailnet** is enabled.
- Tailscale daemon failure does not crash SourceManager; UI shows **Tailscale unavailable**.

---

## References

- [SO-6C: Tailscale Services with Named Tailnet Hostnames](./SO-6C-tailscale-services-named-services.md)
- [TailscalePolicyConfiguration.json](../TailscalePolicyConfiguration.json)
- [Tailscale Services docs](https://tailscale.com/docs/features/tailscale-services)
- [tailscale serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)
