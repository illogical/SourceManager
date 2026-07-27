# SO-6C: Service Registration, Verification, and Dashboard UX

**DevPlanner card:** SO-6C (implementation phase)  
**Priority:** 6 (follows SO-4 config editor, which is complete)  
**Status:** Implemented in repository — deployment and Tailnet action verification pending
**Depends on:** [SO-6C plan](./SO-6C-tailscale-services-named-services.md), [TailscalePolicyConfiguration.json](../TailscalePolicyConfiguration.json) applied to tailnet  

---

## Summary

The tailnet policy is in place and `svc:sourcemanager` is reachable at `https://sourcemanager.bangus-city.ts.net`. SourceManager now includes automation that advertises named Service hosts via `tailscale serve` and dashboard UX that shows Tailnet availability per service with an on/off toggle. The remaining work is deployment verification and manual registration of the other named Services.

This document covers:

1. What to do now (register and verify each `svc:*` resource in Tailscale).
2. What SourceManager automates (CLI integration with service lifecycle).
3. Dashboard UX requirements for Tailnet status and the on/off toggle.

---

## Current state

| Layer | Status |
|---|---|
| Tailnet policy (`tagOwners`, `grants`, `autoApprovers.services`) | Applied |
| `svc:sourcemanager` defined and reachable | **Verified manually at `https://sourcemanager.bangus-city.ts.net`** |
| Remaining Services defined in Tailscale admin console | Manual verification still required |
| Dev machine authenticated with `tag:dev-service-host` | Verified indirectly by successful SourceManager advertisement; confirm tags during final verification |
| SourceManager Tailscale CLI integration | Implemented; uses a shell-free executor |
| Dashboard Tailnet status indicator + toggle | Implemented; deployment verification pending |

---

## Phase 1: Register each Service in Tailscale (manual)

Policy alone does not create Services. Each logical resource must be **defined** in the admin console before a host can advertise it.

### Prerequisites

- Tailscale client **v1.86.0+** on the dev machine. The intended Windows dev machine is reported to be running **v1.98.9**, which satisfies this prerequisite.
- Tailscale v1.94+ is recommended on client devices so Tailscale Services do not require `accept-routes`.
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
$status = tailscale status --json | ConvertFrom-Json
$status.Self.Tags
```

Expected output includes `"tag:dev-service-host"`.

### Step 2: Define each Service in the admin console

For **each** row in the service map below:

1. Admin console → **Services** → **Advertise** → **Define a Service**.
2. **Name:** the service name **without** the `svc:` prefix (e.g. `devplanner-api`).
3. **Description:** optional human label (e.g. `DevPlanner API — local dev`).
4. **Endpoints:** `tcp:443` (HTTPS Serve terminates TLS on 443).
5. Select **Add service**.

Repeat for all seven Services:

| SourceManager service ID | Admin console name | Tailscale Service | Expected MagicDNS URL |
|---|---|---|---|
| `sourcemanager-api` | `sourcemanager` | `svc:sourcemanager` | `https://sourcemanager.<tailnet>.ts.net` |
| `devplanner-web` | `devplanner` | `svc:devplanner` | `https://devplanner.<tailnet>.ts.net` |
| `devplanner-api` | `devplanner-api` | `svc:devplanner-api` | `https://devplanner-api.<tailnet>.ts.net` |
| `lmapi-api` | `lmapi` | `svc:lmapi` | `https://lmapi.<tailnet>.ts.net` |
| `memoryapi` | `memory` | `svc:memory` | `https://memory.<tailnet>.ts.net` |
| `lmeval-frontend` | `lmeval` | `svc:lmeval` | `https://lmeval.<tailnet>.ts.net` |
| `lmeval-api` | `lmeval-api` | `svc:lmeval-api` | `https://lmeval-api.<tailnet>.ts.net` |

Admin console name must match the `svc:` suffix exactly. SourceManager config will store the same name in `tailscaleServiceName` (without `svc:`).

### Step 3: Advertise SourceManager manually (first verification)

Confirm the combined SourceManager web and API process is responding on loopback before changing Tailscale configuration:

```powershell
Invoke-WebRequest http://127.0.0.1:17106/ -UseBasicParsing
```

Then configure and advertise the named SourceManager Service:

```powershell
tailscale serve --service=svc:sourcemanager --https=443 http://127.0.0.1:17106
```

Tailscale runs Serve in background mode automatically when using `--service`. Expected CLI output mentions pending approval or immediate availability depending on auto-approvers.

Check local configuration:

```powershell
tailscale serve status --json
tailscale serve get-config --all

$status = tailscale status --json | ConvertFrom-Json
$status.Self.CapMap.'service-host'
```

The returned configuration should contain `svc:sourcemanager` with `tcp:443` mapped to `http://127.0.0.1:17106`. If auto-approvers are working, the host should move to **Connected** in Admin console → **Services** → **sourcemanager** → **Service hosts** without manual approval. If not, approve the pending host once.

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

Start with SourceManager itself, then validate separate API and web processes:

1. **`svc:sourcemanager`** — combined SourceManager dashboard and API on `127.0.0.1:17106`.
2. **`svc:devplanner-api`** — simple API health endpoint.
3. **`svc:devplanner`** — Vite frontend; confirms static/HMR proxy behavior.

Then register and verify the remaining Services using the same checklist.

### Rollback / cleanup during verification

```powershell
# Stop accepting new connections, then remove endpoint
tailscale serve drain svc:sourcemanager
tailscale serve --service=svc:sourcemanager --https=443 off
```

Do **not** use `tailscale serve reset` — it clears all Service configurations on the host.

---

## Phase 3: SourceManager automation (implemented)

After manual verification succeeds, implement backend integration described in [SO-6C](./SO-6C-tailscale-services-named-services.md). This section captures **when** and **how** SourceManager should invoke Tailscale, beyond the CLI details in that doc.

### Config model

Extend `ServiceConfig` per SO-6C:

```typescript
tailnetExposureMode?: "tailscale-service"
tailscaleServiceName?: string       // without svc: prefix
tailscaleServiceEnabled?: boolean   // persisted desired on/off state
tailscaleServicePort?: number       // default 443
tailscaleServiceTarget?: string     // e.g. http://127.0.0.1:17103
```

`data/projects.localdev.example.json` now uses this named-Service model. Runtime configurations that still use legacy `tailnetHostname` / `tailscaleServe*` fields remain readable during migration, but Settings saves should move them to the SO-6C fields.

### When SourceManager runs Tailscale commands

| Trigger | Behavior |
|---|---|
| **SourceManager backend fully started** | Probe Tailscale without blocking API startup. Reconcile configured services: drain advertised services whose local process is stopped, and restore desired Tailnet exposure only for services already healthy. |
| **User starts a service** (`POST .../start`) | After the local process reaches `running`: if `tailscaleServiceEnabled` is true, advertise an existing correct drained configuration or configure and advertise the endpoint. |
| **User turns Tailnet on** | Require the local service to be `running`, persist `tailscaleServiceEnabled: true`, then configure/advertise the endpoint. Preserve the desired state if the CLI action fails so the error can be retried and startup reconciliation can recover it. |
| **User turns Tailnet off** | Require the local service to be `running`, persist `tailscaleServiceEnabled: false`, drain the Service, then remove its configured HTTPS endpoint. Surface any cleanup failure instead of silently re-enabling later. |
| **User stops a service** | If advertised, run `tailscale serve drain svc:<name>` first. Once drain is acknowledged, immediately begin local process shutdown with no fixed delay. Keep the correct endpoint configuration drained and retain the desired state so a later start can restore it. |
| **User restarts a service** | Drain, stop, start, wait for health, then re-advertise if the persisted desired state is enabled. If restart fails, leave the Service drained. |
| **Local process exits unexpectedly** | Best-effort drain the advertised Service and show the resulting stopped/error status. |
| **SourceManager shutdown** | Best-effort drain Services it manages; never reset or clear unrelated Tailscale configuration. |

### Shutdown ordering and failure behavior

Tailnet and process shutdown are not atomic operations. SourceManager must use this order:

1. Drain the named Service so it stops accepting new Tailnet connections.
2. Immediately begin the existing local process stop workflow.
3. Leave the endpoint configuration present but drained for a normal stop.

There is no artificial grace delay. Short requests may complete between drain acknowledgement and process termination, but long-lived Vite/HMR connections will be closed by process shutdown. Stopping the process first is not acceptable because Tailnet could continue routing new clients to a dead target.

If drain fails, SourceManager should attempt to remove the endpoint, continue the requested local stop, and return a structured warning such as **Service stopped; Tailnet cleanup failed**. A Tailscale failure must not take away local lifecycle control.

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

## Phase 4: Dashboard UX (implemented)

Extends the existing `ServiceCard` Tailnet URL link with live status and a persisted on/off toggle. Aligns with SO-3 polling (10 s refresh).

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
│  Tailnet  [ on ]   (disabled while service action runs)      │
└─────────────────────────────────────────────────────────────┘
```

#### Tailnet status indicator

Visual badge next to the expected URL (`LifecycleBadge`-style chip):

| Status | Badge label | Color intent | Meaning |
|---|---|---|---|
| `not_configured` | No Tailnet config | neutral | Service has no Tailscale Service fields in config |
| `unavailable` | Tailscale down | muted/warn | Host-level Tailscale unavailable |
| `local_stopped` | Service stopped | muted | Local process is not running; an existing mapping should be drained |
| `not_advertised` | Not on Tailnet | warn | Local process running; Serve not configured |
| `pending_approval` | Pending approval | warn | Advertised; admin approval required |
| `draining` | Draining | warn | No new Tailnet connections; local shutdown is pending or in progress |
| `connected` | Available | success | Serve configured, approved, target matches |
| `mismatch` | Config mismatch | error | Serve exists but target/port differs from config |
| `error` | Tailnet error | error | Last CLI action failed; show message |

**Available** (`connected`) means the tailnet hostname should work from other devices — not that the local dev server is running (combine with lifecycle badge for full picture).

#### Tailnet toggle

| Property | Value |
|---|---|
| Label | **Tailnet** |
| Icon | `Wifi` (consistent with existing link) |
| On action | `POST /v1/tailscale/services/:serviceId/service/enable` |
| Off action | `POST /v1/tailscale/services/:serviceId/service/disable` |
| Checked state | Persisted `tailscaleServiceEnabled` desired state |
| Enabled when | Local lifecycle is `running`, configuration is complete, Tailscale is available, and no card action is in flight |
| Disabled when | Local lifecycle is not `running`, configuration is missing, Tailscale is unavailable, or another lifecycle/Tailnet action is in flight |
| Loading | While POST in progress; lock button like other card actions |
| Stopped + checked | Keep checked but disabled and explain: "Tailnet will be restored when the service starts" |
| Tooltip examples | "Start the service before changing Tailnet", "Tailscale not connected on host", "Awaiting admin approval" |

Drain is lifecycle preparation, not a separate dashboard action. The toggle provides the user-facing enable/disable control.

#### Tailnet URL link

- Keep the clickable `https://<name>.<domain>` link when configured.
- Open in new tab (`rel="noreferrer"`).
- Link remains visible in all states except `not_configured`; optionally dim when `not_advertised`.

#### Auto-enable on service start (UX feedback)

When the user clicks **Start service** and backend auto-enables Tailnet:

1. Card shows lifecycle **starting** → **running** as today.
2. Tailnet badge transitions **not_advertised** → enabling → **connected** (or **error** / **pending_approval**).
3. No separate user click required if `tailscaleServiceEnabled: true` in config.

If auto-enable fails, show a non-blocking warning on the card: *"Service started but Tailnet enable failed: …"* with the checked toggle available for retry while the service remains running.

### API data shape (frontend)

Extend `ServiceSummary` (or nested `tailnet` object):

```typescript
interface TailnetStatus {
  configured: boolean
  desiredEnabled: boolean
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
    | "draining"
    | "connected"
    | "mismatch"
    | "error"
  lastError: string | null
  lastWarning: string | null
  operation: "enabling" | "draining" | "disabling" | null
  canToggle: boolean
}
```

Populate from `GET /v1/tailscale/status` as a host-level response plus a per-service map. Keep this request separate from `GET /v1/repos` so a missing or slow Tailscale daemon cannot delay lifecycle status.

### Polling

- Poll Tailnet status every **10 s** alongside RepoList polling, but handle the two requests independently.
- After a Tailnet toggle or service start/stop/restart, immediately refetch both relevant status sources.

### Settings UI

The existing Tailscale accordion in Settings should migrate to SO-6C fields:

- **Tailscale Service Name** (`tailscaleServiceName`)
- **Local Target** (`tailscaleServiceTarget`)
- **HTTPS Port** (default 443)
- **Desired Tailnet exposure** (`tailscaleServiceEnabled` checkbox)

Validation rules from SO-6C apply (lowercase service names, no `svc:` in config value).

---

## Implementation order

```
1. [NOW]     Register all svc:* Services in admin console
2. [NOW]     Re-auth dev machine with tag:dev-service-host
3. [NOW]     Manual serve + verify sourcemanager, then devplanner-api and devplanner
4. [NEXT]    Backend: tailscale.ts CLI adapter + status parsing
5. [NEXT]    Backend: /v1/tailscale/* routes
6. [NEXT]    Backend: lifecycle coordinator for enable, drain, stop, and restore
7. [NEXT]    Frontend: Tailnet panel + indicator + toggle on ServiceCard
8. [NEXT]    Config schema migration + Settings field updates
9. [LATER]   Optional host-level dashboard strip
```

---

## Acceptance criteria

**Manual phase (before SourceManager code):**

- All seven Services defined in admin console with `tcp:443`.
- Dev machine authenticated with `tag:dev-service-host`.
- `svc:sourcemanager` verified end-to-end from a second client device over HTTPS.
- At least one additional Service verified using the same checklist.

**Automation phase:**

- Starting a service with `tailscaleServiceEnabled: true` advertises Tailnet when not already available.
- The Tailnet toggle is disabled whenever the local service is not running.
- Stopping or restarting an advertised service drains it before local process shutdown.
- A normal stop preserves the desired enabled state and restores advertisement only after a later start becomes healthy.
- Explicit toggle-off drains, removes the endpoint, and persists the disabled state.
- Drain failure does not block local shutdown and is surfaced as a Tailnet cleanup warning.
- Dashboard badge shows **Available** only when Serve is connected and the target matches.
- Dashboard badge shows **Not on Tailnet** when the local process is running but Serve is missing.
- Tailscale daemon failure does not crash SourceManager; UI shows **Tailscale unavailable**.

---

## References

- [SO-6C: Tailscale Services with Named Tailnet Hostnames](./SO-6C-tailscale-services-named-services.md)
- [TailscalePolicyConfiguration.json](../TailscalePolicyConfiguration.json)
- [Tailscale Services docs](https://tailscale.com/docs/features/tailscale-services)
- [tailscale serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)
