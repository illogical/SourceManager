import type { Server } from "node:http"
import type { Express } from "express"
import type { AppConfig, ProjectConfig, ProjectRuntimeStatus } from "../types"
import type { HostedApplication } from "./contract"
import { loadHostedProject } from "./loader"
import { RealtimeDispatcher } from "./realtime"
import { initialStatus, sanitizeError } from "./status"
import { projectsByApiMountOrder } from "./routes"

interface LoadedProject {
  config: ProjectConfig
  application?: HostedApplication
  disposeRealtime?: () => Promise<void> | void
  status: ProjectRuntimeStatus
}

export class HostedProjectRegistry {
  private readonly projects = new Map<string, LoadedProject>()
  readonly realtime = new RealtimeDispatcher()

  constructor(private readonly config: AppConfig) {
    for (const project of config.projects) this.projects.set(project.id, { config: project, status: initialStatus(project) })
  }

  async loadAll(app: Express, server: Server): Promise<void> {
    this.realtime.attach(server)
    const ordered = [
      ...projectsByApiMountOrder(this.config.projects),
      ...this.config.projects.filter((project) => !project.api),
    ]
    for (const project of ordered) {
      const record = this.projects.get(project.id)!
      if (!project.enabled) continue
      record.status.hostState = "loading"
      const result = await loadHostedProject(this.config, project, app, server, this.realtime)
      Object.assign(record, result)
    }
  }

  async refreshStatuses(): Promise<ProjectRuntimeStatus[]> {
    for (const record of this.projects.values()) {
      if (!record.application) continue
      try {
        record.status.moduleStatus = await record.application.status()
        record.status.hostState = record.status.moduleStatus.state
      } catch (error) {
        record.status.hostState = "degraded"
        record.status.lastError = sanitizeError(error)
      }
    }
    return [...this.projects.values()].map((record) => structuredClone(record.status))
  }

  async restartBlockers(): Promise<Array<{ projectId: string; kind: string; count: number }>> {
    const statuses = await this.refreshStatuses()
    return statuses.flatMap((status) => {
      const active = status.moduleStatus?.activeWork
      return active && active.count > 0 && active.restartPolicy === "block"
        ? [{ projectId: status.id, kind: active.kind, count: active.count }]
        : []
    })
  }

  async dispose(): Promise<void> {
    const records = [...this.projects.values()].reverse()
    for (const record of records) {
      try { await record.disposeRealtime?.() } catch (error) { console.error(`[${record.config.id}] realtime disposal failed`, error) }
      try { await record.application?.dispose?.() } catch (error) { console.error(`[${record.config.id}] disposal failed`, error) }
    }
    this.realtime.dispose()
  }
}
