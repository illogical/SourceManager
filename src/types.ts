// ── Server config ─────────────────────────────────────────────────────────────

export interface ServerConfig {
  port: number
  frontendPort?: number
  token: string
  allowedIps: string[]
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
  server: ServerConfig
  repos: RepoConfig[]
}

// ── Lifecycle state machine ───────────────────────────────────────────────────

export type LifecycleState = "starting" | "running" | "stopped" | "failed"

export interface ServiceProcessState {
  serviceId: string
  repoId: string
  pid: number
  port: number
  startedAt: string    // ISO 8601
  command: string
  lifecycleState: LifecycleState
  readySince?: string  // ISO 8601; set when health first passes after start
  lastError?: string   // set when lifecycleState is "failed"
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
