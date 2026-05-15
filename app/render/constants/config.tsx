// Cache for backend port
let cachedPort: number | null = null;
let portPromise: Promise<number> | null = null;

// Get backend port from Electron if available, otherwise use default
async function getBackendPort(): Promise<number> {
  if (cachedPort !== null) {
    return cachedPort;
  }

  if (portPromise) {
    return portPromise;
  }

  portPromise = (async (): Promise<number> => {
    if (typeof window !== 'undefined' && (window as any).electron?.getBackendPort) {
      try {
        const port = await (window as any).electron.getBackendPort();
        const finalPort = port || 5001;
        cachedPort = finalPort;
        return finalPort;
      } catch (error) {
        console.warn('[CONFIG] Failed to get backend port from Electron, using default:', error);
        const finalPort = 5001;
        cachedPort = finalPort;
        return finalPort;
      }
    }
    const finalPort = 5001;
    cachedPort = finalPort;
    return finalPort;
  })();

  return portPromise;
}

// Initialize port immediately (non-blocking)
if (typeof window !== 'undefined') {
  getBackendPort().catch(() => {
    // Silently fail, will use default 5001
  });
}

export const AI_SERVICE_HOST = process.env.PUBLIC_AI_SERVICE_HOST || '127.0.0.1';
export const CTRL_SERVICE_HOST = process.env.PUBLIC_CTRL_SERVICE_HOST || '127.0.0.1';
export const CTRL_SERVICE_API_ENDPOINT = process.env.PUBLIC_CTRL_SERVICE_API_ENDPOINT || 'http://127.0.0.1:5002/api';

/**
 * Local LLM agent endpoint (the TissueLab AI service exposes `/api/agent/*` so
 * that agent traffic does not have to round-trip through the cloud ctrl service).
 *
 * Falls back to the AI service endpoint at runtime if the env var is not set,
 * which is the common case for local development.
 */
export const AGENT_API_ENDPOINT =
  process.env.PUBLIC_AGENT_API_ENDPOINT ||
  process.env.PUBLIC_AI_SERVICE_API_ENDPOINT ||
  'http://127.0.0.1:5001/api';

/** From `.env.*` `DEBUG_ENV`, forwarded in `next.config` `env` (required for client bundles). */
export const DEBUG_ENV = process.env.DEBUG_ENV ?? '';

/**
 * View-act / behavior logging (mouse, viewport, upload to `/behavior/v1/*`).
 * Disabled when `DEBUG_ENV=prod` (see `.env.production`).
 */
export const ENABLE_BEHAVIOR_VIEW_ACT_LOGGING = DEBUG_ENV !== 'prod';

// Initialize endpoints with default port (will be updated when port is detected)
function getInitialApiEndpoint(): string {
  if (process.env.PUBLIC_AI_SERVICE_API_ENDPOINT) {
    return process.env.PUBLIC_AI_SERVICE_API_ENDPOINT;
  }
  const port = cachedPort ?? 5001;
  return `http://127.0.0.1:${port}/api`;
}

function getInitialSocketEndpoint(): string {
  if (process.env.PUBLIC_AI_SERVICE_SOCKET_ENDPOINT) {
    return process.env.PUBLIC_AI_SERVICE_SOCKET_ENDPOINT;
  }
  const port = cachedPort ?? 5001;
  return `ws://127.0.0.1:${port}/ws`;
}

// Export endpoints - these will use the detected port from Electron
// Port is detected at startup, so we initialize with default and update when ready
export let AI_SERVICE_API_ENDPOINT: string = getInitialApiEndpoint();
export let AI_SERVICE_SOCKET_ENDPOINT: string = getInitialSocketEndpoint();

// Update endpoints when port is detected (only happens once at startup)
getBackendPort().then(() => {
  if (!process.env.PUBLIC_AI_SERVICE_API_ENDPOINT) {
    const port = cachedPort ?? 5001;
    AI_SERVICE_API_ENDPOINT = `http://127.0.0.1:${port}/api`;
  }
  if (!process.env.PUBLIC_AI_SERVICE_SOCKET_ENDPOINT) {
    const port = cachedPort ?? 5001;
    AI_SERVICE_SOCKET_ENDPOINT = `ws://127.0.0.1:${port}/ws`;
  }
}).catch(() => {
  // Keep default values
});

// Async getters for when port is needed immediately (before cache is ready)
export async function getAIServiceApiEndpoint(): Promise<string> {
  if (process.env.PUBLIC_AI_SERVICE_API_ENDPOINT) {
    return process.env.PUBLIC_AI_SERVICE_API_ENDPOINT;
  }
  const port = await getBackendPort();
  return `http://127.0.0.1:${port}/api`;
}

export async function getAIServiceSocketEndpoint(): Promise<string> {
  if (process.env.PUBLIC_AI_SERVICE_SOCKET_ENDPOINT) {
    return process.env.PUBLIC_AI_SERVICE_SOCKET_ENDPOINT;
  }
  const port = await getBackendPort();
  return `ws://127.0.0.1:${port}/ws`;
}

// Viewer constants
// ZOOM_SCALE removed: OSD image coordinates now equal real pixel coordinates (no 16x virtual canvas)
