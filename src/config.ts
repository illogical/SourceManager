import { join } from "path"
import { readFileSync } from "fs"
import type { AppConfig, ProjectConfig } from "./types"

const CONFIG_PATH = join(import.meta.dir, "..", "data", "projects.json")
const EXAMPLE_PATH = "data/projects.example.json"

let cachedConfig: AppConfig | null = null

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig

  let raw: string
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8")
  } catch {
    console.error(`\n[SourceManager] ERROR: Config file not found at ${CONFIG_PATH}`)
    console.error(`  Copy ${EXAMPLE_PATH} to data/projects.json and fill in your values.\n`)
    process.exit(1)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`[SourceManager] ERROR: Failed to parse ${CONFIG_PATH}: ${(e as Error).message}`)
    process.exit(1)
  }

  const config = parsed as AppConfig
  try {
    validateConfig(config)
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`[SourceManager] CONFIG ERROR: ${e.message}`)
      process.exit(1)
    }
    throw e
  }

  cachedConfig = config
  return config
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

export function validateConfig(config: AppConfig): void {
  if (!config.server?.token) {
    abort("server.token is required in projects.json")
  }
  if (!config.server?.port) {
    abort("server.port is required in projects.json")
  }
  if (!Array.isArray(config.projects)) {
    abort("projects must be an array in projects.json")
  }

  const ids = new Set<string>()
  for (const project of config.projects) {
    if (!project.id) abort(`A project is missing the required "id" field`)
    if (ids.has(project.id)) abort(`Duplicate project id: "${project.id}"`)
    ids.add(project.id)

    if (!project.repoPath) abort(`Project "${project.id}" is missing "repoPath"`)
    if (!project.defaultBranch) abort(`Project "${project.id}" is missing "defaultBranch"`)
    if (!project.healthUrl) abort(`Project "${project.id}" is missing "healthUrl"`)
    if (!project.port) abort(`Project "${project.id}" is missing "port"`)

    // Apply defaults
    project.healthMode ??= "ping"
    project.packageManager ??= "auto"
    project.scriptName ??= "dev"
    project.allowedIps ??= []
  }

  config.server.allowedIps ??= []
}

function abort(msg: string): never {
  throw new ConfigError(msg)
}

export function getConfig(): AppConfig {
  return loadConfig()
}

export function getProject(id: string): ProjectConfig | undefined {
  return loadConfig().projects.find((p) => p.id === id)
}

export function requireProject(id: string): ProjectConfig {
  const project = getProject(id)
  if (!project) throw new ProjectNotFoundError(id)
  return project
}

export class ProjectNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super(`Project not found: "${projectId}"`)
  }
}
