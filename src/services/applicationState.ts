export type ApplicationState = "running" | "shutting_down"

let applicationState: ApplicationState = "running"

export function getApplicationState(): ApplicationState {
  return applicationState
}

export function beginApplicationShutdown(): boolean {
  if (applicationState === "shutting_down") return false
  applicationState = "shutting_down"
  return true
}

export function resetApplicationStateForTests(): void {
  applicationState = "running"
}
