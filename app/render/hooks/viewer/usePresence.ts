import { useEffect, useState, useRef } from "react";
import { AI_SERVICE_SOCKET_ENDPOINT } from "@/config/api.config";
import { getAuthToken } from "@/utils/common/authToken";

export interface PresenceUser {
  uid: string;
  name: string;
  color: string;
}

const PRESENCE_RECONNECT_DELAY_MS = 5000;

export const usePresence = (filePath: string | null) => {
  const [onlineUsers, setOnlineUsers] = useState<PresenceUser[]>([]);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!filePath || filePath === "undefined" || filePath === "null") {
      setOnlineUsers([]);
      return;
    }

    let finalUid = localStorage.getItem("last_user_id");
    if (!finalUid) {
      finalUid = "guest_" + Math.random().toString(36).substring(2, 9);
      localStorage.setItem("last_user_id", finalUid);
    }

    let finalName = "";
    const preferredName = localStorage.getItem(`preferred_name_${finalUid}`);
    if (preferredName) {
      finalName = preferredName;
    } else {
      try {
        const firebaseKey = Object.keys(localStorage).find((key) =>
          key.startsWith("firebase:authUser:"),
        );
        if (firebaseKey) {
          const fbData = JSON.parse(localStorage.getItem(firebaseKey) || "{}");
          finalName = fbData.displayName || fbData.email || "";
        }
      } catch (e) {
        console.warn("[Presence Hook] Failed to parse Firebase data", e);
      }
    }
    if (!finalName) finalName = "User_" + finalUid.substring(0, 4);

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      if (cancelled) return;

      const token = await getAuthToken();
      if (cancelled) return;
      if (!token) {
        setOnlineUsers([]);
        if (!cancelled) {
          reconnectTimer = setTimeout(() => {
            void connect();
          }, PRESENCE_RECONNECT_DELAY_MS);
        }
        return;
      }

      const baseUrl = String(AI_SERVICE_SOCKET_ENDPOINT).replace(/\/$/, "");
      const wsUrl =
        `${baseUrl}/presence` +
        `?file_path=${encodeURIComponent(filePath)}` +
        `&uid=${encodeURIComponent(finalUid)}` +
        `&name=${encodeURIComponent(finalName)}` +
        `&token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "sync_room") {
            setOnlineUsers(data.users);
          } else if (data.type === "user_joined") {
            setOnlineUsers((prev) =>
              prev.find((u) => u.uid === data.user.uid) ? prev : [...prev, data.user],
            );
          } else if (data.type === "user_left") {
            setOnlineUsers((prev) => prev.filter((u) => u.uid !== data.user_id));
          }
        } catch (err) {
          console.error("[Presence] Parse error:", err);
        }
      };
      ws.onerror = (error) => console.error("[Presence] Error:", error);
      ws.onclose = () => {
        if (socketRef.current === ws) socketRef.current = null;
        setOnlineUsers([]);
        if (!cancelled) {
          reconnectTimer = setTimeout(() => {
            void connect();
          }, PRESENCE_RECONNECT_DELAY_MS);
        }
      };
    };

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = socketRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
        socketRef.current = null;
      }
    };
  }, [filePath]);

  return { onlineUsers };
};
