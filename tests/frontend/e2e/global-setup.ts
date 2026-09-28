/**
 * Playwright global setup: boots the whole local stack once per run.
 *
 *   1. the mock OpenAI-compatible LLM  (tests/smoke/mock_llm_server.py) and the
 *      scripted Responses server the discovery loop talks to
 *      (tests/smoke/mock_discovery_llm.py, via DISCOVERY_BASE_URL)
 *   2. the Python service              (app/service/main.py) on a free port,
 *      against a temporary service root with the test slide copied in
 *   3. a mock of the hosted TissueLab community (`mock-community-server.ts`,
 *      in-process) that the renderer gets as PUBLIC_COMMUNITY_API_ENDPOINT
 *   4. the Next.js renderer            (`next dev`, or `next build && next start`
 *      with TL_E2E_BUILD=1) pointed at that service
 *
 * The addresses are handed to the tests through `process.env.TL_E2E_*`
 * (Playwright forwards the environment to its worker processes); see
 * `fixtures.ts`. The returned function tears everything down.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { startMockCommunityServer, type MockCommunityServer } from './mock-community-server';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RENDER_ROOT = path.join(REPO_ROOT, 'app', 'render');
const SERVICE_DIR = path.join(REPO_ROOT, 'app', 'service');
const MOCK_LLM_SCRIPT = path.join(REPO_ROOT, 'tests', 'smoke', 'mock_llm_server.py');
const MOCK_DISCOVERY_LLM_SCRIPT = path.join(REPO_ROOT, 'tests', 'smoke', 'mock_discovery_llm.py');
// Seconds the discovery mock waits before each reply, so a test can stop a run midway.
const DISCOVERY_LLM_DELAY_SEC = '1';
const NEXT_BIN = path.join(RENDER_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
// `next dev` writes .next/dev/types/validator.ts, which redeclares the same global
// types as .next/types/validator.ts from `next build`; with both present
// `tsc --noEmit -p tsconfig.json` fails (Next 16 includes both directories).
// The teardown removes the dev copy again when this run created it.
const NEXT_DEV_TYPES = path.join(RENDER_ROOT, '.next', 'dev', 'types');

const LOCAL_USER_ID = 'local';

const BACKEND_READY_TIMEOUT_MS = 180_000;
const RENDERER_READY_TIMEOUT_MS = 240_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message: string) {
  console.log(`[e2e-setup] ${message}`);
}

function resolvePython(): string {
  if (process.env.TL_PYTHON) return process.env.TL_PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function tail(file: string | undefined, lines = 40): string {
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

interface Spawned {
  proc: ChildProcess;
  log: string;
  label: string;
}

function spawnLogged(label: string, command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; log: string }): Spawned {
  const fd = fs.openSync(opts.log, 'a');
  const proc = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  proc.on('exit', () => {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  });
  log(`${label}: pid ${proc.pid} (${command} ${args.join(' ')})`);
  return { proc, log: opts.log, label };
}

async function waitForHttp(
  url: string,
  opts: { label: string; timeoutMs: number; child?: Spawned; accept?: (res: Response) => boolean },
): Promise<void> {
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (opts.child && hasExited(opts.child.proc)) {
      throw new Error(`${opts.label} exited early (code ${opts.child.proc.exitCode})\n--- ${opts.child.log} ---\n${tail(opts.child.log)}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      // Consume the body so the socket is released.
      await res.arrayBuffer().catch(() => undefined);
      if (opts.accept ? opts.accept(res) : res.ok) {
        log(`${opts.label} ready after ${((Date.now() - started) / 1000).toFixed(1)}s (${url})`);
        return;
      }
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = String((error as Error)?.message ?? error);
    }
    await sleep(500);
  }
  throw new Error(`${opts.label} not ready after ${opts.timeoutMs}ms (${lastError})\n--- ${opts.child?.log ?? ''} ---\n${tail(opts.child?.log)}`);
}

function killTree(child: Spawned) {
  const { proc, label } = child;
  if (!proc.pid || hasExited(proc)) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      proc.kill('SIGTERM');
    }
  } catch (error) {
    log(`failed to stop ${label}: ${String((error as Error)?.message ?? error)}`);
  }
}

function copySlide(serviceRoot: string): string | null {
  const slide = process.env.TL_TEST_SLIDE;
  if (!slide || !fs.existsSync(slide)) {
    log('WARNING: test slide not found — slide-dependent tests will be skipped (set TL_TEST_SLIDE)');
    return null;
  }
  const userDir = path.join(serviceRoot, 'storage', 'uploads', 'users', LOCAL_USER_ID);
  fs.mkdirSync(userDir, { recursive: true });
  const name = path.basename(slide);
  fs.copyFileSync(slide, path.join(userDir, name));
  log(`copied ${slide} -> users/${LOCAL_USER_ID}/${name}`);
  return name;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  const python = resolvePython();
  const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tissuelab-e2e-'));
  const children: Spawned[] = [];
  const hadDevTypes = fs.existsSync(NEXT_DEV_TYPES);
  let community: MockCommunityServer | null = null;

  const teardown = async () => {
    for (const child of [...children].reverse()) killTree(child);
    await community?.close().catch(() => undefined);
    await sleep(500);
    if (!hadDevTypes && process.env.TL_E2E_BUILD !== '1') {
      fs.rmSync(NEXT_DEV_TYPES, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
    if (process.env.TL_E2E_KEEP === '1') {
      log(`keeping service root ${serviceRoot}`);
      return;
    }
    try {
      fs.rmSync(serviceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (error) {
      log(`could not remove ${serviceRoot}: ${String((error as Error)?.message ?? error)}`);
    }
  };

  try {
    // ---- 1. mock LLM -------------------------------------------------------
    const llmPort = await freePort();
    const llm = spawnLogged('mock-llm', python, [MOCK_LLM_SCRIPT, '--port', String(llmPort)], {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      log: path.join(serviceRoot, 'mock-llm.log'),
    });
    children.push(llm);
    const llmBase = `http://127.0.0.1:${llmPort}/v1`;
    await waitForHttp(`${llmBase}/models`, { label: 'mock LLM', timeoutMs: 60_000, child: llm });

    const discoveryPort = await freePort();
    const discoveryLlm = spawnLogged(
      'mock-discovery-llm',
      python,
      [MOCK_DISCOVERY_LLM_SCRIPT, '--port', String(discoveryPort), '--delay', DISCOVERY_LLM_DELAY_SEC],
      { cwd: REPO_ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }, log: path.join(serviceRoot, 'mock-discovery-llm.log') },
    );
    children.push(discoveryLlm);
    const discoveryBase = `http://127.0.0.1:${discoveryPort}/v1`;
    await waitForHttp(`${discoveryBase}/models`, { label: 'mock discovery LLM', timeoutMs: 60_000, child: discoveryLlm });

    // ---- 2. Python service -------------------------------------------------
    const slideName = copySlide(serviceRoot);
    const backendPort = await freePort();
    const backendOrigin = `http://127.0.0.1:${backendPort}`;
    const apiUrl = `${backendOrigin}/api`;
    const wsUrl = `ws://127.0.0.1:${backendPort}/ws`;
    const backendEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ENV: 'local',
      TL_SERVICE_ROOT: serviceRoot,
      AUTO_ACTIVATE_TASKNODES: 'false',
      CODEEXEC_DOCKER: '0',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      OPENAI_API_KEY: 'dummy',
      OPENAI_BASE_URL: llmBase,
      LLM_MODEL: 'mock-llm',
      DISCOVERY_BASE_URL: discoveryBase,
      DISCOVERY_API_KEY: 'dummy',
    };
    delete backendEnv.LLM_API;
    const backend = spawnLogged('backend', python, ['main.py', '--port', String(backendPort), '--service-root', serviceRoot], {
      cwd: SERVICE_DIR,
      env: backendEnv,
      log: path.join(serviceRoot, 'backend.log'),
    });
    children.push(backend);
    await waitForHttp(`${apiUrl}/v1/openapi.json`, { label: 'backend', timeoutMs: BACKEND_READY_TIMEOUT_MS, child: backend });

    // ---- 3. mock community (hosted TissueLab server stand-in) ----------------
    community = await startMockCommunityServer();
    log(`mock community ready (${community.url})`);

    // ---- 4. renderer ---------------------------------------------------------
    const rendererPort = await freePort();
    const baseURL = `http://127.0.0.1:${rendererPort}`;
    const rendererEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PUBLIC_AI_SERVICE_API_ENDPOINT: apiUrl,
      PUBLIC_AI_SERVICE_SOCKET_ENDPOINT: wsUrl,
      PUBLIC_CTRL_SERVICE_API_ENDPOINT: apiUrl,
      PUBLIC_COMMUNITY_API_ENDPOINT: community.url,
      NEXT_TELEMETRY_DISABLED: '1',
      BROWSER: 'none',
    };
    const useBuild = process.env.TL_E2E_BUILD === '1';
    if (useBuild) {
      log('next build (TL_E2E_BUILD=1) …');
      execFileSync(process.execPath, [NEXT_BIN, 'build'], { cwd: RENDER_ROOT, env: rendererEnv, stdio: 'inherit' });
    }
    const renderer = spawnLogged(
      'renderer',
      process.execPath,
      [NEXT_BIN, useBuild ? 'start' : 'dev', '-p', String(rendererPort), '-H', '127.0.0.1'],
      { cwd: RENDER_ROOT, env: rendererEnv, log: path.join(serviceRoot, 'renderer.log') },
    );
    children.push(renderer);
    await waitForHttp(`${baseURL}/dashboard`, { label: 'renderer', timeoutMs: RENDERER_READY_TIMEOUT_MS, child: renderer });
    if (!useBuild) {
      // Dev mode compiles pages on first request; do it now so the tests'
      // navigations (and their timeouts) only measure the app itself.
      for (const route of ['/community', '/imageViewer']) {
        await waitForHttp(`${baseURL}${route}`, { label: `renderer ${route}`, timeoutMs: RENDERER_READY_TIMEOUT_MS, child: renderer });
      }
    }

    process.env.TL_E2E_BASE_URL = baseURL;
    process.env.TL_E2E_API_URL = apiUrl;
    process.env.TL_E2E_SERVICE_ROOT = serviceRoot;
    process.env.TL_E2E_MOCK_LLM_URL = llmBase;
    process.env.TL_E2E_DISCOVERY_LLM_URL = discoveryBase;
    process.env.TL_E2E_COMMUNITY_URL = community.url;
    if (slideName) process.env.TL_E2E_SLIDE_NAME = slideName;
    else delete process.env.TL_E2E_SLIDE_NAME;

    log(`stack up in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — renderer ${baseURL}, service ${apiUrl}, community ${community.url}, root ${serviceRoot}`);
  } catch (error) {
    await teardown();
    throw error;
  }

  return teardown;
}
