import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import type { Server } from "node:http"
import type { Express } from "express"
import type { AppConfig, BuildManifest, ProjectConfig, ProjectRuntimeStatus } from "../types"
import { gitCheckoutStatus } from "../services/git"
import { assertHostedApplication, type HostedApplication, type HostedApplicationFactory, type RealtimeRegistrar } from "./contract"
import { createHostLogger } from "./logger"
import { resolveExistingContainedPath } from "./paths"
import { mountBoundedStatic } from "./static"
import { initialStatus, sanitizeError } from "./status"

export interface LoadResult {
  application?: HostedApplication
  disposeRealtime?: () => Promise<void> | void
  status: ProjectRuntimeStatus
}

export async function loadHostedProject(config: AppConfig, project: ProjectConfig, expressApp: Express, server: Server, realtime: RealtimeRegistrar): Promise<LoadResult> {
  const status = initialStatus(project)
  let repoRoot = ""
  let application: HostedApplication | undefined
  let disposeRealtime: (() => Promise<void> | void) | undefined
  const unavailable = (_request: unknown, response: { status(code: number): { json(value: unknown): void } }) => response.status(503).json({ error: `${project.displayName} is unavailable`, projectId: project.id })
  try {
    repoRoot = await resolveExistingContainedPath(config.workspacePath, project.repoPath, "directory", `${project.id} repoPath`)
    const modulePath = await resolveExistingContainedPath(repoRoot, project.host.module, "file", `${project.id} host.module`)
    const manifestPath = await resolveExistingContainedPath(repoRoot, "dist/host/build-manifest.json", "file", `${project.id} build manifest`)
    const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")), project)
    const checkout = await gitCheckoutStatus(repoRoot)
    status.checkedOutCommit = checkout.commit
    status.branch = checkout.branch
    status.workingTree = checkout.workingTree
    status.loadedCommit = manifest.commit
    status.buildState = manifest.commit === checkout.commit ? "current" : "stale"
    const imported = await import(pathToFileURL(modulePath).href)
    const exportName = project.host.exportName ?? "createHostedApplication"
    const factory = imported[exportName] as HostedApplicationFactory | undefined
    if (typeof factory !== "function") throw new Error(`adapter does not export ${exportName}()`)
    application = await factory({
      projectId: project.id,
      repoRoot,
      webBasePath: project.web?.mountPath,
      apiBasePath: project.api?.mountPath,
      realtimeBasePath: project.realtime?.mountPath,
      hostOrigin: `http://127.0.0.1:${config.server.port}`,
      environment: process.env.NODE_ENV === "production" ? "production" : "development",
      log: createHostLogger(project.id),
      realtime,
    })
    assertHostedApplication(application)
    await application.initialize?.()
    if (project.api && !application.router) throw new Error("configuration declares an API mount but the adapter returned no router")
    if (project.api) expressApp.use(project.api.mountPath, application.router!)
    if (project.realtime && !application.attachRealtime) throw new Error("configuration declares realtime ownership but the adapter returned no attachRealtime()")
    if (project.realtime) disposeRealtime = await application.attachRealtime!(server) ?? undefined
    if (project.web) {
      const staticDirectory = application.static?.directory
        ? await resolveExistingContainedPath(repoRoot, application.static.directory, "directory", `${project.id} static directory`)
        : await resolveExistingContainedPath(repoRoot, project.web.distPath, "directory", `${project.id} web.distPath`)
      await mountBoundedStatic(expressApp, project.web.mountPath, staticDirectory, application.static?.spaFallback ?? project.web.spaFallback, unavailable)
    }
    status.moduleStatus = await application.status()
    status.hostState = status.moduleStatus.state
    status.lastLoadedAt = new Date().toISOString()
    return { application, disposeRealtime, status }
  } catch (error) {
    try { await disposeRealtime?.() } catch { /* retain the original load error */ }
    try { await application?.dispose?.() } catch { /* retain the original load error */ }
    status.hostState = "unavailable"
    status.lastError = sanitizeError(error)
    if (status.buildState === "missing" && /manifest.*(invalid|unsupported|projectId)/i.test(status.lastError)) status.buildState = "invalid"
    if (project.api) expressApp.use(project.api.mountPath, unavailable as never)
    if (project.web) expressApp.use(project.web.mountPath, unavailable as never)
    return { status }
  }
}

export function validateManifest(value: unknown, project: ProjectConfig): BuildManifest {
  const manifest = value as Partial<BuildManifest>
  if (manifest.contractVersion !== project.host.contractVersion) throw new Error("build manifest has an unsupported contractVersion")
  if (manifest.projectId !== project.id) throw new Error(`build manifest projectId ${String(manifest.projectId)} does not match ${project.id}`)
  if (typeof manifest.commit !== "string" || !/^[0-9a-f]{40}$/i.test(manifest.commit)) throw new Error("build manifest commit is invalid")
  if (typeof manifest.builtAt !== "string" || Number.isNaN(Date.parse(manifest.builtAt))) throw new Error("build manifest builtAt is invalid")
  if (manifest.nodeMajor !== 24) throw new Error(`adapter was built for Node ${String(manifest.nodeMajor)}; expected Node 24`)
  return manifest as BuildManifest
}
