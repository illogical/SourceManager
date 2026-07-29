import type { StartupReconciliationStatus } from "../types"

const DEFAULT_TIMEOUT_MS = 5_000

let status: StartupReconciliationStatus = {
  state: "pending",
  startedAt: null,
  deadlineAt: null,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  total: 0,
  completed: 0,
  remainingMs: 0,
  message: "Startup reconciliation has not started",
}

export function beginStartupReconciliation(total: number, timeoutMs = DEFAULT_TIMEOUT_MS): void {
  const now = Date.now()
  status = {
    state: "running",
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + timeoutMs).toISOString(),
    timeoutMs,
    total,
    completed: 0,
    remainingMs: timeoutMs,
    message: total === 0 ? "No services require reconciliation" : "Checking saved services and Tailnet state",
  }
}

export function markStartupServiceComplete(): void {
  status = { ...status, completed: Math.min(status.total, status.completed + 1) }
}

export function completeStartupReconciliation(): void {
  status = {
    ...status,
    state: "complete",
    completed: status.total,
    remainingMs: 0,
    message: "Startup reconciliation complete",
  }
}

export function getStartupReconciliationStatus(now = Date.now()): StartupReconciliationStatus {
  if (status.state !== "running" || !status.deadlineAt) return { ...status }
  return {
    ...status,
    remainingMs: Math.max(0, new Date(status.deadlineAt).getTime() - now),
  }
}

export const STARTUP_RECONCILIATION_TIMEOUT_MS = DEFAULT_TIMEOUT_MS
