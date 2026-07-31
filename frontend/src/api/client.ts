import type {
  ReposResponse,
  GlobalStatusRefreshResponse,
  ServiceStatusRefreshResponse,
  UpdateRequest,
  EditableConfig,
  ConfigResponse,
  ConfigValidateResponse,
  ConfigApplyResponse,
  TailscaleStatusResponse,
  HealthResponse,
} from "./types"

const TOKEN_KEY = "sm:token"

// ── Error types ────────────────────────────────────────────────────────────────

export class AuthError extends Error {
  constructor(message = "Missing or invalid API token") {
    super(message)
    this.name = "AuthError"
  }
}

export class ApiError extends Error {
  public readonly detail: string

  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    const detail = stringifyApiBody(body)
    super(detail ? `API error ${status}: ${detail}` : `API error ${status}`)
    this.name = "ApiError"
    this.detail = detail
  }
}

function stringifyApiBody(body: unknown): string {
  if (body == null) return ""
  if (typeof body === "string") return body
  if (typeof body === "object") {
    const record = body as Record<string, unknown>
    const diagnostics = record.diagnostics as Record<string, unknown> | null | undefined
    const parts = [record.error, record.message, record.code, diagnostics?.code]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    if (parts.length > 0) return parts.join(" - ")
    try {
      return JSON.stringify(body)
    } catch {
      return String(body)
    }
  }
  return String(body)
}

// ── Token helpers ──────────────────────────────────────────────────────────────

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

// ── Core fetch wrapper ─────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  if (!token) throw new AuthError()

  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-DevServer-Token": token,
      ...(options.headers as Record<string, string> | undefined),
    },
  })

  if (res.status === 401) throw new AuthError("Invalid API token — check Settings")

  if (!res.ok) {
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = await res.text()
    }
    console.error("[SourceManager API] request failed", {
      path,
      method: options.method ?? "GET",
      status: res.status,
      body,
    })
    throw new ApiError(res.status, body)
  }

  return res.json() as Promise<T>
}

// ── Endpoints ──────────────────────────────────────────────────────────────────

export function listRepos(): Promise<ReposResponse> {
  return apiFetch<ReposResponse>("/v1/repos")
}

export function startService(repoId: string, serviceId: string): Promise<unknown> {
  return apiFetch(`/v1/repos/${repoId}/services/${serviceId}/start`, { method: "POST" })
}

export interface StopServiceResponse {
  success: boolean
  shutdownAccepted?: boolean
}

export function refreshAllStatus(): Promise<GlobalStatusRefreshResponse> {
  return apiFetch<GlobalStatusRefreshResponse>("/v1/status/refresh", { method: "POST" })
}

export function refreshServiceStatus(repoId: string, serviceId: string): Promise<ServiceStatusRefreshResponse> {
  return apiFetch<ServiceStatusRefreshResponse>(
    `/v1/repos/${repoId}/services/${serviceId}/status/refresh`,
    { method: "POST" },
  )
}

export function stopService(repoId: string, serviceId: string): Promise<StopServiceResponse> {
  return apiFetch<StopServiceResponse>(`/v1/repos/${repoId}/services/${serviceId}/stop`, { method: "POST" })
}

export function getTailscaleStatus(): Promise<TailscaleStatusResponse> {
  return apiFetch<TailscaleStatusResponse>("/v1/tailscale/status")
}

export function enableTailscaleService(serviceId: string): Promise<unknown> {
  return apiFetch(`/v1/tailscale/services/${serviceId}/service/enable`, { method: "POST" })
}

export function disableTailscaleService(serviceId: string): Promise<unknown> {
  return apiFetch(`/v1/tailscale/services/${serviceId}/service/disable`, { method: "POST" })
}

export function restartService(repoId: string, serviceId: string): Promise<unknown> {
  return apiFetch(`/v1/repos/${repoId}/services/${serviceId}/restart`, { method: "POST" })
}

export function updateService(
  repoId: string,
  serviceId: string,
  body: UpdateRequest = {},
): Promise<unknown> {
  return apiFetch(`/v1/repos/${repoId}/services/${serviceId}/update`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function testConnection(): Promise<{ status: string }> {
  return apiFetch<{ status: string }>("/health")
}

export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch("/health")
  if (!response.ok) throw new ApiError(response.status, await response.text())
  return response.json() as Promise<HealthResponse>
}

// ── Config edit ────────────────────────────────────────────────────────────────

export function getEditableConfig(): Promise<ConfigResponse> {
  return apiFetch<ConfigResponse>("/v1/config")
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
