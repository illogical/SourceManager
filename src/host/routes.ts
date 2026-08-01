import type { ProjectConfig } from "../types"

export const RESERVED_PREFIXES = ["/health", "/api/SourceManager"] as const

export function normalizeMountPath(path: string): string {
  let decoded: string
  try { decoded = decodeURIComponent(path) } catch { throw new Error(`Invalid encoded route prefix: ${path}`) }
  if (decoded !== path || !path.startsWith("/") || path === "/" || path.endsWith("/") || path.includes("//") || path.split("/").includes("..") || /[?#\\]/.test(path)) {
    throw new Error(`Invalid route prefix: ${path}`)
  }
  return path
}

function owns(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

export function assertUniqueRoutePrefixes(projects: ProjectConfig[]): void {
  const owners: Array<{ path: string; owner: string; kind: string }> = []
  for (const project of projects) {
    for (const [kind, path] of [["web", project.web?.mountPath], ["api", project.api?.mountPath], ["realtime", project.realtime?.mountPath]] as const) {
      if (!path) continue
      const normalized = normalizeMountPath(path)
      if (kind !== "api" && RESERVED_PREFIXES.some((reserved) => owns(normalized, reserved) || owns(reserved, normalized))) {
        throw new Error(`${project.id} ${kind} route ${path} collides with a reserved prefix`)
      }
      const collision = owners.find((existing) => existing.path === normalized || (existing.kind === kind && (owns(existing.path, normalized) || owns(normalized, existing.path))))
      if (collision) throw new Error(`${project.id} ${kind} route ${path} collides with ${collision.owner} ${collision.kind} route ${collision.path}`)
      owners.push({ path: normalized, owner: project.id, kind })
    }
  }
}

export function projectsByApiMountOrder(projects: ProjectConfig[]): ProjectConfig[] {
  return [...projects].filter((project) => project.api).sort((a, b) => b.api!.mountPath.length - a.api!.mountPath.length)
}
