import { useState } from "react"
import { Settings as SettingsIcon } from "lucide-react"
import { getToken } from "./api/client"
import Settings from "./components/Settings"
import RepoList from "./components/RepoList"
import styles from "./App.module.css"

export default function App() {
  const [showSettings, setShowSettings] = useState(false)
  const [hasToken, setHasToken] = useState(!!getToken())

  function handleConnected() {
    setHasToken(true)
    setShowSettings(false)
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
          <Settings onConnected={handleConnected} />
        ) : (
          <RepoList />
        )}
      </main>
    </div>
  )
}
