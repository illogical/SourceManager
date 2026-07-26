import { describe, it, expect } from "bun:test"
import {
  loadEnvironmentConfig,
  resolveRepoPaths,
  validateConfig,
  ConfigError,
} from "../src/config"
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
    workspacePath: "/workspace",
    server: {
      port: 17106,
      token: "test-token",
      allowedIps: [],
    },
    repos: [
      {
        id: "my-app",
        displayName: "My App",
        repoPath: "my-app",
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

    it("defaults server.frontendPort when omitted", () => {
      const cfg = validConfig()
      validateConfig(cfg)
      expect(cfg.server.frontendPort).toBe(5173)
    })

    it("throws ConfigError when server.frontendPort is 0", () => {
      const cfg = validConfig()
      cfg.server.frontendPort = 0
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
        repoPath: "second-repo",
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
        repoPath: "other",
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
      repoPath: "second",
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

describe("environment configuration and repo resolution", () => {
  it("loads required deployment values", () => {
    const result = loadEnvironmentConfig({
      SOURCEMANAGER_PORT: "18080",
      SOURCEMANAGER_TOKEN: "environment-token",
      SOURCEMANAGER_WORKSPACE_PATH: "/localdev/projects",
    })

    expect(result).toEqual({
      port: 18080,
      token: "environment-token",
      workspacePath: "/localdev/projects",
    })
  })

  it("rejects missing and malformed deployment values", () => {
    expect(() => loadEnvironmentConfig({})).toThrow(ConfigError)
    expect(() => loadEnvironmentConfig({
      SOURCEMANAGER_PORT: "17.5",
      SOURCEMANAGER_TOKEN: "token",
      SOURCEMANAGER_WORKSPACE_PATH: "/workspace",
    })).toThrow(ConfigError)
    expect(() => loadEnvironmentConfig({
      SOURCEMANAGER_PORT: "70000",
      SOURCEMANAGER_TOKEN: "token",
      SOURCEMANAGER_WORKSPACE_PATH: "/workspace",
    })).toThrow(ConfigError)
    expect(() => loadEnvironmentConfig({
      SOURCEMANAGER_PORT: "17106",
      SOURCEMANAGER_TOKEN: " ",
      SOURCEMANAGER_WORKSPACE_PATH: "/workspace",
    })).toThrow(ConfigError)
    expect(() => loadEnvironmentConfig({
      SOURCEMANAGER_PORT: "17106",
      SOURCEMANAGER_TOKEN: "token",
      SOURCEMANAGER_WORKSPACE_PATH: "relative/workspace",
    })).toThrow(ConfigError)
  })

  it("resolves the same repo path beneath different workspaces", () => {
    const local = validConfig()
    local.workspacePath = "/Users/example/projects"
    const secondLocalMachine = validConfig()
    secondLocalMachine.workspacePath = "/localdev/projects"

    resolveRepoPaths(local)
    resolveRepoPaths(secondLocalMachine)

    expect(local.repos[0].repoPath).toBe("/Users/example/projects/my-app")
    expect(secondLocalMachine.repos[0].repoPath).toBe("/localdev/projects/my-app")
  })

  it("rejects absolute and escaping repo paths", () => {
    const absolute = validConfig()
    absolute.repos[0].repoPath = "/outside/my-app"
    expect(() => validateConfig(absolute)).toThrow(ConfigError)

    const windowsAbsolute = validConfig()
    windowsAbsolute.repos[0].repoPath = "C:\\outside\\my-app"
    expect(() => validateConfig(windowsAbsolute)).toThrow(ConfigError)

    const traversal = validConfig()
    traversal.repos[0].repoPath = "../my-app"
    expect(() => validateConfig(traversal)).toThrow(ConfigError)
  })
})
