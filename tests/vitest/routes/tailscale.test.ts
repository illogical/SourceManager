import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RepoConfig, ServiceConfig } from "../../../src/types"
import type { TailscaleExecutor } from "../../../src/services/tailscale"

const service: ServiceConfig = {
  id: "sourcemanager-api",
  displayName: "SourceManager Web and API",
  packageManager: "bun",
  scriptName: "start",
  port: 17106,
  healthUrl: "http://127.0.0.1:17106/health",
  healthMode: "full",
  tags: [],
  allowedIps: [],
  tailnetExposureMode: "tailscale-service",
  tailscaleServiceName: "sourcemanager",
  tailscaleServiceEnabled: true,
  tailscaleServiceProtocol: "https",
  tailscaleServicePort: 443,
  tailscaleServiceTarget: "http://127.0.0.1:17106",
}
const repo: RepoConfig = {
  id: "sourcemanager",
  displayName: "SourceManager",
  repoPath: "/projects/SourceManager",
  defaultBranch: "main",
  services: [service],
}
const setEnabled = vi.fn()

vi.mock("../../../src/config", () => ({
  getAllServices: vi.fn(() => [{ repo, service }]),
  requireService: vi.fn((id: string) => {
    if (id !== service.id) throw new Error(`Service not found: "${id}"`)
    return { repo, service }
  }),
}))

vi.mock("../../../src/services/configEditor", () => ({
  setTailscaleServiceEnabled: setEnabled,
}))

vi.mock("../../../src/services/processManager", () => ({
  processManager: {
    observe: vi.fn(async () => ({
      serviceId: service.id,
      repoId: repo.id,
      pid: 123,
      port: service.port,
      startedAt: new Date().toISOString(),
      command: "bun run start",
      lifecycleState: "running",
    })),
  },
}))

vi.mock("../../../src/services/healthCheck", () => ({
  checkHealth: vi.fn(async () => ({ status: "pass", durationMs: 1 })),
}))

class FakeExecutor implements TailscaleExecutor {
  calls: string[][] = []

  async execute(args: string[]) {
    this.calls.push(args)
    if (args.join(" ") === "status --json") {
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          CurrentTailnet: { MagicDNSSuffix: "bangus-city.ts.net" },
          Self: { Tags: ["tag:dev-service-host"], CapMap: { "service-host": {} } },
        }),
        stderr: "",
      }
    }
    if (args.join(" ") === "serve get-config --all") {
      return {
        stdout: JSON.stringify({
          services: {
            "svc:sourcemanager": {
              advertised: true,
              endpoints: { "tcp:443": "http://127.0.0.1:17106" },
            },
          },
        }),
        stderr: "",
      }
    }
    return { stdout: "", stderr: "" }
  }
}

async function buildApp(executor: TailscaleExecutor) {
  const { Elysia } = await import("elysia")
  const { createTailscaleRoute } = await import("../../../src/routes/tailscale")
  return new Elysia().group("/v1", (app) => app.use(createTailscaleRoute(executor)))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("Tailscale routes", () => {
  it("returns host and matching named-Service status", async () => {
    const app = await buildApp(new FakeExecutor())
    const response = await app.handle(new Request("http://localhost/v1/tailscale/status"))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.machine.state).toBe("connected")
    expect(body.services[0]).toMatchObject({
      serviceId: "sourcemanager-api",
      status: "connected",
      expectedUrl: "https://sourcemanager.bangus-city.ts.net",
    })
  })

  it("persists desired state and configures the named Service on enable", async () => {
    const executor = new FakeExecutor()
    const app = await buildApp(executor)
    const response = await app.handle(new Request(
      "http://localhost/v1/tailscale/services/sourcemanager-api/service/enable",
      { method: "POST" },
    ))
    expect(response.status).toBe(200)
    expect(setEnabled).toHaveBeenCalledWith("sourcemanager-api", true)
    expect(executor.calls).toContainEqual([
      "serve",
      "--service=svc:sourcemanager",
      "--https=443",
      "http://127.0.0.1:17106",
    ])
  })

  it("drains and removes the endpoint on disable", async () => {
    const executor = new FakeExecutor()
    const app = await buildApp(executor)
    const response = await app.handle(new Request(
      "http://localhost/v1/tailscale/services/sourcemanager-api/service/disable",
      { method: "POST" },
    ))
    expect(response.status).toBe(200)
    expect(setEnabled).toHaveBeenCalledWith("sourcemanager-api", false)
    expect(executor.calls).toContainEqual(["serve", "drain", "svc:sourcemanager"])
    expect(executor.calls).toContainEqual([
      "serve",
      "--service=svc:sourcemanager",
      "--https=443",
      "off",
    ])
  })
})
