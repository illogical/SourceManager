import { render, screen, fireEvent } from "@testing-library/react"
import { vi } from "vitest"
import { Play, RotateCcw, Square } from "lucide-react"
import ActionButton from "../components/ActionButton"

describe("ActionButton", () => {
  it("renders enabled by default", () => {
    render(<ActionButton label="Start" icon={Play} onClick={() => {}} />)
    expect(screen.getByRole("button", { name: "Start" })).not.toBeDisabled()
  })

  it("is disabled and shows loading text when loading=true", () => {
    render(<ActionButton label="Start" icon={Play} onClick={() => {}} loading />)
    const btn = screen.getByRole("button")
    expect(btn).toBeDisabled()
    expect(btn.textContent).toMatch(/…|loading|\.{3}/i)
  })

  it("is disabled when disabled=true", () => {
    render(<ActionButton label="Stop" icon={Square} onClick={() => {}} disabled />)
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled()
  })

  it("calls onClick once per click when enabled", () => {
    const handler = vi.fn()
    render(<ActionButton label="Restart" icon={RotateCcw} onClick={handler} />)
    fireEvent.click(screen.getByRole("button"))
    expect(handler).toHaveBeenCalledOnce()
  })

  it("does not call onClick when disabled", () => {
    const handler = vi.fn()
    render(<ActionButton label="Restart" icon={RotateCcw} onClick={handler} disabled />)
    fireEvent.click(screen.getByRole("button"))
    expect(handler).not.toHaveBeenCalled()
  })
})
