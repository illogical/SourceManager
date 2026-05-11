import { useState, useCallback, useRef } from "react"
import { Settings as SettingsIcon } from "lucide-react"
import { getToken } from "./api/client"
import Settings from "./components/Settings"
import RepoList from "./components/RepoList"
import { Toast } from "./components/Toast"
import type { ToastData } from "./components/Toast"
import styles from "./App.module.css"

let _toastId = 0

export default function App() {
  const [showSettings, setShowSettings] = useState(false)
  const [hasToken, setHasToken] = useState(!!getToken())
  const [toast, setToast] = useState<ToastData | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showToast(message: string, variant: "success" | "error", durationMs = variant === "success" ? 3500 : 5000) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    const id = ++_toastId
    setToast({ id, message, variant })
    toastTimerRef.current = setTimeout(() => setToast(null), durationMs)
  }

  const dismissToast = useCallback((id: number) => {
    setToast((t) => (t?.id === id ? null : t))
  }, [])

  function handleConnected() {
    setHasToken(true)
    setShowSettings(false)
  }

  function handleClose() {
    setShowSettings(false)
  }

  function handleSaved(message: string) {
    setShowSettings(false)
    showToast(message, "success")
  }

  function handleSaveError(message: string, detail?: unknown) {
    if (detail !== undefined) {
      console.error("[SourceManager] Save error detail:", detail)
    }
    showToast(message, "error")
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.logo}>SourceManager</span>
        <button
          className={styles.settingsBtn}
          onClick={() => setShowSettings((v) => !v)}
          aria-label="Settings"
          title="Settings"
        >
          <SettingsIcon aria-hidden="true" size={18} strokeWidth={2.2} />
        </button>
      </header>

      <main className={styles.main}>
        {showSettings || !hasToken ? (
          <Settings
            onConnected={handleConnected}
            onClose={hasToken ? handleClose : undefined}
            onSaved={handleSaved}
            onSaveError={handleSaveError}
          />
        ) : (
          <RepoList />
        )}
      </main>

      {toast && (
        <Toast
          toast={toast}
          onDismiss={dismissToast}
          durationMs={toast.variant === "success" ? 3500 : 5000}
        />
      )}
    </div>
  )
}

