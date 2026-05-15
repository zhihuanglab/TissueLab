import React, { useEffect, useState, useCallback, useRef, useMemo, ReactNode, createContext, useContext } from "react";
import { toast } from "sonner";
import Cookies from "js-cookie";
import { getOrCreateDeviceId } from "../utils/deviceUtils";
import { 
  saveWebSocketState, 
  getWebSocketState, 
  clearWebSocketState, 
  updateConnectionId,
  incrementReconnectAttempts,
  resetReconnectAttempts,
  shouldAttemptReconnect
} from "../utils/websocketPersistence";
import { forceRefreshAuthToken } from "../utils/common/authToken";

type WsContextType = {
  socket: WebSocket | null;
  status: number | null;
  setWsUrl: (url: string) => void;
  clearSocket: () => void;
  forceReconnect: () => void;
  refreshWebSocketToken: (newToken: string) => void;
  isReconnecting: boolean;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
};

const WsContext = createContext<WsContextType | null>(null);

interface WsProviderProps {
  children: ReactNode;
}

export const WsProvider: React.FC<WsProviderProps> = ({ children }) => {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [wsUrl, setWsUrl] = useState<string>("");
  const [isReconnecting, setIsReconnecting] = useState(false);
  const isConnecting = useRef(false);
  const reconnectTimer = useRef<NodeJS.Timeout | null>(null);
  const connectionId = useRef<string | null>(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 10;
  const pingInterval = useRef<NodeJS.Timeout | null>(null);

  // Clean up WebSocket connection
  const clearSocket = useCallback(() => {
    if (socket) {
      console.log("Clearing socket connection.");
      // Remove event listeners to prevent memory leaks
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
      setSocket(null);
      setStatus(null);
      connectionId.current = null;
    }
    
    // Clear ping interval
    if (pingInterval.current) {
      clearInterval(pingInterval.current);
      pingInterval.current = null;
    }
  }, [socket]);


  const connectWebSocketRef = useRef<((isFirstAttempt?: boolean) => void) | null>(null);

  const attemptReconnect = useCallback((isFirstAttempt = false) => {
    console.log(`attemptReconnect called: isFirstAttempt=${isFirstAttempt}, reconnectTimer.current=${!!reconnectTimer.current}, reconnectAttempts.current=${reconnectAttempts.current}, maxReconnectAttempts=${maxReconnectAttempts}`);
    if (!reconnectTimer.current && reconnectAttempts.current < maxReconnectAttempts) {
      reconnectAttempts.current += 1;
      incrementReconnectAttempts(); // Update persistence
      setIsReconnecting(true);
      const delay = 5000; // Fixed 5 second delay for all reconnection attempts
      
      console.log(`Reconnecting WebSocket... (attempt ${reconnectAttempts.current}/${maxReconnectAttempts}, delay: ${delay}ms)`);
      
      // Only show reconnection notification if this is not the first attempt
      if (!isFirstAttempt) {
        if (reconnectAttempts.current === 1) {
          toast.warning("Connection lost. Attempting to reconnect...", {
            duration: 3000,
            id: 'reconnect-attempt'
          });
        } else if (reconnectAttempts.current > 1) {
          toast.warning(`Reconnecting... (attempt ${reconnectAttempts.current}/${maxReconnectAttempts})`, {
            duration: 3000,
            id: 'reconnect-attempt'
          });
        }
      }
      
      reconnectTimer.current = setTimeout(() => {
        console.log(`Timeout completed, attempting reconnection now (attempt ${reconnectAttempts.current})`);
        console.log(`connectWebSocketRef.current exists:`, !!connectWebSocketRef.current);
        reconnectTimer.current = null;
        if (connectWebSocketRef.current) {
          console.log(`Calling connectWebSocketRef.current(false) for reconnection`);
          connectWebSocketRef.current(false); // Pass false for reconnection
        } else {
          console.error(`connectWebSocketRef.current is null!`);
        }
      }, delay);
    } else if (reconnectAttempts.current >= maxReconnectAttempts) {
      console.log("Max reconnection attempts reached. Stopping reconnection.");
      setIsReconnecting(false);
      toast.error("Connection lost. Please refresh the page to reconnect.", {
        duration: Infinity,
        id: 'reconnect-failed'
      });
    }
  }, []);

  const connectWebSocket = useCallback((isFirstAttempt = false) => {
    if (wsUrl && !isConnecting.current) {
      console.log("Attempting WebSocket connection to:", wsUrl);
      isConnecting.current = true;
      
      // Clear any existing connection before creating new one
      if (socket) {
        clearSocket();
      }
      
      // Get Firebase token for authentication
      const token = Cookies.get('tissuelab_token') || process.env.NEXT_PUBLIC_LOCAL_DEFAULT_TOKEN || 'local-default-token';
      
      // Get device ID for connection isolation
      const deviceId = getOrCreateDeviceId();
      
      // Save connection state for persistence
      saveWebSocketState({ url: wsUrl, deviceId });
      
      // Add token and device-id as query parameters for WebSocket authentication and isolation
      const urlWithParams = wsUrl.includes('?') 
        ? `${wsUrl}&token=${encodeURIComponent(token)}&device_id=${encodeURIComponent(deviceId)}`
        : `${wsUrl}?token=${encodeURIComponent(token)}&device_id=${encodeURIComponent(deviceId)}`;
      
      const ws = new WebSocket(urlWithParams);

      ws.onopen = () => {
        console.log("WebSocket connection established.");
        setSocket(ws);
        setStatus(ws.OPEN);
        isConnecting.current = false;
        setIsReconnecting(false);
        
        // Show success notification if this was a reconnection
        if (reconnectAttempts.current > 0) {
          toast.success("Connection restored successfully!", {
            duration: 3000,
            id: 'reconnect-success'
          });
        }
        
        reconnectAttempts.current = 0; // Reset reconnect attempts on successful connection
        resetReconnectAttempts(); // Reset in persistence
        
        if (reconnectTimer.current) {
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = null;
        }
        
        // Start ping interval to keep connection alive
        if (pingInterval.current) {
          clearInterval(pingInterval.current);
        }
        pingInterval.current = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send("ping");
          }
        }, 30000); // Send ping every 30 seconds
      };

      ws.onerror = (error) => {
        console.error("WebSocket connection error:", error);
        isConnecting.current = false;
        
        // Only show error message for initial connection attempts, not reconnects
        if (reconnectAttempts.current === 0) {
          toast.error("WebSocket connection failed. Please check your network connection and try again.", {
            duration: 5000,
            id: 'connection-error'
          });
        }
        
        // Always attempt reconnect on error, but with different behavior for first attempt
        if (isFirstAttempt) {
          // For first attempt, start reconnection process
          console.log("First connection failed, starting reconnection process");
          attemptReconnect(false);
        } else {
          // For reconnection attempts, continue reconnection
          attemptReconnect(false);
        }
      };

      ws.onclose = async (event) => {
        console.log("WebSocket connection closed.", event.code, event.reason);
        setSocket(null);
        setStatus(null);
        isConnecting.current = false;
        
        // Only attempt reconnect if it wasn't a manual close
        if (event.code !== 1000) {
          // For any abnormal closure, refresh token before reconnecting
          // This handles: 1006 (handshake rejection/network), 1008 (auth failure), and other errors
          // Token refresh is low-cost and ensures we have a valid token for reconnection
          console.log(`WebSocket closed with code ${event.code}, attempting token refresh before reconnect...`);
          
          const newToken = await forceRefreshAuthToken();
          if (newToken) {
            console.log("Token refreshed successfully, will reconnect with new token");
            if (event.code === 1008 || reconnectAttempts.current === 0) {
              toast.info("Session refreshed, reconnecting...", {
                duration: 2000,
                id: 'auth-refresh'
              });
            }
          } else {
            console.warn("Failed to refresh token, will still attempt reconnect");
          }
          
          // Always attempt reconnect on close
          if (isFirstAttempt) {
            console.log("First connection closed, starting reconnection process");
            attemptReconnect(false);
          } else {
            attemptReconnect(false);
          }
        }
      };

      ws.onmessage = (event) => {
        try {
          // Check if this is a pong message first
          if (event.data === 'pong') {
            return;
          }
          
          const data = JSON.parse(event.data);
          console.log("Received message:", data);
          
          // Handle connection status messages
          if (data.type === 'status' && data.connection_id) {
            connectionId.current = data.connection_id;
            updateConnectionId(data.connection_id);
            console.log("Connection ID received:", data.connection_id);
          }
        } catch (error) {
          console.log("Received message (non-JSON):", event.data);
        }
      };

      setSocket(ws);
    }
  }, [wsUrl, clearSocket, socket, attemptReconnect]);

  // Set the ref after connectWebSocket is defined
  connectWebSocketRef.current = connectWebSocket;

  const forceReconnect = useCallback(() => {
    console.log("Force reconnecting WebSocket...");
    reconnectAttempts.current = 0; // Reset attempts
    resetReconnectAttempts(); // Reset in persistence
    setIsReconnecting(false);
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (pingInterval.current) {
      clearInterval(pingInterval.current);
      pingInterval.current = null;
    }
    clearSocket();
    setTimeout(() => {
      connectWebSocket(false); // Pass false for force reconnect
    }, 100); // Small delay to ensure cleanup
  }, [connectWebSocket, clearSocket]);

  // Send token refresh message through WebSocket (no reconnection needed)
  const refreshWebSocketToken = useCallback((newToken: string) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      console.log("[WebSocket] Sending token refresh message to server");
      socket.send(JSON.stringify({
        type: 'token_refresh',
        token: newToken
      }));
    } else {
      console.log("[WebSocket] Cannot refresh token - socket not connected");
    }
  }, [socket]);

  // Listen for token refresh events from UserInfoProvider
  useEffect(() => {
    const handleTokenRefreshed = (event: CustomEvent<{ token: string }>) => {
      const newToken = event.detail?.token;
      if (newToken) {
        refreshWebSocketToken(newToken);
      }
    };

    window.addEventListener('tokenRefreshed', handleTokenRefreshed as EventListener);
    return () => {
      window.removeEventListener('tokenRefreshed', handleTokenRefreshed as EventListener);
    };
  }, [refreshWebSocketToken]);

  // Initialize connection on mount
  useEffect(() => {
    const initializeConnection = () => {
      // Check if we should attempt to restore connection
      const shouldRestore = shouldAttemptReconnect();
      const savedState = getWebSocketState();
      
      if (shouldRestore && savedState && savedState.url) {
        console.log("Restoring WebSocket connection from saved state");
        setWsUrl(savedState.url);
      }
    };

    initializeConnection();
  }, []);

  const lastWsUrlRef = useRef<string>("");
  const connectWebSocketRef2 = useRef<((isFirstAttempt?: boolean) => void) | null>(null);
  const clearSocketRef2 = useRef<(() => void) | null>(null);

  // Set refs
  connectWebSocketRef2.current = connectWebSocket;
  clearSocketRef2.current = clearSocket;

  useEffect(() => {
    if (wsUrl) {
      // Only reset reconnect attempts when URL actually changes
      if (wsUrl !== lastWsUrlRef.current) {
        console.log("WebSocket URL changed, resetting reconnect attempts");
        reconnectAttempts.current = 0;
        resetReconnectAttempts();
        setIsReconnecting(false);
        lastWsUrlRef.current = wsUrl;
        
        // Clear any existing timer
        if (reconnectTimer.current) {
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = null;
        }
        
        // For new URL, connect immediately without delay
        console.log("First connection attempt for new URL, connecting immediately");
        if (connectWebSocketRef2.current) {
          connectWebSocketRef2.current(true);
        }
      }
    }

    return () => {
      if (clearSocketRef2.current) {
        clearSocketRef2.current();
      }
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
    };
  }, [wsUrl]);

  const contextValue = useMemo(() => ({ 
    socket, 
    status, 
    setWsUrl, 
    clearSocket,
    forceReconnect,
    refreshWebSocketToken,
    isReconnecting,
    reconnectAttempts: reconnectAttempts.current,
    maxReconnectAttempts
  }), [socket, status, forceReconnect, refreshWebSocketToken, isReconnecting, clearSocket]);

  return <WsContext.Provider value={contextValue}>{children}</WsContext.Provider>;
};

export const useWs = (url: string) => {
  const context = useContext(WsContext);
  if (!context) throw new Error("useWs must be used within a WsProvider");

  const { setWsUrl, ...rest } = context;
  const lastUrlRef = useRef<string>("");

  useEffect(() => {
    // Only set URL if it's different
    if (url !== lastUrlRef.current) {
      console.log("Setting WebSocket URL to:", url);
      lastUrlRef.current = url;
      setWsUrl(url);
    }
  }, [url, setWsUrl]);

  return rest;
};
