import { createServer } from "node:http"
import { describe, expect, it, vi } from "vitest"
import { RealtimeDispatcher } from "../../../src/host/realtime"

describe("shared realtime dispatcher", () => {
  it("dispatches exact owned paths and rejects duplicate ownership", () => {
    const dispatcher = new RealtimeDispatcher()
    const handler = vi.fn()
    dispatcher.registerWebSocket("/api/DevPlanner/ws", handler)
    expect(() => dispatcher.reserveSocketIo("/api/DevPlanner/ws")).toThrow(/already owned/)
    const server = createServer(); dispatcher.attach(server)
    const socket = { write: vi.fn(), destroy: vi.fn() }
    server.emit("upgrade", { url: "/api/DevPlanner/ws" }, socket, Buffer.alloc(0))
    expect(handler).toHaveBeenCalledOnce()
    server.emit("upgrade", { url: "/unknown" }, socket, Buffer.alloc(0))
    expect(socket.destroy).toHaveBeenCalledOnce()
    dispatcher.dispose()
  })
})
