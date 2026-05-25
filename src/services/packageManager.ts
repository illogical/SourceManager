export type RunnablePackageManager = "bun" | "npm" | "yarn" | "pnpm"

export function packageManagerExecutable(
  pm: RunnablePackageManager,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32" && pm !== "bun") return `${pm}.cmd`
  return pm
}

export function packageManagerRunCommand(pm: RunnablePackageManager, scriptName: string): string[] {
  return [packageManagerExecutable(pm), "run", scriptName]
}

export function packageManagerInstallCommand(pm: RunnablePackageManager): string[] {
  return [packageManagerExecutable(pm), "install"]
}
