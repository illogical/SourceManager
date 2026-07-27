import { fireEvent, render, screen } from "@testing-library/react"
import { vi } from "vitest"
import TailscalePanel from "../components/TailscalePanel"
import type { TailscaleServiceCheck } from "../api/types"

function status(overrides: Partial<TailscaleServiceCheck> = {}): TailscaleServiceCheck {
  return {
    serviceId: "devplanner-api",
    configured: true,
    desiredEnabled: true,
    serviceName: "svc:devplanner-api",
    expectedUrl: "https://devplanner-api.bangus-city.ts.net",
    localTarget: "http://127.0.0.1:17103",
    httpsPort: 443,
    status: "connected",
    lastError: null,
    lastWarning: null,
    operation: null,
    canToggle: true,
    ...overrides,
  }
}

describe("TailscalePanel", () => {
  it("shows the named URL, service name, and connected state without the local target", () => {
    render(
      <TailscalePanel
        lifecycleState="running"
        status={status()}
        pending={false}
        onToggle={vi.fn()}
      />,
    )
    expect(screen.getByText("Available")).toBeInTheDocument()
    expect(screen.getByText("devplanner-api.bangus-city.ts.net")).toBeInTheDocument()
    expect(screen.getByText("svc:devplanner-api")).toBeInTheDocument()
    expect(screen.queryByText(/127\.0\.0\.1:17103/)).not.toBeInTheDocument()
  })

  it("turns the desired state off when the checked switch is clicked", () => {
    const onToggle = vi.fn()
    render(
      <TailscalePanel
        lifecycleState="running"
        status={status()}
        pending={false}
        onToggle={onToggle}
      />,
    )
    fireEvent.click(screen.getByRole("switch", { name: "Tailnet exposure" }))
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it("keeps a desired-on switch checked and disabled without a repeated instruction while stopped", () => {
    render(
      <TailscalePanel
        lifecycleState="stopped"
        status={status({ status: "local_stopped", canToggle: false })}
        pending={false}
        onToggle={vi.fn()}
      />,
    )
    const toggle = screen.getByRole("switch", { name: "Tailnet exposure" })
    expect(toggle).toBeChecked()
    expect(toggle).toBeDisabled()
    expect(screen.queryByText(/start the service/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/will be restored/i)).not.toBeInTheDocument()
  })

  it("renders cleanup warnings", () => {
    render(
      <TailscalePanel
        lifecycleState="stopped"
        status={status({
          status: "local_stopped",
          canToggle: false,
          lastWarning: "Tailnet drain failed",
        })}
        pending={false}
        onToggle={vi.fn()}
      />,
    )
    expect(screen.getByText("Tailnet drain failed")).toBeInTheDocument()
  })
})
