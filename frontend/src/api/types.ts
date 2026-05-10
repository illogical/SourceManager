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
