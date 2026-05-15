import { useEffect, useState, useRef } from "react";
import { AI_SERVICE_SOCKET_ENDPOINT } from "@/constants/config";

export interface PresenceUser {
  uid: string;
  name: string;
  color: string;
}

export const usePresence = (filePath: string | null) => {
  const [onlineUsers, setOnlineUsers] = useState<PresenceUser[]>([]);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // 1. Basic Validation
    if (!filePath || filePath === "undefined" || filePath === "null") {
      setOnlineUsers([]);
      return;
    }

    // --- IDENTITY RESOLUTION START ---
    // Step A: Get the UID (The Anchor)
    let finalUid = localStorage.getItem("last_user_id");

    // If no UID exists, generate one and persist it
    if (!finalUid) {
      finalUid = "guest_" + Math.random().toString(36).substring(2, 9);
      localStorage.setItem("last_user_id", finalUid);
    }

    // Step B: Determine the Best Name
    let finalName = "";

    // Priority 1: Check for "preferred_name_{UID}"
    const preferredKey = `preferred_name_${finalUid}`;
    const preferredName = localStorage.getItem(preferredKey);

    if (preferredName) {
      finalName = preferredName;
    } else {
      // Priority 2 & 3: Check Firebase Storage for Display Name or Email
      try {
        // We search for the firebase key because the API key (middle part) might vary
        const firebaseKey = Object.keys(localStorage).find((key) =>
          key.startsWith("firebase:authUser:"),
        );

        if (firebaseKey) {
          const rawData = localStorage.getItem(firebaseKey);
          if (rawData) {
            const fbData = JSON.parse(rawData);
            // Priority 2: Firebase Display Name (e.g., "Shi Rolf")
            if (fbData.displayName) {
              finalName = fbData.displayName;
            }
            // Priority 3: Firebase Email (e.g., "105...@qq.com")
            else if (fbData.email) {
              finalName = fbData.email;
            }
          }
        }
      } catch (e) {
        console.warn("[Presence Hook] Failed to parse Firebase data", e);
      }
    }

    // Priority 4: Fallback to ID
    if (!finalName) {
      finalName = "User_" + finalUid.substring(0, 4);
    }

    // --- IDENTITY RESOLUTION END ---

    const connectToPresence = () => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        return;
      }

      // Construct URL
      const baseUrl = String(AI_SERVICE_SOCKET_ENDPOINT).replace(/\/$/, "");
      const wsUrl = `${baseUrl}/presence?file_path=${encodeURIComponent(filePath)}&uid=${finalUid}&name=${encodeURIComponent(finalName)}`;

      console.log(`[Presence Hook] Connecting as: ${finalName} (${finalUid})`);

      const ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "sync_room") {
            setOnlineUsers(data.users);
          } else if (data.type === "user_joined") {
            setOnlineUsers((prev) =>
              prev.find((u) => u.uid === data.user.uid)
                ? prev
                : [...prev, data.user],
            );
          } else if (data.type === "user_left") {
            setOnlineUsers((prev) =>
              prev.filter((u) => u.uid !== data.user_id),
            );
          }
        } catch (err) {
          console.error("[Presence] Parse error:", err);
        }
      };

      ws.onerror = (error) => console.error("[Presence] Error:", error);
      ws.onclose = () => setOnlineUsers([]);

      socketRef.current = ws;
    };

    connectToPresence();

    return () => {
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [filePath]);

  return { onlineUsers };
};
