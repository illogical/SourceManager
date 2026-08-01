import type { ProjectConfig, ProjectRuntimeStatus } from "../types"

export function initialStatus(project: ProjectConfig): ProjectRuntimeStatus {
  return {
    id: project.id,
    displayName: project.displayName,
    repoPath: project.repoPath,
    defaultBranch: project.defaultBranch,
    enabled: project.enabled,
    tags: project.tags,
    capabilities: [project.web && "web", project.api && "api", project.realtime && "realtime"].filter(Boolean) as ProjectRuntimeStatus["capabilities"],
    links: { web: project.web?.mountPath, api: project.api?.mountPath, realtime: project.realtime?.mountPath },
    hostState: project.enabled ? "loading" : "disabled",
    loadedCommit: null,
    checkedOutCommit: null,
    branch: null,
    buildState: "missing",
    workingTree: "unknown",
    lastLoadedAt: null,
    lastError: null,
    moduleStatus: null,
  }
}

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/g, " ").replace(/(token|password|secret)=\S+/gi, "$1=[REDACTED]").slice(0, 500)
}
