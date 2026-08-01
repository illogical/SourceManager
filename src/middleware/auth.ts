import { timingSafeEqual } from "node:crypto"
import type { RequestHandler } from "express"
import { BlockList, isIP } from "node:net"
import type { AppConfig } from "../types"

function equalToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function authMiddleware(config: AppConfig): RequestHandler {
  return (request, response, next) => {
    if (!equalToken(request.header("x-devserver-token"), config.server.token)) {
      response.status(401).json({ error: "Unauthorized: missing or invalid X-DevServer-Token" })
      return
    }
    next()
  }
}

export function isIpAllowed(clientIp: string, allowedIps: string[]): boolean {
  if (allowedIps.length === 0) return true
  const normalized = clientIp.startsWith("::ffff:") ? clientIp.slice(7) : clientIp
  return allowedIps.some((value) => cidrContains(value, normalized))
}

function cidrContains(rule: string, address: string): boolean {
  const [network, prefixText] = rule.split("/")
  if (prefixText === undefined) return network === address
  const version = isIP(network)
  if (!version || isIP(address) !== version) return false
  const family = version === 4 ? "ipv4" : "ipv6"
  const block = new BlockList()
  block.addSubnet(network, Number(prefixText), family)
  return block.check(address, family)
}
