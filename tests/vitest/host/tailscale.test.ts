import { describe, expect, it, vi } from "vitest"
import { getGlobalTailscaleStatus, setGlobalTailscaleEnabled, type TailscaleExecutor } from "../../../src/services/tailscaleGlobal"

const config = { serviceName: "apps", enabled: true, protocol: "https" as const, port: 443, target: "http://127.0.0.1:17106" }
describe("global Tailscale service", () => {
  it("recognizes the one matching advertised service", async () => {
    const executor: TailscaleExecutor = { execute: vi.fn(async (args) => args[0] === "status" ? JSON.stringify({ BackendState: "Running", MagicDNSSuffix: "example.ts.net" }) : JSON.stringify({ services: { "svc:apps": { advertised: true, endpoints: { "tcp:443": config.target } } } })) }
    expect(await getGlobalTailscaleStatus(config, executor)).toMatchObject({ status: "connected", serviceName: "apps" })
  })
  it("uses named-service argument arrays for enable and drain/off", async () => {
    const execute = vi.fn(async () => "")
    await setGlobalTailscaleEnabled(config, true, { execute })
    await setGlobalTailscaleEnabled(config, false, { execute })
    expect(execute).toHaveBeenCalledWith(["serve", "--service=svc:apps", "--https=443", config.target])
    expect(execute).toHaveBeenCalledWith(["serve", "drain", "svc:apps"])
    expect(execute).toHaveBeenCalledWith(["serve", "--service=svc:apps", "--https=443", "off"])
  })
})
