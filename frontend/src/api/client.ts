import type { ReposResponse, UpdateRequest } from "./types"

const TOKEN_KEY = "sm:token"

// ── Error types ────────────────────────────────────────────────────────────────

export class AuthError extends Error {
  constructor(message = "Missing or invalid API token") {
    super(message)
    this.name = "AuthError"
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API error ${status}`)
    this.name = "ApiError"
  }
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

export function stopService(repoId: string, serviceId: string): Promise<unknown> {
  return apiFetch(`/v1/repos/${repoId}/services/${serviceId}/stop`, { method: "POST" })
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
