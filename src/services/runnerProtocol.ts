import { createHash, createHmac, timingSafeEqual } from "node:crypto"

export interface RunnerManifest {
  version: 1
  runId: string
  serviceId: string
  repoId: string
  command: string[]
  commandFingerprint: string
  cwd: string
  port: number
  healthUrl: string
  createdAt: string
  logDirectory: string
  statusPath: string
  controlPath: string
  controlToken: string
  maxSegmentBytes: number
  maxRetainedBytes: number
}

export interface RunnerStatus {
  version: 1
  runId: string
  serviceId: string
  runnerPid: number
  childPid: number | null
  processCreatedAt: string
  commandFingerprint: string
  state: "starting" | "running" | "stopping" | "exited"
  heartbeatAt: string
  exitCode: number | null
  activeSegment: number
  activeSegmentBytes: number
  signature: string
}

export interface RunnerControlRequest {
  action: "stop"
  runId: string
  token: string
  requestedAt: string
}

export function fingerprintCommand(command: string[], cwd: string): string {
  return createHash("sha256").update(JSON.stringify({ command, cwd })).digest("hex")
}

function statusPayload(status: Omit<RunnerStatus, "signature">): string {
  return JSON.stringify(status)
}

export function signRunnerStatus(
  status: Omit<RunnerStatus, "signature">,
  token: string,
): RunnerStatus {
  return {
    ...status,
    signature: createHmac("sha256", token).update(statusPayload(status)).digest("hex"),
  }
}

export function verifyRunnerStatus(status: RunnerStatus, token: string): boolean {
  const { signature, ...unsigned } = status
  const expected = createHmac("sha256", token).update(statusPayload(unsigned)).digest()
  let actual: Buffer
  try {
    actual = Buffer.from(signature, "hex")
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
