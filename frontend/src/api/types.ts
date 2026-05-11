// ── Lifecycle ──────────────────────────────────────────────────────────────────

export type LifecycleState = "starting" | "running" | "stopped" | "failed"

export interface Lifecycle {
  state: LifecycleState
  pid: number | null
  startedAt: string | null
  readySince: string | null
  uptimeMs: number | null
  command: string | null
  lastError: string | null
}

// ── Tailnet ────────────────────────────────────────────────────────────────────

export interface TailnetInfo {
  hostname: string
  domain: string | null
  serveEnabled: boolean
  serveMode: "https" | null
  serveTarget: string | null
}

// ── Service ────────────────────────────────────────────────────────────────────

export interface ServiceSummary {
  id: string
  displayName: string
  port: number
  healthUrl: string
  healthMode: "ping" | "full"
  packageManager: string
  scriptName: string
  tags: string[]
  allowedIps: string[]
  lifecycle: Lifecycle
  tailnet: TailnetInfo | null
}

// ── Repo ───────────────────────────────────────────────────────────────────────

export interface RepoSummary {
  id: string
  displayName: string
  repoPath: string
  defaultBranch: string
  services: ServiceSummary[]
}

export interface ReposResponse {
  repos: RepoSummary[]
}

// ── Update ─────────────────────────────────────────────────────────────────────

export interface UpdateRequest {
  branch?: string
  installMode?: "auto" | "always" | "never"
  restartMode?: "auto" | "always" | "never"
  dryRun?: boolean
}

// ── Config edit ────────────────────────────────────────────────────────────────

export interface EditableServerConfig {
  port: number
  frontendPort: number
  allowedIps: string[]
}

export interface EditableServiceConfig {
  id: string
  displayName: string
  packageManager: string
  scriptName: string
  installCommand: string | null
  port: number
  healthUrl: string
  healthMode: "ping" | "full"
  tags: string[]
  allowedIps: string[]
  tailnetHostname?: string
  tailnetDomain?: string
  tailscaleServeEnabled?: boolean
  tailscaleServeMode?: "https"
  tailscaleServeTarget?: string
}

export interface EditableRepoConfig {
  id: string
  displayName: string
  repoPath: string
  defaultBranch: string
  services: EditableServiceConfig[]
}

export interface EditableConfig {
  server: EditableServerConfig
  repos: EditableRepoConfig[]
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

export interface ConfigValidateResponse {
  validation: ValidationResult
  diff: ConfigDiff
}

export interface ConfigApplyResponse {
  success: boolean
  changeCount: number
}
