import { Router } from "express"
import type { HostedApplicationFactory } from "./contract"

export const createHostedApplication: HostedApplicationFactory = async (context) => {
  const router = Router()
  router.get("/module-status", (_request, response) => response.json({ projectId: context.projectId, state: "ready" }))
  return {
    contractVersion: 1,
    router,
    static: { directory: "frontend/dist", spaFallback: true },
    async status() { return { state: "ready", message: "SourceManager composition root loaded" } },
  }
}
