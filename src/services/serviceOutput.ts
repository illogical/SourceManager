import { readdir, readFile, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export interface OutputChunk {
  runId: string
  segment: number
  cursor: string
  nextCursor: string
  text: string
  truncated: boolean
}

const OUTPUT_FILE = /^output-(\d{4})\.log$/
const SERVICE_OUTPUT_ROOT = join(
  import.meta.dir ?? dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
  "logs",
  "services",
)

export async function readServiceOutput(
  runId: string,
  logDirectory: string,
  cursor = "",
  limit = 64 * 1024,
): Promise<OutputChunk> {
  const segments = await listSegments(logDirectory)
  if (segments.length === 0) {
    return { runId, segment: 1, cursor: "1:0", nextCursor: "1:0", text: "", truncated: false }
  }

  const parsed = parseCursor(cursor)
  const requestedSegment = parsed?.segment ?? segments[0]
  const truncated = requestedSegment < segments[0] || !segments.includes(requestedSegment)
  let segment = truncated ? segments[0] : requestedSegment
  let offset = truncated ? 0 : (parsed?.offset ?? 0)
  const chunks: Buffer[] = []
  let remaining = Math.max(1, Math.min(limit, 256 * 1024))
  const initialCursor = `${segment}:${offset}`

  for (const current of segments.filter((value) => value >= segment)) {
    segment = current
    const buffer = await readFile(segmentPath(logDirectory, current))
    const start = current === requestedSegment && !truncated ? Math.min(offset, buffer.length) : 0
    const slice = buffer.subarray(start, start + remaining)
    chunks.push(slice)
    remaining -= slice.length
    offset = start + slice.length
    if (remaining === 0 || offset < buffer.length) break
    const nextIndex = segments.indexOf(current) + 1
    if (nextIndex < segments.length) {
      segment = segments[nextIndex]
      offset = 0
    }
  }

  return {
    runId,
    segment,
    cursor: initialCursor,
    nextCursor: `${segment}:${offset}`,
    text: Buffer.concat(chunks).toString("utf8"),
    truncated,
  }
}

export function streamServiceOutput(
  runId: string,
  logDirectory: string,
  initialCursor = "",
): Response {
  const encoder = new TextEncoder()
  let cursor = initialCursor
  let lastSegment = parseCursor(initialCursor)?.segment ?? null
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const poll = async () => {
        if (cancelled) return
        try {
          const chunk = await readServiceOutput(runId, logDirectory, cursor, 32 * 1024)
          if (chunk.text || chunk.truncated) {
            cursor = chunk.nextCursor
            if (lastSegment !== null && chunk.segment !== lastSegment) {
              controller.enqueue(encoder.encode(`event: rotation\ndata: ${JSON.stringify({
                runId,
                previousSegment: lastSegment,
                activeSegment: chunk.segment,
                cursor,
              })}\n\n`))
            }
            lastSegment = chunk.segment
            controller.enqueue(encoder.encode(`event: output\ndata: ${JSON.stringify(chunk)}\n\n`))
          }
        } catch (err) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`))
        }
        timer = setTimeout(poll, 500)
      }
      await poll()
    },
    cancel() {
      cancelled = true
      if (timer) clearTimeout(timer)
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  })
}

async function listSegments(logDirectory: string): Promise<number[]> {
  try {
    const entries = await readdir(logDirectory)
    return entries
      .map((entry) => OUTPUT_FILE.exec(entry))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number.parseInt(match[1], 10))
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

function parseCursor(cursor: string): { segment: number; offset: number } | null {
  const match = /^(\d+):(\d+)$/.exec(cursor)
  if (!match) return null
  return { segment: Number.parseInt(match[1], 10), offset: Number.parseInt(match[2], 10) }
}

function segmentPath(logDirectory: string, segment: number): string {
  return join(logDirectory, `output-${String(segment).padStart(4, "0")}.log`)
}

export async function pruneServiceOutputLogs(
  protectedDirectories: string[],
  keepDays = 7,
  maxBytesPerService = 100 * 1024 * 1024,
): Promise<void> {
  const protectedSet = new Set(protectedDirectories)
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
  let services: string[]
  try { services = await readdir(SERVICE_OUTPUT_ROOT) } catch { return }

  for (const serviceId of services) {
    const serviceDirectory = join(SERVICE_OUTPUT_ROOT, serviceId)
    let runIds: string[]
    try { runIds = await readdir(serviceDirectory) } catch { continue }
    const runs = await Promise.all(runIds.map(async (runId) => {
      const directory = join(serviceDirectory, runId)
      try {
        const info = await directoryInfo(directory)
        return { directory, ...info }
      } catch {
        return null
      }
    }))
    const existing = runs.filter((run): run is NonNullable<typeof run> => run !== null)
      .sort((a, b) => a.modifiedAt - b.modifiedAt)

    for (const run of existing) {
      if (!protectedSet.has(run.directory) && run.modifiedAt < cutoff) {
        await rm(run.directory, { recursive: true, force: true })
        run.bytes = 0
      }
    }

    let retained = existing.reduce((total, run) => total + run.bytes, 0)
    for (const run of existing) {
      if (retained <= maxBytesPerService) break
      if (protectedSet.has(run.directory) || run.bytes === 0) continue
      await rm(run.directory, { recursive: true, force: true })
      retained -= run.bytes
    }
  }
}

export async function readRecentServiceOutput(logDirectory: string, maxBytes = 4_096): Promise<string> {
  const segments = await listSegments(logDirectory)
  if (segments.length === 0) return ""
  try {
    const buffer = await readFile(segmentPath(logDirectory, segments.at(-1)!))
    return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8").trim()
  } catch {
    return ""
  }
}

async function directoryInfo(directory: string): Promise<{ bytes: number; modifiedAt: number }> {
  const entries = await readdir(directory)
  let bytes = 0
  let modifiedAt = 0
  for (const entry of entries) {
    const info = await stat(join(directory, entry))
    if (info.isFile()) {
      bytes += info.size
      modifiedAt = Math.max(modifiedAt, info.mtimeMs)
    }
  }
  return { bytes, modifiedAt }
}
