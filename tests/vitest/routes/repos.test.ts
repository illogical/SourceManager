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
    getAllProcesses: vi.fn(() => []),
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

beforeEach(async () => {
  const { processManager } = await import("../../../src/services/processManager")
  const { checkHealth } = await import("../../../src/services/healthCheck")
  vi.mocked(processManager.getProcess).mockReturnValue(null)
  vi.mocked(checkHealth).mockResolvedValue({ status: "fail", durationMs: 5 })
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

  it("reports an untracked service as running when its health check passes", async () => {
    const { checkHealth } = await import("../../../src/services/healthCheck")
    vi.mocked(checkHealth).mockResolvedValue({ status: "pass", durationMs: 6 })

    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo/services/my-repo-web"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { lifecycle: { state: string; pid: number | null; command: string | null } }
    expect(body.lifecycle.state).toBe("running")
    expect(body.lifecycle.pid).toBeNull()
    expect(body.lifecycle.command).toBeNull()
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

describe("POST /v1/repos/:repoId/services/:serviceId/start", () => {
  it("returns 200 with success and lifecycle", async () => {
    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo/services/my-repo-web/start", { method: "POST" }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; serviceId: string }
    expect(body.success).toBe(true)
    expect(body.serviceId).toBe("my-repo-web")
  })
})

describe("POST /v1/repos/:repoId/services/:serviceId/stop", () => {
  it("returns 200 with stop result", async () => {
    const app = await buildApp()
    const res = await app.handle(req("/repos/my-repo/services/my-repo-web/stop", { method: "POST" }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; alreadyStopped: boolean }
    expect(body.success).toBe(true)
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
