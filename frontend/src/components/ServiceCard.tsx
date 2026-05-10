import { useState } from "react"
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

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <span className={styles.name}>{service.displayName}</span>
          <span className={styles.port}>:{service.port}</span>
        </div>
        <div className={styles.metaRow}>
          <LifecycleBadge state={state} />
          {lifecycle.pid && <span className={styles.pid}>PID {lifecycle.pid}</span>}
          {uptimeSummary && <span className={styles.uptime}>{uptimeSummary}</span>}
        </div>
        {tailnetUrl && (
          <div className={styles.tailnet}>
            Tailnet: <span className={styles.tailnetUrl}>{tailnetUrl}</span>
          </div>
        )}
        {state === "failed" && lifecycle.lastError && (
          <div className={styles.errorMsg}>{lifecycle.lastError}</div>
        )}
        {actionError && <div className={styles.actionError}>{actionError}</div>}
      </div>

      <div className={styles.controls}>
        <ActionButton
          label="Start"
          variant="primary"
          disabled={isPending || state === "running" || state === "starting"}
          loading={pendingAction === "start"}
          onClick={() => run("start", () => onStart(repoId, service.id))}
        />
        <ActionButton
          label="Stop"
          variant="danger"
          disabled={isPending || state === "stopped" || state === "failed"}
          loading={pendingAction === "stop"}
          onClick={() => run("stop", () => onStop(repoId, service.id))}
        />
        <ActionButton
          label="Restart"
          disabled={isPending || state === "stopped" || state === "failed" || state === "starting"}
          loading={pendingAction === "restart"}
          onClick={() => run("restart", () => onRestart(repoId, service.id))}
        />
        <ActionButton
          label="Update"
          disabled={isPending || state === "starting"}
          loading={pendingAction === "update"}
          onClick={() => run("update", () => onUpdate(repoId, service.id))}
        />
      </div>
    </div>
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
