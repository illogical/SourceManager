import { describe, expect, it } from "vitest"
import { commandFingerprint, selectProcessTree, type ProcessInfo } from "../../../src/services/windowsProcessTree"

const snapshot: ProcessInfo[] = [
  { pid: 10, parentPid: 1, creationDate: null, executablePath: "bun.exe", commandLine: "launcher" },
  { pid: 20, parentPid: 10, creationDate: null, executablePath: "bun.exe", commandLine: "backend" },
  { pid: 21, parentPid: 20, creationDate: null, executablePath: "bun.exe", commandLine: "server" },
  { pid: 30, parentPid: 10, creationDate: null, executablePath: "bun.exe", commandLine: "frontend" },
  { pid: 40, parentPid: 20, creationDate: null, executablePath: "bun.exe", commandLine: "runner" },
  { pid: 41, parentPid: 40, creationDate: null, executablePath: "bun.exe", commandLine: "managed service" },
]

describe("selectProcessTree", () => {
  it("protects verified runner subtrees and orders remaining descendants deepest-first", () => {
    const selected = selectProcessTree(snapshot, [10], [40], [10])
    expect(selected.protected).toEqual(new Set([10, 40, 41]))
    expect(selected.terminationOrder).toEqual([21, 30, 20])
  })

  it("does not include unrelated processes", () => {
    const selected = selectProcessTree([...snapshot, {
      pid: 99, parentPid: 1, creationDate: null, executablePath: null, commandLine: null,
    }], [10], [])
    expect(selected.descendants.has(99)).toBe(false)
  })
})

describe("commandFingerprint", () => {
  it("is stable and includes executable and command line", () => {
    expect(commandFingerprint("C:\\BUN.EXE", "bun run start"))
      .toBe(commandFingerprint("c:\\bun.exe", "bun run start"))
    expect(commandFingerprint("bun.exe", "bun run start"))
      .not.toBe(commandFingerprint("bun.exe", "bun run dev"))
  })
})
