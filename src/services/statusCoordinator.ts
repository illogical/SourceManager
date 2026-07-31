import { getAllServices, getConfig } from "../config"
import type { ObservedServiceStatus, ServiceConfig, StatusObservationSource } from "../types"
import { processManager } from "./processManager"
import {
  checkTailscaleService,
  readMachineStatus,
  readServeConfig,
  tailscaleExecutor,
  type TailscaleMachineStatus,
  type TailscaleServiceCheck,
} from "./tailscale"

export interface PublicTailscaleStatus {
  machine: {
    state: TailscaleMachineStatus["state"]
    backendState: string | null
    tailnetDomain: string | null
    tags: string[]
    error: string | null
  }
  services: TailscaleServiceCheck[]
}

export interface ServiceRefreshResult {
  repoId: string
  serviceId: string
  status: ObservedServiceStatus
  error: string | null
  durationMs: number
}

export interface StatusRefreshResult {
  checkedAt: string
  durationMs: number
  services: ServiceRefreshResult[]
  tailscale: PublicTailscaleStatus
}

const UNKNOWN_TAILSCALE: PublicTailscaleStatus = {
  machine: {
    state: "unavailable",
    backendState: null,
    tailnetDomain: null,
    tags: [],
    error: "Tailscale status has not been checked yet",
  },
  services: [],
}

export class StatusCoordinator {
  private readonly inFlightByService = new Map<string, Promise<ServiceRefreshResult>>()
  private allInFlight: Promise<StatusRefreshResult> | null = null
  private cachedTailscale: PublicTailscaleStatus = UNKNOWN_TAILSCALE
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly concurrency = 4) {}

  getTailscaleStatus(): PublicTailscaleStatus {
    return this.cachedTailscale
  }

  refreshService(
    repoId: string,
    service: ServiceConfig,
    source: StatusObservationSource = "manual_service",
  ): Promise<ServiceRefreshResult> {
    const existing = this.inFlightByService.get(service.id)
    if (existing) return existing
    const operation = this.observeOne(repoId, service, source)
      .finally(() => this.inFlightByService.delete(service.id))
    this.inFlightByService.set(service.id, operation)
    return operation
  }

  refreshAll(source: StatusObservationSource = "manual_global"): Promise<StatusRefreshResult> {
    if (this.allInFlight) return this.allInFlight
    const operation = this.performRefreshAll(source).finally(() => {
      if (this.allInFlight === operation) this.allInFlight = null
    })
    this.allInFlight = operation
    return operation
  }

  startScheduledMonitoring(intervalMs = 10_000): void {
    if (this.timer) return
    void this.refreshAll("startup").catch((error) => {
      console.warn(`[StatusCoordinator] Initial observation failed: ${safeError(error)}`)
    })
    this.timer = setInterval(() => {
      void this.refreshAll("scheduled").catch((error) => {
        console.warn(`[StatusCoordinator] Scheduled observation failed: ${safeError(error)}`)
      })
    }, intervalMs)
    this.timer.unref?.()
  }

  stopScheduledMonitoring(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private async performRefreshAll(source: StatusObservationSource): Promise<StatusRefreshResult> {
    const startedAt = Date.now()
    const configured = getAllServices()
    const services = await runBounded(configured, this.concurrency, ({ repo, service }) =>
      this.refreshService(repo.id, service, source))
    this.cachedTailscale = await this.refreshTailscale(configured.map(({ service }) => service))
    return {
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      services,
      tailscale: this.cachedTailscale,
    }
  }

  async refreshTailscale(services = getAllServices().map(({ service }) => service)): Promise<PublicTailscaleStatus> {
    const machine = await readMachineStatus(tailscaleExecutor)
    let serveConfig: Awaited<ReturnType<typeof readServeConfig>> = { services: {} }
    let serveConfigAvailable = machine.state !== "unavailable"
    if (serveConfigAvailable) {
      try {
        serveConfig = await readServeConfig(tailscaleExecutor)
      } catch (error) {
        machine.error = safeError(error)
        serveConfigAvailable = false
      }
    }
    const checks = services.map((service) => {
      const observed = this.getObservation(service)
      return checkTailscaleService(
        service,
        observed.availability.state === "healthy",
        machine,
        serveConfig,
        serveConfigAvailable,
      )
    })
    this.cachedTailscale = {
      machine: {
        state: machine.state,
        backendState: machine.backendState,
        tailnetDomain: machine.tailnetDomain,
        tags: machine.tags,
        error: machine.error,
      },
      services: checks,
    }
    return this.cachedTailscale
  }

  private async observeOne(
    repoId: string,
    service: ServiceConfig,
    source: StatusObservationSource,
  ): Promise<ServiceRefreshResult> {
    const startedAt = Date.now()
    try {
      const status = service.port === getConfig().server.port
        ? selfObservation()
        : await processManager.observe(service, source, repoId)
      return { repoId, serviceId: service.id, status, error: null, durationMs: Date.now() - startedAt }
    } catch (error) {
      const message = safeError(error)
      const status: ObservedServiceStatus = {
        availability: { state: "unknown" },
        management: { state: service.port === getConfig().server.port ? "not_applicable" : "unmanaged" },
        checkedAt: new Date().toISOString(),
        healthDurationMs: null,
        healthError: message,
        listenerPid: null,
        runnerPid: null,
        runnerHeartbeatAt: null,
        diagnosticCode: "SERVICE_STATUS_CHECK_FAILED",
        message: `Status check failed: ${message}`,
      }
      return { repoId, serviceId: service.id, status, error: message, durationMs: Date.now() - startedAt }
    }
  }

  getObservation(service: ServiceConfig): ObservedServiceStatus {
    if (service.port === getConfig().server.port) return selfObservation()
    return processManager.getObservedStatus(service.id) ?? unknownObservation()
  }
}

export const statusCoordinator = new StatusCoordinator()

function selfObservation(): ObservedServiceStatus {
  return {
    availability: { state: "healthy" },
    management: { state: "not_applicable" },
    checkedAt: new Date().toISOString(),
    healthDurationMs: 0,
    healthError: null,
    listenerPid: process.pid,
    runnerPid: process.pid,
    runnerHeartbeatAt: null,
    diagnosticCode: null,
    message: null,
  }
}

export function unknownObservation(): ObservedServiceStatus {
  return {
    availability: { state: "unknown" },
    management: { state: "unmanaged" },
    checkedAt: new Date(0).toISOString(),
    healthDurationMs: null,
    healthError: null,
    listenerPid: null,
    runnerPid: null,
    runnerHeartbeatAt: null,
    diagnosticCode: null,
    message: "Status has not been checked yet",
  }
}

async function runBounded<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  const worker = async () => {
    while (next < values.length) {
      const index = next++
      results[index] = await operation(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return results
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}
