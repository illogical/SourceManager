import { join } from "path"
import { detectPackageManager } from "./installer"
import type { PortEntry, ProcessState, ProjectConfig } from "../types"

const STATE_PATH = join(import.meta.dir, "..", "..", "data", "state.json")

interface StateFile {
  processes: Record<string, ProcessState>
}

interface StartResult {
  success: boolean
  message: string
  portKillResult?: { killed: boolean; previousPid: number; error?: string }
}

class ProcessManager {
  private processes = new Map<string, ProcessState>()
  private portMap = new Map<number, string>() // port → projectId

  async init(): Promise<void> {
    await this.loadState()
  }

  // ─── State Persistence ────────────────────────────────────────────────────

  private async loadState(): Promise<void> {
    const file = Bun.file(STATE_PATH)
    if (!(await file.exists())) return

    try {
      const data: StateFile = await file.json()
      for (const [projectId, state] of Object.entries(data.processes ?? {})) {
        if (isProcessAlive(state.pid)) {
          this.processes.set(projectId, state)
          this.portMap.set(state.port, projectId)
        } else {
          console.log(`[ProcessManager] Pruned stale PID ${state.pid} for "${projectId}"`)
        }
      }
    } catch (err) {
      console.warn(`[ProcessManager] Could not load state: ${(err as Error).message}`)
    }
  }

  private async saveState(): Promise<void> {
    const data: StateFile = { processes: Object.fromEntries(this.processes) }
    await Bun.write(STATE_PATH, JSON.stringify(data, null, 2))
  }

  // ─── Port Management ──────────────────────────────────────────────────────

  private async killPort(port: number): Promise<{ killed: boolean; previousPid: number; error?: string }> {
    const existingProjectId = this.portMap.get(port)

    if (existingProjectId) {
      // We own this process — stop it cleanly
      const state = this.processes.get(existingProjectId)
      if (state) {
        console.log(`[ProcessManager] Auto-killing PID ${state.pid} (project "${existingProjectId}") to free port ${port}`)
        const result = await this.killPid(state.pid)
        this.processes.delete(existingProjectId)
        this.portMap.delete(port)
        await this.saveState()
        return { killed: result.success, previousPid: state.pid, error: result.error }
      }
    }

    // Port may be in use by an external process — check with OS
    const externalPid = await findPidOnPort(port)
    if (externalPid) {
      console.log(`[ProcessManager] Auto-killing external PID ${externalPid} on port ${port}`)
      const result = await this.killPid(externalPid)
      return { killed: result.success, previousPid: externalPid, error: result.error }
    }

    return { killed: true, previousPid: 0 } // port was already free
  }

  private async killPid(pid: number): Promise<{ success: boolean; error?: string }> {
    try {
      process.kill(pid, "SIGTERM")
      // Give the process a moment to exit
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (isProcessAlive(pid)) {
        // Force kill if still running
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

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async start(project: ProjectConfig): Promise<StartResult> {
    let portKillResult: StartResult["portKillResult"]

    // Check if port is in use
    const portOwner = this.portMap.get(project.port)
    const externalPid = await findPidOnPort(project.port)

    if (portOwner || externalPid) {
      portKillResult = await this.killPort(project.port)
      if (!portKillResult.killed) {
        return {
          success: false,
          message: `Port ${project.port} is in use and could not be freed: ${portKillResult.error}`,
          portKillResult,
        }
      }
      // Brief wait for port to be fully released
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    // Build start command
    const pm = project.packageManager === "auto"
      ? await detectPackageManager(project.repoPath)
      : project.packageManager

    const command = [pm, "run", project.scriptName]
    console.log(`[ProcessManager] Starting "${project.id}": ${command.join(" ")} in ${project.repoPath}`)

    const proc = Bun.spawn(command, {
      cwd: project.repoPath,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
    })

    const state: ProcessState = {
      projectId: project.id,
      pid: proc.pid,
      port: project.port,
      startedAt: new Date().toISOString(),
      command: command.join(" "),
    }

    this.processes.set(project.id, state)
    this.portMap.set(project.port, project.id)
    await this.saveState()

    // Monitor for immediate exit (crash at startup)
    proc.exited.then(async (code) => {
      if (this.processes.get(project.id)?.pid === proc.pid) {
        console.error(`[ProcessManager] Process "${project.id}" (PID ${proc.pid}) exited with code ${code}`)
        this.processes.delete(project.id)
        this.portMap.delete(project.port)
        await this.saveState()
      }
    })

    return {
      success: true,
      message: `Started "${project.id}" with PID ${proc.pid} on port ${project.port}`,
      portKillResult,
    }
  }

  async stop(projectId: string): Promise<{ success: boolean; message: string }> {
    const state = this.processes.get(projectId)
    if (!state) {
      return { success: false, message: `No running process found for "${projectId}"` }
    }

    console.log(`[ProcessManager] Stopping "${projectId}" (PID ${state.pid})`)
    const result = await this.killPid(state.pid)
    this.processes.delete(projectId)
    this.portMap.delete(state.port)
    await this.saveState()

    if (!result.success) {
      return { success: false, message: `Stop attempted but may have failed: ${result.error}` }
    }
    return { success: true, message: `Stopped "${projectId}" (PID ${state.pid})` }
  }

  async restart(project: ProjectConfig): Promise<StartResult> {
    // Stop if running
    const state = this.processes.get(project.id)
    if (state) {
      await this.stop(project.id)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    return this.start(project)
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getProcess(projectId: string): ProcessState | null {
    return this.processes.get(projectId) ?? null
  }

  getAllProcesses(): ProcessState[] {
    return Array.from(this.processes.values())
  }

  getPortEntries(): PortEntry[] {
    return Array.from(this.portMap.entries()).map(([port, projectId]) => {
      const state = this.processes.get(projectId)
      return {
        port,
        projectId,
        pid: state?.pid ?? 0,
        status: state ? "running" : "stopped",
      }
    })
  }

  isRunning(projectId: string): boolean {
    const state = this.processes.get(projectId)
    if (!state) return false
    return isProcessAlive(state.pid)
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

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
