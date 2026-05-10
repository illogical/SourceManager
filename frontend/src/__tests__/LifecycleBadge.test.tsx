import { render, screen } from "@testing-library/react"
import LifecycleBadge from "../components/LifecycleBadge"
import type { LifecycleState } from "../api/types"

describe("LifecycleBadge", () => {
  const cases: Array<[LifecycleState, string]> = [
    ["running", "running"],
    ["starting", "starting"],
    ["stopped", "stopped"],
    ["failed", "failed"],
  ]

  for (const [state, label] of cases) {
    it(`renders "${label}" for state="${state}"`, () => {
      render(<LifecycleBadge state={state} />)
      expect(screen.getByText(new RegExp(label, "i"))).toBeInTheDocument()
    })
  }

  it("applies a distinct CSS class for each state", () => {
    const { container, rerender } = render(<LifecycleBadge state="running" />)
    const runningClass = container.firstElementChild?.className

    rerender(<LifecycleBadge state="failed" />)
    const failedClass = container.firstElementChild?.className

    expect(runningClass).not.toBe(failedClass)
  })
})
