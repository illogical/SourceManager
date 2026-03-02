/**
 * git.test.ts — Tests for the git service.
 *
 * Strategy: Use a real temporary git repository for spawn-based tests.
 * This avoids native-binding spy issues and validates actual git behavior.
 * Branch-name validation tests require no spawn at all (pure regex).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// ── Temp git repo setup ───────────────────────────────────────────────────────

let repoDir: string

async function git(args: string[], cwd = repoDir): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out: out.trim(), err: err.trim(), code }
}

beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "sm-git-test-"))

  // Configure git identity for commits (required even in temp repos)
  await git(["init"], repoDir)
  await git(["config", "user.email", "test@test.com"])
  await git(["config", "user.name", "Test User"])
  await git(["config", "commit.gpgsign", "false"])

  // Initial commit
  writeFileSync(join(repoDir, "README.md"), "# test repo")
  await git(["add", "."])
  await git(["commit", "-m", "initial commit"])
})

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

// ── gitStatus ─────────────────────────────────────────────────────────────────

import { gitStatus, gitFetch, gitCheckout, gitPull, detectDependencyChanges } from "../../src/services/git"

describe("gitStatus", () => {
  it("returns clean=true on a fresh commit with no modifications", async () => {
    const result = await gitStatus(repoDir)
    expect(result.clean).toBe(true)
    expect(result.output).toBe("")
  })

  it("returns clean=false when there are untracked files", async () => {
    writeFileSync(join(repoDir, "untracked.txt"), "new file")
    const result = await gitStatus(repoDir)
    // Restore immediately
    rmSync(join(repoDir, "untracked.txt"))
    expect(result.clean).toBe(false)
  })

  it("returns clean=false when a tracked file is modified", async () => {
    writeFileSync(join(repoDir, "README.md"), "modified content")
    const result = await gitStatus(repoDir)
    // Restore
    writeFileSync(join(repoDir, "README.md"), "# test repo")
    await git(["checkout", "README.md"])
    expect(result.clean).toBe(false)
  })
})

// ── gitCheckout — branch name validation (no spawn needed) ───────────────────

describe("gitCheckout — branch name validation", () => {
  it("accepts 'main' branch name", async () => {
    const result = await gitCheckout(repoDir, "master") // use master (what init creates)
    // May succeed or fail depending on branch existence — key is it's not "Invalid"
    expect(result.message).not.toContain("Invalid branch name")
    expect(result.step).toBe("checkout")
  })

  it("rejects branch names with spaces (returns without calling git)", async () => {
    const result = await gitCheckout(repoDir, "branch name")
    expect(result.status).toBe("failure")
    expect(result.message).toContain("Invalid branch name")
    expect(result.durationMs).toBe(0)
  })

  it("rejects branch names with semicolons", async () => {
    const result = await gitCheckout(repoDir, "branch;rm -rf /")
    expect(result.status).toBe("failure")
    expect(result.message).toContain("Invalid branch name")
    expect(result.durationMs).toBe(0)
  })

  it("rejects branch names with ampersands", async () => {
    const result = await gitCheckout(repoDir, "branch&&cmd")
    expect(result.status).toBe("failure")
    expect(result.message).toContain("Invalid branch name")
    expect(result.durationMs).toBe(0)
  })

  it("rejects branch names with backticks", async () => {
    const result = await gitCheckout(repoDir, "`whoami`")
    expect(result.status).toBe("failure")
    expect(result.message).toContain("Invalid branch name")
    expect(result.durationMs).toBe(0)
  })

  it("rejects empty branch name", async () => {
    const result = await gitCheckout(repoDir, "")
    expect(result.status).toBe("failure")
    expect(result.message).toContain("Invalid branch name")
  })

  it("accepts feature/branch-name format", async () => {
    // Should pass validation (may fail git checkout itself — that's expected)
    const result = await gitCheckout(repoDir, "feature/does-not-exist")
    expect(result.message).not.toContain("Invalid branch name")
  })

  it("accepts release-1.0.0 format (dots, hyphens)", async () => {
    const result = await gitCheckout(repoDir, "release-1.0.0")
    expect(result.message).not.toContain("Invalid branch name")
  })
})

// ── detectDependencyChanges ───────────────────────────────────────────────────

describe("detectDependencyChanges", () => {
  it("returns false when ORIG_HEAD does not exist (no previous pull)", async () => {
    // Fresh repo has no ORIG_HEAD — diff returns non-zero
    const result = await detectDependencyChanges(repoDir)
    expect(result).toBe(false)
  })

  it("returns true when package.json changed between commits", async () => {
    // Create package.json and commit it as ORIG_HEAD
    writeFileSync(join(repoDir, "package.json"), '{"version":"1.0.0"}')
    await git(["add", "package.json"])
    await git(["commit", "-m", "add package.json"])
    // Save current HEAD as ORIG_HEAD manually
    const { out: head } = await git(["rev-parse", "HEAD"])
    // Modify package.json and commit (this becomes new HEAD)
    writeFileSync(join(repoDir, "package.json"), '{"version":"1.1.0"}')
    await git(["add", "package.json"])
    await git(["commit", "-m", "bump version"])
    // Create ORIG_HEAD pointing to previous commit
    await Bun.write(join(repoDir, ".git", "ORIG_HEAD"), head + "\n")

    const result = await detectDependencyChanges(repoDir)
    expect(result).toBe(true)
  })

  it("returns false when only non-dep files changed", async () => {
    writeFileSync(join(repoDir, "src.ts"), 'export const x = 1')
    await git(["add", "src.ts"])
    const { out: prevHead } = await git(["rev-parse", "HEAD"])
    await git(["commit", "-m", "add src.ts"])
    await Bun.write(join(repoDir, ".git", "ORIG_HEAD"), prevHead + "\n")

    const result = await detectDependencyChanges(repoDir)
    expect(result).toBe(false)
  })

  it("returns true when bun.lockb changed", async () => {
    writeFileSync(join(repoDir, "bun.lockb"), "lockfile content")
    await git(["add", "bun.lockb"])
    const { out: prevHead } = await git(["rev-parse", "HEAD"])
    await git(["commit", "-m", "add lockb"])
    writeFileSync(join(repoDir, "bun.lockb"), "updated lockfile")
    await git(["add", "bun.lockb"])
    await git(["commit", "-m", "update lockb"])
    await Bun.write(join(repoDir, ".git", "ORIG_HEAD"), prevHead + "\n")

    const result = await detectDependencyChanges(repoDir)
    expect(result).toBe(true)
  })
})

// ── gitPull — message detection (no remote needed) ───────────────────────────

describe("gitPull — result detection", () => {
  it("returns step=pull in result shape", async () => {
    // Pull on a repo with no remote will fail — that's fine, test the shape
    const result = await gitPull(repoDir, "master")
    expect(result.step).toBe("pull")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    // Will fail (no remote) — just verify the structure
    expect(["success", "failure"]).toContain(result.status)
  })
})
