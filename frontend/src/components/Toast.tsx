import { useEffect } from "react"
import { CheckCircle, XCircle, X } from "lucide-react"
import styles from "./Toast.module.css"

export interface ToastData {
  id: number
  message: string
  variant: "success" | "error"
}

interface Props {
  toast: ToastData
  onDismiss: (id: number) => void
  durationMs?: number
}

export function Toast({ toast, onDismiss, durationMs = 3500 }: Props) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), durationMs)
    return () => clearTimeout(t)
  }, [toast.id, durationMs, onDismiss])

  return (
    <div className={`${styles.toast} ${styles[toast.variant]}`} role="alert" aria-live="polite">
      <span className={styles.icon}>
        {toast.variant === "success" ? (
          <CheckCircle aria-hidden size={16} strokeWidth={2.2} />
        ) : (
          <XCircle aria-hidden size={16} strokeWidth={2.2} />
        )}
      </span>
      <span className={styles.message}>{toast.message}</span>
      <button
        className={styles.dismiss}
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        <X aria-hidden size={14} strokeWidth={2.5} />
      </button>
    </div>
  )
}
