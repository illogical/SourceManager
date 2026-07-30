import { readFileSync, writeFileSync, renameSync } from "fs"
import { CONFIG_PATH, invalidateCache } from "../config"
import type {
  EditableConfig,
  EditableServiceConfig,
  ValidationResult,
  ValidationFieldError,
  ConfigDiff,
  ConfigDiffEntry,
  ProjectsFileConfig,
} from "../types"
import { ValidationError } from "../types"

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  return JSON.stringify(a) === JSON.stringify(b)
}

function rawRead(configPath: string): ProjectsFileConfig {
  const raw = readFileSync(configPath, "utf-8")
  return JSON.parse(raw) as ProjectsFileConfig
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read the current config as an editable snapshot.
 * Reads JSON-owned fields from disk fresh (not from cache).
 * Pass configPath to override the default (useful in tests).
 */
export function readEditableConfig(configPath: string = CONFIG_PATH): EditableConfig {
  const raw = rawRead(configPath)
  return toEditableConfig(raw)
}

function toEditableConfig(config: ProjectsFileConfig): EditableConfig {
  return {
    server: {
      frontendPort: config.server.frontendPort ?? 5173,
      allowedIps: [...(config.server.allowedIps ?? [])],
    },
    repos: config.repos.map((repo) => ({
      id: repo.id,
      displayName: repo.displayName,
      repoPath: repo.repoPath,
      defaultBranch: repo.defaultBranch,
      services: repo.services.map((svc) => ({
        id: svc.id,
        displayName: svc.displayName,
        packageManager: svc.packageManager ?? "auto",
        scriptName: svc.scriptName ?? "dev",
        installCommand: svc.installCommand ?? null,
        port: svc.port,
        healthUrl: svc.healthUrl,
        healthMode: svc.healthMode ?? "ping",
        recoveryTimeoutSeconds: svc.recoveryTimeoutSeconds ?? 30,
        tags: [...(svc.tags ?? [])],
        allowedIps: [...(svc.allowedIps ?? [])],
        tailnetHostname: svc.tailnetHostname,
        tailnetDomain: svc.tailnetDomain,
        tailscaleServeEnabled: svc.tailscaleServeEnabled,
        tailscaleServeMode: svc.tailscaleServeMode,
        tailscaleServeTarget: svc.tailscaleServeTarget,
        tailnetExposureMode: svc.tailnetExposureMode,
        tailscaleServiceName: svc.tailscaleServiceName,
        tailscaleServiceEnabled: svc.tailscaleServiceEnabled,
        tailscaleServiceProtocol: svc.tailscaleServiceProtocol,
        tailscaleServicePort: svc.tailscaleServicePort,
        tailscaleServiceTarget: svc.tailscaleServiceTarget,
      })),
    })),
  }
}

/**
 * Validate a proposed editable config.
 * Returns { valid, errors[], warnings[] }.
 * Errors block apply; warnings are shown but do not block.
 */
export function validateEditableConfig(proposed: EditableConfig): ValidationResult {
  const errors: ValidationFieldError[] = []
  const warnings: ValidationFieldError[] = []

  function err(path: string, message: string) {
    errors.push({ path, message })
  }
  function warn(path: string, message: string) {
    warnings.push({ path, message })
  }

  // ── Server ──────────────────────────────────────────────────────────────────
  if (!Number.isInteger(proposed.server.frontendPort) || proposed.server.frontendPort < 1 || proposed.server.frontendPort > 65535) {
    err("server.frontendPort", "Frontend port must be an integer between 1 and 65535")
  }
  for (const cidr of proposed.server.allowedIps) {
    if (!isValidCidr(cidr)) {
      err("server.allowedIps", `Invalid CIDR: "${cidr}"`)
      break
    }
  }

  // ── Repos ───────────────────────────────────────────────────────────────────
  if (!Array.isArray(proposed.repos) || proposed.repos.length === 0) {
    err("repos", "At least one repo is required")
  }

  const repoIds = new Set<string>()
  const serviceIds = new Set<string>()

  for (let i = 0; i < (proposed.repos?.length ?? 0); i++) {
    const repo = proposed.repos[i]
    const rp = `repos[${i}]`

    if (!repo.id?.trim() || !SLUG_RE.test(repo.id)) {
      err(`${rp}.id`, "ID must be non-empty and contain only lowercase letters, digits, and hyphens")
    } else if (repoIds.has(repo.id)) {
      err(`${rp}.id`, `Repo id "${repo.id}" is duplicated`)
    } else {
      repoIds.add(repo.id)
    }

    if (!repo.displayName?.trim()) {
      err(`${rp}.displayName`, "Display name is required")
    }
    if (!repo.repoPath?.trim()) {
      err(`${rp}.repoPath`, "Repo path is required")
    } else if (repo.repoPath.startsWith("/") || repo.repoPath.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(repo.repoPath)) {
      err(`${rp}.repoPath`, "Repo path must be relative to the configured workspace")
    } else if (repo.repoPath.split(/[\\/]/).includes("..")) {
      err(`${rp}.repoPath`, "Repo path cannot escape the configured workspace")
    }
    if (!repo.defaultBranch?.trim()) {
      err(`${rp}.defaultBranch`, "Default branch is required")
    } else if (!BRANCH_RE.test(repo.defaultBranch)) {
      err(`${rp}.defaultBranch`, "Branch must only contain letters, digits, dots, hyphens, or slashes")
    }

    for (let j = 0; j < (repo.services?.length ?? 0); j++) {
      const svc = repo.services[j]
      const sp = `${rp}.services[${j}]`

      if (serviceIds.has(svc.id)) {
        err(`${sp}.id`, `Service id "${svc.id}" is duplicated across repos`)
      } else {
        serviceIds.add(svc.id)
      }

      if (!svc.displayName?.trim()) {
        err(`${sp}.displayName`, "Display name is required")
      }
      if (!Number.isInteger(svc.port) || svc.port < 1 || svc.port > 65535) {
        err(`${sp}.port`, "Port must be an integer between 1 and 65535")
      }
      if (!svc.healthUrl?.trim() || !isValidUrl(svc.healthUrl)) {
        err(`${sp}.healthUrl`, "Must be a valid http:// or https:// URL")
      }
      if (
        !Number.isInteger(svc.recoveryTimeoutSeconds ?? 30)
        || (svc.recoveryTimeoutSeconds ?? 30) < 1
        || (svc.recoveryTimeoutSeconds ?? 30) > 600
      ) {
        err(`${sp}.recoveryTimeoutSeconds`, "Recovery timeout must be an integer between 1 and 600 seconds")
      }
      if (!svc.scriptName?.trim()) {
        err(`${sp}.scriptName`, "Script name is required")
      } else if (!SCRIPT_RE.test(svc.scriptName)) {
        err(`${sp}.scriptName`, "Only letters, digits, colons, hyphens, and underscores are allowed")
      }
      if (svc.installCommand !== null && svc.installCommand !== undefined && svc.installCommand !== "") {
        if (SHELL_META_RE.test(svc.installCommand)) {
          err(`${sp}.installCommand`, "Install command cannot contain shell metacharacters (; & | > < ` $ ( ) { } \\)")
        }
      }
      for (const tag of svc.tags ?? []) {
        if (!tag.trim()) {
          err(`${sp}.tags`, "Tags must be non-empty strings")
          break
        }
      }
      for (const cidr of svc.allowedIps ?? []) {
        if (!isValidCidr(cidr)) {
          err(`${sp}.allowedIps`, `Invalid CIDR: "${cidr}"`)
          break
        }
      }

      // Tailscale fields
      if (svc.tailnetHostname !== undefined && svc.tailnetHostname !== "") {
        if (!SUBDOMAIN_RE.test(svc.tailnetHostname)) {
          err(`${sp}.tailnetHostname`, "Hostname must be a simple subdomain (lowercase letters, digits, hyphens only)")
        }
      }
      if (svc.tailscaleServeMode !== undefined && svc.tailscaleServeMode !== "https") {
        err(`${sp}.tailscaleServeMode`, 'Only "https" is supported')
      }
      if (svc.tailscaleServeTarget !== undefined && svc.tailscaleServeTarget !== "") {
        if (!isValidUrl(svc.tailscaleServeTarget)) {
          err(`${sp}.tailscaleServeTarget`, "Must be a valid http:// or https:// URL")
        }
      }
      if (svc.tailscaleServeEnabled === true && !svc.tailnetHostname) {
        warn(`${sp}.tailscaleServeEnabled`, "tailscaleServeEnabled is true but tailnetHostname is not set — serve will have no effect")
      }
      if (svc.tailnetExposureMode !== undefined && svc.tailnetExposureMode !== "tailscale-service") {
        err(`${sp}.tailnetExposureMode`, 'Only "tailscale-service" is supported')
      }
      if (svc.tailscaleServiceName && !SUBDOMAIN_RE.test(svc.tailscaleServiceName)) {
        err(`${sp}.tailscaleServiceName`, "Service name must contain lowercase letters, digits, and hyphens only")
      }
      if (svc.tailscaleServiceProtocol !== undefined && svc.tailscaleServiceProtocol !== "https") {
        err(`${sp}.tailscaleServiceProtocol`, 'Only "https" is supported')
      }
      if (svc.tailscaleServicePort !== undefined && (
        !Number.isInteger(svc.tailscaleServicePort)
        || svc.tailscaleServicePort < 1
        || svc.tailscaleServicePort > 65535
      )) {
        err(`${sp}.tailscaleServicePort`, "HTTPS port must be an integer between 1 and 65535")
      }
      if (svc.tailscaleServiceTarget && !isValidUrl(svc.tailscaleServiceTarget)) {
        err(`${sp}.tailscaleServiceTarget`, "Must be a valid http:// or https:// URL")
      }
      if (svc.tailscaleServiceEnabled === true) {
        if (svc.tailnetExposureMode !== "tailscale-service") {
          err(`${sp}.tailnetExposureMode`, 'Enabled named Service requires "tailscale-service" mode')
        }
        if (!svc.tailscaleServiceName) {
          err(`${sp}.tailscaleServiceName`, "Enabled named Service requires a service name")
        }
        if (!svc.tailscaleServiceTarget) {
          err(`${sp}.tailscaleServiceTarget`, "Enabled named Service requires a local target")
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/**
 * Compute a field-level diff between two editable configs.
 * Only covers JSON-owned editable fields (excluding IDs).
 */
export function diffEditableConfig(current: EditableConfig, proposed: EditableConfig): ConfigDiff {
  const changes: ConfigDiffEntry[] = []

  function check(path: string, a: unknown, b: unknown) {
    if (!deepEqual(a, b)) changes.push({ path, oldValue: a, newValue: b })
  }

  // Server (editable fields only)
  check("server.frontendPort", current.server.frontendPort, proposed.server.frontendPort)
  check("server.allowedIps", current.server.allowedIps, proposed.server.allowedIps)

  // Repos
  const repoCount = Math.min(current.repos.length, proposed.repos.length)
  for (let i = 0; i < repoCount; i++) {
    const cr = current.repos[i]
    const pr = proposed.repos[i]
    const rp = `repos[${i}]`

    check(`${rp}.displayName`, cr.displayName, pr.displayName)
    check(`${rp}.repoPath`, cr.repoPath, pr.repoPath)
    check(`${rp}.defaultBranch`, cr.defaultBranch, pr.defaultBranch)

    const svcCount = Math.min(cr.services.length, pr.services.length)
    for (let j = 0; j < svcCount; j++) {
      const cs = cr.services[j]
      const ps = pr.services[j]
      const sp = `${rp}.services[${j}]`

      const editableFields: (keyof EditableServiceConfig)[] = [
        "displayName", "packageManager", "scriptName", "installCommand",
        "port", "healthUrl", "healthMode", "recoveryTimeoutSeconds", "tags", "allowedIps",
        "tailnetHostname", "tailnetDomain", "tailscaleServeEnabled",
        "tailscaleServeMode", "tailscaleServeTarget",
        "tailnetExposureMode", "tailscaleServiceName", "tailscaleServiceEnabled",
        "tailscaleServiceProtocol", "tailscaleServicePort", "tailscaleServiceTarget",
      ]
      for (const field of editableFields) {
        check(`${sp}.${field}`, cs[field], ps[field])
      }
    }
  }

  return { changes, changeCount: changes.length }
}

/**
 * Validate and atomically write the proposed config.
 * - Preserves IDs from the current disk file.
 * - Drops legacy environment-owned server.port and server.token fields.
 * - New repos/services (IDs not on disk) are appended; removed entries are dropped.
 * - Writes to a temp file then renames (atomic on POSIX; best-effort on Windows).
 * - Invalidates the in-memory config cache.
 * Pass configPath to override the default (useful in tests).
 */

function mergeService(
  existing: import("../types").ServiceConfig | undefined,
  proposed: EditableServiceConfig,
): import("../types").ServiceConfig {
  return {
    ...(existing ?? {}),           // preserves any extra fields from disk (svc.id included if existing)
    id: existing?.id ?? proposed.id, // use disk id if exists, else proposed
    displayName: proposed.displayName,
    packageManager: proposed.packageManager,
    scriptName: proposed.scriptName,
    installCommand: proposed.installCommand ?? undefined,
    port: proposed.port,
    healthUrl: proposed.healthUrl,
    healthMode: proposed.healthMode,
    recoveryTimeoutSeconds: proposed.recoveryTimeoutSeconds ?? 30,
    tags: proposed.tags,
    allowedIps: proposed.allowedIps,
    tailnetHostname: proposed.tailnetHostname || undefined,
    tailnetDomain: proposed.tailnetDomain || undefined,
    tailscaleServeEnabled: proposed.tailscaleServeEnabled,
    tailscaleServeMode: proposed.tailscaleServeMode,
    tailscaleServeTarget: proposed.tailscaleServeTarget || undefined,
    tailnetExposureMode: proposed.tailnetExposureMode,
    tailscaleServiceName: proposed.tailscaleServiceName || undefined,
    tailscaleServiceEnabled: proposed.tailscaleServiceEnabled,
    tailscaleServiceProtocol: proposed.tailscaleServiceProtocol,
    tailscaleServicePort: proposed.tailscaleServicePort,
    tailscaleServiceTarget: proposed.tailscaleServiceTarget || undefined,
  }
}

export async function applyEditableConfig(
  proposed: EditableConfig,
  configPath: string = CONFIG_PATH,
  _invalidate: () => void = invalidateCache,
): Promise<void> {
  // 1. Validate
  const validation = validateEditableConfig(proposed)
  if (!validation.valid) {
    throw new ValidationError(validation)
  }

  // 2. Read current raw config to get immutable IDs
  const current = rawRead(configPath)

  // Build lookup maps for ID-based merge
  const currentRepoMap = new Map(current.repos.map((r) => [r.id, r]))

  // 3. Merge: proposed values over current using ID-based lookup.
  //    - Existing repos/services: update editable fields and preserve IDs from disk.
  //    - New repos/services (ID not found on disk): append verbatim.
  //    - Repos/services absent from proposal: removed.
  const merged: ProjectsFileConfig = {
    server: {
      frontendPort: proposed.server.frontendPort,
      allowedIps: proposed.server.allowedIps,
    },
    repos: proposed.repos.map((proposedRepo) => {
      const existingRepo = currentRepoMap.get(proposedRepo.id)
      if (!existingRepo) {
        // New repo: use proposed data directly
        return {
          id: proposedRepo.id,
          displayName: proposedRepo.displayName,
          repoPath: proposedRepo.repoPath,
          defaultBranch: proposedRepo.defaultBranch,
          services: proposedRepo.services.map((proposedSvc) => mergeService(undefined, proposedSvc)),
        }
      }
      const currentSvcMap = new Map(existingRepo.services.map((s) => [s.id, s]))
      return {
        ...existingRepo,            // preserves repo.id
        displayName: proposedRepo.displayName,
        repoPath: proposedRepo.repoPath,
        defaultBranch: proposedRepo.defaultBranch,
        services: proposedRepo.services.map((proposedSvc) =>
          mergeService(currentSvcMap.get(proposedSvc.id), proposedSvc)
        ),
      }
    }),
  }

  // 4. Serialize
  const json = JSON.stringify(merged, null, 2)

  // 5. Write to temp file
  const tmpPath = configPath + ".tmp"
  writeFileSync(tmpPath, json, "utf-8")

  // 6. Rename (atomic on POSIX; best-effort on Windows)
  renameSync(tmpPath, configPath)

  // 7. Invalidate in-memory cache
  _invalidate()
}

/**
 * Persist only the desired named-Service state without replacing unrelated
 * configuration fields. All work is synchronous so another in-process config
 * write cannot interleave between read and atomic rename.
 */
export function setTailscaleServiceEnabled(
  serviceId: string,
  enabled: boolean,
  configPath: string = CONFIG_PATH,
  _invalidate: () => void = invalidateCache,
): void {
  const current = rawRead(configPath)
  let found = false
  for (const repo of current.repos) {
    const service = repo.services.find((candidate) => candidate.id === serviceId)
    if (!service) continue
    service.tailscaleServiceEnabled = enabled
    found = true
    break
  }
  if (!found) {
    throw new Error(`Service "${serviceId}" not found while updating Tailscale state`)
  }

  const tmpPath = configPath + ".tmp"
  writeFileSync(tmpPath, JSON.stringify(current, null, 2), "utf-8")
  renameSync(tmpPath, configPath)
  _invalidate()
}
