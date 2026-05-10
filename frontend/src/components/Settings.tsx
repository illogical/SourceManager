import { useState } from "react"
import * as client from "../api/client"
import styles from "./Settings.module.css"

interface Props {
  onConnected?: () => void
}

export default function Settings({ onConnected }: Props) {
  const [token, setTokenInput] = useState("")
  const [status, setStatus] = useState<"idle" | "checking" | "ok" | "error">("idle")
  const [message, setMessage] = useState("")
  const hasExistingToken = !!client.getToken()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!token.trim()) return
    client.setToken(token.trim())
    setStatus("checking")
    setMessage("")
    try {
      await client.testConnection()
      setStatus("ok")
      setMessage("Connected ✓")
      onConnected?.()
    } catch (err) {
      setStatus("error")
      if (err instanceof client.AuthError) {
        setMessage(`Invalid token — ${err.message}`)
      } else if (err instanceof client.ApiError) {
        setMessage(`Error ${err.status}: check the backend`)
      } else {
        setMessage("Cannot reach SourceManager API — is the backend running?")
      }
    }
  }

  function handleSignOut() {
    client.clearToken()
    setTokenInput("")
    setStatus("idle")
    setMessage("")
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.heading}>Settings</h2>
      <form onSubmit={handleSubmit} className={styles.form}>
        <label className={styles.label} htmlFor="sm-token">
          API Token
        </label>
        <input
          id="sm-token"
          className={styles.input}
          type="password"
          placeholder="Enter token from projects.json"
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
          autoComplete="current-password"
        />
        <button
          className={styles.saveBtn}
          type="submit"
          disabled={status === "checking" || !token.trim()}
        >
          {status === "checking" ? "Checking…" : "Save & test"}
        </button>
      </form>

      {message && (
        <p className={status === "ok" ? styles.successMsg : styles.errorMsg}>
          {message}
        </p>
      )}

      {hasExistingToken && (
        <button className={styles.signOutBtn} type="button" onClick={handleSignOut}>
          Sign out
        </button>
      )}
    </div>
  )
}
