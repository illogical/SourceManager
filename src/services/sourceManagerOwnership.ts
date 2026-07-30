import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { verifyRunnerStatus, type RunnerManifest, type RunnerStatus } from "./runnerProtocol"
import {
  commandFingerprint,
  selectProcessTree,
  snapshotProcesses,
  terminateSelectedTree,
  type ProcessInfo,
} from "./windowsProcessTree"
import type { ServiceProcessState } from "../types"

const _dir = import.meta.dir ?? dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(_dir, "..", "..")
const DATA_ROOT = join(REPO_ROOT, "data")
const STATE_PATH = join(DATA_ROOT, "state.json")
const OWNERSHIP_PATH = join(DATA_ROOT, "runtime", "sourcemanager", "ownership.json")

export interface SourceManagerOwnership {
  version: 1
  mode: "development" | "production"
  rootPid: number
  backendPid: number | null
  frontendPid: number | null
  processes: Array<{
    pid: number
    creationDate: string | null
    executablePath: string | null
    commandFingerprint: string
  }>
  repoPath: string
  apiPort: number
  frontendPort: number | null
  updatedAt: string
}

export interface PortInspection {
  port: number
  pid: number | null
  process: ProcessInfo | null
}

export async function writeSourceManagerOwnership(
  mode: SourceManagerOwnership["mode"],
  rootPid: number,
  backendPid: number | null,
  frontendPid: number | null,
  apiPort: number,
  frontendPort: number | null,
): Promise<SourceManagerOwnership> {
  const snapshot = await snapshotProcesses().catch(() => [])
  const pids = [...new Set([rootPid, backendPid, frontendPid].filter((value): value is number => Boolean(value)))]
  const processes = pids.map((pid) => {
    const info = snapshot.find((item) => item.pid === pid)
    return {
      pid,
      creationDate: info?.creationDate ?? null,
      executablePath: info?.executablePath ?? (pid === process.pid ? process.execPath : null),
      commandFingerprint: commandFingerprint(info?.executablePath ?? null, info?.commandLine ?? null),
    }
  })
  const ownership: SourceManagerOwnership = {
    version: 1,
    mode,
    rootPid,
    backendPid,
    frontendPid,
    processes,
    repoPath: REPO_ROOT,
    apiPort,
    frontendPort,
    updatedAt: new Date().toISOString(),
  }
  await mkdir(dirname(OWNERSHIP_PATH), { recursive: true, mode: 0o700 })
  const temporary = `${OWNERSHIP_PATH}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(ownership, null, 2), { mode: 0o600 })
  await rename(temporary, OWNERSHIP_PATH)
  await restrictOwnershipDirectory()
  return ownership
}

export async function readSourceManagerOwnership(): Promise<SourceManagerOwnership | null> {
  try {
    const value = JSON.parse(await readFile(OWNERSHIP_PATH, "utf8")) as SourceManagerOwnership
    if (value.version !== 1 || !value.rootPid || resolve(value.repoPath) !== REPO_ROOT) return null
    return value
  } catch {
    return null
  }
}

export async function clearSourceManagerOwnership(expectedRootPid?: number): Promise<void> {
  if (expectedRootPid) {
    const current = await readSourceManagerOwnership()
    if (current && current.rootPid !== expectedRootPid) return
  }
  await unlink(OWNERSHIP_PATH).catch(() => {})
}

export async function findPortPid(port: number): Promise<number | null> {
  try {
    const proc = Bun.spawn(
      process.platform === "win32"
        ? ["netstat.exe", "-ano", "-p", "TCP"]
        : ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { stdout: "pipe", stderr: "ignore", windowsHide: true },
    )
    const output = await new Response(proc.stdout).text()
    await proc.exited
    if (process.platform !== "win32") {
      const pid = Number.parseInt(output.trim().split(/\s+/)[0], 10)
      return Number.isFinite(pid) && pid > 0 ? pid : null
    }
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes(`:${port} `) || !line.includes("LISTENING")) continue
      const pid = Number.parseInt(line.trim().split(/\s+/).at(-1) ?? "", 10)
      if (Number.isFinite(pid) && pid > 0) return pid
    }
  } catch {
    // A missing inspection tool is treated as an unverifiable port.
  }
  return null
}

export async function inspectPort(port: number, snapshot?: ProcessInfo[]): Promise<PortInspection> {
  const pid = await findPortPid(port)
  const processes = snapshot ?? await snapshotProcesses().catch(() => [])
  return { port, pid, process: pid ? processes.find((item) => item.pid === pid) ?? null : null }
}

export async function recoverVerifiedStaleSourceManager(ports: number[]): Promise<void> {
  const occupied = (await Promise.all(ports.map((port) => inspectPort(port)))).filter((item) => item.pid)
  if (occupied.length === 0) return

  const ownership = await readSourceManagerOwnership()
  const snapshot = await snapshotProcesses().catch((error) => {
    throw new Error(`Cannot inspect occupied SourceManager ports: ${(error as Error).message}`)
  })
  if (!ownership || !verifyOwnershipSnapshot(ownership, snapshot)) {
    throw unverifiedPortError(occupied)
  }
  const descendants = selectProcessTree(snapshot, [ownership.rootPid], [])
  if (occupied.some((item) => !item.pid || !descendants.descendants.has(item.pid))) {
    throw unverifiedPortError(occupied)
  }

  const protectedPids = await verifiedRunnerPids(snapshot)
  const selection = selectProcessTree(snapshot, [ownership.rootPid], protectedPids, [process.pid])
  await terminateSelectedTree(selection)
  await waitForPortsFree(ports, 5_000)
  await clearSourceManagerOwnership(ownership.rootPid)
}

export async function terminateOwnedSourceManagerDescendants(rootPid: number): Promise<void> {
  const snapshot = await snapshotProcesses()
  const protectedPids = await verifiedRunnerPids(snapshot)
  const selection = selectProcessTree(snapshot, [rootPid], protectedPids, [process.pid])
  const failures = (await terminateSelectedTree(selection)).filter((result) => !result.success)
  if (failures.length > 0) {
    throw new Error(failures.map((item) => `PID ${item.pid}: ${item.error}`).join("; "))
  }
}

export async function waitForPortsFree(ports: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let remaining: PortInspection[] = []
  do {
    remaining = (await Promise.all(ports.map((port) => inspectPort(port)))).filter((item) => item.pid)
    if (remaining.length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  } while (Date.now() < deadline)
  throw unverifiedPortError(remaining)
}

export function verifyOwnershipSnapshot(ownership: SourceManagerOwnership, snapshot: ProcessInfo[]): boolean {
  if (resolve(ownership.repoPath) !== REPO_ROOT) return false
  let matched = 0
  for (const saved of ownership.processes) {
    const current = snapshot.find((item) => item.pid === saved.pid)
    if (!current) continue
    if (saved.creationDate && current.creationDate && saved.creationDate !== current.creationDate) return false
    if (commandFingerprint(current.executablePath, current.commandLine) !== saved.commandFingerprint) return false
    matched += 1
  }
  return matched > 0
}

async function verifiedRunnerPids(snapshot: ProcessInfo[]): Promise<number[]> {
  let states: ServiceProcessState[] = []
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8")) as { processes?: Record<string, ServiceProcessState> }
    states = Object.values(parsed.processes ?? {})
  } catch {
    return []
  }
  const protectedPids: number[] = []
  for (const state of states) {
    if (!state.manifestPath || !state.runId || !state.commandFingerprint || !state.processCreatedAt) continue
    try {
      const manifest = JSON.parse(await readFile(state.manifestPath, "utf8")) as RunnerManifest
      const status = JSON.parse(await readFile(manifest.statusPath, "utf8")) as RunnerStatus
      const processInfo = snapshot.find((item) => item.pid === state.pid)
      if (
        processInfo
        && manifest.runId === state.runId
        && manifest.serviceId === state.serviceId
        && status.runnerPid === state.pid
        && status.runId === state.runId
        && status.commandFingerprint === state.commandFingerprint
        && status.processCreatedAt === state.processCreatedAt
        && status.state !== "exited"
        && Date.now() - new Date(status.heartbeatAt).getTime() <= 3_000
        && (
          !processInfo.creationDate
          || Math.abs(
            new Date(processInfo.creationDate).getTime() - new Date(status.processCreatedAt).getTime(),
          ) <= 10_000
        )
        && verifyRunnerStatus(status, manifest.controlToken)
      ) {
        protectedPids.push(state.pid)
      }
    } catch {
      // An unverified runner is not used to suppress SourceManager cleanup.
    }
  }
  return protectedPids
}

function unverifiedPortError(ports: PortInspection[]): Error {
  const detail = ports.map(({ port, pid, process }) =>
    `port ${port}, PID ${pid ?? "unknown"}, executable ${process?.executablePath ?? "unknown"}, command ${process?.commandLine ?? "unknown"}`
  ).join("; ")
  return new Error(
    `SourceManager will not terminate an unverified listener (${detail}). `
    + `Inspect it with: Get-CimInstance Win32_Process -Filter "ProcessId=<PID>" | Select ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate`,
  )
}

async function restrictOwnershipDirectory(): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(dirname(OWNERSHIP_PATH), 0o700).catch(() => {})
    return
  }
  const username = process.env.USERNAME
  if (!username) return
  const proc = Bun.spawn(
    ["icacls.exe", dirname(OWNERSHIP_PATH), "/inheritance:r", "/grant:r", `${username}:(OI)(CI)F`],
    { stdout: "ignore", stderr: "ignore", windowsHide: true },
  )
  await proc.exited
}
