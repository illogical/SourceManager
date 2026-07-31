import { existsSync } from "node:fs"
import type { LifecycleState, ServiceConfig } from "../types"

export type TailscaleOperation = "enabling" | "draining" | "disabling"
export type TailscaleServiceState =
  | "not_configured"
  | "unavailable"
  | "local_stopped"
  | "local_recovering"
  | "enabled_unverified"
  | "not_advertised"
  | "pending_approval"
  | "draining"
  | "connected"
  | "mismatch"
  | "error"

export interface TailscaleExecutor {
  execute(args: string[]): Promise<{ stdout: string; stderr: string }>
}

export interface NamedServiceConfig {
  serviceName: string
  desiredEnabled: boolean
  httpsPort: number
  target: string
  tailnetDomain: string | null
}

export interface TailscaleMachineStatus {
  state: "connected" | "degraded" | "unavailable"
  backendState: string | null
  tailnetDomain: string | null
  tags: string[]
  serviceHostCapability: unknown
  error: string | null
}

interface ServeServiceConfig {
  endpoints?: Record<string, string>
  advertised?: boolean
}

interface ServeConfig {
  services?: Record<string, ServeServiceConfig>
}

function isServeServiceAdvertised(service: ServeServiceConfig | undefined): boolean {
  // Tailscale omits the optional advertised field for the normal advertised
  // state. Only an explicit false means the Service is drained.
  return service !== undefined && service.advertised !== false
}

function serviceEndpointMatches(
  service: ServeServiceConfig | undefined,
  named: NamedServiceConfig,
): boolean {
  const target = service?.endpoints?.[`tcp:${named.httpsPort}`]
  return Boolean(target && normalizeTarget(target) === named.target)
}

export interface TailscaleServiceCheck {
  serviceId: string
  configured: boolean
  desiredEnabled: boolean
  serviceName: string | null
  expectedUrl: string | null
  localTarget: string | null
  httpsPort: number | null
  status: TailscaleServiceState
  lastError: string | null
  lastWarning: string | null
  operation: TailscaleOperation | null
  canToggle: boolean
}

export class TailscaleUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TailscaleUnavailableError"
  }
}

export class TailscaleCommandError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
  ) {
    super(message)
    this.name = "TailscaleCommandError"
  }
}

const operationByService = new Map<string, TailscaleOperation>()
const errorByService = new Map<string, string>()
const warningByService = new Map<string, string>()

export function getNamedServiceConfig(service: ServiceConfig): NamedServiceConfig | null {
  const serviceName = service.tailscaleServiceName ?? service.tailnetHostname
  const target = service.tailscaleServiceTarget ?? service.tailscaleServeTarget
  const namedMode = service.tailnetExposureMode === "tailscale-service" || Boolean(service.tailscaleServiceName)
  const legacyMode = Boolean(service.tailnetHostname && service.tailscaleServeTarget)
  if ((!namedMode && !legacyMode) || !serviceName || !target) return null

  return {
    serviceName: normalizeServiceName(serviceName),
    desiredEnabled: service.tailscaleServiceEnabled ?? service.tailscaleServeEnabled ?? false,
    httpsPort: service.tailscaleServicePort ?? 443,
    target: normalizeTarget(target),
    tailnetDomain: service.tailnetDomain ?? null,
  }
}

export function normalizeServiceName(name: string): string {
  const normalized = name.startsWith("svc:") ? name.slice(4) : name
  if (!/^[a-z0-9-]+$/.test(normalized)) {
    throw new Error(`Invalid Tailscale Service name "${name}"`)
  }
  return normalized
}

export function serviceNameToCliName(name: string): `svc:${string}` {
  return `svc:${normalizeServiceName(name)}`
}

export function normalizeTarget(target: string): string {
  const url = new URL(target)
  if (url.hostname === "localhost") url.hostname = "127.0.0.1"
  return url.toString().replace(/\/$/, "")
}

export function expectedServiceUrl(name: string, tailnetDomain: string | null): string | null {
  return tailnetDomain ? `https://${normalizeServiceName(name)}.${tailnetDomain}` : null
}

export function createTailscaleExecutor(timeoutMs = 8_000): TailscaleExecutor {
  return {
    async execute(args) {
      const binary = resolveTailscaleBinary()
      if (!binary) {
        throw new TailscaleUnavailableError("Tailscale CLI was not found")
      }

      const proc = Bun.spawn([binary, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      const timer = setTimeout(() => proc.kill(), timeoutMs)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        if (exitCode !== 0) {
          const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`
          if (/tailscaled|daemon|not running|connection refused|failed to connect/i.test(detail)) {
            throw new TailscaleUnavailableError(`Tailscale is unavailable: ${detail}`)
          }
          throw new TailscaleCommandError(`Tailscale command failed: ${detail}`, args)
        }
        return { stdout, stderr }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export const tailscaleExecutor = createTailscaleExecutor()

function resolveTailscaleBinary(): string | null {
  const fromPath = Bun.which("tailscale")
  if (fromPath) return fromPath
  const windowsFallback = "C:\\Program Files\\Tailscale\\tailscale.exe"
  return existsSync(windowsFallback) ? windowsFallback : null
}

export async function readMachineStatus(executor: TailscaleExecutor): Promise<TailscaleMachineStatus> {
  try {
    const { stdout } = await executor.execute(["status", "--json"])
    const parsed = JSON.parse(stdout) as {
      BackendState?: string
      CurrentTailnet?: { MagicDNSSuffix?: string }
      Self?: { Tags?: string[]; CapMap?: Record<string, unknown> }
    }
    const backendState = parsed.BackendState ?? null
    const tags = parsed.Self?.Tags ?? []
    const connected = backendState === "Running"
    const tagged = tags.includes("tag:dev-service-host")
    return {
      state: connected ? (tagged ? "connected" : "degraded") : "unavailable",
      backendState,
      tailnetDomain: parsed.CurrentTailnet?.MagicDNSSuffix ?? null,
      tags,
      serviceHostCapability: parsed.Self?.CapMap?.["service-host"] ?? null,
      error: connected ? null : `Tailscale backend state is ${backendState ?? "unknown"}`,
    }
  } catch (err) {
    return {
      state: "unavailable",
      backendState: null,
      tailnetDomain: null,
      tags: [],
      serviceHostCapability: null,
      error: safeError(err),
    }
  }
}

export async function readServeConfig(executor: TailscaleExecutor): Promise<ServeConfig> {
  const { stdout } = await executor.execute(["serve", "get-config", "--all"])
  if (!stdout.trim()) return { services: {} }
  const parsed = JSON.parse(stdout) as ServeConfig
  return { services: parsed.services ?? {} }
}

export function checkTailscaleService(
  service: ServiceConfig,
  localState: boolean | LifecycleState,
  machine: TailscaleMachineStatus,
  serveConfig: ServeConfig,
  serveConfigAvailable = true,
): TailscaleServiceCheck {
  const named = getNamedServiceConfig(service)
  const operation = operationByService.get(service.id) ?? null
  const lastError = errorByService.get(service.id) ?? null
  const lastWarning = warningByService.get(service.id) ?? null

  if (!named) {
    return {
      serviceId: service.id,
      configured: false,
      desiredEnabled: false,
      serviceName: null,
      expectedUrl: null,
      localTarget: null,
      httpsPort: null,
      status: "not_configured",
      lastError,
      lastWarning,
      operation,
      canToggle: false,
    }
  }

  const cliName = serviceNameToCliName(named.serviceName)
  const configured = serveConfig.services?.[cliName]
  const endpointTarget = configured?.endpoints?.[`tcp:${named.httpsPort}`]
  const targetMatches = serviceEndpointMatches(configured, named)
  let status: TailscaleServiceState

  const localRunning = localState === true || localState === "running"
  const localRecovering = localState === "recovering" || localState === "starting"

  if (operation === "draining") status = "draining"
  else if (localRecovering) status = "local_recovering"
  else if (!localRunning) status = "local_stopped"
  else if ((!serveConfigAvailable || machine.state === "unavailable") && named.desiredEnabled) status = "enabled_unverified"
  else if (machine.state === "unavailable") status = "unavailable"
  else if (!serveConfigAvailable) status = "unavailable"
  else if (!configured || !endpointTarget) status = "not_advertised"
  else if (!targetMatches) status = "mismatch"
  else if (!isServeServiceAdvertised(configured)) status = "not_advertised"
  else if (isPendingApproval(machine.serviceHostCapability, cliName)) status = "pending_approval"
  else status = "connected"

  const observedWarning = status === "connected" && !named.desiredEnabled
    ? "Tailnet is advertised but the saved desired state is off; turn it on to preserve exposure across restarts"
    : lastWarning
  const observedError = status === "connected" || status === "enabled_unverified" ? null : lastError
  const presentationWarning = status === "enabled_unverified"
    ? "Saved Tailnet intent is enabled, but live Serve state could not be verified"
    : observedWarning

  return {
    serviceId: service.id,
    configured: true,
    desiredEnabled: named.desiredEnabled,
    serviceName: cliName,
    expectedUrl: expectedServiceUrl(named.serviceName, machine.tailnetDomain ?? named.tailnetDomain),
    localTarget: named.target,
    httpsPort: named.httpsPort,
    status,
    lastError: observedError,
    lastWarning: presentationWarning,
    operation,
    canToggle: localRunning && machine.state !== "unavailable" && operation === null,
  }
}

function isPendingApproval(capability: unknown, cliName: string): boolean {
  if (capability == null) return false
  const text = JSON.stringify(capability).toLowerCase()
  return text.includes(cliName.toLowerCase()) && text.includes("pending")
}

export async function enableTailscaleService(service: ServiceConfig, executor: TailscaleExecutor): Promise<void> {
  const named = requireNamedConfig(service)
  await withOperation(service.id, "enabling", async () => {
    await executor.execute([
      "serve",
      `--service=${serviceNameToCliName(named.serviceName)}`,
      `--https=${named.httpsPort}`,
      named.target,
    ])
  })
}

export async function advertiseTailscaleService(service: ServiceConfig, executor: TailscaleExecutor): Promise<void> {
  const named = requireNamedConfig(service)
  await withOperation(service.id, "enabling", async () => {
    try {
      await executor.execute(["serve", "advertise", serviceNameToCliName(named.serviceName)])
    } catch (error) {
      if (!/NoState/i.test(safeError(error))) throw error
      const config = await readServeConfig(executor)
      const current = config.services?.[serviceNameToCliName(named.serviceName)]
      if (!serviceEndpointMatches(current, named) || !isServeServiceAdvertised(current)) throw error
    }
  })
}

export async function drainTailscaleService(service: ServiceConfig, executor: TailscaleExecutor): Promise<void> {
  const named = requireNamedConfig(service)
  await withOperation(service.id, "draining", async () => {
    await executor.execute(["serve", "drain", serviceNameToCliName(named.serviceName)])
  })
}

export async function disableTailscaleService(service: ServiceConfig, executor: TailscaleExecutor): Promise<void> {
  const named = requireNamedConfig(service)
  await withOperation(service.id, "disabling", async () => {
    let drainError: unknown
    try {
      await executor.execute(["serve", "drain", serviceNameToCliName(named.serviceName)])
    } catch (err) {
      drainError = err
    }
    await executor.execute([
      "serve",
      `--service=${serviceNameToCliName(named.serviceName)}`,
      `--https=${named.httpsPort}`,
      "off",
    ])
    if (drainError) {
      warningByService.set(service.id, `Endpoint removed after drain failed: ${safeError(drainError)}`)
    }
  })
}

export async function prepareTailscaleForStop(
  service: ServiceConfig,
  executor: TailscaleExecutor,
): Promise<{ success: boolean; warning: string | null }> {
  const named = getNamedServiceConfig(service)
  if (!named) return { success: true, warning: null }
  try {
    const current = (await readServeConfig(executor)).services?.[serviceNameToCliName(named.serviceName)]
    if (!isServeServiceAdvertised(current)) {
      return { success: true, warning: null }
    }
    await drainTailscaleService(service, executor)
    return { success: true, warning: null }
  } catch (err) {
    const warning = `Tailnet drain failed: ${safeError(err)}`
    warningByService.set(service.id, warning)
    try {
      await executor.execute([
        "serve",
        `--service=${serviceNameToCliName(named.serviceName)}`,
        `--https=${named.httpsPort}`,
        "off",
      ])
    } catch (cleanupError) {
      warningByService.set(service.id, `${warning}; endpoint cleanup failed: ${safeError(cleanupError)}`)
    }
    return { success: false, warning: warningByService.get(service.id) ?? warning }
  }
}

export async function restoreTailscaleWhenReady(
  service: ServiceConfig,
  isRunning: () => Promise<boolean>,
  executor: TailscaleExecutor,
  attempts = 30,
  intervalMs = 1_000,
): Promise<void> {
  const named = getNamedServiceConfig(service)
  if (!named?.desiredEnabled) return
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await isRunning()) {
      try {
        const config = await readServeConfig(executor)
        const current = config.services?.[serviceNameToCliName(named.serviceName)]
        const targetMatches = serviceEndpointMatches(current, named)
        if (targetMatches && !isServeServiceAdvertised(current)) {
          // One bounded repair for the stale saved-On/observed-Off state. This
          // models the proven per-service Off then On recovery and never resets
          // unrelated Serve configuration.
          await disableTailscaleService(service, executor)
          await enableTailscaleService(service, executor)
        } else if (!targetMatches) {
          await enableTailscaleService(service, executor)
        }
        // Otherwise live Serve state is authoritative. The endpoint command
        // advertises named Services automatically, and the advertised field is
        // normally omitted in this state.
        clearTailscaleServiceMessages(service.id)
      } catch (err) {
        const detail = safeError(err)
        if (/NoState/i.test(detail)) {
          try {
            const observed = await readServeConfig(executor)
            const current = observed.services?.[serviceNameToCliName(named.serviceName)]
            if (serviceEndpointMatches(current, named) && isServeServiceAdvertised(current)) {
              clearTailscaleServiceMessages(service.id)
              return
            }
          } catch {
            // Preserve the original command error when live state also fails.
          }
        }
        errorByService.set(service.id, detail)
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  warningByService.set(service.id, "Tailnet was not restored because the local service did not become healthy")
}

export function clearTailscaleServiceMessages(serviceId: string): void {
  errorByService.delete(serviceId)
  warningByService.delete(serviceId)
}

function requireNamedConfig(service: ServiceConfig): NamedServiceConfig {
  const config = getNamedServiceConfig(service)
  if (!config) throw new Error(`Service "${service.id}" is missing named Tailscale Service configuration`)
  return config
}

async function withOperation(
  serviceId: string,
  operation: TailscaleOperation,
  action: () => Promise<void>,
): Promise<void> {
  operationByService.set(serviceId, operation)
  errorByService.delete(serviceId)
  warningByService.delete(serviceId)
  try {
    await action()
  } catch (err) {
    errorByService.set(serviceId, safeError(err))
    throw err
  } finally {
    operationByService.delete(serviceId)
  }
}

function safeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
