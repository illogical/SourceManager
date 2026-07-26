# Remove Docker Support and Add Windows Logon Startup

**Status:** Implemented; Windows Scheduled Task validation pending

**Primary platform:** Windows 11

**Startup mode:** Current user logon, interactive development terminal

**Runtime command:** `bun run dev`

**Related:** [README](../../README.md), [SO-6C Tailscale Services](./SO-6C-tailscale-services-named-services.md)

---

## Summary

Remove Docker as a SourceManager runtime option and run SourceManager directly
on the Windows development machine. Add a PowerShell utility that registers an
interactive Scheduled Task so SourceManager starts in a visible terminal when
the current user logs in.

This is the best fit for the current process-management and Tailscale design:

- SourceManager starts managed applications as child processes on Windows.
- Managed applications use their normal host ports without maintaining a
  duplicate list of Docker port publications.
- Tailscale Services can continue forwarding to the loopback targets in the
  [Current LocalDev Service Map](./SO-6C-tailscale-services-named-services.md#current-localdev-service-map).
- Bun, Git, package-manager credentials, and Tailscale all run in the same user
  context as an interactive development session.

This document guided the implementation. The tracked Docker runtime files have
been removed, local environment configuration has been simplified, and
`scripts/SourceManagerStartup.ps1` has been added. The Scheduled Task must still
be installed and validated on the Windows development machine.

---

## Why Remove Docker

SourceManager starts each configured service with `Bun.spawn()` using the
repository as the working directory. When SourceManager runs in Docker, those
processes run inside the SourceManager container and share its network
namespace. A managed application's port is not automatically available on the
Windows host.

For example, a managed application listening on container port `5173` requires
an explicit Compose mapping such as:

```yaml
ports:
  - "5173:5173"
```

Every added or changed service port would require a matching Compose change and
container recreation. The host-based Tailscale design would also need to target
the published host port rather than the actual managed process.

Running SourceManager natively removes that mismatch. A service configured for
port `5173` runs directly on Windows port `5173`, and a Tailscale Service on the
same machine can target `http://127.0.0.1:5173`.

### Important LAN distinction

Native execution does not make an application automatically reachable from the
local network:

- A process bound to `127.0.0.1` is available only on the Windows machine.
- A process bound to `0.0.0.0` or the machine's LAN address can accept LAN
  connections if Windows Defender Firewall permits the port.
- SourceManager does not control the bind address. Each managed application's
  development command or server configuration controls it.
- Firewall rules should be limited to the required TCP port and the Windows
  Private network profile. Do not create broad firewall exceptions from the
  SourceManager startup script.

A loopback binding is sufficient for same-host Tailscale Services. Direct LAN
access is a separate opt-in configuration for each application.

---

## Scope

### In scope

- Remove committed Docker build and Compose artifacts.
- Remove Docker-only environment configuration and active documentation.
- Preserve the host workspace and relative repository-path model.
- Add one PowerShell utility for installing and managing an interactive
  at-logon Scheduled Task.
- Start SourceManager in development mode with visible backend and Vite output.
- Document local, LAN, and Tailscale reachability accurately.
- Document migration and validation on Windows.

### Out of scope

- Implementing Tailscale Services automation.
- Changing the Current LocalDev Service Map.
- Automatically starting all managed services when SourceManager starts.
- Creating Windows Firewall rules.
- Running SourceManager before a user logs in.
- Installing or uninstalling Docker Desktop.
- Changing HTTP APIs, TypeScript types, or process lifecycle behavior.
- Solving SourceManager self-update or self-restart behavior.
- Retaining a supported Docker deployment path.

---

## Docker Removal

### Delete tracked Docker artifacts

Delete:

```text
Dockerfile
compose.yaml
.dockerignore
.env.docker.example
```

Delete `.env.local.example` as well. It currently exists to map the shared
Docker host-workspace variable to the local runtime path and is unnecessary
after the Docker configuration is removed.

Do not delete a user's untracked `.env`, `.env.local`, `data/projects.json`,
state, logs, repositories, or Docker Desktop installation.

### Simplify ignored files

Remove only `.env.docker` from `.gitignore`.

Continue ignoring:

```text
.env
.env.local
```

`.env.local` remains a valid optional Bun environment override even though the
repository will no longer provide a dedicated example file for it.

### Simplify runtime environment configuration

Replace the Docker-oriented workspace variables in `.env.example`:

```dotenv
SOURCEMANAGER_HOST_WORKSPACE_PATH=C:/LocalDev/Projects
```

and:

```dotenv
SOURCEMANAGER_WORKSPACE_PATH=${SOURCEMANAGER_HOST_WORKSPACE_PATH}
```

with one direct local setting:

```dotenv
SOURCEMANAGER_PORT=17106
SOURCEMANAGER_TOKEN=replace-with-a-long-random-token
SOURCEMANAGER_WORKSPACE_PATH=C:/LocalDev/Projects
```

Retain all of the following:

- `SOURCEMANAGER_PORT`
- `SOURCEMANAGER_TOKEN`
- `SOURCEMANAGER_WORKSPACE_PATH`
- Relative `repoPath` values in `projects.json`
- Workspace containment and traversal validation
- Environment-owned runtime values in the Settings API

These behaviors are useful for local security and portable configuration and
are not Docker dependencies.

### Update active documentation

Update `README.md` to:

- Remove the entire "Running with Docker Desktop" section.
- Replace setup instructions with a direct `SOURCEMANAGER_WORKSPACE_PATH`
  value in `.env`.
- Stop instructing users to create `.env.local`.
- Replace the inline Scheduled Task commands with the checked-in PowerShell
  utility described below.
- Add the networking guidance from this plan.
- Clarify runtime prerequisites.
- Add one-time Docker migration and cleanup instructions.

Update `docs/SPECIFICATION.md` to remove:

- `SOURCEMANAGER_HOST_WORKSPACE_PATH`
- Docker Compose bind-mount wording
- Any statement presenting Docker as a supported SourceManager runtime

Historical feature documents may retain Docker references when Docker is only
an example external dependency or historical alternative. Do not rewrite
unrelated historical plans merely to eliminate the word "Docker."

### Runtime prerequisites after removal

SourceManager itself requires:

- Windows 10 or 11
- Bun
- Git

Managed applications must also have their own configured tools available in
the same user `PATH`. For the current LocalDev configuration this can include:

- Node.js and npm
- pnpm
- yarn
- Any application-specific runtime or command used by its package scripts

The Docker image previously installed several of these tools. Removing Docker
makes the Windows user environment the source of truth.

---

## One-Time Migration

Document these steps in the README before the new local startup task is
installed.

### 1. Stop the old container

If the checkout still contains `compose.yaml`, run:

```powershell
docker compose --env-file .env --env-file .env.docker down
```

If Docker support has already been removed from the checkout, target the known
container directly:

```powershell
docker stop sourcemanager
docker rm sourcemanager
```

Removing the container does not remove host repositories or the bind-mounted
`data` directory. Image removal is optional and should not be automated.

### 2. Update `.env`

Set the local workspace directly:

```dotenv
SOURCEMANAGER_PORT=17106
SOURCEMANAGER_TOKEN=<existing-secret>
SOURCEMANAGER_WORKSPACE_PATH=C:/LocalDev/Projects
```

Do not copy a real token into documentation, task arguments, command history, or
transcript output.

An existing `.env.local` can remain, but it must not set
`SOURCEMANAGER_WORKSPACE_PATH` to the old container path
`/workspace/projects`.

### 3. Prepare the local checkout

```powershell
Set-Location C:\LocalDev\Projects\SourceManager
bun install
```

Development mode does not require a prebuilt frontend because Vite runs as part
of `bun run dev`.

### 4. Handle Docker Desktop separately

If no other project needs Docker Desktop, the user may disable "Start Docker
Desktop when you sign in" or uninstall Docker Desktop manually. SourceManager
must not change Docker Desktop settings.

---

## PowerShell Utility

Add:

```text
scripts/SourceManagerStartup.ps1
```

The script must support this command surface:

```powershell
.\scripts\SourceManagerStartup.ps1 Install
.\scripts\SourceManagerStartup.ps1 Start
.\scripts\SourceManagerStartup.ps1 Stop
.\scripts\SourceManagerStartup.ps1 Status
.\scripts\SourceManagerStartup.ps1 Uninstall
```

`Run` is an internal command used by Task Scheduler:

```powershell
.\scripts\SourceManagerStartup.ps1 Run
```

Use a positional parameter with this validation:

```powershell
[ValidateSet("Install", "Uninstall", "Start", "Stop", "Status", "Run")]
[string] $Command = "Status"
```

The fixed Scheduled Task name is:

```text
SourceManager
```

### Repository and executable resolution

Derive the repository root from the checked-in script, not the caller's current
directory:

```powershell
$repoRoot = Split-Path -Parent $PSScriptRoot
```

Resolve Bun in this order:

1. `Get-Command bun.exe`
2. `%USERPROFILE%\.bun\bin\bun.exe`

Fail with an actionable error if Bun cannot be resolved. Store and use the
resolved absolute executable path. Do not rely on Task Scheduler inheriting the
interactive shell's `PATH`.

Resolve the PowerShell host for the task action in this order:

1. `pwsh.exe` when available
2. `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`

The task action must use an absolute PowerShell executable path and an absolute
script path.

### Prerequisite validation

`Install` and `Run` must validate:

- `bun.exe` exists.
- `<repo>\package.json` exists.
- `<repo>\node_modules` exists; otherwise instruct the user to run
  `bun install`.
- `<repo>\.env` exists.
- `<repo>\data\projects.json` exists.

Do not print `.env` contents or secret values.

`Install` must fail before changing Task Scheduler if validation fails. `Run`
must show the validation error in the terminal and write it to the launcher
transcript.

### Scheduled Task definition

`Install` must register or replace the task idempotently using:

- Trigger: current user logon
- Principal user: current Windows identity
- Logon type: `Interactive`
- Run level: `Limited`
- Execution time limit: zero/unlimited
- Start when available: enabled
- Multiple instances: `IgnoreNew`
- Allow start on battery: enabled
- Do not stop when switching to battery: enabled

The task action runs:

```text
<absolute powershell> -NoLogo -NoProfile -ExecutionPolicy Bypass -File "<absolute script>" Run
```

Use `New-ScheduledTaskPrincipal -LogonType Interactive` so the task uses the
existing signed-in user's interactive token. This is necessary for a visible
terminal and avoids storing a Windows password. Microsoft documents that an
interactive-token task only runs while the user is logged in:
[Task Scheduler logon types](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskfolder-registertask).

Use `Register-ScheduledTask -Force` so rerunning `Install` updates the existing
definition. `Install` should report whether it created or replaced the task,
then print the command for starting it immediately.

Do not use `RunLevel Highest`. SourceManager and its managed development
processes should run with the same normal privileges as the signed-in user.

Do not configure an automatic task restart loop. Bun watch mode handles normal
source changes, and closing the visible window must remain a meaningful way to
end that development session. The user can run `Start` to reopen it.

### Run behavior

`Run` must:

1. Create `data/logs` if it does not exist.
2. Start a PowerShell transcript named
   `sourcemanager-startup-<yyyyMMdd-HHmmss>.log`.
3. Set a recognizable terminal title such as
   `SourceManager Development Server`.
4. Print the start time, repository path, and Bun path, but not environment
   values.
5. Change to the repository root.
6. Execute:

   ```powershell
   & $bunPath run dev
   ```

7. Preserve and report the Bun exit code.
8. Stop the transcript in `finally`.
9. If startup validation fails or Bun exits unexpectedly, leave the diagnostic
   visible and prompt the user to press Enter before closing.

The visible terminal contains the combined backend and Vite development output
produced by the existing `dev` script. Closing the window ends the scheduled
task session.

SourceManager's existing application logs continue under `data/logs`. The new
startup transcript is only for launcher and console diagnostics.

### Management command behavior

`Start`:

- Require the task to exist.
- If it is already running, report that fact without starting another instance.
- Otherwise call `Start-ScheduledTask`.

`Stop`:

- If the task does not exist or is not running, succeed with an informative
  message.
- Otherwise call `Stop-ScheduledTask`.
- Check whether the configured SourceManager API and Vite ports still have
  listeners and warn with the remaining PIDs if child processes survived.
- Do not kill an arbitrary remaining port owner automatically.

`Status`:

- Report whether the task is installed.
- Report Task Scheduler state, last run time, last task result, and next run
  time when available.
- Report whether the configured API and Vite ports are listening.
- Never read or display the API token.

`Uninstall`:

- Call the same stop behavior first.
- Unregister the task with confirmation suppressed.
- Be idempotent when the task does not exist.
- Do not delete logs, configuration, dependencies, or repositories.

### README commands

Replace the current inline Scheduled Task implementation with:

```powershell
# Register SourceManager for the current user's logon
.\scripts\SourceManagerStartup.ps1 Install

# Start it now without signing out
.\scripts\SourceManagerStartup.ps1 Start

# Inspect task and port status
.\scripts\SourceManagerStartup.ps1 Status

# Stop the current development session
.\scripts\SourceManagerStartup.ps1 Stop

# Remove automatic startup
.\scripts\SourceManagerStartup.ps1 Uninstall
```

Explain that the terminal appears after user logon, both backend and Vite run in
development mode, and closing the terminal stops the session.

---

## Tailscale and Network Behavior

### Current LocalDev map remains unchanged

The existing targets remain correct for native Windows processes:

| Service | Local target |
|---|---|
| SourceManager web | `http://127.0.0.1:17116` |
| SourceManager API | `http://127.0.0.1:17106` |
| DevPlanner web | `http://127.0.0.1:5173` |
| DevPlanner API | `http://127.0.0.1:17103` |
| LMApi | `http://127.0.0.1:3111` |
| MemoryApi | `http://127.0.0.1:17107` |
| LMEval web | `http://127.0.0.1:5177` |
| LMEval API | `http://127.0.0.1:3200` |

Do not change service names, HTTPS URLs, or ports as part of Docker removal.

### SourceManager startup is not service startup

Starting SourceManager restores and prunes process state, but it does not start
every configured application. Managed applications remain controlled through
the dashboard and lifecycle API.

Tailscale endpoints for a managed service can only return a healthy application
response after that local service is running.

### Verification

Verify Tailscale HTTPS from a second device on the Tailnet. The service-host
machine may not be able to reach a Service it hosts through that Service's
hostname because of the documented no-hairpinning limitation.

For optional direct LAN access:

1. Configure the application to bind to `0.0.0.0` or the Windows LAN address.
2. Add a narrowly scoped inbound Windows Defender Firewall rule for its TCP
   port and the Private profile.
3. Test from a second LAN device.
4. Keep token authentication and application-level access controls enabled.

These LAN steps are per application and are not performed by SourceManager.

---

## Implementation Order

1. Remove the tracked Docker artifacts.
2. Simplify `.gitignore`, `.env.example`, and environment setup.
3. Update the README and specification.
4. Add `scripts/SourceManagerStartup.ps1`.
5. Run cross-platform application validation.
6. Run PowerShell parsing and Scheduled Task validation on Windows.
7. Perform logon, native process, Tailscale, and optional LAN smoke tests.

Keep each step narrowly scoped. Do not combine this work with the planned
Tailscale Services API or dashboard implementation.

---

## Validation

### Repository checks

Confirm Docker deployment artifacts are no longer tracked:

```bash
git ls-files Dockerfile compose.yaml .dockerignore .env.docker.example
```

Expected output: empty.

Search active runtime files for stale configuration:

```bash
rg -n "SOURCEMANAGER_HOST_WORKSPACE_PATH|env\\.docker|compose\\.yaml|/workspace/projects" \
  README.md docs/SPECIFICATION.md .env.example .gitignore package.json src frontend tests
```

Expected output: only the README's one-time migration advice for removing an
old `/workspace/projects` override. Historical feature plans are excluded
intentionally.

### Existing application checks

Run:

```bash
bun run test
bun run test:vitest
bunx tsc --noEmit
bun run frontend:build
git diff --check
```

Docker removal must not change application runtime behavior, API contracts, or
existing configuration validation.

### PowerShell static checks

On Windows:

```powershell
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path .\scripts\SourceManagerStartup.ps1),
  [ref]$null,
  [ref]$errors
) | Out-Null
$errors
```

Expected output: no parser errors.

Exercise every public command:

```powershell
.\scripts\SourceManagerStartup.ps1 Status
.\scripts\SourceManagerStartup.ps1 Install
.\scripts\SourceManagerStartup.ps1 Install
.\scripts\SourceManagerStartup.ps1 Start
.\scripts\SourceManagerStartup.ps1 Status
.\scripts\SourceManagerStartup.ps1 Stop
.\scripts\SourceManagerStartup.ps1 Uninstall
.\scripts\SourceManagerStartup.ps1 Uninstall
```

### Scheduled Task inspection

After installation, verify:

- Task name is `SourceManager`.
- Trigger is limited to the current user's logon.
- Principal logon type is interactive.
- Run level is limited.
- Action contains absolute executable and script paths.
- Execution time limit is unlimited.
- Multiple-instance policy is `IgnoreNew`.
- Reinstalling does not create a duplicate task.
- No password or SourceManager token appears in the task definition.

### Windows smoke tests

1. Log out and back in.
2. Confirm the SourceManager PowerShell terminal appears.
3. Confirm backend and Vite output are visible.
4. Verify `http://127.0.0.1:17106/health`.
5. Verify `http://127.0.0.1:17116/`.
6. Start one managed application through SourceManager.
7. Confirm it is a native Windows process listening on its configured port.
8. Stop it and confirm the listener exits.
9. Stop and uninstall the startup task.
10. Confirm SourceManager ports are no longer listening and the task is absent.

### Tailscale smoke test

From a second Tailnet device:

1. Start a managed service.
2. Confirm its configured loopback health target works on the Windows host.
3. Confirm its existing named Tailscale Service resolves.
4. Confirm HTTPS returns the expected application or health response.

If direct LAN access is required, test it separately from a second LAN device
after configuring application binding and firewall access.

---

## Acceptance Criteria

- No Docker deployment artifact remains tracked.
- Active setup and specification documentation have no Docker dependency.
- `.env.example` uses `SOURCEMANAGER_WORKSPACE_PATH` directly.
- Relative repository paths and workspace containment remain enforced.
- One checked-in PowerShell utility manages install, start, stop, status, run,
  and uninstall behavior.
- The task runs only for the signed-in current user with an interactive,
  non-elevated token.
- Logon opens a visible terminal running `bun run dev`.
- Installing and uninstalling are idempotent.
- No SourceManager token or Windows password is stored in the Scheduled Task or
  launcher transcript.
- SourceManager API and Vite endpoints work on their existing ports.
- Managed applications run as native Windows processes.
- The Current LocalDev Tailscale service names and targets remain unchanged.
- Existing automated application tests and builds pass.
- Windows-only validation results are reported honestly if they cannot be run
  in the implementation environment.

---

## Future Reconsideration of Docker

Docker support can return later as a separate architecture effort if there is a
clear need for isolation or deployment portability. That design must explicitly
solve:

- Dynamic or declarative exposure of every managed service port
- Host versus container process ownership
- Tailscale daemon and Service-host placement
- Host repository mounts and credentials
- Package-manager and runtime diversity across managed applications
- Safe container recreation when the service map changes

Until that work is prioritized, native Windows execution is the supported
personal-development model.

---

## Implementation Validation Result

Validated on the non-Windows implementation machine:

- Bun test suite: 103 passed
- Vitest suite: 141 passed
- TypeScript `--noEmit`: passed
- Frontend production build: passed
- Tracked Docker deployment artifacts: removed
- Docker commands: not run

PowerShell and Scheduled Task validation remains pending on the Windows
development machine because this implementation environment does not provide a
PowerShell executable or Windows Task Scheduler.
