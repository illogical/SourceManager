import { access, lstat, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

function assertBelow(root: string, candidate: string, label: string): void {
  const fromRoot = relative(root, candidate)
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} escapes ${root}`)
  }
}

export function resolveContainedPath(root: string, relativePath: string, label = "path"): string {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error(`${label} must be a relative path without traversal`)
  }
  const candidate = resolve(root, relativePath)
  assertBelow(resolve(root), candidate, label)
  return candidate
}

export async function resolveExistingContainedPath(root: string, relativePath: string, kind: "file" | "directory", label = "path"): Promise<string> {
  const rootReal = await realpath(root)
  const candidate = resolveContainedPath(rootReal, relativePath, label)
  await access(candidate)
  const candidateReal = await realpath(candidate)
  assertBelow(rootReal, candidateReal, label)
  const stats = await lstat(candidateReal)
  if (kind === "file" && !stats.isFile()) throw new Error(`${label} is not a file`)
  if (kind === "directory" && !stats.isDirectory()) throw new Error(`${label} is not a directory`)
  return candidateReal
}
