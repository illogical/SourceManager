import type { LifecycleState } from "../api/types"
import styles from "./LifecycleBadge.module.css"

interface Props {
  state: LifecycleState
}

const STATE_CONFIG: Record<LifecycleState, { label: string; cssClass: string }> = {
  running: { label: "running", cssClass: styles.running },
  starting: { label: "starting", cssClass: styles.starting },
  stopped: { label: "stopped", cssClass: styles.stopped },
  failed: { label: "failed", cssClass: styles.failed },
}

export default function LifecycleBadge({ state }: Props) {
  const { label, cssClass } = STATE_CONFIG[state]
  return (
    <span className={`${styles.badge} ${cssClass}`}>
      <span className={styles.dot} aria-hidden="true" />
      {label}
    </span>
  )
}
