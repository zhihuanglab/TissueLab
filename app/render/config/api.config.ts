// Single local backend. The open edition talks to exactly one service (the
// local AI service, which also serves the file-manager / user / workflow
// routes the cloud "Ctrl Service" used to provide). `CTRL_SERVICE_API_ENDPOINT`
// is kept as an alias so the many call sites that still import it keep
// compiling; both names always resolve to the same URL.

// Cache for backend port
let cachedPort: number | null = null;
let portPromise: Promise<number> | null = null;

const DEFAULT_PORT = 5001;

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
        const finalPort = port || DEFAULT_PORT;
        cachedPort = finalPort;
        return finalPort;
      } catch (error) {
        console.warn('[CONFIG] Failed to get backend port from Electron, using default:', error);
        cachedPort = DEFAULT_PORT;
        return DEFAULT_PORT;
      }
    }
    cachedPort = DEFAULT_PORT;
    return DEFAULT_PORT;
  })();

  return portPromise;
}

// Initialize port immediately (non-blocking)
if (typeof window !== 'undefined') {
  getBackendPort().catch(() => {
    // Silently fail, will use default port
  });
}

export const AI_SERVICE_HOST = process.env.PUBLIC_AI_SERVICE_HOST || '127.0.0.1';

// Initialize endpoints with default port (will be updated when port is detected)
function getInitialApiEndpoint(): string {
  if (process.env.PUBLIC_AI_SERVICE_API_ENDPOINT) {
    return process.env.PUBLIC_AI_SERVICE_API_ENDPOINT;
  }
  const port = cachedPort ?? DEFAULT_PORT;
  return `http://127.0.0.1:${port}/api`;
}

function getInitialSocketEndpoint(): string {
  if (process.env.PUBLIC_AI_SERVICE_SOCKET_ENDPOINT) {
    return process.env.PUBLIC_AI_SERVICE_SOCKET_ENDPOINT;
  }
  const port = cachedPort ?? DEFAULT_PORT;
  return `ws://127.0.0.1:${port}/ws`;
}

// Export endpoints - these will use the detected port from Electron.
// Port is detected at startup, so we initialize with the default and update
// the live bindings when ready. Importers read the `export let` bindings by
// reference, so a template evaluated later picks up the new value.
export let AI_SERVICE_API_ENDPOINT: string = getInitialApiEndpoint();
export let AI_SERVICE_SOCKET_ENDPOINT: string = getInitialSocketEndpoint();
/** Alias of {@link AI_SERVICE_API_ENDPOINT} — there is only one backend. */
export let CTRL_SERVICE_API_ENDPOINT: string = AI_SERVICE_API_ENDPOINT;

// Update endpoints when port is detected (only happens once at startup)
getBackendPort().then(() => {
  const port = cachedPort ?? DEFAULT_PORT;
  if (!process.env.PUBLIC_AI_SERVICE_API_ENDPOINT) {
    AI_SERVICE_API_ENDPOINT = `http://127.0.0.1:${port}/api`;
  }
  if (!process.env.PUBLIC_AI_SERVICE_SOCKET_ENDPOINT) {
    AI_SERVICE_SOCKET_ENDPOINT = `ws://127.0.0.1:${port}/ws`;
  }
  CTRL_SERVICE_API_ENDPOINT = AI_SERVICE_API_ENDPOINT;
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

// ---------------------------------------------------------------------------
// TissueLab community (hosted)
//
// The open edition runs against one local service, but the Community page
// browses the shared TissueLab community, which lives on the hosted Ctrl
// Service. Every `/community/v1/*` call, the public author profiles, the
// email-code sign-in routes and the hosted file-manager upload behind
// community publishing go to this base URL; everything else stays local.
// The hosted server verifies the Firebase session token `apiFetch` attaches
// (anonymous sessions can browse; publishing needs a signed-in account).
export const COMMUNITY_API_ENDPOINT: string =
  process.env.PUBLIC_COMMUNITY_API_ENDPOINT || 'https://ctrl.vlm.ai/api';
