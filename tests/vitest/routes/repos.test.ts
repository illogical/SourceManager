import { describe, it, expect, vi, beforeEach } from "vitest"
import type { RepoConfig, ServiceConfig, ServiceProcessState } from "../../../src/types"

// ── Minimal mocks ─────────────────────────────────────────────────────────────

const testRepo: RepoConfig = {
  id: "my-repo",
  displayName: "My Repo",
  repoPath: "/dev/my-repo",
  defaultBranch: "main",
  services: [],
}

const testService: ServiceConfig = {
  id: "my-repo-web",
  displayName: "Web",
  packageManager: "bun",
  scriptName: "dev",
  port: 3000,
  healthUrl: "http://localhost:3000/health",
  healthMode: "ping",
  tags: ["web"],
  allowedIps: [],
}

const testRepoWithService: RepoConfig = { ...testRepo, services: [testService] }

vi.mock("../../../src/config", () => ({
  getConfig: vi.fn(() => ({ repos: [testRepoWithService] })),
  requireRepo: vi.fn((id: string) => {
    if (id === testRepo.id) return testRepoWithService
    const err = new Error(`Repo not found: "${id}"`)
    throw err
  }),
  requireService: vi.fn((id: string) => {
    if (id === testService.id) return { repo: testRepoWithService, service: testService }
    const err = new Error(`Service not found: "${id}"`)
    throw err
  }),
  RepoNotFoundError: class RepoNotFoundError extends Error {},
  ServiceNotFoundError: class ServiceNotFoundError extends Error {},
}))

vi.mock("../../../src/services/processManager", () => ({
  processManager: {
    getProcess: vi.fn((): ServiceProcessState | null => null),
    observe: vi.fn(async (): Promise<ServiceProcessState | null> => null),
    getAllProcesses: vi.fn(() => []),
    getOutput: vi.fn(() => null),
    isRunning: vi.fn(() => false),
    start: vi.fn(async () => ({ success: true, message: "Started", lifecycleState: "starting", pid: 1234 })),
    stop: vi.fn(async () => ({ success: true, alreadyStopped: false, message: "Stopped" })),
    restart: vi.fn(async () => ({ success: true, message: "Restarted", lifecycleState: "starting", pid: 1234 })),
  },
}))

vi.mock("../../../src/services/healthCheck", () => ({
  checkHealth: vi.fn(async () => ({ status: "fail" as const, durationMs: 5 })),
}))

vi.mock("../../../src/services/runLogger", () => ({
  readRecentLogs: vi.fn(async () => []),
}))

vi.mock("../../../src/services/statusCoordinator", () => ({
  statusCoordinator: {
    getObservation: vi.fn(() => ({
      availability: { state: "unhealthy" },
      management: { state: "unmanaged" },
      checkedAt: new Date(0).toISOString(),
      healthDurationMs: 5,
      healthError: "not running",
      listenerPid: null,
      runnerPid: null,
      runnerHeartbeatAt: null,
      diagnosticCode: null,
      message: null,
    })),
    refreshService: vi.fn(),
    refreshTailscale: vi.fn(),
  },
}))

vi.mock("../../../src/services/applicationLifecycle", () => ({
  scheduleApplicationShutdown: vi.fn(),
}))

beforeEach(async () => {
  vi.restoreAllMocks()
  const config = await import("../../../src/config")
  const { processManager } = await import("../../../src/services/processManager")
  const healthCheck = await import("../../../src/services/healthCheck")
  const { statusCoordinator } = await import("../../../src/services/statusCoordinator")
  vi.spyOn(config, "getConfig").mockReturnValue({
    server: { port: 17106, token: "test-token", allowedIps: [] },
    repos: [testRepoWithService],
  })
  vi.spyOn(config, "requireRepo").mockImplementation((id: string) => {
    if (id === testRepo.id) return testRepoWithService
    throw new Error(`Repo not found: "${id}"`)
  })
  vi.spyOn(config, "requireService").mockImplementation((id: string) => {
    if (id === testService.id) return { repo: testRepoWithService, service: testService }
    throw new Error(`Service not found: "${id}"`)
  })
  vi.spyOn(processManager, "getProcess").mockReturnValue(null)
  vi.spyOn(processManager, "getOutput").mockReturnValue(null)
  vi.spyOn(processManager, "observe").mockResolvedValue(null)
  vi.spyOn(processManager, "start").mockResolvedValue({ success: true, message: "Started", lifecycleState: "starting", pid: 1234 })
  vi.spyOn(processManager, "stop").mockResolvedValue({ success: true, alreadyStopped: false, message: "Stopped", lifecycleState: "stopped" })
  vi.spyOn(processManager, "restart").mockResolvedValue({ success: true, message: "Restarted", lifecycleState: "starting", pid: 1234 })
  vi.spyOn(healthCheck, "checkHealth").mockResolvedValue({ status: "fail", durationMs: 5 })
  vi.mocked(statusCoordinator.getObservation).mockReturnValue({
    availability: { state: "unhealthy" },
    management: { state: "unmanaged" },
    checkedAt: new Date(0).toISOString(),
    healthDurationMs: 5,
    healthError: "not running",
    listenerPid: null,
    runnerPid: null,
    runnerHeartbeatAt: null,
    diagnosticCode: null,
    message: null,
  })
})

// ── App builder ───────────────────────────────────────────────────────────────

async function buildApp() {
  const { Elysia, NotFoundError } = await import("elysia")
  const { reposRoute } = await import("../../../src/routes/repos")
  const { RepoNotFoundError, ServiceNotFoundError } = await import("../../../src/config")

  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof RepoNotFoundError || error instanceof ServiceNotFoundError || (error as Error).message?.includes("not found")) {
        set.status = 404
        return { error: (error as Error).message }
      }
      if (error instanceof NotFoundError) {
        set.status = 404
        return { error: "Not found" }
      }
      set.status = 500
      return { error: (error as Error).message }
    })
    .group("/v1", (app) => app.use(reposRoute))
}

function req(path: string, opts?: RequestInit) {
  return new Request(`http://localhost/v1${path}`, opts)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /v1/repos", () => {
  it("returns 200 with repos array", async () => {
    const app = await buildApp()
    const res = await app.handle(req("/repos"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { repos: unknown[] }
    expect(Array.isArray(body.repos)).toBe(true)
    expect(body.repos).toHaveLength(1)
  })

  it("each repo has id, displayName, services", async () => {
    const app = await buildApp()
    const res = await app.handle(req("/repos"))
    const body = (await res.json()) as { repos: Array<{ id: string; services: unknown[] }> }
    expect(body.repos[0].id).toBe("my-repo")
    expect(Array.isArray(body.repos[0].services)).toBe(true)
  })

  it("includes full service metadata needed by the dashboard", async () => {
    const app = await buildApp()
    const res = await app.handle(req("/repos"))
    const body = (await res.json()) as {
      repos: Array<{ services: Array<{ packageManager: string; scriptName: string; healthUrl: string; healthMode: string; allowedIps: string[] }> }>
    }
    expect(body.repos[0].services[0]).toMatchObject({
      packageManager: "bun",
      scriptName: "dev",
      healthUrl: "http://localhost:3000/health",
      healthMode: "ping",
      allowedIps: [],
    })
  })
})

describe("GET /v1/repos/:repoId", () => {
  it("returns 200 with full repo detail", async () => {
    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string }
    expect(body.id).toBe("my-repo")
  })

  it("returns 404 for unknown repoId", async () => {
    const app = await buildApp()
    const res = await app.handle(req("/repos/nope"))
    expect(res.status).toBe(404)
  })
})

describe("GET /v1/repos/:repoId/services/:serviceId", () => {
  it("returns 200 with service detail", async () => {
    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo/services/my-repo-web"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; lifecycle: { state: string } }
    expect(body.id).toBe("my-repo-web")
    expect(body.lifecycle).toBeDefined()
    expect(body.lifecycle.state).toBe("stopped")
  })

  it("reports a healthy untracked service as an ownership conflict", async () => {
    const { statusCoordinator } = await import("../../../src/services/statusCoordinator")
    vi.mocked(statusCoordinator.getObservation).mockReturnValue({
      availability: { state: "healthy" },
      management: { state: "unmanaged" },
      checkedAt: new Date().toISOString(),
      healthDurationMs: 6,
      healthError: null,
      listenerPid: 22222,
      runnerPid: null,
      runnerHeartbeatAt: null,
      diagnosticCode: "SERVICE_PROCESS_OWNERSHIP_CONFLICT",
      message: "A healthy service is present, but it was not launched by SourceManager",
    })

    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo/services/my-repo-web"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { lifecycle: { state: string; pid: number | null; command: string | null }; observedStatus: { availability: { state: string } } }
    expect(body.lifecycle.state).toBe("failed")
    expect(body.lifecycle.pid).toBeNull()
    expect(body.lifecycle.command).toBeNull()
    expect((body.lifecycle as { diagnosticCode?: string }).diagnosticCode).toBe("SERVICE_PROCESS_OWNERSHIP_CONFLICT")
    expect(body.observedStatus.availability.state).toBe("healthy")
  })

  it("returns 404 for unknown serviceId", async () => {
    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo/services/nope"))
    expect(res.status).toBe(404)
  })
})

describe("GET /v1/repos/:repoId/services/:serviceId/logs", () => {
  it("returns 200 with empty logs", async () => {
    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo/services/my-repo-web/logs"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { serviceId: string; count: number; logs: unknown[] }
    expect(body.serviceId).toBe("my-repo-web")
    expect(body.count).toBe(0)
    expect(body.logs).toEqual([])
  })
})

describe("GET /v1/repos/:repoId/services/:serviceId/output", () => {
  it("returns 404 when no managed runner output exists", async () => {
    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo/services/my-repo-web/output"))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("No managed output") })
  })
})

describe("POST /v1/repos/:repoId/services/:serviceId/start", () => {
  it("returns 200 with success and lifecycle", async () => {
    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo/services/my-repo-web/start", { method: "POST" }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; serviceId: string }
    expect(body.success).toBe(true)
    expect(body.serviceId).toBe("my-repo-web")
  })

  it("returns 500 with diagnostics when start fails", async () => {
    const { processManager } = await import("../../../src/services/processManager")
    vi.mocked(processManager.start).mockResolvedValueOnce({
      success: false,
      message: "Failed to spawn service",
      lifecycleState: "failed",
      diagnostics: {
        code: "SERVICE_SPAWN_FAILED",
        repoId: "my-repo",
        serviceId: "my-repo-web",
        repoPath: "/dev/my-repo",
        packageManager: "npm",
        executable: "npm",
        command: ["npm", "run", "dev"],
        message: "spawn ENOENT",
      },
    })

    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo/services/my-repo-web/start", { method: "POST" }))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { success: boolean; diagnostics: { code: string; command: string[] } }
    expect(body.success).toBe(false)
    expect(body.diagnostics.code).toBe("SERVICE_SPAWN_FAILED")
    expect(body.diagnostics.command).toEqual(["npm", "run", "dev"])
  })
})

describe("POST /v1/repos/:repoId/services/:serviceId/stop", () => {
  it("returns 200 with stop result", async () => {
    const { processManager } = await import("../../../src/services/processManager")
    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo/services/my-repo-web/stop", { method: "POST" }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; alreadyStopped: boolean; lifecycle: { state: string } }
    expect(body.success).toBe(true)
    expect(body.lifecycle.state).toBe("stopped")
    expect(processManager.stop).toHaveBeenCalledWith(testService, testRepoWithService)
  })

  it("accepts SourceManager self-stop and schedules application shutdown", async () => {
    const config = await import("../../../src/config")
    const lifecycle = await import("../../../src/services/applicationLifecycle")
    const selfService = { ...testService, port: 17106 }
    vi.spyOn(config, "requireService").mockReturnValue({ repo: testRepoWithService, service: selfService })

    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo/services/my-repo-web/stop", { method: "POST" }))
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({
      success: true,
      shutdownAccepted: true,
      application: { state: "shutting_down", phase: "accepted" },
    })
    expect(lifecycle.scheduleApplicationShutdown).toHaveBeenCalledWith("dashboard Stop")
  })

  it("returns 500 with diagnostics when stop fails", async () => {
    const { processManager } = await import("../../../src/services/processManager")
    vi.mocked(processManager.stop).mockResolvedValueOnce({
      success: false,
      alreadyStopped: false,
      message: "Stop verification failed",
      lifecycleState: "failed",
      diagnostics: {
        code: "SERVICE_STOP_PORT_STILL_LISTENING",
        serviceId: "my-repo-web",
        port: 3000,
        portPidAfter: 22222,
        attempts: [],
        message: "port still listening",
      },
    })

    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo/services/my-repo-web/stop", { method: "POST" }))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { success: boolean; diagnostics: { code: string; portPidAfter: number } }
    expect(body.success).toBe(false)
    expect(body.diagnostics.code).toBe("SERVICE_STOP_PORT_STILL_LISTENING")
    expect(body.diagnostics.portPidAfter).toBe(22222)
  })
})

describe("POST /v1/repos/:repoId/services/:serviceId/restart", () => {
  it("returns 200 with restart result", async () => {
    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo/services/my-repo-web/restart", { method: "POST" }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean }
    expect(body.success).toBe(true)
  })
})
