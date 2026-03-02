import Elysia from "elysia"
import { swagger } from "@elysiajs/swagger"
import { loadConfig } from "./config"
import { requestLoggerMiddleware } from "./middleware/requestLogger"
import { healthRoute } from "./routes/health"
import { projectsRoute } from "./routes/projects"
import { projectRoute } from "./routes/project"
import { updateRoute } from "./routes/update"
import { lifecycleRoute } from "./routes/lifecycle"
import { logsRoute } from "./routes/logs"
import { processManager } from "./services/processManager"
import { rotateOldLogs } from "./services/runLogger"
import { ProjectNotFoundError } from "./config"

// ── Startup ────────────────────────────────────────────────────────────────

const config = loadConfig()

// Ensure data directory exists
await Bun.write("data/logs/.keep", "")

// Init process manager (restore state, prune stale PIDs)
await processManager.init()

// Rotate old logs (keep 7 days)
await rotateOldLogs()

// ── Auth guard ─────────────────────────────────────────────────────────────

function requireToken(headers: Record<string, string | undefined>): void {
  const token = headers["x-devserver-token"]
  if (!token || token !== config.server.token) {
    throw new Error("UNAUTHORIZED")
  }
}

// ── App ────────────────────────────────────────────────────────────────────

const app = new Elysia()
  // OpenAPI docs (unauthenticated)
  .use(
    swagger({
      path: "/swagger",
      documentation: {
        info: {
          title: "SourceManager API",
          version: "1.0.0",
          description:
            "Secure HTTP API for managing Git operations and process lifecycle on a Windows dev server.",
        },
        tags: [
          { name: "Health", description: "API health" },
          { name: "Projects", description: "Project listing and status" },
          { name: "Update", description: "Git update workflow" },
          { name: "Lifecycle", description: "Process start/stop/restart" },
        ],
      },
    })
  )

  // Request logging (all routes)
  .use(requestLoggerMiddleware)

  // Unauthenticated routes
  .use(healthRoute)

  // Authenticated routes — guard applied via onBeforeHandle scoped to /v1
  .group("/v1", (app) =>
    app
      .onBeforeHandle(({ headers, set }) => {
        try {
          requireToken(headers as Record<string, string | undefined>)
        } catch {
          set.status = 401
          return { error: "Unauthorized: missing or invalid X-DevServer-Token" }
        }
      })
      .use(projectsRoute)
      .use(projectRoute)
      .use(updateRoute)
      .use(lifecycleRoute)
      .use(logsRoute)
  )

  // Error handling
  .onError(({ error, set }) => {
    if (error instanceof ProjectNotFoundError) {
      set.status = 404
      return { error: error.message }
    }
    if (error.message === "UNAUTHORIZED") {
      set.status = 401
      return { error: "Unauthorized: missing or invalid X-DevServer-Token" }
    }
    console.error("[SourceManager] Unhandled error:", error)
    set.status = 500
    return { error: "Internal server error" }
  })

  .listen(config.server.port)

console.log(`
╔══════════════════════════════════════════════════╗
║          SourceManager API — Running             ║
╠══════════════════════════════════════════════════╣
║  Port:    ${String(config.server.port).padEnd(38)}║
║  Projects: ${String(config.projects.length).padEnd(37)}║
║  Swagger: http://localhost:${config.server.port}/swagger${" ".repeat(Math.max(0, 18 - String(config.server.port).length))}║
╚══════════════════════════════════════════════════╝
`)
