import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { vi, beforeEach } from "vitest"
import ServiceCard from "../components/ServiceCard"
import type { ServiceSummary } from "../api/types"

function makeService(overrides: Partial<ServiceSummary> = {}): ServiceSummary {
  return {
    id: "my-api",
    displayName: "My API",
    port: 3000,
    healthUrl: "http://localhost:3000/health",
    healthMode: "ping",
    packageManager: "bun",
    scriptName: "dev",
    tags: ["api"],
    allowedIps: [],
    lifecycle: {
      state: "stopped",
      pid: null,
      startedAt: null,
      readySince: null,
      uptimeMs: null,
      command: null,
      lastError: null,
    },
    tailnet: null,
    ...overrides,
  }
}

beforeEach(() => vi.restoreAllMocks())

describe("ServiceCard", () => {
  it("renders displayName and port", () => {
    render(
      <ServiceCard
        repoId="my-repo"
        service={makeService()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRestart={vi.fn()}
        onUpdate={vi.fn()}
      />
    )
    expect(screen.getByText("My API")).toBeInTheDocument()
    expect(screen.getByText(/3000/)).toBeInTheDocument()
  })

  it("shows the lifecycle badge", () => {
    render(
      <ServiceCard
        repoId="my-repo"
        service={makeService({ lifecycle: { ...makeService().lifecycle, state: "running" } })}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRestart={vi.fn()}
        onUpdate={vi.fn()}
      />
    )
    expect(screen.getByText(/running/i)).toBeInTheDocument()
  })

  it("shows Tailnet URL when tailnet is set with a domain", () => {
    render(
      <ServiceCard
        repoId="my-repo"
        service={makeService({
          tailnet: {
            hostname: "myapi",
            domain: "example.ts.net",
            serveEnabled: false,
            serveMode: null,
            serveTarget: null,
          },
        })}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRestart={vi.fn()}
        onUpdate={vi.fn()}
      />
    )
    expect(screen.getByText(/myapi\.example\.ts\.net/)).toBeInTheDocument()
  })

  it("shows a stop toggle when state is running", () => {
    render(
      <ServiceCard
        repoId="my-repo"
        service={makeService({ lifecycle: { ...makeService().lifecycle, state: "running" } })}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRestart={vi.fn()}
        onUpdate={vi.fn()}
      />
    )
    expect(screen.getByRole("button", { name: "Stop service" })).not.toBeDisabled()
  })

  it("shows a start toggle when state is stopped", () => {
    render(
      <ServiceCard
        repoId="my-repo"
        service={makeService({ lifecycle: { ...makeService().lifecycle, state: "stopped" } })}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRestart={vi.fn()}
        onUpdate={vi.fn()}
      />
    )
    expect(screen.getByRole("button", { name: "Start service" })).not.toBeDisabled()
  })

  it("clicking the start toggle calls onStart with repoId and serviceId", async () => {
    const onStart = vi.fn().mockResolvedValue(undefined)
    render(
      <ServiceCard
        repoId="my-repo"
        service={makeService({ lifecycle: { ...makeService().lifecycle, state: "stopped" } })}
        onStart={onStart}
        onStop={vi.fn()}
        onRestart={vi.fn()}
        onUpdate={vi.fn()}
      />
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start service" }))
    })
    expect(onStart).toHaveBeenCalledWith("my-repo", "my-api")
  })

  it("clicking the stop toggle calls onStop with repoId and serviceId", async () => {
    const onStop = vi.fn().mockResolvedValue(undefined)
    render(
      <ServiceCard
        repoId="my-repo"
        service={makeService({ lifecycle: { ...makeService().lifecycle, state: "running" } })}
        onStart={vi.fn()}
        onStop={onStop}
        onRestart={vi.fn()}
        onUpdate={vi.fn()}
      />
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop service" }))
    })
    expect(onStop).toHaveBeenCalledWith("my-repo", "my-api")
  })

  it("all buttons are disabled while an action is pending", async () => {
    let resolveStart!: () => void
    const onStart = vi.fn().mockReturnValue(new Promise<void>((r) => { resolveStart = r }))

    render(
      <ServiceCard
        repoId="my-repo"
        service={makeService({ lifecycle: { ...makeService().lifecycle, state: "stopped" } })}
        onStart={onStart}
        onStop={vi.fn()}
        onRestart={vi.fn()}
        onUpdate={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Start service" }))

    // During pending, all buttons should be disabled
    await waitFor(() => {
      for (const btn of screen.getAllByRole("button")) {
        expect(btn).toBeDisabled()
      }
    })

    resolveStart()
  })

  it("shows lastError when state is failed", () => {
    render(
      <ServiceCard
        repoId="my-repo"
        service={makeService({
          lifecycle: {
            ...makeService().lifecycle,
            state: "failed",
            lastError: "Process exited with code 1",
          },
        })}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRestart={vi.fn()}
        onUpdate={vi.fn()}
      />
    )
    expect(screen.getByText(/Process exited with code 1/)).toBeInTheDocument()
  })
})
