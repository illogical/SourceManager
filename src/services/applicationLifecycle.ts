export type ApplicationLifecycleState = "running" | "shutting_down"

let state: ApplicationLifecycleState = "running"
let shutdownHandler: (() => Promise<void>) | null = null
let shutdownPromise: Promise<void> | null = null

export function getApplicationLifecycleState(): ApplicationLifecycleState {
  return state
}

export function registerShutdownHandler(handler: () => Promise<void>): void {
  shutdownHandler = handler
}

export function requestSourceManagerShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  state = "shutting_down"
  shutdownPromise = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    await shutdownHandler?.()
  })()
  return shutdownPromise
}
