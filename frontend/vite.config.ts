import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const configPath = resolve(__dirname, "..", "data", "projects.json")

function readServerPorts(): { backendPort: number; frontendPort: number } {
  if (!existsSync(configPath)) return { backendPort: 17106, frontendPort: 5173 }

  const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
    server?: { port?: unknown; frontendPort?: unknown }
  }

  const backendPort = typeof raw.server?.port === "number" ? raw.server.port : 17106
  const frontendPort = typeof raw.server?.frontendPort === "number" ? raw.server.frontendPort : 5173
  return { backendPort, frontendPort }
}

const { backendPort, frontendPort } = readServerPorts()
const backendUrl = `http://localhost:${backendPort}`

export default defineConfig({
  root: "frontend",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: frontendPort,
    strictPort: true,
    proxy: {
      "/v1": backendUrl,
      "/health": backendUrl,
      "/swagger": backendUrl,
    },
  },
})
