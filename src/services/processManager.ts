import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { detectPackageManager } from "./installer"
import { checkHealth } from "./healthCheck"
import type { LifecycleState, PortEntry, RepoConfig, ServiceConfig, ServiceProcessState } from "../types"

const _dir = import.meta.dir ?? dirname(fileURLToPath(import.meta.url))
const STATE_PATH = join(_dir, "..", "..", "data", "state.json")
const HEALTH_POLL_INTERVAL_MS = 1_000
const HEALTH_POLL_TIMEOUT_MS = 30_000

interface StateFile {
  processes: Record<string, ServiceProcessState>
}

interface StartResult {
  success: boolean
  message: string
  lifecycleState?: LifecycleState
  pid?: number
  portKillResult?: { killed: boolean; previousPid: number; error?: string }
}

interface StopResult {
  success: boolean
  alreadyStopped: boolean
  message: string
}

export class ProcessManager {
  private processes = new Map<string, ServiceProcessState>()
  private portMap = new Map<number, string>() // port → serviceId

  // ── Overridable for testing ──────────────────────────────────────────────────

  _checkHealth: (service: ServiceConfig) => ReturnType<typeof checkHealth> = checkHealth
  _isProcessAlive: (pid: number) => boolean = isProcessAlive
  _findPidOnPort: (port: number) => Promise<number | null> = findPidOnPort
  _spawnProcess: (command: string[], opts: object) => { pid: number; exited: Promise<number> } = (cmd, opts) => {
    const proc = Bun.spawn(cmd as string[], opts as Parameters<typeof Bun.spawn>[1])
    return { pid: proc.pid, exited: proc.exited }
  }

  // ── Startup ──────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.loadState()
  }

  // ── State persistence ────────────────────────────────────────────────────────

  private async loadState(): Promise<void> {
    let content: string
    try {
      content = await readFile(STATE_PATH, "utf-8")
    } catch {
      return
    }

    try {
      const data: StateFile = JSON.parse(content) as StateFile
      for (const [serviceId, state] of Object.entries(data.processes ?? {})) {
        if (!this._isProcessAlive(state.pid)) {
          console.log(`[ProcessManager] Pruned stale PID ${state.pid} for "${serviceId}"`)
          continue
        }
        if (state.lifecycleState === "starting") {
          // Restarted mid-startup — mark as failed
          this.processes.set(serviceId, {
            ...state,
            lifecycleState: "failed",
            lastError: "SourceManager restarted while service was starting",
          })
          this.portMap.set(state.port, serviceId)
        } else if (state.lifecycleState === "running") {
          this.processes.set(serviceId, state)
          this.portMap.set(state.port, serviceId)
        }
      }
    } catch (err) {
      console.warn(`[ProcessManager] Could not load state: ${(err as Error).message}`)
    }
  }

  private async saveState(): Promise<void> {
    const data: StateFile = { processes: Object.fromEntries(this.processes) }
    try {
      await mkdir(dirname(STATE_PATH), { recursive: true })
      await writeFile(STATE_PATH, JSON.stringify(data, null, 2))
    } catch (err) {
      console.warn(`[ProcessManager] Could not save state: ${(err as Error).message}`)
    }
  }

  // ── Lifecycle state helpers ──────────────────────────────────────────────────

  private setLifecycleState(serviceId: string, state: LifecycleState, extra?: Partial<ServiceProcessState>): void {
    const existing = this.processes.get(serviceId)
    if (!existing) return
    this.processes.set(serviceId, { ...existing, lifecycleState: state, ...extra })
  }

  private async setRunning(serviceId: string): Promise<void> {
    this.setLifecycleState(serviceId, "running", { readySince: new Date().toISOString(), lastError: undefined })
    await this.saveState()
  }

  private async setFailed(serviceId: string, error: string): Promise<void> {
    const state = this.processes.get(serviceId)
    if (state) {
      this.portMap.delete(state.port)
    }
    this.setLifecycleState(serviceId, "failed", { lastError: error })
    await this.saveState()
    console.error(`[ProcessManager] "${serviceId}" failed: ${error}`)
  }

  // ── Port management ──────────────────────────────────────────────────────────

  private async killPort(port: number): Promise<{ killed: boolean; previousPid: number; error?: string }> {
    const existingServiceId = this.portMap.get(port)

    if (existingServiceId) {
      const state = this.processes.get(existingServiceId)
      if (state) {
        console.log(`[ProcessManager] Auto-killing PID ${state.pid} ("${existingServiceId}") to free port ${port}`)
        const result = await this.killPid(state.pid)
        this.processes.delete(existingServiceId)
        this.portMap.delete(port)
        await this.saveState()
        return { killed: result.success, previousPid: state.pid, error: result.error }
      }
    }

    const externalPid = await this._findPidOnPort(port)
    if (externalPid) {
      console.log(`[ProcessManager] Auto-killing external PID ${externalPid} on port ${port}`)
      const result = await this.killPid(externalPid)
      return { killed: result.success, previousPid: externalPid, error: result.error }
    }

    return { killed: true, previousPid: 0 }
  }

  private async killPid(pid: number): Promise<{ success: boolean; error?: string }> {
    try {
      process.kill(pid, "SIGTERM")
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (this._isProcessAlive(pid)) {
        process.kill(pid, "SIGKILL")
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return { success: true }
    } catch (err) {
      const error = (err as NodeJS.ErrnoException).code === "ESRCH"
        ? "Process not found (already exited)"
        : (err as Error).message
      return { success: false, error }
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start(repo: RepoConfig, service: ServiceConfig): Promise<StartResult> {
    // Idempotent for already-starting or running services
    const existing = this.processes.get(service.id)
    if (existing?.lifecycleState === "starting" || existing?.lifecycleState === "running") {
      return {
        success: true,
        message: `Service "${service.id}" is already ${existing.lifecycleState}`,
        lifecycleState: existing.lifecycleState,
        pid: existing.pid,
      }
    }

    let portKillResult: StartResult["portKillResult"]
    const portOwner = this.portMap.get(service.port)
    const externalPid = await this._findPidOnPort(service.port)

    if (portOwner || externalPid) {
      portKillResult = await this.killPort(service.port)
      if (!portKillResult.killed) {
        return {
          success: false,
          message: `Port ${service.port} is in use and could not be freed: ${portKillResult.error}`,
          portKillResult,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    // Build start command
    const pm = service.packageManager === "auto"
      ? await detectPackageManager(repo.repoPath)
      : service.packageManager

    const command = [pm, "run", service.scriptName]
    console.log(`[ProcessManager] Starting "${service.id}": ${command.join(" ")} in ${repo.repoPath}`)

    const proc = this._spawnProcess(command, {
      cwd: repo.repoPath,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
    })

    const state: ServiceProcessState = {
      serviceId: service.id,
      repoId: repo.id,
      pid: proc.pid,
      port: service.port,
      startedAt: new Date().toISOString(),
      command: command.join(" "),
      lifecycleState: "starting",
    }

    this.processes.set(service.id, state)
    this.portMap.set(service.port, service.id)
    await this.saveState()

    // Monitor for immediate exit
    proc.exited.then(async (code) => {
      const current = this.processes.get(service.id)
      if (current?.pid === proc.pid && current.lifecycleState === "starting") {
        await this.setFailed(service.id, `Process exited with code ${code} before becoming ready`)
      } else if (current?.pid === proc.pid && current.lifecycleState === "running") {
        console.error(`[ProcessManager] "${service.id}" (PID ${proc.pid}) exited unexpectedly with code ${code}`)
        this.processes.delete(service.id)
        this.portMap.delete(service.port)
        await this.saveState()
      }
    }).catch(() => {})

    // Launch background health poll — do not await
    this.pollUntilReady(service.id, service, proc.pid).catch(() => {})

    return {
      success: true,
      message: `Service "${service.id}" starting with PID ${proc.pid} on port ${service.port}`,
      lifecycleState: "starting",
      pid: proc.pid,
      portKillResult,
    }
  }

  async stop(serviceId: string): Promise<StopResult> {
    const state = this.processes.get(serviceId)
    if (!state) {
      return { success: true, alreadyStopped: true, message: `Service "${serviceId}" was not running` }
    }

    console.log(`[ProcessManager] Stopping "${serviceId}" (PID ${state.pid})`)
    const result = await this.killPid(state.pid)
    this.processes.delete(serviceId)
    this.portMap.delete(state.port)
    await this.saveState()

    if (!result.success) {
      return { success: false, alreadyStopped: false, message: `Stop attempted but may have failed: ${result.error}` }
    }
    return { success: true, alreadyStopped: false, message: `Stopped "${serviceId}" (PID ${state.pid})` }
  }

  async restart(repo: RepoConfig, service: ServiceConfig): Promise<StartResult> {
    await this.stop(service.id)
    await new Promise((resolve) => setTimeout(resolve, 300))
    return this.start(repo, service)
  }

  // ── Background health poll ────────────────────────────────────────────────────

  private async pollUntilReady(
    serviceId: string,
    service: ServiceConfig,
    expectedPid: number,
  ): Promise<void> {
    const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS))

      const current = this.processes.get(serviceId)
      if (!current || current.pid !== expectedPid || current.lifecycleState !== "starting") return

      if (!this._isProcessAlive(current.pid)) {
        await this.setFailed(serviceId, "Process exited before becoming ready")
        return
      }

      const health = await this._checkHealth(service)
      if (health.status === "pass") {
        await this.setRunning(serviceId)
        console.log(`[ProcessManager] "${serviceId}" is ready (${health.durationMs}ms)`)
        return
      }
    }

    const current = this.processes.get(serviceId)
    if (current?.pid === expectedPid && current.lifecycleState === "starting") {
      await this.setFailed(serviceId, `Health check did not pass within ${HEALTH_POLL_TIMEOUT_MS / 1000}s`)
    }
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  getProcess(serviceId: string): ServiceProcessState | null {
    return this.processes.get(serviceId) ?? null
  }

  getAllProcesses(): ServiceProcessState[] {
    return Array.from(this.processes.values())
  }

  getPortEntries(): PortEntry[] {
    return Array.from(this.portMap.entries()).map(([port, serviceId]) => {
      const state = this.processes.get(serviceId)
      return {
        port,
        serviceId,
        pid: state?.pid ?? 0,
        status: state?.lifecycleState === "running" ? "running" : "stopped",
      }
    })
  }

  isRunning(serviceId: string): boolean {
    const state = this.processes.get(serviceId)
    if (!state) return false
    return state.lifecycleState === "running" && this._isProcessAlive(state.pid)
  }

  getLifecycleState(serviceId: string): LifecycleState {
    const state = this.processes.get(serviceId)
    if (!state) return "stopped"
    return state.lifecycleState
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function findPidOnPort(port: number): Promise<number | null> {
  // Windows: use netstat to find PID on port
  try {
    const proc = Bun.spawn(
      ["netstat", "-ano", "-p", "TCP"],
      { stdout: "pipe", stderr: "pipe" }
    )
    const output = await new Response(proc.stdout).text()
    const portStr = `:${port} `
    for (const line of output.split("\n")) {
      if (line.includes(portStr) && line.includes("LISTENING")) {
        const parts = line.trim().split(/\s+/)
        const pid = parseInt(parts[parts.length - 1], 10)
        if (!isNaN(pid) && pid > 0) return pid
      }
    }
  } catch {
    // netstat not available or failed — skip
  }
  return null
}

export const processManager = new ProcessManager()
