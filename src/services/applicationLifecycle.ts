import { getConfig } from "../config"
import { processManager } from "./processManager"
import { beginApplicationShutdown } from "./applicationState"
import { flushRequestLogs } from "./requestLogger"
import {
  clearSourceManagerOwnership,
  terminateOwnedSourceManagerDescendants,
  waitForPortsFree,
} from "./sourceManagerOwnership"

const GRACEFUL_TIMEOUT_MS = 5_000
const PORT_RELEASE_TIMEOUT_MS = 5_000
const FLUSH_TIMEOUT_MS = 1_500

interface StoppableServer {
  stop(closeActiveConnections?: boolean): void | Promise<void>
}

let server: StoppableServer | null = null
let shutdownPromise: Promise<void> | null = null
let forceRequested = false
let forcedExitStarted = false

export function configureApplicationLifecycle(value: StoppableServer): void {
  server = value
}

export function requestApplicationShutdown(reason: string): Promise<void> {
  if (shutdownPromise) {
    console.warn(`[shutdown] Repeated shutdown request (${reason}); forcing SourceManager shutdown`)
    forceRequested = true
    if (!forcedExitStarted) {
      forcedExitStarted = true
      void forceApplicationExit()
    }
    return shutdownPromise
  }

  beginApplicationShutdown()
  shutdownPromise = runShutdown(reason)
  return shutdownPromise
}

export function scheduleApplicationShutdown(reason: string): void {
  setTimeout(() => {
    void requestApplicationShutdown(reason)
  }, 50)
}

async function runShutdown(reason: string): Promise<void> {
  const mode = process.env.SOURCEMANAGER_LAUNCH_MODE === "development" ? "development" : "production"
  const rootPid = Number.parseInt(process.env.SOURCEMANAGER_OWNER_ROOT_PID ?? "", 10) || process.pid
  const port = getConfig().server.port
  console.log(`[shutdown] Requested by ${reason}; managed services will remain running`)
  console.log("[shutdown] Flushing SourceManager state and logs")

  await Promise.all([
    withTimeout(processManager.flushState(), FLUSH_TIMEOUT_MS),
    withTimeout(flushRequestLogs(), FLUSH_TIMEOUT_MS),
  ])

  console.log(`[shutdown] Closing HTTP server on port ${port} (5s graceful window)`)
  const graceful = Promise.resolve(server?.stop(false))
  const gracefulResult = await Promise.race([
    graceful.then(() => "closed" as const).catch(() => "failed" as const),
    delay(GRACEFUL_TIMEOUT_MS).then(() => "timeout" as const),
  ])

  if (gracefulResult !== "closed" || forceRequested) {
    console.warn("[shutdown] Graceful window ended; closing active HTTP connections")
    await forceServerClose()
  }

  if (mode === "production") {
    try {
      await terminateOwnedSourceManagerDescendants(rootPid)
    } catch (error) {
      console.warn(`[shutdown] Selective descendant cleanup was unavailable: ${(error as Error).message}`)
    }
  }

  try {
    console.log(`[shutdown] Verifying port ${port} is free`)
    await waitForPortsFree([port], PORT_RELEASE_TIMEOUT_MS)
    await clearSourceManagerOwnership(rootPid)
    console.log(`[shutdown] Port ${port} released; shutdown complete`)
    process.exitCode = 0
  } catch (error) {
    console.error(`[shutdown] Verification failed: ${(error as Error).message}`)
    process.exitCode = 1
  }

  // Let pending console output flush before ending the Bun process. The
  // development launcher performs its own frontend/tree verification.
  setTimeout(() => process.exit(process.exitCode ?? 0), 25)
}

async function forceServerClose(): Promise<void> {
  try {
    await server?.stop(true)
  } catch {
    // Port verification below is the authoritative shutdown result.
  }
}

async function forceApplicationExit(): Promise<void> {
  const mode = process.env.SOURCEMANAGER_LAUNCH_MODE === "development" ? "development" : "production"
  const rootPid = Number.parseInt(process.env.SOURCEMANAGER_OWNER_ROOT_PID ?? "", 10) || process.pid
  const port = getConfig().server.port
  await forceServerClose()
  if (mode === "production") {
    await terminateOwnedSourceManagerDescendants(rootPid).catch((error) => {
      console.warn(`[shutdown] Forced selective cleanup was incomplete: ${(error as Error).message}`)
    })
  }
  try {
    await waitForPortsFree([port], PORT_RELEASE_TIMEOUT_MS)
    await clearSourceManagerOwnership(rootPid)
    console.log(`[shutdown] Forced shutdown released port ${port}`)
    process.exit(0)
  } catch (error) {
    console.error(`[shutdown] Forced shutdown verification failed: ${(error as Error).message}`)
    process.exit(1)
  }
}

async function withTimeout(value: Promise<unknown>, timeoutMs: number): Promise<void> {
  await Promise.race([value.catch(() => {}), delay(timeoutMs)])
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
