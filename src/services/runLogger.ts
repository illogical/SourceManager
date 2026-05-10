import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { readFile, writeFile, appendFile, mkdir, access } from "node:fs/promises"
import type { RunReport } from "../types"

const _dir = import.meta.dir ?? dirname(fileURLToPath(import.meta.url))
const LOG_DIR = join(_dir, "..", "..", "data", "logs")
const KEEP_DAYS = 7

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function runLogPath(date: string): string {
  return join(LOG_DIR, `runs-${date}.ndjson`)
}

async function ensureLogDir(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true })
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function logRun(report: RunReport): Promise<void> {
  await ensureLogDir()
  const line = JSON.stringify(report) + "\n"
  const path = runLogPath(todayStr())
  await appendFile(path, line, "utf-8")
}

export async function readRecentLogs(serviceId: string, n = 20): Promise<RunReport[]> {
  const path = runLogPath(todayStr())

  if (!(await fileExists(path))) return []

  let content: string
  try {
    content = await readFile(path, "utf-8")
  } catch {
    return []
  }

  const lines = content.split("\n").filter(Boolean)

  const entries: RunReport[] = []
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as RunReport
      if (entry.serviceId === serviceId) entries.push(entry)
    } catch {
      // Skip malformed lines
    }
  }

  return entries.slice(-n)
}

export async function rotateOldLogs(): Promise<void> {
  await ensureLogDir()
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS)

  const { readdir, unlink } = await import("fs/promises")
  let files: string[]
  try {
    files = await readdir(LOG_DIR)
  } catch {
    return
  }

  for (const file of files) {
    const match = file.match(/^(?:runs|requests)-(\d{4}-\d{2}-\d{2})\.ndjson$/)
    if (!match) continue
    const fileDate = new Date(match[1])
    if (fileDate < cutoff) {
      await unlink(join(LOG_DIR, file)).catch(() => {})
    }
  }
}

