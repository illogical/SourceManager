import { describe, expect, it } from "vitest"
import {
  verifyOwnershipSnapshot,
  type SourceManagerOwnership,
} from "../../../src/services/sourceManagerOwnership"
import { commandFingerprint, type ProcessInfo } from "../../../src/services/windowsProcessTree"

function ownership(): SourceManagerOwnership {
  return {
    version: 1,
    mode: "development",
    rootPid: 10,
    backendPid: 20,
    frontendPid: 30,
    processes: [
      {
        pid: 10,
        creationDate: "2026-07-29T00:00:00.000Z",
        executablePath: "bun.exe",
        commandFingerprint: commandFingerprint("bun.exe", "launcher"),
      },
      {
        pid: 20,
        creationDate: "2026-07-29T00:00:01.000Z",
        executablePath: "bun.exe",
        commandFingerprint: commandFingerprint("bun.exe", "backend"),
      },
    ],
    repoPath: process.cwd(),
    apiPort: 17106,
    frontendPort: 17116,
    updatedAt: "2026-07-29T00:00:01.000Z",
  }
}

describe("SourceManager ownership verification", () => {
  it("accepts a recorded live descendant after the launcher has exited", () => {
    const snapshot: ProcessInfo[] = [{
      pid: 20,
      parentPid: 10,
      creationDate: "2026-07-29T00:00:01.000Z",
      executablePath: "bun.exe",
      commandLine: "backend",
    }]
    expect(verifyOwnershipSnapshot(ownership(), snapshot)).toBe(true)
  })

  it("rejects PID reuse with a different creation time", () => {
    const snapshot: ProcessInfo[] = [{
      pid: 20,
      parentPid: 10,
      creationDate: "2026-07-29T01:00:00.000Z",
      executablePath: "bun.exe",
      commandLine: "backend",
    }]
    expect(verifyOwnershipSnapshot(ownership(), snapshot)).toBe(false)
  })

  it("rejects command identity changes", () => {
    const snapshot: ProcessInfo[] = [{
      pid: 20,
      parentPid: 10,
      creationDate: "2026-07-29T00:00:01.000Z",
      executablePath: "bun.exe",
      commandLine: "different command",
    }]
    expect(verifyOwnershipSnapshot(ownership(), snapshot)).toBe(false)
  })
})
