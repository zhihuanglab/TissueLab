import React, { useEffect, useState, useCallback, useRef, useMemo, ReactNode, createContext, useContext } from "react";
import { message } from "antd";
import Cookies from "js-cookie";
import { getOrCreateDeviceId } from "../utils/helperUtils";

type WsContextType = {
  socket: WebSocket | null;
  status: number | null;
  setWsUrl: (url: string) => void;
  clearSocket: () => void;
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
  const reconnectTimer = useRef<NodeJS.Timeout | null>(null);

  // Clean up WebSocket connection
  const clearSocket = useCallback(() => {
    if (socket) {
      console.log("Clearing socket connection.");
      socket.close();
      setSocket(null);
      setStatus(null);
    }
  }, [socket]);

  const connectWebSocket = useCallback(() => {
    if (wsUrl && !isConnecting.current) {
      console.log("Attempting WebSocket connection to:", wsUrl);
      isConnecting.current = true;
      
      // Get Firebase token for authentication
      const token = Cookies.get('tissuelab_token') || process.env.NEXT_PUBLIC_LOCAL_DEFAULT_TOKEN || 'local-default-token';
      
      // Get device ID for connection isolation
      const deviceId = getOrCreateDeviceId();
      
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
        if (reconnectTimer.current) {
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = null;
        }
      };

      ws.onerror = (error) => {
        console.error("WebSocket connection error:", error);
        message.error("WebSocket connection failed, please try again later");
        isConnecting.current = false;
        attemptReconnect();
      };

      ws.onclose = () => {
        console.log("WebSocket connection closed.");
        attemptReconnect();
      };

      ws.onmessage = (event) => {
        console.log("Received message:", event.data);
      };

      setSocket(ws);
    }
  }, [wsUrl, clearSocket]);

  const attemptReconnect = useCallback(() => {
    if (!reconnectTimer.current) {
      reconnectTimer.current = setTimeout(() => {
        console.log("Reconnecting WebSocket...");
        connectWebSocket();
      }, 3000); // Reconnect interval: 3 seconds
    }
  }, [connectWebSocket]);

  useEffect(() => {
    if (wsUrl) {
      connectWebSocket();
    }

    return () => {
      clearSocket();
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
    };
  }, [wsUrl, connectWebSocket, clearSocket]);

  const contextValue = useMemo(() => ({ socket, status, setWsUrl, clearSocket }), [socket, status]);

  return <WsContext.Provider value={contextValue}>{children}</WsContext.Provider>;
};

export const useWs = (url: string) => {
  const context = useContext(WsContext);
  if (!context) throw new Error("useWs must be used within a WsProvider");

  const { setWsUrl, ...rest } = context;

  useEffect(() => {
    console.log("Setting WebSocket URL to:", url);
    setWsUrl(url);
  }, [url, setWsUrl]);

  return rest;
};
