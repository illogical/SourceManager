import { render, screen, act } from "@testing-library/react"
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
