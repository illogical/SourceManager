import { appendFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"

const LOG_DIR = join(resolve(process.env.SOURCEMANAGER_DATA_PATH ?? join(process.cwd(), "data")), "logs")

interface RequestLogEntry {
  timestamp: string
  method: string
  url: string
  body: unknown
  status: number
  durationMs: number
  ip: string
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, /token|password|secret/i.test(key) ? "[REDACTED]" : redact(item)]))
}

export async function logRequest(entry: RequestLogEntry): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true })
  await appendFile(join(LOG_DIR, `requests-${entry.timestamp.slice(0, 10)}.ndjson`), `${JSON.stringify({ ...entry, body: redact(entry.body) })}\n`, "utf8")
}
