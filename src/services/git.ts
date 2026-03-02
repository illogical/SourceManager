import type { StepResult } from "../types"

interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function spawnGit(args: string[], cwd: string): Promise<SpawnResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

export async function gitStatus(repoPath: string): Promise<{ clean: boolean; output: string }> {
  const result = await spawnGit(["status", "--porcelain"], repoPath)
  return { clean: result.stdout === "" && result.exitCode === 0, output: result.stdout }
}

export async function gitFetch(repoPath: string): Promise<StepResult> {
  const start = Date.now()
  const result = await spawnGit(["fetch", "origin"], repoPath)
  const durationMs = Date.now() - start

  if (result.exitCode !== 0) {
    return { step: "fetch", status: "failure", message: result.stderr || "git fetch failed", durationMs }
  }
  return { step: "fetch", status: "success", message: "Fetched from origin", durationMs }
}

export async function gitCheckout(repoPath: string, branch: string): Promise<StepResult> {
  const start = Date.now()
  // Validate branch name to prevent injection (no shell, but still good hygiene)
  if (!/^[\w./-]+$/.test(branch)) {
    return {
      step: "checkout",
      status: "failure",
      message: `Invalid branch name: "${branch}"`,
      durationMs: 0,
    }
  }

  const result = await spawnGit(["checkout", branch], repoPath)
  const durationMs = Date.now() - start

  if (result.exitCode !== 0) {
    return {
      step: "checkout",
      status: "failure",
      message: result.stderr || `Failed to checkout branch "${branch}"`,
      durationMs,
    }
  }
  return { step: "checkout", status: "success", message: `Checked out branch "${branch}"`, durationMs }
}

export async function gitPull(repoPath: string, branch: string): Promise<StepResult> {
  const start = Date.now()
  const result = await spawnGit(["pull", "--ff-only", "origin", branch], repoPath)
  const durationMs = Date.now() - start

  if (result.exitCode !== 0) {
    return {
      step: "pull",
      status: "failure",
      message: result.stderr || "Fast-forward pull failed",
      durationMs,
    }
  }

  const alreadyUpToDate =
    result.stdout.includes("Already up to date") || result.stdout.includes("Already up-to-date")
  return {
    step: "pull",
    status: "success",
    message: alreadyUpToDate ? "Already up to date" : result.stdout || "Pulled successfully",
    durationMs,
  }
}

export async function detectDependencyChanges(repoPath: string): Promise<boolean> {
  // Check files changed in the last pull (ORIG_HEAD..HEAD)
  const result = await spawnGit(
    ["diff", "--name-only", "ORIG_HEAD", "HEAD"],
    repoPath
  )

  if (result.exitCode !== 0) {
    // ORIG_HEAD may not exist (e.g. already up-to-date); assume no changes
    return false
  }

  const changedFiles = result.stdout.split("\n").filter(Boolean)
  const depPatterns = [/^package\.json$/, /^package-lock\.json$/, /^bun\.lockb$/, /^yarn\.lock$/, /^pnpm-lock\.yaml$/]
  return changedFiles.some((file) => depPatterns.some((pat) => pat.test(file.split("/").pop() ?? "")))
}

export async function gitCurrentBranch(repoPath: string): Promise<string> {
  const result = await spawnGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath)
  return result.exitCode === 0 ? result.stdout : "unknown"
}
