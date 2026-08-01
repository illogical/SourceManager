import type { Router } from "express"
import type { Server } from "node:http"
import type { BuildManifest } from "../types"

export interface HostLogger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export interface RealtimeRegistrar {
  registerWebSocket(path: string, handler: (request: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void): () => void
  reserveSocketIo(path: string): () => void
}

export interface HostedApplicationContext {
  projectId: string
  repoRoot: string
  webBasePath?: string
  apiBasePath?: string
  realtimeBasePath?: string
  hostOrigin: string
  environment: "development" | "production"
  log: HostLogger
  realtime: RealtimeRegistrar
}

export interface HostedModuleStatus {
  state: "ready" | "degraded" | "unavailable"
  message?: string
  activeWork?: { kind: string; count: number; restartPolicy: "block" | "cancel" | "resume" }
  details?: Record<string, unknown>
}

export interface HostedApplication {
  contractVersion: 1
  router?: Router
  static?: { directory: string; spaFallback: boolean }
  initialize?(): Promise<void>
  attachRealtime?(server: Server): Promise<(() => Promise<void> | void) | void>
  status(): Promise<HostedModuleStatus>
  dispose?(): Promise<void>
}

export type HostedApplicationFactory = (context: HostedApplicationContext) => HostedApplication | Promise<HostedApplication>

export interface VerifiedHostedModule {
  factory: HostedApplicationFactory
  manifest: BuildManifest
}

export function assertHostedApplication(value: unknown): asserts value is HostedApplication {
  if (!value || typeof value !== "object") throw new Error("factory did not return an object")
  const app = value as Partial<HostedApplication>
  if (app.contractVersion !== 1) throw new Error(`unsupported contract version: ${String(app.contractVersion)}`)
  if (typeof app.status !== "function") throw new Error("hosted application must implement status()")
  if (app.initialize !== undefined && typeof app.initialize !== "function") throw new Error("initialize must be a function")
  if (app.attachRealtime !== undefined && typeof app.attachRealtime !== "function") throw new Error("attachRealtime must be a function")
  if (app.dispose !== undefined && typeof app.dispose !== "function") throw new Error("dispose must be a function")
}
