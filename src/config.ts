import { readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { isIP } from "node:net"
import type { AppConfig, ProjectConfig, ProjectsFileConfig, V1ConversionPreview } from "./types"
import { assertUniqueRoutePrefixes } from "./host/routes"

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export const CONFIG_PATH = process.env.SOURCEMANAGER_CONFIG_PATH
  ? resolve(process.env.SOURCEMANAGER_CONFIG_PATH)
  : join(sourceRoot, "data", "projects.json")

const mountPath = z.string().regex(/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/, "must be an absolute normalized URL path without a trailing slash")
const relativePath = z.string().min(1).refine((value) => !isAbsolute(value) && !value.split(/[\\/]/).includes(".."), "must be a relative path without traversal")
const scriptName = z.string().regex(/^[A-Za-z0-9:_-]+$/)
const ipOrCidr = z.string().refine((value) => {
  const [address, prefix] = value.split("/")
  const version = isIP(address)
  if (!version) return false
  if (prefix === undefined) return true
  if (!/^\d+$/.test(prefix)) return false
  return Number(prefix) >= 0 && Number(prefix) <= (version === 4 ? 32 : 128)
}, "must be an IP address or valid CIDR")
const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  displayName: z.string().min(1),
  repoPath: relativePath,
  defaultBranch: z.string().min(1),
  enabled: z.boolean().default(true),
  host: z.object({ module: relativePath, exportName: z.string().min(1).optional(), contractVersion: z.literal(1) }),
  web: z.object({ mountPath, distPath: relativePath, spaFallback: z.boolean() }).optional(),
  api: z.object({ mountPath }).optional(),
  realtime: z.object({ mountPath, protocol: z.enum(["websocket", "socket.io"]) }).optional(),
  build: z.object({ script: scriptName, verifyScript: scriptName }),
  tags: z.array(z.string().min(1)).default([]),
  compatibility: z.object({ lowercaseAlias: z.boolean().optional(), lmapiV1Alias: z.boolean().optional() }).optional(),
})

const fileSchema = z.object({
  schemaVersion: z.literal(2),
  server: z.object({ allowedIps: z.array(ipOrCidr).default([]) }).default({ allowedIps: [] }),
  tailnet: z.object({
    serviceName: z.string().regex(/^[a-z0-9-]+$/),
    enabled: z.boolean(),
    protocol: z.literal("https"),
    port: z.number().int().min(1).max(65535),
    target: z.string().url().refine((value) => value.startsWith("http://127.0.0.1:") || value.startsWith("http://localhost:"), "must target the local SourceManager listener"),
  }),
  projects: z.array(projectSchema).min(1),
})

let cachedConfig: AppConfig | null = null

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

export function loadEnvironmentConfig(env: Record<string, string | undefined> = process.env) {
  const portRaw = env.SOURCEMANAGER_PORT?.trim()
  if (!portRaw || !/^\d+$/.test(portRaw) || Number(portRaw) < 1 || Number(portRaw) > 65535) {
    throw new ConfigError("SOURCEMANAGER_PORT must be set to an integer between 1 and 65535")
  }
  const token = env.SOURCEMANAGER_TOKEN?.trim()
  if (!token) throw new ConfigError("SOURCEMANAGER_TOKEN is required in the environment")
  const workspacePath = env.SOURCEMANAGER_WORKSPACE_PATH?.trim()
  if (!workspacePath || !isAbsolute(workspacePath)) {
    throw new ConfigError("SOURCEMANAGER_WORKSPACE_PATH must be an absolute path")
  }
  return { port: Number(portRaw), token, workspacePath: resolve(workspacePath) }
}

export function parseProjectsConfig(value: unknown): ProjectsFileConfig {
  const result = fileSchema.safeParse(value)
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")
    throw new ConfigError(details)
  }
  const ids = new Set<string>()
  for (const project of result.data.projects) {
    if (ids.has(project.id)) throw new ConfigError(`Duplicate project id: ${project.id}`)
    ids.add(project.id)
  }
  assertUniqueRoutePrefixes(result.data.projects)
  return result.data
}

export function loadConfig(path = CONFIG_PATH): AppConfig {
  if (cachedConfig && path === CONFIG_PATH) return cachedConfig
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new ConfigError(`Unable to read ${path}: ${(error as Error).message}`)
  }
  const file = parseProjectsConfig(parsed)
  const environment = loadEnvironmentConfig()
  const tailnetTarget = new URL(file.tailnet.target)
  if (Number(tailnetTarget.port) !== environment.port) {
    throw new ConfigError(`tailnet.target must use SOURCEMANAGER_PORT ${environment.port}`)
  }
  const config: AppConfig = { ...file, ...environment, server: { ...file.server, port: environment.port, token: environment.token } }
  if (path === CONFIG_PATH) cachedConfig = config
  return config
}

export function invalidateCache(): void {
  cachedConfig = null
}

export function getConfig(): AppConfig {
  return loadConfig()
}

export function getProject(id: string): ProjectConfig | undefined {
  return getConfig().projects.find((project) => project.id === id)
}

const PROJECT_CATALOG: Record<string, Omit<ProjectConfig, "id" | "displayName" | "repoPath" | "defaultBranch" | "enabled" | "tags">> = {
  sourcemanager: { host: { module: "dist/host/index.js", contractVersion: 1 }, web: { mountPath: "/SourceManager", distPath: "frontend/dist", spaFallback: true }, api: { mountPath: "/api/SourceManager" }, build: { script: "build", verifyScript: "verify:host" } },
  devplanner: { host: { module: "dist/host/index.js", contractVersion: 1 }, web: { mountPath: "/DevPlanner", distPath: "frontend/dist", spaFallback: true }, api: { mountPath: "/api/DevPlanner" }, realtime: { mountPath: "/api/DevPlanner/ws", protocol: "websocket" }, build: { script: "build", verifyScript: "verify:host" } },
  lmapi: { host: { module: "dist/host/index.js", contractVersion: 1 }, web: { mountPath: "/LMApi", distPath: "src/public", spaFallback: false }, api: { mountPath: "/api/LMApi" }, realtime: { mountPath: "/api/LMApi/socket.io", protocol: "socket.io" }, build: { script: "build", verifyScript: "verify:host" } },
  memoryapi: { host: { module: "dist/host/index.js", contractVersion: 1 }, web: { mountPath: "/MemoryApi", distPath: "public", spaFallback: false }, api: { mountPath: "/api/MemoryApi" }, build: { script: "build", verifyScript: "verify:host" } },
  lmeval: { host: { module: "dist/host/index.js", contractVersion: 1 }, web: { mountPath: "/LMEval", distPath: "dist/web", spaFallback: true }, api: { mountPath: "/api/LMEval" }, realtime: { mountPath: "/api/LMEval/ws", protocol: "websocket" }, build: { script: "build", verifyScript: "verify:host" } },
}

export function previewV1Conversion(input: unknown): V1ConversionPreview {
  const raw = input as { server?: { allowedIps?: string[] }; repos?: Array<Record<string, unknown>> }
  if (!Array.isArray(raw.repos)) throw new ConfigError("Legacy config must contain repos[]")
  const warnings: string[] = []
  const removedFields = new Set<string>()
  const projects = raw.repos.map((repo) => {
    const id = String(repo.id ?? "")
    const catalog = PROJECT_CATALOG[id]
    if (!catalog) throw new ConfigError(`No v2 catalog entry exists for project ${id}`)
    const services = Array.isArray(repo.services) ? repo.services as Array<Record<string, unknown>> : []
    for (const service of services) {
      for (const field of ["packageManager", "scriptName", "installCommand", "port", "healthUrl", "healthMode", "allowedIps", "tailscaleServiceName", "tailscaleServiceTarget"]) {
        if (field in service) removedFields.add(`repos[].services[].${field}`)
      }
      if (service.installCommand) warnings.push(`${id}: custom installCommand requires owner review and was not converted`)
    }
    return { id, displayName: String(repo.displayName ?? id), repoPath: String(repo.repoPath ?? id), defaultBranch: String(repo.defaultBranch ?? "main"), enabled: true, tags: [], compatibility: { lowercaseAlias: true, lmapiV1Alias: id === "lmapi" }, ...catalog }
  })
  return {
    config: parseProjectsConfig({ schemaVersion: 2, server: { allowedIps: raw.server?.allowedIps ?? [] }, tailnet: { serviceName: "apps", enabled: true, protocol: "https", port: 443, target: `http://127.0.0.1:${process.env.SOURCEMANAGER_PORT ?? "17106"}` }, projects }),
    warnings,
    removedFields: [...removedFields].sort(),
  }
}
