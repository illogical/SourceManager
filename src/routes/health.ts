import Elysia, { t } from "elysia"
import { getStartupReconciliationStatus } from "../services/startupStatus"

const startedAt = Date.now()

export const healthRoute = new Elysia().get(
  "/health",
  () => ({
    status: "ok",
    version: "1.0.0",
    uptimeMs: Date.now() - startedAt,
    applicationState: "running" as const,
    startupReconciliation: getStartupReconciliationStatus(),
  }),
  {
    detail: { summary: "API health check", tags: ["Health"] },
    response: t.Object({
      status: t.String(),
      version: t.String(),
      uptimeMs: t.Number(),
      applicationState: t.Union([t.Literal("running"), t.Literal("shutting_down")]),
      startupReconciliation: t.Object({
        state: t.Union([t.Literal("pending"), t.Literal("running"), t.Literal("complete")]),
        startedAt: t.Nullable(t.String()),
        deadlineAt: t.Nullable(t.String()),
        timeoutMs: t.Number(),
        total: t.Number(),
        completed: t.Number(),
        remainingMs: t.Number(),
        message: t.String(),
      }),
    }),
  }
)
