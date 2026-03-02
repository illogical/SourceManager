import { describe, it, expect } from "bun:test"
import { validateConfig, ConfigError } from "../src/config"
import type { AppConfig } from "../src/types"

function validConfig(): AppConfig {
  return {
    server: {
      port: 17106,
      token: "test-token",
      allowedIps: [],
    },
    projects: [
      {
        id: "my-app",
        repoPath: "C:\\dev\\my-app",
        defaultBranch: "main",
        healthUrl: "http://localhost:3000/health",
        healthMode: "ping",
        port: 3000,
        packageManager: "auto",
        scriptName: "dev",
        allowedIps: [],
      },
    ],
  }
}

describe("validateConfig", () => {
  it("accepts a valid config without throwing", () => {
    expect(() => validateConfig(validConfig())).not.toThrow()
  })

  describe("server section", () => {
    it("throws ConfigError when server.token is missing", () => {
      const cfg = validConfig()
      cfg.server.token = ""
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws ConfigError when server.port is missing", () => {
      const cfg = validConfig()
      // @ts-expect-error intentionally invalid
      cfg.server.port = 0
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws ConfigError when projects is not an array", () => {
      const cfg = validConfig()
      // @ts-expect-error intentionally invalid
      cfg.projects = null
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws ConfigError when projects is an object (not array)", () => {
      const cfg = validConfig()
      // @ts-expect-error intentionally invalid
      cfg.projects = {}
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })
  })

  describe("required project fields", () => {
    it("throws when project.id is missing", () => {
      const cfg = validConfig()
      // @ts-expect-error intentionally invalid
      cfg.projects[0].id = ""
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when duplicate project.id exists", () => {
      const cfg = validConfig()
      cfg.projects.push({ ...cfg.projects[0] }) // same id
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when project.repoPath is missing", () => {
      const cfg = validConfig()
      cfg.projects[0].repoPath = ""
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when project.defaultBranch is missing", () => {
      const cfg = validConfig()
      cfg.projects[0].defaultBranch = ""
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when project.healthUrl is missing", () => {
      const cfg = validConfig()
      cfg.projects[0].healthUrl = ""
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when project.port is 0 (falsy)", () => {
      const cfg = validConfig()
      cfg.projects[0].port = 0
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })
  })

  describe("optional field defaults", () => {
    it("sets healthMode to ping when omitted", () => {
      const cfg = validConfig()
      // @ts-expect-error testing undefined case
      delete cfg.projects[0].healthMode
      validateConfig(cfg)
      expect(cfg.projects[0].healthMode).toBe("ping")
    })

    it("sets packageManager to auto when omitted", () => {
      const cfg = validConfig()
      // @ts-expect-error testing undefined case
      delete cfg.projects[0].packageManager
      validateConfig(cfg)
      expect(cfg.projects[0].packageManager).toBe("auto")
    })

    it("sets scriptName to dev when omitted", () => {
      const cfg = validConfig()
      // @ts-expect-error testing undefined case
      delete cfg.projects[0].scriptName
      validateConfig(cfg)
      expect(cfg.projects[0].scriptName).toBe("dev")
    })

    it("sets allowedIps to [] when omitted", () => {
      const cfg = validConfig()
      // @ts-expect-error testing undefined case
      delete cfg.projects[0].allowedIps
      validateConfig(cfg)
      expect(cfg.projects[0].allowedIps).toEqual([])
    })

    it("sets server.allowedIps to [] when omitted", () => {
      const cfg = validConfig()
      // @ts-expect-error testing undefined case
      delete cfg.server.allowedIps
      validateConfig(cfg)
      expect(cfg.server.allowedIps).toEqual([])
    })

    it("preserves existing optional values", () => {
      const cfg = validConfig()
      cfg.projects[0].healthMode = "full"
      cfg.projects[0].packageManager = "npm"
      cfg.projects[0].scriptName = "start"
      cfg.projects[0].allowedIps = ["10.0.0.0/24"]
      validateConfig(cfg)
      expect(cfg.projects[0].healthMode).toBe("full")
      expect(cfg.projects[0].packageManager).toBe("npm")
      expect(cfg.projects[0].scriptName).toBe("start")
      expect(cfg.projects[0].allowedIps).toEqual(["10.0.0.0/24"])
    })
  })

  it("validates multiple projects independently", () => {
    const cfg = validConfig()
    cfg.projects.push({
      id: "second-app",
      repoPath: "C:\\dev\\second-app",
      defaultBranch: "main",
      healthUrl: "http://localhost:4000/health",
      healthMode: "full",
      port: 4000,
      packageManager: "npm",
      scriptName: "start",
      allowedIps: [],
    })
    expect(() => validateConfig(cfg)).not.toThrow()
    expect(cfg.projects).toHaveLength(2)
  })
})
