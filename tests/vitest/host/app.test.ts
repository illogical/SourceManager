import { afterEach, describe, expect, it } from "vitest"
import request from "supertest"
import { createSourceManagerHost, type SourceManagerHost } from "../../../src/app"
import type { AppConfig } from "../../../src/types"

const hosts: SourceManagerHost[] = []
afterEach(async () => { for (const host of hosts.splice(0)) await host.close() })
const config: AppConfig = {
  schemaVersion: 2, workspacePath: process.cwd(), server: { port: 17106, token: "test-token", allowedIps: [] },
  tailnet: { serviceName: "apps", enabled: false, protocol: "https", port: 443, target: "http://127.0.0.1:17106" },
  projects: [
    { id: "fixture", displayName: "Fixture", repoPath: ".", defaultBranch: "main", enabled: false, host: { module: "dist/host/index.js", contractVersion: 1 }, build: { script: "build", verifyScript: "verify:host" }, tags: [] },
    { id: "broken", displayName: "Broken", repoPath: ".", defaultBranch: "main", enabled: true, host: { module: "dist/host/missing.js", contractVersion: 1 }, api: { mountPath: "/api/Broken" }, build: { script: "build", verifyScript: "verify:host" }, tags: [] },
  ],
}

describe("Express composition root", () => {
  it("keeps health public and management authenticated", async () => {
    const host = createSourceManagerHost(config); hosts.push(host); await host.initialize()
    expect((await request(host.app).get("/health")).status).toBe(200)
    expect((await request(host.app).get("/api/SourceManager/projects")).status).toBe(401)
    const response = await request(host.app).get("/api/SourceManager/projects").set("X-DevServer-Token", "test-token")
    expect(response.status).toBe(200); expect(response.body.projects[0].hostState).toBe("disabled"); expect(response.body.projects[1].hostState).toBe("unavailable")
    expect((await request(host.app).get("/api/Broken/test")).status).toBe(503)
  })
  it("keeps API 404 responses out of SPA fallbacks", async () => { const host = createSourceManagerHost(config); hosts.push(host); await host.initialize(); expect((await request(host.app).get("/api/missing")).type).toMatch(/json/) })
})
