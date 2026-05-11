import Elysia, { t } from "elysia"
import {
  readEditableConfig,
  validateEditableConfig,
  diffEditableConfig,
  applyEditableConfig,
} from "../services/configEditor"
import { ValidationError } from "../types"

export const configRoute = new Elysia({ prefix: "/config" })

  // GET /v1/config — read editable snapshot (no token field)
  .get("/", () => {
    const config = readEditableConfig()
    return { config }
  })

  // POST /v1/config/validate — validate proposed edits; return errors + diff
  .post(
    "/validate",
    ({ body }) => {
      const proposed = (body as { config: unknown }).config
      if (!proposed || typeof proposed !== "object") {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }

      const current = readEditableConfig()
      const validation = validateEditableConfig(proposed as Parameters<typeof validateEditableConfig>[0])
      const diff = diffEditableConfig(current, proposed as Parameters<typeof diffEditableConfig>[1])

      return { validation, diff }
    },
  )

  // POST /v1/config/apply — validate + atomically write
  .post(
    "/apply",
    async ({ body, set }) => {
      const proposed = (body as { config: unknown }).config
      if (!proposed || typeof proposed !== "object") {
        set.status = 400
        return { error: "Invalid request body" }
      }

      const current = readEditableConfig()

      try {
        await applyEditableConfig(proposed as Parameters<typeof applyEditableConfig>[0])
        const diff = diffEditableConfig(current, proposed as Parameters<typeof diffEditableConfig>[1])
        return { success: true, changeCount: diff.changeCount }
      } catch (err) {
        if (err instanceof ValidationError) {
          set.status = 422
          return { error: "Validation failed", validation: err.result }
        }
        console.error("[SourceManager] Config apply error:", err)
        set.status = 500
        return { error: `Failed to write config: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  )
