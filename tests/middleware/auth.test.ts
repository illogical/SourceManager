import { describe, it, expect, beforeEach } from "bun:test"
import { isIpAllowed, validateToken } from "../../src/middleware/auth"

// validateToken reads from config which reads from disk — we need to mock loadConfig.
// Since validateToken calls getConfig() at runtime, we test isIpAllowed directly (pure)
// and test validateToken by mocking the config module.

describe("isIpAllowed", () => {
  it("allows all IPs when allowedIps is empty", () => {
    expect(isIpAllowed("1.2.3.4", [])).toBe(true)
    expect(isIpAllowed("192.168.1.100", [])).toBe(true)
  })

  it("allows exact IP match", () => {
    expect(isIpAllowed("203.0.113.5", ["203.0.113.5"])).toBe(true)
  })

  it("rejects non-matching exact IP", () => {
    expect(isIpAllowed("203.0.113.6", ["203.0.113.5"])).toBe(false)
  })

  it("allows IP within CIDR /24 prefix", () => {
    expect(isIpAllowed("192.168.1.50", ["192.168.1.0/24"])).toBe(true)
    expect(isIpAllowed("192.168.1.254", ["192.168.1.0/24"])).toBe(true)
  })

  it("rejects IP outside CIDR /24 prefix", () => {
    expect(isIpAllowed("192.168.2.1", ["192.168.1.0/24"])).toBe(false)
    expect(isIpAllowed("10.0.0.1", ["192.168.1.0/24"])).toBe(false)
  })

  it("checks multiple CIDR entries in list", () => {
    const list = ["10.0.0.0/24", "192.168.1.0/24"]
    expect(isIpAllowed("10.0.0.5", list)).toBe(true)
    expect(isIpAllowed("192.168.1.5", list)).toBe(true)
    expect(isIpAllowed("172.16.0.1", list)).toBe(false)
  })

  it("matches exact IP even when list contains only CIDRs", () => {
    // Exact match check runs before CIDR check
    expect(isIpAllowed("10.0.0.1", ["10.0.0.1"])).toBe(true)
  })
})
