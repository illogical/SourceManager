import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import WebSocket from "ws"

interface Baseline { applications: Array<{ id: string; web: string; apiHealth: string; realtime: string | null }> }
const baseline = JSON.parse(await readFile(resolve("docs/features/unified-node-express-portal/standalone-contract-baseline.json"), "utf8")) as Baseline
const live = process.env.RUN_STANDALONE_CONTRACTS === "1" ? describe : describe.skip

describe("captured standalone contract", () => {
  it("covers all five applications", () => expect(baseline.applications.map((app) => app.id)).toEqual(["sourcemanager", "devplanner", "lmapi", "memoryapi", "lmeval"]))
})

live("current standalone applications", () => {
  for (const application of baseline.applications) {
    it(`${application.id} serves web and API contracts`, async () => {
      expect((await fetch(application.web)).status).toBeLessThan(500)
      expect((await fetch(application.apiHealth)).status).toBeLessThan(500)
    })
    if (application.realtime?.startsWith("http")) it(`${application.id} serves Socket.IO polling`, async () => expect((await fetch(application.realtime!)).status).toBeLessThan(500))
    if (application.realtime?.startsWith("ws")) it(`${application.id} accepts WebSocket upgrade`, async () => {
      await new Promise<void>((resolvePromise, reject) => { const ws = new WebSocket(application.realtime!); ws.once("open", () => { ws.close(); resolvePromise() }); ws.once("error", reject) })
    })
  }
})
