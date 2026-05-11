import type { LucideIcon } from "lucide-react"
import { LoaderCircle } from "lucide-react"
import styles from "./ActionButton.module.css"

interface Props {
  label: string
  icon: LucideIcon
  onClick: () => void
  loading?: boolean
  disabled?: boolean
  variant?: "start" | "stop" | "secondary" | "danger"
}

export default function ActionButton({
  label,
  icon: Icon,
  onClick,
  loading = false,
  disabled = false,
  variant = "secondary",
}: Props) {
  const isDisabled = disabled || loading
  const ButtonIcon = loading ? LoaderCircle : Icon

  return (
    <button
      className={`${styles.btn} ${styles[variant]}`}
      onClick={isDisabled ? undefined : onClick}
      disabled={isDisabled}
      aria-busy={loading}
      aria-label={label}
      title={label}
    >
      <ButtonIcon
        className={loading ? styles.spinning : undefined}
        aria-hidden="true"
        size={16}
        strokeWidth={2.35}
      />
      <span className={styles.srOnly}>{loading ? `${label}…` : label}</span>
    </button>
  )
}
