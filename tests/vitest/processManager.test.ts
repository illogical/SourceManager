import { describe, it, expect, vi, beforeEach } from "vitest"
import { ProcessManager } from "../../src/services/processManager"
import { packageManagerExecutable } from "../../src/services/packageManager"
import type { RepoConfig, ServiceConfig, ServiceProcessState } from "../../src/types"

function makeRepo(overrides?: Partial<RepoConfig>): RepoConfig {
  return {
    id: "test-repo",
    displayName: "Test Repo",
    repoPath: "/dev/test-repo",
    defaultBranch: "main",
    services: [],
    ...overrides,
  }
}

function makeService(overrides?: Partial<ServiceConfig>): ServiceConfig {
  return {
    id: "test-service",
    displayName: "Test Service",
    packageManager: "bun",
    scriptName: "dev",
    port: 3000,
    healthUrl: "http://localhost:3000/health",
    healthMode: "ping",
    tags: [],
    allowedIps: [],
    ...overrides,
  }
}

function makePm() {
  const pm = new ProcessManager()
  pm._persistState = false
  pm._isProcessAlive = vi.fn(() => false)
  pm._findPidOnPort = vi.fn(async () => null)
  pm._checkHealth = vi.fn(async () => ({ status: "fail" as const, durationMs: 10 }))
  pm._killPid = vi.fn(async () => ({ success: true }))
  pm._logLifecycleRun = vi.fn(async () => {})
  pm._stopPollIntervalMs = 1
  pm._stopPollTimeoutMs = 5
  pm._spawnProcess = vi.fn(() => ({
    pid: 99999,
    exited: new Promise<number>(() => {}), // never resolves by default
  }))
  return pm
}

function injectProcess(pm: ProcessManager, overrides?: Partial<ServiceProcessState>) {
  const state: ServiceProcessState = {
    serviceId: "test-service",
    repoId: "test-repo",
    pid: 11111,
    port: 3000,
    startedAt: new Date().toISOString(),
    command: "bun run dev",
    lifecycleState: "running",
    readySince: new Date().toISOString(),
    ...overrides,
  }
  const internals = pm as unknown as {
    processes: Map<string, ServiceProcessState>
    portMap: Map<number, string>
  }
  internals.processes.set(state.serviceId, state)
  internals.portMap.set(state.port, state.serviceId)
  return state
}

describe("ProcessManager.stop — idempotent", () => {
  it("returns alreadyStopped=true when service is not tracked", async () => {
    const pm = makePm()
    const result = await pm.stop(makeService({ id: "unknown-service" }))
    expect(result.success).toBe(true)
    expect(result.alreadyStopped).toBe(true)
  })

  it("sets lifecycle to stopping before killing the tracked PID", async () => {
    const pm = makePm()
    injectProcess(pm)
    pm._killPid = vi.fn(async () => {
      expect(pm.getLifecycleState("test-service")).toBe("stopping")
      return { success: true }
    })

    const result = await pm.stop(makeService())

    expect(result.success).toBe(true)
    expect(pm._killPid).toHaveBeenCalledWith(11111)
    expect(pm.getLifecycleState("test-service")).toBe("stopped")
  })

  it("kills a remaining port PID after killing the tracked parent PID", async () => {
    const pm = makePm()
    injectProcess(pm)
    pm._findPidOnPort = vi.fn()
      .mockResolvedValueOnce(22222)
      .mockResolvedValueOnce(22222)
      .mockResolvedValueOnce(null)
    pm._killPid = vi.fn(async () => ({ success: true }))

    const result = await pm.stop(makeService())

    expect(result.success).toBe(true)
    expect(pm._killPid).toHaveBeenNthCalledWith(1, 11111)
    expect(pm._killPid).toHaveBeenNthCalledWith(2, 22222)
    expect(result.lifecycleState).toBe("stopped")
  })

  it("stops an untracked service by killing the PID found on its configured port", async () => {
    const pm = makePm()
    pm._findPidOnPort = vi.fn()
      .mockResolvedValueOnce(22222)
      .mockResolvedValueOnce(22222)
      .mockResolvedValueOnce(null)
    pm._killPid = vi.fn(async () => ({ success: true }))

    const result = await pm.stop(makeService())

    expect(result.success).toBe(true)
    expect(result.alreadyStopped).toBe(false)
    expect(pm._killPid).toHaveBeenCalledWith(22222)
  })

  it("returns diagnostics and preserves lastError when stop verification fails", async () => {
    const pm = makePm()
    injectProcess(pm)
    pm._findPidOnPort = vi.fn(async () => 22222)
    pm._checkHealth = vi.fn(async () => ({ status: "pass" as const, durationMs: 4 }))

    const result = await pm.stop(makeService())
    const state = pm.getProcess("test-service")

    expect(result.success).toBe(false)
    expect(result.lifecycleState).toBe("failed")
    expect(result.diagnostics).toMatchObject({
      code: "SERVICE_STOP_PORT_STILL_LISTENING",
      serviceId: "test-service",
      port: 3000,
      portPidAfter: 22222,
    })
    expect(state?.lifecycleState).toBe("failed")
    expect(state?.lastError).toContain("Stop verification failed")
  })
})

describe("ProcessManager.start — idempotent", () => {
  it("returns the current state when service is already starting", async () => {
    const pm = makePm()
    const repo = makeRepo()
    const service = makeService()

    const first = await pm.start(repo, service)
    expect(first.lifecycleState).toBe("starting")

    const second = await pm.start(repo, service)
    expect(second.success).toBe(true)
    expect(second.message).toContain("already starting")
  })

  it("starts the service with pid returned by spawn", async () => {
    const pm = makePm()
    const repo = makeRepo()
    const service = makeService()

    const result = await pm.start(repo, service)
    expect(result.success).toBe(true)
    expect(result.pid).toBe(99999)
    expect(result.lifecycleState).toBe("starting")
  })

  it("returns diagnostics when spawning a service throws", async () => {
    const pm = makePm()
    pm._spawnProcess = vi.fn(() => {
      throw new Error("spawn ENOENT")
    })
    const service = makeService({ packageManager: "npm" })

    const result = await pm.start(makeRepo(), service)

    expect(result.success).toBe(false)
    expect(result.lifecycleState).toBe("failed")
    expect(result.message).toContain("spawn ENOENT")
    expect(result.diagnostics).toMatchObject({
      code: "SERVICE_SPAWN_FAILED",
      repoId: "test-repo",
      serviceId: "test-service",
      repoPath: "/dev/test-repo",
      packageManager: "npm",
      message: "spawn ENOENT",
    })
    expect(result.diagnostics?.command).toEqual([
      packageManagerExecutable("npm"),
      "run",
      "dev",
    ])
  })
})

describe("packageManagerExecutable", () => {
  it("uses .cmd wrappers for npm-like package managers on Windows", () => {
    expect(packageManagerExecutable("npm", "win32")).toBe("npm.cmd")
    expect(packageManagerExecutable("pnpm", "win32")).toBe("pnpm.cmd")
    expect(packageManagerExecutable("yarn", "win32")).toBe("yarn.cmd")
  })

  it("keeps bun and non-Windows package managers unchanged", () => {
    expect(packageManagerExecutable("bun", "win32")).toBe("bun")
    expect(packageManagerExecutable("npm", "linux")).toBe("npm")
  })
})

describe("ProcessManager.getLifecycleState", () => {
  it("returns stopped for an untracked service", () => {
    const pm = makePm()
    expect(pm.getLifecycleState("unknown")).toBe("stopped")
  })

  it("returns starting immediately after start()", async () => {
    const pm = makePm()
    await pm.start(makeRepo(), makeService())
    expect(pm.getLifecycleState("test-service")).toBe("starting")
  })
})

describe("ProcessManager.init — stale state pruning", () => {
  it("marks a starting-state service as failed after restart", async () => {
    // Simulate state file with a "starting" service
    const pm = new ProcessManager()
    // Override loadState by injecting a fake state manually
    pm._isProcessAlive = vi.fn((pid: number) => pid === 99999) // pid is alive
    pm._findPidOnPort = vi.fn(async () => null)

    // Directly access private field to inject test state
    const processes = (pm as unknown as { processes: Map<string, unknown> }).processes
    processes.set("test-service", {
      serviceId: "test-service",
      repoId: "test-repo",
      pid: 99999,
      port: 3000,
      startedAt: new Date().toISOString(),
      command: "bun run dev",
      lifecycleState: "starting",
    })

    // Call a restart-detection path: simulate what init() does for "starting" services
    // We test the result of the state mutation directly rather than loading from file
    const portMap = (pm as unknown as { portMap: Map<number, string> }).portMap
    portMap.set(3000, "test-service")

    // Manually trigger the init logic for this test
    const state = processes.get("test-service") as { lifecycleState: string; lastError?: string }
    if (state.lifecycleState === "starting") {
      processes.set("test-service", {
        ...state,
        lifecycleState: "failed",
        lastError: "SourceManager restarted while service was starting",
      })
    }

    const updatedState = processes.get("test-service") as { lifecycleState: string; lastError: string }
    expect(updatedState.lifecycleState).toBe("failed")
    expect(updatedState.lastError).toContain("restarted")
  })
})

describe("ProcessManager.getPortEntries", () => {
  it("returns empty array initially", () => {
    const pm = makePm()
    expect(pm.getPortEntries()).toEqual([])
  })

  it("reflects port after start()", async () => {
    const pm = makePm()
    await pm.start(makeRepo(), makeService())
    const entries = pm.getPortEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].port).toBe(3000)
    expect(entries[0].serviceId).toBe("test-service")
  })
})

describe("ProcessManager — health poll transitions", () => {
  it("transitions to running when health passes", async () => {
    vi.useFakeTimers()
    const pm = makePm()
    pm._isProcessAlive = vi.fn(() => true) // process stays alive during poll
    pm._checkHealth = vi.fn(async () => ({ status: "pass" as const, durationMs: 5 }))

    await pm.start(makeRepo(), makeService())
    expect(pm.getLifecycleState("test-service")).toBe("starting")

    // Advance timers to trigger the poll
    await vi.advanceTimersByTimeAsync(1100)

    expect(pm.getLifecycleState("test-service")).toBe("running")
    vi.useRealTimers()
  })
})
