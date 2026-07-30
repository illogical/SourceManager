import { readdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { spawn as nodeSpawn } from "node:child_process"
import { installConsolePrefix, pipePrefixed, prefixFor } from "./services/consoleOutput"
import {
  clearSourceManagerOwnership,
  recoverVerifiedStaleSourceManager,
  writeSourceManagerOwnership,
} from "./services/sourceManagerOwnership"

const repoRoot = resolve(import.meta.dir, "..")
const apiPort = Number.parseInt(process.env.SOURCEMANAGER_PORT ?? "", 10)
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
  throw new Error("SOURCEMANAGER_PORT must be configured before production startup")
}

process.env.SOURCEMANAGER_LAUNCH_MODE = "production"
process.env.SOURCEMANAGER_OWNER_ROOT_PID = String(process.pid)

if (await frontendBuildIsStale()) {
  process.stdout.write(`${prefixFor("build")} frontend/dist is missing or stale; rebuilding\n`)
  const proc = nodeSpawn(process.execPath, ["run", "frontend:build"], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  })
  const flushOut = pipePrefixed(proc.stdout, "build", process.stdout)
  const flushErr = pipePrefixed(proc.stderr, "build", process.stderr)
  const code = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject)
    proc.once("exit", (value: number | null) => resolve(value ?? 1))
  })
  flushOut()
  flushErr()
  if (code !== 0) throw new Error(`Frontend build failed with exit code ${code}`)
}

await recoverVerifiedStaleSourceManager([apiPort])
await writeSourceManagerOwnership("production", process.pid, process.pid, null, apiPort, null)
installConsolePrefix("server")

try {
  await import("./index")
} catch (error) {
  await clearSourceManagerOwnership(process.pid)
  throw error
}

async function frontendBuildIsStale(): Promise<boolean> {
  const output = join(repoRoot, "frontend", "dist", "index.html")
  let outputTime: number
  try {
    outputTime = (await stat(output)).mtimeMs
  } catch {
    return true
  }

  const inputs = [
    join(repoRoot, "frontend", "src"),
    join(repoRoot, "frontend", "index.html"),
    join(repoRoot, "frontend", "vite.config.ts"),
    join(repoRoot, "package.json"),
    join(repoRoot, "bun.lock"),
  ]
  for (const input of inputs) {
    if (await newestMtime(input) > outputTime) return true
  }
  return false
}

async function newestMtime(path: string): Promise<number> {
  let info
  try {
    info = await stat(path)
  } catch {
    return 0
  }
  if (!info.isDirectory()) return info.mtimeMs
  let newest = info.mtimeMs
  for (const entry of await readdir(path)) {
    newest = Math.max(newest, await newestMtime(join(path, entry)))
  }
  return newest
}
