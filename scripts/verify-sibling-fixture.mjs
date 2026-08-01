import { cp, mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const temporary = await mkdtemp(join(tmpdir(), "sourcemanager-host-fixture-"))
try {
  await cp(resolve("fixtures/sibling-adapter"), temporary, { recursive: true })
  await mkdir(join(temporary, "node_modules"), { recursive: true })
  await cp(join(temporary, "fixture-dependency"), join(temporary, "node_modules", "fixture-dependency"), { recursive: true })
  const imported = await import(pathToFileURL(join(temporary, "index.js")).href)
  const status = await (await imported.createHostedApplication()).status()
  if (status.message !== "resolved from sibling dependency") throw new Error("sibling dependency resolution failed")
  console.log("Verified sibling adapter dependency isolation")
} finally { await rm(temporary, { recursive: true, force: true }) }
