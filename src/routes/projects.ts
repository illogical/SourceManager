import Elysia, { t } from "elysia"
import { getConfig } from "../config"
import { processManager } from "../services/processManager"
import { readRecentLogs } from "../services/runLogger"

export const projectsRoute = new Elysia()
  .get(
    "/projects",
    async () => {
      const config = getConfig()
      const projects = await Promise.all(
        config.projects.map(async (project) => {
          const processState = processManager.getProcess(project.id)
          const recentLogs = await readRecentLogs(project.id, 1)
          const lastRun = recentLogs[0] ?? null
          return {
            id: project.id,
            defaultBranch: project.defaultBranch,
            port: project.port,
            healthUrl: project.healthUrl,
            healthMode: project.healthMode,
            running: processManager.isRunning(project.id),
            process: processState
              ? {
                  pid: processState.pid,
                  startedAt: processState.startedAt,
                  command: processState.command,
                }
              : null,
            lastRun: lastRun
              ? {
                  runId: lastRun.runId,
                  startedAt: lastRun.startedAt,
                  updated: lastRun.updated,
                  healthStatus: lastRun.healthStatus,
                  durationMs: lastRun.durationMs,
                }
              : null,
          }
        })
      )
      return { projects }
    },
    {
      detail: { summary: "List all managed projects", tags: ["Projects"] },
    }
  )
  .get(
    "/ports",
    () => {
      const entries = processManager.getPortEntries()
      return { ports: entries }
    },
    {
      detail: { summary: "List all managed ports", tags: ["Projects"] },
    }
  )
