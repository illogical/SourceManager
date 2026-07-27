import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { detectPackageManager } from "./installer"
import { checkHealth } from "./healthCheck"
import { logLifecycleRun } from "./runLogger"
import { packageManagerExecutable, packageManagerRunCommand, type RunnablePackageManager } from "./packageManager"
import type { HealthCheckResult, LifecycleState, PortEntry, RepoConfig, ServiceConfig, ServiceProcessState, StepResult } from "../types"

const _dir = import.meta.dir ?? dirname(fileURLToPath(import.meta.url))
const STATE_PATH = join(_dir, "..", "..", "data", "state.json")
const HEALTH_POLL_INTERVAL_MS = 1_000
const HEALTH_POLL_TIMEOUT_MS = 30_000
const STOP_POLL_INTERVAL_MS = 250
const STOP_POLL_TIMEOUT_MS = 5_000

interface StateFile {
  processes: Record<string, ServiceProcessState>
}

interface StartResult {
  success: boolean
  message: string
  lifecycleState?: LifecycleState
  pid?: number
  portKillResult?: { killed: boolean; previousPid: number; error?: string }
  diagnostics?: StartDiagnostics
}

interface StartDiagnostics {
  code: "PACKAGE_MANAGER_DETECTION_FAILED" | "SERVICE_SPAWN_FAILED"
  repoId: string
  serviceId: string
  repoPath: string
  packageManager?: string
  executable?: string
  command?: string[]
  message: string
}

interface StopResult {
  success: boolean
  alreadyStopped: boolean
  message: string
  lifecycleState?: LifecycleState
  diagnostics?: StopDiagnostics
}

interface StopAttempt {
  target: "tracked-pid" | "port-pid"
  pid: number
  success: boolean
  error?: string
}

interface StopDiagnostics {
  code: "SERVICE_STOP_VERIFICATION_FAILED" | "SERVICE_STOP_KILL_FAILED" | "SERVICE_STOP_PORT_STILL_LISTENING"
  serviceId: string
  port: number
  trackedPid?: number
  portPidBefore?: number | null
  portPidAfter?: number | null
  attempts: StopAttempt[]
  message: string
}

interface StopVerification {
  stopped: boolean
  portPid: number | null
  health: HealthCheckResult
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
  _killProcessTree: (pid: number) => Promise<{ success: boolean; error?: string }> = killProcessTree
  _killPid: (pid: number) => Promise<{ success: boolean; error?: string }> = (pid) => this.killPid(pid)
  _logLifecycleRun: typeof logLifecycleRun = logLifecycleRun
  _onUnexpectedExit: (serviceId: string) => void | Promise<void> = () => {}
  _stopPollIntervalMs = STOP_POLL_INTERVAL_MS
  _stopPollTimeoutMs = STOP_POLL_TIMEOUT_MS
  _persistState = true

  // ── Startup ──────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.loadState()
  }

  // ── State persistence ────────────────────────────────────────────────────────

  private async loadState(): Promise<void> {
    if (!this._persistState) return

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
        if (state.lifecycleState === "starting" || state.lifecycleState === "stopping") {
          // Restarted mid-transition — keep the diagnostic visible.
          this.processes.set(serviceId, {
            ...state,
            lifecycleState: "failed",
            lastError: `SourceManager restarted while service was ${state.lifecycleState}`,
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
    if (!this._persistState) return

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
        const result = await this._killPid(state.pid)
        this.processes.delete(existingServiceId)
        this.portMap.delete(port)
        await this.saveState()
        return { killed: result.success, previousPid: state.pid, error: result.error }
      }
    }

    const externalPid = await this._findPidOnPort(port)
    if (externalPid) {
      console.log(`[ProcessManager] Auto-killing external PID ${externalPid} on port ${port}`)
      const result = await this._killPid(externalPid)
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
      if (this._isProcessAlive(pid) && process.platform === "win32") {
        const treeResult = await this._killProcessTree(pid)
        if (!treeResult.success) return treeResult
      }
      return { success: !this._isProcessAlive(pid), error: this._isProcessAlive(pid) ? "Process is still alive after kill attempts" : undefined }
    } catch (err) {
      const error = (err as NodeJS.ErrnoException).code === "ESRCH"
        ? "Process not found (already exited)"
        : (err as Error).message
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return { success: true, error }
      return { success: false, error }
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start(repo: RepoConfig, service: ServiceConfig): Promise<StartResult> {
    // Idempotent for already-starting or running services
    const existing = this.processes.get(service.id)
    if (existing?.lifecycleState === "starting" || existing?.lifecycleState === "running" || existing?.lifecycleState === "stopping") {
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
    let pm: RunnablePackageManager
    try {
      pm = service.packageManager === "auto"
        ? await detectPackageManager(repo.repoPath)
        : service.packageManager
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        message: `Could not detect package manager for "${service.id}": ${message}`,
        diagnostics: {
          code: "PACKAGE_MANAGER_DETECTION_FAILED",
          repoId: repo.id,
          serviceId: service.id,
          repoPath: repo.repoPath,
          packageManager: service.packageManager,
          message,
        },
      }
    }

    const executable = packageManagerExecutable(pm)
    const command = packageManagerRunCommand(pm, service.scriptName)
    console.log(`[ProcessManager] Starting "${service.id}": ${command.join(" ")} in ${repo.repoPath}`)

    let proc: { pid: number; exited: Promise<number> }
    try {
      proc = this._spawnProcess(command, {
        cwd: repo.repoPath,
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const diagnostics: StartDiagnostics = {
        code: "SERVICE_SPAWN_FAILED",
        repoId: repo.id,
        serviceId: service.id,
        repoPath: repo.repoPath,
        packageManager: pm,
        executable,
        command,
        message,
      }
      console.error(`[ProcessManager] Failed to spawn "${service.id}":`, diagnostics)
      return {
        success: false,
        message: `Failed to spawn service "${service.id}": ${message}`,
        lifecycleState: "failed",
        portKillResult,
        diagnostics,
      }
    }

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
        void this._onUnexpectedExit(service.id)
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

  async stop(service: ServiceConfig, repo?: RepoConfig): Promise<StopResult> {
    const serviceId = service.id
    const runId = crypto.randomUUID()
    const startedAt = new Date().toISOString()
    const runStart = Date.now()
    const steps: StepResult[] = []
    const attempts: StopAttempt[] = []
    const trackedState = this.processes.get(serviceId)
    const trackedPid = trackedState?.pid
    const repoId = repo?.id ?? trackedState?.repoId ?? "unknown"

    const portPidBefore = await this._findPidOnPort(service.port)
    addStep(steps, "inspect", "success", `tracked PID ${trackedPid ?? "none"}, port PID ${portPidBefore ?? "none"}`, runStart)

    if (!trackedState && !portPidBefore) {
      const health = await this._checkHealth(service)
      if (health.status === "fail") {
        const message = `Service "${serviceId}" was not running`
        addStep(steps, "verify-stopped", "success", health.detail ?? "health check failed as expected", runStart)
        await this.logStopRun({ runId, serviceId, repoId, startedAt, runStart, status: "skipped", reason: message, steps })
        return { success: true, alreadyStopped: true, message, lifecycleState: "stopped" }
      }

      const diagnostics: StopDiagnostics = {
        code: "SERVICE_STOP_VERIFICATION_FAILED",
        serviceId,
        port: service.port,
        portPidBefore,
        portPidAfter: null,
        attempts,
        message: `Health check still passes for "${serviceId}", but no PID was found on port ${service.port}`,
      }
      const message = diagnostics.message
      this.processes.set(serviceId, {
        serviceId,
        repoId,
        pid: 0,
        port: service.port,
        startedAt,
        command: "<unknown healthy service>",
        lifecycleState: "failed",
        lastError: message,
      })
      await this.saveState()
      addStep(steps, "verify-stopped", "failure", message, runStart)
      await this.logStopRun({ runId, serviceId, repoId, startedAt, runStart, status: "failure", reason: message, steps, diagnostics })
      return { success: false, alreadyStopped: false, message, lifecycleState: "failed", diagnostics }
    }

    const state = trackedState ?? {
      serviceId,
      repoId,
      pid: portPidBefore ?? 0,
      port: service.port,
      startedAt,
      command: "<external port listener>",
      lifecycleState: "stopping" as LifecycleState,
    }

    this.processes.set(serviceId, { ...state, lifecycleState: "stopping", lastError: undefined })
    this.portMap.set(service.port, serviceId)
    await this.saveState()
    addStep(steps, "mark-stopping", "success", `Lifecycle set to stopping for "${serviceId}"`, runStart)

    console.log(`[ProcessManager] Stopping "${serviceId}": tracked PID ${trackedPid ?? "none"}, port ${service.port} PID ${portPidBefore ?? "none"}`)

    if (trackedPid) {
      const result = await this._killPid(trackedPid)
      attempts.push({ target: "tracked-pid", pid: trackedPid, success: result.success, error: result.error })
      addStep(steps, "kill-tracked-pid", result.success ? "success" : "failure", result.success ? `Killed tracked PID ${trackedPid}` : `Failed to kill tracked PID ${trackedPid}: ${result.error}`, runStart)
      console.log(`[ProcessManager] Kill tracked PID ${trackedPid} for "${serviceId}": ${result.success ? "success" : `failed: ${result.error}`}`)
    } else {
      addStep(steps, "kill-tracked-pid", "skipped", "No tracked PID", runStart)
    }

    const portPidAfterTrackedKill = await this._findPidOnPort(service.port)
    if (portPidAfterTrackedKill && portPidAfterTrackedKill !== trackedPid) {
      const result = await this._killPid(portPidAfterTrackedKill)
      attempts.push({ target: "port-pid", pid: portPidAfterTrackedKill, success: result.success, error: result.error })
      addStep(steps, "kill-port-pid", result.success ? "success" : "failure", result.success ? `Killed port PID ${portPidAfterTrackedKill}` : `Failed to kill port PID ${portPidAfterTrackedKill}: ${result.error}`, runStart)
      console.log(`[ProcessManager] Kill port PID ${portPidAfterTrackedKill} for "${serviceId}": ${result.success ? "success" : `failed: ${result.error}`}`)
    } else if (portPidAfterTrackedKill) {
      addStep(steps, "kill-port-pid", "skipped", `Port PID ${portPidAfterTrackedKill} already matched tracked PID`, runStart)
    } else {
      addStep(steps, "kill-port-pid", "skipped", "No remaining port PID", runStart)
    }

    const verification = await this.waitUntilStopped(service)
    if (verification.stopped) {
      this.processes.delete(serviceId)
      this.portMap.delete(service.port)
      await this.saveState()
      const message = `Stopped "${serviceId}" on port ${service.port}`
      addStep(steps, "verify-stopped", "success", "Health check failed and port is free", runStart)
      await this.logStopRun({ runId, serviceId, repoId, startedAt, runStart, status: "success", reason: message, steps })
      console.log(`[ProcessManager] ${message}`)
      return { success: true, alreadyStopped: false, message, lifecycleState: "stopped" }
    }

    const portDetail = verification.portPid
      ? `port ${service.port} is still listening on PID ${verification.portPid}`
      : `health check still passes for ${service.healthUrl}`
    const message = `Stop verification failed for "${serviceId}": ${portDetail}`
    const diagnostics: StopDiagnostics = {
      code: verification.portPid ? "SERVICE_STOP_PORT_STILL_LISTENING" : "SERVICE_STOP_VERIFICATION_FAILED",
      serviceId,
      port: service.port,
      trackedPid,
      portPidBefore,
      portPidAfter: verification.portPid,
      attempts,
      message,
    }

    this.setLifecycleState(serviceId, "failed", { lastError: message })
    await this.saveState()
    addStep(steps, "verify-stopped", "failure", verification.health.detail ?? message, runStart)
    await this.logStopRun({ runId, serviceId, repoId, startedAt, runStart, status: "failure", reason: message, steps, diagnostics })
    console.error(`[ProcessManager] ${message}`)

    return { success: false, alreadyStopped: false, message, lifecycleState: "failed", diagnostics }
  }

  async restart(repo: RepoConfig, service: ServiceConfig): Promise<StartResult> {
    await this.stop(service, repo)
    await new Promise((resolve) => setTimeout(resolve, 300))
    return this.start(repo, service)
  }

  private async waitUntilStopped(service: ServiceConfig): Promise<StopVerification> {
    const deadline = Date.now() + this._stopPollTimeoutMs
    let latest: StopVerification | null = null

    while (Date.now() <= deadline) {
      const portPid = await this._findPidOnPort(service.port)
      const health = await this._checkHealth(service)
      latest = { stopped: !portPid && health.status === "fail", portPid, health }
      if (latest.stopped) return latest
      await new Promise((resolve) => setTimeout(resolve, this._stopPollIntervalMs))
    }

    return latest ?? {
      stopped: false,
      portPid: await this._findPidOnPort(service.port),
      health: await this._checkHealth(service),
    }
  }

  private async logStopRun(args: {
    runId: string
    serviceId: string
    repoId: string
    startedAt: string
    runStart: number
    status: "success" | "failure" | "skipped"
    reason: string
    steps: StepResult[]
    diagnostics?: StopDiagnostics
  }): Promise<void> {
    await this._logLifecycleRun({
      kind: "lifecycle",
      action: "stop",
      runId: args.runId,
      serviceId: args.serviceId,
      repoId: args.repoId,
      startedAt: args.startedAt,
      durationMs: Date.now() - args.runStart,
      status: args.status,
      reason: args.reason,
      steps: args.steps,
      diagnostics: args.diagnostics as Record<string, unknown> | undefined,
    }).catch((err) => {
      console.warn(`[ProcessManager] Could not write stop lifecycle log for "${args.serviceId}": ${(err as Error).message}`)
    })
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

function addStep(
  steps: StepResult[],
  step: string,
  status: StepResult["status"],
  message: string,
  runStart: number,
): void {
  steps.push({ step, status, message, durationMs: Date.now() - runStart })
}

async function killProcessTree(pid: number): Promise<{ success: boolean; error?: string }> {
  if (process.platform !== "win32") return { success: false, error: "Process tree kill is only available on Windows" }

  try {
    const proc = Bun.spawn(
      ["taskkill", "/PID", String(pid), "/T", "/F"],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code === 0) return { success: true }
    return { success: false, error: stderr.trim() || stdout.trim() || `taskkill exited with code ${code}` }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
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
