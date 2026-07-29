import { appendFile, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { basename, join } from "node:path"
import type { RunnerControlRequest, RunnerManifest, RunnerStatus } from "./services/runnerProtocol"
import { fingerprintCommand, signRunnerStatus } from "./services/runnerProtocol"

const manifestPath = process.argv[2]
if (!manifestPath) throw new Error("Runner manifest path is required")

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RunnerManifest
validateManifest(manifest)
await mkdir(manifest.logDirectory, { recursive: true, mode: 0o700 })

let segment = 1
let segmentBytes = await existingSize(segmentPath(segment))
let state: RunnerStatus["state"] = "starting"
let exitCode: number | null = null
let stopping = false
let outputQueue = Promise.resolve()
let finalized = false

const childExecutable = process.platform === "win32" ? "cmd.exe" : manifest.command[0]
const childArguments = process.platform === "win32"
  ? ["/d", "/s", "/c", manifest.command.join(" ")]
  : manifest.command.slice(1)
const child = spawn(childExecutable, childArguments, {
  cwd: manifest.cwd,
  env: process.env,
  detached: process.platform !== "win32",
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
})

state = "running"
child.stdout?.on("data", (chunk: Buffer) => { outputQueue = outputQueue.then(() => appendOutput(chunk)) })
child.stderr?.on("data", (chunk: Buffer) => { outputQueue = outputQueue.then(() => appendOutput(chunk)) })
child.on("error", (error) => {
  outputQueue = outputQueue.then(() => appendOutput(Buffer.from(`[runner] ${error.message}\n`)))
  void finalize(1)
})

const heartbeat = setInterval(() => { void publishStatus() }, 500)
const controls = setInterval(() => { void checkControl() }, 250)
await publishStatus()

child.on("exit", (code) => { void finalize(code ?? (stopping ? 0 : 1)) })

async function finalize(code: number): Promise<void> {
  if (finalized) return
  finalized = true
  await outputQueue
  exitCode = code
  state = "exited"
  clearInterval(heartbeat)
  clearInterval(controls)
  await publishStatus()
  process.exit(code)
}

async function appendOutput(chunk: Buffer): Promise<void> {
  if (segmentBytes > 0 && segmentBytes + chunk.byteLength > manifest.maxSegmentBytes) {
    segment += 1
    segmentBytes = 0
    await publishStatus()
  }
  await appendFile(segmentPath(segment), chunk, { mode: 0o600 })
  segmentBytes += chunk.byteLength
  await enforceRetention()
}

async function publishStatus(): Promise<void> {
  const unsigned: Omit<RunnerStatus, "signature"> = {
    version: 1,
    runId: manifest.runId,
    serviceId: manifest.serviceId,
    runnerPid: process.pid,
    childPid: child.pid ?? null,
    processCreatedAt: manifest.createdAt,
    commandFingerprint: manifest.commandFingerprint,
    state,
    heartbeatAt: new Date().toISOString(),
    exitCode,
    activeSegment: segment,
    activeSegmentBytes: segmentBytes,
  }
  const temporary = `${manifest.statusPath}.tmp`
  await writeFile(temporary, JSON.stringify(signRunnerStatus(unsigned, manifest.controlToken), null, 2), { mode: 0o600 })
  await rename(temporary, manifest.statusPath)
}

async function checkControl(): Promise<void> {
  let request: RunnerControlRequest
  try {
    request = JSON.parse(await readFile(manifest.controlPath, "utf8")) as RunnerControlRequest
  } catch {
    return
  }
  if (request.action !== "stop" || request.runId !== manifest.runId || request.token !== manifest.controlToken) return
  await unlink(manifest.controlPath).catch(() => {})
  stopping = true
  state = "stopping"
  await publishStatus()
  await stopChildTree(child.pid)
}

async function stopChildTree(pid: number | undefined): Promise<void> {
  if (!pid) return
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    await new Promise<void>((resolve) => killer.once("exit", () => resolve()))
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try { process.kill(pid, "SIGTERM") } catch {}
  }
}

async function enforceRetention(): Promise<void> {
  let total = 0
  for (let current = segment; current >= 1; current -= 1) {
    const path = segmentPath(current)
    const size = await existingSize(path)
    total += size
    if (current !== segment && total > manifest.maxRetainedBytes) {
      await unlink(path).catch(() => {})
    }
  }
}

function segmentPath(value: number): string {
  return join(manifest.logDirectory, `output-${String(value).padStart(4, "0")}.log`)
}

async function existingSize(path: string): Promise<number> {
  try { return (await stat(path)).size } catch { return 0 }
}

function validateManifest(value: RunnerManifest): void {
  if (value.version !== 1 || !value.runId || !value.serviceId || !value.controlToken) {
    throw new Error("Invalid runner manifest identity")
  }
  if (!Array.isArray(value.command) || value.command.length < 2 || value.command.some((part) => typeof part !== "string" || !part)) {
    throw new Error("Invalid runner command")
  }
  const executable = basename(value.command[0]).toLowerCase()
  if (!["bun", "bun.exe", "npm", "npm.cmd", "yarn", "yarn.cmd", "pnpm", "pnpm.cmd"].includes(executable)
    || value.command.length !== 3
    || value.command[1] !== "run"
    || !/^[A-Za-z0-9:_-]+$/.test(value.command[2])) {
    throw new Error("Runner manifest is not a validated package-manager run command")
  }
  if (value.commandFingerprint !== fingerprintCommand(value.command, value.cwd)) {
    throw new Error("Runner command fingerprint mismatch")
  }
  if (basename(value.statusPath) !== "runner-status.json" || basename(value.controlPath) !== "control.json") {
    throw new Error("Invalid runner runtime paths")
  }
  void chmod(manifestPath, 0o600).catch(() => {})
}
