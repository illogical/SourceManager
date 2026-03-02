import Elysia, { t } from "elysia"
import { requireProject } from "../config"
import { processManager } from "../services/processManager"

export const lifecycleRoute = new Elysia({ prefix: "/projects/:id" })
  .post(
    "/start",
    async ({ params }) => {
      const project = requireProject(params.id)
      const result = await processManager.start(project)
      return {
        projectId: project.id,
        success: result.success,
        message: result.message,
        portKillResult: result.portKillResult ?? null,
        process: processManager.getProcess(project.id),
      }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { summary: "Start project server", tags: ["Lifecycle"] },
    }
  )
  .post(
    "/stop",
    async ({ params }) => {
      const project = requireProject(params.id)
      const result = await processManager.stop(project.id)
      return { projectId: project.id, ...result }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { summary: "Stop project server", tags: ["Lifecycle"] },
    }
  )
  .post(
    "/restart",
    async ({ params }) => {
      const project = requireProject(params.id)
      const result = await processManager.restart(project)
      return {
        projectId: project.id,
        success: result.success,
        message: result.message,
        portKillResult: result.portKillResult ?? null,
        process: processManager.getProcess(project.id),
      }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { summary: "Restart project server", tags: ["Lifecycle"] },
    }
  )
