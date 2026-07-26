[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("Install", "Uninstall", "Start", "Stop", "Status", "Run")]
    [string] $Command = "Status"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$TaskName = "SourceManager"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ScriptPath = $PSCommandPath

function Assert-Windows {
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw "SourceManager startup task management is supported only on Windows."
    }
}

function Resolve-BunPath {
    $bunCommand = Get-Command "bun.exe" -ErrorAction SilentlyContinue
    if ($null -ne $bunCommand) {
        return $bunCommand.Source
    }

    $fallbackPath = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
    if (Test-Path -LiteralPath $fallbackPath -PathType Leaf) {
        return (Resolve-Path -LiteralPath $fallbackPath).Path
    }

    throw "Bun was not found. Install Bun, open a new PowerShell window, and confirm 'bun --version' works."
}

function Resolve-PowerShellPath {
    $pwshCommand = Get-Command "pwsh.exe" -ErrorAction SilentlyContinue
    if ($null -ne $pwshCommand) {
        return $pwshCommand.Source
    }

    $windowsPowerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (Test-Path -LiteralPath $windowsPowerShellPath -PathType Leaf) {
        return $windowsPowerShellPath
    }

    throw "Neither pwsh.exe nor Windows PowerShell could be found."
}

function Assert-StartupPrerequisites {
    [void] (Resolve-BunPath)

    $requiredFiles = @(
        (Join-Path $RepoRoot "package.json"),
        (Join-Path $RepoRoot ".env"),
        (Join-Path $RepoRoot "data\projects.json")
    )

    foreach ($requiredFile in $requiredFiles) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            throw "Required file not found: $requiredFile"
        }
    }

    $nodeModulesPath = Join-Path $RepoRoot "node_modules"
    if (-not (Test-Path -LiteralPath $nodeModulesPath -PathType Container)) {
        throw "Dependencies are not installed. Run 'bun install' in $RepoRoot and try again."
    }
}

function Get-RegisteredSourceManagerTask {
    return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Get-ConfiguredPorts {
    $apiPort = 17106
    $frontendPort = 5173

    foreach ($environmentFileName in @(".env", ".env.local")) {
        $environmentPath = Join-Path $RepoRoot $environmentFileName
        if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
            continue
        }

        foreach ($line in Get-Content -LiteralPath $environmentPath) {
            if ($line -match "^\s*SOURCEMANAGER_PORT\s*=\s*['`"]?(\d+)['`"]?\s*$") {
                $candidate = [int] $Matches[1]
                if ($candidate -ge 1 -and $candidate -le 65535) {
                    $apiPort = $candidate
                }
            }
        }
    }

    $projectsPath = Join-Path $RepoRoot "data\projects.json"
    if (Test-Path -LiteralPath $projectsPath -PathType Leaf) {
        try {
            $projects = Get-Content -LiteralPath $projectsPath -Raw | ConvertFrom-Json
            if ($null -ne $projects.server.frontendPort) {
                $candidate = [int] $projects.server.frontendPort
                if ($candidate -ge 1 -and $candidate -le 65535) {
                    $frontendPort = $candidate
                }
            }
        }
        catch {
            Write-Warning "Could not read the frontend port from data\projects.json: $($_.Exception.Message)"
        }
    }

    return [PSCustomObject] @{
        Api = $apiPort
        Frontend = $frontendPort
    }
}

function Get-PortListenerPids {
    param(
        [Parameter(Mandatory = $true)]
        [int] $Port
    )

    try {
        $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        return @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
    }
    catch {
        $pids = @()
        foreach ($line in & netstat.exe -ano -p TCP 2>$null) {
            if ($line -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
                $pids += [int] $Matches[1]
            }
        }
        return @($pids | Sort-Object -Unique)
    }
}

function Write-PortStatus {
    $ports = Get-ConfiguredPorts
    foreach ($entry in @(
        [PSCustomObject] @{ Name = "API"; Port = $ports.Api },
        [PSCustomObject] @{ Name = "Vite"; Port = $ports.Frontend }
    )) {
        $listenerPids = @(Get-PortListenerPids -Port $entry.Port)
        if ($listenerPids.Count -eq 0) {
            Write-Host "$($entry.Name) port $($entry.Port): not listening"
        }
        else {
            Write-Host "$($entry.Name) port $($entry.Port): listening (PID $($listenerPids -join ', '))"
        }
    }
}

function Stop-SourceManagerTask {
    $task = Get-RegisteredSourceManagerTask
    if ($null -eq $task) {
        Write-Host "Scheduled Task '$TaskName' is not installed."
        return
    }

    if ($task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TaskName

        $deadline = (Get-Date).AddSeconds(10)
        do {
            Start-Sleep -Milliseconds 250
            $task = Get-RegisteredSourceManagerTask
        } while ($null -ne $task -and $task.State -eq "Running" -and (Get-Date) -lt $deadline)

        Write-Host "Stopped Scheduled Task '$TaskName'."
    }
    else {
        Write-Host "Scheduled Task '$TaskName' is not running."
    }

    $ports = Get-ConfiguredPorts
    foreach ($port in @($ports.Api, $ports.Frontend)) {
        $listenerPids = @(Get-PortListenerPids -Port $port)
        if ($listenerPids.Count -gt 0) {
            Write-Warning "Port $port is still listening on PID $($listenerPids -join ', '). The script will not kill an unverified port owner."
        }
    }
}

function Install-SourceManagerTask {
    Assert-StartupPrerequisites

    $powerShellPath = Resolve-PowerShellPath
    $userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $actionArguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" Run"

    $action = New-ScheduledTaskAction `
        -Execute $powerShellPath `
        -Argument $actionArguments `
        -WorkingDirectory $RepoRoot

    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    $principal = New-ScheduledTaskPrincipal `
        -UserId $userId `
        -LogonType Interactive `
        -RunLevel Limited

    $settings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries

    $task = New-ScheduledTask `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Description "Starts SourceManager development mode in a visible terminal when $userId logs in."

    $existingTask = Get-RegisteredSourceManagerTask
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

    if ($null -eq $existingTask) {
        Write-Host "Installed Scheduled Task '$TaskName' for $userId."
    }
    else {
        Write-Host "Updated Scheduled Task '$TaskName' for $userId."
    }
    Write-Host "Start it now with: .\scripts\SourceManagerStartup.ps1 Start"
}

function Start-SourceManagerTask {
    $task = Get-RegisteredSourceManagerTask
    if ($null -eq $task) {
        throw "Scheduled Task '$TaskName' is not installed. Run '.\scripts\SourceManagerStartup.ps1 Install' first."
    }

    if ($task.State -eq "Running") {
        Write-Host "Scheduled Task '$TaskName' is already running."
        return
    }

    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started Scheduled Task '$TaskName'. The SourceManager terminal should appear shortly."
}

function Show-SourceManagerStatus {
    $task = Get-RegisteredSourceManagerTask
    if ($null -eq $task) {
        Write-Host "Scheduled Task '$TaskName': not installed"
        Write-PortStatus
        return
    }

    $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Scheduled Task '$TaskName': installed"
    Write-Host "State: $($task.State)"
    Write-Host "Last run: $($taskInfo.LastRunTime)"
    Write-Host "Last result: $($taskInfo.LastTaskResult)"
    Write-Host "Next run: $($taskInfo.NextRunTime)"
    Write-PortStatus
}

function Uninstall-SourceManagerTask {
    $task = Get-RegisteredSourceManagerTask
    if ($null -eq $task) {
        Write-Host "Scheduled Task '$TaskName' is already uninstalled."
        return
    }

    Stop-SourceManagerTask
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Uninstalled Scheduled Task '$TaskName'. Configuration, dependencies, and logs were preserved."
}

function Run-SourceManager {
    $logsPath = Join-Path $RepoRoot "data\logs"
    New-Item -ItemType Directory -Path $logsPath -Force | Out-Null

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $transcriptPath = Join-Path $logsPath "sourcemanager-startup-$timestamp.log"
    $transcriptStarted = $false
    $exitCode = 1

    try {
        Start-Transcript -Path $transcriptPath -Append | Out-Null
        $transcriptStarted = $true
        $Host.UI.RawUI.WindowTitle = "SourceManager Development Server"

        Assert-StartupPrerequisites
        $bunPath = Resolve-BunPath

        Write-Host "SourceManager development startup"
        Write-Host "Started: $(Get-Date -Format o)"
        Write-Host "Repository: $RepoRoot"
        Write-Host "Bun: $bunPath"
        Write-Host "Transcript: $transcriptPath"
        Write-Host ""

        Set-Location -LiteralPath $RepoRoot
        & $bunPath run dev
        $exitCode = $LASTEXITCODE

        if ($exitCode -ne 0) {
            Write-Error "SourceManager development mode exited with code $exitCode." -ErrorAction Continue
        }
        else {
            Write-Host "SourceManager development mode stopped."
        }
    }
    catch {
        Write-Error $_ -ErrorAction Continue
        $exitCode = 1
    }
    finally {
        if ($transcriptStarted) {
            Stop-Transcript | Out-Null
        }
    }

    if ($exitCode -ne 0) {
        [void] (Read-Host "Press Enter to close this window")
    }
    exit $exitCode
}

Assert-Windows

switch ($Command) {
    "Install" {
        Install-SourceManagerTask
    }
    "Uninstall" {
        Uninstall-SourceManagerTask
    }
    "Start" {
        Start-SourceManagerTask
    }
    "Stop" {
        Stop-SourceManagerTask
    }
    "Status" {
        Show-SourceManagerStatus
    }
    "Run" {
        Run-SourceManager
    }
}
