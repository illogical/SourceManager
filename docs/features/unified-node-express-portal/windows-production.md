# Windows Production Wrapper

The scheduled task runs `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\LocalDev\Projects\SourceManager\scripts\SourceManagerStartup.ps1` from the SourceManager repository. It must run under the intended development account and start after network availability.

The wrapper resolves Node 24 and `npm.cmd`, takes an exclusive lock so only one production host can run, executes the compiled `npm start`, and writes a transcript below `data/logs`. Exit code 75 requests an immediate graceful restart. Crashes use bounded exponential backoff and stop after five attempts. A normal exit does not restart.

Before changing the scheduled task, run `npm ci`, `npm run build`, and `npm run verify:host`. After changing it, confirm exactly one PID owns `SOURCEMANAGER_PORT` with `netstat -ano -p TCP`, verify `/health`, `/SourceManager`, authenticated `/api/SourceManager/projects`, WebSocket/Socket.IO routes for loaded adapters, and the one `apps` Tailscale advertisement.
