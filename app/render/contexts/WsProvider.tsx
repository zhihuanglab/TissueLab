import React, { useEffect, useState, useCallback, useRef, useMemo, ReactNode, createContext, useContext } from "react";
import { toast } from "sonner";
import Cookies from "js-cookie";
import { getOrCreateDeviceId } from "../utils/common/device.utils";
import { forceRefreshAuthToken, getAuthToken } from "../utils/common/authToken";
// Reconnect policy. Kept as free functions rather than inlined into the
// provider so each rule has one definition and one place to change it.
export const MAX_RECONNECT_ATTEMPTS = 10;
export const RECONNECT_DELAY_MS = 5000;
export const CONNECT_TIMEOUT_MS = 15000;
/** Backoff ceiling. Ten attempts reach ~7 minutes of coverage instead of 50s. */
export const MAX_RECONNECT_DELAY_MS = 60_000;

/** Ignore a stale onclose that arrives after clearSocket / replace. */
export function shouldReconnectOnClose(gen: number, currentGen: number): boolean {
  return gen === currentGen;
}

/** Only an auth-policy close (1008) needs a Firebase token refresh. */
export function shouldRefreshAuthOnClose(code: number): boolean {
  return code === 1008;
}

/**
 * The delay used to be a flat 5s, so ten attempts gave up after 50 seconds and
 * told the user to reload the page. That is shorter than a cold start of the
 * local Python service (model load, zarr open) and far shorter than a laptop
 * waking from sleep, which is exactly when the socket is down — so the app read
 * as permanently broken after any lid close. Exponential backoff with a 60s
 * ceiling covers ~7 minutes over the same ten attempts while sending fewer
 * requests at a service that is still booting.
 */
export function planReconnectAttempt(currentAttempts: number): {
  nextAttempts: number;
  exhausted: boolean;
  delayMs: number;
} {
  if (currentAttempts >= MAX_RECONNECT_ATTEMPTS) {
    return { nextAttempts: currentAttempts, exhausted: true, delayMs: 0 };
  }
  const nextAttempts = currentAttempts + 1;
  const backoff = RECONNECT_DELAY_MS * 2 ** currentAttempts;
  // Jitter keeps every tab in a multi-window session from retrying in lockstep.
  const capped = Math.min(backoff, MAX_RECONNECT_DELAY_MS);
  const delayMs = Math.round(capped * (0.8 + Math.random() * 0.4));
  return { nextAttempts, exhausted: false, delayMs };
}

/** Abandon a socket that is still CONNECTING when the timeout fires. */
export function shouldAbortConnectTimeout(
  gen: number,
  currentGen: number,
  readyState: number,
): boolean {
  return gen === currentGen && readyState !== WebSocket.OPEN;
}

/** Everything the retry decision depends on, at the moment it is taken. */
type ConnectionSnapshot = {
  hasUrl: boolean;
  /** A socket object is currently held — open, or opening. */
  hasSocket: boolean;
  isConnecting: boolean;
  /** A reconnect is already scheduled. */
  hasPendingTimer: boolean;
  /** When the last connect attempt was started (epoch ms). */
  lastAttemptAt: number;
  now: number;
};

type RetryDecision =
  | { action: "skip" }
  | { action: "connect" }
  | { action: "defer"; delayMs: number };

/**
 * What to do when a signal says the thing we were waiting for changed — the
 * network came back, or the window became visible again after the OS throttled
 * its timers. Without this, a laptop that slept through the whole backoff woke
 * up to an exhausted counter and a "refresh the page" toast, even though the
 * connection would have succeeded on the next try.
 *
 * `hasSocket` / `isConnecting` are checked HERE rather than only at the moment
 * the signal arrives, because the deferred branch fires a timer later: by then
 * the connection may have come back on its own, and reconnecting anyway tears
 * down a healthy socket (connectWebSocket clears an existing one before it
 * dials). Both the immediate path and the timer callback must route through
 * this function — that is the whole reason it is a function.
 */
export function planRetryNow(snapshot: ConnectionSnapshot): RetryDecision {
  if (!snapshot.hasUrl) return { action: "skip" };
  if (snapshot.hasSocket || snapshot.isConnecting) return { action: "skip" };

  // Date.now() is wall clock, so an NTP correction or a VM resume can move it
  // BACKWARDS and make `since` negative. Deferring by RECONNECT_DELAY_MS - since
  // would then arm a timer the size of the jump — an hour-long stall during
  // which attemptReconnect also does nothing, because a timer is pending. A
  // clock that went backwards means the window is not measurable; just connect.
  const since = snapshot.now - snapshot.lastAttemptAt;
  if (since >= 0 && since < RECONNECT_DELAY_MS) {
    // Switching tabs fires visibilitychange, so these signals arrive as fast as
    // the user clicks. Honouring each one would replace the backoff with one
    // request per event. Drop it — unless nothing is queued at all, in which
    // case queue one at the boundary so an exhausted counter is not left
    // waiting for another signal that may never come.
    if (snapshot.hasPendingTimer) return { action: "skip" };
    return { action: "defer", delayMs: RECONNECT_DELAY_MS - since };
  }

  return { action: "connect" };
}

type WsContextType = {
  socket: WebSocket | null;
  status: number | null;
  setWsUrl: (url: string) => void;
};

const WsContext = createContext<WsContextType | null>(null);

interface WsProviderProps {
  children: ReactNode;
}

export const WsProvider: React.FC<WsProviderProps> = ({ children }) => {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [wsUrl, setWsUrl] = useState<string>("");

  const isConnecting = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  /** When the last connection attempt was made, for rate-limiting retryNow. */
  const lastAttemptAt = useRef(0);
  const pingInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /** Invalidates in-flight onclose after teardown / replace. */
  const connectGenRef = useRef(0);
  const wsUrlRef = useRef(wsUrl);
  const lastWsUrlRef = useRef("");
  const connectRef = useRef<(first?: boolean) => void | Promise<void>>(() => {});

  wsUrlRef.current = wsUrl;

  const clearSocket = useCallback(() => {
    connectGenRef.current += 1;
    isConnecting.current = false;
    if (pingInterval.current) {
      clearInterval(pingInterval.current);
      pingInterval.current = null;
    }
    if (connectTimeout.current) {
      clearTimeout(connectTimeout.current);
      connectTimeout.current = null;
    }
    const current = socketRef.current;
    if (!current) return;
    current.onopen = null;
    current.onclose = null;
    current.onerror = null;
    current.onmessage = null;
    try {
      current.close(1000, "client_clear");
    } catch {
      /* ignore */
    }
    socketRef.current = null;
    setSocket(null);
    setStatus(null);
  }, []);

  const attemptReconnect = useCallback(() => {
    if (reconnectTimer.current) return;
    const plan = planReconnectAttempt(reconnectAttempts.current);
    if (plan.exhausted) {
      toast.error(
        "Connection lost. Reconnecting when the network or window comes back \u2014 or refresh the page.",
        { duration: Infinity, id: "reconnect-failed" },
      );
      return;
    }

    reconnectAttempts.current = plan.nextAttempts;
    toast.warning(
      plan.nextAttempts === 1
        ? "Connection lost. Attempting to reconnect..."
        : `Reconnecting... (attempt ${plan.nextAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
      { duration: 3000, id: "reconnect-attempt" },
    );

    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      connectRef.current(false);
    }, plan.delayMs);
  }, []);

  /**
   * Retry on a signal that the thing we were waiting for changed — the network
   * came back, or the window became visible again after the OS throttled its
   * timers. The decision itself lives in planRetryNow; this only carries it out.
   *
   * The deferred branch re-enters this same function when its timer fires,
   * rather than connecting directly: by then the socket may have come back on
   * its own, and connectWebSocket clears an existing socket before it dials, so
   * connecting unconditionally would tear down a healthy connection. The
   * self-call is safe because useCallback([]) hands back one stable function.
   */
  const retryNow = useCallback(() => {
    const decision = planRetryNow({
      hasUrl: Boolean(wsUrlRef.current),
      hasSocket: Boolean(socketRef.current),
      isConnecting: isConnecting.current,
      hasPendingTimer: Boolean(reconnectTimer.current),
      lastAttemptAt: lastAttemptAt.current,
      now: Date.now(),
    });

    if (decision.action === "skip") return;

    if (decision.action === "defer") {
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        retryNow();
      }, decision.delayMs);
      return;
    }

    reconnectAttempts.current = 0;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    toast.dismiss("reconnect-failed");
    connectRef.current(false);
  }, []);

  const connectWebSocket = useCallback(
    async (isFirstAttempt = false) => {
      const url = wsUrlRef.current;
      if (!url || isConnecting.current) return;

      isConnecting.current = true;
      lastAttemptAt.current = Date.now();
      if (socketRef.current) {
        clearSocket();
        isConnecting.current = true;
      }
      const gen = ++connectGenRef.current;

      // The cookie is written with `expires: 30` days but holds a Firebase ID
      // token that dies in an hour, and the handshake cannot refresh it — so
      // reading it directly dialed with a dead token whenever no other caller
      // had refreshed it recently, and the server closed with 1008. The 1008
      // handler below then recovered, but only after two wasted handshakes.
      // getAuthToken() returns Firebase's cached token until close to expiry,
      // refreshes transparently past that, and writes the fresh cookie back for
      // the other direct readers. Cookie stays as the offline fallback.
      let token: string | null = null;
      try {
        token = await getAuthToken();
      } catch {
        /* Firebase unreachable — fall through to the cookie */
      }
      // Superseded while awaiting: a newer dial (or clearSocket) already ran,
      // and it owns isConnecting. Same rule as the stale-onclose guard.
      if (gen !== connectGenRef.current) return;
      token =
        token ||
        Cookies.get("tissuelab_token") ||
        process.env.NEXT_PUBLIC_LOCAL_DEFAULT_TOKEN ||
        "local-default-token";
      const deviceId = getOrCreateDeviceId();
      const urlWithParams = `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}&device_id=${encodeURIComponent(deviceId)}`;

      let ws: WebSocket;
      try {
        ws = new WebSocket(urlWithParams);
      } catch (err) {
        console.error("WebSocket constructor failed:", err);
        isConnecting.current = false;
        attemptReconnect();
        return;
      }

      // Overlay frames are binary. The default 'blob' forces every frame through
      // `await blob.arrayBuffer()` — an async hop whose resumption queues behind
      // whatever the main thread is doing, so under a pan the frame sat waiting
      // 130-300ms before a single byte was decompressed. 'arraybuffer' hands the
      // bytes over synchronously; the handler already accepts both.
      ws.binaryType = 'arraybuffer';

      socketRef.current = ws;
      setSocket(ws);

      if (connectTimeout.current) clearTimeout(connectTimeout.current);
      connectTimeout.current = setTimeout(() => {
        connectTimeout.current = null;
        if (!shouldAbortConnectTimeout(gen, connectGenRef.current, ws.readyState)) return;
        try {
          ws.close(4000, "connect_timeout");
        } catch {
          /* ignore */
        }
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        if (!shouldReconnectOnClose(gen, connectGenRef.current)) return;
        if (connectTimeout.current) {
          clearTimeout(connectTimeout.current);
          connectTimeout.current = null;
        }
        setStatus(ws.OPEN);
        isConnecting.current = false;
        // The exhausted toast has duration: Infinity, so it has to be taken
        // down explicitly once a later attempt succeeds.
        toast.dismiss("reconnect-failed");
        if (reconnectAttempts.current > 0) {
          toast.success("Connection restored successfully!", {
            duration: 3000,
            id: "reconnect-success",
          });
        }
        reconnectAttempts.current = 0;
        if (reconnectTimer.current) {
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = null;
        }
        if (pingInterval.current) clearInterval(pingInterval.current);
        pingInterval.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 30000);
      };

      ws.onerror = () => {
        if (reconnectAttempts.current === 0 && isFirstAttempt) {
          toast.error(
            "WebSocket connection failed. Please check your network connection and try again.",
            { duration: 5000, id: "connection-error" },
          );
        }
      };

      ws.onclose = async (event) => {
        // Who closed it, and why. Three parties can: this client (1000
        // client_clear / 4000 connect_timeout), the backend's stale-connection
        // sweeper (1001), and auth (1008). Without the code, a disconnect that
        // silently recovers by reconnecting is indistinguishable between them.
        if (event.code !== 1000) {
          console.warn(
            `[WebSocket] closed: code=${event.code} reason="${event.reason}" wasClean=${event.wasClean}`,
          );
        }
        if (socketRef.current === ws) socketRef.current = null;
        if (pingInterval.current) {
          clearInterval(pingInterval.current);
          pingInterval.current = null;
        }
        if (connectTimeout.current) {
          clearTimeout(connectTimeout.current);
          connectTimeout.current = null;
        }
        // Stale socket after replace/teardown — do not wipe the newer connection.
        if (!shouldReconnectOnClose(gen, connectGenRef.current)) return;

        setSocket(null);
        setStatus(null);
        isConnecting.current = false;

        if (shouldRefreshAuthOnClose(event.code)) {
          await forceRefreshAuthToken();
          if (!shouldReconnectOnClose(gen, connectGenRef.current)) return;
        }
        attemptReconnect();
      };
    },
    [attemptReconnect, clearSocket],
  );

  connectRef.current = connectWebSocket;

  useEffect(() => {
    const onToken = (event: CustomEvent<{ token: string }>) => {
      const token = event.detail?.token;
      const current = socketRef.current;
      if (token && current?.readyState === WebSocket.OPEN) {
        current.send(JSON.stringify({ type: "token_refresh", token }));
      }
    };
    window.addEventListener("tokenRefreshed", onToken as EventListener);
    return () => window.removeEventListener("tokenRefreshed", onToken as EventListener);
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") retryNow();
    };
    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", retryNow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [retryNow]);

  useEffect(() => {
    if (wsUrl && wsUrl !== lastWsUrlRef.current) {
      reconnectAttempts.current = 0;
      lastWsUrlRef.current = wsUrl;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      connectRef.current(true);
    }
    return () => {
      clearSocket();
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      lastWsUrlRef.current = "";
    };
  }, [wsUrl, clearSocket]);

  const contextValue = useMemo(
    () => ({ socket, status, setWsUrl }),
    [socket, status],
  );

  return <WsContext.Provider value={contextValue}>{children}</WsContext.Provider>;
};

export const useWs = (url: string) => {
  const context = useContext(WsContext);
  if (!context) throw new Error("useWs must be used within a WsProvider");

  const { setWsUrl, ...rest } = context;
  const lastUrlRef = useRef("");

  useEffect(() => {
    // Baked-in page URL only — never restore another tab's slot after cutover.
    if (url !== lastUrlRef.current) {
      lastUrlRef.current = url;
      setWsUrl(url);
    }
  }, [url, setWsUrl]);

  return rest;
};
