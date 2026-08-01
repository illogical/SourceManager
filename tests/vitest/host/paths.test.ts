import { afterEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveContainedPath, resolveExistingContainedPath } from "../../../src/host/paths"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
describe("contained paths", () => {
  it("rejects lexical escapes", () => expect(() => resolveContainedPath("C:/workspace", "../outside", "module")).toThrow(/relative path/))
  it("resolves an existing contained file", async () => { const root = await mkdtemp(join(tmpdir(), "host-path-")); roots.push(root); await writeFile(join(root, "adapter.js"), "export {}\n"); expect(await resolveExistingContainedPath(root, "adapter.js", "file")).toContain("adapter.js") })
  it("rejects a directory symlink escape", async () => {
    const parent = await mkdtemp(join(tmpdir(), "host-symlink-")); roots.push(parent)
    const root = join(parent, "workspace"); const outside = join(parent, "outside")
    await mkdir(root); await mkdir(outside); await writeFile(join(outside, "adapter.js"), "export {}\n")
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
    await expect(resolveExistingContainedPath(root, "linked/adapter.js", "file")).rejects.toThrow(/escapes/)
  })
})
