// ── Server config ─────────────────────────────────────────────────────────────

export interface ServerConfig {
  port: number
  frontendPort?: number
  token: string
  allowedIps: string[]
}

export interface ProjectsFileServerConfig {
  frontendPort?: number
  allowedIps?: string[]
  /** @deprecated Configure SOURCEMANAGER_PORT in .env instead. */
  port?: number
  /** @deprecated Configure SOURCEMANAGER_TOKEN in .env instead. */
  token?: string
}

// ── Service config (one runnable process) ─────────────────────────────────────

export interface ServiceConfig {
  id: string
  displayName: string
  packageManager: "auto" | "bun" | "npm" | "yarn" | "pnpm"
  scriptName: string
  port: number
  healthUrl: string
  healthMode: "ping" | "full"
  tags: string[]
  installCommand?: string | null
  allowedIps: string[]
  // Tailnet metadata — optional; validated in SO-2 but not acted on until SO-6
  tailnetHostname?: string
  tailnetDomain?: string
  tailscaleServeEnabled?: boolean
  tailscaleServeMode?: "https"
  tailscaleServeTarget?: string
  // SO-6C named Tailscale Service configuration
  tailnetExposureMode?: "tailscale-service"
  tailscaleServiceName?: string
  tailscaleServiceEnabled?: boolean
  tailscaleServiceProtocol?: "https"
  tailscaleServicePort?: number
  tailscaleServiceTarget?: string
}

// ── Repo config (groups one or more services sharing a repository) ─────────────

export interface RepoConfig {
  id: string
  displayName: string
  repoPath: string
  defaultBranch: string
  services: ServiceConfig[]
}

// ── App config ────────────────────────────────────────────────────────────────

export interface AppConfig {
  workspacePath: string
  server: ServerConfig
  repos: RepoConfig[]
}

export interface ProjectsFileConfig {
  server: ProjectsFileServerConfig
  repos: RepoConfig[]
}

export interface RuntimeConfigSummary {
  port: number
  workspacePath: string
  tokenConfigured: boolean
}

// ── Lifecycle state machine ───────────────────────────────────────────────────

export type LifecycleState = "starting" | "running" | "stopping" | "stopped" | "failed"

export interface ServiceProcessState {
  serviceId: string
  repoId: string
  /** Stable detached runner PID. Kept as `pid` for API compatibility. */
  pid: number
  childPid?: number | null
  port: number
  startedAt: string    // ISO 8601
  command: string
  lifecycleState: LifecycleState
  readySince?: string  // ISO 8601; set when health first passes after start
  lastError?: string   // set when lifecycleState is "failed"
  diagnosticCode?: "SERVICE_PROCESS_OWNERSHIP_CONFLICT" | "SERVICE_STARTUP_RECOVERY_FAILED" | "SERVICE_INTERRUPTED"
  intendedState?: "running" | "stopped"
  runId?: string
  processCreatedAt?: string
  commandFingerprint?: string
  repoPath?: string
  healthUrl?: string
  logDirectory?: string
  manifestPath?: string
  lastVerifiedAt?: string
  recoveryAttempt?: 1
  recoveryReason?: string
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

// ── Port map entry ────────────────────────────────────────────────────────────

export interface PortEntry {
  port: number
  serviceId: string
  pid: number
  status: "running" | "stopped"
}

// ── Health check ──────────────────────────────────────────────────────────────

export type HealthCheckResult =
  | { status: "pass"; durationMs: number; detail?: string }
  | { status: "fail"; durationMs: number; detail?: string }

// ── Minimal interface accepted by checkHealth ─────────────────────────────────

export interface HealthCheckable {
  healthUrl: string
  healthMode: "ping" | "full"
}

// ── Run/update types ──────────────────────────────────────────────────────────

export type StepStatus = "pending" | "success" | "failure" | "skipped"

export interface StepResult {
  step: string
  status: StepStatus
  message: string
  durationMs: number
}

export interface InstallRunResult {
  status: StepStatus
  reason: string
  durationMs?: number
}

export interface RestartRunResult {
  status: StepStatus
  reason: string
  durationMs?: number
}

export interface RunReport {
  runId: string
  serviceId: string
  repoId: string
  startedAt: string
  durationMs: number
  branch: string
  dryRun: boolean
  updated: boolean
  reason: string
  installRun: InstallRunResult
  restartRun: RestartRunResult
  healthStatus: "pass" | "fail" | "skipped"
  steps: StepResult[]
}

export interface LifecycleRunReport {
  kind: "lifecycle"
  action: "start" | "stop" | "restart"
  runId: string
  serviceId: string
  repoId: string
  startedAt: string
  durationMs: number
  status: "success" | "failure" | "skipped"
  reason: string
  steps: StepResult[]
  diagnostics?: Record<string, unknown>
}

export type InstallMode = "auto" | "always" | "never"
export type RestartMode = "auto" | "always" | "never"

export interface UpdateRequest {
  branch?: string
  installMode?: InstallMode
  restartMode?: RestartMode
  dryRun?: boolean
  background?: boolean
}

export interface UpdateAccepted {
  runId: string
  serviceId: string
  repoId: string
  startedAt: string
  branch: string
  status: "accepted"
  message: string
}

// ── Config edit types ─────────────────────────────────────────────────────────

export interface EditableServerConfig {
  frontendPort: number
  allowedIps: string[]
}

export interface EditableServiceConfig {
  id: string
  displayName: string
  packageManager: "auto" | "bun" | "npm" | "yarn" | "pnpm"
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

export class ValidationError extends Error {
  constructor(public readonly result: ValidationResult) {
    super("Config validation failed")
    this.name = "ValidationError"
  }
}
