import Elysia, { t } from "elysia"

const startedAt = Date.now()

export const healthRoute = new Elysia().get(
  "/health",
  () => ({
    status: "ok",
    version: "1.0.0",
    uptimeMs: Date.now() - startedAt,
  }),
  {
    detail: { summary: "API health check", tags: ["Health"] },
    response: t.Object({
      status: t.String(),
      version: t.String(),
      uptimeMs: t.Number(),
    }),
  }
)
