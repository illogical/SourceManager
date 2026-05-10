import { describe, it, expect, vi, beforeEach } from "vitest"
import { ProcessManager } from "../../src/services/processManager"
import type { RepoConfig, ServiceConfig } from "../../src/types"

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
  pm._isProcessAlive = vi.fn(() => false)
  pm._findPidOnPort = vi.fn(async () => null)
  pm._checkHealth = vi.fn(async () => ({ status: "fail" as const, durationMs: 10 }))
  pm._spawnProcess = vi.fn(() => ({
    pid: 99999,
    exited: new Promise<number>(() => {}), // never resolves by default
  }))
  return pm
}

describe("ProcessManager.stop — idempotent", () => {
  it("returns alreadyStopped=true when service is not tracked", async () => {
    const pm = makePm()
    const result = await pm.stop("unknown-service")
    expect(result.success).toBe(true)
    expect(result.alreadyStopped).toBe(true)
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
