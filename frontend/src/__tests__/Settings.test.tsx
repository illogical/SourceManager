import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { vi, beforeEach } from "vitest"
import Settings from "../components/Settings"
import * as client from "../api/client"

// Stub localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()
Object.defineProperty(globalThis, "localStorage", { value: localStorageMock })

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

// ── Unauthenticated view (no token stored) ────────────────────────────────────

describe("Settings — unauthenticated view", () => {
  it("renders a token input and save & test button", () => {
    render(<Settings />)
    expect(screen.getByPlaceholderText(/token/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /save & test/i })).toBeInTheDocument()
  })

  it("saves token to localStorage on submit", async () => {
    vi.spyOn(client, "testConnection").mockResolvedValue({ status: "ok" })
    render(<Settings />)

    fireEvent.change(screen.getByPlaceholderText(/token/i), {
      target: { value: "abc123" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save & test/i }))

    await waitFor(() => expect(client.getToken()).toBe("abc123"))
  })

  it("shows Connected after a successful testConnection", async () => {
    vi.spyOn(client, "testConnection").mockResolvedValue({ status: "ok" })
    render(<Settings />)

    fireEvent.change(screen.getByPlaceholderText(/token/i), {
      target: { value: "abc123" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save & test/i }))

    await screen.findByText(/connected/i)
  })

  it("shows error message on AuthError", async () => {
    vi.spyOn(client, "testConnection").mockRejectedValue(new client.AuthError("Invalid token"))
    render(<Settings />)

    fireEvent.change(screen.getByPlaceholderText(/token/i), {
      target: { value: "bad-token" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save & test/i }))

    await screen.findByText(/invalid/i)
  })
})

// ── Authenticated view (token stored) ────────────────────────────────────────

describe("Settings — authenticated view", () => {
  const mockConfig = {
    config: {
      server: { port: 17106, frontendPort: 17116, allowedIps: [] },
      repos: [
        {
          id: "my-repo",
          displayName: "My Repo",
          repoPath: "/dev/my-repo",
          defaultBranch: "main",
          services: [
            {
              id: "my-repo-web",
              displayName: "Web",
              packageManager: "bun",
              scriptName: "dev",
              installCommand: null,
              port: 3000,
              healthUrl: "http://localhost:3000/health",
              healthMode: "ping",
              tags: [],
              allowedIps: [],
            },
          ],
        },
      ],
    },
  }

  beforeEach(() => {
    client.setToken("existing-token")
  })

  it("shows Sign out button when token is set", async () => {
    vi.spyOn(client, "getEditableConfig").mockResolvedValue(mockConfig)
    render(<Settings />)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument()
    })
  })

  it("clears token when Sign out is clicked", async () => {
    vi.spyOn(client, "getEditableConfig").mockResolvedValue(mockConfig)
    render(<Settings />)

    await waitFor(() => screen.getByRole("button", { name: /sign out/i }))
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }))
    expect(client.getToken()).toBeNull()
  })

  it("renders config editor with repo display name after loading", async () => {
    vi.spyOn(client, "getEditableConfig").mockResolvedValue(mockConfig)
    render(<Settings />)

    await waitFor(() => {
      expect(screen.getAllByDisplayValue("My Repo").length).toBeGreaterThan(0)
    })
  })

  it("calls applyEditableConfig and invokes onSaved on successful save", async () => {
    vi.spyOn(client, "getEditableConfig").mockResolvedValue(mockConfig)
    vi.spyOn(client, "applyEditableConfig").mockResolvedValue({ success: true, changeCount: 0 })

    const onSaved = vi.fn()
    render(<Settings onSaved={onSaved} />)

    await waitFor(() => screen.getAllByRole("button", { name: /^save$/i }))
    fireEvent.click(screen.getAllByRole("button", { name: /^save$/i })[0])

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it("calls onClose when Cancel is clicked", async () => {
    vi.spyOn(client, "getEditableConfig").mockResolvedValue(mockConfig)

    const onClose = vi.fn()
    render(<Settings onClose={onClose} />)

    await waitFor(() => screen.getAllByRole("button", { name: /cancel/i }))
    fireEvent.click(screen.getAllByRole("button", { name: /cancel/i })[0])
    expect(onClose).toHaveBeenCalled()
  })

  it("calls onClose when Back to Dashboard is clicked", async () => {
    vi.spyOn(client, "getEditableConfig").mockResolvedValue(mockConfig)

    const onClose = vi.fn()
    render(<Settings onClose={onClose} />)

    await waitFor(() => screen.getByRole("button", { name: /dashboard/i }))
    fireEvent.click(screen.getByRole("button", { name: /dashboard/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
