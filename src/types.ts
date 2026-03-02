export interface ServerConfig {
  port: number
  token: string
  allowedIps: string[]
}

export interface ProjectConfig {
  id: string
  repoPath: string
  defaultBranch: string
  healthUrl: string
  healthMode: "ping" | "full"
  port: number
  packageManager: "auto" | "bun" | "npm" | "yarn" | "pnpm"
  scriptName: string
  installCommand?: string
  allowedIps: string[]
}

export interface AppConfig {
  server: ServerConfig
  projects: ProjectConfig[]
}

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
  projectId: string
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

export interface ProcessState {
  projectId: string
  pid: number
  port: number
  startedAt: string
  command: string
}

export interface PortEntry {
  port: number
  projectId: string
  pid: number
  status: "running" | "stopped"
}

export type HealthCheckResult =
  | { status: "pass"; durationMs: number; detail?: string }
  | { status: "fail"; durationMs: number; detail?: string }

export type InstallMode = "auto" | "always" | "never"
export type RestartMode = "auto" | "always" | "never"

export interface UpdateRequest {
  branch?: string
  installMode?: InstallMode
  restartMode?: RestartMode
  dryRun?: boolean
}
