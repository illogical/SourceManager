# SourceManager Process Lifecycle and Reboot Recovery Handoff

**Status:** Superseded by selective process-tree implementation
**Priority:** Critical  
**Branch:** `process-handling`  
**Compared with:** `master`  
**Last reviewed:** 2026-07-28

---

## Purpose

This document hands off the remaining shutdown, restart, cold-boot recovery, and
Tailnet-status problems introduced or exposed by the persistent service-runner
work. It records what the branch already changed, what has been tried since the
latest commit, and the selected architecture for the next implementation
session.

The immediate user-facing goals are:

1. Ctrl+C must give useful progress, close SourceManager, and release port
   `17106` without requiring a PC restart.
2. SourceManager started by Windows Task Scheduler must use one production
   process on `17106`; it must not depend on Vite.
3. Interactive development should restore Concurrently's clearer prefixed
   backend/frontend output.
4. Managed project services and their Tailnet advertisements must continue
   running when SourceManager stops.
5. Cold-boot recovery and Tailnet status must not report a healthy or still
   recovering service as failed.

This is a handoff and implementation plan. The remedies below have not all been
implemented.

> **2026-07-29 decision update:** The proposed long-lived runner host and
> Scheduled Task changes are out of scope. Persistent signed service runners
> remain direct detached descendants. SourceManager shutdown now protects
> verified runner subtrees and terminates only the remaining SourceManager
> descendants by exact PID. The custom development launcher is retained to
> provide timestamped backend/frontend output without Concurrently's Windows
> whole-tree termination.

---

## Selected Runtime Model

SourceManager has two distinct launch modes:

| Mode | Processes | Ports | Intended use |
|---|---|---|---|
| Scheduled/production | One non-watch SourceManager process serving the API and `frontend/dist` | `17106` | Windows logon task and normal remote/Tailnet use |
| Interactive development | Backend plus Vite, presented by Concurrently | `17106` and `17116` | Active backend/frontend development |

Port `17106` is the production SourceManager origin. Both the API and built
frontend are served from it, and the SourceManager named Tailnet Service targets
it.

Port `17116` is only the Vite development server. It must not be modeled as a
production SourceManager service, advertised independently on Tailnet, or
required by the scheduled task. Direct LAN/Tailnet use of Vite is not part of
this work.

SourceManager itself is never managed by the persistent project-service runner.
The runner remains responsible for other configured services such as DevPlanner.

---

## What Changed on This Branch

The latest branch commit, `4f484cf`, introduced the persistent runner protocol
and startup reconciliation. The current worktree also contains follow-up fixes
that are staged on top of that commit.

### Persistent managed-service work

- Each managed service is launched through a detached runner with a signed
  manifest, status heartbeat, authenticated control file, command fingerprint,
  runner PID, child PID, and process creation time.
- Intended state and ownership diagnostics are persisted so SourceManager can
  distinguish a verified prior launch from an arbitrary listener.
- Managed output is written to durable rotating log segments and can be read or
  streamed after SourceManager restarts.
- Startup reconciliation verifies saved runners and makes a one-time recovery
  attempt for a service that was intended to be running.
- SourceManager excludes its own API port from managed-service reconciliation.
- Tailnet configuration is preserved while SourceManager is offline and
  restored for healthy desired-on services.

These capabilities are still required. Reverting the complete branch to
`master` would remove the desired persistence behavior.

### Follow-up fixes already present in the worktree

- The custom SourceManager shutdown handler was removed from `src/index.ts`.
  That handler flushed ProcessManager state, awaited `app.stop()`, and handled
  SIGINT/SIGTERM itself. Active HTTP/Tailnet connections could keep that path
  waiting.
- ProcessManager state writes now use a serialized queue plus temporary-file
  replacement. This addresses the observed `Unexpected EOF` state corruption
  after interrupted writes.
- Request NDJSON logging now uses serialized append-only writes instead of
  concurrent whole-file read/modify/rewrite operations.
- Tailnet status now lets an observed advertised service override a stale saved
  error. Startup restoration skips a redundant advertise command when the
  correct target is already advertised and clears stale messages after a
  successful observation.
- Development startup checks API and Vite ports before launching and reports
  the listener PIDs rather than sharing an occupied port.
- A custom `src/devLauncher.ts` replaced Concurrently. It launches a non-watch
  backend and Vite, forwards their output, signals only their top-level PIDs,
  and imposes a three-second force-exit deadline.
- The separate SourceManager frontend service card was removed from live
  configuration. Production SourceManager correctly appears as one service on
  `17106`.

The state and logging fixes should be retained. The custom launcher and
scheduled-development startup are not the final architecture.

---

## Why Shutdown Worked on `master`

On `master`, `bun run dev` was:

```text
concurrently --kill-others --kill-timeout 3000 --names backend,frontend \
  "bun run dev:backend" "bun run dev:frontend"
```

The backend and frontend were ordinary descendants of Concurrently.
SourceManager-managed applications were also ordinary descendants and were not
expected to survive the SourceManager terminal. On Windows, Concurrently's
process-tree termination could therefore close the entire tree without
violating an application-persistence requirement.

The runner branch changed that ownership assumption. Managed project runners
are detached because they must survive SourceManager and its console. They are
nevertheless initially created by the SourceManager backend. Concurrently's
Windows tree-kill behavior and the new requirement to preserve those descendants
are incompatible.

The custom launcher avoided tree termination to protect managed runners. It
signals only its direct backend and Vite PIDs. That creates the opposite risk:
a Bun wrapper, watch process, or server descendant can survive after the direct
PID or terminal exits. The surviving descendant can continue listening on
`17106`.

Therefore:

- Seeing the terminal close does not prove SourceManager stopped.
- Sending SIGKILL to only the top-level launcher child does not prove the
  listener-owning descendant stopped.
- Restoring Concurrently without separating persistent runner ownership would
  reintroduce the risk of killing managed projects.
- Keeping the current exact-PID launcher does not guarantee that `17106` is
  released.

The fix is to separate persistent runner ownership from SourceManager's process
tree, then give SourceManager itself bounded whole-tree shutdown semantics.

---

## Remaining Bugs

### P0: SourceManager exits visibly but leaves `17106` listening

**Observed behavior**

- Ctrl+C can close the terminal immediately.
- A later startup reports that API port `17106` is occupied.
- Task Manager may not show the PID in the expected terminal process group.
- Restarting SourceManager can require killing the listener manually or
  rebooting Windows.

**Likely mechanism**

The current launcher kills only direct children to avoid terminating detached
managed runners. A Bun/server descendant can remain alive and own the listening
socket.

**Required result**

- Shutdown identifies the verified SourceManager process tree.
- The graceful phase is bounded.
- The verified tree is terminated if needed.
- Shutdown does not report completion or close its visible host until `17106`
  has no listener.
- An unrelated or unverifiable listener is reported but never killed.

### P0: Persistent runners share ancestry with the SourceManager backend

Detached mode and `unref()` prevent ordinary parent waiting, but do not provide
a sufficiently clear Windows ownership boundary for a launcher that terminates
an entire descendant tree.

Persistent runners must be created by an independent runner host whose process
root belongs to Windows Task Scheduler, not to SourceManager or Concurrently.

### P1: Scheduled startup runs development mode

`SourceManagerStartup.ps1` currently validates both API and Vite ports and runs
`bun run dev`. That makes a logon task depend on two development processes and
confuses production port reporting.

The scheduled task must build or validate `frontend/dist`, then run the
non-watch `start` command only. It should check only the configured API port.

### P1: Cold-boot recovery fails healthy but slow services

Startup reconciliation currently uses one global five-second deadline and
starts all configured services concurrently. The remaining readiness time can
be only a fraction of those five seconds after initial health and ownership
checks.

When readiness misses that window, `recordRecoveryFailure()`:

- stops the newly created runner,
- marks lifecycle state `failed`,
- changes intended state to `stopped`, and
- says automatic recovery is off until an explicit Start.

This explains the reboot screenshot in which the DevPlanner API eventually
became available while the frontend was declared failed. Vite and other
cold-starting tools can legitimately take longer than five seconds after a
reboot.

### P1: Tailnet `NoState` can contradict observed availability

The current code can read named Serve configuration using:

```text
tailscale serve get-config --all
```

The implementation therefore does not need to guess whether a service is
advertised. It should inspect the live service record, endpoint target, and
`advertised` value before issuing another advertise command.

The screenshot showed `NoState` for DevPlanner even though its Tailnet address
was reachable. A command error retained in memory must not override a later
authoritative observation.

### P2: Startup PowerShell diagnostics are noisy and incomplete

- An expected lack of `Get-NetTCPConnection` results can fall into a noisy
  error/fallback path.
- Occupied ports are reported, but a stale verified SourceManager instance is
  not yet recoverable.
- The task description and terminal title still describe development mode.
- Stop checks both API and Vite even though production startup should own only
  the API port.

---

## Implementation Plan

### 1. Introduce an independent runner host

Create one long-lived Windows runner-host process for persistent managed
services.

- Install it as a separate per-user scheduled task.
- Start it before SourceManager at logon or on demand.
- Ensure Task Scheduler, rather than SourceManager, creates its process root.
- Move runner launch, authenticated stop requests, status heartbeats, and output
  ownership behind this host.
- Keep the existing signed manifest and status concepts; do not weaken process
  identity checks.
- Have ProcessManager request operations from the host through a local,
  authenticated control channel or atomic control records.
- Persist at least service ID, runner PID, child PID, desired state, readiness
  state, start/ready timestamps, command fingerprint, and last output/failure
  summary.
- If the host is unavailable, report managed services as unavailable to control;
  do not adopt or kill listeners based only on a port.

This separation allows SourceManager's own process tree to be terminated without
affecting persistent projects.

### 2. Restore Concurrently for interactive development

Restore the master-style `dev` command and prefixed backend/frontend output after
runner-host separation is in place.

- `dev:backend` may retain watch mode for interactive development.
- `dev:frontend` continues to run Vite on `17116`.
- Concurrently may terminate its complete backend/frontend trees because
  persistent service runners are no longer descendants.
- Do not restore Concurrently before the runner-host boundary is implemented and
  tested.
- Remove `src/devLauncher.ts` after Concurrently is restored and no remaining
  script imports it.

### 3. Make scheduled startup production-only

Change the SourceManager scheduled task to:

1. Verify the runner-host task is installed and start it if needed.
2. Validate dependencies, configuration, and `frontend/dist`.
3. Build the frontend when the build is missing or stale, or fail with a clear
   build instruction if automatic building is deliberately disabled.
4. Check only the configured SourceManager API port.
5. Launch `bun run start`, not `bun run dev`.
6. Record SourceManager's PID, executable path, command line/fingerprint,
   creation time, repository path, and API port in a SourceManager-specific
   ownership record.
7. Keep the production terminal visible and retain the startup transcript.

The task name and description should say “SourceManager server,” not
“SourceManager development mode.”

### 4. Add verified, bounded SourceManager shutdown

SourceManager shutdown is separate from managed-service shutdown.

1. On the first Ctrl+C/SIGTERM, print the reason and enter a single idempotent
   shutdown operation.
2. Stop accepting new SourceManager API work.
3. Flush only SourceManager-owned state/log queues with a bounded timeout.
4. Ask the production server to close gracefully.
5. Wait a short, explicit grace period while printing the current stage.
6. Verify whether `17106` is still listening.
7. If it is owned by the recorded SourceManager tree, terminate that verified
   tree and poll until the port is free.
8. If it is unverified, leave it running, print its PID and available command
   line/creation details, and exit with a failure result.
9. On a repeated Ctrl+C, skip directly to terminating the verified
   SourceManager tree.
10. Close the terminal only after the port check has completed.

Do not call a potentially unbounded `app.stop()` and then wait without stage
output. Do not use a port number alone as permission to kill a process.

The same ownership verification and port-release routine must be used by the
scheduled task's `Stop` command and stale-instance startup recovery.

### 5. Improve startup reconciliation

- Replace the shared five-second window with a configurable per-service
  readiness timeout. Default to 30 seconds.
- Add a `recovering` lifecycle state for a verified runner that has started but
  whose health endpoint is not ready.
- Run cold-boot starts through a bounded queue instead of unbounded
  `Promise.all`; default concurrency should be two.
- Preserve `intendedState: "running"` when readiness times out.
- Do not stop the runner solely because the first recovery window expired
  unless it has exited, lost identity, or produced a definitive startup error.
- Record a recoverable timeout diagnostic and expose Retry/Start.
- Continue background reconciliation so a late healthy result can move
  `recovering` to `running`.
- Include the latest captured output summary in a failed or timed-out service
  response.
- An explicit user Stop remains the only normal action that changes intended
  state to stopped.

### 6. Make observed Tailnet state authoritative

Use this precedence:

1. Read live Serve configuration before enabling or advertising.
2. If the expected named service exists, targets the expected local origin, and
   has `advertised: true`, report `connected`, clear stale errors, and issue no
   advertise command.
3. If it targets correctly but is explicitly not advertised, perform one
   bounded repair.
4. If an advertise operation returns `NoState`, immediately re-read live Serve
   configuration. Treat the operation as successful if the expected advertised
   record is now present.
5. If live state cannot be queried but persisted intent is enabled, report
   `enabled_unverified`, not `connected` or `error`.
6. Keep the disable control available in the unverified state when the local
   command channel is available.
7. Never label persisted intent as confirmed live availability.

The frontend needs a label such as **Enabled (unverified)** and neutral styling
for this new presentation state.

### 7. Clean up PowerShell ownership and diagnostics

- Query `Get-NetTCPConnection` with expected-empty behavior that does not print a
  terminating error.
- Fall back to `netstat` only when the cmdlet itself is unavailable or fails,
  not simply when no listener exists.
- Print port, PID, executable path, command line, creation time, and whether the
  ownership record verifies the process.
- On startup, terminate a stale listener only when all SourceManager identity
  checks pass.
- Wait for confirmed port release before relaunch.
- For an unverified listener, fail safely and print a copyable PowerShell
  inspection command.
- Production status and stop operations should inspect `17106`; Vite status
  belongs only to an explicit development-status command.

---

## Interfaces and Compatibility

No existing HTTP endpoint needs to be renamed or removed.

Required additions:

- A service lifecycle value representing `recovering`.
- A Tailnet presentation value representing `enabled_unverified`.
- A configurable per-service recovery timeout, with a 30-second default.
- Runner-host control and status records containing the ownership and readiness
  fields listed above.
- A SourceManager-specific ownership record used only for verified shutdown and
  stale-instance recovery.

Compatibility requirements:

- Existing managed-service manifests should be migrated or reconciled without
  adopting an arbitrary listener.
- Existing desired-on Tailnet configuration must remain enabled.
- Existing service output logs remain readable.
- SourceManager's production URL and API continue to share port `17106`.
- The runner host must not expose a network listener outside the local machine.

---

## Acceptance Tests

### SourceManager shutdown and restart

- Start interactive development, hold HTTP keep-alive connections open, press
  Ctrl+C, and observe bounded stage messages.
- Verify both backend and Vite process trees exit.
- Verify no listener remains on `17106` or `17116`.
- Restart immediately and verify exactly one listener owns `17106`.
- Verify `/health`, authenticated `/v1/repos`, and the built frontend respond.
- Repeat using the SourceManager Tailnet address.
- Press Ctrl+C twice and verify the second press immediately terminates only the
  verified SourceManager tree.

### Scheduled startup

- Install and start the scheduled task after a clean reboot.
- Verify it launches one SourceManager server process and does not start Vite.
- Verify `17106` serves the API and built frontend.
- Verify nothing is required to listen on `17116`.
- Stop the task and verify its terminal reports shutdown stages and `17106`
  becomes free.
- Create an unverified listener on `17106`; verify startup refuses to kill it
  and prints actionable ownership details.

### Managed-service persistence

- Start multiple managed services, then stop SourceManager.
- Verify the independent runner host, service children, output capture, and
  Tailnet advertisements remain active.
- Restart SourceManager and verify it reconnects to verified runner records.
- Verify Concurrently shutdown cannot terminate runner-host processes.

### Cold-boot recovery

- Persist desired-running services, reboot, and start SourceManager.
- Use a service that needs more than five seconds but less than 30 seconds to
  become healthy; verify it remains `Recovering` and then becomes `Running`.
- Simulate a timeout; verify intended state remains running, retry is available,
  and recent output is shown.
- Verify bounded recovery concurrency and that one slow service does not consume
  another service's readiness window.

### Tailnet reconciliation

- Test already advertised with the correct target: no mutation command.
- Test correct target but not advertised: one bounded repair.
- Test wrong target: report mismatch and follow the explicit repair path.
- Test advertise returning `NoState` while a follow-up read shows advertised:
  report connected and clear the error.
- Test unavailable live state with saved desired-on state: report Enabled
  (unverified) and retain the disable action where possible.
- Test a genuinely stopped local service: do not report Tailnet availability.

### Regression suite

Run:

```text
bun run test:all
bun run test:frontend
bun run test:backend
bun run frontend:build
```

Also add Windows integration coverage for scheduled-task ownership, Ctrl+C,
process-tree termination, and post-shutdown port release. Unit tests alone
cannot validate the Windows process-boundary behavior.

---

## Recommended Implementation Order

1. Add the independent runner host and migrate ProcessManager control to it.
2. Restore Concurrently for interactive development.
3. Split scheduled production startup from development startup.
4. Implement verified SourceManager ownership and bounded shutdown.
5. Correct recovery timing/state semantics.
6. Add Tailnet re-read and unverified-state behavior.
7. Clean up PowerShell diagnostics and complete Windows integration tests.

Do not validate shutdown by terminal disappearance alone. Every implementation
step affecting SourceManager lifecycle is complete only when port `17106` is
confirmed free and managed project services remain running.

---

## Worktree Handoff Notes

At the time of this handoff, the branch has staged changes on top of
`4f484cf`, including additions, modifications, and deletion of the abandoned
application-lifecycle helper. Review `git status` and stage this document before
creating the next commit.

Retain the atomic ProcessManager state writes, append-only request logger,
ownership verification, durable service output, and observed Tailnet-state
improvements. Treat the custom development launcher as an interim workaround to
remove after runner-host separation and Concurrently restoration.

Related design history:

- [Preserve Managed Services and Reconcile on Startup](./service-persistence-and-startup-reconciliation.md)
- [Service Stop Functionality Improvement Plan](./service-stop-functionality.md)
- [Remove Docker and Restore Windows Startup](./remove-docker-and-windows-startup.md)
