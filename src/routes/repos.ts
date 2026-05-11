import Elysia, { t } from "elysia"
import { getConfig, requireRepo, requireService } from "../config"
import { processManager } from "../services/processManager"
import { checkHealth } from "../services/healthCheck"
import { readRecentLogs } from "../services/runLogger"
import type { LifecycleState, ServiceConfig } from "../types"

interface ServiceLifecycle {
  state: LifecycleState
  pid: number | null
  startedAt: string | null
  readySince: string | null
  uptimeMs: number | null
  command: string | null
  lastError: string | null
}

async function buildLifecycle(service: ServiceConfig): Promise<ServiceLifecycle> {
  const state = processManager.getProcess(service.id)
  if (!state) {
    const health = await checkHealth(service)
    return {
      state: health.status === "pass" ? "running" : "stopped",
      pid: null,
      startedAt: null,
      readySince: health.status === "pass" ? new Date().toISOString() : null,
      uptimeMs: null,
      command: null,
      lastError: null,
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
  if (!service.tailnetHostname) return null
  return {
    hostname: service.tailnetHostname,
    domain: service.tailnetDomain ?? null,
    serveEnabled: service.tailscaleServeEnabled ?? false,
    serveMode: service.tailscaleServeMode ?? null,
    serveTarget: service.tailscaleServeTarget ?? null,
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
  .post(
    "/:repoId/services/:serviceId/start",
    async ({ params }) => {
      const repo = requireRepo(params.repoId)
      const { service } = requireService(params.serviceId)
      const result = await processManager.start(repo, service)
      return {
        serviceId: service.id,
        repoId: repo.id,
        success: result.success,
        message: result.message,
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
    async ({ params }) => {
      requireRepo(params.repoId)
      const { service } = requireService(params.serviceId)
      const result = await processManager.stop(service.id)
      return {
        serviceId: service.id,
        success: result.success,
        alreadyStopped: result.alreadyStopped,
        message: result.message,
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
    async ({ params }) => {
      const repo = requireRepo(params.repoId)
      const { service } = requireService(params.serviceId)
      const result = await processManager.restart(repo, service)
      return {
        serviceId: service.id,
        repoId: repo.id,
        success: result.success,
        message: result.message,
        portKillResult: result.portKillResult ?? null,
        lifecycle: await buildLifecycle(service),
      }
    },
    {
      params: t.Object({ repoId: t.String(), serviceId: t.String() }),
      detail: { summary: "Restart a service", tags: ["Lifecycle"] },
    }
  )
