import { getConfig } from "../config"

export function isIpAllowed(clientIp: string, allowedIps: string[]): boolean {
  if (allowedIps.length === 0) return true
  for (const cidr of allowedIps) {
    if (cidr === clientIp) return true
    if (cidr.includes("/")) {
      const [network] = cidr.split("/")
      // Prefix match — for production replace with a proper CIDR library
      const prefix = network.split(".").slice(0, 3).join(".")
      if (clientIp.startsWith(prefix + ".")) return true
    }
  }
  return false
}

export function validateToken(headers: Record<string, string | undefined>): boolean {
  const config = getConfig()
  const token = headers["x-devserver-token"]
  return !!token && token === config.server.token
}
