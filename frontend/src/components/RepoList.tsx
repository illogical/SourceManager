import { useState, useEffect, useCallback } from "react"
import type { CSSProperties } from "react"
import { Activity, RefreshCw, Server, ShieldAlert, TimerReset } from "lucide-react"
import * as client from "../api/client"
import type { LifecycleState, RepoSummary, StartupReconciliationStatus, TailscaleStatusResponse } from "../api/types"
import ServiceCard from "./ServiceCard"
import styles from "./RepoList.module.css"

const GROUP_ACCENTS = ["#2dd4bf", "#60a5fa", "#a78bfa", "#f59e0b", "#fb7185", "#34d399"]
const STATE_LABELS: Record<LifecycleState, string> = {
  running: "Running",
  starting: "Starting",
  recovering: "Recovering",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
}

export default function RepoList() {
  const [repos, setRepos] = useState<RepoSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshingServices, setRefreshingServices] = useState<Set<string>>(() => new Set())
  const [refreshFeedback, setRefreshFeedback] = useState<{ message: string; error: boolean } | null>(null)
  const [tailscaleStatus, setTailscaleStatus] = useState<TailscaleStatusResponse | null>(null)
  const [startup, setStartup] = useState<StartupReconciliationStatus | null>(null)
  const [applicationState, setApplicationState] = useState<"running" | "shutting_down">("running")

  const fetchRepos = useCallback(async () => {
    try {
      const data = await client.listRepos()
      setRepos(data.repos)
      setError(null)
    } catch (err) {
      if (err instanceof client.AuthError) {
        setError("Token missing or invalid — open Settings to update your API token")
      } else if (err instanceof client.ApiError) {
        setError(`API error ${err.status} — check the backend`)
      } else {
        setError("Cannot reach SourceManager API — is the backend running?")
      }
    }
  }, [])

  const fetchTailscale = useCallback(async () => {
    try {
      setTailscaleStatus(await client.getTailscaleStatus())
    } catch {
      setTailscaleStatus(null)
    }
  }, [])

  const fetchStartup = useCallback(async () => {
    try {
      const health = await client.getHealth()
      setStartup(health.startupReconciliation)
      setApplicationState(health.applicationState)
    } catch {
      // The main API error state is handled by fetchRepos.
    }
  }, [])

  useEffect(() => {
    void fetchRepos()
    void fetchTailscale()
    const interval = setInterval(() => {
      void fetchRepos()
      void fetchTailscale()
    }, 10_000)
    return () => clearInterval(interval)
  }, [fetchRepos, fetchTailscale])

  useEffect(() => {
    void fetchStartup()
    const interval = setInterval(() => {
      void fetchStartup()
    }, startup?.state === "running" ? 500 : 1_000)
    return () => clearInterval(interval)
  }, [fetchStartup, startup?.state])

  // ── Action handlers ────────────────────────────────────────────────────────

  async function handleStart(repoId: string, serviceId: string) {
    await client.startService(repoId, serviceId)
    await handleStatusRefresh(repoId, serviceId)
  }

  async function handleStop(repoId: string, serviceId: string) {
    const result = await client.stopService(repoId, serviceId)
    if (result.shutdownAccepted) {
      setApplicationState("shutting_down")
      return
    }
    try {
      const health = await client.getHealth()
      setApplicationState(health.applicationState)
      if (health.applicationState === "shutting_down") return
    } catch {
      // Continue with normal refresh handling for a managed-service stop.
    }
    await handleStatusRefresh(repoId, serviceId)
  }

  async function handleRestart(repoId: string, serviceId: string) {
    await client.restartService(repoId, serviceId)
    await handleStatusRefresh(repoId, serviceId)
  }

  async function handleUpdate(repoId: string, serviceId: string) {
    await client.updateService(repoId, serviceId, {
      installMode: "auto",
      restartMode: "auto",
    })
    await handleStatusRefresh(repoId, serviceId)
  }

  async function handleTailnetToggle(serviceId: string, enabled: boolean) {
    if (enabled) await client.enableTailscaleService(serviceId)
    else await client.disableTailscaleService(serviceId)
    await Promise.all([fetchRepos(), fetchTailscale()])
  }

  async function handleStatusRefresh(repoId: string, serviceId: string) {
    setRefreshingServices((current) => new Set(current).add(serviceId))
    try {
      const response = await client.refreshServiceStatus(repoId, serviceId)
      setRepos((current) => current?.map((repo) => repo.id === repoId ? {
        ...repo,
        services: repo.services.map((service) => service.id === serviceId ? response.service : service),
      } : repo) ?? null)
      setTailscaleStatus(response.tailscale)
      if (response.result.error) throw new Error(response.result.error)
    } finally {
      setRefreshingServices((current) => {
        const next = new Set(current)
        next.delete(serviceId)
        return next
      })
    }
  }

  async function handleGlobalRefresh() {
    if (isRefreshing) return
    setIsRefreshing(true)
    setRefreshFeedback({ message: "Refreshing all service statuses…", error: false })
    try {
      const response = await client.refreshAllStatus()
      setRepos(response.repos)
      setTailscaleStatus(response.tailscale)
      setError(null)
      const failures = response.services.filter((service) => service.error)
      setRefreshFeedback({
        message: failures.length > 0
          ? `Refresh completed with ${failures.length} service check error${failures.length === 1 ? "" : "s"}`
          : `Status refresh completed at ${new Date(response.checkedAt).toLocaleTimeString()}`,
        error: failures.length > 0,
      })
    } catch (err) {
      setRefreshFeedback({
        message: err instanceof Error ? err.message : "Status refresh failed",
        error: true,
      })
    } finally {
      setIsRefreshing(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div className={styles.errorBanner} role="alert">
        {error}
      </div>
    )
  }

  if (repos === null) {
    return <div className={styles.loading}>Loading services…</div>
  }

  if (repos.length === 0) {
    return (
      <div className={styles.empty}>
        No repos configured. Add entries to <code>data/projects.json</code>.
      </div>
    )
  }

  const summary = getSummary(repos)
  const tailnetByService = new Map(
    tailscaleStatus?.services.map((service) => [service.serviceId, service]) ?? [],
  )

  return (
    <div className={styles.dashboard}>
      {applicationState === "shutting_down" && (
        <section className={styles.shutdownBanner} role="alert">
          SourceManager is shutting down. Managed services and their Tailnet advertisements will remain running.
        </section>
      )}
      {startup?.state === "running" && (
        <section className={styles.recoveryBanner} role="status" aria-live="polite">
          <TimerReset aria-hidden="true" size={21} />
          <div>
            <strong>Restoring services from the previous SourceManager session</strong>
            <span>
              {startup.completed} of {startup.total} checked. Services that need
              longer remain Recovering and continue checking in the background.
            </span>
          </div>
          <progress value={startup.completed} max={Math.max(1, startup.total)} />
        </section>
      )}
      <section className={styles.overview} aria-label="Service overview">
        <div>
          <p className={styles.kicker}>Dashboard</p>
          <h1 className={styles.title}>Service Status</h1>
        </div>
        <div className={styles.metrics}>
          <div className={styles.metric}>
            <Server aria-hidden="true" size={18} strokeWidth={2.2} />
            <span className={styles.metricValue}>{summary.total}</span>
            <span className={styles.metricLabel}>Services</span>
          </div>
          <div className={styles.metric} data-state="running">
            <Activity aria-hidden="true" size={18} strokeWidth={2.2} />
            <span className={styles.metricValue}>{summary.running}</span>
            <span className={styles.metricLabel}>Running</span>
          </div>
          <div className={styles.metric} data-state="attention">
            <ShieldAlert aria-hidden="true" size={18} strokeWidth={2.2} />
            <span className={styles.metricValue}>{summary.attention}</span>
            <span className={styles.metricLabel}>Attention</span>
          </div>
          <button
            className={styles.refreshBtn}
            type="button"
            onClick={() => {
              void handleGlobalRefresh()
            }}
            disabled={isRefreshing}
            aria-label="Refresh service status"
            title="Refresh service status"
          >
            <RefreshCw
              className={isRefreshing ? styles.spinning : undefined}
              aria-hidden="true"
              size={18}
              strokeWidth={2.25}
            />
          </button>
        </div>
      </section>
      {refreshFeedback && (
        <div
          className={refreshFeedback.error ? styles.refreshError : styles.refreshFeedback}
          role={refreshFeedback.error ? "alert" : "status"}
          aria-live="polite"
        >
          {refreshFeedback.message}
        </div>
      )}

      <div className={styles.grid}>
        {repos.map((repo, index) => {
          const counts = countStates(repo)
          const accent = GROUP_ACCENTS[index % GROUP_ACCENTS.length]
          return (
            <section
              key={repo.id}
              className={styles.repoGroup}
              style={{ "--group-accent": accent } as CSSProperties}
            >
              <header className={styles.repoHeader}>
                <div>
                  <p className={styles.repoEyebrow}>Project</p>
                  <h2 className={styles.repoName}>{repo.displayName}</h2>
                </div>
                <div className={styles.repoCounts} aria-label={`${repo.displayName} status counts`}>
                  {Object.entries(counts)
                    .filter(([, count]) => count > 0)
                    .map(([state, count]) => (
                      <span key={state} className={styles.stateCount} data-state={state}>
                        {count}
                        <span>{STATE_LABELS[state as LifecycleState]}</span>
                      </span>
                    ))}
                </div>
              </header>
              <div className={styles.services}>
                {repo.services.map((service) => (
                  <ServiceCard
                    key={service.id}
                    repoId={repo.id}
                    service={service}
                    onStart={handleStart}
                    onStop={handleStop}
                    onRestart={handleRestart}
                    onUpdate={handleUpdate}
                    onRefreshStatus={handleStatusRefresh}
                    isStatusRefreshing={isRefreshing || refreshingServices.has(service.id)}
                    tailnetStatus={tailnetByService.get(service.id) ?? null}
                    onTailnetToggle={handleTailnetToggle}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function getSummary(repos: RepoSummary[]) {
  const counts = repos.reduce(
    (acc, repo) => {
      for (const service of repo.services) {
        acc.total += 1
        const state = effectiveLifecycleState(service)
        acc[state] += 1
        if (
          (service.observedStatus.availability.state === "healthy" && (
            service.observedStatus.management.state === "control_lost"
            || service.observedStatus.management.state === "unmanaged"
          ))
          || state === "failed"
          || state === "starting"
          || state === "recovering"
          || state === "stopping"
        ) acc.attention += 1
      }
      return acc
    },
    { total: 0, attention: 0, running: 0, starting: 0, recovering: 0, stopping: 0, stopped: 0, failed: 0 },
  )
  return counts
}

function countStates(repo: RepoSummary): Record<LifecycleState, number> {
  return repo.services.reduce(
    (acc, service) => {
      acc[effectiveLifecycleState(service)] += 1
      return acc
    },
    { running: 0, starting: 0, recovering: 0, stopping: 0, stopped: 0, failed: 0 },
  )
}

function effectiveLifecycleState(service: RepoSummary["services"][number]): LifecycleState {
  const lifecycle = service.lifecycle.state
  if (lifecycle === "starting" || lifecycle === "recovering" || lifecycle === "stopping") return lifecycle
  return service.observedStatus.availability.state === "healthy" ? "running" : lifecycle
}
