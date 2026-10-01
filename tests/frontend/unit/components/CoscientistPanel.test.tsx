import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-redux', () => ({
  useDispatch: () => vi.fn(),
  useSelector: () => 'TL Coscientist',
}));
vi.mock('@/utils/viewer/slidePath', () => ({ useActiveSlidePath: () => '/data/ws/slide.svs' }));
vi.mock('@/hooks/usePathWriteAccess', () => ({ usePathWriteAccess: () => ({ allowed: true, tooltip: undefined }) }));
vi.mock('@/utils/common/authToken', () => ({ getAuthToken: vi.fn(async () => 'token') }));
// The program form has its own test: here it simply reports a ready program.
vi.mock('@/components/imageViewer/sidebar/agent/chat/ResearchProgramInput', async () => {
  const { useEffect } = await import('react');
  return {
    ResearchProgramInput: ({ onChange }: { onChange: (t: string, r: boolean) => void }) => {
      useEffect(() => { onChange('program', true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return null;
    },
  };
});

import { CoscientistPanel } from '@/components/imageViewer/sidebar/agent/chat/CoscientistPanel';

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ code: 0, message: 'ok', data }) });

/** A run's SSE stream the test feeds by hand; aborting its request rejects the pending read. */
function sseStream(signal: AbortSignal) {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  const reader = {
    read: () => new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
      const next = () => {
        if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
        const c = chunks.shift();
        if (c === undefined) { wake = next; return; }
        resolve(c.length ? { done: false, value: c } : { done: true });
      };
      signal.addEventListener('abort', () => { if (wake) { wake = null; next(); } });
      next();
    }),
  };
  const push = (c: Uint8Array) => { chunks.push(c); const w = wake; wake = null; w?.(); };
  return {
    response: { ok: true, status: 200, body: { getReader: () => reader } },
    send: (event: object) => push(enc.encode(`data: ${JSON.stringify(event)}\n\n`)),
    end: () => push(new Uint8Array(0)),
  };
}

type Stream = ReturnType<typeof sseStream> & { signal: AbortSignal };

const RUNNING = { run_id: 'run-live', run_root_path: '/data/ws/autoresearch_runs/run-live', status: 'running', rounds: 3, next_round_id: 2 };

function mockService({ runs = [] as object[], streamStatus = 200 } = {}) {
  const streams: Stream[] = [];
  const cancels: string[] = [];
  let releaseStart: ((runId: string) => void) | null = null;
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    if (url.includes('/discovery/runs?workspace_path=')) return ok({ runs });
    if (url.includes('/discovery/runs/load?')) {
      return ok({ ...RUNNING, journal: [{ roundId: 1, focus: 'first round', summary: 'r1' }], final_summary: null });
    }
    if (url.endsWith('/stream') && streamStatus !== 200) return { ok: false, status: streamStatus, body: null };
    if (url.endsWith('/discovery/runs') && method === 'POST') {
      return new Promise((resolve) => { releaseStart = (runId) => resolve(ok({ run_id: runId })); });
    }
    const cancel = url.match(/\/runs\/([^/]+)\/cancel$/);
    if (cancel) { cancels.push(cancel[1]); return ok({ cancelled: true }); }
    if (url.endsWith('/stream')) {
      const s = { ...sseStream(init.signal!), signal: init.signal! };
      streams.push(s);
      return s.response;
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    streams,
    cancels,
    startReturns: async (runId: string) => { await waitFor(() => expect(releaseStart).not.toBeNull()); await act(async () => releaseStart!(runId)); },
  };
}

const start = () => fireEvent.click(screen.getByRole('button', { name: /Start Research/ }));
const newTask = () => screen.getByRole('button', { name: 'New research task' });

afterEach(() => { vi.restoreAllMocks(); });

describe('CoscientistPanel run lifecycle', () => {
  it('Stop before the start request returns cancels the run it then names, and never reads its stream', async () => {
    const svc = mockService();
    render(<CoscientistPanel />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Start Research/ })).toBeEnabled());
    start();
    fireEvent.click(await screen.findByRole('button', { name: /Stop/ }));
    await svc.startReturns('run-a');

    await waitFor(() => expect(svc.cancels).toEqual(['run-a']));
    expect(svc.streams).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'New Research Task' })).toBeInTheDocument();
    expect(newTask()).toBeEnabled();
  });

  it('locks "+" while running, settles spinners and unlocks when the stream ends', async () => {
    const svc = mockService();
    const { container } = render(<CoscientistPanel />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Start Research/ })).toBeEnabled());
    start();
    await svc.startReturns('run-b');
    await waitFor(() => expect(svc.streams).toHaveLength(1));
    expect(newTask()).toBeDisabled();

    // Every proposal fails: the round ends with no worker, then the run ends.
    await act(async () => {
      svc.streams[0].send({ type: 'round_started', round_id: 1, total_rounds: 1, workers: 1 });
      svc.streams[0].send({ type: 'proposer_failed', round_id: 1, slot: 1, error: 'boom' });
      svc.streams[0].send({ type: 'round_summary', round_id: 1, summary: 'nothing' });
      svc.streams[0].send({ type: 'round_completed', round_id: 1 });
      svc.streams[0].end();
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'New Research Task' })).toBeInTheDocument());
    expect(newTask()).toBeEnabled();
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(0);
  });

  it('Stop leaves "cancelling" and unlocks the panel', async () => {
    const svc = mockService();
    render(<CoscientistPanel />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Start Research/ })).toBeEnabled());
    start();
    await svc.startReturns('run-c');
    await waitFor(() => expect(svc.streams).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    expect(svc.streams[0].signal.aborted).toBe(true);
    await waitFor(() => expect(svc.cancels).toEqual(['run-c']));
    await waitFor(() => expect(newTask()).toBeEnabled());
    expect(screen.queryByText(/aborted/i)).toBeNull();
  });

  it('unmounting aborts the live stream', async () => {
    const svc = mockService();
    const { unmount } = render(<CoscientistPanel />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Start Research/ })).toBeEnabled());
    start();
    await svc.startReturns('run-d');
    await waitFor(() => expect(svc.streams).toHaveLength(1));
    unmount();
    expect(svc.streams[0].signal.aborted).toBe(true);
    expect(svc.cancels).toEqual([]);   // leaving the panel does not stop the run
  });

  const openRunning = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Run history' }));
    fireEvent.click(await screen.findByRole('button', { name: /run-live/ }));
  };

  it('reopening a running run from the history watches it again, so it can be stopped', async () => {
    const svc = mockService({ runs: [RUNNING] });
    render(<CoscientistPanel />);
    await openRunning();
    await waitFor(() => expect(svc.streams).toHaveLength(1));
    expect(screen.getByText('first round')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    await waitFor(() => expect(svc.cancels).toEqual(['run-live']));
  });

  it('a run that ended meanwhile falls back to what was loaded, once and without an error', async () => {
    for (const streamStatus of [200, 404]) {
      const svc = mockService({ runs: [RUNNING], streamStatus });
      const { unmount } = render(<CoscientistPanel />);
      await openRunning();
      if (streamStatus === 200) {
        await waitFor(() => expect(svc.streams).toHaveLength(1));
        await act(async () => { svc.streams[0].send({ type: 'error', message: 'Run not found' }); });
      }
      await waitFor(() => expect(screen.getByRole('button', { name: 'New Research Task' })).toBeInTheDocument());
      expect(screen.getByText('first round')).toBeInTheDocument();
      expect(screen.queryByText(/not found|Stream failed/)).toBeNull();
      expect(newTask()).toBeEnabled();
      const streamCalls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.filter(([u]) => u.endsWith('/stream'));
      expect(streamCalls).toHaveLength(1);
      unmount();
    }
  });
});
