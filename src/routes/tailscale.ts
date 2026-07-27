import Elysia, { t } from "elysia"
import { getAllServices, requireService } from "../config"
import { checkHealth } from "../services/healthCheck"
import { processManager } from "../services/processManager"
import { setTailscaleServiceEnabled } from "../services/configEditor"
import {
  checkTailscaleService,
  disableTailscaleService,
  enableTailscaleService,
  getNamedServiceConfig,
  readMachineStatus,
  readServeConfig,
  tailscaleExecutor,
  TailscaleCommandError,
  TailscaleUnavailableError,
  type TailscaleExecutor,
} from "../services/tailscale"
import type { ServiceConfig } from "../types"

async function isLocalServiceRunning(service: ServiceConfig): Promise<boolean> {
  const process = processManager.getProcess(service.id)
  if (process) return process.lifecycleState === "running"
  return (await checkHealth(service)).status === "pass"
}

export function createTailscaleRoute(executor: TailscaleExecutor = tailscaleExecutor) {
  return new Elysia({ prefix: "/tailscale" })
    .get(
      "/status",
      async () => {
        const machine = await readMachineStatus(executor)
        let serveConfig: Awaited<ReturnType<typeof readServeConfig>> = { services: {} }
        if (machine.state !== "unavailable") {
          try {
            serveConfig = await readServeConfig(executor)
          } catch (err) {
            machine.state = "unavailable"
            machine.error = err instanceof Error ? err.message : String(err)
          }
        }

        const configured = getAllServices()
        const running = await Promise.all(configured.map(({ service }) => isLocalServiceRunning(service)))
        return {
          machine: {
            state: machine.state,
            backendState: machine.backendState,
            tailnetDomain: machine.tailnetDomain,
            tags: machine.tags,
            error: machine.error,
          },
          services: configured.map(({ service }, index) =>
            checkTailscaleService(service, running[index], machine, serveConfig)
          ),
        }
      },
      { detail: { summary: "Get Tailscale host and named-Service status", tags: ["Tailscale"] } },
    )
    .post(
      "/services/:serviceId/service/enable",
      async ({ params, set }) => {
        const { service } = requireService(params.serviceId)
        if (!getNamedServiceConfig(service)) {
          set.status = 422
          return { error: "Service is missing named Tailscale Service configuration" }
        }
        if (!await isLocalServiceRunning(service)) {
          set.status = 409
          return { error: "Start the local service before enabling Tailnet exposure" }
        }

        try {
          setTailscaleServiceEnabled(service.id, true)
          await enableTailscaleService(service, executor)
          return { success: true, serviceId: service.id, desiredEnabled: true }
        } catch (err) {
          return tailscaleActionError(err, set)
        }
      },
      {
        params: t.Object({ serviceId: t.String() }),
        detail: { summary: "Enable a named Tailscale Service", tags: ["Tailscale"] },
      },
    )
    .post(
      "/services/:serviceId/service/disable",
      async ({ params, set }) => {
        const { service } = requireService(params.serviceId)
        if (!getNamedServiceConfig(service)) {
          set.status = 422
          return { error: "Service is missing named Tailscale Service configuration" }
        }
        if (!await isLocalServiceRunning(service)) {
          set.status = 409
          return { error: "Start the local service before changing Tailnet exposure" }
        }

        try {
          setTailscaleServiceEnabled(service.id, false)
          await disableTailscaleService(service, executor)
          return { success: true, serviceId: service.id, desiredEnabled: false }
        } catch (err) {
          return tailscaleActionError(err, set)
        }
      },
      {
        params: t.Object({ serviceId: t.String() }),
        detail: { summary: "Disable a named Tailscale Service", tags: ["Tailscale"] },
      },
    )
}

function tailscaleActionError(err: unknown, set: { status?: number | string }) {
  if (err instanceof TailscaleUnavailableError) {
    set.status = 503
    return { error: err.message }
  }
  if (err instanceof TailscaleCommandError) {
    set.status = 500
    return { error: err.message }
  }
  set.status = 500
  return { error: err instanceof Error ? err.message : String(err) }
}

export const tailscaleRoute = createTailscaleRoute()
