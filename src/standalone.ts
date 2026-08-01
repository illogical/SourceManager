import "dotenv/config"
import { loadConfig } from "./config"
import { createSourceManagerHost } from "./app"
import { getGlobalTailscaleStatus, setGlobalTailscaleEnabled } from "./services/tailscaleGlobal"
import { recordProjectEvent } from "./services/projectEvents"

const config = loadConfig()
const host = createSourceManagerHost(config)
const address = await host.listen()
console.log(`[SourceManager] unified Node/Express host listening at http://${address.address}:${address.port}`)

if (config.tailnet.enabled) {
  void getGlobalTailscaleStatus(config.tailnet).then(async (status) => {
    if (status.status !== "connected") {
      await setGlobalTailscaleEnabled(config.tailnet, true)
      await recordProjectEvent({ projectId: "sourcemanager", kind: "tailnet", state: "enabled", message: `${config.tailnet.serviceName} advertisement reconciled after host readiness` })
    }
  }).catch((error) => console.warn(`[SourceManager] Tailnet reconciliation failed: ${(error as Error).message}`))
}

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[SourceManager] ${signal}; shutting down`)
  const timeout = setTimeout(() => process.exit(1), 10_000)
  timeout.unref()
  await host.close()
  clearTimeout(timeout)
}

process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))
