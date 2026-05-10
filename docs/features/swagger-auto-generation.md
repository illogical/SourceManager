---
title: Swagger auto-generation (replace static openapi.yaml)
created: 2026-05-10
status: planned
priority: medium
tags: [openapi, swagger, elysia, dx]
---

## Problem

`docs/openapi.yaml` is a hand-maintained 845-line file that already diverges from the running API and must be updated every time routes, request bodies, or response shapes change. The API already serves a live OpenAPI spec at `GET /swagger/json` via `@elysiajs/swagger`, but that spec is thin: it only knows route paths and HTTP methods because none of the route handlers declare typed schemas.

**Goal:** Make `/swagger/json` the authoritative, always-accurate spec — delete `openapi.yaml` entirely or keep it only as a generated snapshot.

---

## How Elysia generates OpenAPI

`@elysiajs/swagger` reads the TypeBox schemas attached to each route via Elysia's `.get()` / `.post()` option objects and the `.detail()` decorator. It produces a full OpenAPI 3.x document with no build step.

Three things drive spec quality:

| Mechanism | What it adds to the spec |
|-----------|--------------------------|
| `body: t.Object({...})` | Request body schema + required fields |
| `response: { 200: t.Object({...}) }` | Response schema per status code |
| `.detail({ tags, summary, description, operationId })` | Human-readable metadata |

---

## Implementation plan

### 1. Add shared TypeBox schemas to `src/types.ts` or a new `src/schemas.ts`

Extract the reusable OpenAPI schemas as TypeBox objects so routes can reference them without repetition:

```typescript
// src/schemas.ts
import { t } from "elysia"

export const LifecycleStateSchema = t.Union([
  t.Literal("starting"),
  t.Literal("running"),
  t.Literal("stopped"),
  t.Literal("failed"),
])

export const ServiceLifecycleSchema = t.Object({
  state: LifecycleStateSchema,
  pid: t.Nullable(t.Integer()),
  startedAt: t.Nullable(t.String({ format: "date-time" })),
  readySince: t.Nullable(t.String({ format: "date-time" })),
  uptimeMs: t.Nullable(t.Integer({ minimum: 0 })),
  command: t.Nullable(t.String()),
  lastError: t.Nullable(t.String()),
})

export const TailnetInfoSchema = t.Nullable(t.Object({
  hostname: t.String(),
  domain: t.Nullable(t.String()),
  serveEnabled: t.Boolean(),
  serveMode: t.Nullable(t.Union([t.Literal("https"), t.Literal("http")])),
  serveTarget: t.Nullable(t.String()),
}))

export const ServiceSummarySchema = t.Object({
  id: t.String(),
  displayName: t.String(),
  port: t.Integer(),
  healthUrl: t.String({ format: "uri" }),
  healthMode: t.Union([t.Literal("ping"), t.Literal("full")]),
  packageManager: t.String(),
  scriptName: t.String(),
  tags: t.Array(t.String()),
  allowedIps: t.Array(t.String()),
  tailnet: TailnetInfoSchema,
  lifecycle: ServiceLifecycleSchema,
})

export const RepoSummarySchema = t.Object({
  id: t.String(),
  displayName: t.String(),
  repoPath: t.String(),
  defaultBranch: t.String(),
  services: t.Array(ServiceSummarySchema),
})

export const StepResultSchema = t.Object({
  step: t.String(),
  status: t.Union([
    t.Literal("pending"), t.Literal("success"),
    t.Literal("failure"), t.Literal("skipped"),
  ]),
  message: t.String(),
  durationMs: t.Integer({ minimum: 0 }),
})

export const RunReportSchema = t.Object({
  runId: t.String({ format: "uuid" }),
  serviceId: t.String(),
  repoId: t.String(),
  startedAt: t.String({ format: "date-time" }),
  durationMs: t.Integer({ minimum: 0 }),
  branch: t.String(),
  dryRun: t.Boolean(),
  updated: t.Boolean(),
  reason: t.String(),
  installRun: t.Object({ status: t.String(), reason: t.String(), durationMs: t.Optional(t.Integer()) }),
  restartRun: t.Object({ status: t.String(), reason: t.String(), durationMs: t.Optional(t.Integer()) }),
  healthStatus: t.Union([t.Literal("pass"), t.Literal("fail"), t.Literal("skipped")]),
  steps: t.Array(StepResultSchema),
})

export const StartStopResultSchema = t.Object({
  success: t.Boolean(),
  alreadyStopped: t.Optional(t.Boolean()),
  lifecycle: ServiceLifecycleSchema,
  message: t.Optional(t.String()),
})

export const ErrorResponseSchema = t.Object({
  error: t.String(),
})
```

### 2. Annotate routes in `src/routes/repos.ts`

Attach schemas and `.detail()` metadata to each route. Example for the list and start endpoints:

```typescript
import { RepoSummarySchema, ServiceSummarySchema, StartStopResultSchema, ErrorResponseSchema } from "../schemas"

export const reposRoute = new Elysia({ prefix: "/repos" })
  .get("/", async () => { /* ... */ }, {
    response: {
      200: t.Object({ repos: t.Array(RepoSummarySchema) }),
    },
    detail: {
      tags: ["Repos"],
      summary: "List all repos with services",
      operationId: "listRepos",
      description: "Returns all configured repos with nested services and lifecycle state.",
    },
  })

  .get("/:repoId", async ({ params }) => { /* ... */ }, {
    response: {
      200: RepoSummarySchema,
      404: ErrorResponseSchema,
    },
    detail: { tags: ["Repos"], summary: "Get repo detail", operationId: "getRepo" },
  })

  .get("/:repoId/services/:serviceId", async ({ params }) => { /* ... */ }, {
    response: {
      200: ServiceSummarySchema,
      404: ErrorResponseSchema,
    },
    detail: { tags: ["Repos"], summary: "Get service detail", operationId: "getService" },
  })

  .post("/:repoId/services/:serviceId/start", async ({ params }) => { /* ... */ }, {
    response: {
      200: StartStopResultSchema,
      404: ErrorResponseSchema,
    },
    detail: { tags: ["Lifecycle"], summary: "Start a service", operationId: "startService" },
  })
  // ... stop, restart similarly
```

### 3. Annotate routes in `src/routes/update.ts`

```typescript
import { RunReportSchema, ErrorResponseSchema } from "../schemas"

export const updateRoute = new Elysia()
  .post(
    "/repos/:repoId/services/:serviceId/update",
    async ({ params, body }) => { /* ... */ },
    {
      body: t.Optional(t.Object({
        branch: t.Optional(t.String()),
        installMode: t.Optional(t.Union([t.Literal("auto"), t.Literal("always"), t.Literal("never")])),
        restartMode: t.Optional(t.Union([t.Literal("auto"), t.Literal("always"), t.Literal("never")])),
        dryRun: t.Optional(t.Boolean()),
      })),
      response: {
        200: RunReportSchema,
        401: ErrorResponseSchema,
        404: ErrorResponseSchema,
      },
      detail: {
        tags: ["Update"],
        summary: "Trigger git update workflow",
        operationId: "updateService",
        description:
          "Runs precheck → fetch → checkout → pull → depCheck → install → restart → health. Any failure short-circuits remaining steps.",
      },
    }
  )
```

### 4. Update tag descriptions in `src/index.ts`

The `swagger()` call already lists tags. Update labels to match the new route structure:

```typescript
swagger({
  path: "/swagger",
  documentation: {
    info: {
      title: "SourceManager API",
      version: "1.1.0",
      description: "...",
    },
    tags: [
      { name: "Health",    description: "API liveness (unauthenticated)" },
      { name: "Repos",     description: "Repo and service listing, detail, and logs" },
      { name: "Lifecycle", description: "Service process start, stop, and restart" },
      { name: "Update",    description: "Git pull / branch-switch workflow" },
    ],
  },
})
```

### 5. Delete `docs/openapi.yaml`

Once the live spec at `/swagger/json` is accurate and complete, delete the static file:

```bash
rm docs/openapi.yaml
```

If a committed snapshot is still useful (e.g. for diffs in PRs), generate it on demand:

```bash
curl -s http://localhost:17106/swagger/json | python3 -m json.tool > docs/openapi.snapshot.json
```

Add to `.gitignore` or commit the snapshot intentionally — but never maintain it by hand again.

---

## Acceptance criteria

- [ ] `GET /swagger/json` returns schemas for all request bodies and all `200` / `404` response shapes.
- [ ] Swagger UI at `/swagger` shows typed request bodies with examples inferred from TypeBox schemas.
- [ ] `docs/openapi.yaml` is deleted (or replaced by a generated snapshot with a comment header warning it is not hand-edited).
- [ ] No test regressions (`bun run test:all` passes).
- [ ] Adding a new route with schemas automatically appears in `/swagger/json` without any additional step.

---

## Notes

- Elysia uses TypeBox (`t.*`) as its schema language. TypeBox objects are valid JSON Schema and are passed directly to the OpenAPI `components/schemas` section by `@elysiajs/swagger`.
- `t.Nullable(schema)` renders as `oneOf: [schema, { type: "null" }]` in OpenAPI 3.1 — correct for fields that can be null.
- Route-level `response` schemas also enable Elysia's runtime response validation in strict mode — a useful side effect.
- `operationId` should be camelCase and globally unique; it's what agent scripts use to identify endpoints.
- The auth guard lives in the `/v1` group's `onBeforeHandle` — not per-route — so the `401` response won't automatically appear in per-route schemas. Add it manually via `response: { 401: ErrorResponseSchema }` on any route that needs it documented, or add a global `components/responses` entry in the `swagger()` documentation block.
