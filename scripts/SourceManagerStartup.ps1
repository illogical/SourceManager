[CmdletBinding()]
param(
    [int]$RestartExitCode = 75,
    [int]$MaxCrashRestarts = 5
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDirectory = Join-Path $RepoRoot "data\logs"
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null

$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$Version = (& $Node --version).Trim()
if ($Version -notmatch '^v24\.') { throw "SourceManager requires Node 24; found $Version" }

$LockPath = Join-Path $LogDirectory "production-wrapper.lock"
$LockStream = [System.IO.File]::Open($LockPath, 'OpenOrCreate', 'ReadWrite', 'None')
$TranscriptPath = Join-Path $LogDirectory ("sourcemanager-production-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Start-Transcript -Path $TranscriptPath -Append | Out-Null

try {
    Set-Location $RepoRoot
    $crashes = 0
    while ($true) {
        Write-Host "Starting SourceManager with $Npm start"
        & $Npm start
        $exitCode = $LASTEXITCODE
        if ($exitCode -eq $RestartExitCode) {
            $crashes = 0
            Write-Host "Restart exit code received; starting the rebuilt host."
            continue
        }
        if ($exitCode -eq 0) { break }
        $crashes++
        if ($crashes -gt $MaxCrashRestarts) { throw "SourceManager exceeded $MaxCrashRestarts crash restarts (last exit $exitCode)." }
        $delay = [Math]::Min(30, [Math]::Pow(2, $crashes))
        Write-Warning "SourceManager exited with $exitCode; retrying in $delay seconds."
        Start-Sleep -Seconds $delay
    }
} finally {
    Stop-Transcript | Out-Null
    $LockStream.Dispose()
}
