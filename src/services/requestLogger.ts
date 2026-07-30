import { join } from "path"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { appendFile, mkdir } from "node:fs/promises"

const _dir = import.meta.dir ?? dirname(fileURLToPath(import.meta.url))
const LOG_DIR = join(_dir, "..", "..", "data", "logs")
let appendQueue: Promise<void> = Promise.resolve()

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

  const write = appendQueue.then(async () => {
    await mkdir(LOG_DIR, { recursive: true })
    await appendFile(path, line, "utf8")
  })
  appendQueue = write.catch(() => {})
  await write
}

export async function flushRequestLogs(): Promise<void> {
  await appendQueue
}
