import Elysia, { t } from "elysia"
import { requireProject } from "../config"
import { readRecentLogs } from "../services/runLogger"

export const logsRoute = new Elysia({ prefix: "/projects/:id" }).get(
  "/logs",
  async ({ params, query }) => {
    const project = requireProject(params.id)
    const n = Math.min(Math.max(1, query.n ?? 20), 100)
    const logs = await readRecentLogs(project.id, n)
    return { projectId: project.id, count: logs.length, logs: logs.reverse() }
  },
  {
    params: t.Object({ id: t.String() }),
    query: t.Object({ n: t.Optional(t.Numeric()) }),
    detail: { summary: "Get recent run logs", tags: ["Projects"] },
  }
)
