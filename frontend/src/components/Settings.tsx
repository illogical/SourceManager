import { useEffect, useState } from "react"
import { applyConfig, clearToken, fetchConfig, getToken, setToken, testConnection, validateConfig } from "../api/client"
import styles from "./Settings.module.css"

interface Props { onConnected(): void; onClose?: () => void; onSaved(message: string): void; onSaveError(message: string, detail?: unknown): void }

export default function Settings({ onConnected, onClose, onSaved, onSaveError }: Props) {
  const [token, updateToken] = useState(getToken())
  const [json, setJson] = useState("")
  const [message, setMessage] = useState("")
  useEffect(() => { if (getToken()) void fetchConfig().then((value) => setJson(JSON.stringify(value.config, null, 2))).catch(() => undefined) }, [])
  async function connect() {
    setToken(token)
    try { await testConnection(); const value = await fetchConfig(); setJson(JSON.stringify(value.config, null, 2)); setMessage("Connected"); onConnected() }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }
  async function save() {
    try {
      const value = JSON.parse(json)
      const preview = await validateConfig(value)
      if (!preview.validation.valid) throw new Error(preview.validation.errors.map((error) => error.message).join("; "))
      const result = await applyConfig(value)
      onSaved(`Saved ${result.changeCount} changes. Restart the host to apply them.`)
    } catch (error) { onSaveError("Configuration was not saved", error); setMessage(error instanceof Error ? error.message : String(error)) }
  }
  return <div className={styles.settings}>
    <div className={styles.header}><div><p className={styles.eyebrow}>Portal configuration</p><h1>Settings</h1></div>{onClose && <button onClick={onClose}>Close</button>}</div>
    <section className={styles.section}><h2 className={styles.sectionHeading}>API token</h2><div className={styles.sectionCard}><input className={styles.input} type="password" value={token} onChange={(event) => updateToken(event.target.value)} placeholder="SOURCEMANAGER_TOKEN"/><button className={styles.testBtn} onClick={() => void connect()}>Save & test</button><button className={styles.signOutBtn} onClick={() => { clearToken(); updateToken(""); setMessage("Signed out") }}>Sign out</button></div></section>
    {json && <section className={styles.section}><h2 className={styles.sectionHeading}>Hosted projects (schema v2)</h2><div className={styles.sectionCard}><textarea className={styles.configEditor} rows={28} value={json} onChange={(event) => setJson(event.target.value)} spellCheck={false}/><button className={styles.saveBtn} onClick={() => void save()}>Validate & save</button></div></section>}
    {message && <p className={styles.tokenNote}>{message}</p>}
  </div>
}
