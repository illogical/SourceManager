import { beforeEach, describe, expect, it, vi } from "vitest"

const appendFile = vi.fn(async () => {})
const mkdir = vi.fn(async () => undefined)

vi.mock("node:fs/promises", () => ({
  appendFile,
  mkdir,
}))

describe("request logger", () => {
  beforeEach(() => {
    appendFile.mockClear()
    mkdir.mockClear()
  })

  it("serializes concurrent entries as complete NDJSON lines", async () => {
    const { logRequest } = await import("../../../src/services/requestLogger")
    const entries = Array.from({ length: 20 }, (_, index) => ({
      timestamp: new Date(index).toISOString(),
      method: "GET",
      url: `http://localhost/health?request=${index}`,
      body: index === 0 ? { token: "secret" } : undefined,
      status: 200,
      durationMs: index,
      ip: "127.0.0.1",
    }))

    await Promise.all(entries.map((entry) => logRequest(entry)))

    expect(appendFile).toHaveBeenCalledTimes(entries.length)
    const lines = appendFile.mock.calls.map((call) => call[1] as string)
    const parsed = lines.map((line) => {
      expect(line.endsWith("\n")).toBe(true)
      return JSON.parse(line)
    })
    expect(parsed.map((entry) => entry.url)).toEqual(entries.map((entry) => entry.url))
    expect(parsed[0].body.token).toBe("[REDACTED]")
  })
})
