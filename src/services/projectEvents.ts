import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const DATA_DIR = resolve(process.env.SOURCEMANAGER_DATA_PATH ?? join(process.cwd(), "data"))
const EVENT_PATH = join(DATA_DIR, "project-events.ndjson")

export interface ProjectEvent {
  timestamp: string
  projectId: string
  kind: "host" | "load" | "build" | "config" | "tailnet"
  state: string
  message: string
}

export async function recordProjectEvent(event: Omit<ProjectEvent, "timestamp">): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await appendFile(EVENT_PATH, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8")
}

export async function readProjectEvents(limit = 100): Promise<ProjectEvent[]> {
  try {
    const lines = (await readFile(EVENT_PATH, "utf8")).trim().split("\n").filter(Boolean)
    return lines.slice(-Math.max(1, Math.min(limit, 500))).map((line) => JSON.parse(line) as ProjectEvent).reverse()
  } catch { return [] }
}
