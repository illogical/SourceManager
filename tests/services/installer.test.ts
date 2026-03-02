import { describe, it, expect, spyOn, afterEach, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import type { ProjectConfig } from "../../src/types"
import { detectPackageManager, runInstall } from "../../src/services/installer"

// ── Temp directory helpers ────────────────────────────────────────────────────

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sm-installer-test-"))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeProjectDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpDir, "proj-"))
  for (const file of files) {
    writeFileSync(join(dir, file), "")
  }
  return dir
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "test",
    repoPath: tmpDir,
    defaultBranch: "main",
    healthUrl: "http://localhost:3000/health",
    healthMode: "ping",
    port: 3000,
    packageManager: "auto",
    scriptName: "dev",
    allowedIps: [],
    ...overrides,
  }
}

// ── detectPackageManager (integration: real temp dirs) ────────────────────────

describe("detectPackageManager", () => {

  it('returns "bun" when only bun.lockb exists', async () => {
    const dir = makeProjectDir(["bun.lockb"])
    expect(await detectPackageManager(dir)).toBe("bun")
  })

  it('returns "pnpm" when only pnpm-lock.yaml exists', async () => {
    const dir = makeProjectDir(["pnpm-lock.yaml"])
    expect(await detectPackageManager(dir)).toBe("pnpm")
  })

  it('returns "yarn" when only yarn.lock exists', async () => {
    const dir = makeProjectDir(["yarn.lock"])
    expect(await detectPackageManager(dir)).toBe("yarn")
  })

  it('returns "npm" when only package-lock.json exists', async () => {
    const dir = makeProjectDir(["package-lock.json"])
    expect(await detectPackageManager(dir)).toBe("npm")
  })

  it('returns "bun" as fallback when no lockfile found', async () => {
    const dir = makeProjectDir(["README.md"])
    expect(await detectPackageManager(dir)).toBe("bun")
  })

  it("bun.lockb wins over all other lockfiles", async () => {
    const dir = makeProjectDir(["bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"])
    expect(await detectPackageManager(dir)).toBe("bun")
  })

  it("pnpm wins over yarn and npm when no bun.lockb", async () => {
    const dir = makeProjectDir(["pnpm-lock.yaml", "yarn.lock", "package-lock.json"])
    expect(await detectPackageManager(dir)).toBe("pnpm")
  })

  it("yarn wins over npm when no bun.lockb or pnpm-lock.yaml", async () => {
    const dir = makeProjectDir(["yarn.lock", "package-lock.json"])
    expect(await detectPackageManager(dir)).toBe("yarn")
  })
})

// ── runInstall ────────────────────────────────────────────────────────────────

describe("runInstall", () => {

  let spawnSpy: ReturnType<typeof spyOn>

  function mockSpawn(exitCode: number, stdout = "", stderr = "") {
    const enc = new TextEncoder()
    const makeStream = (data: string) =>
      new ReadableStream({
        start(c) {
          if (data) c.enqueue(enc.encode(data))
          c.close()
        },
      })
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(
      () =>
        ({
          stdout: makeStream(stdout),
          stderr: makeStream(stderr),
          exited: Promise.resolve(exitCode),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
    )
  }

  afterEach(() => {
    spawnSpy?.mockRestore()
  })

  it("returns success on exit code 0", async () => {
    mockSpawn(0, "3 packages installed")
    const dir = makeProjectDir(["bun.lockb"])
    const result = await runInstall(makeProject({ repoPath: dir, packageManager: "bun" }))
    expect(result.status).toBe("success")
    expect(result.step).toBe("install")
  })

  it("returns failure when install exits with non-zero code", async () => {
    mockSpawn(1, "", "ERR_PEER_DEP")
    const result = await runInstall(makeProject({ packageManager: "npm" }))
    expect(result.status).toBe("failure")
    expect(result.message).toContain("ERR_PEER_DEP")
  })

  it("uses custom installCommand (split on spaces)", async () => {
    mockSpawn(0)
    await runInstall(makeProject({ installCommand: "npm ci" }))
    expect(spawnSpy).toHaveBeenCalledWith(
      expect.arrayContaining(["npm", "ci"]),
      expect.any(Object)
    )
  })

  it("reports success message containing the command used", async () => {
    mockSpawn(0)
    const result = await runInstall(makeProject({ installCommand: "pnpm install --frozen-lockfile" }))
    expect(result.status).toBe("success")
    expect(result.message).toContain("pnpm")
  })

  it("auto-detects bun when bun.lockb present", async () => {
    mockSpawn(0)
    const dir = makeProjectDir(["bun.lockb"])
    await runInstall(makeProject({ repoPath: dir, packageManager: "auto" }))
    expect(spawnSpy).toHaveBeenCalledWith(
      expect.arrayContaining(["bun", "install"]),
      expect.any(Object)
    )
  })

  it("auto-detects npm when only package-lock.json present", async () => {
    mockSpawn(0)
    const dir = makeProjectDir(["package-lock.json"])
    await runInstall(makeProject({ repoPath: dir, packageManager: "auto" }))
    expect(spawnSpy).toHaveBeenCalledWith(
      expect.arrayContaining(["npm", "install"]),
      expect.any(Object)
    )
  })
})
