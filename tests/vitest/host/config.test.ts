import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseProjectsConfig, previewV1Conversion } from "../../../src/config"
import { diffConfig, writeProjectsFile } from "../../../src/services/configV2"

const temporaryRoots: string[] = []
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const project = {
  id: "devplanner", displayName: "DevPlanner", repoPath: "DevPlanner", defaultBranch: "main", enabled: true,
  host: { module: "dist/host/index.js", contractVersion: 1 as const },
  web: { mountPath: "/DevPlanner", distPath: "frontend/dist", spaFallback: true },
  api: { mountPath: "/api/DevPlanner" },
  realtime: { mountPath: "/api/DevPlanner/ws", protocol: "websocket" as const },
  build: { script: "build", verifyScript: "verify:host" }, tags: ["web"],
}

describe("v2 configuration", () => {
  it("accepts the canonical schema", () => {
    const parsed = parseProjectsConfig({ schemaVersion: 2, server: { allowedIps: [] }, tailnet: { serviceName: "apps", enabled: true, protocol: "https", port: 443, target: "http://127.0.0.1:17106" }, projects: [project] })
    expect(parsed.projects[0].api?.mountPath).toBe("/api/DevPlanner")
  })

  it("rejects traversal and duplicate route ownership", () => {
    expect(() => parseProjectsConfig({ schemaVersion: 2, server: { allowedIps: [] }, tailnet: { serviceName: "apps", enabled: true, protocol: "https", port: 443, target: "http://127.0.0.1:17106" }, projects: [project, { ...project, id: "other", repoPath: "../escape" }] })).toThrow()
  })

  it("previews legacy config without mutating it", () => {
    const legacy = { server: { allowedIps: [] }, repos: [{ id: "devplanner", displayName: "DevPlanner", repoPath: "DevPlanner", defaultBranch: "main", services: [{ installCommand: "custom install", port: 17103 }] }] }
    const preview = previewV1Conversion(legacy)
    expect(preview.config.schemaVersion).toBe(2)
    expect(preview.warnings[0]).toContain("owner review")
    expect(legacy.repos[0].services[0].port).toBe(17103)
  })

  it("atomically saves validated v2 config and backs up the prior file", async () => {
    const root = await mkdtemp(join(tmpdir(), "config-v2-")); temporaryRoots.push(root); const path = join(root, "projects.json")
    const value = { schemaVersion: 2 as const, server: { allowedIps: [] }, tailnet: { serviceName: "apps", enabled: true, protocol: "https" as const, port: 443, target: "http://127.0.0.1:17106" }, projects: [project] }
    await writeFile(path, `${JSON.stringify(value)}\n`)
    const changed = structuredClone(value); changed.tailnet.enabled = false
    await writeProjectsFile(changed, path)
    expect(JSON.parse(await readFile(path, "utf8")).tailnet.enabled).toBe(false)
    expect((await readdir(join(root, "backups"))).length).toBe(1)
    expect(diffConfig(value, changed).changeCount).toBe(1)
  })
})
