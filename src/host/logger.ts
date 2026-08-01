import type { HostLogger } from "./contract"

export function createHostLogger(projectId: string): HostLogger {
  const write = (level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => {
    const suffix = fields ? ` ${JSON.stringify(fields)}` : ""
    console[level](`[${projectId}] ${message}${suffix}`)
  }
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  }
}
