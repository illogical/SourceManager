import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"

const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
const manifest = { contractVersion: 1, projectId: "sourcemanager", commit, builtAt: new Date().toISOString(), nodeMajor: Number(process.versions.node.split(".")[0]) }
await mkdir("dist/host", { recursive: true })
await writeFile("dist/host/build-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`)
