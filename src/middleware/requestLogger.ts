import Elysia from "elysia"
import { logRequest } from "../services/requestLogger"

export const requestLoggerMiddleware = new Elysia({ name: "request-logger" })
  .onAfterHandle({ as: "global" }, async ({ request, set, server }) => {
    const ip =
      server?.requestIP(request)?.address ??
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown"

    let body: unknown = undefined
    const contentType = request.headers.get("content-type") ?? ""
    if (contentType.includes("application/json")) {
      try {
        // Clone to avoid consuming the stream
        body = await request.clone().json()
      } catch {
        body = undefined
      }
    }

    logRequest({
      timestamp: new Date().toISOString(),
      method: request.method,
      url: request.url,
      body,
      status: set.status as number ?? 200,
      durationMs: 0, // Elysia doesn't expose duration here; timing handled per-route if needed
      ip,
    }).catch((err) => console.error("[RequestLogger] Failed to write log:", err))
  })
  .onError({ as: "global" }, ({ request, error, server }) => {
    const ip =
      server?.requestIP(request)?.address ??
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown"

    const status = "status" in error ? (error as { status: number }).status : 500

    logRequest({
      timestamp: new Date().toISOString(),
      method: request.method,
      url: request.url,
      body: undefined,
      status,
      durationMs: 0,
      ip,
    }).catch(() => {})
  })
