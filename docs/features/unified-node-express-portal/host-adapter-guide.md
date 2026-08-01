# Hosted Adapter and Standalone Wrapper Guide

Each repository compiles `dist/host/index.js` and exports `createHostedApplication(context)`. Importing this module must not listen, register process signal handlers, mutate global environment configuration, or initialize databases, watchers, timers, and sockets at module scope.

The factory creates repository-owned state from `context.repoRoot`. `initialize()` opens resources, `status()` reports readiness and active work, `attachRealtime()` attaches only the configured shared-server path, and `dispose()` closes every owned handle. Environment files are parsed from `<repoRoot>/.env` into a local object; adapters do not call a global dotenv loader or use generic host variables such as `PORT` as shared state.

The standalone entry point is the only module that calls `listen()`:

```ts
const hosted = await createHostedApplication(localContext)
const app = express()
app.use("/api", hosted.router)
const server = createServer(app)
await hosted.initialize?.()
const disposeRealtime = await hosted.attachRealtime?.(server)
server.listen(config.port)
```

Shutdown closes the HTTP server, invokes the realtime disposer, then invokes `hosted.dispose()`. `npm run verify:host` imports the compiled adapter with listening disabled and validates contract version 1. The SourceManager fixture additionally verifies that a sibling adapter resolves dependencies from its own repository.
