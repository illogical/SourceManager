import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import {
  fingerprintCommand,
  signRunnerStatus,
  verifyRunnerStatus,
  type RunnerManifest,
  type RunnerStatus,
} from "../../../src/services/runnerProtocol"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("runner protocol", () => {
  it("fingerprints command arguments and working directory", () => {
    expect(fingerprintCommand(["bun", "run", "dev"], "/repo"))
      .not.toBe(fingerprintCommand(["bun", "run", "test"], "/repo"))
    expect(fingerprintCommand(["bun", "run", "dev"], "/repo"))
      .not.toBe(fingerprintCommand(["bun", "run", "dev"], "/other"))
  })

  it("authenticates runner status and rejects identity tampering", () => {
    const signed = signRunnerStatus({
      version: 1,
      runId: "run-1",
      serviceId: "service-1",
      runnerPid: 123,
      childPid: 456,
      processCreatedAt: "2026-01-01T00:00:00.000Z",
      commandFingerprint: "abc",
      state: "running",
      heartbeatAt: "2026-01-01T00:00:01.000Z",
      exitCode: null,
      activeSegment: 1,
      activeSegmentBytes: 10,
    }, "secret-token")

    expect(verifyRunnerStatus(signed, "secret-token")).toBe(true)
    expect(verifyRunnerStatus({ ...signed, runId: "other-run" }, "secret-token")).toBe(false)
    expect(verifyRunnerStatus(signed, "wrong-token")).toBe(false)
  })

  it("captures combined output and publishes authenticated exit status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sourcemanager-runner-"))
    directories.push(directory)
    const logDirectory = join(directory, "logs")
    const cwd = resolve("tests/fixtures/runner-service")
    const command = ["bun", "run", "dev"]
    const manifest: RunnerManifest = {
      version: 1,
      runId: "run-fixture",
      serviceId: "fixture-service",
      repoId: "fixture-repo",
      command,
      commandFingerprint: fingerprintCommand(command, cwd),
      cwd,
      port: 39999,
      healthUrl: "http://127.0.0.1:39999/health",
      createdAt: new Date().toISOString(),
      logDirectory,
      statusPath: join(directory, "runner-status.json"),
      controlPath: join(directory, "control.json"),
      controlToken: "fixture-secret",
      maxSegmentBytes: 1024,
      maxRetainedBytes: 4096,
    }
    const manifestPath = join(directory, "manifest.json")
    await writeFile(manifestPath, JSON.stringify(manifest))

    const runner = spawn("bun", [resolve("src/serviceRunner.ts"), manifestPath], {
      stdio: "pipe",
    })
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      runner.once("exit", (code) => resolveExit(code ?? 1))
      runner.once("error", reject)
    })
    expect(exitCode).toBe(0)

    const status = JSON.parse(await readFile(manifest.statusPath, "utf8")) as RunnerStatus
    const output = await readFile(join(logDirectory, "output-0001.log"), "utf8")
    expect(status.state).toBe("exited")
    expect(verifyRunnerStatus(status, manifest.controlToken)).toBe(true)
    expect(output).toContain("fixture stdout")
    expect(output).toContain("fixture stderr")
  })
})
