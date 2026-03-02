import Elysia, { t } from "elysia"
import { requireProject } from "../config"
import { processManager } from "../services/processManager"
import { readRecentLogs } from "../services/runLogger"

export const projectRoute = new Elysia({ prefix: "/projects/:id" })
  .get(
    "/",
    ({ params }) => {
      const project = requireProject(params.id)
      const processState = processManager.getProcess(project.id)
      return {
        id: project.id,
        repoPath: project.repoPath,
        defaultBranch: project.defaultBranch,
        port: project.port,
        healthUrl: project.healthUrl,
        healthMode: project.healthMode,
        packageManager: project.packageManager,
        scriptName: project.scriptName,
        running: processManager.isRunning(project.id),
        process: processState ?? null,
      }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { summary: "Get project detail", tags: ["Projects"] },
    }
  )
  .get(
    "/status",
    async ({ params }) => {
      const project = requireProject(params.id)
      const logs = await readRecentLogs(project.id, 3)
      return { projectId: project.id, runs: logs.reverse() }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { summary: "Get last 3 run reports", tags: ["Projects"] },
    }
  )
  .get(
    "/process",
    ({ params }) => {
      const project = requireProject(params.id)
      const state = processManager.getProcess(project.id)
      if (!state) {
        return { projectId: project.id, running: false, process: null }
      }
      const uptimeMs = Date.now() - new Date(state.startedAt).getTime()
      return {
        projectId: project.id,
        running: processManager.isRunning(project.id),
        process: { ...state, uptimeMs },
      }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { summary: "Get live process state", tags: ["Projects"] },
    }
  )
