# Feature Removal and Portal Simplification Plan

## Removal principle

Delete child-service management only after all configured projects run through hosted adapters and standalone npm parity is proven. Until that gate, hide new hosted projects behind a feature flag and retain the v1 path for rollback.

## Backend removals

| Current area | Remove | Retain/replace |
|---|---|---|
| `src/services/processManager.ts` | child spawn/kill/restart, PID/port registry, detached runner ownership, startup PID reconciliation | shared host shutdown and adapter initialize/dispose registry |
| lifecycle routes in `src/routes/repos.ts` | per-service start/stop/restart/log endpoints | project status and later fetch/pull/build/restart-host endpoints |
| `data/state.json` | persisted child PID/lifecycle intent | persisted project update results and last-known load/build metadata |
| child health checks | loopback port checks and health-driven restarts | host readiness plus adapter status and bounded route smoke tests |
| install/package-manager services | Bun/npm/yarn/pnpm child runtime selection | npm-only install/build steps during project update |
| update report types | `serviceId`, `restartMode`, child `restartRun` | `projectId`, build/verify/host-restart/load steps |
| port conflict logic | per-service port ownership and external PID killing | one configured host listener preflight; never kill unknown PIDs automatically |
| runner control | detached runner protocol/process tree handling | restart-capable SourceManager wrapper only |

Git argument-array execution, clean-tree checks, fetch/checkout/pull safeguards, dependency-change detection, structured step reporting, audit logs, and token authentication remain valuable and migrate to project scope.

## Tailscale removals

Remove:

- per-service named service config and desired state;
- service drain/restore on process transitions;
- per-service enable/disable/status routes;
- service target validation against many loopback ports;
- Tailnet status on every service card;
- legacy per-service Serve host fields if no longer used.

Retain:

- one exact global service name/HTTPS port/target;
- one status/reconcile implementation;
- one authenticated enable/disable control;
- policy/docs for the `apps` service and exact host;
- verification from local origin and a second Tailnet device.

## Frontend removals

Remove or rewrite:

- `ServiceCard` start/stop/restart controls and command display;
- `LifecycleBadge` and states `starting/running/stopping/stopped/failed`;
- per-service `TailscalePanel` and service toggles;
- settings fields for package manager, script, install command, port, health URL/mode, allowed IPs, and all service Tailnet fields;
- optimistic lifecycle polling and run log UI tied to service actions;
- service count/port-centric summaries.

Replace with:

- a `ProjectCard` with web/API/docs links and capability badges;
- `HostStateBadge` (`ready/degraded/unavailable/disabled`);
- loaded versus checked-out commit and dirty/build indicators;
- concise module initialization/route status;
- a single host/Tailnet banner and toggle;
- reserved space for later fetch/pull/build/reload actions and progress.

The dashboard remains a per-application portal rather than becoming a blank link list.

## Schema/editor removals

- Replace `ServiceConfig`, `EditableServiceConfig`, process/lifecycle types, port-map types, and service lookup helpers.
- Rename `repos` to `projects` consistently at the API/UI boundary while retaining repository language for Git operations.
- Remove validation/diff/merge logic for nested services and per-service Tailnet fields.
- Add validation for adapter/build/static paths, mount collisions, contract version, and the global Tailnet block.
- Settings should favor a checked-in catalog/default plus advanced JSON preview; module paths should not be casually editable from the browser without validation.

## Logs and observability

Remove lifecycle logs keyed by service action. Keep daily request/audit rotation and introduce events:

- `host.start`, `host.ready`, `host.stop`, `host.restart`;
- `project.load`, `project.initialize`, `project.dispose`;
- `project.fetch`, `project.pull`, `project.install`, `project.build`, `project.verify`;
- `tailnet.reconcile`;
- `route.smoke`.

Every event includes `projectId`, checkout/build/loaded commit when relevant, duration, status, and sanitized error. Never log tokens or project secrets.

## Test removals and replacements

Remove tests whose only behavior is child PID state, kill semantics, lifecycle buttons, per-service port conflicts, per-service Tailnet state, and Bun package-manager execution.

Replace with tests for:

- adapter contract validation and isolated failures;
- route prefix collision/order and SPA fallback boundaries;
- repository-root and symlink escape prevention;
- build manifest/loaded commit accuracy;
- adapter init/dispose and shared WebSocket upgrade dispatch;
- project-level update/build/restart reports;
- one global Tailscale state;
- portal project cards and Git/build/load statuses;
- standalone-versus-hosted contract parity for every repository.

## Documentation cleanup

After cutover, update/remove documentation that describes:

- Bun/Elysia prerequisites and commands;
- one port/process/Tailscale service per configured service;
- child start/stop/restart API;
- service persistence/recovery and detached runner behavior;
- Docker/Bun startup details no longer used;
- per-service configuration examples.

Preserve historical feature documents if useful, but mark them superseded by this plan and link to the migration release. Update `README.md`, `docs/SPECIFICATION.md`, OpenAPI, `.env.example`, example project JSON, and Windows startup documentation together.

## Deletion gate

The old implementation is removable only when:

1. all five projects pass hosted and standalone acceptance tests;
2. the single Tailnet route is verified from a second device;
3. loaded-commit reporting survives pull/build/restart;
4. restart behavior with LMEval/LMApi active work is defined and tested;
5. v1 config is backed up and the rollback release is documented;
6. no project relies on a child loopback listener in hosted mode;
7. the final scheduled host is restored and its single port ownership verified.

