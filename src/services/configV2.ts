import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { CONFIG_PATH, invalidateCache, parseProjectsConfig } from "../config"
import type { ConfigDiff, ConfigDiffEntry, ProjectsFileConfig, ValidationResult } from "../types"

export async function readProjectsFile(path = CONFIG_PATH): Promise<ProjectsFileConfig> {
  return parseProjectsConfig(JSON.parse(await readFile(path, "utf8")))
}

export function validateProjectsFile(value: unknown): ValidationResult {
  try {
    parseProjectsConfig(value)
    return { valid: true, errors: [], warnings: [] }
  } catch (error) {
    return { valid: false, errors: [{ path: "config", message: (error as Error).message }], warnings: [] }
  }
}

export function diffConfig(current: unknown, proposed: unknown): ConfigDiff {
  const changes: ConfigDiffEntry[] = []
  walk(current, proposed, "", changes)
  return { changes, changeCount: changes.length }
}

function walk(left: unknown, right: unknown, path: string, changes: ConfigDiffEntry[]): void {
  if (Object.is(left, right)) return
  if (Array.isArray(left) && Array.isArray(right)) {
    const max = Math.max(left.length, right.length)
    for (let index = 0; index < max; index++) walk(left[index], right[index], `${path}[${index}]`, changes)
    return
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) walk((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], path ? `${path}.${key}` : key, changes)
    return
  }
  changes.push({ path, oldValue: left, newValue: right })
}

export async function writeProjectsFile(value: unknown, path = CONFIG_PATH): Promise<ProjectsFileConfig> {
  const config = parseProjectsConfig(value)
  await mkdir(dirname(path), { recursive: true })
  const backupDir = join(dirname(path), "backups")
  await mkdir(backupDir, { recursive: true })
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    await copyFile(path, join(backupDir, `projects-${timestamp}.json`))
  } catch { /* first configuration has nothing to back up */ }
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  await rename(temporary, path)
  invalidateCache()
  return config
}
