interface WebSocketConnectionState {
  url: string;
  deviceId: string;
  connectionId?: string;
  lastConnected: number;
  reconnectAttempts: number;
}

const WEBSOCKET_STATE_KEY = 'tissuelab_websocket_state';

export const saveWebSocketState = (state: Partial<WebSocketConnectionState>) => {
  try {
    const existingState = getWebSocketState();
    const newState = { ...existingState, ...state, lastConnected: Date.now() };
    localStorage.setItem(WEBSOCKET_STATE_KEY, JSON.stringify(newState));
  } catch (error) {
    console.warn('Failed to save WebSocket state:', error);
  }
};

export const getWebSocketState = (): WebSocketConnectionState | null => {
  try {
    const stored = localStorage.getItem(WEBSOCKET_STATE_KEY);
    if (!stored) return null;
    
    const state = JSON.parse(stored);
    
    // Check if state is not too old (24 hours)
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    if (Date.now() - state.lastConnected > maxAge) {
      clearWebSocketState();
      return null;
    }
    
    return state;
  } catch (error) {
    console.warn('Failed to get WebSocket state:', error);
    return null;
  }
};

export const clearWebSocketState = () => {
  try {
    localStorage.removeItem(WEBSOCKET_STATE_KEY);
  } catch (error) {
    console.warn('Failed to clear WebSocket state:', error);
  }
};

export const updateConnectionId = (connectionId: string) => {
  const state = getWebSocketState();
  if (state) {
    saveWebSocketState({ connectionId });
  }
};

export const incrementReconnectAttempts = () => {
  const state = getWebSocketState();
  if (state) {
    saveWebSocketState({ reconnectAttempts: (state.reconnectAttempts || 0) + 1 });
  }
};

export const resetReconnectAttempts = () => {
  const state = getWebSocketState();
  if (state) {
    saveWebSocketState({ reconnectAttempts: 0 });
  }
};

export const shouldAttemptReconnect = (): boolean => {
  const state = getWebSocketState();
  if (!state) return true;
  
  const maxAttempts = 5;
  const maxAge = 5 * 60 * 1000; // 5 minutes
  
  // Don't attempt if too many attempts or too old
  if (state.reconnectAttempts >= maxAttempts) return false;
  if (Date.now() - state.lastConnected > maxAge) return false;
  
  return true;
};
