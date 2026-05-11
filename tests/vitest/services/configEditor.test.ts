import { describe, it, expect, vi } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  readEditableConfig,
  validateEditableConfig,
  diffEditableConfig,
  applyEditableConfig,
} from "../../../src/services/configEditor"
import type { EditableConfig } from "../../../src/types"

// ── Fixtures ──────────────────────────────────────────────────────────────────

const minimalConfig = {
  server: { port: 17106, frontendPort: 17116, token: "secret-token", allowedIps: [] },
  repos: [
    {
      id: "my-repo",
      displayName: "My Repo",
      repoPath: "/dev/my-repo",
      defaultBranch: "main",
      services: [
        {
          id: "my-repo-web",
          displayName: "Web",
          packageManager: "bun",
          scriptName: "dev",
          port: 3000,
          healthUrl: "http://localhost:3000/health",
          healthMode: "ping",
          tags: ["web"],
          allowedIps: [],
        },
      ],
    },
  ],
}

function makeTmp(content = minimalConfig): string {
  const dir = mkdtempSync(join(tmpdir(), "sm-configeditor-"))
  const path = join(dir, "projects.json")
  writeFileSync(path, JSON.stringify(content, null, 2), "utf-8")
  return path
}

// ── readEditableConfig ────────────────────────────────────────────────────────

describe("readEditableConfig", () => {
  it("returns an editable snapshot without token", () => {
    const path = makeTmp()
    const result = readEditableConfig(path)
    expect(result.server).not.toHaveProperty("token")
    expect(result.server.port).toBe(17106)
    expect(result.server.frontendPort).toBe(17116)
  })

  it("maps service fields correctly", () => {
    const path = makeTmp()
    const result = readEditableConfig(path)
    const svc = result.repos[0].services[0]
    expect(svc.id).toBe("my-repo-web")
    expect(svc.displayName).toBe("Web")
    expect(svc.port).toBe(3000)
    expect(svc.healthUrl).toBe("http://localhost:3000/health")
    expect(svc.tags).toEqual(["web"])
  })

  it("defaults optional service fields", () => {
    const path = makeTmp()
    const result = readEditableConfig(path)
    const svc = result.repos[0].services[0]
    expect(svc.packageManager).toBe("bun")
    expect(svc.scriptName).toBe("dev")
    expect(svc.installCommand).toBeNull()
    expect(svc.healthMode).toBe("ping")
  })
})

// ── validateEditableConfig ────────────────────────────────────────────────────

describe("validateEditableConfig", () => {
  function makeValid(): EditableConfig {
    return {
      server: { port: 17106, frontendPort: 17116, allowedIps: [] },
      repos: [
        {
          id: "my-repo",
          displayName: "My Repo",
          repoPath: "/dev/my-repo",
          defaultBranch: "main",
          services: [
            {
              id: "my-repo-web",
              displayName: "Web",
              packageManager: "bun",
              scriptName: "dev",
              installCommand: null,
              port: 3000,
              healthUrl: "http://localhost:3000/health",
              healthMode: "ping",
              tags: [],
              allowedIps: [],
            },
          ],
        },
      ],
    }
  }

  it("passes a valid config", () => {
    expect(validateEditableConfig(makeValid()).valid).toBe(true)
  })

  it("rejects invalid server port", () => {
    const cfg = makeValid()
    cfg.server.port = 0
    const result = validateEditableConfig(cfg)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path === "server.port")).toBe(true)
  })

  it("rejects invalid frontendPort", () => {
    const cfg = makeValid()
    cfg.server.frontendPort = 99999
    const result = validateEditableConfig(cfg)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path === "server.frontendPort")).toBe(true)
  })

  it("rejects bad CIDR in server allowedIps", () => {
    const cfg = makeValid()
    cfg.server.allowedIps = ["not-a-cidr"]
    const result = validateEditableConfig(cfg)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path === "server.allowedIps")).toBe(true)
  })

  it("accepts valid CIDR allowedIps", () => {
    const cfg = makeValid()
    cfg.server.allowedIps = ["192.168.1.0/24"]
    expect(validateEditableConfig(cfg).valid).toBe(true)
  })

  it("rejects empty repo displayName", () => {
    const cfg = makeValid()
    cfg.repos[0].displayName = "  "
    const result = validateEditableConfig(cfg)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path === "repos[0].displayName")).toBe(true)
  })

  it("rejects empty repo repoPath", () => {
    const cfg = makeValid()
    cfg.repos[0].repoPath = ""
    const result = validateEditableConfig(cfg)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path === "repos[0].repoPath")).toBe(true)
  })

  it("rejects invalid branch name", () => {
    const cfg = makeValid()
    cfg.repos[0].defaultBranch = "feat branch!" // space + excl
    const result = validateEditableConfig(cfg)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path === "repos[0].defaultBranch")).toBe(true)
  })

  it("rejects invalid service port", () => {
    const cfg = makeValid()
    cfg.repos[0].services[0].port = -1
    const result = validateEditableConfig(cfg)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("services[0]") && e.path.includes("port"))).toBe(true)
  })

  it("rejects bad health URL", () => {
    const cfg = makeValid()
    cfg.repos[0].services[0].healthUrl = "ftp://not-http.com"
    const result = validateEditableConfig(cfg)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("healthUrl"))).toBe(true)
  })

  it("rejects script name with invalid chars", () => {
    const cfg = makeValid()
    cfg.repos[0].services[0].scriptName = "bad script!"
    const result = validateEditableConfig(cfg)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("scriptName"))).toBe(true)
  })

  it("rejects installCommand with shell metacharacters", () => {
    const cfg = makeValid()
    cfg.repos[0].services[0].installCommand = "bun install && rm -rf /"
    const result = validateEditableConfig(cfg)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("installCommand"))).toBe(true)
  })

  it("allows valid installCommand", () => {
    const cfg = makeValid()
    cfg.repos[0].services[0].installCommand = "bun install --frozen-lockfile"
    expect(validateEditableConfig(cfg).valid).toBe(true)
  })

  it("warns when tailscaleServeEnabled is true without hostname", () => {
    const cfg = makeValid()
    cfg.repos[0].services[0].tailscaleServeEnabled = true
    const result = validateEditableConfig(cfg)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it("rejects invalid tailnetHostname", () => {
    const cfg = makeValid()
    cfg.repos[0].services[0].tailnetHostname = "UPPERCASE!"
    const result = validateEditableConfig(cfg)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path.includes("tailnetHostname"))).toBe(true)
  })
})

// ── diffEditableConfig ────────────────────────────────────────────────────────

describe("diffEditableConfig", () => {
  function makeEditable(): EditableConfig {
    return {
      server: { port: 17106, frontendPort: 17116, allowedIps: [] },
      repos: [
        {
          id: "my-repo",
          displayName: "My Repo",
          repoPath: "/dev/my-repo",
          defaultBranch: "main",
          services: [
            {
              id: "my-repo-web",
              displayName: "Web",
              packageManager: "bun",
              scriptName: "dev",
              installCommand: null,
              port: 3000,
              healthUrl: "http://localhost:3000/health",
              healthMode: "ping",
              tags: [],
              allowedIps: [],
            },
          ],
        },
      ],
    }
  }

  it("returns zero changes for identical configs", () => {
    const cfg = makeEditable()
    const diff = diffEditableConfig(cfg, cfg)
    expect(diff.changeCount).toBe(0)
  })

  it("detects a port change", () => {
    const a = makeEditable()
    const b = makeEditable()
    b.server.port = 9000
    const diff = diffEditableConfig(a, b)
    expect(diff.changeCount).toBe(1)
    expect(diff.changes[0].path).toBe("server.port")
    expect(diff.changes[0].oldValue).toBe(17106)
    expect(diff.changes[0].newValue).toBe(9000)
  })

  it("detects a repo displayName change", () => {
    const a = makeEditable()
    const b = makeEditable()
    b.repos[0].displayName = "New Name"
    const diff = diffEditableConfig(a, b)
    expect(diff.changes.some((c) => c.path === "repos[0].displayName")).toBe(true)
  })

  it("detects a service tag change", () => {
    const a = makeEditable()
    const b = makeEditable()
    b.repos[0].services[0].tags = ["web", "api"]
    const diff = diffEditableConfig(a, b)
    expect(diff.changes.some((c) => c.path.includes("services[0]") && c.path.includes("tags"))).toBe(true)
  })
})

// ── applyEditableConfig ───────────────────────────────────────────────────────

describe("applyEditableConfig", () => {
  function makeValid(): EditableConfig {
    return {
      server: { port: 17106, frontendPort: 17116, allowedIps: [] },
      repos: [
        {
          id: "my-repo",
          displayName: "My Repo",
          repoPath: "/dev/my-repo",
          defaultBranch: "main",
          services: [
            {
              id: "my-repo-web",
              displayName: "Web",
              packageManager: "bun",
              scriptName: "dev",
              installCommand: null,
              port: 3000,
              healthUrl: "http://localhost:3000/health",
              healthMode: "ping",
              tags: [],
              allowedIps: [],
            },
          ],
        },
      ],
    }
  }

  it("writes updated fields and preserves token", async () => {
    const path = makeTmp()
    const mockInvalidate = vi.fn()

    const proposed = makeValid()
    proposed.repos[0].displayName = "Updated Repo"
    proposed.repos[0].services[0].port = 4000

    await applyEditableConfig(proposed, path, mockInvalidate)

    const written = JSON.parse(readFileSync(path, "utf-8"))
    expect(written.server.token).toBe("secret-token")      // token preserved
    expect(written.repos[0].id).toBe("my-repo")            // id preserved
    expect(written.repos[0].displayName).toBe("Updated Repo")
    expect(written.repos[0].services[0].port).toBe(4000)
    expect(written.repos[0].services[0].id).toBe("my-repo-web") // service id preserved
    expect(mockInvalidate).toHaveBeenCalledTimes(1)
  })

  it("throws ValidationError for invalid config", async () => {
    const path = makeTmp()
    const mockInvalidate = vi.fn()

    const proposed = makeValid()
    proposed.server.port = 0 // invalid

    await expect(applyEditableConfig(proposed, path, mockInvalidate)).rejects.toMatchObject({
      name: "ValidationError",
    })
    expect(mockInvalidate).not.toHaveBeenCalled()
  })

  it("strips null installCommand from output", async () => {
    const path = makeTmp()
    const proposed = makeValid()
    proposed.repos[0].services[0].installCommand = null

    await applyEditableConfig(proposed, path, vi.fn())

    const written = JSON.parse(readFileSync(path, "utf-8"))
    // installCommand should be undefined/absent (not null) in the written file
    expect(written.repos[0].services[0].installCommand).toBeUndefined()
  })
})
