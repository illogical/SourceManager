import { join } from "path"
import type { RunReport } from "../types"

const LOG_DIR = join(import.meta.dir, "..", "..", "data", "logs")
const KEEP_DAYS = 7

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function runLogPath(date: string): string {
  return join(LOG_DIR, `runs-${date}.ndjson`)
}

async function ensureLogDir(): Promise<void> {
  await Bun.write(join(LOG_DIR, ".keep"), "")
}

export async function logRun(report: RunReport): Promise<void> {
  await ensureLogDir()
  const line = JSON.stringify(report) + "\n"
  const path = runLogPath(todayStr())

  // Append to file
  const existing = await Bun.file(path).exists() ? await Bun.file(path).text() : ""
  await Bun.write(path, existing + line)
}

export async function readRecentLogs(projectId: string, n = 20): Promise<RunReport[]> {
  const path = runLogPath(todayStr())
  const file = Bun.file(path)

  if (!(await file.exists())) return []

  const content = await file.text()
  const lines = content.split("\n").filter(Boolean)

  const entries: RunReport[] = []
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as RunReport
      if (entry.projectId === projectId) entries.push(entry)
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
