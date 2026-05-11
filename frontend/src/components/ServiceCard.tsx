import { useState } from "react"
import { ExternalLink, Play, RefreshCw, RotateCcw, Square, Terminal, Wifi } from "lucide-react"
import type { ServiceSummary } from "../api/types"
import LifecycleBadge from "./LifecycleBadge"
import ActionButton from "./ActionButton"
import styles from "./ServiceCard.module.css"

interface Props {
  repoId: string
  service: ServiceSummary
  onStart: (repoId: string, serviceId: string) => Promise<void>
  onStop: (repoId: string, serviceId: string) => Promise<void>
  onRestart: (repoId: string, serviceId: string) => Promise<void>
  onUpdate: (repoId: string, serviceId: string) => Promise<void>
}

export default function ServiceCard({ repoId, service, onStart, onStop, onRestart, onUpdate }: Props) {
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const { lifecycle, tailnet } = service
  const state = lifecycle.state
  const isPending = pendingAction !== null
  const isRunning = state === "running" || state === "starting"

  const tailnetUrl =
    tailnet?.hostname && tailnet?.domain
      ? `${tailnet.hostname}.${tailnet.domain}`
      : null

  async function run(name: string, fn: () => Promise<void>) {
    setPendingAction(name)
    setActionError(null)
    try {
      await fn()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingAction(null)
    }
  }

  const uptimeSummary =
    lifecycle.state === "running" && lifecycle.uptimeMs != null
      ? formatUptime(lifecycle.uptimeMs)
      : null
  const toggleLabel = isRunning ? "Stop service" : "Start service"
  const toggleIcon = isRunning ? Square : Play
  const toggleVariant = isRunning ? "stop" : "start"
  const canRestart = state === "running"
  const canUpdate = state !== "starting"

  async function handleToggle() {
    if (isRunning) {
      await run("stop", () => onStop(repoId, service.id))
    } else {
      await run("start", () => onStart(repoId, service.id))
    }
  }

  return (
    <article className={styles.card} data-state={state}>
      <div className={styles.statusRail} aria-hidden="true" />

      <div className={styles.identity}>
        <div className={styles.titleBlock}>
          <div className={styles.titleRow}>
            <span className={styles.name}>{service.displayName}</span>
            <span className={styles.port}>:{service.port}</span>
          </div>
          <div className={styles.metaRow}>
            <LifecycleBadge state={state} />
            {uptimeSummary && <span className={styles.uptime}>{uptimeSummary}</span>}
            {lifecycle.pid && <span className={styles.pid}>PID {lifecycle.pid}</span>}
          </div>
        </div>

        <div className={styles.stackInfo}>
          <span className={styles.infoPill}>
            <Terminal aria-hidden="true" size={13} strokeWidth={2.2} />
            {service.packageManager} {service.scriptName}
          </span>
          {service.tags.map((tag) => (
            <span key={tag} className={styles.tag}>
              {tag}
            </span>
          ))}
        </div>
      </div>

      <div className={styles.controls}>
        <ActionButton
          label={toggleLabel}
          icon={toggleIcon}
          variant={toggleVariant}
          disabled={isPending}
          loading={pendingAction === "start" || pendingAction === "stop"}
          onClick={handleToggle}
        />
        <ActionButton
          label="Restart service"
          icon={RotateCcw}
          disabled={isPending || !canRestart}
          loading={pendingAction === "restart"}
          onClick={() => run("restart", () => onRestart(repoId, service.id))}
        />
        <ActionButton
          label="Update service"
          icon={RefreshCw}
          disabled={isPending || !canUpdate}
          loading={pendingAction === "update"}
          onClick={() => run("update", () => onUpdate(repoId, service.id))}
        />
      </div>

      {tailnetUrl && (
        <a
          className={styles.tailnet}
          href={`https://${tailnetUrl}`}
          target="_blank"
          rel="noreferrer"
        >
          <Wifi aria-hidden="true" size={13} strokeWidth={2.2} />
          <span>{tailnetUrl}</span>
          <ExternalLink aria-hidden="true" size={12} strokeWidth={2.2} />
        </a>
      )}

      {(state === "failed" && lifecycle.lastError) || actionError ? (
        <div className={styles.message} role="alert">
          {actionError ?? lifecycle.lastError}
        </div>
      ) : null}
    </article>
  )
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
