import { format } from "node:util"
import type { Readable } from "node:stream"

const COLORS: Record<string, string> = {
  backend: "\u001b[36m",
  frontend: "\u001b[35m",
  build: "\u001b[33m",
  server: "\u001b[36m",
}
const RESET = "\u001b[0m"

export function timestamp(): string {
  return new Intl.DateTimeFormat("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date())
}

export function prefixFor(label: string, color = Boolean(process.stdout.isTTY && !process.env.NO_COLOR)): string {
  const value = `[${timestamp()}] [${label}]`
  return color && COLORS[label] ? `${COLORS[label]}${value}${RESET}` : value
}

export function pipePrefixed(stream: Readable | null, label: string, destination: NodeJS.WriteStream): () => void {
  let buffered = ""
  const writeLines = (flush = false) => {
    const lines = buffered.split(/\r?\n/)
    buffered = flush ? "" : (lines.pop() ?? "")
    const complete = flush ? lines.filter((line, index) => line.length > 0 || index < lines.length - 1) : lines
    for (const line of complete) destination.write(`${prefixFor(label)} ${line}\n`)
  }
  stream?.on("data", (chunk: Buffer | string) => {
    buffered += chunk.toString()
    writeLines()
  })
  stream?.on("end", () => writeLines(true))
  return () => writeLines(true)
}

export function installConsolePrefix(label: string): void {
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  }
  console.log = (...args: unknown[]) => original.log(`${prefixFor(label)} ${format(...args)}`)
  console.warn = (...args: unknown[]) => original.warn(`${prefixFor(label)} ${format(...args)}`)
  console.error = (...args: unknown[]) => original.error(`${prefixFor(label)} ${format(...args)}`)
}
