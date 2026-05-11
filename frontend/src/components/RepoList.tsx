import { useState, useEffect, useCallback } from "react"
import type { CSSProperties } from "react"
import { Activity, RefreshCw, Server, ShieldAlert } from "lucide-react"
import * as client from "../api/client"
import type { LifecycleState, RepoSummary } from "../api/types"
import ServiceCard from "./ServiceCard"
import styles from "./RepoList.module.css"

const GROUP_ACCENTS = ["#2dd4bf", "#60a5fa", "#a78bfa", "#f59e0b", "#fb7185", "#34d399"]
const STATE_LABELS: Record<LifecycleState, string> = {
  running: "Running",
  starting: "Starting",
  stopped: "Stopped",
  failed: "Failed",
}

export default function RepoList() {
  const [repos, setRepos] = useState<RepoSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const fetchRepos = useCallback(async (manual = false) => {
    if (manual) setIsRefreshing(true)
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
    } finally {
      if (manual) setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void fetchRepos()
    const interval = setInterval(() => { void fetchRepos() }, 10_000)
    return () => clearInterval(interval)
  }, [fetchRepos])

  // ── Action handlers ────────────────────────────────────────────────────────

  async function handleStart(repoId: string, serviceId: string) {
    await client.startService(repoId, serviceId)
    await fetchRepos()
  }

  async function handleStop(repoId: string, serviceId: string) {
    await client.stopService(repoId, serviceId)
    await fetchRepos()
  }

  async function handleRestart(repoId: string, serviceId: string) {
    await client.restartService(repoId, serviceId)
    await fetchRepos()
  }

  async function handleUpdate(repoId: string, serviceId: string) {
    await client.updateService(repoId, serviceId, {
      installMode: "auto",
      restartMode: "auto",
    })
    await fetchRepos()
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

  return (
    <div className={styles.dashboard}>
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
            <span className={styles.metricValue}>{summary.failed + summary.starting}</span>
            <span className={styles.metricLabel}>Attention</span>
          </div>
          <button
            className={styles.refreshBtn}
            type="button"
            onClick={() => void fetchRepos(true)}
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
                  {Object.entries(counts).map(([state, count]) => (
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
        acc[service.lifecycle.state] += 1
      }
      return acc
    },
    { total: 0, running: 0, starting: 0, stopped: 0, failed: 0 },
  )
  return counts
}

function countStates(repo: RepoSummary): Record<LifecycleState, number> {
  return repo.services.reduce(
    (acc, service) => {
      acc[service.lifecycle.state] += 1
      return acc
    },
    { running: 0, starting: 0, stopped: 0, failed: 0 },
  )
}
