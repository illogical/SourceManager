# SO-3: Frontend Dashboard MVP — Implementation Plan

**DevPlanner card:** SO-3  
**Priority:** 3 (depends on SO-2 backend service model, which is complete)  
**Status:** Upcoming → In Progress  

---

## Decisions (confirmed before writing this plan)

| Decision | Choice |
|---|---|
| Frontend stack | React 19 + Vite 6 + TypeScript |
| Styling | Plain CSS modules (`.module.css`) — no extra deps |
| Token storage | `localStorage` under key `sm:token`; entered once on a Settings page |
| Dev workflow | Vite proxy for API routes; two processes (`dev:backend` + `dev:frontend`), one browser origin |
| Auto-refresh | 10s polling in the background while the dashboard is open |
| Tests | Vitest + jsdom + React Testing Library for frontend tests; existing Bun + Vitest (node) suites must remain green |

---

## Architecture overview

```
Browser (port 5173 in dev / port 17106 in prod)
  │
  ├── / GET → React SPA (Vite HMR in dev; Elysia static in prod)
  ├── /v1/* → proxied to Elysia backend (both dev and prod)
  ├── /health → proxied to Elysia backend
  └── /swagger → proxied to Elysia backend

Production: Elysia serves frontend/dist/ at /
            Elysia serves /v1/* /health /swagger normally
```

In **development** Vite runs on a separate port (e.g. 5173) and proxies `/v1/*`, `/health`, and `/swagger` requests to `http://localhost:17106`. Bun runs the backend with `--watch`. Both together give a single-origin browser experience with hot-reload on both sides.

In **production** `frontend:build` compiles the React app into `frontend/dist/`. Elysia uses `@elysiajs/static` to serve those files at `/`, with a catch-all SPA fallback for client-side routes. API routes are untouched.

---

## File tree to create

```
frontend/
  index.html
  vite.config.ts
  tsconfig.json
  vitest.config.ts           ← jsdom environment; covers frontend tests only
  src/
    main.tsx
    App.tsx
    App.module.css
    api/
      client.ts              ← typed fetch wrapper; reads token from localStorage
      types.ts               ← mirrors backend response shapes
    components/
      Settings.tsx           ← token entry form + connection test
      Settings.module.css
      RepoList.tsx           ← grouped service list (polls every 10s)
      RepoList.module.css
      ServiceCard.tsx        ← single service; lifecycle badge + controls
      ServiceCard.module.css
      LifecycleBadge.tsx     ← state chip: running/starting/stopped/failed
      LifecycleBadge.module.css
      ActionButton.tsx       ← button with loading/disabled state
    __tests__/
      client.test.ts         ← API client unit tests (fetch mock)
      Settings.test.tsx      ← RTL: token persistence, connection test UI
      ServiceCard.test.tsx   ← RTL: lifecycle badge, button states, polling

src/
  index.ts                   ← MODIFIED: add @elysiajs/static for prod static serving

package.json                 ← MODIFIED: new scripts + new deps
vitest.config.ts             ← MODIFIED: add frontend project
```

---

## Dependencies to add

```bash
# Frontend deps (in root package.json for Bun workspace simplicity)
bun add react react-dom
bun add -d vite @vitejs/plugin-react @types/react @types/react-dom
bun add -d @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom

# Backend dep
bun add @elysiajs/static
```

> **Note:** We install frontend deps at the root (not a nested workspace) to keep the build simple for Bun. The `frontend/tsconfig.json` can reference the root `node_modules`.

---

## Implementation sequence (strict TDD)

### Step 1 — Frontend scaffold + Vitest configuration

**Create files:**

`frontend/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SourceManager</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`frontend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

`frontend/vite.config.ts`:
```typescript
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  root: "frontend",
  plugins: [react()],
  build: {
    outDir: "../frontend/dist",   // relative to root
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://localhost:17106",
      "/health": "http://localhost:17106",
      "/swagger": "http://localhost:17106",
    },
  },
})
```

`frontend/vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
  root: "frontend",
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
  },
})
```

`frontend/src/__tests__/setup.ts`:
```typescript
import "@testing-library/jest-dom"
```

**Update root `vitest.config.ts`** to add the frontend as a project while keeping the existing node-env tests:
```typescript
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        // Backend / node tests — existing
        test: {
          name: "backend",
          include: ["tests/vitest/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        // Frontend / jsdom tests — new
        extends: "frontend/vitest.config.ts",
        test: {
          name: "frontend",
        },
      },
    ],
  },
})
```

**Update `package.json` scripts:**
```json
{
  "scripts": {
    "dev": "bun run dev:backend & bun run dev:frontend",
    "dev:backend": "bun run --watch src/index.ts",
    "dev:frontend": "bunx vite --config frontend/vite.config.ts",
    "start": "bun run src/index.ts",
    "frontend:build": "bunx vite build --config frontend/vite.config.ts",
    "test": "bun test tests/config.test.ts tests/middleware tests/services && bun test tests/routes",
    "test:watch": "bun test tests/config.test.ts tests/middleware tests/services --watch",
    "test:vitest": "bunx vitest run",
    "test:frontend": "bunx vitest run --project frontend",
    "test:backend": "bunx vitest run --project backend",
    "test:all": "bun run test && bun run test:vitest"
  }
}
```

**Verification:** `bunx vitest run --project frontend` reports no tests found (not failing). `bun run test` passes unchanged.

---

### Step 2 — API client (`frontend/src/api/client.ts`)

**Write failing test first** (`frontend/src/__tests__/client.test.ts`):

The test should verify:
1. `getToken()` / `setToken()` / `clearToken()` read and write `localStorage['sm:token']`
2. `apiFetch()` with a token set attaches `X-DevServer-Token` header
3. `apiFetch()` without a token set throws an `AuthError`
4. `apiFetch()` when the server returns 401 throws an `AuthError`
5. `apiFetch()` when the server returns 4xx/5xx throws an `ApiError` with `.status` and `.body`
6. `listRepos()` returns typed `{ repos: RepoSummary[] }` parsed from JSON

**Implement `frontend/src/api/types.ts`:**
```typescript
export type LifecycleState = "starting" | "running" | "stopped" | "failed"

export interface Lifecycle {
  state: LifecycleState
  pid: number | null
  startedAt: string | null
  readySince: string | null
  uptimeMs: number | null
  command: string | null
  lastError: string | null
}

export interface TailnetInfo {
  hostname: string
  domain: string | null
  serveEnabled: boolean
  serveMode: "https" | null
  serveTarget: string | null
}

export interface ServiceSummary {
  id: string
  displayName: string
  port: number
  healthUrl: string
  healthMode: "ping" | "full"
  packageManager: string
  scriptName: string
  tags: string[]
  allowedIps: string[]
  lifecycle: Lifecycle
  tailnet: TailnetInfo | null
}

export interface RepoSummary {
  id: string
  displayName: string
  repoPath: string
  defaultBranch: string
  services: ServiceSummary[]
}

export interface ReposResponse {
  repos: RepoSummary[]
}
```

**Implement `frontend/src/api/client.ts`:**
```typescript
import type { ReposResponse, RepoSummary, ServiceSummary } from "./types"

const TOKEN_KEY = "sm:token"
const BASE = ""  // same-origin; Vite proxy handles /v1/* in dev

export class AuthError extends Error {
  constructor(message = "Missing or invalid API token") {
    super(message)
    this.name = "AuthError"
  }
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`API error ${status}`)
    this.name = "ApiError"
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  if (!token) throw new AuthError()

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-DevServer-Token": token,
      ...options.headers,
    },
  })

  if (res.status === 401) throw new AuthError("Invalid API token — check Settings")

  if (!res.ok) {
    let body: unknown
    try { body = await res.json() } catch { body = await res.text() }
    throw new ApiError(res.status, body)
  }

  return res.json() as Promise<T>
}

// ── Endpoints ──────────────────────────────────────────────────────────────────

export function listRepos(): Promise<ReposResponse> {
  return apiFetch<ReposResponse>("/v1/repos")
}

export function getRepo(repoId: string): Promise<{ id: string; displayName: string; services: ServiceSummary[] }> {
  return apiFetch(`/v1/repos/${repoId}`)
}

export function startService(repoId: string, serviceId: string): Promise<unknown> {
  return apiFetch(`/v1/repos/${repoId}/services/${serviceId}/start`, { method: "POST" })
}

export function stopService(repoId: string, serviceId: string): Promise<unknown> {
  return apiFetch(`/v1/repos/${repoId}/services/${serviceId}/stop`, { method: "POST" })
}

export function restartService(repoId: string, serviceId: string): Promise<unknown> {
  return apiFetch(`/v1/repos/${repoId}/services/${serviceId}/restart`, { method: "POST" })
}

export function updateService(
  repoId: string,
  serviceId: string,
  body: { branch?: string; installMode?: string; restartMode?: string; dryRun?: boolean }
): Promise<unknown> {
  return apiFetch(`/v1/repos/${repoId}/services/${serviceId}/update`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function testConnection(): Promise<{ status: string }> {
  return apiFetch<{ status: string }>("/health")
}
```

**Verify:** `bunx vitest run --project frontend` passes the client tests.

---

### Step 3 — Settings component

**Write failing tests** (`frontend/src/__tests__/Settings.test.tsx`):
1. Renders a token input field
2. Saves token to localStorage on submit
3. Shows "Connected" after a successful `testConnection()` call
4. Shows an error message on `AuthError` or `ApiError`
5. Clears token on "Sign out" click

**Implement `frontend/src/components/Settings.tsx`:**
- `<form>` with `<input type="password">` for token
- On submit: call `setToken()`, then `testConnection()`, show result
- "Sign out" button calls `clearToken()` and resets state
- Styles from `Settings.module.css`

**Verify:** `bunx vitest run --project frontend` passes.

---

### Step 4 — LifecycleBadge component

**Write failing tests** (`frontend/src/__tests__/LifecycleBadge.test.tsx`):
1. Renders "running" badge with green indicator for `state="running"`
2. Renders "starting" badge with blue/amber indicator for `state="starting"`
3. Renders "stopped" badge for `state="stopped"`
4. Renders "failed" badge with red indicator for `state="failed"`

**Implement `frontend/src/components/LifecycleBadge.tsx`:**
- Maps `LifecycleState` → label + CSS class
- Uses CSS module for colors

---

### Step 5 — ActionButton component

**Write failing tests** (`frontend/src/__tests__/ActionButton.test.tsx`):
1. Renders enabled by default
2. When `loading={true}`, is disabled and shows spinner text
3. When `disabled={true}`, is disabled
4. Calls `onClick` once per click when enabled

**Implement `frontend/src/components/ActionButton.tsx`:**
```typescript
interface Props {
  label: string
  onClick: () => void
  loading?: boolean
  disabled?: boolean
  variant?: "primary" | "danger" | "secondary"
}
```

---

### Step 6 — ServiceCard component

**Write failing tests** (`frontend/src/__tests__/ServiceCard.test.tsx`):
1. Renders service `displayName` and `port`
2. Shows `LifecycleBadge` with the correct state
3. Shows Tailnet expected URL if `tailnet` is non-null with `tailnetDomain`
4. Start button is disabled when `lifecycle.state === "running"`
5. Stop button is disabled when `lifecycle.state === "stopped"`
6. Clicking Start calls `onStart(repoId, serviceId)`
7. During a pending action (prop `actionPending=true`), all buttons are disabled
8. Shows `lastError` when `lifecycle.state === "failed"`

**Implement `frontend/src/components/ServiceCard.tsx`:**
```typescript
interface Props {
  repoId: string
  service: ServiceSummary
  onStart: (repoId: string, serviceId: string) => Promise<void>
  onStop: (repoId: string, serviceId: string) => Promise<void>
  onRestart: (repoId: string, serviceId: string) => Promise<void>
  onUpdate: (repoId: string, serviceId: string) => Promise<void>
}
```

Internal state: `pendingAction: string | null` (name of in-flight action).  
On button click: set `pendingAction`, call prop handler, clear `pendingAction` (in finally).

---

### Step 7 — RepoList component

**Write failing tests** (`frontend/src/__tests__/RepoList.test.tsx`):
1. Renders a repo group header per repo
2. Renders a `ServiceCard` per service within each repo
3. Shows a loading skeleton while `repos` is null
4. Shows an error message when an `AuthError` is thrown
5. Calls `listRepos()` once on mount
6. Re-fetches after 10s via `setInterval` (use `vi.useFakeTimers()`)

**Implement `frontend/src/components/RepoList.tsx`:**
- `useEffect` on mount: fetch `listRepos()` and store in state; set `error` if thrown
- `useEffect` with `setInterval(fetch, 10_000)` for background refresh
- Expose action handlers that call `startService`/`stopService`/`restartService`/`updateService` and then immediately re-fetch

---

### Step 8 — App shell + routing

**Implement `frontend/src/App.tsx`:**
- Single page with header: "SourceManager" title + settings gear icon link
- Conditional rendering:
  - If no token in localStorage → show `<Settings />` with prompt "Enter your API token to continue"
  - Otherwise → show `<RepoList />`
- Header shows a Settings link that toggles the Settings panel

**Implement `frontend/src/main.tsx`:**
```typescript
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

---

### Step 9 — Backend static serving (production)

**Update `src/index.ts`** to serve `frontend/dist/` at `/` in production:

```typescript
import { staticPlugin } from "@elysiajs/static"

// Add after swagger plugin, before health route:
.use(
  staticPlugin({
    assets: "frontend/dist",
    prefix: "/",
    // SPA fallback: serve index.html for any unmatched path
    // (Elysia static serves index.html for 404 by default when indexHTML is set)
    indexHTML: true,
  })
)
```

The static plugin must be added **before** the `/v1` group so API routes take priority.
The existing `/health`, `/swagger`, and `/favicon.ico` routes remain untouched.

**Acceptance:** After `bun run frontend:build && bun run start`, visiting `http://localhost:17106/` serves the React app. All `/v1/*` calls work as before. `/health` and `/swagger` are unaffected.

---

### Step 10 — Final verification

Run in this order:

```bash
# 1. Frontend unit tests (jsdom)
bunx vitest run --project frontend

# 2. Backend vitest tests (unchanged)
bunx vitest run --project backend

# 3. Existing bun tests (must stay green)
bun run test

# 4. Full suite
bun run test:all

# 5. Production smoke test
bun run frontend:build
bun run start
# Then verify http://localhost:17106/ serves the dashboard
# and http://localhost:17106/v1/repos returns JSON (with a valid token)
```

---

## Component UX specification

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  SourceManager                              ⚙ Settings      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ▸ SourceManager                            (repo group)    │
│    ┌─────────────────────────────────────────────────────┐  │
│    │ SourceManager API          port 17106               │  │
│    │ ● running  PID 1234  uptime 2h 14m                  │  │
│    │ Tailnet: https://sourcemanager.bangus-city.ts.net    │  │
│    │ [Start] [Stop] [Restart] [Update]                   │  │
│    └─────────────────────────────────────────────────────┘  │
│                                                             │
│  ▸ DevPlanner                               (repo group)    │
│    ┌────────────────────────────────────────────────────┐   │
│    │ DevPlanner API              port 17103             │   │
│    │ ○ stopped                                          │   │
│    │ [Start] [Stop↗] [Restart] [Update]                 │   │
│    └────────────────────────────────────────────────────┘   │
│    ┌────────────────────────────────────────────────────┐   │
│    │ DevPlanner Frontend Dev     port 5173              │   │
│    │ ◌ starting...                                      │   │
│    │ [Start↗] [Stop] [Restart↗] [Update↗]              │   │
│    └────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Lifecycle badge colours (CSS modules)

| State | Colour | Label |
|---|---|---|
| `running` | green (`#22c55e`) | ● running |
| `starting` | amber (`#f59e0b`) | ◌ starting… |
| `stopped` | grey (`#6b7280`) | ○ stopped |
| `failed` | red (`#ef4444`) | ✕ failed |

### Button states

| Condition | Start | Stop | Restart | Update |
|---|---|---|---|---|
| `running` | disabled | enabled | enabled | enabled |
| `starting` | disabled | enabled | disabled | disabled |
| `stopped` | enabled | disabled | disabled | enabled |
| `failed` | enabled | disabled | disabled | enabled |
| `actionPending` | disabled | disabled | disabled | disabled |

### Update button behaviour
- Clicking Update triggers `POST /v1/repos/:repoId/services/:serviceId/update` with defaults (`installMode: "auto"`, `restartMode: "auto"`)
- A future card (SO-4/SO-5) will add a modal with branch/mode overrides
- For now just fire the default update and show the result in a toast-style message

### Settings panel
- Toggle open/closed with the ⚙ icon
- Input: `type="password"` for token
- "Save & test" button: calls `testConnection()` on `/health`
  - On success: shows "Connected ✓" and navigates to repo list
  - On `AuthError`: shows "Invalid token — check your projects.json"
  - On `ApiError`: shows error status and message
- "Clear token" button: removes from localStorage, shows login prompt

### Error states
- `AuthError` at top level: show a banner "Token missing or invalid — open Settings"
- Network error: show "Cannot reach SourceManager API — is the backend running?"
- `ApiError` on a lifecycle action: show inline error under the button that triggered it

---

## Non-goals for this card

- No config editing (SO-4)
- No package script runner (SO-5)
- No Tailscale enable/disable (SO-6) — show tailnet config data as read-only placeholders
- No live log streaming (SO-8)
- No public Tailscale Funnel
- No arbitrary shell commands from the UI

---

## README / SPECIFICATION updates

After implementation update:
- `README.md`: add "Frontend Dashboard" section — `bun run dev:frontend` instructions, Settings page token entry
- `docs/SPECIFICATION.md`: update with new `/` static route and dev workflow
- `docs/openapi.yaml`: no change — `/` is not part of the API spec
