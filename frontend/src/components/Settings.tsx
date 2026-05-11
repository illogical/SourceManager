import { useState, useEffect } from "react"
import { ArrowLeft, ChevronDown, ChevronRight, AlertCircle, Plus, Trash2 } from "lucide-react"
import * as client from "../api/client"
import type { EditableConfig, EditableServiceConfig, ValidationFieldError } from "../api/types"
import styles from "./Settings.module.css"

// ── Validation helpers (mirrors backend rules) ────────────────────────────────

const BRANCH_RE = /^[\w./-]+$/
const SCRIPT_RE = /^[a-zA-Z0-9:_-]+$/
const CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/
const SHELL_META_RE = /[;&|><`$(){}\\\n]/
const SUBDOMAIN_RE = /^[a-z0-9-]+$/
const SLUG_RE = /^[a-z0-9-]+$/

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

function isValidCidr(s: string): boolean {
  return CIDR_RE.test(s)
}

function validateDraft(draft: EditableConfig, newIds: Set<string>): Record<string, string> {
  const errors: Record<string, string> = {}

  if (!Number.isInteger(draft.server.port) || draft.server.port < 1 || draft.server.port > 65535) {
    errors["server.port"] = "Must be an integer between 1 and 65535"
  }
  if (!Number.isInteger(draft.server.frontendPort) || draft.server.frontendPort < 1 || draft.server.frontendPort > 65535) {
    errors["server.frontendPort"] = "Must be an integer between 1 and 65535"
  }
  for (const cidr of draft.server.allowedIps) {
    if (!isValidCidr(cidr)) {
      errors["server.allowedIps"] = `Invalid CIDR: "${cidr}"`
      break
    }
  }

  const seenRepoIds = new Set<string>()
  for (let i = 0; i < draft.repos.length; i++) {
    const repo = draft.repos[i]
    const rp = `repos[${i}]`

    if (newIds.has(repo.id)) {
      if (!repo.id.trim() || !SLUG_RE.test(repo.id)) {
        errors[`${rp}.id`] = "Lowercase letters, digits, and hyphens only"
      } else if (seenRepoIds.has(repo.id)) {
        errors[`${rp}.id`] = "ID must be unique"
      }
    }
    seenRepoIds.add(repo.id)

    if (!repo.displayName.trim()) errors[`${rp}.displayName`] = "Required"
    if (!repo.repoPath.trim()) errors[`${rp}.repoPath`] = "Required"
    if (!repo.defaultBranch.trim()) {
      errors[`${rp}.defaultBranch`] = "Required"
    } else if (!BRANCH_RE.test(repo.defaultBranch)) {
      errors[`${rp}.defaultBranch`] = "Letters, digits, dots, hyphens, or slashes only"
    }

    const seenSvcIds = new Set<string>()
    for (let j = 0; j < repo.services.length; j++) {
      const svc = repo.services[j]
      const sp = `${rp}.services[${j}]`

      if (newIds.has(svc.id)) {
        if (!svc.id.trim() || !SLUG_RE.test(svc.id)) {
          errors[`${sp}.id`] = "Lowercase letters, digits, and hyphens only"
        } else if (seenSvcIds.has(svc.id)) {
          errors[`${sp}.id`] = "ID must be unique within repo"
        }
      }
      seenSvcIds.add(svc.id)

      if (!svc.displayName.trim()) errors[`${sp}.displayName`] = "Required"
      if (!Number.isInteger(svc.port) || svc.port < 1 || svc.port > 65535) {
        errors[`${sp}.port`] = "Integer 1–65535"
      }
      if (!svc.healthUrl.trim() || !isValidUrl(svc.healthUrl)) {
        errors[`${sp}.healthUrl`] = "Valid http:// or https:// URL required"
      }
      if (!svc.scriptName.trim()) {
        errors[`${sp}.scriptName`] = "Required"
      } else if (!SCRIPT_RE.test(svc.scriptName)) {
        errors[`${sp}.scriptName`] = "Letters, digits, colons, hyphens, underscores only"
      }
      if (svc.installCommand && SHELL_META_RE.test(svc.installCommand)) {
        errors[`${sp}.installCommand`] = "Cannot contain shell metacharacters"
      }
      for (const cidr of svc.allowedIps) {
        if (!isValidCidr(cidr)) {
          errors[`${sp}.allowedIps`] = `Invalid CIDR: "${cidr}"`
          break
        }
      }
      if (svc.tailnetHostname && !SUBDOMAIN_RE.test(svc.tailnetHostname)) {
        errors[`${sp}.tailnetHostname`] = "Lowercase letters, digits, and hyphens only"
      }
      if (svc.tailscaleServeTarget && !isValidUrl(svc.tailscaleServeTarget)) {
        errors[`${sp}.tailscaleServeTarget`] = "Valid http:// or https:// URL required"
      }
    }
  }

  return errors
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  onConnected?: () => void
  onClose?: () => void
  onSaved?: (message: string) => void
  onSaveError?: (message: string, detail?: unknown) => void
}

// ── Field helpers ─────────────────────────────────────────────────────────────

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return (
    <span className={styles.fieldError} role="alert">
      <AlertCircle aria-hidden size={12} strokeWidth={2.5} />
      {message}
    </span>
  )
}

function parseLines(val: string): string[] {
  return val
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function joinLines(arr: string[]): string {
  return arr.join(", ")
}

/** Generate a unique ID that doesn't collide with the provided set */
function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Settings({ onConnected, onClose, onSaved, onSaveError }: Props) {
  const hasToken = !!client.getToken()

  // ── Token section state ────────────────────────────────────────────────────
  const [tokenInput, setTokenInput] = useState("")
  const [tokenStatus, setTokenStatus] = useState<"idle" | "checking" | "ok" | "error">("idle")
  const [tokenMessage, setTokenMessage] = useState("")

  // ── Config editor state ────────────────────────────────────────────────────
  const [configPhase, setConfigPhase] = useState<"loading" | "ready" | "loadError">("loading")
  const [draft, setDraft] = useState<EditableConfig | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [serverErrors, setServerErrors] = useState<ValidationFieldError[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [expandedTailscale, setExpandedTailscale] = useState<Set<string>>(new Set())
  // Tracks IDs that were created in this session (so their ID field renders as editable)
  const [newIds, setNewIds] = useState<Set<string>>(new Set())

  // Load config on mount (only if authenticated)
  useEffect(() => {
    if (!hasToken) return
    let cancelled = false
    client.getEditableConfig()
      .then(({ config }) => {
        if (!cancelled) {
          setDraft(config)
          setConfigPhase("ready")
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("[SourceManager] Failed to load editable config:", err)
          setConfigPhase("loadError")
        }
      })
    return () => { cancelled = true }
  }, [hasToken])

  // Re-validate whenever draft or newIds changes
  useEffect(() => {
    if (!draft) return
    setFieldErrors(validateDraft(draft, newIds))
  }, [draft, newIds])

  // ── Token form ─────────────────────────────────────────────────────────────

  async function handleTokenSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!tokenInput.trim()) return
    client.setToken(tokenInput.trim())
    setTokenStatus("checking")
    setTokenMessage("")
    try {
      await client.testConnection()
      setTokenStatus("ok")
      setTokenMessage("Connected ✓")
      onConnected?.()
    } catch (err) {
      setTokenStatus("error")
      if (err instanceof client.AuthError) {
        setTokenMessage(`Invalid token — ${err.message}`)
      } else if (err instanceof client.ApiError) {
        setTokenMessage(`Error ${err.status}: check the backend`)
      } else {
        setTokenMessage("Cannot reach SourceManager API — is the backend running?")
      }
    }
  }

  function handleSignOut() {
    client.clearToken()
    setTokenInput("")
    setTokenStatus("idle")
    setTokenMessage("")
  }

  // ── Config save ────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!draft) return
    const localErrors = validateDraft(draft, newIds)
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors)
      document.querySelector<HTMLElement>("[data-field]")?.scrollIntoView({ behavior: "smooth", block: "center" })
      return
    }

    setIsSaving(true)
    setServerErrors([])
    try {
      await client.applyEditableConfig(draft)
      onSaved?.("Configuration saved — restart required if ports changed")
    } catch (err) {
      if (err instanceof client.ApiError && err.status === 422) {
        const body = err.body as { validation?: { errors?: ValidationFieldError[] } }
        const errs = body?.validation?.errors ?? []
        setServerErrors(errs)
        const errorMap: Record<string, string> = {}
        for (const e of errs) errorMap[e.path] = e.message
        setFieldErrors(errorMap)
        const detail = `Server validation: ${errs.map((e) => `${e.path}: ${e.message}`).join("; ")}`
        console.error("[SourceManager] Config save validation error:", detail, err.body)
        onSaveError?.("Configuration has validation errors — check the form", err.body)
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[SourceManager] Config save error:", err)
        onSaveError?.(`Failed to save configuration: ${msg}`, err)
      }
    } finally {
      setIsSaving(false)
    }
  }

  // ── Draft updaters ─────────────────────────────────────────────────────────

  function setServerField<K extends keyof EditableConfig["server"]>(
    key: K,
    value: EditableConfig["server"][K],
  ) {
    setDraft((d) => (d ? { ...d, server: { ...d.server, [key]: value } } : d))
  }

  function setRepoField<K extends keyof EditableConfig["repos"][number]>(
    i: number,
    key: K,
    value: EditableConfig["repos"][number][K],
  ) {
    setDraft((d) => {
      if (!d) return d
      const repos = [...d.repos]
      repos[i] = { ...repos[i], [key]: value }
      return { ...d, repos }
    })
  }

  function setServiceField<K extends keyof EditableServiceConfig>(
    i: number,
    j: number,
    key: K,
    value: EditableServiceConfig[K],
  ) {
    setDraft((d) => {
      if (!d) return d
      const repos = [...d.repos]
      const services = [...repos[i].services]
      services[j] = { ...services[j], [key]: value }
      repos[i] = { ...repos[i], services }
      return { ...d, repos }
    })
  }

  function toggleTailscale(svcId: string) {
    setExpandedTailscale((prev) => {
      const next = new Set(prev)
      if (next.has(svcId)) next.delete(svcId)
      else next.add(svcId)
      return next
    })
  }

  // ── Structural add/remove ──────────────────────────────────────────────────

  function addRepo() {
    const id = uniqueId("new-repo", new Set(draft?.repos.map((r) => r.id) ?? []))
    setNewIds((prev) => new Set(prev).add(id))
    setDraft((d) => {
      if (!d) return d
      return {
        ...d,
        repos: [
          ...d.repos,
          {
            id,
            displayName: "",
            repoPath: "",
            defaultBranch: "main",
            services: [],
          },
        ],
      }
    })
  }

  function removeRepo(i: number) {
    setDraft((d) => {
      if (!d) return d
      const repos = d.repos.filter((_, idx) => idx !== i)
      return { ...d, repos }
    })
  }

  function addService(repoIndex: number) {
    const existingIds = new Set(draft?.repos.flatMap((r) => r.services.map((s) => s.id)) ?? [])
    const id = uniqueId("new-service", existingIds)
    setNewIds((prev) => new Set(prev).add(id))
    setDraft((d) => {
      if (!d) return d
      const repos = [...d.repos]
      repos[repoIndex] = {
        ...repos[repoIndex],
        services: [
          ...repos[repoIndex].services,
          {
            id,
            displayName: "",
            packageManager: "auto" as const,
            scriptName: "dev",
            installCommand: null,
            port: 3000,
            healthUrl: "http://localhost:3000/health",
            healthMode: "ping" as const,
            tags: [],
            allowedIps: [],
          },
        ],
      }
      return { ...d, repos }
    })
  }

  function removeService(repoIndex: number, svcIndex: number) {
    setDraft((d) => {
      if (!d) return d
      const repos = [...d.repos]
      repos[repoIndex] = {
        ...repos[repoIndex],
        services: repos[repoIndex].services.filter((_, idx) => idx !== svcIndex),
      }
      return { ...d, repos }
    })
  }

  function setRepoId(i: number, value: string) {
    setDraft((d) => {
      if (!d) return d
      const repos = [...d.repos]
      const oldId = repos[i].id
      repos[i] = { ...repos[i], id: value }
      // update newIds tracking if the id changed
      setNewIds((prev) => {
        const next = new Set(prev)
        if (next.has(oldId)) {
          next.delete(oldId)
          next.add(value)
        }
        return next
      })
      return { ...d, repos }
    })
  }

  function setServiceId(repoIndex: number, svcIndex: number, value: string) {
    setDraft((d) => {
      if (!d) return d
      const repos = [...d.repos]
      const services = [...repos[repoIndex].services]
      const oldId = services[svcIndex].id
      services[svcIndex] = { ...services[svcIndex], id: value }
      setNewIds((prev) => {
        const next = new Set(prev)
        if (next.has(oldId)) {
          next.delete(oldId)
          next.add(value)
        }
        return next
      })
      repos[repoIndex] = { ...repos[repoIndex], services }
      return { ...d, repos }
    })
  }

  const hasLocalErrors = Object.keys(fieldErrors).length > 0

  // ── Render: no token ───────────────────────────────────────────────────────

  if (!hasToken) {
    return (
      <div className={styles.container}>
        <h2 className={styles.heading}>Connect to SourceManager</h2>
        <p className={styles.intro}>Enter your API token from <code>data/projects.json</code> to get started.</p>
        <TokenForm
          token={tokenInput}
          onChange={setTokenInput}
          onSubmit={handleTokenSubmit}
          status={tokenStatus}
          message={tokenMessage}
          hasExisting={false}
          onSignOut={handleSignOut}
        />
      </div>
    )
  }

  // ── Render: full settings page ─────────────────────────────────────────────

  return (
    <div className={styles.page}>
      {/* Page header */}
      <div className={styles.pageHeader}>
        <button className={styles.backBtn} onClick={onClose} type="button">
          <ArrowLeft aria-hidden size={16} strokeWidth={2.5} />
          Dashboard
        </button>
        <h1 className={styles.pageTitle}>Settings</h1>
        <div className={styles.pageActions}>
          <button className={styles.cancelBtn} type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className={styles.saveBtn}
            type="button"
            onClick={() => { void handleSave() }}
            disabled={isSaving || configPhase !== "ready"}
          >
            {isSaving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* Server validation errors banner */}
      {serverErrors.length > 0 && (
        <div className={styles.errorBanner} role="alert">
          <AlertCircle aria-hidden size={16} strokeWidth={2.2} />
          <span>
            {serverErrors.length} validation error{serverErrors.length !== 1 ? "s" : ""} — check the highlighted fields below.
          </span>
        </div>
      )}

      {/* Config sections */}
      {configPhase === "loading" && (
        <div className={styles.loadingState}>Loading configuration…</div>
      )}
      {configPhase === "loadError" && (
        <div className={styles.loadErrorState}>
          Failed to load configuration from the API. Check your token and try again.
        </div>
      )}
      {configPhase === "ready" && draft && (
        <>
          {/* ── Server section ─────────────────────────────────────────────── */}
          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>Server</h2>
            <div className={styles.sectionCard}>
              <div className={styles.fieldsRow}>
                <Field
                  label="API Port"
                  required
                  path="server.port"
                  error={fieldErrors["server.port"]}
                >
                  <input
                    className={inputClass(fieldErrors["server.port"])}
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.server.port}
                    onChange={(e) => setServerField("port", parseInt(e.target.value) || 0)}
                  />
                </Field>
                <Field
                  label="Frontend Dev Port"
                  path="server.frontendPort"
                  error={fieldErrors["server.frontendPort"]}
                  hint="Vite dev server port"
                >
                  <input
                    className={inputClass(fieldErrors["server.frontendPort"])}
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.server.frontendPort}
                    onChange={(e) => setServerField("frontendPort", parseInt(e.target.value) || 0)}
                  />
                </Field>
              </div>
              <Field
                label="Allowed IPs"
                path="server.allowedIps"
                error={fieldErrors["server.allowedIps"]}
                hint="CIDR ranges, comma-separated. Empty = all IPs allowed."
              >
                <textarea
                  className={`${styles.textarea} ${fieldErrors["server.allowedIps"] ? styles.inputError : ""}`}
                  rows={2}
                  placeholder="e.g. 192.168.1.0/24, 10.0.0.0/8"
                  value={joinLines(draft.server.allowedIps)}
                  onChange={(e) => setServerField("allowedIps", parseLines(e.target.value))}
                />
              </Field>
            </div>
          </section>

          {/* ── Repos & Services ───────────────────────────────────────────── */}
          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>Repos &amp; Services</h2>
            <div className={styles.repoList}>
              {draft.repos.map((repo, i) => (
                <div key={repo.id} className={styles.repoCard}>
                  {/* Repo header */}
                  <div className={styles.repoHeader}>
                    {newIds.has(repo.id) ? (
                      <Field
                        label="Repo ID"
                        required
                        path={`repos[${i}].id`}
                        error={fieldErrors[`repos[${i}].id`]}
                        hint="Slug: lowercase, digits, hyphens"
                      >
                        <input
                          className={inputClass(fieldErrors[`repos[${i}].id`])}
                          type="text"
                          placeholder="my-repo"
                          value={repo.id}
                          onChange={(e) => setRepoId(i, e.target.value)}
                        />
                      </Field>
                    ) : (
                      <span className={styles.repoIdPill}>{repo.id}</span>
                    )}
                    <span className={styles.repoLabel}>Repository</span>
                    <button
                      type="button"
                      className={styles.removeBtn}
                      onClick={() => removeRepo(i)}
                      title="Remove this repo"
                    >
                      <Trash2 aria-hidden size={14} strokeWidth={2} />
                      Remove
                    </button>
                  </div>

                  {/* Repo fields */}
                  <div className={styles.repoFields}>
                    <Field
                      label="Display Name"
                      required
                      path={`repos[${i}].displayName`}
                      error={fieldErrors[`repos[${i}].displayName`]}
                    >
                      <input
                        className={inputClass(fieldErrors[`repos[${i}].displayName`])}
                        type="text"
                        value={repo.displayName}
                        onChange={(e) => setRepoField(i, "displayName", e.target.value)}
                      />
                    </Field>
                    <Field
                      label="Repo Path"
                      required
                      path={`repos[${i}].repoPath`}
                      error={fieldErrors[`repos[${i}].repoPath`]}
                      hint="Absolute path to the git repository"
                    >
                      <input
                        className={`${styles.input} ${styles.inputMono} ${fieldErrors[`repos[${i}].repoPath`] ? styles.inputError : ""}`}
                        type="text"
                        value={repo.repoPath}
                        onChange={(e) => setRepoField(i, "repoPath", e.target.value)}
                      />
                    </Field>
                    <Field
                      label="Default Branch"
                      required
                      path={`repos[${i}].defaultBranch`}
                      error={fieldErrors[`repos[${i}].defaultBranch`]}
                    >
                      <input
                        className={inputClass(fieldErrors[`repos[${i}].defaultBranch`])}
                        type="text"
                        value={repo.defaultBranch}
                        onChange={(e) => setRepoField(i, "defaultBranch", e.target.value)}
                      />
                    </Field>
                  </div>

                  {/* Services */}
                  <div className={styles.servicesSection}>
                    <div className={styles.servicesSectionLabel}>Services</div>
                    {repo.services.map((svc, j) => {
                      const sp = `repos[${i}].services[${j}]`
                      const tsExpanded = expandedTailscale.has(svc.id)
                      return (
                        <div key={svc.id} className={styles.serviceCard}>
                          <div className={styles.serviceHeader}>
                            {newIds.has(svc.id) ? (
                              <Field
                                label="Service ID"
                                required
                                path={`${sp}.id`}
                                error={fieldErrors[`${sp}.id`]}
                                hint="Slug: globally unique"
                              >
                                <input
                                  className={inputClass(fieldErrors[`${sp}.id`])}
                                  type="text"
                                  placeholder="my-service"
                                  value={svc.id}
                                  onChange={(e) => setServiceId(i, j, e.target.value)}
                                />
                              </Field>
                            ) : (
                              <span className={styles.serviceIdPill}>{svc.id}</span>
                            )}
                            <span className={styles.serviceLabel}>Service</span>
                            <button
                              type="button"
                              className={styles.removeBtn}
                              onClick={() => removeService(i, j)}
                              title="Remove this service"
                            >
                              <Trash2 aria-hidden size={14} strokeWidth={2} />
                              Remove
                            </button>
                          </div>

                          {/* Identity group */}
                          <div className={styles.fieldGroup}>
                            <div className={styles.fieldGroupLabel}>Identity</div>
                            <div className={styles.fieldsRow}>
                              <Field
                                label="Display Name"
                                required
                                path={`${sp}.displayName`}
                                error={fieldErrors[`${sp}.displayName`]}
                              >
                                <input
                                  className={inputClass(fieldErrors[`${sp}.displayName`])}
                                  type="text"
                                  value={svc.displayName}
                                  onChange={(e) => setServiceField(i, j, "displayName", e.target.value)}
                                />
                              </Field>
                              <Field
                                label="Tags"
                                path={`${sp}.tags`}
                                error={fieldErrors[`${sp}.tags`]}
                                hint="Comma-separated (e.g. api, frontend)"
                              >
                                <input
                                  className={inputClass(fieldErrors[`${sp}.tags`])}
                                  type="text"
                                  value={joinLines(svc.tags)}
                                  onChange={(e) => setServiceField(i, j, "tags", parseLines(e.target.value))}
                                />
                              </Field>
                            </div>
                          </div>

                          {/* Process group */}
                          <div className={styles.fieldGroup}>
                            <div className={styles.fieldGroupLabel}>Process</div>
                            <div className={styles.fieldsRow3}>
                              <Field
                                label="Package Manager"
                                path={`${sp}.packageManager`}
                                error={fieldErrors[`${sp}.packageManager`]}
                              >
                                <select
                                  className={styles.select}
                                  value={svc.packageManager}
                                  onChange={(e) =>
                                    setServiceField(i, j, "packageManager", e.target.value as EditableServiceConfig["packageManager"])
                                  }
                                >
                                  {["auto", "bun", "npm", "yarn", "pnpm"].map((pm) => (
                                    <option key={pm} value={pm}>{pm}</option>
                                  ))}
                                </select>
                              </Field>
                              <Field
                                label="Script Name"
                                required
                                path={`${sp}.scriptName`}
                                error={fieldErrors[`${sp}.scriptName`]}
                                hint="package.json script key"
                              >
                                <input
                                  className={inputClass(fieldErrors[`${sp}.scriptName`])}
                                  type="text"
                                  value={svc.scriptName}
                                  onChange={(e) => setServiceField(i, j, "scriptName", e.target.value)}
                                />
                              </Field>
                              <Field
                                label="Install Command"
                                path={`${sp}.installCommand`}
                                error={fieldErrors[`${sp}.installCommand`]}
                                hint="Override default (optional)"
                              >
                                <input
                                  className={`${styles.input} ${styles.inputMono} ${fieldErrors[`${sp}.installCommand`] ? styles.inputError : ""}`}
                                  type="text"
                                  placeholder="e.g. bun install"
                                  value={svc.installCommand ?? ""}
                                  onChange={(e) => setServiceField(i, j, "installCommand", e.target.value || null)}
                                />
                              </Field>
                            </div>
                          </div>

                          {/* Network group */}
                          <div className={styles.fieldGroup}>
                            <div className={styles.fieldGroupLabel}>Network</div>
                            <div className={styles.fieldsRow3}>
                              <Field
                                label="Port"
                                required
                                path={`${sp}.port`}
                                error={fieldErrors[`${sp}.port`]}
                              >
                                <input
                                  className={inputClass(fieldErrors[`${sp}.port`])}
                                  type="number"
                                  min={1}
                                  max={65535}
                                  value={svc.port}
                                  onChange={(e) => setServiceField(i, j, "port", parseInt(e.target.value) || 0)}
                                />
                              </Field>
                              <Field
                                label="Health URL"
                                required
                                path={`${sp}.healthUrl`}
                                error={fieldErrors[`${sp}.healthUrl`]}
                              >
                                <input
                                  className={`${styles.input} ${styles.inputMono} ${fieldErrors[`${sp}.healthUrl`] ? styles.inputError : ""}`}
                                  type="text"
                                  placeholder="http://localhost:3000/health"
                                  value={svc.healthUrl}
                                  onChange={(e) => setServiceField(i, j, "healthUrl", e.target.value)}
                                />
                              </Field>
                              <Field
                                label="Health Mode"
                                path={`${sp}.healthMode`}
                                error={fieldErrors[`${sp}.healthMode`]}
                              >
                                <select
                                  className={styles.select}
                                  value={svc.healthMode}
                                  onChange={(e) =>
                                    setServiceField(i, j, "healthMode", e.target.value as "ping" | "full")
                                  }
                                >
                                  <option value="ping">ping (2xx)</option>
                                  <option value="full">full (JSON ok)</option>
                                </select>
                              </Field>
                            </div>
                            <Field
                              label="Allowed IPs"
                              path={`${sp}.allowedIps`}
                              error={fieldErrors[`${sp}.allowedIps`]}
                              hint="CIDR ranges, comma-separated. Empty = inherit global."
                            >
                              <textarea
                                className={`${styles.textarea} ${fieldErrors[`${sp}.allowedIps`] ? styles.inputError : ""}`}
                                rows={2}
                                placeholder="e.g. 203.0.113.0/24"
                                value={joinLines(svc.allowedIps)}
                                onChange={(e) => setServiceField(i, j, "allowedIps", parseLines(e.target.value))}
                              />
                            </Field>
                          </div>

                          {/* Tailscale accordion */}
                          <button
                            type="button"
                            className={styles.tailscaleToggle}
                            onClick={() => toggleTailscale(svc.id)}
                            aria-expanded={tsExpanded}
                          >
                            {tsExpanded ? (
                              <ChevronDown aria-hidden size={14} strokeWidth={2.5} />
                            ) : (
                              <ChevronRight aria-hidden size={14} strokeWidth={2.5} />
                            )}
                            Tailscale
                          </button>

                          {tsExpanded && (
                            <div className={styles.fieldGroup}>
                              <div className={styles.fieldsRow}>
                                <Field
                                  label="Tailnet Hostname"
                                  path={`${sp}.tailnetHostname`}
                                  error={fieldErrors[`${sp}.tailnetHostname`]}
                                  hint="Subdomain only (e.g. myapp)"
                                >
                                  <input
                                    className={`${styles.input} ${styles.inputMono} ${fieldErrors[`${sp}.tailnetHostname`] ? styles.inputError : ""}`}
                                    type="text"
                                    placeholder="myapp"
                                    value={svc.tailnetHostname ?? ""}
                                    onChange={(e) => setServiceField(i, j, "tailnetHostname", e.target.value || undefined)}
                                  />
                                </Field>
                                <Field
                                  label="Tailnet Domain"
                                  path={`${sp}.tailnetDomain`}
                                  error={fieldErrors[`${sp}.tailnetDomain`]}
                                  hint="e.g. bangus-city.ts.net"
                                >
                                  <input
                                    className={`${styles.input} ${styles.inputMono} ${fieldErrors[`${sp}.tailnetDomain`] ? styles.inputError : ""}`}
                                    type="text"
                                    placeholder="bangus-city.ts.net"
                                    value={svc.tailnetDomain ?? ""}
                                    onChange={(e) => setServiceField(i, j, "tailnetDomain", e.target.value || undefined)}
                                  />
                                </Field>
                              </div>
                              <div className={styles.fieldsRow3}>
                                <Field
                                  label="Serve Target"
                                  path={`${sp}.tailscaleServeTarget`}
                                  error={fieldErrors[`${sp}.tailscaleServeTarget`]}
                                  hint="Local URL to expose"
                                >
                                  <input
                                    className={`${styles.input} ${styles.inputMono} ${fieldErrors[`${sp}.tailscaleServeTarget`] ? styles.inputError : ""}`}
                                    type="text"
                                    placeholder="http://localhost:3000"
                                    value={svc.tailscaleServeTarget ?? ""}
                                    onChange={(e) => setServiceField(i, j, "tailscaleServeTarget", e.target.value || undefined)}
                                  />
                                </Field>
                                <Field
                                  label="Serve Mode"
                                  path={`${sp}.tailscaleServeMode`}
                                >
                                  <select
                                    className={styles.select}
                                    value={svc.tailscaleServeMode ?? "https"}
                                    onChange={(e) =>
                                      setServiceField(i, j, "tailscaleServeMode", e.target.value as "https")
                                    }
                                  >
                                    <option value="https">https</option>
                                  </select>
                                </Field>
                                <Field label="Serve Enabled" path={`${sp}.tailscaleServeEnabled`}>
                                  <label className={styles.checkboxLabel}>
                                    <input
                                      type="checkbox"
                                      checked={svc.tailscaleServeEnabled ?? false}
                                      onChange={(e) => setServiceField(i, j, "tailscaleServeEnabled", e.target.checked)}
                                    />
                                    Enable Tailscale Serve
                                  </label>
                                </Field>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                    <button
                      type="button"
                      className={styles.addBtn}
                      onClick={() => addService(i)}
                    >
                      <Plus aria-hidden size={14} strokeWidth={2.5} />
                      Add Service
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              className={styles.addBtn}
              onClick={addRepo}
            >
              <Plus aria-hidden size={14} strokeWidth={2.5} />
              Add Repo
            </button>
          </section>

          {/* Bottom action bar (mirrors top bar for long forms) */}
          <div className={styles.bottomActions}>
            <button className={styles.cancelBtn} type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className={styles.saveBtn}
              type="button"
              onClick={() => { void handleSave() }}
              disabled={isSaving || hasLocalErrors}
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}

      {/* ── API Token section (always at bottom when authenticated) ─────────── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>API Token</h2>
        <div className={styles.sectionCard}>
          <p className={styles.tokenNote}>
            The API token is set in <code>data/projects.json</code> under <code>server.token</code>.
            To test a different token, enter it below. Token rotation requires editing the config file directly.
          </p>
          <TokenForm
            token={tokenInput}
            onChange={setTokenInput}
            onSubmit={handleTokenSubmit}
            status={tokenStatus}
            message={tokenMessage}
            hasExisting={hasToken}
            onSignOut={handleSignOut}
          />
        </div>
      </section>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface FieldProps {
  label: string
  required?: boolean
  path: string
  error?: string
  hint?: string
  children: React.ReactNode
}

function Field({ label, required, path, error, hint, children }: FieldProps) {
  return (
    <div className={`${styles.field} ${error ? styles.fieldHasError : ""}`} data-field={path}>
      <label className={styles.fieldLabel}>
        {label}
        {required && <span className={styles.required} aria-label="required">*</span>}
      </label>
      {children}
      {hint && !error && <span className={styles.fieldHint}>{hint}</span>}
      <FieldError message={error} />
    </div>
  )
}

function inputClass(error?: string): string {
  return `${styles.input} ${error ? styles.inputError : ""}`
}

interface TokenFormProps {
  token: string
  onChange: (v: string) => void
  onSubmit: (e: React.FormEvent) => void
  status: "idle" | "checking" | "ok" | "error"
  message: string
  hasExisting: boolean
  onSignOut: () => void
}

function TokenForm({ token, onChange, onSubmit, status, message, hasExisting, onSignOut }: TokenFormProps) {
  return (
    <>
      <form onSubmit={onSubmit} className={styles.tokenForm}>
        <label className={styles.fieldLabel} htmlFor="sm-token">
          Token
        </label>
        <input
          id="sm-token"
          className={styles.input}
          type="password"
          placeholder="Enter token from projects.json"
          value={token}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="current-password"
        />
        <button
          className={styles.testBtn}
          type="submit"
          disabled={status === "checking" || !token.trim()}
        >
          {status === "checking" ? "Checking…" : "Save & test"}
        </button>
      </form>
      {message && (
        <p className={status === "ok" ? styles.successMsg : styles.errorMsg}>{message}</p>
      )}
      {hasExisting && (
        <button className={styles.signOutBtn} type="button" onClick={onSignOut}>
          Sign out
        </button>
      )}
    </>
  )
}

