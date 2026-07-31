import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { readFile, writeFile, mkdir, chmod, rename } from "node:fs/promises"
import { spawn } from "node:child_process"
import { detectPackageManager } from "./installer"
import { checkHealth } from "./healthCheck"
import { logLifecycleRun } from "./runLogger"
import { packageManagerExecutable, packageManagerRunCommand, type RunnablePackageManager } from "./packageManager"
import type { HealthCheckResult, LifecycleState, PortEntry, RepoConfig, ServiceConfig, ServiceProcessState, StepResult } from "../types"
import {
  fingerprintCommand,
  verifyRunnerStatus,
  type RunnerControlRequest,
  type RunnerManifest,
  type RunnerStatus,
} from "./runnerProtocol"
import {
  beginStartupReconciliation,
  completeStartupReconciliation,
  markStartupServiceComplete,
  STARTUP_RECONCILIATION_TIMEOUT_MS,
} from "./startupStatus"
import { readRecentServiceOutput } from "./serviceOutput"
import { spawnDetachedProcess } from "./detachedProcess"

const _dir = import.meta.dir ?? dirname(fileURLToPath(import.meta.url))
const STATE_PATH = join(_dir, "..", "..", "data", "state.json")
const RUNTIME_PATH = join(_dir, "..", "..", "data", "runtime", "services")
const LOG_PATH = join(_dir, "..", "..", "data", "logs", "services")
const RUNNER_PATH = join(_dir, "..", "serviceRunner.ts")
const HEALTH_POLL_INTERVAL_MS = 1_000
const HEALTH_POLL_TIMEOUT_MS = 30_000
const RECOVERY_HEALTH_POLL_INTERVAL_MS = 2_000
const STARTUP_RECOVERY_CONCURRENCY = 2
const STOP_POLL_INTERVAL_MS = 250
const STOP_POLL_TIMEOUT_MS = 5_000

interface StateFile {
  processes: Record<string, ServiceProcessState>
  outputs?: Record<string, { runId: string; logDirectory: string }>
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
  code: "PACKAGE_MANAGER_DETECTION_FAILED" | "SERVICE_SPAWN_FAILED" | "SERVICE_PROCESS_OWNERSHIP_CONFLICT"
  repoId: string
  serviceId: string
  repoPath: string
  packageManager?: string
  executable?: string
  command?: string[]
  message: string
}

interface StartOptions {
  readinessTimeoutMs?: number
  recovery?: boolean
}

export interface StartupReconciliationHooks {
  onHealthyDesiredTailnet?: (service: ServiceConfig) => Promise<void>
  onUnhealthyTailnet?: (service: ServiceConfig) => Promise<void>
}

interface StopResult {
  success: boolean
  alreadyStopped: boolean
  message: string
  lifecycleState?: LifecycleState
  diagnostics?: StopDiagnostics
}

interface StopAttempt {
  target: "runner-control"
  pid: number
  success: boolean
  error?: string
}

interface StopDiagnostics {
  code:
    | "SERVICE_STOP_VERIFICATION_FAILED"
    | "SERVICE_STOP_PORT_STILL_LISTENING"
    | "SERVICE_PROCESS_OWNERSHIP_CONFLICT"
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
  private outputs = new Map<string, { runId: string; logDirectory: string }>()
  private stateWriteQueue: Promise<void> = Promise.resolve()

  // ── Overridable for testing ──────────────────────────────────────────────────

  _checkHealth: (service: ServiceConfig) => ReturnType<typeof checkHealth> = checkHealth
  _isProcessAlive: (pid: number) => boolean = isProcessAlive
  _findPidOnPort: (port: number) => Promise<number | null> = findPidOnPort
  _isDescendantProcess: (pid: number, ancestorPid: number) => Promise<boolean> = isDescendantProcess
  _spawnProcess: (
    command: string[],
    opts: object,
  ) => Promise<{ pid: number; exited: Promise<number>; unref?: () => void }>
    | { pid: number; exited: Promise<number>; unref?: () => void } = (cmd, opts) =>
      spawnDetachedProcess(cmd, opts)
  _logLifecycleRun: typeof logLifecycleRun = logLifecycleRun
  _onUnexpectedExit: (serviceId: string) => void | Promise<void> = () => {}
  _onReady: (service: ServiceConfig) => void | Promise<void> = () => {}
  _verifyLaunchRecord: (
    state: ServiceProcessState,
    service: ServiceConfig,
    knownHealthy?: boolean,
    knownPortPid?: number | null,
  ) => Promise<RunnerStatus | null> = (state, service, knownHealthy, knownPortPid) =>
    this.verifyLaunchRecord(state, service, knownHealthy, knownPortPid)
  _verifyRunnerIdentity: (state: ServiceProcessState, service: ServiceConfig) => Promise<RunnerStatus | null> =
    (state, service) => this.verifyRunnerIdentity(state, service)
  _requestRunnerStop: (state: ServiceProcessState) => Promise<{ success: boolean; error?: string }> =
    (state) => this.requestRunnerStop(state)
  _restrictRuntimePermissions: (directories: string[]) => Promise<void> = restrictRuntimePermissions
  _stopPollIntervalMs = STOP_POLL_INTERVAL_MS
  _stopPollTimeoutMs = STOP_POLL_TIMEOUT_MS
  _healthPollIntervalMs = HEALTH_POLL_INTERVAL_MS
  _startupReconciliationTimeoutMs = STARTUP_RECONCILIATION_TIMEOUT_MS
  _runtimePath = RUNTIME_PATH
  _serviceLogPath = LOG_PATH
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
      for (const [serviceId, output] of Object.entries(data.outputs ?? {})) {
        if (output.runId && output.logDirectory) this.outputs.set(serviceId, output)
      }
      for (const [serviceId, state] of Object.entries(data.processes ?? {})) {
        if (state.runId && state.logDirectory && !this.outputs.has(serviceId)) {
          this.outputs.set(serviceId, { runId: state.runId, logDirectory: state.logDirectory })
        }
        // Keep unavailable saved records until startup reconciliation has used
        // their intended state. A reboot makes every PID stale but must not
        // erase the fact that SourceManager should try one recovery.
        this.processes.set(serviceId, {
          ...state,
          intendedState: state.intendedState ?? (
            state.lifecycleState === "running" || state.lifecycleState === "starting" || state.lifecycleState === "stopping"
              ? "running"
              : "stopped"
          ),
        })
        this.portMap.set(state.port, serviceId)
      }
    } catch (err) {
      console.warn(`[ProcessManager] Could not load state: ${(err as Error).message}`)
    }
  }

  private async saveState(): Promise<void> {
    if (!this._persistState) return

    const data: StateFile = {
      processes: Object.fromEntries(this.processes),
      outputs: Object.fromEntries(this.outputs),
    }
    const serialized = JSON.stringify(data, null, 2)
    const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`
    const write = this.stateWriteQueue.then(async () => {
      await mkdir(dirname(STATE_PATH), { recursive: true })
      await writeFile(temporaryPath, serialized)
      await rename(temporaryPath, STATE_PATH)
    })
    this.stateWriteQueue = write.catch(() => {})
    await write.catch((err) => {
      console.warn(`[ProcessManager] Could not save state: ${(err as Error).message}`)
    })
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

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start(repo: RepoConfig, service: ServiceConfig, options: StartOptions = {}): Promise<StartResult> {
    // Idempotent for already-starting or running services
    const existing = this.processes.get(service.id)
    if (existing?.lifecycleState === "recovering") {
      const health = await this._checkHealth(service)
      const verified = await this._verifyRunnerIdentity(existing, service)
      if (health.status === "pass" && verified) {
        await this.setRunning(service.id)
        await this._onReady(service)
        return {
          success: true,
          message: `Service "${service.id}" recovered and is now ready`,
          lifecycleState: "running",
          pid: existing.pid,
        }
      }
      return {
        success: true,
        message: `Service "${service.id}" is still recovering; readiness was checked again`,
        lifecycleState: "recovering",
        pid: existing.pid,
      }
    }
    if (existing?.lifecycleState === "starting" || existing?.lifecycleState === "running" || existing?.lifecycleState === "stopping") {
      return {
        success: true,
        message: `Service "${service.id}" is already ${existing.lifecycleState}`,
        lifecycleState: existing.lifecycleState,
        pid: existing.pid,
      }
    }
    if (existing?.lifecycleState === "failed" && await this._verifyRunnerIdentity(existing, service)) {
      const stopped = await this.stopVerifiedRunnerForReplacement(existing, service)
      if (!stopped.success) {
        return {
          success: false,
          message: `Could not replace the prior runner for "${service.id}": ${stopped.error}`,
          lifecycleState: "failed",
        }
      }
      this.processes.delete(service.id)
      this.portMap.delete(service.port)
      await this.saveState()
    }

    let portKillResult: StartResult["portKillResult"]
    const portOwner = this.portMap.get(service.port)
    const externalPid = await this._findPidOnPort(service.port)

    if (externalPid) {
      const message = `Port ${service.port} is in use by a process SourceManager cannot verify`
      portKillResult = {
        killed: false,
        previousPid: externalPid,
        error: `SourceManager will not kill or adopt PID ${externalPid}`,
      }
      return {
        success: false,
        message,
        portKillResult,
        lifecycleState: "failed",
        diagnostics: {
          code: "SERVICE_PROCESS_OWNERSHIP_CONFLICT",
          repoId: repo.id,
          serviceId: service.id,
          repoPath: repo.repoPath,
          message: `${message}: ${portKillResult.error}`,
        },
      }
    }
    if (portOwner) {
      // A saved map entry without a listener is stale metadata, commonly after
      // reboot. It is safe to discard; no PID is signalled.
      this.portMap.delete(service.port)
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
    console.log(`[ProcessManager] Starting detached runner for "${service.id}": ${command.join(" ")} in ${repo.repoPath}`)

    const runId = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const runDirectory = join(this._runtimePath, service.id, runId)
    const logDirectory = join(this._serviceLogPath, service.id, runId)
    const manifestPath = join(runDirectory, "manifest.json")
    const statusPath = join(runDirectory, "runner-status.json")
    const controlPath = join(runDirectory, "control.json")
    const controlToken = crypto.randomUUID() + crypto.randomUUID()
    const commandFingerprint = fingerprintCommand(command, repo.repoPath)
    const manifest: RunnerManifest = {
      version: 1,
      runId,
      serviceId: service.id,
      repoId: repo.id,
      command,
      commandFingerprint,
      cwd: repo.repoPath,
      port: service.port,
      healthUrl: service.healthUrl,
      createdAt,
      logDirectory,
      statusPath,
      controlPath,
      controlToken,
      maxSegmentBytes: 5 * 1024 * 1024,
      maxRetainedBytes: 25 * 1024 * 1024,
    }

    let proc: { pid: number; exited: Promise<number>; unref?: () => void }
    try {
      await mkdir(runDirectory, { recursive: true, mode: 0o700 })
      await mkdir(logDirectory, { recursive: true, mode: 0o700 })
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 })
      await chmod(manifestPath, 0o600).catch(() => {})
      await this._restrictRuntimePermissions([runDirectory, logDirectory])
      proc = await this._spawnProcess([process.execPath, RUNNER_PATH, manifestPath], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        cwd: repo.repoPath,
        env: { ...process.env },
      })
      proc.unref?.()
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
      childPid: null,
      port: service.port,
      startedAt: createdAt,
      command: command.join(" "),
      lifecycleState: options.recovery ? "recovering" : "starting",
      intendedState: "running",
      runId,
      processCreatedAt: createdAt,
      commandFingerprint,
      repoPath: repo.repoPath,
      healthUrl: service.healthUrl,
      logDirectory,
      manifestPath,
      recoveryAttempt: options.recovery ? 1 : undefined,
      recoveryReason: options.recovery
        ? "Restoring service that was running before SourceManager exited"
        : undefined,
    }

    this.processes.set(service.id, state)
    this.outputs.set(service.id, { runId, logDirectory })
    this.portMap.set(service.port, service.id)
    await this.saveState()

    // Monitor for immediate exit
    proc.exited.then(async (code) => {
      const current = this.processes.get(service.id)
      if (current?.pid === proc.pid && (current.lifecycleState === "starting" || current.lifecycleState === "recovering")) {
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
    this.pollUntilReady(
      service.id,
      service,
      proc.pid,
      options.readinessTimeoutMs ?? (service.recoveryTimeoutSeconds ?? 30) * 1_000,
    ).catch(() => {})

    return {
      success: true,
      message: `Service "${service.id}" starting with PID ${proc.pid} on port ${service.port}`,
      lifecycleState: options.recovery ? "recovering" : "starting",
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
    const verified = trackedState ? await this._verifyRunnerIdentity(trackedState, service) : null
    addStep(steps, "inspect", "success", `tracked PID ${trackedPid ?? "none"}, port PID ${portPidBefore ?? "none"}`, runStart)

    if (!verified && !portPidBefore) {
      const health = await this._checkHealth(service)
      if (health.status === "fail") {
        const message = `Service "${serviceId}" was not running`
        this.processes.delete(serviceId)
        this.portMap.delete(service.port)
        await this.saveState()
        addStep(steps, "verify-stopped", "success", health.detail ?? "health check failed as expected", runStart)
        await this.logStopRun({ runId, serviceId, repoId, startedAt, runStart, status: "skipped", reason: message, steps })
        return { success: true, alreadyStopped: true, message, lifecycleState: "stopped" }
      }

      const diagnostics: StopDiagnostics = {
        code: "SERVICE_PROCESS_OWNERSHIP_CONFLICT",
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
        diagnosticCode: "SERVICE_PROCESS_OWNERSHIP_CONFLICT",
        intendedState: "stopped",
      })
      await this.saveState()
      addStep(steps, "verify-stopped", "failure", message, runStart)
      await this.logStopRun({ runId, serviceId, repoId, startedAt, runStart, status: "failure", reason: message, steps, diagnostics })
      return { success: false, alreadyStopped: false, message, lifecycleState: "failed", diagnostics }
    }

    if (!verified) {
      const message = `SourceManager cannot verify ownership of PID ${portPidBefore ?? trackedPid ?? "unknown"} for "${serviceId}" and will not stop it`
      const diagnostics: StopDiagnostics = {
        code: "SERVICE_STOP_VERIFICATION_FAILED",
        serviceId,
        port: service.port,
        trackedPid,
        portPidBefore,
        portPidAfter: portPidBefore,
        attempts,
        message,
      }
      this.processes.set(serviceId, {
        ...(trackedState ?? {
          serviceId,
          repoId,
          pid: portPidBefore ?? 0,
          port: service.port,
          startedAt,
          command: "<unverified port listener>",
        }),
        lifecycleState: "failed",
        intendedState: "stopped",
        diagnosticCode: "SERVICE_PROCESS_OWNERSHIP_CONFLICT",
        lastError: message,
      })
      await this.saveState()
      await this.logStopRun({ runId, serviceId, repoId, startedAt, runStart, status: "failure", reason: message, steps, diagnostics })
      return { success: false, alreadyStopped: false, message, lifecycleState: "failed", diagnostics }
    }

    const state = trackedState!

    this.processes.set(serviceId, { ...state, lifecycleState: "stopping", lastError: undefined })
    this.portMap.set(service.port, serviceId)
    await this.saveState()
    addStep(steps, "mark-stopping", "success", `Lifecycle set to stopping for "${serviceId}"`, runStart)

    console.log(`[ProcessManager] Stopping "${serviceId}": tracked PID ${trackedPid ?? "none"}, port ${service.port} PID ${portPidBefore ?? "none"}`)

    const controlResult = await this._requestRunnerStop(state)
    attempts.push({
      target: "runner-control",
      pid: trackedPid ?? 0,
      success: controlResult.success,
      error: controlResult.error,
    })
    addStep(
      steps,
      "request-runner-stop",
      controlResult.success ? "success" : "failure",
      controlResult.success ? `Authenticated stop requested for runner PID ${trackedPid}` : controlResult.error ?? "Runner stop request failed",
      runStart,
    )

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
    const stop = await this.stop(service, repo)
    if (!stop.success && !stop.alreadyStopped) {
      return { success: false, message: `Could not restart "${service.id}": ${stop.message}`, lifecycleState: "failed" }
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    return this.start(repo, service)
  }

  async reconcileStartup(repos: RepoConfig[], hooks: StartupReconciliationHooks = {}): Promise<void> {
    const configured = repos.flatMap((repo) => repo.services.map((service) => ({ repo, service })))
    beginStartupReconciliation(configured.length, this._startupReconciliationTimeoutMs)

    let nextIndex = 0
    const worker = async () => {
      while (nextIndex < configured.length) {
        const { repo, service } = configured[nextIndex++]
        try {
          await this.reconcileService(repo, service)
          if (this.processes.get(service.id)?.lifecycleState === "running") {
            await hooks.onHealthyDesiredTailnet?.(service)
          } else {
            await hooks.onUnhealthyTailnet?.(service)
          }
        } catch (err) {
          console.warn(`[ProcessManager] Startup reconciliation failed for "${service.id}": ${(err as Error).message}`)
        } finally {
          markStartupServiceComplete()
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(STARTUP_RECOVERY_CONCURRENCY, configured.length) }, () => worker()),
    )

    completeStartupReconciliation()
  }

  private async reconcileService(repo: RepoConfig, service: ServiceConfig): Promise<void> {
    const saved = this.processes.get(service.id)
    const intendedRunning = saved?.intendedState === "running"
    const portPid = await this._findPidOnPort(service.port)
    const health = await this._checkHealth(service)
    const runnerIdentity = saved ? await this._verifyRunnerIdentity(saved, service) : null
    const verified = saved ? await this._verifyLaunchRecord(saved, service, health.status === "pass", portPid) : null

    if (verified) {
      this.processes.set(service.id, {
        ...saved!,
        pid: verified.runnerPid,
        childPid: verified.childPid,
        lifecycleState: "running",
        intendedState: "running",
        readySince: saved?.readySince ?? new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        lastError: undefined,
        diagnosticCode: undefined,
      })
      this.portMap.set(service.port, service.id)
      await this.saveState()
      return
    }

    if (health.status === "pass" || portPid) {
      const message = `A healthy listener${portPid ? ` (PID ${portPid})` : ""} exists on port ${service.port}, but it is not owned by a verified SourceManager runner`
      this.processes.set(service.id, {
        ...(saved ?? {
          serviceId: service.id,
          repoId: repo.id,
          pid: 0,
          port: service.port,
          startedAt: new Date().toISOString(),
          command: "<unverified listener>",
        }),
        lifecycleState: "failed",
        intendedState: saved?.intendedState ?? "stopped",
        diagnosticCode: "SERVICE_PROCESS_OWNERSHIP_CONFLICT",
        lastError: message,
      })
      await this.saveState()
      return
    }

    if (!intendedRunning) {
      this.processes.delete(service.id)
      this.portMap.delete(service.port)
      await this.saveState()
      return
    }

    // The old runner is gone (the common reboot case). Remove only the stale
    // record, then make one replacement attempt with this service's own
    // readiness threshold.
    if (saved && runnerIdentity) {
      const stopped = await this.stopVerifiedRunnerForReplacement(saved, service)
      if (!stopped.success) {
        await this.recordRecoveryFailure(repo, service, stopped.error ?? "Could not stop the unhealthy prior runner")
        return
      }
    }
    this.processes.delete(service.id)
    this.portMap.delete(service.port)
    await this.saveState()
    const recoveryTimeoutMs = service.recoveryTimeoutSeconds === undefined
      ? this._startupReconciliationTimeoutMs
      : service.recoveryTimeoutSeconds * 1_000
    const result = await this.start(repo, service, {
      recovery: true,
      readinessTimeoutMs: recoveryTimeoutMs,
    })
    if (!result.success) {
      await this.recordRecoveryFailure(repo, service, result.message)
      return
    }

    const deadline = Date.now() + recoveryTimeoutMs
    while (Date.now() < deadline) {
      const current = this.processes.get(service.id)
      if (current?.lifecycleState === "running") return
      if (current?.lifecycleState === "failed") break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // A live runner remains Recovering after its initial readiness threshold.
    // pollUntilReady continues checking it in the background.
  }

  private async recordRecoveryFailure(repo: RepoConfig, service: ServiceConfig, detail: string): Promise<void> {
    const current = this.processes.get(service.id)
    const output = current?.logDirectory ? await readRecentServiceOutput(current.logDirectory, 4_096) : ""
    if (output) detail = `${detail}. Recent output: ${output}`
    this.processes.set(service.id, {
      ...(current ?? {
        serviceId: service.id,
        repoId: repo.id,
        pid: 0,
        port: service.port,
        startedAt: new Date().toISOString(),
        command: `${service.packageManager} run ${service.scriptName}`,
      }),
      lifecycleState: "failed",
      intendedState: "running",
      recoveryAttempt: 1,
      recoveryReason: "Restoring service that was running before SourceManager exited",
      diagnosticCode: "SERVICE_STARTUP_RECOVERY_FAILED",
      lastError: `Startup recovery failed: ${detail}`,
    })
    this.portMap.delete(service.port)
    await this.saveState()
  }

  private async verifyLaunchRecord(
    state: ServiceProcessState,
    service: ServiceConfig,
    knownHealthy?: boolean,
    knownPortPid?: number | null,
  ): Promise<RunnerStatus | null> {
    const status = await this.verifyRunnerIdentity(state, service)
    if (!status) return null
    const healthy = knownHealthy ?? (await this._checkHealth(service)).status === "pass"
    if (!healthy) return null
    const portPid = knownPortPid === undefined ? await this._findPidOnPort(service.port) : knownPortPid
    if (!portPid) return null
    if (portPid !== status.childPid && !await this._isDescendantProcess(portPid, state.pid)) return null
    return status
  }

  private async verifyRunnerIdentity(
    state: ServiceProcessState,
    service: ServiceConfig,
  ): Promise<RunnerStatus | null> {
    if (!state.runId || !state.manifestPath || !state.commandFingerprint || !state.processCreatedAt) return null
    if (!this._isProcessAlive(state.pid)) return null

    try {
      const manifest = JSON.parse(await readFile(state.manifestPath, "utf8")) as RunnerManifest
      const status = JSON.parse(await readFile(manifest.statusPath, "utf8")) as RunnerStatus
      if (
        manifest.runId !== state.runId
        || manifest.serviceId !== service.id
        || manifest.commandFingerprint !== state.commandFingerprint
        || status.runId !== state.runId
        || status.serviceId !== service.id
        || status.runnerPid !== state.pid
        || status.processCreatedAt !== state.processCreatedAt
        || status.commandFingerprint !== state.commandFingerprint
        || !verifyRunnerStatus(status, manifest.controlToken)
        || Date.now() - new Date(status.heartbeatAt).getTime() > 3_000
        || status.state === "exited"
      ) return null

      return status
    } catch {
      return null
    }
  }

  private async stopVerifiedRunnerForReplacement(
    state: ServiceProcessState,
    service: ServiceConfig,
  ): Promise<{ success: boolean; error?: string }> {
    const request = await this._requestRunnerStop(state)
    if (!request.success) return request
    const deadline = Date.now() + this._stopPollTimeoutMs
    while (Date.now() < deadline) {
      if (!this._isProcessAlive(state.pid) && !await this._findPidOnPort(service.port)) {
        return { success: true }
      }
      await new Promise((resolve) => setTimeout(resolve, this._stopPollIntervalMs))
    }
    return { success: false, error: "Prior verified runner did not stop before replacement timeout" }
  }

  private async requestRunnerStop(state: ServiceProcessState): Promise<{ success: boolean; error?: string }> {
    if (!state.manifestPath || !state.runId) return { success: false, error: "Verified runner manifest is unavailable" }
    try {
      const manifest = JSON.parse(await readFile(state.manifestPath, "utf8")) as RunnerManifest
      const request: RunnerControlRequest = {
        action: "stop",
        runId: state.runId,
        token: manifest.controlToken,
        requestedAt: new Date().toISOString(),
      }
      await writeFile(manifest.controlPath, JSON.stringify(request, null, 2), { mode: 0o600 })
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
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
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(this._healthPollIntervalMs, timeoutMs)))

      const current = this.processes.get(serviceId)
      if (
        !current
        || current.pid !== expectedPid
        || (current.lifecycleState !== "starting" && current.lifecycleState !== "recovering")
      ) return

      if (!this._isProcessAlive(current.pid)) {
        await this.setFailed(serviceId, "Process exited before becoming ready")
        return
      }

      const health = await this._checkHealth(service)
      if (health.status === "pass") {
        await this.setRunning(serviceId)
        console.log(`[ProcessManager] "${serviceId}" is ready (${health.durationMs}ms)`)
        await this._onReady(service)
        return
      }
    }

    let current = this.processes.get(serviceId)
    if (
      current?.pid !== expectedPid
      || (current.lifecycleState !== "starting" && current.lifecycleState !== "recovering")
    ) return

    const slowMessage = `Still recovering after ${timeoutMs / 1000}s; health checks will continue`
    this.setLifecycleState(serviceId, "recovering", {
      intendedState: "running",
      recoveryReason: slowMessage,
      lastError: undefined,
    })
    await this.saveState()
    console.warn(`[ProcessManager] "${serviceId}" ${slowMessage.toLowerCase()}`)

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, RECOVERY_HEALTH_POLL_INTERVAL_MS))
      current = this.processes.get(serviceId)
      if (!current || current.pid !== expectedPid || current.lifecycleState !== "recovering") return
      if (!this._isProcessAlive(current.pid)) {
        await this.setFailed(serviceId, "Recovery runner exited before becoming ready")
        return
      }
      const identity = await this._verifyRunnerIdentity(current, service)
      if (!identity) {
        await this.setFailed(serviceId, "Recovery runner identity or heartbeat was lost")
        return
      }
      const health = await this._checkHealth(service)
      if (health.status === "pass") {
        await this.setRunning(serviceId)
        console.log(`[ProcessManager] "${serviceId}" recovered and is ready (${health.durationMs}ms)`)
        await this._onReady(service)
        return
      }
    }
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  getProcess(serviceId: string): ServiceProcessState | null {
    return this.processes.get(serviceId) ?? null
  }

  async observe(service: ServiceConfig): Promise<ServiceProcessState | null> {
    const state = this.processes.get(service.id)
    if (!state) return null
    if (state.lifecycleState === "recovering") {
      const health = await this._checkHealth(service)
      const portPid = await this._findPidOnPort(service.port)
      const verified = await this._verifyLaunchRecord(state, service, health.status === "pass", portPid)
      if (verified) {
        await this.setRunning(service.id)
        return this.processes.get(service.id) ?? state
      }
      return state
    }
    if (state.lifecycleState !== "running") return state
    const health = await this._checkHealth(service)
    const portPid = await this._findPidOnPort(service.port)
    const verified = await this._verifyLaunchRecord(state, service, health.status === "pass", portPid)
    if (verified) {
      const updated = {
        ...state,
        pid: verified.runnerPid,
        childPid: verified.childPid,
        lastVerifiedAt: new Date().toISOString(),
      }
      this.processes.set(service.id, updated)
      return updated
    }

    const conflict = health.status === "pass" || Boolean(portPid)
    const updated: ServiceProcessState = {
      ...state,
      lifecycleState: "failed",
      diagnosticCode: conflict ? "SERVICE_PROCESS_OWNERSHIP_CONFLICT" : "SERVICE_INTERRUPTED",
      lastError: conflict
        ? `The current listener${portPid ? ` (PID ${portPid})` : ""} is not owned by the saved SourceManager runner`
        : "The verified SourceManager runner is no longer running",
    }
    this.processes.set(service.id, updated)
    if (!portPid) this.portMap.delete(service.port)
    await this.saveState()
    return updated
  }

  getAllProcesses(): ServiceProcessState[] {
    return Array.from(this.processes.values())
  }

  getOutput(serviceId: string): { runId: string; logDirectory: string } | null {
    return this.outputs.get(serviceId) ?? null
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

  async flushState(): Promise<void> {
    await this.saveState()
  }

  async forget(serviceId: string): Promise<void> {
    const state = this.processes.get(serviceId)
    if (state) this.portMap.delete(state.port)
    this.processes.delete(serviceId)
    await this.saveState()
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

async function findPidOnPort(port: number): Promise<number | null> {
  if (process.platform !== "win32") {
    try {
      const proc = Bun.spawn(
        ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
        { stdout: "pipe", stderr: "ignore" },
      )
      const output = await new Response(proc.stdout).text()
      const pid = Number.parseInt(output.trim().split(/\s+/)[0], 10)
      return Number.isFinite(pid) && pid > 0 ? pid : null
    } catch {
      return null
    }
  }

  // Windows: use netstat to find PID on port.
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

async function isDescendantProcess(pid: number, ancestorPid: number): Promise<boolean> {
  if (pid === ancestorPid) return true
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawn(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
          `$p=${pid};$a=${ancestorPid};while($p -gt 0){if($p -eq $a){exit 0};$p=(Get-CimInstance Win32_Process -Filter "ProcessId=$p").ParentProcessId};exit 1`],
        { stdout: "ignore", stderr: "ignore" },
      )
      return await proc.exited === 0
    }

    let current = pid
    for (let depth = 0; depth < 32 && current > 1; depth += 1) {
      const proc = Bun.spawn(["ps", "-o", "ppid=", "-p", String(current)], { stdout: "pipe", stderr: "ignore" })
      const parent = Number.parseInt((await new Response(proc.stdout).text()).trim(), 10)
      if (parent === ancestorPid) return true
      if (!Number.isFinite(parent) || parent <= 1 || parent === current) return false
      current = parent
    }
  } catch {
    return false
  }
  return false
}

async function restrictRuntimePermissions(directories: string[]): Promise<void> {
  if (process.platform !== "win32") {
    await Promise.all(directories.map((directory) => chmod(directory, 0o700)))
    return
  }

  const username = process.env.USERNAME
  if (!username) throw new Error("USERNAME is required to secure service runner files")
  for (const directory of directories) {
    const proc = spawn(
      "icacls",
      [directory, "/inheritance:r", "/grant:r", `${username}:(OI)(CI)F`],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    )
    let stdout = ""
    let stderr = ""
    proc.stdout?.setEncoding("utf8")
    proc.stderr?.setEncoding("utf8")
    proc.stdout?.on("data", (chunk: string) => { stdout += chunk })
    proc.stderr?.on("data", (chunk: string) => { stderr += chunk })
    const code = await new Promise<number>((resolve, reject) => {
      proc.once("exit", (value) => resolve(value ?? 1))
      proc.once("error", reject)
    })
    if (code !== 0) {
      throw new Error(`Could not secure runner directory: ${stderr.trim() || stdout.trim() || `icacls exited ${code}`}`)
    }
  }
}

export const processManager = new ProcessManager()
