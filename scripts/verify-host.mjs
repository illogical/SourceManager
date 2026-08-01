import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

const modulePath = resolve(process.argv[2] ?? "dist/host/index.js")
let listened = false
const net = await import("node:net")
const originalListen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) { listened = true; return originalListen.apply(this, args) }
try {
  const imported = await import(pathToFileURL(modulePath).href)
  if (typeof imported.createHostedApplication !== "function") throw new Error("createHostedApplication export is missing")
  const application = await imported.createHostedApplication({
    projectId: process.env.HOST_PROJECT_ID ?? "sourcemanager",
    repoRoot: process.cwd(), webBasePath: "/SourceManager", apiBasePath: "/api/SourceManager",
    hostOrigin: "http://127.0.0.1:17106", environment: "production",
    log: Object.fromEntries(["debug", "info", "warn", "error"].map((key) => [key, () => undefined])),
    realtime: { registerWebSocket: () => () => undefined, reserveSocketIo: () => () => undefined },
  })
  if (application.contractVersion !== 1 || typeof application.status !== "function") throw new Error("invalid hosted application contract")
  await application.initialize?.()
  await application.dispose?.()
  if (listened) throw new Error("adapter called listen() during verification")
  console.log(`Verified hosted adapter: ${modulePath}`)
} finally {
  net.Server.prototype.listen = originalListen
}
