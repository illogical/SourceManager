import { describe, it, expect, mock, beforeEach } from "bun:test"
import type { RepoConfig, ServiceConfig } from "../../src/types"

// ── Module mocks (must be top-level so bun:test can hoist them) ──────────────

const testRepo: RepoConfig = {
  id: "test-repo",
  displayName: "Test Repo",
  repoPath: "/dev/test-app",
  defaultBranch: "main",
  services: [],
}

const testService: ServiceConfig = {
  id: "test-app-web",
  displayName: "Web",
  packageManager: "bun",
  scriptName: "dev",
  port: 3000,
  healthUrl: "http://localhost:3000/health",
  healthMode: "ping",
  tags: [],
  allowedIps: [],
}

// Mock config
mock.module("../../src/config", () => ({
  requireService: mock((id: string) => {
    if (id === testService.id) return { repo: testRepo, service: testService }
    throw new Error(`Service not found: "${id}"`)
  }),
  getConfig: mock(() => ({
    server: { port: 17106, token: "test-token", allowedIps: [] },
    repos: [testRepo],
  })),
  loadConfig: mock(() => ({
    server: { port: 17106, token: "test-token", allowedIps: [] },
    repos: [testRepo],
  })),
  ServiceNotFoundError: class extends Error {
    serviceId: string
    constructor(id: string) {
      super(`Service not found: "${id}"`)
      this.serviceId = id
    }
  },
  RepoNotFoundError: class extends Error {
    repoId: string
    constructor(id: string) {
      super(`Repo not found: "${id}"`)
      this.repoId = id
    }
  },
  ConfigError: class extends Error {},
}))

// Git service mocks — default to "happy path"
const mockGitStatus = mock(() => Promise.resolve({ clean: true, output: "" }))
const mockGitFetch = mock(() =>
  Promise.resolve({ step: "fetch", status: "success", message: "Fetched from origin", durationMs: 50 })
)
const mockGitCheckout = mock(() =>
  Promise.resolve({ step: "checkout", status: "success", message: 'Checked out branch "main"', durationMs: 30 })
)
const mockGitPull = mock(() =>
  Promise.resolve({ step: "pull", status: "success", message: "Pulled 3 commits", durationMs: 200 })
)
const mockDetectDependencyChanges = mock(() => Promise.resolve(false))

mock.module("../../src/services/git", () => ({
  gitStatus: mockGitStatus,
  gitFetch: mockGitFetch,
  gitCheckout: mockGitCheckout,
  gitPull: mockGitPull,
  detectDependencyChanges: mockDetectDependencyChanges,
}))

// Health check mock — default pass
const mockCheckHealth = mock(() =>
  Promise.resolve({ status: "pass" as const, durationMs: 40 })
)
mock.module("../../src/services/healthCheck", () => ({
  checkHealth: mockCheckHealth,
}))

// Installer mock — default success
const mockRunInstall = mock(() =>
  Promise.resolve({ step: "install", status: "success", message: "Install completed", durationMs: 800 })
)
mock.module("../../src/services/installer", () => ({
  runInstall: mockRunInstall,
}))

// Process manager mock
const mockRestart = mock(() =>
  Promise.resolve({ success: true, message: "Restarted successfully" })
)
mock.module("../../src/services/processManager", () => ({
  processManager: {
    restart: mockRestart,
    getProcess: mock(() => null),
    isRunning: mock(() => false),
  },
}))

// Run logger mock
const mockLogRun = mock(() => Promise.resolve())
mock.module("../../src/services/runLogger", () => ({
  logRun: mockLogRun,
}))

// ── Test setup ────────────────────────────────────────────────────────────────

const TEST_TOKEN = "test-token"

async function buildApp() {
  const { Elysia } = await import("elysia")
  const { updateRoute } = await import("../../src/routes/update")

  return new Elysia()
    .onError(({ error, set }) => {
      if ((error as Error).message?.includes("not found")) {
        set.status = 404
        return { error: (error as Error).message }
      }
      set.status = 500
      return { error: (error as Error).message }
    })
    .group("/v1", (app) =>
      app
        .onBeforeHandle(({ headers, set }) => {
          const token = (headers as Record<string, string | undefined>)["x-devserver-token"]
          if (!token || token !== TEST_TOKEN) {
            set.status = 401
            return { error: "Unauthorized" }
          }
        })
        .use(updateRoute)
    )
}

function makeRequest(repoId: string, serviceId: string, body: object, token = TEST_TOKEN) {
  return new Request(`http://localhost/v1/repos/${repoId}/services/${serviceId}/update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-DevServer-Token": token,
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  // Clear call counts first, then reset implementations
  mockGitStatus.mockClear()
  mockGitFetch.mockClear()
  mockGitCheckout.mockClear()
  mockGitPull.mockClear()
  mockDetectDependencyChanges.mockClear()
  mockCheckHealth.mockClear()
  mockRunInstall.mockClear()
  mockRestart.mockClear()
  mockLogRun.mockClear()

  mockGitStatus.mockImplementation(() => Promise.resolve({ clean: true, output: "" }))
  mockGitFetch.mockImplementation(() =>
    Promise.resolve({ step: "fetch", status: "success", message: "Fetched from origin", durationMs: 50 })
  )
  mockGitCheckout.mockImplementation(() =>
    Promise.resolve({ step: "checkout", status: "success", message: 'Checked out branch "main"', durationMs: 30 })
  )
  mockGitPull.mockImplementation(() =>
    Promise.resolve({ step: "pull", status: "success", message: "Pulled 3 commits", durationMs: 200 })
  )
  mockDetectDependencyChanges.mockImplementation(() => Promise.resolve(false))
  mockCheckHealth.mockImplementation(() =>
    Promise.resolve({ status: "pass" as const, durationMs: 40 })
  )
  mockRunInstall.mockImplementation(() =>
    Promise.resolve({ step: "install", status: "success", message: "Install completed", durationMs: 800 })
  )
  mockRestart.mockImplementation(() =>
    Promise.resolve({ success: true, message: "Restarted successfully" })
  )
  mockLogRun.mockImplementation(() => Promise.resolve())
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /v1/repos/:repoId/services/:serviceId/update — authentication", () => {
  it("returns 401 when token is missing", async () => {
    const app = await buildApp()
    const req = new Request(`http://localhost/v1/repos/${testRepo.id}/services/${testService.id}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    const res = await app.handle(req)
    expect(res.status).toBe(401)
  })

  it("returns 401 when token is wrong", async () => {
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, {}, "wrong-token"))
    expect(res.status).toBe(401)
  })

  it("proceeds when token is valid", async () => {
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, {}))
    expect(res.status).toBe(200)
  })
})

describe("POST /v1/repos/:repoId/services/:serviceId/update — dryRun", () => {
  it("skips all steps except precheck on dryRun: true", async () => {
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, { dryRun: true }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, unknown>
    expect(body.dryRun).toBe(true)

    // Git mutations should not be called
    expect(mockGitFetch).not.toHaveBeenCalled()
    expect(mockGitCheckout).not.toHaveBeenCalled()
    expect(mockGitPull).not.toHaveBeenCalled()
    expect(mockRunInstall).not.toHaveBeenCalled()
    expect(mockRestart).not.toHaveBeenCalled()

    // Steps should be skipped (except precheck)
    const steps = body.steps as Array<{ step: string; status: string }>
    const nonPrecheck = steps.filter((s) => s.step !== "precheck")
    expect(nonPrecheck.every((s) => s.status === "skipped")).toBe(true)
  })
})

describe("POST /v1/repos/:repoId/services/:serviceId/update — precheck", () => {
  it("aborts with failure when working tree is dirty", async () => {
    mockGitStatus.mockImplementation(() =>
      Promise.resolve({ clean: false, output: " M src/index.ts\n?? newfile.ts" })
    )
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, {}))
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, unknown>
    expect(body.updated).toBe(false)
    expect(String(body.reason)).toMatch(/uncommitted|dirty/i)

    // All subsequent steps should not be called
    expect(mockGitFetch).not.toHaveBeenCalled()
  })

  it("continues when working tree is clean", async () => {
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, {}))
    expect(res.status).toBe(200)
    expect(mockGitFetch).toHaveBeenCalled()
  })
})

describe("POST /v1/repos/:repoId/services/:serviceId/update — fetch/pull failures", () => {
  it("aborts when fetch fails", async () => {
    mockGitFetch.mockImplementation(() =>
      Promise.resolve({ step: "fetch", status: "failure", message: "no route to host", durationMs: 100 })
    )
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, {}))
    const body = (await res.json()) as Record<string, unknown>
    expect(body.updated).toBe(false)
    expect(mockGitPull).not.toHaveBeenCalled()
  })

  it("marks updated=false when pull says already up to date", async () => {
    mockGitPull.mockImplementation(() =>
      Promise.resolve({ step: "pull", status: "success", message: "Already up to date", durationMs: 50 })
    )
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, {}))
    const body = (await res.json()) as Record<string, unknown>
    expect(body.updated).toBe(false)
  })

  it("marks updated=true when pull fetches new commits", async () => {
    mockGitPull.mockImplementation(() =>
      Promise.resolve({ step: "pull", status: "success", message: "Fast-forward 3 files changed", durationMs: 200 })
    )
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, {}))
    const body = (await res.json()) as Record<string, unknown>
    expect(body.updated).toBe(true)
  })
})

describe("POST /v1/repos/:repoId/services/:serviceId/update — installMode", () => {
  it("installMode=always runs install even without dep changes", async () => {
    mockDetectDependencyChanges.mockImplementation(() => Promise.resolve(false))
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, { installMode: "always" }))
    const body = (await res.json()) as Record<string, unknown>
    const installRun = body.installRun as Record<string, unknown>
    expect(installRun.status).toBe("success")
    expect(mockRunInstall).toHaveBeenCalled()
  })

  it("installMode=never skips install regardless of dep changes", async () => {
    mockDetectDependencyChanges.mockImplementation(() => Promise.resolve(true))
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, { installMode: "never" }))
    const body = (await res.json()) as Record<string, unknown>
    const installRun = body.installRun as Record<string, unknown>
    expect(installRun.status).toBe("skipped")
    expect(mockRunInstall).not.toHaveBeenCalled()
  })

  it("installMode=auto runs install when dep files changed", async () => {
    mockDetectDependencyChanges.mockImplementation(() => Promise.resolve(true))
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, { installMode: "auto" }))
    const body = (await res.json()) as Record<string, unknown>
    const installRun = body.installRun as Record<string, unknown>
    expect(installRun.status).toBe("success")
    expect(mockRunInstall).toHaveBeenCalled()
  })

  it("installMode=auto skips install when no dep changes", async () => {
    mockDetectDependencyChanges.mockImplementation(() => Promise.resolve(false))
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, { installMode: "auto" }))
    const body = (await res.json()) as Record<string, unknown>
    const installRun = body.installRun as Record<string, unknown>
    expect(installRun.status).toBe("skipped")
    expect(mockRunInstall).not.toHaveBeenCalled()
  })
})

describe("POST /v1/repos/:repoId/services/:serviceId/update — restartMode", () => {
  it("restartMode=always restarts regardless of health", async () => {
    mockCheckHealth.mockImplementation(() => Promise.resolve({ status: "pass" as const, durationMs: 30 }))
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, { restartMode: "always" }))
    const body = (await res.json()) as Record<string, unknown>
    const restartRun = body.restartRun as Record<string, unknown>
    expect(restartRun.status).toBe("success")
    expect(mockRestart).toHaveBeenCalled()
  })

  it("restartMode=never skips restart even when health fails", async () => {
    mockCheckHealth.mockImplementation(() =>
      Promise.resolve({ status: "fail" as const, durationMs: 5001, detail: "timeout" })
    )
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, { restartMode: "never" }))
    const body = (await res.json()) as Record<string, unknown>
    const restartRun = body.restartRun as Record<string, unknown>
    expect(restartRun.status).toBe("skipped")
    expect(mockRestart).not.toHaveBeenCalled()
  })

  it("restartMode=auto does NOT restart when health passes", async () => {
    mockCheckHealth.mockImplementation(() => Promise.resolve({ status: "pass" as const, durationMs: 30 }))
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, { restartMode: "auto" }))
    expect(mockRestart).not.toHaveBeenCalled()
    const body = (await res.json()) as Record<string, unknown>
    expect((body.restartRun as Record<string, unknown>).status).toBe("skipped")
  })

  it("restartMode=auto triggers restart when health fails", async () => {
    mockCheckHealth
      .mockImplementationOnce(() =>
        Promise.resolve({ status: "fail" as const, durationMs: 5001, detail: "timeout" })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ status: "pass" as const, durationMs: 40 })
      )

    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, { restartMode: "auto" }))
    expect(mockRestart).toHaveBeenCalled()

    const body = (await res.json()) as Record<string, unknown>
    expect(body.healthStatus).toBe("pass")
    const steps = body.steps as Array<{ step: string; status: string }>
    expect(steps.some((s) => s.step === "health-retry" && s.status === "success")).toBe(true)
  })
})

describe("POST /v1/repos/:repoId/services/:serviceId/update — response shape", () => {
  it("response includes all required fields", async () => {
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, {}))
    const body = (await res.json()) as Record<string, unknown>

    expect(body).toHaveProperty("runId")
    expect(body).toHaveProperty("serviceId", testService.id)
    expect(body).toHaveProperty("repoId", testRepo.id)
    expect(body).toHaveProperty("startedAt")
    expect(body).toHaveProperty("durationMs")
    expect(body).toHaveProperty("branch")
    expect(body).toHaveProperty("dryRun")
    expect(body).toHaveProperty("updated")
    expect(body).toHaveProperty("reason")
    expect(body).toHaveProperty("installRun")
    expect(body).toHaveProperty("restartRun")
    expect(body).toHaveProperty("healthStatus")
    expect(body).toHaveProperty("steps")
    expect(Array.isArray(body.steps)).toBe(true)
  })

  it("uses branch from repo config when none provided in body", async () => {
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, {}))
    const body = (await res.json()) as Record<string, unknown>
    expect(body.branch).toBe(testRepo.defaultBranch)
  })

  it("uses branch from body when provided", async () => {
    const app = await buildApp()
    const res = await app.handle(makeRequest(testRepo.id, testService.id, { branch: "feature/test" }))
    const body = (await res.json()) as Record<string, unknown>
    expect(body.branch).toBe("feature/test")
  })

  it("logs the run report via logRun", async () => {
    const app = await buildApp()
    await app.handle(makeRequest(testRepo.id, testService.id, {}))
    expect(mockLogRun).toHaveBeenCalledTimes(1)
  })
})
