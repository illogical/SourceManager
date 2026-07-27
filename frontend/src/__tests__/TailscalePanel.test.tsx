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
  it("shows the named URL, target, and connected state", () => {
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
    expect(screen.getByText(/127\.0\.0\.1:17103/)).toBeInTheDocument()
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

  it("keeps a desired-on switch checked but disabled while stopped", () => {
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
    expect(screen.getByText(/will be restored when the service starts/i)).toBeInTheDocument()
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
