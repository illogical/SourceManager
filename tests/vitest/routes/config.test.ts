import { describe, it, expect, vi, beforeEach } from "vitest"
import type { EditableConfig, ValidationResult, ConfigDiff } from "../../../src/types"

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockEditableConfig: EditableConfig = {
  server: { frontendPort: 17116, allowedIps: [] },
  repos: [
    {
      id: "my-repo",
      displayName: "My Repo",
      repoPath: "my-repo",
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

const validationPassed: ValidationResult = { valid: true, errors: [], warnings: [] }
const mockDiff: ConfigDiff = { changes: [], changeCount: 0 }

vi.mock("../../../src/services/configEditor", () => ({
  readEditableConfig: vi.fn(() => mockEditableConfig),
  validateEditableConfig: vi.fn(() => validationPassed),
  diffEditableConfig: vi.fn(() => mockDiff),
  applyEditableConfig: vi.fn(async () => {}),
}))

vi.mock("../../../src/config", () => ({
  getConfig: vi.fn(() => ({
    workspacePath: "/localdev/projects",
    server: { port: 17106, token: "secret", frontendPort: 17116, allowedIps: [] },
    repos: [],
  })),
}))

// ── App builder ───────────────────────────────────────────────────────────────

async function buildApp() {
  const { Elysia } = await import("elysia")
  const { configRoute } = await import("../../../src/routes/config")

  return new Elysia()
    .group("/v1", (app) => app.use(configRoute))
}

const AUTH_HEADER = { "x-devserver-token": "test-token" }

// ── GET /v1/config ─────────────────────────────────────────────────────────────

describe("GET /v1/config", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("returns editable config snapshot", async () => {
    const app = await buildApp()
    const res = await app.handle(
      new Request("http://localhost/v1/config", { headers: AUTH_HEADER }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.config).toBeDefined()
    expect(body.runtime.port).toBe(17106)
    expect(body.runtime.workspacePath).toBe("/localdev/projects")
    expect(body.runtime.tokenConfigured).toBe(true)
    expect(body.config.server).not.toHaveProperty("token")
    expect(JSON.stringify(body)).not.toContain("secret")
  })
})

// ── POST /v1/config/validate ───────────────────────────────────────────────────

describe("POST /v1/config/validate", () => {
  it("returns validation result and diff", async () => {
    const app = await buildApp()
    const res = await app.handle(
      new Request("http://localhost/v1/config/validate", {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ config: mockEditableConfig }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.validation).toBeDefined()
    expect(body.diff).toBeDefined()
    expect(body.validation.valid).toBe(true)
  })

  it("returns 400 for missing config body", async () => {
    const app = await buildApp()
    const res = await app.handle(
      new Request("http://localhost/v1/config/validate", {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    )
    expect(res.status).toBe(400)
  })
})

// ── POST /v1/config/apply ──────────────────────────────────────────────────────

describe("POST /v1/config/apply", () => {
  it("applies config and returns success", async () => {
    const app = await buildApp()
    const res = await app.handle(
      new Request("http://localhost/v1/config/apply", {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ config: mockEditableConfig }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.changeCount).toBeDefined()
  })

  it("returns 422 when applyEditableConfig throws ValidationError", async () => {
    const { ValidationError } = await import("../../../src/types")
    const validationFailed: ValidationResult = {
      valid: false,
      errors: [{ path: "repos[0].repoPath", message: "Must be relative" }],
      warnings: [],
    }
    const configEditor = await import("../../../src/services/configEditor")
    vi.spyOn(configEditor, "applyEditableConfig").mockRejectedValueOnce(new ValidationError(validationFailed))

    const app = await buildApp()
    const res = await app.handle(
      new Request("http://localhost/v1/config/apply", {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ config: mockEditableConfig }),
      }),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toContain("Validation")
    expect(body.validation).toBeDefined()
  })

  it("returns 400 for missing config body", async () => {
    const app = await buildApp()
    const res = await app.handle(
      new Request("http://localhost/v1/config/apply", {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    )
    expect(res.status).toBe(400)
  })
})
