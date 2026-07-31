import { describe, expect, it, vi } from "vitest"

const refreshAll = vi.hoisted(() => vi.fn(async () => ({
  checkedAt: "2026-07-31T12:00:00.000Z",
  durationMs: 12,
  services: [],
  tailscale: { machine: { state: "connected" }, services: [] },
})))

vi.mock("../../../src/services/statusCoordinator", () => ({
  statusCoordinator: { refreshAll },
}))

vi.mock("../../../src/routes/repos", () => ({
  buildReposResponse: vi.fn(async () => ({ repos: [] })),
}))

describe("POST /v1/status/refresh", () => {
  it("returns refreshed status and cached repo summaries", async () => {
    const { Elysia } = await import("elysia")
    const { statusRoute } = await import("../../../src/routes/status")
    const app = new Elysia().group("/v1", (group) => group.use(statusRoute))

    const response = await app.handle(new Request("http://localhost/v1/status/refresh", { method: "POST" }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(refreshAll).toHaveBeenCalledWith("manual_global")
    expect(body).toMatchObject({ durationMs: 12, repos: [], services: [] })
  })
})
