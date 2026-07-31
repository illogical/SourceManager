# Reliable Managed-Service Status and Refresh

## Diagnosis

DevPlanner's API and frontend remained healthy on ports `17103` and `5173`
after their detached SourceManager runner supervisors exited. The live listener
processes were descendants of the original managed launches, but the signed
runner heartbeats stopped and SourceManager could no longer safely control
them. The dashboard collapsed that loss of management into the single red
`Failed` state even though both health URLs still passed.

Both failed runs left a `runner-status.json.tmp` newer than the last committed
status file. Runner heartbeat writes used one fixed temporary name without
serialization or error handling, while supervisor stderr was discarded. An
overlapping or transient Windows rename failure is therefore the strongest
available explanation, but the exact exception was not recorded.

PID tracking should remain supporting evidence rather than the sole source of
truth. URL health establishes availability; signed runner identity, heartbeat,
listener ownership, and process ancestry establish whether SourceManager can
safely stop or restart a service. A URL-only model would hide loss of control.

## Architecture and Compatibility

- Preserve the existing lifecycle object and persisted process records for
  compatibility. Add a separate observed status with availability and
  management dimensions.
- A passing health check is shown as Running. A missing or invalid runner for a
  healthy listener is an amber `Control lost` attention condition, not a
  service failure.
- Never adopt, terminate, restart, or replace an unverified listener
  automatically. Existing healthy DevPlanner listeners must remain untouched.
- Keep `intendedState: "running"` when a previously managed service remains
  healthy. Existing state files require no destructive migration.
- Derive Tailnet state from local availability and authoritative live Tailscale
  Serve configuration so a stale command error cannot override an observed
  matching advertisement.

## Implementation

1. Serialize runner status publication, use a run-specific temporary path,
   retry transient Windows replacement failures, and prevent heartbeat errors
   from terminating the supervisor. Write sanitized runner events for startup,
   child/control failures, status-write failures, unhandled errors, and exit.
2. Add an observation coordinator shared by startup, scheduled monitoring, and
   manual refresh. It coalesces per-service work, uses bounded concurrency, and
   records health, listener, runner, heartbeat, and diagnostic evidence.
3. Make repository GET routes return cached observations. Add global and
   per-service POST refresh routes, with partial per-service results and
   timestamps. Run scheduled observations every ten seconds in the backend.
4. Add `observedStatus` to backend/frontend contracts. Render healthy services
   as Running, show management loss separately, guard unsafe actions, and base
   Tailnet local availability on observed health.
5. Add distinct global and per-service status-refresh feedback: pending state,
   disabled duplicate controls, accessible `Checking...` text, last-checked
   time, and inline partial errors. Keep repository Update as a separate action.
6. Record status transitions and manual observations in daily NDJSON without
   logging tokens, environment data, or unchanged scheduled checks.

## Public Interfaces

- Each service summary gains `observedStatus` containing availability
  (`healthy | unhealthy | unknown`), management
  (`managed | control_lost | unmanaged | not_applicable`), check timestamp,
  health duration/error, listener and runner PIDs, runner heartbeat, diagnostic
  code, and a sanitized explanation.
- `POST /v1/status/refresh` refreshes all configured services and Tailnet state
  and returns updated repositories, per-service outcomes, `checkedAt`, and
  `durationMs`.
- `POST /v1/repos/:repoId/services/:serviceId/status/refresh` performs the same
  observation for one service.
- Partial observation failures remain successful refresh responses with
  per-service errors; only coordinator failure is a request-level error.

## Acceptance Tests

- Concurrent or failing heartbeat writes do not terminate the runner and emit
  sanitized diagnostic events.
- Healthy plus verified runner reports Running/managed; healthy plus dead
  supervisor reports Running/control-lost; healthy without saved state reports
  Running/unmanaged; unhealthy checks do not erase intended running state.
- A later successful check replaces stale failed availability without adopting
  or killing the listener.
- Repository GETs are passive; targeted/global refreshes coalesce work, enforce
  bounded concurrency, return timestamps and partial failures, and reread live
  Tailnet configuration.
- Dashboard tests cover card/global refresh progress, last-checked feedback,
  partial errors, accessible announcements, management attention, guarded
  controls, and separation from repository updates.
- An integration fixture whose supervisor is killed while its child stays
  healthy remains available and is reported Running with Attention.
- Runtime verification checks local DevPlanner health, listener evidence,
  named-Service configuration, refresh feedback, and absence of a red failure
  caused solely by lost management control.

## Worktree and Rollout Notes

The worktree was clean before this document was added. Do not stop or replace
the current DevPlanner orphan listeners during implementation. On first launch
of the updated SourceManager, existing state should be observed in place and
displayed as healthy with a control warning. Regaining management remains an
explicit manual restart after the operator chooses an appropriate maintenance
window.
