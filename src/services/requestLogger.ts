import { join } from "path"

const LOG_DIR = join(import.meta.dir, "..", "..", "data", "logs")

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function requestLogPath(): string {
  return join(LOG_DIR, `requests-${todayStr()}.ndjson`)
}

interface RequestLogEntry {
  timestamp: string
  method: string
  url: string
  body: unknown
  status: number
  durationMs: number
  ip: string
}

function redactSensitive(body: unknown): unknown {
  if (!body || typeof body !== "object") return body
  const copy = { ...(body as Record<string, unknown>) }
  for (const key of Object.keys(copy)) {
    const lower = key.toLowerCase()
    if (lower.includes("token") || lower.includes("password") || lower.includes("secret")) {
      copy[key] = "[REDACTED]"
    }
  }
  return copy
}

export async function logRequest(entry: RequestLogEntry): Promise<void> {
  const safeEntry = { ...entry, body: redactSensitive(entry.body) }
  const line = JSON.stringify(safeEntry) + "\n"
  const path = requestLogPath()

  const existing = await Bun.file(path).exists() ? await Bun.file(path).text() : ""
  await Bun.write(path, existing + line)
}
