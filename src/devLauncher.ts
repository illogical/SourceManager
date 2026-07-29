import { spawn, type ChildProcess } from "node:child_process"

const FORCE_EXIT_TIMEOUT_MS = 3_000
const executable = process.execPath
let shuttingDown = false
let exitCode = 0
let forceExitTimer: ReturnType<typeof setTimeout> | null = null

const backend = launch("backend", ["run", "src/index.ts"])
const frontend = launch("frontend", ["x", "vite", "--config", "frontend/vite.config.ts"])
const children = [backend, frontend]

process.on("SIGINT", () => requestShutdown("SIGINT"))
process.on("SIGTERM", () => requestShutdown("SIGTERM"))

function launch(name: string, args: string[]): ChildProcess {
  const child = spawn(executable, args, {
    cwd: process.cwd(),
    env: process.env,
    detached: false,
    windowsHide: false,
    stdio: "inherit",
  })

  child.once("error", (error) => {
    console.error(`[SourceManager] ${name} failed to launch: ${error.message}`)
    exitCode = 1
    requestShutdown("child error")
  })
  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(
        `[SourceManager] ${name} exited unexpectedly (${signal ?? `code ${code ?? 1}`}); stopping SourceManager`,
      )
      exitCode = code ?? 1
      requestShutdown(`${name} exit`)
      return
    }
    finishWhenChildrenExit()
  })

  return child
}

function requestShutdown(reason: string): void {
  if (shuttingDown) {
    console.warn(`[SourceManager] Repeated shutdown request (${reason}); forcing top-level processes to exit`)
    forceTopLevelProcesses()
    process.exit(exitCode || 1)
  }

  shuttingDown = true
  console.log(`[SourceManager] Shutdown requested (${reason}); stopping backend and frontend`)
  for (const child of children) stopTopLevelProcess(child, "SIGTERM")

  forceExitTimer = setTimeout(() => {
    const remaining = children.filter(isRunning)
    if (remaining.length > 0) {
      console.warn(`[SourceManager] ${remaining.length} top-level process(es) did not exit; forcing them now`)
      forceTopLevelProcesses()
    }
    console.log("[SourceManager] Development processes stopped")
    process.exit(exitCode)
  }, FORCE_EXIT_TIMEOUT_MS)

  finishWhenChildrenExit()
}

function forceTopLevelProcesses(): void {
  for (const child of children) stopTopLevelProcess(child, "SIGKILL")
}

function stopTopLevelProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!isRunning(child)) return
  try {
    // On Windows ChildProcess.kill terminates this PID only. Deliberately do
    // not use taskkill /T: managed service runners must survive SourceManager.
    child.kill(signal)
  } catch {
    // The process may have exited between the liveness check and kill request.
  }
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

function finishWhenChildrenExit(): void {
  if (!shuttingDown || children.some(isRunning)) return
  if (forceExitTimer) clearTimeout(forceExitTimer)
  console.log("[SourceManager] Development processes stopped")
  process.exit(exitCode)
}
