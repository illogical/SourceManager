import styles from "./ActionButton.module.css"

interface Props {
  label: string
  onClick: () => void
  loading?: boolean
  disabled?: boolean
  variant?: "primary" | "danger" | "secondary"
}

export default function ActionButton({
  label,
  onClick,
  loading = false,
  disabled = false,
  variant = "secondary",
}: Props) {
  const isDisabled = disabled || loading

  return (
    <button
      className={`${styles.btn} ${styles[variant]}`}
      onClick={isDisabled ? undefined : onClick}
      disabled={isDisabled}
      aria-busy={loading}
    >
      {loading ? `${label}…` : label}
    </button>
  )
}
