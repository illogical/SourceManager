import { describe, expect, it } from "vitest"
import type { ServiceConfig } from "../../../src/types"
import {
  advertiseTailscaleService,
  checkTailscaleService,
  clearTailscaleServiceMessages,
  disableTailscaleService,
  drainTailscaleService,
  enableTailscaleService,
  expectedServiceUrl,
  normalizeServiceName,
  normalizeTarget,
  prepareTailscaleForStop,
  readMachineStatus,
  readServeConfig,
  restoreTailscaleWhenReady,
  serviceNameToCliName,
  type TailscaleExecutor,
} from "../../../src/services/tailscale"

class FakeExecutor implements TailscaleExecutor {
  calls: string[][] = []

  constructor(private readonly responses: Record<string, string> = {}) {}

  async execute(args: string[]) {
    this.calls.push(args)
    return { stdout: this.responses[args.join(" ")] ?? "", stderr: "" }
  }
}

const service: ServiceConfig = {
  id: "devplanner-api",
  displayName: "DevPlanner API",
  packageManager: "bun",
  scriptName: "dev",
  port: 17103,
  healthUrl: "http://127.0.0.1:17103/health",
  healthMode: "ping",
  tags: [],
  allowedIps: [],
  tailnetExposureMode: "tailscale-service",
  tailscaleServiceName: "devplanner-api",
  tailscaleServiceEnabled: true,
  tailscaleServiceProtocol: "https",
  tailscaleServicePort: 443,
  tailscaleServiceTarget: "http://localhost:17103",
}

describe("named Tailscale Service helpers", () => {
  it("normalizes names, targets, and expected URLs", () => {
    expect(normalizeServiceName("svc:devplanner-api")).toBe("devplanner-api")
    expect(serviceNameToCliName("devplanner-api")).toBe("svc:devplanner-api")
    expect(normalizeTarget("http://localhost:17103/")).toBe("http://127.0.0.1:17103")
    expect(expectedServiceUrl("devplanner-api", "example.ts.net"))
      .toBe("https://devplanner-api.example.ts.net")
  })

  it("constructs enable, advertise, drain, and disable commands without funnel or reset", async () => {
    const executor = new FakeExecutor()
    await enableTailscaleService(service, executor)
    await advertiseTailscaleService(service, executor)
    await drainTailscaleService(service, executor)
    await disableTailscaleService(service, executor)

    expect(executor.calls).toEqual([
      ["serve", "--service=svc:devplanner-api", "--https=443", "http://127.0.0.1:17103"],
      ["serve", "advertise", "svc:devplanner-api"],
      ["serve", "drain", "svc:devplanner-api"],
      ["serve", "drain", "svc:devplanner-api"],
      ["serve", "--service=svc:devplanner-api", "--https=443", "off"],
    ])
    expect(executor.calls.flat()).not.toContain("funnel")
    expect(executor.calls.map((call) => call.join(" ")).join("\n")).not.toContain("serve reset")
  })

  it("parses machine and Serve configuration and reports a connected matching service", async () => {
    const executor = new FakeExecutor({
      "status --json": JSON.stringify({
        BackendState: "Running",
        CurrentTailnet: { MagicDNSSuffix: "bangus-city.ts.net" },
        Self: { Tags: ["tag:dev-service-host"], CapMap: { "service-host": {} } },
      }),
      "serve get-config --all": JSON.stringify({
        services: {
          "svc:devplanner-api": {
            advertised: true,
            endpoints: { "tcp:443": "http://127.0.0.1:17103" },
          },
        },
      }),
    })
    const machine = await readMachineStatus(executor)
    const config = await readServeConfig(executor)
    const result = checkTailscaleService(service, true, machine, config)

    expect(machine.state).toBe("connected")
    expect(result).toMatchObject({
      status: "connected",
      desiredEnabled: true,
      expectedUrl: "https://devplanner-api.bangus-city.ts.net",
      canToggle: true,
    })
  })

  it("reports stopped and mismatch states independently of desired state", async () => {
    const machine = {
      state: "connected" as const,
      backendState: "Running",
      tailnetDomain: "example.ts.net",
      tags: ["tag:dev-service-host"],
      serviceHostCapability: {},
      error: null,
    }
    const config = {
      services: {
        "svc:devplanner-api": {
          advertised: true,
          endpoints: { "tcp:443": "http://127.0.0.1:9999" },
        },
      },
    }

    expect(checkTailscaleService(service, false, machine, config).status).toBe("local_stopped")
    expect(checkTailscaleService(service, true, machine, config).status).toBe("mismatch")
  })

  it("inspects advertisement and drains before local shutdown proceeds", async () => {
    const executor = new FakeExecutor({
      "serve get-config --all": JSON.stringify({
        services: {
          "svc:devplanner-api": {
            advertised: true,
            endpoints: { "tcp:443": "http://127.0.0.1:17103" },
          },
        },
      }),
    })
    const result = await prepareTailscaleForStop(service, executor)
    expect(result).toEqual({ success: true, warning: null })
    expect(executor.calls).toEqual([
      ["serve", "get-config", "--all"],
      ["serve", "drain", "svc:devplanner-api"],
    ])
  })

  it("repairs a saved-On but not-advertised service once with per-service Off then On", async () => {
    const executor = new FakeExecutor({
      "serve get-config --all": JSON.stringify({
        services: {
          "svc:devplanner-api": {
            advertised: false,
            endpoints: { "tcp:443": "http://127.0.0.1:17103" },
          },
        },
      }),
    })

    await restoreTailscaleWhenReady(service, async () => true, executor, 1, 0)

    expect(executor.calls).toEqual([
      ["serve", "get-config", "--all"],
      ["serve", "drain", "svc:devplanner-api"],
      ["serve", "--service=svc:devplanner-api", "--https=443", "off"],
      ["serve", "--service=svc:devplanner-api", "--https=443", "http://127.0.0.1:17103"],
      ["serve", "advertise", "svc:devplanner-api"],
    ])
  })

  it("does not re-advertise an already connected matching service", async () => {
    const executor = new FakeExecutor({
      "serve get-config --all": JSON.stringify({
        services: {
          "svc:devplanner-api": {
            advertised: true,
            endpoints: { "tcp:443": "http://127.0.0.1:17103" },
          },
        },
      }),
    })

    await restoreTailscaleWhenReady(service, async () => true, executor, 1, 0)

    expect(executor.calls).toEqual([
      ["serve", "get-config", "--all"],
    ])
  })

  it("reports an observed connected service despite a stale command error", async () => {
    const serviceWithStaleError = { ...service, id: "devplanner-api-stale-error" }
    const failingExecutor: TailscaleExecutor = {
      async execute() {
        throw new Error("NoState")
      },
    }
    await expect(advertiseTailscaleService(serviceWithStaleError, failingExecutor))
      .rejects.toThrow("NoState")

    const result = checkTailscaleService(
      serviceWithStaleError,
      true,
      {
        state: "connected",
        backendState: "Running",
        tailnetDomain: "bangus-city.ts.net",
        tags: ["tag:dev-service-host"],
        serviceHostCapability: {},
        error: null,
      },
      {
        services: {
          "svc:devplanner-api": {
            advertised: true,
            endpoints: { "tcp:443": "http://127.0.0.1:17103" },
          },
        },
      },
    )

    expect(result.status).toBe("connected")
    expect(result.lastError).toBeNull()
    clearTailscaleServiceMessages(serviceWithStaleError.id)
  })
})
