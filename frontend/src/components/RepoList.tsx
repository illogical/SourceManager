import { useState, useEffect, useCallback } from "react"
import * as client from "../api/client"
import type { RepoSummary } from "../api/types"
import ServiceCard from "./ServiceCard"
import styles from "./RepoList.module.css"

export default function RepoList() {
  const [repos, setRepos] = useState<RepoSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className={styles.list}>
      {repos.map((repo) => (
        <section key={repo.id} className={styles.repoGroup}>
          <h2 className={styles.repoName}>{repo.displayName}</h2>
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
      ))}
    </div>
  )
}
