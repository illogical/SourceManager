import { describe, it, expect } from "bun:test"
import { validateConfig, ConfigError } from "../src/config"
import type { AppConfig } from "../src/types"

function validService(overrides?: object) {
  return {
    id: "my-app-web",
    displayName: "Web",
    packageManager: "auto" as const,
    scriptName: "dev",
    port: 3000,
    healthUrl: "http://localhost:3000/health",
    healthMode: "ping" as const,
    tags: [],
    allowedIps: [],
    ...overrides,
  }
}

function validConfig(): AppConfig {
  return {
    server: {
      port: 17106,
      token: "test-token",
      allowedIps: [],
    },
    repos: [
      {
        id: "my-app",
        displayName: "My App",
        repoPath: "/dev/my-app",
        defaultBranch: "main",
        services: [validService()],
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

    it("throws ConfigError when server.port is 0", () => {
      const cfg = validConfig()
      // @ts-expect-error intentionally invalid
      cfg.server.port = 0
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws ConfigError when repos is not an array", () => {
      const cfg = validConfig()
      // @ts-expect-error intentionally invalid
      cfg.repos = null
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws ConfigError when repos is an object (not array)", () => {
      const cfg = validConfig()
      // @ts-expect-error intentionally invalid
      cfg.repos = {}
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })
  })

  describe("required repo fields", () => {
    it("throws when repo.id is missing", () => {
      const cfg = validConfig()
      // @ts-expect-error intentionally invalid
      cfg.repos[0].id = ""
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when repo.repoPath is missing", () => {
      const cfg = validConfig()
      cfg.repos[0].repoPath = ""
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when repo.defaultBranch is missing", () => {
      const cfg = validConfig()
      cfg.repos[0].defaultBranch = ""
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when repo.services is not an array", () => {
      const cfg = validConfig()
      // @ts-expect-error intentionally invalid
      cfg.repos[0].services = null
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when repo has no services", () => {
      const cfg = validConfig()
      cfg.repos[0].services = []
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })
  })

  describe("required service fields", () => {
    it("throws when service.id is missing", () => {
      const cfg = validConfig()
      // @ts-expect-error intentionally invalid
      cfg.repos[0].services[0].id = ""
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when service.id contains invalid characters", () => {
      const cfg = validConfig()
      cfg.repos[0].services[0].id = "My_App"
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when service.healthUrl is missing", () => {
      const cfg = validConfig()
      cfg.repos[0].services[0].healthUrl = ""
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when service.port is 0", () => {
      const cfg = validConfig()
      cfg.repos[0].services[0].port = 0
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when service.scriptName contains spaces", () => {
      const cfg = validConfig()
      cfg.repos[0].services[0].scriptName = "my script"
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })
  })

  describe("duplicate detection", () => {
    it("throws when two services in the same repo share an id", () => {
      const cfg = validConfig()
      cfg.repos[0].services.push(validService({ id: "my-app-web", port: 4000, healthUrl: "http://localhost:4000/health" }))
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when two services across different repos share an id", () => {
      const cfg = validConfig()
      cfg.repos.push({
        id: "second-repo",
        displayName: "Second",
        repoPath: "/dev/second-repo",
        defaultBranch: "main",
        services: [validService({ port: 4000, healthUrl: "http://localhost:4000/health" })], // same service id "my-app-web"
      })
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })

    it("throws when two repos share the same id", () => {
      const cfg = validConfig()
      cfg.repos.push({
        id: "my-app",
        displayName: "Duplicate",
        repoPath: "/dev/other",
        defaultBranch: "main",
        services: [validService({ id: "other-svc", port: 4000, healthUrl: "http://localhost:4000/health" })],
      })
      expect(() => validateConfig(cfg)).toThrow(ConfigError)
    })
  })

  describe("optional field defaults", () => {
    it("sets service.healthMode to ping when omitted", () => {
      const cfg = validConfig()
      // @ts-expect-error testing undefined case
      delete cfg.repos[0].services[0].healthMode
      validateConfig(cfg)
      expect(cfg.repos[0].services[0].healthMode).toBe("ping")
    })

    it("sets service.packageManager to auto when omitted", () => {
      const cfg = validConfig()
      // @ts-expect-error testing undefined case
      delete cfg.repos[0].services[0].packageManager
      validateConfig(cfg)
      expect(cfg.repos[0].services[0].packageManager).toBe("auto")
    })

    it("sets service.scriptName to dev when omitted", () => {
      const cfg = validConfig()
      // @ts-expect-error testing undefined case
      delete cfg.repos[0].services[0].scriptName
      validateConfig(cfg)
      expect(cfg.repos[0].services[0].scriptName).toBe("dev")
    })

    it("sets service.allowedIps to [] when omitted", () => {
      const cfg = validConfig()
      // @ts-expect-error testing undefined case
      delete cfg.repos[0].services[0].allowedIps
      validateConfig(cfg)
      expect(cfg.repos[0].services[0].allowedIps).toEqual([])
    })

    it("sets service.tags to [] when omitted", () => {
      const cfg = validConfig()
      // @ts-expect-error testing undefined case
      delete cfg.repos[0].services[0].tags
      validateConfig(cfg)
      expect(cfg.repos[0].services[0].tags).toEqual([])
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
      cfg.repos[0].services[0].healthMode = "full"
      cfg.repos[0].services[0].packageManager = "npm"
      cfg.repos[0].services[0].scriptName = "start"
      cfg.repos[0].services[0].allowedIps = ["10.0.0.0/24"]
      validateConfig(cfg)
      expect(cfg.repos[0].services[0].healthMode).toBe("full")
      expect(cfg.repos[0].services[0].packageManager).toBe("npm")
      expect(cfg.repos[0].services[0].scriptName).toBe("start")
      expect(cfg.repos[0].services[0].allowedIps).toEqual(["10.0.0.0/24"])
    })
  })

  it("validates multiple repos with multiple services independently", () => {
    const cfg = validConfig()
    cfg.repos.push({
      id: "second-repo",
      displayName: "Second",
      repoPath: "/dev/second",
      defaultBranch: "develop",
      services: [
        validService({ id: "second-api", port: 4000, healthUrl: "http://localhost:4000/health" }),
        validService({ id: "second-worker", port: 5000, healthUrl: "http://localhost:5000/health" }),
      ],
    })
    expect(() => validateConfig(cfg)).not.toThrow()
    expect(cfg.repos).toHaveLength(2)
    expect(cfg.repos[1].services).toHaveLength(2)
  })
})
