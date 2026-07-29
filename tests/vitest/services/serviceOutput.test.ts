import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readServiceOutput } from "../../../src/services/serviceOutput"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("durable service output", () => {
  it("reads across rotated segments without duplication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sourcemanager-output-"))
    directories.push(directory)
    await writeFile(join(directory, "output-0001.log"), "first\n")
    await writeFile(join(directory, "output-0002.log"), "\u001b[32msecond\u001b[0m\n")

    const first = await readServiceOutput("run-1", directory, "", 8)
    const second = await readServiceOutput("run-1", directory, first.nextCursor, 64)

    const combined = first.text + second.text
    expect(combined).toBe("first\n\u001b[32msecond\u001b[0m\n")
    expect(combined).toContain("\u001b[32m")
  })

  it("reports truncation when a cursor references a rotated-away segment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sourcemanager-output-"))
    directories.push(directory)
    await writeFile(join(directory, "output-0003.log"), "retained")

    const result = await readServiceOutput("run-1", directory, "1:40")

    expect(result.truncated).toBe(true)
    expect(result.text).toBe("retained")
    expect(result.cursor).toBe("3:0")
  })
})
