import Elysia, { NotFoundError } from "elysia"
import { swagger } from "@elysiajs/swagger"
import { staticPlugin } from "@elysiajs/static"
import { loadConfig } from "./config"
import { getService } from "./config"
import { requestLoggerMiddleware } from "./middleware/requestLogger"
import { healthRoute } from "./routes/health"
import { reposRoute } from "./routes/repos"
import { updateRoute } from "./routes/update"
import { configRoute } from "./routes/config"
import { tailscaleRoute } from "./routes/tailscale"
import { processManager } from "./services/processManager"
import { rotateOldLogs } from "./services/runLogger"
import { RepoNotFoundError, ServiceNotFoundError } from "./config"
import { validateToken } from "./middleware/auth"
import { checkHealth } from "./services/healthCheck"
import {
  prepareTailscaleForStop,
  restoreTailscaleWhenReady,
  getNamedServiceConfig,
  tailscaleExecutor,
} from "./services/tailscale"

// ── Startup ────────────────────────────────────────────────────────────────

const config = loadConfig()

// Ensure data directory exists
await Bun.write("data/logs/.keep", "")

// Init process manager (restore state, prune stale PIDs)
await processManager.init()

processManager._onUnexpectedExit = async (serviceId) => {
  const found = getService(serviceId)
  if (found) await prepareTailscaleForStop(found.service, tailscaleExecutor)
}

// Reconcile without blocking API startup. Healthy desired-on services are
// restored; stopped services are left drained.
for (const repo of config.repos) {
  for (const service of repo.services) {
    void checkHealth(service).then(async (health) => {
      const named = getNamedServiceConfig(service)
      if (health.status === "pass" && named?.desiredEnabled) {
        await restoreTailscaleWhenReady(service, async () => true, tailscaleExecutor, 1, 0)
      } else if (health.status === "fail") {
        await prepareTailscaleForStop(service, tailscaleExecutor)
      }
    }).catch((err) => {
      console.warn(`[Tailscale] Startup reconciliation failed for "${service.id}": ${(err as Error).message}`)
    })
  }
}

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
          { name: "Tailscale", description: "Named Tailnet Service status and controls" },
        ],
      },
    })
  )

  // Request logging (all routes)
  .use(requestLoggerMiddleware)

  // ── Static frontend (production) ───────────────────────────────────────────
  // Serves frontend/dist/ at /. API routes (/v1/*, /health, /swagger) take
  // precedence because they are registered before the catch-all below.
  // Only mounted when the build output exists (graceful no-op otherwise).
  .use(
    staticPlugin({
      assets: "frontend/dist",
      prefix: "/",
      indexHTML: true,
    })
  )

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
      .use(reposRoute)
      .use(updateRoute)
      .use(configRoute)
      .use(tailscaleRoute)
  )

  // Error handling
  .onError(({ error, set }) => {
    if (error instanceof RepoNotFoundError || error instanceof ServiceNotFoundError) {
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
  Repos:    ${String(config.repos.length).padEnd(38)}
  Swagger: http://localhost:${config.server.port}/swagger${" ".repeat(Math.max(0, 18 - String(config.server.port).length))}
  Started: ${new Date().toLocaleString().padEnd(38)}

`)
