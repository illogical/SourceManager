# SO-4: JSON Config Edit UI — Implementation Plan

**DevPlanner card:** SO-4  
**Priority:** 4 (depends on SO-3 frontend dashboard, which is complete)  
**Status:** Upcoming  

---

## Objective

Let the dashboard read, validate, preview, and safely write `data/projects.json` without manual file editing. The JSON file remains the short-term source of truth; this card adds the frontend and backend workflow to edit it through a structured UI with explicit validation, diff/summary, and atomic apply semantics.

The UI must **not** become an arbitrary shell editor. It exposes only an allowlisted subset of config fields, validates each one before the user can apply, and shows a diff summary before writing.

---

## Decisions (confirmed before writing this plan)

| Decision | Choice |
|---|---|
| Config source of truth | `data/projects.json` (unchanged) |
| Editable scope | Allowlisted fields only — IDs and `server.token` are read-only in the editor |
| Apply mechanism | Atomic temp-file + rename on the backend; never in-place overwrite |
| Validation location | Backend (authoritative); frontend shows the backend's structured errors |
| Diff display | Field-level diff: old value vs new value per changed field |
| In-memory cache | `cachedConfig` in `config.ts` is invalidated after a successful apply |
| Tests | Vitest (node) for backend service + routes; Vitest (jsdom) for frontend UI |
| Non-goals | No `server.token` editing in the UI (security risk) |

---

## Architecture overview

```
Browser (ConfigEditor component)
  │
  ├── GET  /v1/config           → read current editable snapshot
  ├── POST /v1/config/validate  → validate proposed edits; get structured errors
  └── POST /v1/config/apply     → atomically write validated edits; invalidate cache
```

The backend exposes three routes under `/v1/config` (all auth-guarded). The frontend `ConfigEditor` component:

1. Fetches current config on mount
2. Lets the user edit allowlisted fields inline
3. Calls `/validate` on every change (debounced 300ms)
4. Shows field-level errors and a diff summary
5. Enables the "Apply" button only when validation passes with no errors
6. POSTs to `/apply` and refreshes the repo list on success

---

## Allowlisted editable fields

The following fields may be edited through the UI. All others are read-only or not exposed.

**Server-level** (one block, at the top):

| Field | Editable | Validation |
|---|---|---|
| `server.port` | ✓ | Integer 1–65535 |
| `server.frontendPort` | ✓ | Integer 1–65535 |
| `server.allowedIps` | ✓ | Array of valid CIDR strings (empty = all) |

> `server.token` is **not** editable in the UI. Token rotation requires direct file edit.

**Repo-level** (one block per repo):

| Field | Editable | Validation |
|---|---|---|
| `repo.displayName` | ✓ | Non-empty string |
| `repo.repoPath` | ✓ | Absolute path (non-empty); cannot point outside root |
| `repo.defaultBranch` | ✓ | Matches `/^[\w./-]+$/` |
| `repo.id` | Read-only | Cannot be changed — would invalidate running processes |

**Service-level** (one block per service within each repo):

| Field | Editable | Validation |
|---|---|---|
| `service.displayName` | ✓ | Non-empty string |
| `service.packageManager` | ✓ | One of `auto`, `bun`, `npm`, `yarn`, `pnpm` |
| `service.scriptName` | ✓ | Matches `/^[a-zA-Z0-9:_-]+$/` |
| `service.installCommand` | ✓ | Null or string with no shell metacharacters |
| `service.port` | ✓ | Integer 1–65535 |
| `service.healthUrl` | ✓ | Valid `http://` or `https://` URL |
| `service.healthMode` | ✓ | `ping` or `full` |
| `service.tags` | ✓ | Array of non-empty strings |
| `service.allowedIps` | ✓ | Array of valid CIDR strings |
| `service.tailnetHostname` | ✓ | Subdomain only (no dots, no slashes), or empty |
| `service.tailnetDomain` | ✓ | Non-empty string if set (e.g. `bangus-city.ts.net`) |
| `service.tailscaleServeEnabled` | ✓ | Boolean |
| `service.tailscaleServeMode` | ✓ | `https` only |
| `service.tailscaleServeTarget` | ✓ | Valid `http://` or `https://` URL |
| `service.id` | Read-only | Cannot be changed — would invalidate running processes |

---

## Files to create or modify

**New:**
- `src/services/configEditor.ts` — read, validate, diff, and atomic-write logic
- `src/routes/config.ts` — three Elysia routes (`GET /v1/config`, `POST /v1/config/validate`, `POST /v1/config/apply`)
- `frontend/src/components/ConfigEditor.tsx` — modal/panel editor UI
- `frontend/src/components/ConfigEditor.module.css` — styles
- `tests/vitest/services/configEditor.test.ts` — backend unit tests
- `tests/vitest/routes/config.test.ts` — backend route tests
- `frontend/src/__tests__/ConfigEditor.test.tsx` — frontend UI tests

**Modified:**
- `src/index.ts` — register new `configRoute`
- `src/config.ts` — export `invalidateCache()` for use after apply; export `CONFIG_PATH` constant
- `frontend/src/api/client.ts` — add `getConfig()`, `validateConfig()`, `applyConfig()` functions
- `frontend/src/api/types.ts` — add `EditableConfig`, `ValidationResult`, `ConfigDiff` types
- `frontend/src/components/ServiceCard.tsx` — add "Edit Config" button that opens `ConfigEditor`
- `docs/SPECIFICATION.md` — add config edit endpoint docs
- `data/projects.example.json` — already up to date; no changes needed

---

## TypeScript types

### Backend (`src/types.ts`) — additions

```typescript
// ── Config edit types ─────────────────────────────────────────────────────────

export interface EditableServerConfig {
  port: number
  frontendPort: number
  allowedIps: string[]
}

export interface EditableServiceConfig {
  id: string                           // read-only identifier
  displayName: string
  packageManager: "auto" | "bun" | "npm" | "yarn" | "pnpm"
  scriptName: string
  installCommand: string | null
  port: number
  healthUrl: string
  healthMode: "ping" | "full"
  tags: string[]
  allowedIps: string[]
  tailnetHostname?: string
  tailnetDomain?: string
  tailscaleServeEnabled?: boolean
  tailscaleServeMode?: "https"
  tailscaleServeTarget?: string
}

export interface EditableRepoConfig {
  id: string                           // read-only identifier
  displayName: string
  repoPath: string
  defaultBranch: string
  services: EditableServiceConfig[]
}

export interface EditableConfig {
  server: EditableServerConfig
  repos: EditableRepoConfig[]
}

export interface ValidationFieldError {
  path: string                         // e.g. "repos[0].services[1].port"
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationFieldError[]
  warnings: ValidationFieldError[]    // non-blocking but shown to user
}

export interface ConfigDiffEntry {
  path: string
  oldValue: unknown
  newValue: unknown
}

export interface ConfigDiff {
  changes: ConfigDiffEntry[]
  changeCount: number
}
```

### Frontend (`frontend/src/api/types.ts`) — additions

```typescript
export interface EditableServerConfig {
  port: number
  frontendPort: number
  allowedIps: string[]
}

export interface EditableServiceConfig {
  id: string
  displayName: string
  packageManager: string
  scriptName: string
  installCommand: string | null
  port: number
  healthUrl: string
  healthMode: "ping" | "full"
  tags: string[]
  allowedIps: string[]
  tailnetHostname?: string
  tailnetDomain?: string
  tailscaleServeEnabled?: boolean
  tailscaleServeMode?: "https"
  tailscaleServeTarget?: string
}

export interface EditableRepoConfig {
  id: string
  displayName: string
  repoPath: string
  defaultBranch: string
  services: EditableServiceConfig[]
}

export interface EditableConfig {
  server: EditableServerConfig
  repos: EditableRepoConfig[]
}

export interface ValidationFieldError {
  path: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationFieldError[]
  warnings: ValidationFieldError[]
}

export interface ConfigDiffEntry {
  path: string
  oldValue: unknown
  newValue: unknown
}

export interface ConfigDiff {
  changes: ConfigDiffEntry[]
  changeCount: number
}

export interface ConfigValidateResponse {
  validation: ValidationResult
  diff: ConfigDiff
}

export interface ConfigApplyResponse {
  success: boolean
  changeCount: number
}
```

---

## Backend: `src/services/configEditor.ts`

This is the core service module. It never reads `cachedConfig` directly; it always reads the file fresh to avoid serving a stale snapshot.

```typescript
export function readEditableConfig(): EditableConfig
```
Returns the subset of fields the UI may edit. Reads `data/projects.json` fresh (not from cache) so it reflects the last saved state. The `server.token` field is stripped. Repo and service IDs are included as read-only references.

```typescript
export function validateEditableConfig(proposed: EditableConfig): ValidationResult
```
Validates the proposed editable config against all rules listed in the Allowlisted fields table above. Returns `{ valid, errors[], warnings[] }`. Errors block apply; warnings are shown but do not block. Examples:
- Port out of range → error
- `repoPath` that is empty → error
- `tailnetHostname` that contains a dot → error
- `tailscaleServeEnabled: true` with `tailnetHostname` missing → warning (serve cannot work without hostname)
- No repos → error

```typescript
export function diffEditableConfig(current: EditableConfig, proposed: EditableConfig): ConfigDiff
```
Walks both configs field-by-field and returns `ConfigDiffEntry[]` for any values that changed. Uses deep equality for arrays. Path strings use dot notation and bracket notation for arrays, e.g. `repos[0].services[1].port`.

```typescript
export async function applyEditableConfig(proposed: EditableConfig): Promise<void>
```
1. Call `validateEditableConfig(proposed)` — throw if not valid
2. Read current raw config from disk to get the immutable fields (`server.token`, all `id` values)
3. Merge proposed editable values over the current raw config, preserving:
   - `server.token` (always kept from disk, never from proposed)
   - all `repo.id` and `service.id` values (always from disk)
4. Serialize merged config to JSON (2-space indent)
5. Write to a temp file in the same directory (`projects.json.tmp`)
6. Rename temp → `projects.json` (atomic on POSIX; best-effort on Windows)
7. Call `invalidateCache()` so the next request reloads fresh config

### Export `CONFIG_PATH` and `invalidateCache()` from `src/config.ts`

Add to `config.ts`:

```typescript
export const CONFIG_PATH = join(_dir, "..", "data", "projects.json")

export function invalidateCache(): void {
  cachedConfig = null
}
```

---

## Backend: `src/routes/config.ts`

Three routes, all auth-guarded. Register via `app.use(configRoute)` in `src/index.ts`.

### `GET /v1/config`

Returns the current editable config snapshot (no token field).

**Response 200:**
```json
{
  "config": {
    "server": { "port": 17106, "frontendPort": 17116, "allowedIps": [] },
    "repos": [
      {
        "id": "sourcemanager",
        "displayName": "SourceManager",
        "repoPath": "/Volumes/.../SourceManager",
        "defaultBranch": "main",
        "services": [
          {
            "id": "sourcemanager-api",
            "displayName": "SourceManager API",
            "packageManager": "bun",
            "scriptName": "dev",
            "installCommand": null,
            "port": 17106,
            "healthUrl": "http://localhost:17106/health",
            "healthMode": "ping",
            "tags": ["api"],
            "allowedIps": [],
            "tailnetHostname": "sourcemanager",
            "tailnetDomain": "bangus-city.ts.net",
            "tailscaleServeEnabled": false,
            "tailscaleServeMode": "https",
            "tailscaleServeTarget": "http://localhost:17106"
          }
        ]
      }
    ]
  }
}
```

### `POST /v1/config/validate`

Validates proposed editable config. Returns errors, warnings, and diff against current on-disk config. Does **not** write anything.

**Request body:** `{ "config": EditableConfig }`

**Response 200:**
```json
{
  "validation": {
    "valid": true,
    "errors": [],
    "warnings": [
      {
        "path": "repos[0].services[0].tailscaleServeEnabled",
        "message": "tailscaleServeEnabled is true but tailnetHostname is not set — serve will have no effect"
      }
    ]
  },
  "diff": {
    "changes": [
      { "path": "repos[0].services[0].port", "oldValue": 17106, "newValue": 17200 }
    ],
    "changeCount": 1
  }
}
```

**Response 400** (if request body is malformed / missing required shape):
```json
{ "error": "Invalid request body" }
```

### `POST /v1/config/apply`

Validates and atomically writes the proposed config. Invalidates the in-memory cache.

**Request body:** `{ "config": EditableConfig }`

**Response 200:**
```json
{ "success": true, "changeCount": 1 }
```

**Response 422** (validation errors — not written):
```json
{
  "error": "Validation failed",
  "validation": {
    "valid": false,
    "errors": [{ "path": "repos[0].services[0].port", "message": "port must be between 1 and 65535" }],
    "warnings": []
  }
}
```

**Response 500** (disk write failed):
```json
{ "error": "Failed to write config: <reason>" }
```

---

## Frontend: `frontend/src/api/client.ts` additions

```typescript
export function getEditableConfig(): Promise<{ config: EditableConfig }> {
  return apiFetch<{ config: EditableConfig }>("/v1/config")
}

export function validateEditableConfig(
  config: EditableConfig,
): Promise<ConfigValidateResponse> {
  return apiFetch<ConfigValidateResponse>("/v1/config/validate", {
    method: "POST",
    body: JSON.stringify({ config }),
  })
}

export function applyEditableConfig(
  config: EditableConfig,
): Promise<ConfigApplyResponse> {
  return apiFetch<ConfigApplyResponse>("/v1/config/apply", {
    method: "POST",
    body: JSON.stringify({ config }),
  })
}
```

---

## Frontend: `ConfigEditor` component

`frontend/src/components/ConfigEditor.tsx`

### Props

```typescript
interface ConfigEditorProps {
  onClose: () => void
  onApplied: () => void   // called after successful apply; parent refreshes repo list
}
```

### State

```typescript
type EditorPhase = "loading" | "editing" | "validating" | "previewing" | "applying" | "error"

interface EditorState {
  phase: EditorPhase
  original: EditableConfig | null        // fetched on mount
  draft: EditableConfig | null           // user's current edits
  validation: ValidationResult | null    // from last /validate response
  diff: ConfigDiff | null               // from last /validate response
  errorMessage: string | null
}
```

### Rendering phases

| Phase | What the user sees |
|---|---|
| `loading` | Spinner |
| `editing` | Structured fields; inline validation errors; diff badge |
| `validating` | Fields + spinner overlay |
| `previewing` | Diff table; warnings listed; "Apply" and "Back" buttons |
| `applying` | Spinner overlay |
| `error` | Error banner + "Close" |

### UX flow

1. **Mount** → fetch `GET /v1/config` → set `original` and `draft`; move to `editing`
2. **User edits any field** → update `draft`; debounce 300ms → call `POST /v1/config/validate`
3. **Validation response** → show field-level errors next to each field; update diff badge in header
4. **"Preview & Apply"** button (enabled only when `validation.valid === true`) → move to `previewing`
5. **Previewing** → show diff table (path | old | new); show warnings as yellow notices
6. **"Apply"** button → call `POST /v1/config/apply`; on success call `onApplied()`; close
7. **Apply error** → show error banner; stay in `previewing` so user can retry or go back

### Field rendering conventions

- Text inputs for string fields (displayName, repoPath, etc.)
- Number inputs for port fields
- `<select>` for enum fields (packageManager, healthMode)
- Comma-separated textarea for array fields (tags, allowedIps — each entry on its own line or comma-separated)
- Checkbox for boolean fields (tailscaleServeEnabled)
- Red border + error message below each field with a validation error
- Fields with `id` in read-only display (greyed `<code>` block, not an input)

### Entry point in the app

The ConfigEditor is opened from `ServiceCard` via an "Edit Config" button (gear/wrench icon). Since editing config affects all services, the component opens as a full-panel overlay (not per-service modal) covering the full dashboard.

**In `App.tsx`:** add `showConfigEditor: boolean` state. When true, render `<ConfigEditor onClose={() => setShowConfigEditor(false)} onApplied={() => { setShowConfigEditor(false); triggerRefresh() }} />` in place of (or on top of) the repo list.

**In `ServiceCard.tsx`:** add a small "Edit Config" button that calls `onEditConfig()` prop back to `App.tsx`.

---

## Implementation sequence (strict TDD)

### Step 1 — Export `CONFIG_PATH` and `invalidateCache()` from `src/config.ts`

**Write failing test first** (`tests/vitest/config.test.ts` — add to existing test file):

```typescript
test("invalidateCache forces reload on next getConfig() call", () => {
  // rely on the already-loaded config; invalidate; check that cachedConfig is reset
  invalidateCache()
  // getConfig() should re-read (will succeed if projects.json exists, or throw if not)
})
```

**Implement:** add `export const CONFIG_PATH = ...` and `export function invalidateCache() { cachedConfig = null }`.

**Verify:** `bunx vitest run --project backend` green; `bun test` green.

---

### Step 2 — `src/services/configEditor.ts` — read and diff

**Write failing tests** (`tests/vitest/services/configEditor.test.ts`):

```typescript
describe("readEditableConfig", () => {
  test("returns editable snapshot without server.token")
  test("includes all repos and services with their IDs")
})

describe("diffEditableConfig", () => {
  test("returns empty diff for identical configs")
  test("detects changed scalar field")
  test("detects changed array element")
  test("detects added array element")
  test("uses correct dot/bracket path notation")
})
```

Tests must use temp directories with a minimal valid `projects.json`. Never read the real `data/projects.json` in tests.

**Implement** `readEditableConfig()` and `diffEditableConfig()`.

**Verify:** targeted Vitest tests green; `bun test` green.

---

### Step 3 — `src/services/configEditor.ts` — validate

**Write failing tests:**

```typescript
describe("validateEditableConfig", () => {
  test("valid minimal config returns valid:true, no errors")
  test("port out of range returns error")
  test("empty displayName returns error")
  test("invalid healthUrl returns error")
  test("scriptName with spaces returns error")
  test("invalid CIDR in allowedIps returns error")
  test("tailnetHostname with dot returns error")
  test("tailscaleServeEnabled:true without tailnetHostname returns warning")
  test("no repos returns error")
  test("duplicate service IDs across repos return error")
})
```

**Implement** `validateEditableConfig()`.

**Verify:** targeted Vitest tests green; full Vitest suite green; `bun test` green.

---

### Step 4 — `src/services/configEditor.ts` — atomic apply

**Write failing tests:**

```typescript
describe("applyEditableConfig", () => {
  test("writes merged config to temp file then renames — real file is updated")
  test("preserves server.token from disk (not from proposed)")
  test("preserves repo and service IDs from disk (not from proposed)")
  test("throws if validation fails — does not write file")
  test("invalidates cachedConfig after successful write")
  test("handles disk write failure gracefully")
})
```

Tests must use isolated temp directories (e.g. `mkdtemp`) and mock `CONFIG_PATH` to point at the temp file. Never mutate `data/projects.json`.

**Implement** `applyEditableConfig()`.

**Verify:** targeted Vitest tests green; full suite green; `bun test` green.

---

### Step 5 — `src/routes/config.ts` + register in `src/index.ts`

**Write failing tests** (`tests/vitest/routes/config.test.ts`):

```typescript
describe("GET /v1/config", () => {
  test("returns 401 without token")
  test("returns editable config snapshot without server.token")
})

describe("POST /v1/config/validate", () => {
  test("returns 401 without token")
  test("returns 400 for malformed body")
  test("returns validation result and diff for valid proposed config")
  test("returns errors array for invalid proposed config (valid:false)")
})

describe("POST /v1/config/apply", () => {
  test("returns 401 without token")
  test("returns 422 when validation fails — does not write file")
  test("returns 200 and changeCount after successful apply")
  test("config cache is invalidated after apply (subsequent GET /v1/config reflects change)")
})
```

Mock `configEditor` module functions in route tests. Never use the real `data/projects.json`.

**Implement** the three routes and register them in `src/index.ts`.

**Verify:** targeted Vitest tests green; full Vitest suite green; `bun test` green.

---

### Step 6 — Frontend API client additions

**Write failing tests** (`frontend/src/__tests__/client.test.ts` — add to existing):

```typescript
test("getEditableConfig() calls GET /v1/config with auth header")
test("validateEditableConfig() calls POST /v1/config/validate with body")
test("applyEditableConfig() calls POST /v1/config/apply with body")
```

**Implement** the three new functions in `frontend/src/api/client.ts`.

**Verify:** `bunx vitest run --project frontend` green.

---

### Step 7 — `ConfigEditor` component

**Write failing tests** (`frontend/src/__tests__/ConfigEditor.test.tsx`):

```typescript
describe("ConfigEditor", () => {
  test("shows loading spinner while fetching config")
  test("renders fields for server port, frontendPort, and allowedIps")
  test("renders a section per repo with displayName, repoPath, defaultBranch")
  test("renders service fields: displayName, packageManager, scriptName, port, healthUrl")
  test("shows repo and service IDs as read-only (no input)")
  test("calls validateEditableConfig after field edit (debounced)")
  test("shows error message below field when validation returns error for that path")
  test("'Preview & Apply' button is disabled while validation.valid is false")
  test("'Preview & Apply' button is enabled when validation.valid is true")
  test("switches to previewing phase and shows diff table on 'Preview & Apply'")
  test("shows warnings in preview phase")
  test("calls applyEditableConfig on 'Apply'; calls onApplied() on success")
  test("shows error banner if apply fails; stays in previewing phase")
  test("onClose() is called when cancel/close button is clicked")
})
```

Use `vi.mock` to mock `../../api/client` functions. Use `vi.useFakeTimers()` for debounce assertions.

**Implement** `ConfigEditor.tsx` and `ConfigEditor.module.css`.

**Verify:** `bunx vitest run --project frontend` green; `bun test` green.

---

### Step 8 — Wire into App + ServiceCard

Add `showConfigEditor` state to `App.tsx`. Add "Edit Config" gear button to the top of `ServiceCard.tsx` (or as a floating button in the header). Pass `onEditConfig` prop up to App.

**Update existing `ServiceCard.test.tsx`** to cover the new button render and callback.

**Verify:** `bunx vitest run --project frontend` green; `bun test` green.

---

### Step 9 — Docs update

Update:
- `docs/SPECIFICATION.md` — add config edit endpoint table and field allowlist table
- `docs/openapi.yaml` — add `GET /v1/config`, `POST /v1/config/validate`, `POST /v1/config/apply` entries
- `README.md` — add short "Config editing" section under API Reference

---

## Non-goals (explicitly out of scope for SO-4)

- Editing `server.token` through the UI — rotate tokens directly in the file
- Managing external dependency services (Qdrant, Neo4j, Ollama, Docker)
- Public `tailscale funnel` support
- Arbitrary shell command execution from client input

---

## Security constraints

| Constraint | Implementation |
|---|---|
| No arbitrary command injection | `scriptName` validated against `/^[a-zA-Z0-9:_-]+$/`; `installCommand` validated against no shell metacharacters (`; & | > < \` $ ( ) { }`) |
| Token never in API response | `readEditableConfig()` strips `server.token`; apply merges token from disk, not from the request body |
| ID immutability for existing entries | `applyEditableConfig()` takes `id` from the current on-disk config for repos/services that already exist; new entries may supply a user-chosen ID |
| New IDs validated | New repo/service IDs must match `[a-z0-9-]+` and be globally unique; validated at both frontend and backend |
| Atomic write | Temp file + rename; avoids truncated config on crash or power failure |
| Auth required | All three endpoints require `X-DevServer-Token` header (existing middleware) |

---

## Structural editing (additive change — SO-4 extension)

Users need to add new repos and services, and remove existing ones, through the Settings UI. The MVP field-edit approach is extended as follows.

### Backend: ID-based merge (replaces index-based)

`applyEditableConfig` switches from index-based to **ID-based** merging:

1. Build a `Map<id, RepoConfig>` from the current disk config.
2. For each `proposedRepo` in `proposed.repos`:
   - If the ID is found in the map → update editable fields (same as before).
   - If the ID is **not** found → treat as a new repo; use proposed values verbatim.
3. Repos in the current config **not present** in the proposal are dropped (user deleted them).
4. Same logic for services within each repo (using a per-repo service ID map).

This means the proposal fully defines the resulting structure — order is preserved as sent by the client.

### Backend: ID validation additions

`validateEditableConfig` gains:
- Repo IDs must match `/^[a-z0-9-]+$/` and be unique within the proposal.
- Service IDs must match `/^[a-z0-9-]+$/` and be unique globally across all repos.
- Empty ID → error.

### Frontend: Add / Remove controls

- **"Add Repo" button** below the repo list — inserts a blank repo with a user-editable ID field (pre-filled with `new-repo`).
- **"Remove" button** on each repo card — removes it from the draft (with a brief confirmation if the repo has services).
- **"Add Service" button** at the bottom of each repo's service list — inserts a blank service with a user-editable ID.
- **"Remove" button** on each service card — removes it from the draft.
- New repo/service entries show an editable **ID field** (validated inline). Existing entries still show the ID as a read-only pill.
- A `newIds: Set<string>` in component state tracks which IDs were created this session so the UI knows which to show as editable vs read-only.

---

## Acceptance criteria

- [ ] `GET /v1/config` returns editable config without `server.token`; 401 without auth header.
- [ ] `POST /v1/config/validate` returns structured errors for invalid fields; returns diff for valid proposed config.
- [ ] `POST /v1/config/apply` writes atomically and returns 422 for invalid input; token always preserved from disk.
- [ ] `ConfigEditor` component renders all editable fields; shows validation errors inline; enables Apply only when valid.
- [ ] Preview/diff screen shows changed fields before apply.
- [ ] Successful apply invalidates cache; next `GET /v1/repos` reflects the change.
- [ ] All Vitest tests pass (`bunx vitest run`); all Bun tests pass (`bun test`).
- [ ] `data/projects.json` is never mutated by any test.
- [ ] `docs/SPECIFICATION.md` is updated with config edit endpoints and safety rules.

---

## Verification commands

```bash
# Run backend Vitest tests (node environment)
bunx vitest run --project backend

# Run frontend Vitest tests (jsdom environment)
bunx vitest run --project frontend

# Run full Vitest suite
bunx vitest run

# Run existing Bun tests (must remain green throughout)
bun test

# All suites
bun run test:all
```
