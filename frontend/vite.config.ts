import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const configPath = resolve(__dirname, "..", "data", "projects.json")

function readFrontendPort(): number {
  if (!existsSync(configPath)) return 5173

  const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
    server?: { frontendPort?: unknown }
  }

  return typeof raw.server?.frontendPort === "number" ? raw.server.frontendPort : 5173
}

function readBackendPort(env: Record<string, string>): number {
  const raw = env.SOURCEMANAGER_PORT?.trim()
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error("SOURCEMANAGER_PORT must be set to an integer between 1 and 65535")
  }
  const port = Number(raw)
  if (port < 1 || port > 65535) {
    throw new Error("SOURCEMANAGER_PORT must be set to an integer between 1 and 65535")
  }
  return port
}

export default defineConfig(({ command, mode }) => {
  const frontendPort = readFrontendPort()
  const env = loadEnv(mode, resolve(__dirname, ".."), "")
  const backendUrl = command === "serve"
    ? `http://localhost:${readBackendPort(env)}`
    : "http://localhost"

  return {
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
  }
})
