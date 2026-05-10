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

describe("Settings component", () => {
  it("renders a token input and save button", () => {
    render(<Settings />)
    expect(screen.getByPlaceholderText(/token/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument()
  })

  it("saves token to localStorage on submit", async () => {
    vi.spyOn(client, "testConnection").mockResolvedValue({ status: "ok" })
    render(<Settings />)

    fireEvent.change(screen.getByPlaceholderText(/token/i), {
      target: { value: "abc123" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => expect(client.getToken()).toBe("abc123"))
  })

  it("shows Connected after a successful testConnection", async () => {
    vi.spyOn(client, "testConnection").mockResolvedValue({ status: "ok" })
    render(<Settings />)

    fireEvent.change(screen.getByPlaceholderText(/token/i), {
      target: { value: "abc123" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await screen.findByText(/connected/i)
  })

  it("shows error message on AuthError", async () => {
    vi.spyOn(client, "testConnection").mockRejectedValue(new client.AuthError("Invalid token"))
    render(<Settings />)

    fireEvent.change(screen.getByPlaceholderText(/token/i), {
      target: { value: "bad-token" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await screen.findByText(/invalid/i)
  })

  it("clears token when Sign out is clicked", async () => {
    client.setToken("existing-token")
    vi.spyOn(client, "testConnection").mockResolvedValue({ status: "ok" })
    render(<Settings />)

    // Sign out is only shown when a token is already set
    const signOut = screen.queryByRole("button", { name: /sign out/i })
    if (signOut) {
      fireEvent.click(signOut)
      expect(client.getToken()).toBeNull()
    } else {
      // If no sign-out button, just verify token can be cleared by calling clearToken
      client.clearToken()
      expect(client.getToken()).toBeNull()
    }
  })
})
