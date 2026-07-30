// ── Lifecycle ──────────────────────────────────────────────────────────────────

export type LifecycleState = "starting" | "recovering" | "running" | "stopping" | "stopped" | "failed"

export interface Lifecycle {
  state: LifecycleState
  pid: number | null
  startedAt: string | null
  readySince: string | null
  uptimeMs: number | null
  command: string | null
  lastError: string | null
  diagnosticCode?: string | null
  intendedState?: "running" | "stopped"
  recoveryAttempt?: number | null
  recoveryReason?: string | null
}

export interface StartupReconciliationStatus {
  state: "pending" | "running" | "complete"
  startedAt: string | null
  deadlineAt: string | null
  timeoutMs: number
  total: number
  completed: number
  remainingMs: number
  message: string
}

export interface HealthResponse {
  status: string
  version: string
  uptimeMs: number
  applicationState: "running" | "shutting_down"
  startupReconciliation: StartupReconciliationStatus
}

// ── Tailnet ────────────────────────────────────────────────────────────────────

export interface TailnetInfo {
  hostname: string
  domain: string | null
  serveEnabled: boolean
  serveMode: "https" | null
  serveTarget: string | null
  exposureMode?: "tailscale-service" | null
  serviceName?: string | null
  serviceEnabled?: boolean
  servicePort?: number | null
  serviceTarget?: string | null
}

export type TailscaleServiceStatus =
  | "not_configured"
  | "unavailable"
  | "local_stopped"
  | "local_recovering"
  | "enabled_unverified"
  | "not_advertised"
  | "pending_approval"
  | "draining"
  | "connected"
  | "mismatch"
  | "error"

export interface TailscaleMachineStatus {
  state: "connected" | "degraded" | "unavailable"
  backendState: string | null
  tailnetDomain: string | null
  tags: string[]
  error: string | null
}

export interface TailscaleServiceCheck {
  serviceId: string
  configured: boolean
  desiredEnabled: boolean
  serviceName: string | null
  expectedUrl: string | null
  localTarget: string | null
  httpsPort: number | null
  status: TailscaleServiceStatus
  lastError: string | null
  lastWarning: string | null
  operation: "enabling" | "draining" | "disabling" | null
  canToggle: boolean
}

export interface TailscaleStatusResponse {
  machine: TailscaleMachineStatus
  services: TailscaleServiceCheck[]
}

// ── Service ────────────────────────────────────────────────────────────────────

export interface ServiceSummary {
  id: string
  displayName: string
  port: number
  healthUrl: string
  healthMode: "ping" | "full"
  recoveryTimeoutSeconds?: number
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
  frontendPort: number
  allowedIps: string[]
}

export interface RuntimeConfigSummary {
  port: number
  workspacePath: string
  tokenConfigured: boolean
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
  recoveryTimeoutSeconds?: number
  tags: string[]
  allowedIps: string[]
  tailnetHostname?: string
  tailnetDomain?: string
  tailscaleServeEnabled?: boolean
  tailscaleServeMode?: "https"
  tailscaleServeTarget?: string
  tailnetExposureMode?: "tailscale-service"
  tailscaleServiceName?: string
  tailscaleServiceEnabled?: boolean
  tailscaleServiceProtocol?: "https"
  tailscaleServicePort?: number
  tailscaleServiceTarget?: string
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

export interface ConfigResponse {
  config: EditableConfig
  runtime: RuntimeConfigSummary
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
