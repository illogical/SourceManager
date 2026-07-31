import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ObservedServiceStatus, RepoConfig, ServiceConfig } from "../../../src/types"

const fixtures = vi.hoisted(() => {
  const service = (index: number): ServiceConfig => ({
    id: `service-${index}`,
    displayName: `Service ${index}`,
    packageManager: "bun",
    scriptName: "dev",
    port: 3000 + index,
    healthUrl: `http://localhost:${3000 + index}/health`,
    healthMode: "ping",
    tags: [],
    allowedIps: [],
  })
  const repo: RepoConfig = {
    id: "repo",
    displayName: "Repo",
    repoPath: "/repo",
    defaultBranch: "main",
    services: [],
  }
  return { configured: [] as Array<{ repo: RepoConfig; service: ServiceConfig }>, service, repo }
})

const healthy = (service: ServiceConfig): ObservedServiceStatus => ({
  availability: { state: "healthy" },
  management: { state: "managed" },
  checkedAt: new Date().toISOString(),
  healthDurationMs: 1,
  healthError: null,
  listenerPid: service.port,
  runnerPid: service.port + 1,
  runnerHeartbeatAt: new Date().toISOString(),
  diagnosticCode: null,
  message: null,
})

const observe = vi.hoisted(() => vi.fn())

vi.mock("../../../src/config", () => ({
  getAllServices: vi.fn(() => fixtures.configured),
  getConfig: vi.fn(() => ({ server: { port: 17106 } })),
}))

vi.mock("../../../src/services/processManager", () => ({
  processManager: {
    observe,
    getObservedStatus: vi.fn(() => null),
  },
}))

vi.mock("../../../src/services/tailscale", () => ({
  tailscaleExecutor: {},
  readMachineStatus: vi.fn(async () => ({
    state: "connected",
    backendState: "Running",
    tailnetDomain: "example.ts.net",
    tags: [],
    serviceHostCapability: null,
    error: null,
  })),
  readServeConfig: vi.fn(async () => ({ services: {} })),
  checkTailscaleService: vi.fn((service: ServiceConfig) => ({
    serviceId: service.id,
    configured: false,
    desiredEnabled: false,
    serviceName: null,
    expectedUrl: null,
    localTarget: null,
    httpsPort: null,
    status: "not_configured",
    lastError: null,
    lastWarning: null,
    operation: null,
    canToggle: false,
  })),
}))

beforeEach(() => {
  fixtures.configured = []
  observe.mockReset()
  observe.mockImplementation(async (service: ServiceConfig) => healthy(service))
})

describe("StatusCoordinator", () => {
  it("coalesces concurrent checks for one service", async () => {
    const { StatusCoordinator } = await import("../../../src/services/statusCoordinator")
    const coordinator = new StatusCoordinator()
    const service = fixtures.service(1)

    const [first, second] = await Promise.all([
      coordinator.refreshService("repo", service),
      coordinator.refreshService("repo", service),
    ])

    expect(observe).toHaveBeenCalledOnce()
    expect(first).toEqual(second)
  })

  it("bounds all-service observation concurrency", async () => {
    const { StatusCoordinator } = await import("../../../src/services/statusCoordinator")
    fixtures.configured = Array.from({ length: 7 }, (_, index) => ({
      repo: fixtures.repo,
      service: fixtures.service(index),
    }))
    let active = 0
    let peak = 0
    observe.mockImplementation(async (service: ServiceConfig) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return healthy(service)
    })

    const result = await new StatusCoordinator(3).refreshAll("manual_global")

    expect(result.services).toHaveLength(7)
    expect(peak).toBe(3)
  })

  it("returns a partial result when one observation throws", async () => {
    const { StatusCoordinator } = await import("../../../src/services/statusCoordinator")
    fixtures.configured = [0, 1].map((index) => ({ repo: fixtures.repo, service: fixtures.service(index) }))
    observe.mockImplementation(async (service: ServiceConfig) => {
      if (service.id === "service-1") throw new Error("probe failed")
      return healthy(service)
    })

    const result = await new StatusCoordinator().refreshAll("manual_global")

    expect(result.services[0].error).toBeNull()
    expect(result.services[1]).toMatchObject({
      error: "probe failed",
      status: { availability: { state: "unknown" } },
    })
  })
})
