import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import type { RealtimeRegistrar } from "./contract"

interface UpgradeOwner {
  path: string
  handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
}

export class RealtimeDispatcher implements RealtimeRegistrar {
  private readonly upgrades = new Map<string, UpgradeOwner>()
  private readonly socketIoPaths = new Set<string>()
  private server: Server | null = null
  private listener = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname
    const owner = [...this.upgrades.values()].sort((a, b) => b.path.length - a.path.length).find((entry) => pathname === entry.path || pathname.startsWith(`${entry.path}/`))
    if (owner) return owner.handler(request, socket, head)
    if ([...this.socketIoPaths].some((path) => pathname === path || pathname.startsWith(`${path}/`))) return
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
    socket.destroy()
  }

  attach(server: Server): void {
    if (this.server) throw new Error("Realtime dispatcher is already attached")
    this.server = server
    server.prependListener("upgrade", this.listener)
  }

  registerWebSocket(path: string, handler: UpgradeOwner["handler"]): () => void {
    if (this.upgrades.has(path) || this.socketIoPaths.has(path)) throw new Error(`Realtime path already owned: ${path}`)
    this.upgrades.set(path, { path, handler })
    return () => { this.upgrades.delete(path) }
  }

  reserveSocketIo(path: string): () => void {
    if (this.upgrades.has(path) || this.socketIoPaths.has(path)) throw new Error(`Realtime path already owned: ${path}`)
    this.socketIoPaths.add(path)
    return () => { this.socketIoPaths.delete(path) }
  }

  dispose(): void {
    if (this.server) this.server.off("upgrade", this.listener)
    this.server = null
    this.upgrades.clear()
    this.socketIoPaths.clear()
  }
}
