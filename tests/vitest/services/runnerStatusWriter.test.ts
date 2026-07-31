import { describe, expect, it, vi } from "vitest"
import { RunnerStatusWriter } from "../../../src/services/runnerStatusWriter"

describe("RunnerStatusWriter", () => {
  it("serializes overlapping publications", async () => {
    let active = 0
    let peak = 0
    const write = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
    })
    const replace = vi.fn(async () => { active -= 1 })
    const writer = new RunnerStatusWriter("status.json", {
      temporaryPath: "status.123.tmp",
      write: write as never,
      replace: replace as never,
    })

    await Promise.all([writer.publish("one"), writer.publish("two"), writer.publish("three")])

    expect(peak).toBe(1)
    expect(write).toHaveBeenCalledTimes(3)
    expect(replace).toHaveBeenCalledTimes(3)
  })

  it("retries transient Windows replacement failures", async () => {
    const transient = Object.assign(new Error("busy"), { code: "EPERM" })
    const replace = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValue(undefined)
    const writer = new RunnerStatusWriter("status.json", {
      temporaryPath: "status.123.tmp",
      replace: replace as never,
      write: vi.fn(async () => {}) as never,
      wait: vi.fn(async () => {}),
    })

    await expect(writer.publish("status")).resolves.toBeUndefined()
    expect(replace).toHaveBeenCalledTimes(2)
  })

  it("continues accepting writes after a permanent failure", async () => {
    const replace = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("disk failure"), { code: "EIO" }))
      .mockResolvedValue(undefined)
    const writer = new RunnerStatusWriter("status.json", {
      temporaryPath: "status.123.tmp",
      replace: replace as never,
      write: vi.fn(async () => {}) as never,
    })

    await expect(writer.publish("bad")).rejects.toThrow("disk failure")
    await expect(writer.publish("good")).resolves.toBeUndefined()
  })
})
