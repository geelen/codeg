"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Loader2, ShieldAlert } from "lucide-react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  clearRemoteDesktopTransport,
  configureRemoteDesktopTransport,
  reconnectRemoteDesktopNow,
  type RemoteConnectionState,
} from "@/lib/transport"
import { resetBackendScopedStores } from "@/stores/backend-scoped-store-reset"
import { getRemoteWorkspaceConnection } from "@/lib/remote-workspace"
import { toErrorMessage } from "@/lib/app-error"
import type { RemoteWorkspaceConnection } from "@/lib/types"

interface RemoteConnectionContextValue {
  connection: RemoteWorkspaceConnection | null
  expired: boolean
  markExpired: () => void
}

interface RemoteConnectionGateState {
  connection: RemoteWorkspaceConnection | null
  loadedId: number | null
  loadedWindowId: string | null
  error: string | null
  connectionState: RemoteConnectionState
}

const RECONNECT_DIALOG_GRACE_MS = 4_000

const RemoteConnectionContext =
  createContext<RemoteConnectionContextValue | null>(null)

function createFallbackRemoteWindowId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `rw-${globalThis.crypto.randomUUID()}`
  }
  return `rw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function useRemoteConnection() {
  return useContext(RemoteConnectionContext)
}

/**
 * Best-effort reset of the backend-scoped module stores when the realm's backend
 * identity changes. A PASSIVE post-render effect (fires after commit, not a
 * render gate) that skips the initial mount, so today — where the identity is
 * immutable per realm (see the gate) — it never fires. Clears store STATE only;
 * it does NOT cancel in-flight backend fetches. Exported for tests; used only by
 * `RemoteConnectionGate`.
 */
export function useResetBackendScopedStoresOnIdentityChange(
  backendKey: string
): void {
  const prevKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevKeyRef.current
    prevKeyRef.current = backendKey
    if (prev !== null && prev !== backendKey) {
      resetBackendScopedStores()
    }
  }, [backendKey])
}

export function RemoteConnectionGate({ children }: { children: ReactNode }) {
  const t = useTranslations("RemoteWorkspace")
  const connectionT = useTranslations("WebConnection")
  const searchParams = useSearchParams()
  const rawId = searchParams.get("remoteConnectionId")
  const remoteConnectionId = rawId ? Number(rawId) : null
  const fallbackRemoteWindowId = useMemo(
    () => createFallbackRemoteWindowId(),
    []
  )
  const remoteWindowId =
    searchParams.get("remoteWindowId") || fallbackRemoteWindowId
  const [reconnectGeneration, setReconnectGeneration] = useState(0)
  const [reconnectDialogVisible, setReconnectDialogVisible] = useState(false)
  const [state, setState] = useState<RemoteConnectionGateState>({
    connection: null,
    loadedId: null,
    loadedWindowId: null,
    error: null,
    connectionState: "connected",
  })

  useEffect(() => {
    if (remoteConnectionId === null || !Number.isFinite(remoteConnectionId)) {
      clearRemoteDesktopTransport()
      return
    }

    let cancelled = false
    clearRemoteDesktopTransport()

    getRemoteWorkspaceConnection(remoteConnectionId)
      .then((next) => {
        if (cancelled) return
        configureRemoteDesktopTransport({
          id: next.id,
          name: next.name,
          baseUrl: next.base_url,
          token: next.token,
          windowInstanceId: remoteWindowId,
          onConnectionStateChange: (connectionState) => {
            if (cancelled) return
            setReconnectDialogVisible(false)
            setState((prev) => ({ ...prev, connectionState }))
          },
        })
        setState({
          connection: next,
          loadedId: remoteConnectionId,
          loadedWindowId: remoteWindowId,
          error: null,
          connectionState: "connected",
        })
      })
      .catch((err) => {
        if (cancelled) return
        clearRemoteDesktopTransport()
        setState({
          connection: null,
          loadedId: remoteConnectionId,
          loadedWindowId: remoteWindowId,
          error: toErrorMessage(err),
          connectionState: "connected",
        })
      })

    return () => {
      cancelled = true
    }
  }, [reconnectGeneration, remoteConnectionId, remoteWindowId])

  // ── Backend-identity invariant ─────────────────────────────────────────────
  // A workspace realm's backend identity — (remoteConnectionId, remoteWindowId),
  // both born from the URL — does not change for the realm's lifetime via any
  // SUPPORTED navigation path. It is enforced structurally, not asserted:
  // `open_remote_workspace` opens/focuses a distinct `remote-workspace-{id}`
  // window per connection (each its own JS realm), the main window is always
  // local, the web build hides the remote-workspace UI (isDesktop gate), and
  // `DeepLinkBootstrap` strips only deep-link params (folderId / conversationId),
  // which never coexist with the remote identity params in a `workspace?…` URL.
  // (settings / git windows are separate labels per remote id — different realms,
  // not in-place switches.) So the backend-scoped module singletons (workspace /
  // tab / conversation-runtime stores, and the remote transport itself) are
  // correctly scoped per realm — the old per-window Providers relied on exactly
  // this same window boundary.
  //
  // The guard below makes that invariant EXPLICIT: if the identity ever changes
  // within a live realm it best-effort resets the backend-scoped store STATE. It
  // is a TRIPWIRE, not a complete live-switch solution — it never fires today. A
  // real in-place backend switcher would additionally need to: epoch-invalidate
  // in-flight store fetches (this reset clears state but can't stop an in-flight
  // backend-A fetch from re-committing — see `resetConversationRuntimeStore` and
  // app-workspace `fetchFolders` / `refreshConversations`), reconfigure the
  // transport, handle the acp-agents refcount, and gate rendering (this is a
  // passive post-render effect, so a remote→local switch — which shows no loading
  // gate — would paint one stale commit before the reset runs).
  const backendKey = `${remoteConnectionId ?? "local"}::${remoteWindowId}`
  useResetBackendScopedStoresOnIdentityChange(backendKey)

  const value = useMemo(
    () => ({
      connection: state.connection,
      expired: state.connectionState === "unauthorized",
      markExpired: () =>
        setState((prev) => ({
          ...prev,
          connectionState: "unauthorized",
        })),
    }),
    [state.connection, state.connectionState]
  )

  const hasRemoteConnection =
    remoteConnectionId !== null && Number.isFinite(remoteConnectionId)
  const loadedCurrentRemoteWindow =
    state.loadedId === remoteConnectionId &&
    state.loadedWindowId === remoteWindowId
  const loading = hasRemoteConnection && !loadedCurrentRemoteWindow
  const error =
    hasRemoteConnection && loadedCurrentRemoteWindow ? state.error : null
  const connectionState =
    hasRemoteConnection && loadedCurrentRemoteWindow
      ? state.connectionState
      : "connected"
  const expired = connectionState === "unauthorized"
  const reconnecting = connectionState === "reconnecting"
  const connection =
    hasRemoteConnection && loadedCurrentRemoteWindow ? state.connection : null

  // Brief sleep/wake and Wi-Fi transitions should recover silently. Only show
  // the blocking reconnect UI if the outage lasts beyond the same grace period
  // used by the browser transport.
  useEffect(() => {
    if (!reconnecting) return
    const id = setTimeout(
      () => setReconnectDialogVisible(true),
      RECONNECT_DIALOG_GRACE_MS
    )
    return () => clearTimeout(id)
  }, [reconnecting])

  // Wake a sleeping backoff immediately when the machine comes online or the
  // remote window becomes visible again after laptop sleep.
  useEffect(() => {
    const reconnectIfNeeded = () => {
      if (state.connectionState === "reconnecting") {
        reconnectRemoteDesktopNow()
      }
    }
    const reconnectWhenVisible = () => {
      if (document.visibilityState === "visible") reconnectIfNeeded()
    }
    window.addEventListener("online", reconnectIfNeeded)
    document.addEventListener("visibilitychange", reconnectWhenVisible)
    return () => {
      window.removeEventListener("online", reconnectIfNeeded)
      document.removeEventListener("visibilitychange", reconnectWhenVisible)
    }
  }, [state.connectionState])

  const handleReconnectNow = () => {
    if (expired) {
      // Re-read the saved connection so a token updated in the manager is
      // picked up without requiring this window to be closed and recreated.
      setReconnectDialogVisible(false)
      setState({
        connection: null,
        loadedId: null,
        loadedWindowId: null,
        error: null,
        connectionState: "reconnecting",
      })
      setReconnectGeneration((value) => value + 1)
      return
    }
    reconnectRemoteDesktopNow()
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t("loadingConnection")}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-6 text-sm text-destructive">
        {t("connectionLoadFailed", { message: error })}
      </div>
    )
  }

  return (
    <RemoteConnectionContext.Provider value={value}>
      {children}
      {(expired || reconnectDialogVisible) && (
        <AlertDialog open onOpenChange={() => {}}>
          <AlertDialogContent
            onEscapeKeyDown={(event) => event.preventDefault()}
          >
            <AlertDialogHeader>
              <AlertDialogMedia>
                {expired ? (
                  <ShieldAlert className="text-destructive" />
                ) : (
                  <Loader2 className="animate-spin" />
                )}
              </AlertDialogMedia>
              <AlertDialogTitle>
                {expired
                  ? connectionT("sessionExpiredTitle")
                  : connectionT("disconnectedTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {expired
                  ? t("connectionExpired", { name: connection?.name ?? "" })
                  : connectionT("reconnectingDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button onClick={handleReconnectNow}>
                {connectionT("reconnectNow")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </RemoteConnectionContext.Provider>
  )
}
