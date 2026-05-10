import Elysia, { t } from "elysia"
import { requireService } from "../config"
import {
  gitCheckout,
  gitFetch,
  gitPull,
  gitStatus,
  detectDependencyChanges,
} from "../services/git"
import { checkHealth } from "../services/healthCheck"
import { runInstall } from "../services/installer"
import { processManager } from "../services/processManager"
import { logRun } from "../services/runLogger"
import type {
  InstallMode,
  InstallRunResult,
  RepoConfig,
  RestartMode,
  RestartRunResult,
  RunReport,
  ServiceConfig,
  StepResult,
  UpdateAccepted,
} from "../types"

function makeId(): string {
  return crypto.randomUUID()
}

function skipped(step: string, reason: string): StepResult {
  return { step, status: "skipped", message: reason, durationMs: 0 }
}

// ── Steps 2–8 extracted so the handler stays readable ────────────────────────

async function runBackgroundSteps(opts: {
  repo: RepoConfig
  service: ServiceConfig
  runId: string
  startedAt: string
  runStart: number
  branch: string
  installMode: InstallMode
  restartMode: RestartMode
  dryRun: boolean
  steps: StepResult[]
}): Promise<void> {
  const { repo, service, runId, startedAt, runStart, branch, installMode, restartMode, dryRun } = opts
  const steps = [...opts.steps]

  let installRun: InstallRunResult = { status: "skipped", reason: "not reached" }
  let restartRun: RestartRunResult = { status: "skipped", reason: "not reached" }
  let healthStatus: RunReport["healthStatus"] = "skipped"
  let updated = false
  let reason = ""

  // ── Step 2: Fetch ──────────────────────────────────────────────────────────
  if (!dryRun) {
    const fetchStep = await gitFetch(repo.repoPath)
    steps.push(fetchStep)
    if (fetchStep.status === "failure") {
      reason = "Fetch failed"
      await logRun(buildReport({ runId, serviceId: service.id, repoId: repo.id, startedAt, branch, dryRun, durationMs: Date.now() - runStart, steps, updated: false, reason, installRun: { status: "skipped", reason: "fetch failed" }, restartRun: { status: "skipped", reason: "fetch failed" }, healthStatus: "skipped" }))
      return
    }
  } else {
    steps.push(skipped("fetch", "dry run"))
  }

  // ── Step 3: Checkout ───────────────────────────────────────────────────────
  if (!dryRun) {
    const checkoutStep = await gitCheckout(repo.repoPath, branch)
    steps.push(checkoutStep)
    if (checkoutStep.status === "failure") {
      reason = `Checkout of branch "${branch}" failed`
      await logRun(buildReport({ runId, serviceId: service.id, repoId: repo.id, startedAt, branch, dryRun, durationMs: Date.now() - runStart, steps, updated: false, reason, installRun: { status: "skipped", reason: "checkout failed" }, restartRun: { status: "skipped", reason: "checkout failed" }, healthStatus: "skipped" }))
      return
    }
  } else {
    steps.push(skipped("checkout", "dry run"))
  }

  // ── Step 4: Pull ───────────────────────────────────────────────────────────
  if (!dryRun) {
    const pullStep = await gitPull(repo.repoPath, branch)
    steps.push(pullStep)
    if (pullStep.status === "failure") {
      reason = "Pull failed"
      await logRun(buildReport({ runId, serviceId: service.id, repoId: repo.id, startedAt, branch, dryRun, durationMs: Date.now() - runStart, steps, updated: false, reason, installRun: { status: "skipped", reason: "pull failed" }, restartRun: { status: "skipped", reason: "pull failed" }, healthStatus: "skipped" }))
      return
    }
    updated = !pullStep.message.includes("Already up to date")
    reason = pullStep.message
  } else {
    steps.push(skipped("pull", "dry run"))
    reason = "Dry run — no mutations applied"
  }

  // ── Step 5: Dependency check ───────────────────────────────────────────────
  let needsInstall = false
  if (!dryRun) {
    const depStart = Date.now()
    needsInstall = await detectDependencyChanges(repo.repoPath)
    steps.push({
      step: "depCheck",
      status: "success",
      message: needsInstall ? "Dependency files changed" : "No dependency changes detected",
      durationMs: Date.now() - depStart,
    })
  } else {
    steps.push(skipped("depCheck", "dry run"))
  }

  // ── Step 6: Install ────────────────────────────────────────────────────────
  if (dryRun || installMode === "never") {
    const skipReason = dryRun ? "dry run" : "installMode=never"
    steps.push(skipped("install", skipReason))
    installRun = { status: "skipped", reason: skipReason }
  } else if (installMode === "always" || needsInstall) {
    const installStep = await runInstall(repo.repoPath, service)
    steps.push(installStep)
    installRun = {
      status: installStep.status,
      reason: installStep.message,
      durationMs: installStep.durationMs,
    }
  } else {
    steps.push(skipped("install", "no dependency changes (installMode=auto)"))
    installRun = { status: "skipped", reason: "no dependency changes" }
  }

  // ── Step 7: Restart ────────────────────────────────────────────────────────
  let healthCheckNeeded = !dryRun

  if (dryRun || restartMode === "never") {
    const skipReason = dryRun ? "dry run" : "restartMode=never"
    steps.push(skipped("restart", skipReason))
    restartRun = { status: "skipped", reason: skipReason }
  } else if (restartMode === "always") {
    const restartStart = Date.now()
    const result = await processManager.restart(repo, service)
    const durationMs = Date.now() - restartStart
    steps.push({
      step: "restart",
      status: result.success ? "success" : "failure",
      message: result.message,
      durationMs,
    })
    restartRun = { status: result.success ? "success" : "failure", reason: result.message, durationMs }
  } else {
    steps.push(skipped("restart", "restartMode=auto — will check health first"))
    restartRun = { status: "skipped", reason: "restartMode=auto — deferring to health check result" }
  }

  // ── Step 8: Health check ───────────────────────────────────────────────────
  if (!healthCheckNeeded) {
    steps.push(skipped("health", "dry run"))
    healthStatus = "skipped"
  } else {
    const healthResult = await checkHealth(service)
    healthStatus = healthResult.status
    steps.push({
      step: "health",
      status: healthResult.status === "pass" ? "success" : "failure",
      message: healthResult.detail ?? (healthResult.status === "pass" ? "Health check passed" : "Health check failed"),
      durationMs: healthResult.durationMs,
    })

    if (restartMode === "auto" && healthResult.status === "fail") {
      const restartStart = Date.now()
      const result = await processManager.restart(repo, service)
      const durationMs = Date.now() - restartStart
      steps.push({
        step: "restart",
        status: result.success ? "success" : "failure",
        message: `Auto-restart triggered (health failed): ${result.message}`,
        durationMs,
      })
      restartRun = { status: result.success ? "success" : "failure", reason: `Health failure triggered restart: ${result.message}`, durationMs }

      const retryHealth = await checkHealth(service)
      healthStatus = retryHealth.status
      steps.push({
        step: "health-retry",
        status: retryHealth.status === "pass" ? "success" : "failure",
        message: retryHealth.detail ?? (retryHealth.status === "pass" ? "Health check passed after restart" : "Health check still failing after restart"),
        durationMs: retryHealth.durationMs,
      })
    }
  }

  await logRun(buildReport({
    runId, serviceId: service.id, repoId: repo.id, startedAt, branch, dryRun,
    durationMs: Date.now() - runStart,
    steps, updated, reason, installRun, restartRun, healthStatus,
  }))
}

// ── Route ─────────────────────────────────────────────────────────────────────

export const updateRoute = new Elysia({ prefix: "/repos/:repoId/services/:serviceId" }).post(
  "/update",
  async ({ params, body, set }) => {
    const { repo, service } = requireService(params.serviceId)
    const branch = body.branch ?? repo.defaultBranch
    const installMode: InstallMode = body.installMode ?? "auto"
    const restartMode: RestartMode = body.restartMode ?? "auto"
    const dryRun = body.dryRun ?? false
    const background = body.background ?? false

    const runId = makeId()
    const startedAt = new Date().toISOString()
    const runStart = Date.now()
    const steps: StepResult[] = []

    let installRun: InstallRunResult = { status: "skipped", reason: "not reached" }
    let restartRun: RestartRunResult = { status: "skipped", reason: "not reached" }
    let healthStatus: RunReport["healthStatus"] = "skipped"

    // ── Step 1: Precheck (always synchronous) ────────────────────────────────
    const precheckStart = Date.now()
    const statusCheck = await gitStatus(repo.repoPath)
    const precheckStep: StepResult = {
      step: "precheck",
      status: statusCheck.clean ? "success" : "failure",
      message: statusCheck.clean
        ? "Working tree is clean"
        : `Working tree is dirty:\n${statusCheck.output}`,
      durationMs: Date.now() - precheckStart,
    }
    steps.push(precheckStep)

    if (!statusCheck.clean) {
      const reason = "Aborted: working tree has uncommitted changes"
      const report = buildReport({
        runId, serviceId: service.id, repoId: repo.id, startedAt, branch, dryRun,
        durationMs: Date.now() - runStart, steps, updated: false, reason,
        installRun: { status: "skipped", reason: "precheck failed" },
        restartRun: { status: "skipped", reason: "precheck failed" },
        healthStatus: "skipped",
      })
      await logRun(report)
      return report
    }

    // ── Background path ───────────────────────────────────────────────────────
    if (background) {
      set.status = 202

      await logRun(buildReport({
        runId, serviceId: service.id, repoId: repo.id, startedAt, branch, dryRun,
        durationMs: 0, steps,
        updated: false,
        reason: "background run accepted — in progress",
        installRun: { status: "skipped", reason: "pending" },
        restartRun: { status: "skipped", reason: "pending" },
        healthStatus: "skipped",
      }))

      setImmediate(() => {
        runBackgroundSteps({ repo, service, runId, startedAt, runStart, branch, installMode, restartMode, dryRun, steps })
          .catch((err) => console.error(`[update] background run ${runId} failed:`, err))
      })

      const accepted: UpdateAccepted = {
        runId,
        serviceId: service.id,
        repoId: repo.id,
        startedAt,
        branch,
        status: "accepted",
        message: "Update accepted — running in background. Poll /logs for the result.",
      }
      return accepted
    }

    // ── Synchronous path ──────────────────────────────────────────────────────

    let updated = false
    let reason = ""

    // ── Step 2: Fetch ──────────────────────────────────────────────────────────
    if (!dryRun) {
      const fetchStep = await gitFetch(repo.repoPath)
      steps.push(fetchStep)
      if (fetchStep.status === "failure") {
        reason = "Fetch failed"
        const report = buildReport({ runId, serviceId: service.id, repoId: repo.id, startedAt, branch, dryRun, durationMs: Date.now() - runStart, steps, updated: false, reason, installRun: { status: "skipped", reason: "fetch failed" }, restartRun: { status: "skipped", reason: "fetch failed" }, healthStatus: "skipped" })
        await logRun(report)
        return report
      }
    } else {
      steps.push(skipped("fetch", "dry run"))
    }

    // ── Step 3: Checkout ───────────────────────────────────────────────────────
    if (!dryRun) {
      const checkoutStep = await gitCheckout(repo.repoPath, branch)
      steps.push(checkoutStep)
      if (checkoutStep.status === "failure") {
        reason = `Checkout of branch "${branch}" failed`
        const report = buildReport({ runId, serviceId: service.id, repoId: repo.id, startedAt, branch, dryRun, durationMs: Date.now() - runStart, steps, updated: false, reason, installRun: { status: "skipped", reason: "checkout failed" }, restartRun: { status: "skipped", reason: "checkout failed" }, healthStatus: "skipped" })
        await logRun(report)
        return report
      }
    } else {
      steps.push(skipped("checkout", "dry run"))
    }

    // ── Step 4: Pull ───────────────────────────────────────────────────────────
    if (!dryRun) {
      const pullStep = await gitPull(repo.repoPath, branch)
      steps.push(pullStep)
      if (pullStep.status === "failure") {
        reason = "Pull failed"
        const report = buildReport({ runId, serviceId: service.id, repoId: repo.id, startedAt, branch, dryRun, durationMs: Date.now() - runStart, steps, updated: false, reason, installRun: { status: "skipped", reason: "pull failed" }, restartRun: { status: "skipped", reason: "pull failed" }, healthStatus: "skipped" })
        await logRun(report)
        return report
      }
      updated = !pullStep.message.includes("Already up to date")
      reason = pullStep.message
    } else {
      steps.push(skipped("pull", "dry run"))
      reason = "Dry run — no mutations applied"
    }

    // ── Step 5: Dependency check ───────────────────────────────────────────────
    let needsInstall = false
    if (!dryRun) {
      const depStart = Date.now()
      needsInstall = await detectDependencyChanges(repo.repoPath)
      steps.push({
        step: "depCheck",
        status: "success",
        message: needsInstall ? "Dependency files changed" : "No dependency changes detected",
        durationMs: Date.now() - depStart,
      })
    } else {
      steps.push(skipped("depCheck", "dry run"))
    }

    // ── Step 6: Install ────────────────────────────────────────────────────────
    if (dryRun || installMode === "never") {
      const skipReason = dryRun ? "dry run" : "installMode=never"
      steps.push(skipped("install", skipReason))
      installRun = { status: "skipped", reason: skipReason }
    } else if (installMode === "always" || needsInstall) {
      const installStep = await runInstall(repo.repoPath, service)
      steps.push(installStep)
      installRun = {
        status: installStep.status,
        reason: installStep.message,
        durationMs: installStep.durationMs,
      }
    } else {
      steps.push(skipped("install", "no dependency changes (installMode=auto)"))
      installRun = { status: "skipped", reason: "no dependency changes" }
    }

    // ── Step 7: Restart ────────────────────────────────────────────────────────
    let healthCheckNeeded = !dryRun

    if (dryRun || restartMode === "never") {
      const skipReason = dryRun ? "dry run" : "restartMode=never"
      steps.push(skipped("restart", skipReason))
      restartRun = { status: "skipped", reason: skipReason }
    } else if (restartMode === "always") {
      const restartStart = Date.now()
      const result = await processManager.restart(repo, service)
      const durationMs = Date.now() - restartStart
      steps.push({
        step: "restart",
        status: result.success ? "success" : "failure",
        message: result.message,
        durationMs,
      })
      restartRun = { status: result.success ? "success" : "failure", reason: result.message, durationMs }
    } else {
      steps.push(skipped("restart", "restartMode=auto — will check health first"))
      restartRun = { status: "skipped", reason: "restartMode=auto — deferring to health check result" }
    }

    // ── Step 8: Health check ───────────────────────────────────────────────────
    if (!healthCheckNeeded) {
      steps.push(skipped("health", "dry run"))
      healthStatus = "skipped"
    } else {
      const healthResult = await checkHealth(service)
      healthStatus = healthResult.status
      steps.push({
        step: "health",
        status: healthResult.status === "pass" ? "success" : "failure",
        message: healthResult.detail ?? (healthResult.status === "pass" ? "Health check passed" : "Health check failed"),
        durationMs: healthResult.durationMs,
      })

      if (restartMode === "auto" && healthResult.status === "fail") {
        const restartStart = Date.now()
        const result = await processManager.restart(repo, service)
        const durationMs = Date.now() - restartStart
        steps.push({
          step: "restart",
          status: result.success ? "success" : "failure",
          message: `Auto-restart triggered (health failed): ${result.message}`,
          durationMs,
        })
        restartRun = { status: result.success ? "success" : "failure", reason: `Health failure triggered restart: ${result.message}`, durationMs }

        const retryHealth = await checkHealth(service)
        healthStatus = retryHealth.status
        steps.push({
          step: "health-retry",
          status: retryHealth.status === "pass" ? "success" : "failure",
          message: retryHealth.detail ?? (retryHealth.status === "pass" ? "Health check passed after restart" : "Health check still failing after restart"),
          durationMs: retryHealth.durationMs,
        })
      }
    }

    // ── Report ─────────────────────────────────────────────────────────────────
    const report = buildReport({
      runId, serviceId: service.id, repoId: repo.id, startedAt, branch, dryRun,
      durationMs: Date.now() - runStart,
      steps, updated, reason, installRun, restartRun, healthStatus,
    })
    await logRun(report)
    return report
  },
  {
    params: t.Object({ repoId: t.String(), serviceId: t.String() }),
    body: t.Object({
      branch: t.Optional(t.String()),
      installMode: t.Optional(t.Union([t.Literal("auto"), t.Literal("always"), t.Literal("never")])),
      restartMode: t.Optional(t.Union([t.Literal("auto"), t.Literal("always"), t.Literal("never")])),
      dryRun: t.Optional(t.Boolean()),
      background: t.Optional(t.Boolean()),
    }),
    detail: { summary: "Trigger git update workflow", tags: ["Update"] },
  }
)

function buildReport(args: {
  runId: string
  serviceId: string
  repoId: string
  startedAt: string
  branch: string
  dryRun: boolean
  durationMs: number
  steps: StepResult[]
  updated: boolean
  reason: string
  installRun: InstallRunResult
  restartRun: RestartRunResult
  healthStatus: RunReport["healthStatus"]
}): RunReport {
  return {
    runId: args.runId,
    serviceId: args.serviceId,
    repoId: args.repoId,
    startedAt: args.startedAt,
    durationMs: args.durationMs,
    branch: args.branch,
    dryRun: args.dryRun,
    updated: args.updated,
    reason: args.reason,
    installRun: args.installRun,
    restartRun: args.restartRun,
    healthStatus: args.healthStatus,
    steps: args.steps,
  }
}
