import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { TailnetConfig } from "../types"

const execFileAsync = promisify(execFile)

export interface TailscaleExecutor { execute(args: string[]): Promise<string> }
export const tailscaleExecutor: TailscaleExecutor = {
  async execute(args) {
    const { stdout } = await execFileAsync("tailscale", args, { windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
    return stdout.trim()
  },
}

export interface GlobalTailscaleStatus {
  configured: boolean
  desiredEnabled: boolean
  serviceName: string
  target: string
  status: "connected" | "not_advertised" | "unavailable" | "error"
  tailnetDomain: string | null
  error: string | null
}

export async function getGlobalTailscaleStatus(config: TailnetConfig, executor: TailscaleExecutor = tailscaleExecutor): Promise<GlobalTailscaleStatus> {
  try {
    const [machineRaw, servicesRaw] = await Promise.all([executor.execute(["status", "--json"]), executor.execute(["serve", "get-config", "--all"])])
    const machine = JSON.parse(machineRaw) as { MagicDNSSuffix?: string; BackendState?: string }
    const serveConfig = JSON.parse(servicesRaw) as { services?: Record<string, { advertised?: boolean; endpoints?: Record<string, string> }> }
    const configured = serveConfig.services?.[`svc:${config.serviceName}`]
    const advertised = configured?.advertised !== false && configured?.endpoints?.[`tcp:${config.port}`]?.replace(/\/$/, "") === config.target.replace(/\/$/, "")
    return { configured: true, desiredEnabled: config.enabled, serviceName: config.serviceName, target: config.target, status: advertised ? "connected" : "not_advertised", tailnetDomain: machine.MagicDNSSuffix ?? null, error: machine.BackendState === "Running" ? null : machine.BackendState ?? null }
  } catch (error) {
    return { configured: true, desiredEnabled: config.enabled, serviceName: config.serviceName, target: config.target, status: "unavailable", tailnetDomain: null, error: (error as Error).message }
  }
}

export async function setGlobalTailscaleEnabled(config: TailnetConfig, enabled: boolean, executor: TailscaleExecutor = tailscaleExecutor): Promise<void> {
  const serviceName = `svc:${config.serviceName}`
  if (enabled) await executor.execute(["serve", `--service=${serviceName}`, `--https=${config.port}`, config.target])
  else {
    try { await executor.execute(["serve", "drain", serviceName]) } catch { /* endpoint removal still proceeds */ }
    await executor.execute(["serve", `--service=${serviceName}`, `--https=${config.port}`, "off"])
  }
}
