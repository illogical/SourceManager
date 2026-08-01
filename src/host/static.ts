import { access } from "node:fs/promises"
import { join } from "node:path"
import type { Express, RequestHandler } from "express"
import express from "express"

export async function mountBoundedStatic(app: Express, mountPath: string, directory: string, spaFallback: boolean, unavailable: RequestHandler): Promise<boolean> {
  try { await access(directory) } catch {
    app.use(mountPath, unavailable)
    return false
  }
  app.use(mountPath, express.static(directory, { fallthrough: true, index: "index.html" }))
  if (spaFallback) {
    app.use(mountPath, (request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api/") || request.path.includes(".")) return next()
      response.sendFile(join(directory, "index.html"))
    })
  }
  return true
}
