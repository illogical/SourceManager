import Elysia, { t } from "elysia"
import { getConfig, requireRepo, requireService } from "../config"
import { processManager } from "../services/processManager"
import { checkHealth } from "../services/healthCheck"
import { readRecentLogs } from "../services/runLogger"
import { readServiceOutput, streamServiceOutput } from "../services/serviceOutput"
import { getApplicationLifecycleState, requestSourceManagerShutdown } from "../services/applicationLifecycle"
import {
  prepareTailscaleForStop,
  restoreTailscaleWhenReady,
  tailscaleExecutor,
} from "../services/tailscale"
import type { LifecycleState, ServiceConfig } from "../types"

interface ServiceLifecycle {
  state: LifecycleState
  pid: number | null
  startedAt: string | null
  readySince: string | null
  uptimeMs: number | null
  command: string | null
  lastError: string | null
  diagnosticCode: string | null
  intendedState: "running" | "stopped"
  recoveryAttempt: number | null
  recoveryReason: string | null
}

async function buildLifecycle(service: ServiceConfig): Promise<ServiceLifecycle> {
  if (service.port === getConfig().server.port) {
    const shuttingDown = getApplicationLifecycleState() === "shutting_down"
    return {
      state: shuttingDown ? "stopping" : "running",
      pid: process.pid,
      startedAt: null,
      readySince: null,
      uptimeMs: null,
      command: "SourceManager",
      lastError: null,
      diagnosticCode: null,
      intendedState: "running",
      recoveryAttempt: null,
      recoveryReason: null,
    }
  }
  const state = await processManager.observe(service)
  if (!state) {
    const health = await checkHealth(service)
    return {
      state: health.status === "pass" ? "failed" : "stopped",
      pid: null,
      startedAt: null,
      readySince: health.status === "pass" ? new Date().toISOString() : null,
      uptimeMs: null,
      command: null,
      lastError: health.status === "pass"
        ? "A healthy listener exists, but SourceManager cannot verify that it owns the process"
        : null,
      diagnosticCode: health.status === "pass" ? "SERVICE_PROCESS_OWNERSHIP_CONFLICT" : null,
      intendedState: "stopped",
      recoveryAttempt: null,
      recoveryReason: null,
    }
  }
  const uptimeMs = state.lifecycleState === "running" && state.readySince
    ? Date.now() - new Date(state.readySince).getTime()
    : null
  return {
    state: state.lifecycleState,
    pid: state.pid,
    startedAt: state.startedAt,
    readySince: state.readySince ?? null,
    uptimeMs,
    command: state.command,
    lastError: state.lastError ?? null,
    diagnosticCode: state.diagnosticCode ?? null,
    intendedState: state.intendedState ?? (state.lifecycleState === "running" ? "running" : "stopped"),
    recoveryAttempt: state.recoveryAttempt ?? null,
    recoveryReason: state.recoveryReason ?? null,
  }
}

function buildServiceSummary(service: ServiceConfig, lifecycle: ServiceLifecycle) {
  return {
    id: service.id,
    displayName: service.displayName,
    packageManager: service.packageManager,
    scriptName: service.scriptName,
    port: service.port,
    healthUrl: service.healthUrl,
    healthMode: service.healthMode,
    tags: service.tags,
    allowedIps: service.allowedIps,
    lifecycle,
    tailnet: buildTailnet(service),
  }
}

function buildTailnet(service: ServiceConfig) {
  if (!service.tailnetHostname && !service.tailscaleServiceName) return null
  return {
    hostname: service.tailnetHostname ?? service.tailscaleServiceName ?? "",
    domain: service.tailnetDomain ?? null,
    serveEnabled: service.tailscaleServeEnabled ?? false,
    serveMode: service.tailscaleServeMode ?? null,
    serveTarget: service.tailscaleServeTarget ?? null,
    exposureMode: service.tailnetExposureMode ?? (
      service.tailnetHostname && service.tailscaleServeTarget ? "tailscale-service" : null
    ),
    serviceName: service.tailscaleServiceName ?? service.tailnetHostname ?? null,
    serviceEnabled: service.tailscaleServiceEnabled ?? service.tailscaleServeEnabled ?? false,
    servicePort: service.tailscaleServicePort ?? 443,
    serviceTarget: service.tailscaleServiceTarget ?? service.tailscaleServeTarget ?? null,
  }
}

export const reposRoute = new Elysia({ prefix: "/repos" })
  // GET /repos
  .get(
    "/",
    async () => {
      const config = getConfig()
      const repos = await Promise.all(config.repos.map(async (repo) => ({
        id: repo.id,
        displayName: repo.displayName,
        repoPath: repo.repoPath,
        defaultBranch: repo.defaultBranch,
        services: await Promise.all(repo.services.map(async (service) => (
          buildServiceSummary(service, await buildLifecycle(service))
        ))),
      })))
      return { repos }
    },
    { detail: { summary: "List all repos and services", tags: ["Repos"] } }
  )

  // GET /repos/:repoId
  .get(
    "/:repoId",
    async ({ params }) => {
      const repo = requireRepo(params.repoId)
      return {
        id: repo.id,
        displayName: repo.displayName,
        repoPath: repo.repoPath,
        defaultBranch: repo.defaultBranch,
        services: await Promise.all(repo.services.map(async (service) => (
          buildServiceSummary(service, await buildLifecycle(service))
        ))),
      }
    },
    {
      params: t.Object({ repoId: t.String() }),
      detail: { summary: "Get a repo by ID", tags: ["Repos"] },
    }
  )

  // GET /repos/:repoId/services/:serviceId
  .get(
    "/:repoId/services/:serviceId",
    async ({ params }) => {
      const repo = requireRepo(params.repoId)
      const { service } = requireService(params.serviceId)
      // Also validate serviceId belongs to this repo
      if (service.id !== params.serviceId || !repo.services.some((s) => s.id === params.serviceId)) {
        throw new Error(`Service "${params.serviceId}" not found in repo "${params.repoId}"`)
      }
      return buildServiceSummary(service, await buildLifecycle(service))
    },
    {
      params: t.Object({ repoId: t.String(), serviceId: t.String() }),
      detail: { summary: "Get a service by ID", tags: ["Repos"] },
    }
  )

  // GET /repos/:repoId/services/:serviceId/logs
  .get(
    "/:repoId/services/:serviceId/logs",
    async ({ params, query }) => {
      requireRepo(params.repoId)
      const { service } = requireService(params.serviceId)
      const n = Math.min(Math.max(1, query.n ?? 20), 100)
      const logs = await readRecentLogs(service.id, n)
      return { serviceId: service.id, count: logs.length, logs: logs.reverse() }
    },
    {
      params: t.Object({ repoId: t.String(), serviceId: t.String() }),
      query: t.Object({ n: t.Optional(t.Numeric()) }),
      detail: { summary: "Get recent run logs for a service", tags: ["Repos"] },
    }
  )

  // POST /repos/:repoId/services/:serviceId/start
  .get(
    "/:repoId/services/:serviceId/output",
    async ({ params, query, set }) => {
      const repo = requireRepo(params.repoId)
      const { service } = requireService(params.serviceId)
      if (!repo.services.some((candidate) => candidate.id === service.id)) throw new Error("Service does not belong to repository")
      const output = processManager.getOutput(service.id)
      if (!output) {
        set.status = 404
        return { error: "No managed output is available for this service" }
      }
      return readServiceOutput(
        output.runId,
        output.logDirectory,
        query.cursor ?? "",
        query.limit ?? 64 * 1024,
      )
    },
    {
      params: t.Object({ repoId: t.String(), serviceId: t.String() }),
      query: t.Object({ cursor: t.Optional(t.String()), limit: t.Optional(t.Numeric()) }),
      detail: { summary: "Read durable combined service output", tags: ["Lifecycle"] },
    },
  )

  .get(
    "/:repoId/services/:serviceId/output/stream",
    ({ params, query, set }) => {
      const repo = requireRepo(params.repoId)
      const { service } = requireService(params.serviceId)
      if (!repo.services.some((candidate) => candidate.id === service.id)) throw new Error("Service does not belong to repository")
      const output = processManager.getOutput(service.id)
      if (!output) {
        set.status = 404
        return { error: "No managed output is available for this service" }
      }
      return streamServiceOutput(output.runId, output.logDirectory, query.cursor ?? "")
    },
    {
      params: t.Object({ repoId: t.String(), serviceId: t.String() }),
      query: t.Object({ cursor: t.Optional(t.String()) }),
      detail: { summary: "Stream durable combined service output with SSE", tags: ["Lifecycle"] },
    },
  )

  // POST /repos/:repoId/services/:serviceId/start
  .post(
    "/:repoId/services/:serviceId/start",
    async ({ params, set }) => {
      const repo = requireRepo(params.repoId)
      const { service } = requireService(params.serviceId)
      if (service.port === getConfig().server.port) {
        return {
          serviceId: service.id,
          repoId: repo.id,
          success: true,
          message: "SourceManager is already running",
          diagnostics: null,
          portKillResult: null,
          lifecycle: await buildLifecycle(service),
        }
      }
      const result = await processManager.start(repo, service)
      if (result.success) {
        void restoreTailscaleWhenReady(
          service,
          async () => (await checkHealth(service)).status === "pass",
          tailscaleExecutor,
        )
      }
      if (!result.success) {
        set.status = result.diagnostics?.code === "SERVICE_PROCESS_OWNERSHIP_CONFLICT" ? 409 : 500
      }
      return {
        serviceId: service.id,
        repoId: repo.id,
        success: result.success,
        message: result.message,
        diagnostics: result.diagnostics ?? null,
        portKillResult: result.portKillResult ?? null,
        lifecycle: await buildLifecycle(service),
      }
    },
    {
      params: t.Object({ repoId: t.String(), serviceId: t.String() }),
      detail: { summary: "Start a service", tags: ["Lifecycle"] },
    }
  )

  // POST /repos/:repoId/services/:serviceId/stop
  .post(
    "/:repoId/services/:serviceId/stop",
    async ({ params, set }) => {
      const repo = requireRepo(params.repoId)
      const { service } = requireService(params.serviceId)
      if (service.port === getConfig().server.port) {
        void requestSourceManagerShutdown()
        set.status = 202
        return {
          serviceId: service.id,
          repoId: repo.id,
          success: true,
          alreadyStopped: false,
          message: "SourceManager is shutting down; managed services and Tailnet advertisements will remain running",
          diagnostics: null,
          tailnetPreparation: { success: true, warning: null },
          lifecycle: { ...await buildLifecycle(service), state: "stopping" as const },
        }
      }
      const tailnetPreparation = await prepareTailscaleForStop(service, tailscaleExecutor)
      const result = await processManager.stop(service, repo)
      if (!result.success) {
        set.status = result.diagnostics?.code === "SERVICE_PROCESS_OWNERSHIP_CONFLICT" ? 409 : 500
      }
      return {
        serviceId: service.id,
        repoId: repo.id,
        success: result.success,
        alreadyStopped: result.alreadyStopped,
        message: result.message,
        diagnostics: result.diagnostics ?? null,
        tailnetPreparation,
        lifecycle: await buildLifecycle(service),
      }
    },
    {
      params: t.Object({ repoId: t.String(), serviceId: t.String() }),
      detail: { summary: "Stop a service (idempotent)", tags: ["Lifecycle"] },
    }
  )

  // POST /repos/:repoId/services/:serviceId/restart
  .post(
    "/:repoId/services/:serviceId/restart",
    async ({ params, set }) => {
      const repo = requireRepo(params.repoId)
      const { service } = requireService(params.serviceId)
      if (service.port === getConfig().server.port) {
        set.status = 409
        return {
          serviceId: service.id,
          repoId: repo.id,
          success: false,
          message: "SourceManager cannot restart itself in place; stop it, then use the Windows task or terminal launcher to start it again",
          diagnostics: null,
          portKillResult: null,
          tailnetPreparation: { success: true, warning: null },
          lifecycle: await buildLifecycle(service),
        }
      }
      const tailnetPreparation = await prepareTailscaleForStop(service, tailscaleExecutor)
      const result = await processManager.restart(repo, service)
      if (result.success) {
        void restoreTailscaleWhenReady(
          service,
          async () => (await checkHealth(service)).status === "pass",
          tailscaleExecutor,
        )
      }
      if (!result.success) set.status = 500
      return {
        serviceId: service.id,
        repoId: repo.id,
        success: result.success,
        message: result.message,
        diagnostics: result.diagnostics ?? null,
        portKillResult: result.portKillResult ?? null,
        tailnetPreparation,
        lifecycle: await buildLifecycle(service),
      }
    },
    {
      params: t.Object({ repoId: t.String(), serviceId: t.String() }),
      detail: { summary: "Restart a service", tags: ["Lifecycle"] },
    }
  )
