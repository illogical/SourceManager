import { render, screen, act, within } from "@testing-library/react"
import { vi, beforeEach } from "vitest"
import RepoList from "../components/RepoList"
import * as client from "../api/client"
import type { RepoSummary } from "../api/types"

function makeRepo(id: string): RepoSummary {
  return {
    id,
    displayName: `Repo ${id}`,
    repoPath: `/dev/${id}`,
    defaultBranch: "main",
    services: [
      {
        id: `${id}-api`,
        displayName: `${id} API`,
        port: 3000,
        healthUrl: `http://localhost:3000/health`,
        healthMode: "ping",
        packageManager: "bun",
        scriptName: "dev",
        tags: [],
        allowedIps: [],
        lifecycle: { state: "stopped", pid: null, startedAt: null, readySince: null, uptimeMs: null, command: null, lastError: null },
        tailnet: null,
      },
    ],
  }
}

beforeEach(() => vi.restoreAllMocks())

describe("RepoList", () => {
  it("shows loading state initially", () => {
    vi.spyOn(client, "listRepos").mockReturnValue(new Promise(() => {}))
    render(<RepoList />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it("renders a group header per repo", async () => {
    vi.spyOn(client, "listRepos").mockResolvedValue({
      repos: [makeRepo("alpha"), makeRepo("beta")],
    })
    await act(async () => { render(<RepoList />) })
    expect(screen.getByText("Repo alpha")).toBeInTheDocument()
    expect(screen.getByText("Repo beta")).toBeInTheDocument()
  })

  it("renders a ServiceCard per service", async () => {
    vi.spyOn(client, "listRepos").mockResolvedValue({ repos: [makeRepo("gamma")] })
    await act(async () => { render(<RepoList />) })
    expect(screen.getByText("gamma API")).toBeInTheDocument()
  })

  it("includes stopping services in project counts and attention", async () => {
    const repo = makeRepo("delta")
    repo.services[0].lifecycle.state = "stopping"
    vi.spyOn(client, "listRepos").mockResolvedValue({ repos: [repo] })

    await act(async () => { render(<RepoList />) })

    expect(screen.getByText("Stopping")).toBeInTheDocument()
    expect(screen.getAllByText("1").length).toBeGreaterThan(0)
  })

  it("shows startup recovery progress and remaining timeout", async () => {
    vi.spyOn(client, "listRepos").mockResolvedValue({ repos: [makeRepo("recovering")] })
    vi.spyOn(client, "getHealth").mockResolvedValue({
      status: "ok",
      version: "1.0.0",
      uptimeMs: 100,
      applicationState: "running",
      startupReconciliation: {
        state: "running",
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 4_000).toISOString(),
        timeoutMs: 5_000,
        total: 2,
        completed: 1,
        remainingMs: 4_000,
        message: "Checking services",
      },
    })

    await act(async () => { render(<RepoList />) })

    expect(screen.getByText(/Restoring services/)).toBeInTheDocument()
    expect(screen.getByText(/1 of 2 checked/)).toBeInTheDocument()
    expect(screen.getByText(/4s remaining/)).toBeInTheDocument()
  })

  it("hides zero-value project status counts", async () => {
    vi.spyOn(client, "listRepos").mockResolvedValue({ repos: [makeRepo("epsilon")] })

    await act(async () => { render(<RepoList />) })

    const projectCounts = screen.getByLabelText("Repo epsilon status counts")
    expect(within(projectCounts).getByText("Stopped")).toBeInTheDocument()
    expect(within(projectCounts).queryByText("Running")).not.toBeInTheDocument()
    expect(within(projectCounts).queryByText("Starting")).not.toBeInTheDocument()
    expect(within(projectCounts).queryByText("Stopping")).not.toBeInTheDocument()
    expect(within(projectCounts).queryByText("Failed")).not.toBeInTheDocument()
  })

  it("shows error banner on AuthError", async () => {
    vi.spyOn(client, "listRepos").mockRejectedValue(new client.AuthError())
    await act(async () => { render(<RepoList />) })
    expect(screen.getByText(/token/i)).toBeInTheDocument()
  })

  it("calls listRepos once on mount", async () => {
    const spy = vi.spyOn(client, "listRepos").mockResolvedValue({ repos: [] })
    await act(async () => { render(<RepoList />) })
    expect(spy).toHaveBeenCalledOnce()
  })

  it("re-fetches after 10s interval", async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(client, "listRepos").mockResolvedValue({ repos: [] })
    await act(async () => { render(<RepoList />) })
    expect(spy).toHaveBeenCalledTimes(1)

    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(spy).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })
})
