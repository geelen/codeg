import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const remoteMocks = vi.hoisted(() => ({
  clearRemoteDesktopTransport: vi.fn(),
  configureRemoteDesktopTransport: vi.fn(),
  reconnectRemoteDesktopNow: vi.fn(),
  getRemoteWorkspaceConnection: vi.fn(),
  connectionStateCallback: null as
    | ((state: "connected" | "reconnecting" | "unauthorized") => void)
    | null,
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams("remoteConnectionId=7&remoteWindowId=test-window"),
}))

vi.mock("@/lib/transport", () => ({
  clearRemoteDesktopTransport: remoteMocks.clearRemoteDesktopTransport,
  configureRemoteDesktopTransport: remoteMocks.configureRemoteDesktopTransport,
  reconnectRemoteDesktopNow: remoteMocks.reconnectRemoteDesktopNow,
}))

vi.mock("@/lib/remote-workspace", () => ({
  getRemoteWorkspaceConnection: remoteMocks.getRemoteWorkspaceConnection,
}))

// Capture the registry's reset. The hook under test is the only part of the gate
// exercised here, so the other gate deps (next/navigation, next-intl, transport)
// load but are never invoked.
const mockResetBackendScopedStores = vi.fn()
vi.mock("@/stores/backend-scoped-store-reset", () => ({
  resetBackendScopedStores: () => mockResetBackendScopedStores(),
  registerBackendScopedStoreReset: vi.fn(),
  __clearRegisteredBackendScopedStoreResets: vi.fn(),
}))

import enMessages from "@/i18n/messages/en.json"
import {
  RemoteConnectionGate,
  useResetBackendScopedStoresOnIdentityChange,
} from "./remote-connection-context"

afterEach(() => mockResetBackendScopedStores.mockClear())

describe("useResetBackendScopedStoresOnIdentityChange", () => {
  it("does NOT reset on initial mount", () => {
    renderHook(({ k }) => useResetBackendScopedStoresOnIdentityChange(k), {
      initialProps: { k: "5::win-a" },
    })
    expect(mockResetBackendScopedStores).not.toHaveBeenCalled()
  })

  it("does NOT reset when the identity is unchanged across rerenders", () => {
    const { rerender } = renderHook(
      ({ k }) => useResetBackendScopedStoresOnIdentityChange(k),
      { initialProps: { k: "5::win-a" } }
    )
    rerender({ k: "5::win-a" })
    rerender({ k: "5::win-a" })
    expect(mockResetBackendScopedStores).not.toHaveBeenCalled()
  })

  it("resets exactly once when the backend identity changes, then stays quiet", () => {
    const { rerender } = renderHook(
      ({ k }) => useResetBackendScopedStoresOnIdentityChange(k),
      { initialProps: { k: "5::win-a" } }
    )

    rerender({ k: "7::win-b" })
    expect(mockResetBackendScopedStores).toHaveBeenCalledTimes(1)

    // Stable again at the new identity → no further resets.
    rerender({ k: "7::win-b" })
    expect(mockResetBackendScopedStores).toHaveBeenCalledTimes(1)
  })

  it("resets again on each subsequent distinct change (incl. local→remote)", () => {
    const { rerender } = renderHook(
      ({ k }) => useResetBackendScopedStoresOnIdentityChange(k),
      { initialProps: { k: "local::win-a" } }
    )
    rerender({ k: "5::win-a" }) // local → backend 5: reset 1
    rerender({ k: "9::win-a" }) // backend 5 → 9: reset 2
    expect(mockResetBackendScopedStores).toHaveBeenCalledTimes(2)
  })

  it("resets on a remote→local transition too (the hook is symmetric)", () => {
    const { rerender } = renderHook(
      ({ k }) => useResetBackendScopedStoresOnIdentityChange(k),
      { initialProps: { k: "5::win-a" } }
    )
    rerender({ k: "local::win-a" }) // backend 5 → local: reset
    expect(mockResetBackendScopedStores).toHaveBeenCalledTimes(1)
  })
})

function renderGate() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RemoteConnectionGate>
        <div>Remote workspace content</div>
      </RemoteConnectionGate>
    </NextIntlClientProvider>
  )
}

async function finishInitialConnection() {
  await act(async () => {})
  expect(screen.getByText("Remote workspace content")).toBeInTheDocument()
  expect(remoteMocks.connectionStateCallback).not.toBeNull()
}

describe("RemoteConnectionGate reconnect behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    remoteMocks.connectionStateCallback = null
    remoteMocks.clearRemoteDesktopTransport.mockReset()
    remoteMocks.reconnectRemoteDesktopNow.mockReset()
    remoteMocks.getRemoteWorkspaceConnection.mockReset()
    remoteMocks.configureRemoteDesktopTransport.mockReset()
    remoteMocks.getRemoteWorkspaceConnection.mockResolvedValue({
      id: 7,
      name: "Devcontainer",
      base_url: "http://127.0.0.1:3080",
      token: "token",
    })
    remoteMocks.configureRemoteDesktopTransport.mockImplementation((config) => {
      remoteMocks.connectionStateCallback = config.onConnectionStateChange
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("retries automatically and offers an immediate reconnect after the grace period", async () => {
    renderGate()
    await finishInitialConnection()

    act(() => remoteMocks.connectionStateCallback?.("reconnecting"))
    expect(screen.queryByText("Connection lost")).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(4_000))
    expect(screen.getByText("Connection lost")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Reconnect now" }))
    expect(remoteMocks.reconnectRemoteDesktopNow).toHaveBeenCalledTimes(1)

    act(() => remoteMocks.connectionStateCallback?.("connected"))
    expect(screen.queryByText("Connection lost")).not.toBeInTheDocument()
    expect(screen.getByText("Remote workspace content")).toBeInTheDocument()
  })

  it("nudges reconnect immediately when the machine comes online", async () => {
    renderGate()
    await finishInitialConnection()

    act(() => remoteMocks.connectionStateCallback?.("reconnecting"))
    remoteMocks.reconnectRemoteDesktopNow.mockClear()
    act(() => window.dispatchEvent(new Event("online")))

    expect(remoteMocks.reconnectRemoteDesktopNow).toHaveBeenCalledTimes(1)
  })

  it("reloads the saved connection in place after an explicit 401", async () => {
    renderGate()
    await finishInitialConnection()

    act(() => remoteMocks.connectionStateCallback?.("unauthorized"))
    expect(screen.getByText("Session expired")).toBeInTheDocument()
    expect(
      screen.getByText(
        'Remote connection "Devcontainer" is expired. Update its token and reload this window.'
      )
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Reconnect now" }))
    await act(async () => {})

    expect(remoteMocks.getRemoteWorkspaceConnection).toHaveBeenCalledTimes(2)
    expect(remoteMocks.configureRemoteDesktopTransport).toHaveBeenCalledTimes(2)
    expect(screen.queryByText("Session expired")).not.toBeInTheDocument()
    expect(screen.getByText("Remote workspace content")).toBeInTheDocument()
  })
})
