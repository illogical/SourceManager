import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
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
  const env = loadEnv(mode, resolve(__dirname, ".."), "")
  const backendUrl = command === "serve"
    ? `http://localhost:${readBackendPort(env)}`
    : "http://localhost"

  return {
    root: "frontend",
    base: env.VITE_PUBLIC_BASE || "/SourceManager/",
    plugins: [react()],
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
    server: {
      port: Number(env.SOURCEMANAGER_FRONTEND_PORT || 5173),
      strictPort: true,
      proxy: {
        "/api/SourceManager": backendUrl,
        "/health": backendUrl,
      },
      allowedHosts: [
        'localhost',
        '127.0.0.1',
        'devplanner',
        'devplanner.bangus-city.ts.net',
      ],
    },
  }
})
