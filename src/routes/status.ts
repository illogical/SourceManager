import Elysia from "elysia"
import { buildReposResponse } from "./repos"
import { statusCoordinator } from "../services/statusCoordinator"

export const statusRoute = new Elysia({ prefix: "/status" })
  .post(
    "/refresh",
    async () => {
      const refresh = await statusCoordinator.refreshAll("manual_global")
      return {
        ...refresh,
        ...(await buildReposResponse()),
      }
    },
    { detail: { summary: "Refresh all managed service status", tags: ["Lifecycle"] } },
  )
