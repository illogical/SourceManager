# SourceManager Agent Instructions

SourceManager v2 is a Node 24 / Express 5 unified application host. Use `http://127.0.0.1:17106/health` for public readiness and send `X-DevServer-Token` on every `/api/SourceManager/*` request. Never print, log, commit, or place the token in a URL.

Read project state with `GET /api/SourceManager/projects`. Treat `loadedCommit`, `checkedOutCommit`, `buildState`, and `workingTree` as separate facts. An updated checkout is not running until a successful build and whole-host restart make `loadedCommit === checkedOutCommit`.

Configuration uses schema version 2 and project-level web/API/realtime/build/module declarations. Validate with `POST /api/SourceManager/config/validate` before saving with `PUT /api/SourceManager/config`. Saving creates a backup but does not silently restart the host. The v1 converter at `POST /api/SourceManager/config/preview-v1` is preview-only.

Do not start, stop, or restart child services: hosted mode has no child lifecycle API. Missing sibling adapters are expected during migration and appear as `unavailable`. Project Git/update endpoints are intentionally deferred until the project-level update phase.

The single Tailnet control is `/api/SourceManager/tailnet`; enable or disable only the configured `apps` service. A project load failure must not change its advertisement.

Before requesting `POST /api/SourceManager/restart`, inspect project status for active work. The host returns 409 when an adapter reports blocking work. Exit code 75 is consumed by the Windows production wrapper.

For local verification, run `npm test`, `npm run build`, `npm run verify:host`, and `npm run verify:fixture`. After a production restart, verify the local health/portal/API routes, each enabled application route, realtime paths, the one listener PID, and the Tailnet origin.
