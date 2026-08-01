import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { WorkingTreeState } from "../types"

const execFileAsync = promisify(execFile)

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export async function runGit(args: string[], cwd: string): Promise<CommandResult> {
  try {
    const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), exitCode: 0 }
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number }
    return { stdout: failed.stdout?.trim() ?? "", stderr: failed.stderr?.trim() ?? failed.message, exitCode: typeof failed.code === "number" ? failed.code : 1 }
  }
}

export async function gitCheckoutStatus(repoPath: string): Promise<{ commit: string | null; branch: string | null; workingTree: WorkingTreeState }> {
  const [commit, branch, status] = await Promise.all([
    runGit(["rev-parse", "HEAD"], repoPath),
    runGit(["branch", "--show-current"], repoPath),
    runGit(["status", "--porcelain"], repoPath),
  ])
  return {
    commit: commit.exitCode === 0 ? commit.stdout : null,
    branch: branch.exitCode === 0 ? branch.stdout || null : null,
    workingTree: status.exitCode === 0 ? (status.stdout ? "dirty" : "clean") : "unknown",
  }
}

export async function gitStatus(repoPath: string): Promise<{ clean: boolean; output: string }> {
  const result = await runGit(["status", "--porcelain"], repoPath)
  return { clean: result.exitCode === 0 && !result.stdout, output: result.stdout }
}

export async function gitCurrentBranch(repoPath: string): Promise<string> {
  return (await gitCheckoutStatus(repoPath)).branch ?? "unknown"
}
