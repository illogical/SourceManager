import { spawn, type ChildProcess } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pipePrefixed } from "./services/consoleOutput"
import {
  clearSourceManagerOwnership,
  recoverVerifiedStaleSourceManager,
  terminateOwnedSourceManagerDescendants,
  waitForPortsFree,
  writeSourceManagerOwnership,
} from "./services/sourceManagerOwnership"

const GRACEFUL_TIMEOUT_MS = 5_000
const PORT_TIMEOUT_MS = 5_000
const repoRoot = resolve(import.meta.dir, "..")
const ports = await configuredPorts()

await recoverVerifiedStaleSourceManager([ports.api, ports.frontend])

process.env.SOURCEMANAGER_LAUNCH_MODE = "development"
process.env.SOURCEMANAGER_OWNER_ROOT_PID = String(process.pid)

let shuttingDown = false
let forcing = false
let finishing = false
let exitCode = 0

const backend = launch("backend", ["run", "dev:backend"])
const frontend = launch("frontend", ["run", "dev:frontend"])
const children = [backend, frontend]

await writeSourceManagerOwnership(
  "development",
  process.pid,
  backend.pid ?? null,
  frontend.pid ?? null,
  ports.api,
  ports.frontend,
)

process.on("SIGINT", () => requestShutdown("Ctrl+C"))
process.on("SIGTERM", () => requestShutdown("SIGTERM"))

function launch(name: "backend" | "frontend", args: string[]): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      SOURCEMANAGER_LAUNCH_MODE: "development",
      SOURCEMANAGER_OWNER_ROOT_PID: String(process.pid),
    },
    detached: false,
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"],
  })
  pipePrefixed(child.stdout, name, process.stdout)
  pipePrefixed(child.stderr, name, process.stderr)
  child.once("error", (error) => {
    console.error(`[SourceManager] ${name} failed to launch: ${error.message}`)
    exitCode = 1
    requestShutdown(`${name} launch failure`)
  })
  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[SourceManager] ${name} exited unexpectedly (${signal ?? `code ${code ?? 1}`})`)
      exitCode = code ?? 1
      requestShutdown(`${name} exit`)
    }
  })
  return child
}

function requestShutdown(reason: string): void {
  if (shuttingDown) {
    if (!forcing) {
      forcing = true
      console.warn(`[SourceManager] Repeated shutdown request (${reason}); forcing SourceManager processes`)
      void forceAndVerify()
    }
    return
  }
  shuttingDown = true
  console.log(`[SourceManager] Shutdown requested (${reason}); managed services will remain running`)

  // Ctrl+C is broadcast to processes sharing this console. For non-console
  // shutdown triggers, signal only the direct development children.
  if (reason !== "Ctrl+C") {
    for (const child of children) {
      if (isRunning(child)) child.kill("SIGTERM")
    }
  }

  setTimeout(() => {
    if (!forcing) {
      forcing = true
      console.warn("[SourceManager] Graceful window ended; selectively terminating development processes")
      void forceAndVerify()
    }
  }, GRACEFUL_TIMEOUT_MS)

  void finishIfExited()
}

async function forceAndVerify(): Promise<void> {
  try {
    await terminateOwnedSourceManagerDescendants(process.pid)
  } catch (error) {
    console.error(`[SourceManager] Selective process cleanup failed: ${(error as Error).message}`)
    exitCode = 1
  }
  await finishAndExit()
}

async function finishIfExited(): Promise<void> {
  while (Date.now() && children.some(isRunning) && !forcing) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!forcing) await finishAndExit()
}

async function finishAndExit(): Promise<void> {
  if (finishing) return
  finishing = true
  try {
    await waitForPortsFree([ports.api, ports.frontend], PORT_TIMEOUT_MS)
    await clearSourceManagerOwnership(process.pid)
    console.log("[SourceManager] API and Vite ports released; development processes stopped")
  } catch (error) {
    console.error(`[SourceManager] Shutdown verification failed: ${(error as Error).message}`)
    exitCode = 1
  }
  process.exit(exitCode)
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

async function configuredPorts(): Promise<{ api: number; frontend: number }> {
  const api = Number.parseInt(process.env.SOURCEMANAGER_PORT ?? "17106", 10)
  let frontend = 5173
  try {
    const config = JSON.parse(await readFile(resolve(repoRoot, "data", "projects.json"), "utf8")) as {
      server?: { frontendPort?: number }
    }
    if (Number.isInteger(config.server?.frontendPort)) frontend = config.server!.frontendPort!
  } catch {
    // Config validation in the backend will report malformed project data.
  }
  return { api, frontend }
}
