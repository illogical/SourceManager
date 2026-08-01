import type { ConfigResponse, GlobalTailscaleStatus, ProjectsResponse } from "./types"

const TOKEN_KEY = "sm:token"
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || "/api/SourceManager"

export class AuthError extends Error {}
export class ApiError extends Error {
  constructor(readonly status: number, readonly body: unknown) { super(`API error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`) }
}

export function getToken(): string { return localStorage.getItem(TOKEN_KEY) ?? "" }
export function setToken(token: string): void { token.trim() ? localStorage.setItem(TOKEN_KEY, token.trim()) : localStorage.removeItem(TOKEN_KEY) }
export function clearToken(): void { localStorage.removeItem(TOKEN_KEY) }

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", "X-DevServer-Token": getToken(), ...init.headers } })
  const body = await response.json().catch(() => null)
  if (response.status === 401) throw new AuthError("Missing or invalid API token")
  if (!response.ok) throw new ApiError(response.status, body)
  return body as T
}

export const fetchProjects = () => apiFetch<ProjectsResponse>("/projects")
export const fetchTailscaleStatus = () => apiFetch<GlobalTailscaleStatus>("/tailnet")
export const setTailscaleEnabled = (enabled: boolean) => apiFetch<GlobalTailscaleStatus>(`/tailnet/${enabled ? "enable" : "disable"}`, { method: "POST" })
export const fetchConfig = () => apiFetch<ConfigResponse>("/config")
export const validateConfig = (config: unknown) => apiFetch<{ validation: { valid: boolean; errors: Array<{ message: string }> }; diff: { changeCount: number } }>("/config/validate", { method: "POST", body: JSON.stringify(config) })
export const applyConfig = (config: unknown) => apiFetch<{ success: boolean; changeCount: number; restartRequired: boolean }>("/config", { method: "PUT", body: JSON.stringify(config) })
export const testConnection = () => fetchProjects()
