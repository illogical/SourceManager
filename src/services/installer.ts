import { join } from "path"
import type { ServiceConfig, StepResult } from "../types"

type PackageManager = "bun" | "npm" | "yarn" | "pnpm"

export async function detectPackageManager(repoPath: string): Promise<PackageManager> {
  const checks: [string, PackageManager][] = [
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ]

  for (const [lockfile, pm] of checks) {
    const file = Bun.file(join(repoPath, lockfile))
    if (await file.exists()) return pm
  }

  return "bun" // default
}

export async function runInstall(
  repoPath: string,
  service: Pick<ServiceConfig, "packageManager" | "scriptName" | "installCommand">
): Promise<StepResult> {
  const start = Date.now()

  let installCommand: string[]
  if (service.installCommand) {
    installCommand = service.installCommand.split(" ").filter(Boolean)
  } else {
    const pm = service.packageManager === "auto"
      ? await detectPackageManager(repoPath)
      : service.packageManager
    installCommand = [pm, "install"]
  }

  const [cmd, ...args] = installCommand
  const proc = Bun.spawn([cmd, ...args], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  const durationMs = Date.now() - start

  if (exitCode !== 0) {
    return {
      step: "install",
      status: "failure",
      message: stderr.trim() || stdout.trim() || "Install command failed",
      durationMs,
    }
  }

  return {
    step: "install",
    status: "success",
    message: `Installed successfully (${installCommand.join(" ")})`,
    durationMs,
  }
}

