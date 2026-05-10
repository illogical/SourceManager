import { beforeEach, vi } from "vitest"
import {
  getToken,
  setToken,
  clearToken,
  AuthError,
  ApiError,
  listRepos,
  testConnection,
} from "../api/client"

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
