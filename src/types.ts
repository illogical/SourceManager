import type { HostedModuleStatus } from "./host/contract"

export type RealtimeProtocol = "websocket" | "socket.io"

export interface ServerConfig {
  port: number
  token: string
  allowedIps: string[]
}

export interface TailnetConfig {
  serviceName: string
  enabled: boolean
  protocol: "https"
  port: number
  target: string
}

export interface HostModuleConfig {
  module: string
  exportName?: string
  contractVersion: 1
}

export interface WebMountConfig {
  mountPath: string
  distPath: string
  spaFallback: boolean
}

export interface ApiMountConfig {
  mountPath: string
}

export interface RealtimeMountConfig {
  mountPath: string
  protocol: RealtimeProtocol
}

export interface BuildConfig {
  script: string
  verifyScript: string
}

export interface ProjectConfig {
  id: string
  displayName: string
  repoPath: string
  defaultBranch: string
  enabled: boolean
  host: HostModuleConfig
  web?: WebMountConfig
  api?: ApiMountConfig
  realtime?: RealtimeMountConfig
  build: BuildConfig
  tags: string[]
  compatibility?: {
    lowercaseAlias?: boolean
    lmapiV1Alias?: boolean
  }
}

export interface ProjectsFileConfig {
  schemaVersion: 2
  server: { allowedIps: string[] }
  tailnet: TailnetConfig
  projects: ProjectConfig[]
}

export interface AppConfig extends ProjectsFileConfig {
  workspacePath: string
  server: ServerConfig
}

export interface BuildManifest {
  contractVersion: 1
  projectId: string
  commit: string
  builtAt: string
  nodeMajor: number
}

export type HostState = "loading" | "ready" | "degraded" | "unavailable" | "disabled"
export type BuildState = "current" | "stale" | "missing" | "invalid"
export type WorkingTreeState = "clean" | "dirty" | "unknown"

export interface ProjectRuntimeStatus {
  id: string
  displayName: string
  repoPath: string
  defaultBranch: string
  enabled: boolean
  tags: string[]
  capabilities: Array<"web" | "api" | "realtime">
  links: { web?: string; api?: string; realtime?: string }
  hostState: HostState
  loadedCommit: string | null
  checkedOutCommit: string | null
  branch: string | null
  buildState: BuildState
  workingTree: WorkingTreeState
  lastLoadedAt: string | null
  lastError: string | null
  moduleStatus: HostedModuleStatus | null
}

export interface RuntimeConfigSummary {
  port: number
  workspacePath: string
  tokenConfigured: boolean
}

export interface ValidationFieldError {
  path: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationFieldError[]
  warnings: ValidationFieldError[]
}

export interface ConfigDiffEntry {
  path: string
  oldValue: unknown
  newValue: unknown
}

export interface ConfigDiff {
  changes: ConfigDiffEntry[]
  changeCount: number
}

export interface V1ConversionPreview {
  config: ProjectsFileConfig
  warnings: string[]
  removedFields: string[]
}

export class ValidationError extends Error {
  constructor(public readonly result: ValidationResult) {
    super("Config validation failed")
    this.name = "ValidationError"
  }
}
