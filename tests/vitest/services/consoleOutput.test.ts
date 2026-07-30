import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { pipePrefixed, prefixFor } from "../../../src/services/consoleOutput"

describe("console output prefixes", () => {
  it("uses Concurrently-style timestamps and labels", () => {
    expect(prefixFor("backend", false)).toMatch(/^\[\d{2}:\d{2}:\d{2}\] \[backend\]$/)
    expect(prefixFor("frontend", false)).toMatch(/\[frontend\]$/)
  })

  it("prefixes complete and partial lines without dropping output", async () => {
    const source = new PassThrough()
    const destination = new PassThrough()
    let text = ""
    destination.on("data", (chunk) => { text += chunk.toString() })
    pipePrefixed(source, "backend", destination)
    source.write("first\npart")
    source.end("ial")
    await new Promise((resolve) => destination.write("", resolve))
    expect(text).toMatch(/\[backend\] first\r?\n/)
    expect(text).toMatch(/\[backend\] partial\r?\n/)
  })
})
