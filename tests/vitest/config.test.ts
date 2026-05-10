import { describe, it, expect, beforeEach } from "vitest"
import { validateConfig, ConfigError, getRepo, getService, getAllServices, requireRepo, requireService, RepoNotFoundError, ServiceNotFoundError } from "../../src/config"
import type { AppConfig } from "../../src/types"

function validService(overrides: Partial<{ id: string; port: number; healthUrl: string }> = {}) {
  return {
    id: overrides.id ?? "my-app-web",
    displayName: "Web",
    packageManager: "auto" as const,
    scriptName: "dev",
    port: overrides.port ?? 3000,
    healthUrl: overrides.healthUrl ?? "http://localhost:3000/health",
    healthMode: "ping" as const,
    tags: [],
    allowedIps: [],
  }
}

function validConfig(): AppConfig {
  return {
    server: { port: 17106, token: "test-token", allowedIps: [] },
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

describe("validateConfig — schema shape", () => {
  it("accepts a valid config", () => {
    expect(() => validateConfig(validConfig())).not.toThrow()
  })

  it("throws ConfigError on old format (projects key)", () => {
    const cfg = { server: { port: 17106, token: "token" }, projects: [] } as unknown as AppConfig
    expect(() => validateConfig(cfg)).toThrow(ConfigError)
  })
})

describe("validateConfig — server validation", () => {
  it("throws when token is empty", () => {
    const cfg = validConfig(); cfg.server.token = ""
    expect(() => validateConfig(cfg)).toThrow(ConfigError)
  })

  it("throws when port is 0", () => {
    const cfg = validConfig(); (cfg.server as { port: number }).port = 0
    expect(() => validateConfig(cfg)).toThrow(ConfigError)
  })
})

describe("validateConfig — repo validation", () => {
  it("throws when repo.id is empty", () => {
    const cfg = validConfig(); cfg.repos[0].id = ""
    expect(() => validateConfig(cfg)).toThrow(ConfigError)
  })

  it("throws when repo.id has uppercase chars", () => {
    const cfg = validConfig(); cfg.repos[0].id = "My-App"
    expect(() => validateConfig(cfg)).toThrow(ConfigError)
  })

  it("throws when two repos have the same id", () => {
    const cfg = validConfig()
    cfg.repos.push({ ...cfg.repos[0], services: [validService({ id: "other-svc", port: 4000, healthUrl: "http://localhost:4000/h" })] })
    expect(() => validateConfig(cfg)).toThrow(ConfigError)
  })

  it("throws when repo has empty services array", () => {
    const cfg = validConfig(); cfg.repos[0].services = []
    expect(() => validateConfig(cfg)).toThrow(ConfigError)
  })
})

describe("validateConfig — service validation", () => {
  it("throws when service.id contains underscore", () => {
    const cfg = validConfig(); cfg.repos[0].services[0].id = "my_app"
    expect(() => validateConfig(cfg)).toThrow(ConfigError)
  })

  it("throws when service ids are not globally unique", () => {
    const cfg = validConfig()
    cfg.repos.push({
      id: "second-repo",
      displayName: "Second",
      repoPath: "/dev/second",
      defaultBranch: "main",
      services: [validService({ port: 4000, healthUrl: "http://localhost:4000/h" })], // same id
    })
    expect(() => validateConfig(cfg)).toThrow(ConfigError)
  })

  it("throws when service.scriptName contains a space", () => {
    const cfg = validConfig(); cfg.repos[0].services[0].scriptName = "my script"
    expect(() => validateConfig(cfg)).toThrow(ConfigError)
  })

  it("throws when service.port is 0", () => {
    const cfg = validConfig(); cfg.repos[0].services[0].port = 0
    expect(() => validateConfig(cfg)).toThrow(ConfigError)
  })

  it("throws when service.healthUrl is empty", () => {
    const cfg = validConfig(); cfg.repos[0].services[0].healthUrl = ""
    expect(() => validateConfig(cfg)).toThrow(ConfigError)
  })

  it("sets defaults for optional fields", () => {
    const cfg = validConfig()
    // @ts-expect-error testing undefined
    delete cfg.repos[0].services[0].healthMode
    // @ts-expect-error testing undefined
    delete cfg.repos[0].services[0].packageManager
    // @ts-expect-error testing undefined
    delete cfg.repos[0].services[0].scriptName
    // @ts-expect-error testing undefined
    delete cfg.repos[0].services[0].tags
    // @ts-expect-error testing undefined
    delete cfg.repos[0].services[0].allowedIps
    validateConfig(cfg)
    expect(cfg.repos[0].services[0].healthMode).toBe("ping")
    expect(cfg.repos[0].services[0].packageManager).toBe("auto")
    expect(cfg.repos[0].services[0].scriptName).toBe("dev")
    expect(cfg.repos[0].services[0].tags).toEqual([])
    expect(cfg.repos[0].services[0].allowedIps).toEqual([])
  })
})

describe("validateConfig — tailnet field validation", () => {
  it("accepts valid tailnet fields", () => {
    const cfg = validConfig()
    cfg.repos[0].services[0].tailnetHostname = "my-app"
    cfg.repos[0].services[0].tailnetDomain = "example.ts.net"
    cfg.repos[0].services[0].tailscaleServeEnabled = true
    cfg.repos[0].services[0].tailscaleServeMode = "https"
    cfg.repos[0].services[0].tailscaleServeTarget = "http://localhost:3000"
    expect(() => validateConfig(cfg)).not.toThrow()
  })

  it("throws when tailnetHostname contains a dot", () => {
    const cfg = validConfig()
    cfg.repos[0].services[0].tailnetHostname = "my.app"
    expect(() => validateConfig(cfg)).toThrow(ConfigError)
  })

  it("throws when tailscaleServeMode is not https", () => {
    const cfg = validConfig()
    cfg.repos[0].services[0].tailscaleServeMode = "http" as "https"
    expect(() => validateConfig(cfg)).toThrow(ConfigError)
  })
})

describe("config accessors", () => {
  beforeEach(() => {
    validateConfig(validConfig())
  })

  it("getRepo returns the repo when found", () => {
    const repo = getRepo("my-app")
    expect(repo?.id).toBe("my-app")
  })

  it("getRepo returns undefined for unknown id", () => {
    expect(getRepo("nonexistent")).toBeUndefined()
  })

  it("requireRepo throws RepoNotFoundError for unknown id", () => {
    expect(() => requireRepo("nonexistent")).toThrow(RepoNotFoundError)
  })

  it("getService returns repo+service for known serviceId", () => {
    const result = getService("my-app-web")
    expect(result?.service.id).toBe("my-app-web")
    expect(result?.repo.id).toBe("my-app")
  })

  it("getService returns undefined for unknown serviceId", () => {
    expect(getService("nope")).toBeUndefined()
  })

  it("requireService throws ServiceNotFoundError for unknown serviceId", () => {
    expect(() => requireService("nope")).toThrow(ServiceNotFoundError)
  })

  it("getAllServices returns all services across all repos", () => {
    // Config is already loaded by beforeEach with validConfig()
    const all = getAllServices()
    expect(all.length).toBeGreaterThanOrEqual(1)
    expect(all.some((e) => e.service.id === "my-app-web")).toBe(true)
  })
})
