export type HostState = "loading" | "ready" | "degraded" | "unavailable" | "disabled"
export type BuildState = "current" | "stale" | "missing" | "invalid"

export interface ProjectStatus {
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
  workingTree: "clean" | "dirty" | "unknown"
  lastLoadedAt: string | null
  lastError: string | null
  moduleStatus: { state: string; message?: string } | null
}

export interface ProjectsResponse { projects: ProjectStatus[] }

export interface GlobalTailscaleStatus {
  configured: boolean
  desiredEnabled: boolean
  serviceName: string
  target: string
  status: "connected" | "not_advertised" | "unavailable" | "error"
  tailnetDomain: string | null
  error: string | null
}

export interface ConfigResponse {
  config: unknown
  runtime: { port: number; workspacePath: string; tokenConfigured: boolean }
}
