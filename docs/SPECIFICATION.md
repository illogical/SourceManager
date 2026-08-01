# SourceManager v2 Specification

SourceManager is a Node 24 / Express 5 composition root and the only managed HTTP listener. It imports compiled, versioned application adapters from sibling repositories under `SOURCEMANAGER_WORKSPACE_PATH`, serves bounded application assets, and dispatches application-owned API and realtime routes.

The normative implementation specification is split across:

- [Target architecture](features/unified-node-express-portal/architecture.md)
- [Schema and routing](features/unified-node-express-portal/schema-and-routing.md)
- [Phase 0 decisions](features/unified-node-express-portal/decisions.md)
- [Hosted adapter guide](features/unified-node-express-portal/host-adapter-guide.md)
- [Implementation tasks and acceptance matrix](features/unified-node-express-portal/tasks.md)

The v1 nested service/process schema, child lifecycle endpoints, and per-service Tailnet advertisements are not part of this specification. Git fetch/pull/build/restart work remains a project-level phase after the hosted adapters land.
