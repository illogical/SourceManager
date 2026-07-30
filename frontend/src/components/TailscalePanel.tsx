import { ExternalLink, LoaderCircle, Wifi } from "lucide-react"
import type { LifecycleState, TailscaleServiceCheck } from "../api/types"
import styles from "./TailscalePanel.module.css"

interface Props {
  lifecycleState: LifecycleState
  status: TailscaleServiceCheck | null
  pending: boolean
  onToggle: (enabled: boolean) => void
}

const LABELS: Record<TailscaleServiceCheck["status"], string> = {
  not_configured: "Not configured",
  unavailable: "Tailscale unavailable",
  local_stopped: "Service stopped",
  local_recovering: "Waiting for service",
  enabled_unverified: "Enabled (unverified)",
  not_advertised: "Not on Tailnet",
  pending_approval: "Pending approval",
  draining: "Draining",
  connected: "Available",
  mismatch: "Configuration mismatch",
  error: "Tailnet error",
}

export default function TailscalePanel({ lifecycleState, status, pending, onToggle }: Props) {
  if (!status || !status.configured) {
    return (
      <section className={styles.panel} aria-label="Tailnet">
        <div className={styles.heading}>
          <Wifi aria-hidden size={14} />
          Tailnet
        </div>
        <span className={styles.loading}>Loading Tailnet status…</span>
      </section>
    )
  }

  const running = lifecycleState === "running"
  const disabled = pending || !running || !status.canToggle
  const operationLabel = status.operation
    ? `${status.operation[0].toUpperCase()}${status.operation.slice(1)}…`
    : null
  const reason = running && status.status === "unavailable"
    ? "Tailscale is unavailable on the host"
    : status.status === "pending_approval"
      ? "Awaiting administrator approval"
      : undefined

  return (
    <section className={styles.panel} aria-label="Tailnet">
      <div className={styles.topRow}>
        <div className={styles.heading}>
          <Wifi aria-hidden size={14} />
          Tailnet
        </div>
        <span className={styles.badge} data-status={status.status}>
          {LABELS[status.status]}
        </span>
        <button
          type="button"
          className={styles.switch}
          role="switch"
          aria-checked={status.desiredEnabled}
          aria-label="Tailnet exposure"
          disabled={disabled}
          title={reason}
          onClick={() => onToggle(!status.desiredEnabled)}
        >
          <span className={styles.switchTrack} data-checked={status.desiredEnabled}>
            <span className={styles.switchThumb} />
          </span>
          <span>{status.desiredEnabled ? "On" : "Off"}</span>
          {pending && <LoaderCircle className={styles.spinning} aria-hidden size={13} />}
        </button>
      </div>

      <div className={styles.details}>
        {status.expectedUrl && (
          <a href={status.expectedUrl} target="_blank" rel="noreferrer">
            {status.expectedUrl.replace(/^https:\/\//, "")}
            <ExternalLink aria-hidden size={11} />
          </a>
        )}
        {status.serviceName && <code>{status.serviceName}</code>}
      </div>

      {(operationLabel || reason || status.lastWarning || status.lastError) && (
        <p
          className={status.lastError ? styles.error : status.lastWarning ? styles.warning : styles.note}
          role={status.lastError ? "alert" : undefined}
        >
          {operationLabel ?? status.lastError ?? status.lastWarning ?? reason}
        </p>
      )}
    </section>
  )
}
