import Elysia, { NotFoundError } from "elysia"
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
import { validateToken } from "./middleware/auth"

// ── Startup ────────────────────────────────────────────────────────────────

const config = loadConfig()

// Ensure data directory exists
await Bun.write("data/logs/.keep", "")

// Init process manager (restore state, prune stale PIDs)
await processManager.init()

// Rotate old logs (keep 7 days)
await rotateOldLogs()

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

  // Favicon (SVG, served as image/svg+xml — accepted by all modern browsers)
  .get("/favicon.ico", () =>
    new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
        <rect width="32" height="32" rx="7" fill="#0f172a"/>
        <circle cx="11" cy="8"  r="3" fill="#38bdf8"/>
        <circle cx="11" cy="24" r="3" fill="#38bdf8"/>
        <circle cx="22" cy="16" r="3" fill="#818cf8"/>
        <line x1="11" y1="11" x2="11" y2="21" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/>
        <path d="M11 11.5 Q11 16 22 16" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round"/>
      </svg>`,
      { headers: { "content-type": "image/svg+xml" } }
    )
  )

  // Unauthenticated routes
  .use(healthRoute)

  // Authenticated routes — guard applied via onBeforeHandle scoped to /v1
  .group("/v1", (app) =>
    app
      .onBeforeHandle(({ headers, set }) => {
        if (!validateToken(headers as Record<string, string | undefined>)) {
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
    if (error instanceof NotFoundError) {
      set.status = 404
      return { error: "Not found" }
    }
    console.error("[SourceManager] Unhandled error:", error)
    set.status = 500
    return { error: "Internal server error" }
  })

  .listen(config.server.port)

console.log(`
╔══════════════════════════════════════════════════╗
║          SourceManager API — Running             ║
╚══════════════════════════════════════════════════╝
  Port:    ${String(config.server.port).padEnd(38)}
  Projects: ${String(config.projects.length).padEnd(37)}
  Swagger: http://localhost:${config.server.port}/swagger${" ".repeat(Math.max(0, 18 - String(config.server.port).length))}
  Started: ${new Date().toLocaleString().padEnd(38)}

`)
