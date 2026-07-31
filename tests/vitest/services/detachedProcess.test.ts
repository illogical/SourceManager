import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:net"
import { spawnDetachedProcess } from "../../../src/services/detachedProcess"
import { terminateExactPid } from "../../../src/services/windowsProcessTree"

const spawnedPids: number[] = []

afterEach(async () => {
  await Promise.all(spawnedPids.splice(0).map((pid) => terminateExactPid(pid)))
})

describe.skipIf(process.platform !== "win32")("Windows detached process isolation", () => {
  it("does not inherit an open SourceManager listener", async () => {
    const first = await listen(createServer())
    const address = first.address()
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener")
    const port = address.port

    const child = await spawnDetachedProcess(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      {
        cwd: process.cwd(),
        env: process.env,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      },
    )
    spawnedPids.push(child.pid)

    await close(first)

    const replacement = await listen(createServer(), port)
    try {
      expect(replacement.address()).toMatchObject({ port })
      expect(() => process.kill(child.pid, 0)).not.toThrow()
    } finally {
      await close(replacement)
    }
  })
})

function listen(server: Server, port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve(server))
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
