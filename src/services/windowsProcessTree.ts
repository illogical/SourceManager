import { createHash } from "node:crypto"

export interface ProcessInfo {
  pid: number
  parentPid: number
  creationDate: string | null
  executablePath: string | null
  commandLine: string | null
}

export interface ProcessTreeSelection {
  descendants: Set<number>
  protected: Set<number>
  terminationOrder: number[]
}

export function commandFingerprint(executablePath: string | null, commandLine: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify({
      executablePath: executablePath?.toLowerCase() ?? null,
      commandLine: commandLine ?? null,
    }))
    .digest("hex")
}

export async function snapshotProcesses(): Promise<ProcessInfo[]> {
  if (process.platform !== "win32") return snapshotPosixProcesses()

  const script = `
$ErrorActionPreference = 'Stop'
$items = Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    creationDate = if ($_.CreationDate) {
      $_.CreationDate.ToUniversalTime().ToString('o')
    } else {
      $null
    }
    executablePath = $_.ExecutablePath
    commandLine = $_.CommandLine
  }
}
$items | ConvertTo-Json -Compress
`
  const proc = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
    { stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr.trim() || `CIM process snapshot exited with code ${code}`)
  if (!stdout.trim()) return []
  const parsed = JSON.parse(stdout) as ProcessInfo | ProcessInfo[]
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => item.pid > 0)
}

export function selectProcessTree(
  snapshot: ProcessInfo[],
  rootPids: Iterable<number>,
  protectedRootPids: Iterable<number>,
  neverTerminate: Iterable<number> = [],
): ProcessTreeSelection {
  const children = new Map<number, number[]>()
  for (const item of snapshot) {
    const values = children.get(item.parentPid) ?? []
    values.push(item.pid)
    children.set(item.parentPid, values)
  }

  const descendants = expandRoots(rootPids, children)
  const protectedPids = expandRoots(protectedRootPids, children)
  for (const pid of neverTerminate) protectedPids.add(pid)

  const depth = new Map<number, number>()
  const visit = (pid: number, value: number) => {
    if ((depth.get(pid) ?? -1) >= value) return
    depth.set(pid, value)
    for (const child of children.get(pid) ?? []) visit(child, value + 1)
  }
  for (const root of rootPids) visit(root, 0)

  const terminationOrder = [...descendants]
    .filter((pid) => !protectedPids.has(pid))
    .sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0))

  return { descendants, protected: protectedPids, terminationOrder }
}

export async function terminateExactPid(pid: number): Promise<{ success: boolean; error?: string }> {
  if (pid <= 0 || pid === process.pid) return { success: false, error: "Refusing to terminate the current or invalid PID" }
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawn(
        ["taskkill.exe", "/PID", String(pid), "/F"],
        { stdout: "pipe", stderr: "pipe", windowsHide: true },
      )
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const text = `${stdout}\n${stderr}`.trim()
      if (code !== 0 && !/not found|no running instance/i.test(text)) {
        return { success: false, error: text || `taskkill exited with code ${code}` }
      }
      return { success: true }
    }
    process.kill(pid, "SIGKILL")
    return { success: true }
  } catch (error) {
    const value = error as NodeJS.ErrnoException
    return value.code === "ESRCH"
      ? { success: true }
      : { success: false, error: value.message }
  }
}

export async function terminateSelectedTree(selection: ProcessTreeSelection): Promise<Array<{ pid: number; success: boolean; error?: string }>> {
  const results: Array<{ pid: number; success: boolean; error?: string }> = []
  for (const pid of selection.terminationOrder) {
    const result = await terminateExactPid(pid)
    results.push({ pid, ...result })
  }
  return results
}

function expandRoots(roots: Iterable<number>, children: Map<number, number[]>): Set<number> {
  const result = new Set<number>()
  const pending = [...roots].filter((pid) => pid > 0)
  while (pending.length > 0) {
    const pid = pending.pop()!
    if (result.has(pid)) continue
    result.add(pid)
    pending.push(...(children.get(pid) ?? []))
  }
  return result
}

async function snapshotPosixProcesses(): Promise<ProcessInfo[]> {
  const proc = Bun.spawn(
    ["ps", "-eo", "pid=,ppid=,lstart=,comm=,args="],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr.trim() || `ps exited with code ${code}`)
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s*(.*)$/.exec(line)
    if (!match) return []
    return [{
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      creationDate: new Date(match[3]).toISOString(),
      executablePath: match[4],
      commandLine: match[5] || null,
    }]
  })
}
