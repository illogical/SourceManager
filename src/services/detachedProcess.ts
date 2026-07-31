import { spawn, type SpawnOptions } from "node:child_process"

export interface DetachedProcess {
  pid: number
  exited: Promise<number>
  unref(): void
}

/**
 * Launch persistent Windows runners through ShellExecute. This creates the
 * runner without inheriting the SourceManager backend's open HTTP socket
 * handles. A normal detached child_process spawn is sufficient on POSIX.
 */
export async function spawnDetachedProcess(
  command: string[],
  options: SpawnOptions,
): Promise<DetachedProcess> {
  if (process.platform !== "win32") {
    const child = spawn(command[0], command.slice(1), options)
    return {
      pid: child.pid ?? 0,
      exited: new Promise<number>((resolve, reject) => {
        child.once("exit", (code) => resolve(code ?? 1))
        child.once("error", reject)
      }),
      unref: () => child.unref(),
    }
  }

  const specification = Buffer.from(JSON.stringify({
    executable: command[0],
    argumentLine: command.slice(1).map(quoteWindowsArgument).join(" "),
    cwd: options.cwd ?? process.cwd(),
  }), "utf8").toString("base64")
  const script = `
$ErrorActionPreference = 'Stop'
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${specification}'))
$specification = $json | ConvertFrom-Json
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $specification.executable
$startInfo.WorkingDirectory = $specification.cwd
$startInfo.UseShellExecute = $true
$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.Arguments = $specification.argumentLine
$process = [Diagnostics.Process]::Start($startInfo)
if ($null -eq $process) { throw 'Windows did not return the detached process' }
[Console]::Out.Write($process.Id)
`
  const encodedScript = Buffer.from(script, "utf16le").toString("base64")
  const launcher = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
    {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  launcher.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
  launcher.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
  const launcherCode = await new Promise<number>((resolve, reject) => {
    launcher.once("exit", (code) => resolve(code ?? 1))
    launcher.once("error", reject)
  })
  const pid = Number.parseInt(Buffer.concat(stdout).toString("utf8").trim(), 10)
  if (launcherCode !== 0 || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      Buffer.concat(stderr).toString("utf8").trim()
      || `Detached Windows process launcher exited with code ${launcherCode}`,
    )
  }

  return {
    pid,
    exited: waitForProcessExit(pid),
    unref: () => {},
  }
}

function quoteWindowsArgument(value: string): string {
  if (value && !/[\s"]/.test(value)) return value
  return `"${value
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\+)$/g, "$1$1")}"`
}

async function waitForProcessExit(pid: number): Promise<number> {
  while (isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  // The signed runner status supplies the authoritative exit code. This
  // non-zero result only tells ProcessManager that the runner disappeared.
  return 1
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
