import { useState } from "react"
import type { GlobalTailscaleStatus } from "../api/types"
import { setTailscaleEnabled } from "../api/client"
import styles from "./TailscalePanel.module.css"

export default function TailscalePanel({ status, onChanged }: { status: GlobalTailscaleStatus; onChanged(value: GlobalTailscaleStatus): void }) {
  const [busy, setBusy] = useState(false)
  const toggle = async () => { setBusy(true); try { onChanged(await setTailscaleEnabled(!status.desiredEnabled)) } finally { setBusy(false) } }
  return <section className={styles.panel}>
    <div className={styles.topRow}><strong className={styles.heading}>Tailnet service: {status.serviceName}</strong><span className={styles.badge} data-status={status.status}>{status.status.replaceAll("_", " ")}</span><button className={styles.switch} onClick={() => void toggle()} disabled={busy}>{status.desiredEnabled ? "Disable" : "Enable"}</button></div>
    <div className={styles.details}><code>{status.target}</code>{status.tailnetDomain && <span>{status.serviceName}.{status.tailnetDomain}</span>}</div>
    {status.error && <p className={styles.error}>{status.error}</p>}
  </section>
}
