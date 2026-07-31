# Fix Tailnet `NoState` Startup Reconciliation

**Status:** Implemented
**Priority:** High
**Scope:** Tailnet startup reconciliation, observed advertisement semantics, and `NoState` recovery

---

## Summary

Correct startup reconciliation so SourceManager treats a matching Tailscale
Service as advertised when `advertised` is either `true` or omitted. Tailscale
documents the field as optional, with omission representing the normal
advertised state. SourceManager currently handles that correctly when rendering
status, but not consistently during restoration and `NoState` recovery.

References:

- [Tailscale Services](https://tailscale.com/kb/1552/tailscale-services)
- [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)

## Implementation Changes

- Centralize advertisement interpretation in the Tailnet service layer:
  - `advertised: false` means explicitly drained/not advertised.
  - `advertised: true` or an omitted field means advertised.
  - A Service is considered connected only when its named record, HTTPS
    endpoint, and normalized local target all match.
- During startup, continue reconciling only healthy services whose saved
  `tailscaleServiceEnabled` intent is On:
  - Read `tailscale serve get-config --all` before issuing any mutation.
  - If the matching Service is already advertised, issue no Serve command,
    clear stale errors, and report `Available`; the existing saved-On intent
    keeps the toggle On.
  - If explicitly drained, perform one bounded per-Service Off-then-On repair
    using the existing endpoint commands. Do not use `tailscale serve reset` or
    retry loops.
  - Do not run a redundant `tailscale serve advertise` after the endpoint-enable
    command, because that command already configures and advertises a named
    Service.
- If an enable/advertise operation returns `NoState`, immediately reread live
  Serve configuration:
  - Accept the operation as successful when the expected endpoint is present
    and `advertised` is not explicitly false.
  - Clear the command error so later status polling cannot override
    authoritative live state.
  - Retain the error when the reread fails or does not prove the expected
    advertisement.
- Preserve the distinction between saved intent and observed state. A saved-Off
  but unexpectedly advertised Service remains Off in the toggle and retains the
  existing warning rather than being silently persisted as On.
- Update the existing startup-reconciliation documentation with the tri-state
  advertisement semantics and verified `NoState` behavior. No REST API, OpenAPI
  schema, frontend type, or configuration-schema changes are required.

## Test Plan

- Add unit coverage for a matching Service whose `advertised` field is omitted:
  startup performs no mutation, status is `connected`, stale errors are cleared,
  and desired state remains On.
- Update the explicitly drained case to prove exactly one per-Service
  Off-then-On repair occurs without a redundant advertise command.
- Cover `NoState` followed by:
  - A matching record with omitted `advertised`, accepted as success.
  - A matching record with `advertised: true`, accepted as success.
  - An absent, mismatched, or explicitly false record, retained as an error.
- Preserve coverage for unavailable Tailscale, stopped/recovering local
  services, mismatched targets, saved-Off/live-On warnings, and manual
  enable/disable routes.
- Run the targeted Tailnet tests, then the complete backend/frontend test suites
  and frontend build.
- Perform Windows acceptance testing by rebooting with DevPlanner previously
  running and Tailnet enabled. Verify SourceManager restores process ownership,
  sends no redundant advertisement command, shows `Available` with the toggle
  On, and records no `NoState` error.

## Assumptions

- The persisted `tailscaleServiceEnabled` value remains the source of user
  intent.
- Tailscale's documented behavior that omitted `advertised` means advertised
  applies to the installed Windows client.
- Automatic repair remains limited to one attempt per healthy desired-On
  service per SourceManager startup.
- The targeted Tailnet baseline was green before implementation: 13 tests
  across the service and route suites passed.
