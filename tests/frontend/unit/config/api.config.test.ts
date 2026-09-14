import { afterEach, describe, expect, it, vi } from 'vitest';

/** Let the module's `getBackendPort().then(...)` continuation run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Fresh evaluation of the module so its port cache starts empty. */
async function loadConfig() {
  vi.resetModules();
  return import('@/config/api.config');
}

async function loadEndpoints() {
  vi.resetModules();
  return import('@/config/endpoints');
}

describe('config/api.config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (window as any).electron;
  });

  it('defaults to the single local service on port 5001, with CTRL as an alias of AI', async () => {
    vi.stubEnv('PUBLIC_AI_SERVICE_API_ENDPOINT', undefined);
    vi.stubEnv('PUBLIC_AI_SERVICE_SOCKET_ENDPOINT', undefined);

    const cfg = await loadConfig();

    expect(cfg.AI_SERVICE_API_ENDPOINT).toBe('http://127.0.0.1:5001/api');
    expect(cfg.AI_SERVICE_SOCKET_ENDPOINT).toBe('ws://127.0.0.1:5001/ws');
    expect(cfg.CTRL_SERVICE_API_ENDPOINT).toBe(cfg.AI_SERVICE_API_ENDPOINT);
    expect(cfg.AI_SERVICE_HOST).toBe('127.0.0.1');
    await expect(cfg.getAIServiceApiEndpoint()).resolves.toBe('http://127.0.0.1:5001/api');
    await expect(cfg.getAIServiceSocketEndpoint()).resolves.toBe('ws://127.0.0.1:5001/ws');
  });

  it('updates AI and CTRL endpoints together once Electron reports the backend port', async () => {
    vi.stubEnv('PUBLIC_AI_SERVICE_API_ENDPOINT', undefined);
    vi.stubEnv('PUBLIC_AI_SERVICE_SOCKET_ENDPOINT', undefined);
    const getBackendPort = vi.fn(async () => 6123);
    (window as any).electron = { getBackendPort };

    const cfg = await loadConfig();
    await expect(cfg.getAIServiceApiEndpoint()).resolves.toBe('http://127.0.0.1:6123/api');
    await flush();

    expect(cfg.AI_SERVICE_API_ENDPOINT).toBe('http://127.0.0.1:6123/api');
    expect(cfg.CTRL_SERVICE_API_ENDPOINT).toBe('http://127.0.0.1:6123/api');
    expect(cfg.AI_SERVICE_SOCKET_ENDPOINT).toBe('ws://127.0.0.1:6123/ws');
    // The port is resolved once and cached.
    expect(getBackendPort).toHaveBeenCalledTimes(1);
    await expect(cfg.getAIServiceSocketEndpoint()).resolves.toBe('ws://127.0.0.1:6123/ws');
    expect(getBackendPort).toHaveBeenCalledTimes(1);
  });

  it('build-time PUBLIC_* endpoints win over the Electron port and keep the alias in sync', async () => {
    vi.stubEnv('PUBLIC_AI_SERVICE_API_ENDPOINT', 'http://127.0.0.1:4242/api');
    vi.stubEnv('PUBLIC_AI_SERVICE_SOCKET_ENDPOINT', 'ws://127.0.0.1:4242/ws');
    (window as any).electron = { getBackendPort: vi.fn(async () => 6123) };

    const cfg = await loadConfig();
    await flush();

    expect(cfg.AI_SERVICE_API_ENDPOINT).toBe('http://127.0.0.1:4242/api');
    expect(cfg.CTRL_SERVICE_API_ENDPOINT).toBe('http://127.0.0.1:4242/api');
    expect(cfg.AI_SERVICE_SOCKET_ENDPOINT).toBe('ws://127.0.0.1:4242/ws');
    await expect(cfg.getAIServiceApiEndpoint()).resolves.toBe('http://127.0.0.1:4242/api');
  });

  it('falls back to the default port when Electron cannot report one', async () => {
    vi.stubEnv('PUBLIC_AI_SERVICE_API_ENDPOINT', undefined);
    vi.stubEnv('PUBLIC_AI_SERVICE_SOCKET_ENDPOINT', undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (window as any).electron = { getBackendPort: vi.fn(async () => { throw new Error('ipc down'); }) };

    const cfg = await loadConfig();
    await flush();

    expect(cfg.AI_SERVICE_API_ENDPOINT).toBe('http://127.0.0.1:5001/api');
    expect(cfg.CTRL_SERVICE_API_ENDPOINT).toBe('http://127.0.0.1:5001/api');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('COMMUNITY_API_ENDPOINT defaults to the hosted TissueLab community and honours PUBLIC_COMMUNITY_API_ENDPOINT', async () => {
    vi.stubEnv('PUBLIC_COMMUNITY_API_ENDPOINT', undefined);
    let cfg = await loadConfig();
    expect(cfg.COMMUNITY_API_ENDPOINT).toBe('https://ctrl.vlm.ai/api');
    // The hosted community is never the local service.
    expect(cfg.COMMUNITY_API_ENDPOINT).not.toBe(cfg.CTRL_SERVICE_API_ENDPOINT);

    vi.stubEnv('PUBLIC_COMMUNITY_API_ENDPOINT', 'http://127.0.0.1:9999/api');
    cfg = await loadConfig();
    expect(cfg.COMMUNITY_API_ENDPOINT).toBe('http://127.0.0.1:9999/api');
  });
});

describe('config/endpoints', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the user routes on the local service and sends the sign-in routes to the community', async () => {
    vi.stubEnv('PUBLIC_AI_SERVICE_API_ENDPOINT', 'http://127.0.0.1:5001/api');
    vi.stubEnv('PUBLIC_COMMUNITY_API_ENDPOINT', 'https://community.example/api');
    const ep = await loadEndpoints();

    expect(ep.initUserEndpoint()).toBe('http://127.0.0.1:5001/api/users/v1/init_me');
    expect(ep.initUserAssetsEndpoint()).toBe('http://127.0.0.1:5001/api/users/v1/me');
    expect(ep.updateUserProfileEndpoint()).toBe('http://127.0.0.1:5001/api/users/v1/update_profile');
    expect(ep.getUserAvatarEndpoint('local')).toBe('http://127.0.0.1:5001/api/users/local/avatar');

    expect(ep.sendCodeEndpoint()).toBe('https://community.example/api/users/v1/send_code');
    expect(ep.verifyCodeEndpoint()).toBe('https://community.example/api/users/v1/verify_code');
    expect(ep.partnerLoginEndpoint()).toBe('https://community.example/api/users/v1/partner_login');
  });
});
