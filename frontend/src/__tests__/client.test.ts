import { beforeEach, vi } from "vitest"
import {
  getToken,
  setToken,
  clearToken,
  AuthError,
  ApiError,
  listRepos,
  testConnection,
  getEditableConfig,
  validateEditableConfig,
  applyEditableConfig,
} from "../api/client"
import type { EditableConfig } from "../api/types"

// ── localStorage stubs ─────────────────────────────────────────────────────

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

Object.defineProperty(globalThis, "localStorage", { value: localStorageMock })

// ── fetch stub ─────────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(String(body)),
  })
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

// ── Token helpers ──────────────────────────────────────────────────────────

describe("token helpers", () => {
  it("getToken returns null when not set", () => {
    expect(getToken()).toBeNull()
  })

  it("setToken stores in localStorage", () => {
    setToken("my-secret")
    expect(getToken()).toBe("my-secret")
  })

  it("clearToken removes from localStorage", () => {
    setToken("my-secret")
    clearToken()
    expect(getToken()).toBeNull()
  })
})

// ── apiFetch (via listRepos / testConnection) ──────────────────────────────

describe("API calls without token", () => {
  it("throws AuthError when no token is set", async () => {
    await expect(listRepos()).rejects.toBeInstanceOf(AuthError)
  })
})

describe("API calls with token", () => {
  beforeEach(() => setToken("test-token"))

  it("attaches X-DevServer-Token header", async () => {
    const fetch = mockFetch(200, { repos: [] })
    vi.stubGlobal("fetch", fetch)

    await listRepos()

    expect(fetch).toHaveBeenCalledOnce()
    const [, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)["X-DevServer-Token"]).toBe("test-token")
  })

  it("throws AuthError on 401", async () => {
    vi.stubGlobal("fetch", mockFetch(401, { error: "Unauthorized" }))
    await expect(listRepos()).rejects.toBeInstanceOf(AuthError)
  })

  it("throws ApiError on 500", async () => {
    vi.stubGlobal("fetch", mockFetch(500, { error: "Internal server error" }))
    const err = await listRepos().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(500)
  })

  it("returns parsed repos on success", async () => {
    const repos = [{ id: "my-repo", displayName: "My Repo", services: [] }]
    vi.stubGlobal("fetch", mockFetch(200, { repos }))

    const result = await listRepos()
    expect(result.repos).toEqual(repos)
  })

  it("testConnection calls /health", async () => {
    const fetch = mockFetch(200, { status: "ok" })
    vi.stubGlobal("fetch", fetch)

    await testConnection()

    const [url] = fetch.mock.calls[0] as [string]
    expect(url).toBe("/health")
  })
})

// ── Config edit API ────────────────────────────────────────────────────────

describe("Config edit functions", () => {
  const mockEditableConfig: EditableConfig = {
    server: { port: 17106, frontendPort: 17116, allowedIps: [] },
    repos: [],
  }

  beforeEach(() => setToken("test-token"))

  it("getEditableConfig calls GET /v1/config", async () => {
    const fetch = mockFetch(200, { config: mockEditableConfig })
    vi.stubGlobal("fetch", fetch)

    const result = await getEditableConfig()
    const [url] = fetch.mock.calls[0] as [string]
    expect(url).toBe("/v1/config")
    expect(result.config.server.port).toBe(17106)
  })

  it("validateEditableConfig calls POST /v1/config/validate", async () => {
    const mockResponse = {
      validation: { valid: true, errors: [], warnings: [] },
      diff: { changes: [], changeCount: 0 },
    }
    const fetch = mockFetch(200, mockResponse)
    vi.stubGlobal("fetch", fetch)

    const result = await validateEditableConfig(mockEditableConfig)
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/v1/config/validate")
    expect(init.method).toBe("POST")
    expect(result.validation.valid).toBe(true)
  })

  it("applyEditableConfig calls POST /v1/config/apply", async () => {
    const fetch = mockFetch(200, { success: true, changeCount: 2 })
    vi.stubGlobal("fetch", fetch)

    const result = await applyEditableConfig(mockEditableConfig)
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/v1/config/apply")
    expect(init.method).toBe("POST")
    expect(result.success).toBe(true)
    expect(result.changeCount).toBe(2)
  })

  it("applyEditableConfig throws ApiError on 422", async () => {
    vi.stubGlobal("fetch", mockFetch(422, { error: "Validation failed", validation: { errors: [] } }))
    const err = await applyEditableConfig(mockEditableConfig).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(422)
  })
})
