import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { readFileSync } from "fs"
import type { AppConfig, RepoConfig, ServiceConfig } from "./types"

const _dir = import.meta.dir ?? dirname(fileURLToPath(import.meta.url))
export const CONFIG_PATH = join(_dir, "..", "data", "projects.json")
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

  // Detect old format and emit a clear migration error
  const raw_obj = parsed as Record<string, unknown>
  if (Array.isArray(raw_obj["projects"])) {
    console.error(`\n[SourceManager] CONFIG ERROR: projects.json uses the old schema (projects[]).`)
    console.error(`  The new schema uses repos[] with nested services[].`)
    console.error(`  See ${EXAMPLE_PATH} for the updated format.\n`)
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

// ── Validation helpers ────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9-]+$/
const SCRIPT_RE = /^[a-zA-Z0-9:_-]+$/
const CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

function isValidCidr(s: string): boolean {
  return CIDR_RE.test(s)
}

function abort(msg: string): never {
  throw new ConfigError(msg)
}

// ── Main validation ───────────────────────────────────────────────────────────

export function validateConfig(config: AppConfig): void {
  if (!config.server?.token) abort("server.token is required in projects.json")
  if (!config.server?.port || config.server.port < 1 || config.server.port > 65535) {
    abort("server.port must be a number between 1 and 65535")
  }
  config.server.frontendPort ??= 5173
  if (config.server.frontendPort < 1 || config.server.frontendPort > 65535) {
    abort("server.frontendPort must be a number between 1 and 65535")
  }
  config.server.allowedIps ??= []

  if (!Array.isArray(config.repos)) abort("repos must be an array in projects.json")
  if (config.repos.length === 0) abort("repos must not be empty — add at least one repo entry")

  const repoIds = new Set<string>()
  const serviceIds = new Set<string>()

  for (const repo of config.repos) {
    validateRepo(repo, repoIds, serviceIds)
  }

  cachedConfig = config
}

function validateRepo(repo: RepoConfig, repoIds: Set<string>, serviceIds: Set<string>): void {
  if (!repo.id) abort(`A repo entry is missing the required "id" field`)
  if (!SLUG_RE.test(repo.id)) abort(`Repo id "${repo.id}" must match /^[a-z0-9-]+$/ (lowercase letters, digits, hyphens)`)
  if (repoIds.has(repo.id)) abort(`Duplicate repo id: "${repo.id}"`)
  repoIds.add(repo.id)

  if (!repo.displayName) abort(`Repo "${repo.id}" is missing "displayName"`)
  if (!repo.repoPath) abort(`Repo "${repo.id}" is missing "repoPath"`)
  if (!repo.defaultBranch) abort(`Repo "${repo.id}" is missing "defaultBranch"`)

  if (!Array.isArray(repo.services)) abort(`Repo "${repo.id}" must have a services array`)
  if (repo.services.length === 0) abort(`Repo "${repo.id}" must have at least one service entry`)

  for (const svc of repo.services) {
    validateService(svc, repo.id, serviceIds)
  }
}

function validateService(svc: ServiceConfig, repoId: string, serviceIds: Set<string>): void {
  const ctx = `Service in repo "${repoId}"`

  if (!svc.id) abort(`${ctx} is missing the required "id" field`)
  if (!SLUG_RE.test(svc.id)) abort(`${ctx}: service id "${svc.id}" must match /^[a-z0-9-]+$/`)
  if (serviceIds.has(svc.id)) abort(`Duplicate service id: "${svc.id}" — service ids must be globally unique across all repos`)
  serviceIds.add(svc.id)

  if (!svc.displayName) abort(`Service "${svc.id}" is missing "displayName"`)

  if (!svc.port || svc.port < 1 || svc.port > 65535) abort(`Service "${svc.id}" port must be between 1 and 65535`)

  if (!svc.healthUrl) abort(`Service "${svc.id}" is missing "healthUrl"`)
  if (!isValidUrl(svc.healthUrl)) abort(`Service "${svc.id}" healthUrl must be a valid http/https URL`)

  svc.healthMode ??= "ping"
  if (svc.healthMode !== "ping" && svc.healthMode !== "full") {
    abort(`Service "${svc.id}" healthMode must be "ping" or "full"`)
  }

  const validPMs = ["auto", "bun", "npm", "yarn", "pnpm"]
  svc.packageManager ??= "auto"
  if (!validPMs.includes(svc.packageManager)) {
    abort(`Service "${svc.id}" packageManager must be one of: ${validPMs.join(", ")}`)
  }

  svc.scriptName ??= "dev"
  if (!SCRIPT_RE.test(svc.scriptName)) {
    abort(`Service "${svc.id}" scriptName "${svc.scriptName}" contains invalid characters — use only letters, digits, colons, hyphens, or underscores`)
  }

  if (!Array.isArray(svc.tags)) {
    svc.tags = []
  }
  for (const tag of svc.tags) {
    if (typeof tag !== "string" || tag.trim() === "") {
      abort(`Service "${svc.id}" tags must be non-empty strings`)
    }
  }

  svc.allowedIps ??= []
  for (const cidr of svc.allowedIps) {
    if (!isValidCidr(cidr)) abort(`Service "${svc.id}" allowedIps contains invalid CIDR: "${cidr}"`)
  }

  // Tailnet fields (optional — validated but not acted on until SO-6)
  if (svc.tailnetHostname !== undefined) {
    if (typeof svc.tailnetHostname !== "string" || svc.tailnetHostname.includes(".") || svc.tailnetHostname.includes("/")) {
      abort(`Service "${svc.id}" tailnetHostname must be a simple subdomain without dots or slashes`)
    }
  }
  if (svc.tailscaleServeMode !== undefined && svc.tailscaleServeMode !== "https") {
    abort(`Service "${svc.id}" tailscaleServeMode must be "https"`)
  }
  if (svc.tailscaleServeTarget !== undefined) {
    if (!isValidUrl(svc.tailscaleServeTarget)) {
      abort(`Service "${svc.id}" tailscaleServeTarget must be a valid http/https URL`)
    }
  }
  if (svc.tailscaleServeEnabled !== undefined && typeof svc.tailscaleServeEnabled !== "boolean") {
    abort(`Service "${svc.id}" tailscaleServeEnabled must be a boolean`)
  }
}

// ── Config accessors ──────────────────────────────────────────────────────────

export function getConfig(): AppConfig {
  return loadConfig()
}

export function invalidateCache(): void {
  cachedConfig = null
}

export function getRepo(id: string): RepoConfig | undefined {
  return loadConfig().repos.find((r) => r.id === id)
}

export function requireRepo(id: string): RepoConfig {
  const repo = getRepo(id)
  if (!repo) throw new RepoNotFoundError(id)
  return repo
}

export function getService(serviceId: string): { repo: RepoConfig; service: ServiceConfig } | undefined {
  for (const repo of loadConfig().repos) {
    const service = repo.services.find((s) => s.id === serviceId)
    if (service) return { repo, service }
  }
  return undefined
}

export function requireService(serviceId: string): { repo: RepoConfig; service: ServiceConfig } {
  const found = getService(serviceId)
  if (!found) throw new ServiceNotFoundError(serviceId)
  return found
}

export function getAllServices(): Array<{ repo: RepoConfig; service: ServiceConfig }> {
  const result: Array<{ repo: RepoConfig; service: ServiceConfig }> = []
  for (const repo of loadConfig().repos) {
    for (const service of repo.services) {
      result.push({ repo, service })
    }
  }
  return result
}

// ── Error types ───────────────────────────────────────────────────────────────

export class RepoNotFoundError extends Error {
  constructor(public readonly repoId: string) {
    super(`Repo not found: "${repoId}"`)
    this.name = "RepoNotFoundError"
  }
}

export class ServiceNotFoundError extends Error {
  constructor(public readonly serviceId: string) {
    super(`Service not found: "${serviceId}"`)
    this.name = "ServiceNotFoundError"
  }
}

// ── Deprecated aliases (kept for Bun test compatibility during migration) ──────

/** @deprecated Use requireService() instead */
export function requireProject(id: string) {
  return requireService(id)
}

/** @deprecated Use getService() instead */
export function getProject(id: string) {
  return getService(id)
}

/** @deprecated Use RepoNotFoundError or ServiceNotFoundError instead */
export class ProjectNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super(`Project not found: "${projectId}"`)
    this.name = "ProjectNotFoundError"
  }
}
