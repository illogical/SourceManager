import { useState } from "react"
import { Download, Play, RefreshCw, RotateCcw, Square, Terminal } from "lucide-react"
import type { ServiceSummary, TailscaleServiceCheck } from "../api/types"
import LifecycleBadge from "./LifecycleBadge"
import ActionButton from "./ActionButton"
import TailscalePanel from "./TailscalePanel"
import styles from "./ServiceCard.module.css"

interface Props {
  repoId: string
  service: ServiceSummary
  onStart: (repoId: string, serviceId: string) => Promise<void>
  onStop: (repoId: string, serviceId: string) => Promise<void>
  onRestart: (repoId: string, serviceId: string) => Promise<void>
  onUpdate: (repoId: string, serviceId: string) => Promise<void>
  onRefreshStatus?: (repoId: string, serviceId: string) => Promise<void>
  isStatusRefreshing?: boolean
  tailnetStatus?: TailscaleServiceCheck | null
  onTailnetToggle?: (serviceId: string, enabled: boolean) => Promise<void>
}

export default function ServiceCard({
  repoId,
  service,
  onStart,
  onStop,
  onRestart,
  onUpdate,
  onRefreshStatus = async () => {},
  isStatusRefreshing = false,
  tailnetStatus = null,
  onTailnetToggle = async () => {},
}: Props) {
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const { lifecycle, tailnet } = service
  const observed = service.observedStatus
  const healthy = observed.availability.state === "healthy"
  const state = lifecycle.state === "starting" || lifecycle.state === "recovering" || lifecycle.state === "stopping"
    ? lifecycle.state
    : healthy ? "running" : lifecycle.state
  const managementAttention = healthy && (
    observed.management.state === "control_lost" || observed.management.state === "unmanaged"
  )
  const canControl = observed.management.state === "managed" || observed.management.state === "not_applicable"
  const isPending = pendingAction !== null || isStatusRefreshing
  const isRunning = state === "running" || state === "starting" || state === "recovering"
  const isStopping = state === "stopping"

  async function run(name: string, fn: () => Promise<void>) {
    setPendingAction(name)
    setActionError(null)
    try {
      await fn()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingAction(null)
    }
  }

  const uptimeSummary =
    lifecycle.state === "running" && lifecycle.uptimeMs != null
      ? formatUptime(lifecycle.uptimeMs)
      : null
  const toggleLabel = !canControl && healthy
    ? "Management control unavailable"
    : state === "recovering"
    ? "Stop recovering service"
    : isRunning || isStopping ? "Stop service" : "Start service"
  const toggleIcon = isRunning || isStopping ? Square : Play
  const toggleVariant = isRunning || isStopping ? "stop" : "start"
  const canRestart = state === "running" && canControl
  const canUpdate = state !== "starting" && state !== "stopping" && canControl
  const effectiveTailnetStatus: TailscaleServiceCheck | null = tailnetStatus ?? (tailnet ? {
    serviceId: service.id,
    configured: true,
    desiredEnabled: tailnet.serviceEnabled ?? tailnet.serveEnabled,
    serviceName: tailnet.serviceName ? `svc:${tailnet.serviceName}` : null,
    expectedUrl: tailnet.hostname && tailnet.domain
      ? `https://${tailnet.hostname}.${tailnet.domain}`
      : null,
    localTarget: tailnet.serviceTarget ?? tailnet.serveTarget,
    httpsPort: tailnet.servicePort ?? 443,
    status: state === "recovering"
      ? "local_recovering"
      : state === "running" ? "not_advertised" : "local_stopped",
    lastError: null,
    lastWarning: null,
    operation: null,
    canToggle: false,
  } : null)

  async function handleToggle() {
    if (isRunning) {
      await run("stop", () => onStop(repoId, service.id))
    } else if (isStopping) {
      return
    } else {
      await run("start", () => onStart(repoId, service.id))
    }
  }

  return (
    <article className={styles.card} data-state={state}>
      <div className={styles.statusRail} aria-hidden="true" />

      <div className={styles.identity}>
        <div className={styles.titleBlock}>
          <div className={styles.titleRow}>
            <span className={styles.name}>{service.displayName}</span>
            <span className={styles.port}>:{service.port}</span>
          </div>
          <div className={styles.metaRow}>
          <LifecycleBadge state={state} />
            {uptimeSummary && <span className={styles.uptime}>{uptimeSummary}</span>}
            {(observed.listenerPid ?? lifecycle.pid) && (
              <span className={styles.pid}>PID {observed.listenerPid ?? lifecycle.pid}</span>
            )}
            {observed.checkedAt !== new Date(0).toISOString() && (
              <span className={styles.checked}>{formatCheckedAt(observed.checkedAt)}</span>
            )}
          </div>
        </div>

        <div className={styles.stackInfo}>
          <span className={styles.infoPill}>
            <Terminal aria-hidden="true" size={13} strokeWidth={2.2} />
            {service.packageManager} {service.scriptName}
          </span>
          {service.tags.length > 0 && (
            <div className={styles.tagList}>
              {service.tags.map((tag) => (
                <span key={tag} className={styles.tag}>
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={styles.controls}>
        <ActionButton
          label={toggleLabel}
          icon={toggleIcon}
          variant={toggleVariant}
          disabled={isPending || isStopping || (!canControl && healthy)}
          loading={pendingAction === "start" || pendingAction === "stop" || isStopping}
          onClick={handleToggle}
        />
        <ActionButton
          label="Refresh status"
          icon={RefreshCw}
          disabled={isPending || isStopping}
          loading={pendingAction === "status-refresh" || isStatusRefreshing}
          onClick={() => run("status-refresh", () => onRefreshStatus(repoId, service.id))}
        />
        <ActionButton
          label="Restart service"
          icon={RotateCcw}
          disabled={isPending || !canRestart}
          loading={pendingAction === "restart"}
          onClick={() => run("restart", () => onRestart(repoId, service.id))}
        />
        <ActionButton
          label="Update service"
          icon={Download}
          disabled={isPending || !canUpdate}
          loading={pendingAction === "update"}
          onClick={() => run("update", () => onUpdate(repoId, service.id))}
        />
      </div>

      {tailnet && (
        <TailscalePanel
          lifecycleState={state}
          status={effectiveTailnetStatus}
          pending={isPending}
          onToggle={(enabled) => {
            void run("tailnet", () => onTailnetToggle(service.id, enabled))
          }}
        />
      )}

      {isStatusRefreshing && (
        <div className={styles.checking} role="status" aria-live="polite">Checking service status…</div>
      )}
      {managementAttention && (
        <div className={styles.attention} role="status">
          <strong>{observed.management.state === "control_lost" ? "Control lost" : "Unmanaged service"}</strong>
          <span>{observed.message}</span>
        </div>
      )}
      {((state === "failed" && !healthy && lifecycle.lastError) || actionError) ? (
        <div className={styles.message} role="alert">
          {actionError ?? lifecycle.lastError}
        </div>
      ) : null}
      {(state === "starting" || state === "recovering") && lifecycle.recoveryReason ? (
        <div className={styles.message} role="status">
          {lifecycle.recoveryReason}
        </div>
      ) : null}
    </article>
  )
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function formatCheckedAt(value: string): string {
  const elapsedMs = Date.now() - new Date(value).getTime()
  if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < 60_000) return "Checked just now"
  return `Checked ${new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`
}
