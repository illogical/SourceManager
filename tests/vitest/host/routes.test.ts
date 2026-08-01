import { describe, expect, it } from "vitest"
import { assertUniqueRoutePrefixes, normalizeMountPath, projectsByApiMountOrder } from "../../../src/host/routes"
import type { ProjectConfig } from "../../../src/types"

function project(id: string, api: string): ProjectConfig {
  return { id, displayName: id, repoPath: id, defaultBranch: "main", enabled: true, host: { module: "dist/host/index.js", contractVersion: 1 }, api: { mountPath: api }, build: { script: "build", verifyScript: "verify:host" }, tags: [] }
}

describe("route ownership", () => {
  it("rejects encoded, traversing, and trailing-slash paths", () => {
    for (const path of ["/api/%2e%2e/x", "/api/../x", "/api/x/", "api/x"]) expect(() => normalizeMountPath(path)).toThrow()
  })
  it("sorts API paths longest first", () => expect(projectsByApiMountOrder([project("a", "/api/a"), project("b", "/api/a/long")]).map((value) => value.id)).toEqual(["b", "a"]))
  it("rejects duplicate API owners", () => expect(() => assertUniqueRoutePrefixes([project("a", "/api/shared"), project("b", "/api/shared")])).toThrow(/collides/))
})
