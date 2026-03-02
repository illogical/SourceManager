import type { HealthCheckResult, ProjectConfig } from "../types"

const TIMEOUT_MS = 5000

export async function checkHealth(project: ProjectConfig): Promise<HealthCheckResult> {
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(project.healthUrl, { signal: controller.signal })
    const durationMs = Date.now() - start
    clearTimeout(timer)

    if (!response.ok) {
      return {
        status: "fail",
        durationMs,
        detail: `HTTP ${response.status} ${response.statusText}`,
      }
    }

    if (project.healthMode === "full") {
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { status: "fail", durationMs, detail: "full mode: response body is not valid JSON" }
      }

      const b = body as Record<string, unknown>
      const ok = b["status"] === "ok" || b["ok"] === true || b["status"] === "healthy"
      if (!ok) {
        return {
          status: "fail",
          durationMs,
          detail: `full mode: expected status "ok" or ok=true, got: ${JSON.stringify(body)}`,
        }
      }
    }

    return { status: "pass", durationMs }
  } catch (err) {
    const durationMs = Date.now() - start
    clearTimeout(timer)
    const message = controller.signal.aborted
      ? `Health check timed out after ${TIMEOUT_MS}ms`
      : (err as Error).message
    return { status: "fail", durationMs, detail: message }
  }
}
