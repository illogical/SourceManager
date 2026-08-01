# Phase 0 Decisions

Confirmed 2026-07-31 for contract version 1:

- Runtime: Node 24 LTS and npm 11. SourceManager pins `24.18.1` and `npm@11.11.1`; each sibling adapter change must add the same `.node-version`, `.nvmrc`, `engines`, and `packageManager` values before it can be enabled.
- Canonical paths preserve display-name casing: `/SourceManager`, `/DevPlanner`, `/LMApi`, `/MemoryApi`, and `/LMEval`, with application APIs below the matching `/api/<DisplayName>` path.
- Temporary lowercase aliases are enabled for GET navigation only. Mutation requests and realtime upgrades are never redirected.
- The one Tailnet service name is `apps`. Its expected URL is `https://apps.<tailnet-domain>.ts.net`; the operator must grant the `apps` service identity in the tailnet policy before enabling it.
- LMApi keeps a temporary `/v1` compatibility response for one release. It redirects clients to `/api/LMApi/v1`; clients must update their configured OpenAI base URL because mutations and streaming requests are not transparently proxied.
- A restart is blocked while an adapter reports active work with a `block` policy. LMEval must report active evaluations this way. LMApi stops accepting new work and drains active requests for at most 30 seconds during graceful shutdown. Cancel/resume behavior is not inferred by SourceManager; the owning adapter must expose it explicitly.
- The active gitignored v1 configuration is not migrated in place. A checksum-verified timestamped backup is stored under gitignored `data/backups/`, and the API converter is preview-only.

These decisions are input requirements for phases 3–5. Missing adapters remain isolated as `unavailable` and do not prevent the SourceManager portal from starting.
