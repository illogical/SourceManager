import express, { type ErrorRequestHandler } from "express"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { AppConfig } from "./types"
import { authMiddleware, isIpAllowed } from "./middleware/auth"
import { HostedProjectRegistry } from "./host/registry"
import { diffConfig, readProjectsFile, validateProjectsFile, writeProjectsFile } from "./services/configV2"
import { previewV1Conversion } from "./config"
import { getGlobalTailscaleStatus, setGlobalTailscaleEnabled } from "./services/tailscaleGlobal"
import { logRequest } from "./services/requestLogger"
import { readProjectEvents, recordProjectEvent } from "./services/projectEvents"

export interface SourceManagerHost {
  app: express.Express
  server: Server
  registry: HostedProjectRegistry
  initialize(): Promise<void>
  listen(): Promise<AddressInfo>
  close(): Promise<void>
}

export function createSourceManagerHost(config: AppConfig): SourceManagerHost {
  const app = express()
  const server = createServer(app)
  const registry = new HostedProjectRegistry(config)
  let initialized = false

  app.disable("x-powered-by")
  app.set("case sensitive routing", true)
  app.use(express.json({ limit: "1mb" }))
  app.use((request, response, next) => {
    const startedAt = Date.now()
    response.on("finish", () => void logRequest({ timestamp: new Date().toISOString(), method: request.method, url: request.originalUrl, body: request.body, status: response.statusCode, durationMs: Date.now() - startedAt, ip: request.ip ?? "unknown" }).catch(() => undefined))
    next()
  })
  app.use((request, response, next) => {
    if (!isIpAllowed(request.ip ?? "", config.server.allowedIps)) return response.status(403).json({ error: "Client IP is not allowed" })
    next()
  })

  app.get("/health", (_request, response) => response.json({ status: initialized ? "ready" : "loading", uptime: process.uptime(), node: process.version }))

  const management = express.Router()
  management.use(authMiddleware(config))
  management.get("/projects", async (_request, response, next) => {
    try { response.json({ projects: await registry.refreshStatuses() }) } catch (error) { next(error) }
  })
  management.get("/events", async (request, response, next) => {
    try { response.json({ events: await readProjectEvents(Number(request.query.limit) || 100) }) } catch (error) { next(error) }
  })
  management.get("/config", async (_request, response, next) => {
    try { response.json({ config: await readProjectsFile(), runtime: { port: config.server.port, workspacePath: config.workspacePath, tokenConfigured: true } }) } catch (error) { next(error) }
  })
  management.post("/config/validate", async (request, response, next) => {
    try {
      const current = await readProjectsFile()
      response.json({ validation: validateProjectsFile(request.body), diff: diffConfig(current, request.body) })
    } catch (error) { next(error) }
  })
  management.put("/config", async (request, response, next) => {
    try {
      const current = await readProjectsFile()
      const proposed = await writeProjectsFile(request.body)
      const diff = diffConfig(current, proposed)
      await recordProjectEvent({ projectId: "sourcemanager", kind: "config", state: "saved", message: `${diff.changeCount} configuration changes saved; restart required` })
      response.json({ success: true, changeCount: diff.changeCount, restartRequired: true })
    } catch (error) { next(error) }
  })
  management.post("/config/preview-v1", (request, response, next) => {
    try { response.json(previewV1Conversion(request.body)) } catch (error) { next(error) }
  })
  management.get("/tailnet", async (_request, response) => response.json(await getGlobalTailscaleStatus(config.tailnet)))
  management.post("/tailnet/:action", async (request, response, next) => {
    try {
      const enabled = request.params.action === "enable"
      if (!enabled && request.params.action !== "disable") return response.status(404).json({ error: "Not found" })
      await setGlobalTailscaleEnabled(config.tailnet, enabled)
      const persisted = await readProjectsFile()
      persisted.tailnet.enabled = enabled
      await writeProjectsFile(persisted)
      config.tailnet.enabled = enabled
      await recordProjectEvent({ projectId: "sourcemanager", kind: "tailnet", state: enabled ? "enabled" : "disabled", message: `${config.tailnet.serviceName} advertisement ${enabled ? "enabled" : "disabled"}` })
      response.json(await getGlobalTailscaleStatus({ ...config.tailnet, enabled }))
    } catch (error) { next(error) }
  })
  management.get("/openapi.json", (_request, response) => response.json(openApiDocument(config.server.port)))
  management.post("/restart", async (_request, response) => {
    const blockers = await registry.restartBlockers()
    if (blockers.length > 0) {
      response.status(409).json({ error: "Restart blocked by active work", blockers })
      return
    }
    response.status(202).json({ status: "accepted", exitCode: 75 })
    await recordProjectEvent({ projectId: "sourcemanager", kind: "host", state: "restart-requested", message: "Graceful host restart requested" })
    setTimeout(() => { process.exitCode = 75; void host.close() }, 50).unref()
  })
  app.use("/api/SourceManager", management)

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("[SourceManager] request failed", error)
    response.status(message.includes("config") || message.includes("route") || message.includes("project") ? 400 : 500).json({ error: message })
  }

  const host: SourceManagerHost = {
    app,
    server,
    registry,
    async initialize() {
      if (initialized) return
      await registry.loadAll(app, server)
      for (const project of config.projects) {
        if (project.compatibility?.lowercaseAlias) {
          if (project.web) app.use(project.web.mountPath.toLowerCase(), (request, response, next) => request.method === "GET" ? response.redirect(308, `${project.web!.mountPath}${request.url === "/" ? "" : request.url}`) : next())
          if (project.api) app.use(project.api.mountPath.toLowerCase(), (request, response, next) => request.method === "GET" ? response.redirect(308, `${project.api!.mountPath}${request.url === "/" ? "" : request.url}`) : next())
        }
      }
      const lmapi = config.projects.find((project) => project.id === "lmapi" && project.compatibility?.lmapiV1Alias)
      if (lmapi?.api) app.use("/v1", (request, response) => {
        const location = `${lmapi.api!.mountPath}/v1${request.url === "/" ? "" : request.url}`
        if (request.method === "GET" || request.method === "HEAD") return response.redirect(308, location)
        response.status(409).set("Location", location).json({ error: "Update the LMApi client base URL before retrying this request", location })
      })
      app.get("/", (_request, response) => response.redirect(308, "/SourceManager"))
      app.use("/api", (_request, response) => response.status(404).json({ error: "API route not found" }))
      app.use((_request, response) => response.status(404).json({ error: "Not found" }))
      app.use(errorHandler)
      initialized = true
      await recordProjectEvent({ projectId: "sourcemanager", kind: "host", state: "ready", message: "Unified host initialized" })
    },
    async listen() {
      await host.initialize()
      return await new Promise<AddressInfo>((resolve, reject) => {
        server.once("error", reject)
        server.listen(config.server.port, "127.0.0.1", () => resolve(server.address() as AddressInfo))
      })
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await registry.dispose()
    },
  }
  return host
}

function openApiDocument(port: number) {
  return {
    openapi: "3.1.0",
    info: { title: "SourceManager Unified Host API", version: "2.0.0" },
    servers: [{ url: `http://127.0.0.1:${port}/api/SourceManager` }],
    paths: {
      "/projects": { get: { summary: "List hosted project status", responses: { "200": { description: "Project status" } } } },
      "/config": { get: { summary: "Read v2 configuration", responses: { "200": { description: "Configuration" } } }, put: { summary: "Atomically save v2 configuration", responses: { "200": { description: "Saved" } } } },
      "/tailnet": { get: { summary: "Read global Tailnet status", responses: { "200": { description: "Tailnet status" } } } },
      "/restart": { post: { summary: "Request a graceful wrapper restart", responses: { "202": { description: "Accepted" } } } },
    },
  }
}
