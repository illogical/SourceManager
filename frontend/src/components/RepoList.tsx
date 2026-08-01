import { useCallback, useEffect, useState } from "react"
import { Activity, Boxes, GitBranch, RefreshCw } from "lucide-react"
import { fetchProjects, fetchTailscaleStatus } from "../api/client"
import type { GlobalTailscaleStatus, ProjectStatus } from "../api/types"
import TailscalePanel from "./TailscalePanel"
import styles from "./RepoList.module.css"

function short(commit: string | null): string { return commit?.slice(0, 8) ?? "—" }

export default function RepoList() {
  const [projects, setProjects] = useState<ProjectStatus[]>([])
  const [tailnet, setTailnet] = useState<GlobalTailscaleStatus | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [projectResult, tailnetResult] = await Promise.all([fetchProjects(), fetchTailscaleStatus()])
      setProjects(projectResult.projects); setTailnet(tailnetResult); setError("")
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  const ready = projects.filter((project) => project.hostState === "ready").length
  const attention = projects.filter((project) => project.hostState === "degraded" || project.hostState === "unavailable" || project.buildState !== "current").length
  return <div className={styles.dashboard}>
    <section className={styles.overview}>
      <div><p className={styles.kicker}>Unified Node / Express portal</p><h1 className={styles.title}>Hosted applications</h1></div>
      <div className={styles.metrics}>
        <div className={styles.metric}><Boxes size={18}/><strong className={styles.metricValue}>{projects.length}</strong><span className={styles.metricLabel}>Projects</span></div>
        <div className={styles.metric} data-state="running"><Activity size={18}/><strong className={styles.metricValue}>{ready}</strong><span className={styles.metricLabel}>Ready</span></div>
        <div className={styles.metric} data-state="attention"><Activity size={18}/><strong className={styles.metricValue}>{attention}</strong><span className={styles.metricLabel}>Attention</span></div>
        <button className={styles.refreshBtn} onClick={() => void refresh()} disabled={loading} aria-label="Refresh"><RefreshCw size={18} className={loading ? styles.spinning : ""}/></button>
      </div>
    </section>
    {tailnet && <TailscalePanel status={tailnet} onChanged={setTailnet}/>}
    {error && <div className={styles.errorBanner}>{error}</div>}
    <section className={styles.grid}>
      {projects.map((project) => <article className={styles.repoGroup} key={project.id}>
        <header className={styles.repoHeader}><div><p className={styles.repoEyebrow}>{project.capabilities.join(" · ") || "repository"}</p><h2 className={styles.repoName}>{project.displayName}</h2></div><span className={styles.stateCount} data-state={project.hostState}>{project.hostState}</span></header>
        <div className={styles.commitGrid}>
          <span><GitBranch size={14}/> {project.branch ?? project.defaultBranch}</span>
          <span>Loaded <code>{short(project.loadedCommit)}</code></span>
          <span>Checkout <code>{short(project.checkedOutCommit)}</code></span>
          <span>Build <b>{project.buildState}</b></span>
          <span>Tree <b>{project.workingTree}</b></span>
        </div>
        <div className={styles.capabilities}>{project.links.web && <a href={project.links.web}>Open app</a>}{project.links.api && <a href={project.links.api}>API</a>}{project.links.realtime && <code>{project.links.realtime}</code>}</div>
        {(project.lastError || project.moduleStatus?.message) && <p className={project.lastError ? styles.projectError : styles.projectMessage}>{project.lastError ?? project.moduleStatus?.message}</p>}
      </article>)}
    </section>
  </div>
}
