import { rename, writeFile } from "node:fs/promises"

export interface RunnerStatusWriterOptions {
  temporaryPath: string
  attempts?: number
  retryDelaysMs?: number[]
  write?: typeof writeFile
  replace?: typeof rename
  wait?: (durationMs: number) => Promise<void>
}

/**
 * Serializes atomic runner-status replacements. A runner must never have two
 * writers racing over the same temporary file on Windows.
 */
export class RunnerStatusWriter {
  private queue: Promise<void> = Promise.resolve()
  private readonly attempts: number
  private readonly retryDelaysMs: number[]
  private readonly write: typeof writeFile
  private readonly replace: typeof rename
  private readonly wait: (durationMs: number) => Promise<void>
  private readonly temporaryPath: string

  constructor(
    private readonly statusPath: string,
    options: RunnerStatusWriterOptions,
  ) {
    this.temporaryPath = options.temporaryPath
    this.attempts = Math.max(1, options.attempts ?? 3)
    this.retryDelaysMs = options.retryDelaysMs ?? [25, 100]
    this.write = options.write ?? writeFile
    this.replace = options.replace ?? rename
    this.wait = options.wait ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)))
  }

  publish(serializedStatus: string): Promise<void> {
    const operation = this.queue.then(() => this.replaceWithRetry(serializedStatus))
    this.queue = operation.catch(() => {})
    return operation
  }

  async flush(): Promise<void> {
    await this.queue
  }

  private async replaceWithRetry(serializedStatus: string): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        await this.write(this.temporaryPath, serializedStatus, { mode: 0o600 })
        await this.replace(this.temporaryPath, this.statusPath)
        return
      } catch (error) {
        lastError = error
        if (attempt >= this.attempts || !isTransientReplacementError(error)) break
        await this.wait(this.retryDelaysMs[Math.min(attempt - 1, this.retryDelaysMs.length - 1)] ?? 100)
      }
    }
    throw lastError
  }
}

function isTransientReplacementError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "EACCES" || code === "EBUSY" || code === "EPERM" || code === "ENOENT"
}
