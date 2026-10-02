import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-redux', () => ({
  useDispatch: () => vi.fn(),
  useSelector: () => 'TL Coscientist',
}));
vi.mock('@/utils/viewer/slidePath', () => ({ useActiveSlidePath: () => '/data/ws/slide.svs' }));
vi.mock('@/hooks/usePathWriteAccess', () => ({ usePathWriteAccess: () => ({ allowed: true, tooltip: undefined }) }));
vi.mock('@/utils/common/authToken', () => ({ getAuthToken: vi.fn(async () => 'token') }));

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

/** program: the saved program the box is pre-filled with; null = each request waits for `answerProgram`. */
/** cancelReply: the cancel endpoint's data (the service says {cancelled: false} for a run no longer active). */
function mockService({ runs = [] as object[], streamStatus = 200, program = 'program' as string | null, cancelReply = { cancelled: true } as object } = {}) {
  const streams: Stream[] = [];
  const cancels: string[] = [];
  const programRequests: ((text: string) => void)[] = [];
  const startBodies: Record<string, unknown>[] = [];
  let releaseStart: ((reply: object) => void) | null = null;
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    if (url.includes('/discovery/runs?workspace_path=')) return ok({ runs });
    if (url.includes('/discovery/program?data_dir=')) {
      expect(url).toContain(`data_dir=${encodeURIComponent('/data/ws')}`);
      if (program !== null) return ok({ text: program });
      return new Promise((resolve) => { programRequests.push((text) => resolve(ok({ text }))); });
    }
    if (url.includes('/discovery/runs/load?')) {
      return ok({ ...RUNNING, journal: [{ roundId: 1, focus: 'first round', summary: 'r1' }], final_summary: null });
    }
    if (/\/stream(\?|$)/.test(url) && streamStatus !== 200) return { ok: false, status: streamStatus, body: null };
    if (url.endsWith('/discovery/runs') && method === 'POST') {
      startBodies.push(JSON.parse(String(init.body)));
      return new Promise((resolve) => { releaseStart = resolve; });
    }
    const cancel = url.match(/\/runs\/([^/]+)\/cancel$/);
    if (cancel) { cancels.push(cancel[1]); return ok(cancelReply); }
    if (/\/stream(\?|$)/.test(url)) {
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
    programRequests,
    startBodies,
    answerProgram: async (i: number, text: string) => {
      await waitFor(() => expect(programRequests.length).toBeGreaterThan(i));
      await act(async () => programRequests[i](text));
    },
    startReturns: async (runId: string, outcome?: string) => {
      await waitFor(() => expect(releaseStart).not.toBeNull());
      await act(async () => releaseStart!(ok({ run_id: runId, outcome })));
    },
    startFails: async (message: string) => {
      await waitFor(() => expect(releaseStart).not.toBeNull());
      await act(async () => releaseStart!({ ok: false, status: 400, json: async () => ({ code: 400, message, data: null }) }));
    },
    startRefusedWith: async (status: number, body: object) => {
      await waitFor(() => expect(releaseStart).not.toBeNull());
      await act(async () => releaseStart!({ ok: false, status, json: async () => body }));
    },
  };
}

const start = () => fireEvent.click(screen.getByRole('button', { name: /Start Research/ }));
const newTask = () => screen.getByRole('button', { name: 'New research task' });
const programBox = () => screen.getByLabelText('Research Program') as HTMLTextAreaElement;
const startButton = () => screen.getByRole('button', { name: /Start Research/ });
const endState = () => screen.getByTestId('run-end-state');
/** Stop, then confirm it in the dialog. */
const stopRun = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /^Stop$/ }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop run' }));
};
/** Start a run named runId and wait for its stream. */
const startRunning = async (svc: ReturnType<typeof mockService>, runId: string) => {
  await waitFor(() => expect(startButton()).toBeEnabled());
  start();
  await svc.startReturns(runId);
  await waitFor(() => expect(svc.streams).toHaveLength(1));
};

// jsdom has no Element.scrollTo: the panel auto-scrolls on new events (a frame that may outlive a test).
beforeAll(() => { Element.prototype.scrollTo = () => {}; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('CoscientistPanel run lifecycle', () => {
  it('Stop before the start request returns cancels the run it then names, and never reads its stream', async () => {
    const svc = mockService();
    render(<CoscientistPanel />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Start Research/ })).toBeEnabled());
    start();
    await stopRun();
    await svc.startReturns('run-a');

    await waitFor(() => expect(svc.cancels).toEqual(['run-a']));
    expect(svc.streams).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'New Research Task' })).toBeInTheDocument();
    expect(endState()).toHaveTextContent('Stopped');
    expect(newTask()).toBeEnabled();
  });

  it('Stop asks first: keeping the run running does nothing', async () => {
    const svc = mockService();
    render(<CoscientistPanel />);
    await startRunning(svc, 'run-k');
    fireEvent.click(screen.getByRole('button', { name: /^Stop$/ }));
    expect(await screen.findByText('Work in the current round will be lost.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(svc.cancels).toEqual([]);
    expect(svc.streams[0].signal.aborted).toBe(false);
  });

  it('locks "+" and the agent switch while running, settles spinners and unlocks when the stream ends', async () => {
    const svc = mockService();
    const { container } = render(<CoscientistPanel />);
    await startRunning(svc, 'run-b');
    expect(newTask()).toBeDisabled();
    // switching to the Agent chat would unmount the panel mid-run
    expect(screen.getByRole('combobox')).toBeDisabled();

    // Every proposal fails: the round ends with no worker, then the run ends.
    await act(async () => {
      svc.streams[0].send({ type: 'round_started', round_id: 1, total_rounds: 1, workers: 1 });
      svc.streams[0].send({ type: 'proposer_failed', round_id: 1, slot: 1, error: 'boom' });
      svc.streams[0].send({ type: 'round_summary', round_id: 1, summary: 'nothing' });
      svc.streams[0].send({ type: 'round_completed', round_id: 1 });
      svc.streams[0].send({ type: 'complete', result: {} });
      svc.streams[0].end();
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'New Research Task' })).toBeInTheDocument());
    expect(newTask()).toBeEnabled();
    expect(screen.getByRole('combobox')).toBeEnabled();
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(0);
    expect(endState()).toHaveTextContent('Finished');
    // the round's write-up went to the journal
    fireEvent.click(screen.getByText('Round 1'));
    expect(screen.getByText('nothing')).toBeInTheDocument();
  });

  it('Stop keeps listening ("Stopping…") until the run says it stopped', async () => {
    const svc = mockService();
    render(<CoscientistPanel />);
    await startRunning(svc, 'run-c');
    await stopRun();
    await waitFor(() => expect(svc.cancels).toEqual(['run-c']));
    expect(svc.streams[0].signal.aborted).toBe(false);
    expect(screen.getAllByText('Stopping…').length).toBeGreaterThan(0);
    expect(newTask()).toBeDisabled();

    await act(async () => { svc.streams[0].send({ type: 'run_cancelled', run_id: 'run-c' }); });
    await waitFor(() => expect(newTask()).toBeEnabled());
    expect(endState()).toHaveTextContent('Stopped');
    expect(screen.queryByText(/aborted|cancelled/i)).toBeNull();
  });

  it('a slow stop says so, and still waits for the run', async () => {
    const svc = mockService();
    render(<CoscientistPanel />);
    await startRunning(svc, 'run-s');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    await stopRun();
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(await screen.findByText('Still stopping — the current step is finishing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Research Task' })).toBeNull();
    await act(async () => { svc.streams[0].end(); });
    await waitFor(() => expect(endState()).toHaveTextContent('Stopped'));
  });

  it('Stop on a run the service no longer runs: already stopped', async () => {
    const svc = mockService({ cancelReply: { cancelled: false, reason: 'not active' } });
    render(<CoscientistPanel />);
    await startRunning(svc, 'run-n');
    await stopRun();
    await waitFor(() => expect(endState()).toHaveTextContent('Stopped'));
    expect(svc.streams[0].signal.aborted).toBe(true);
    expect(newTask()).toBeEnabled();
  });

  it('unmounting aborts the live stream', async () => {
    const svc = mockService();
    const { unmount } = render(<CoscientistPanel />);
    await startRunning(svc, 'run-d');
    unmount();
    expect(svc.streams[0].signal.aborted).toBe(true);
    expect(svc.cancels).toEqual([]);   // leaving the panel does not stop the run
  });

  it('opening the panel on a folder with a running run watches it again, so it can be stopped', async () => {
    const svc = mockService({ runs: [RUNNING] });
    render(<CoscientistPanel />);
    await waitFor(() => expect(svc.streams).toHaveLength(1));
    expect(screen.getByText('first round')).toBeInTheDocument();
    await stopRun();
    await waitFor(() => expect(svc.cancels).toEqual(['run-live']));
  });

  it('a reattached run that is only on disk now ends as the service says, without an error', async () => {
    for (const [status, label] of [['completed', 'Finished'], ['incomplete', 'Incomplete'], ['cancelled', 'Stopped']]) {
      const svc = mockService({ runs: [RUNNING] });
      const { unmount } = render(<CoscientistPanel />);
      await waitFor(() => expect(svc.streams).toHaveLength(1));
      await act(async () => { svc.streams[0].send({ type: 'run_detached', run_id: 'run-live', status }); });
      await waitFor(() => expect(endState()).toHaveTextContent(label));
      expect(screen.queryByText(/error|failed/i)).toBeNull();
      expect(newTask()).toBeEnabled();
      unmount();
    }
  });

  it('reattaching mid-round shows the round from its events, not "getting ready"', async () => {
    const svc = mockService({ runs: [RUNNING] });
    render(<CoscientistPanel />);
    await waitFor(() => expect(svc.streams).toHaveLength(1));
    // round_started (round 2) was before this stream: its workers' events still show
    await act(async () => {
      svc.streams[0].send({ type: 'worker_started', worker_name: 'round_0002_worker', scientific_question: 'Does stroma density matter?' });
      svc.streams[0].send({ type: 'worker_tool_call', worker_name: 'round_0002_worker', turn_id: 1, command_preview: 'ls' });
    });
    expect(await screen.findByText('Does stroma density matter?')).toBeInTheDocument();
    expect(screen.getByText('Analysis 1')).toBeInTheDocument();
    expect(screen.getByText('Round 2/3')).toBeInTheDocument();
    expect(screen.queryByText('Getting ready...')).toBeNull();
  });

  it('a run that ended meanwhile falls back to what was loaded, once and without an error', async () => {
    for (const streamStatus of [200, 404]) {
      const svc = mockService({ runs: [RUNNING], streamStatus });
      const { unmount } = render(<CoscientistPanel />);
      if (streamStatus === 200) {
        await waitFor(() => expect(svc.streams).toHaveLength(1));
        await act(async () => { svc.streams[0].send({ type: 'error', message: 'Run not found' }); });
      }
      await waitFor(() => expect(screen.getByRole('button', { name: 'New Research Task' })).toBeInTheDocument());
      expect(screen.getByText('first round')).toBeInTheDocument();
      expect(screen.queryByText(/not found|Stream failed/)).toBeNull();
      expect(newTask()).toBeEnabled();
      const streamCalls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.filter(([u]) => /\/stream(\?|$)/.test(u));
      expect(streamCalls).toHaveLength(1);
      unmount();
    }
  });

  it('the history names runs in plain words, not by id', async () => {
    mockService({ runs: [{ ...RUNNING, status: 'completed', question: 'Which immune cells predict relapse?\nmore' }] });
    render(<CoscientistPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Run history' }));
    const entry = await screen.findByRole('button', { name: /Which immune cells predict relapse\?/ });
    expect(entry).toHaveTextContent('Finished');
    expect(entry).not.toHaveTextContent('run-live');
  });

  it('"New Research Task" clears the previous run\'s error', async () => {
    const svc = mockService();
    render(<CoscientistPanel />);
    await startRunning(svc, 'run-e');
    await act(async () => {
      svc.streams[0].send({ type: 'error', message: 'the cohort table is unreadable' });
      svc.streams[0].end();
    });
    expect(await screen.findByText('the cohort table is unreadable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New Research Task' }));
    expect(programBox()).toBeInTheDocument();
    expect(screen.queryByText('the cohort table is unreadable')).toBeNull();
  });
});

describe('CoscientistPanel research program', () => {
  it('is pre-filled from the workspace and sent as typed; Start needs text', async () => {
    const svc = mockService({ program: '' });
    render(<CoscientistPanel />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/discovery/program?'), expect.anything()));
    expect(programBox().value).toBe('');
    expect(startButton()).toBeDisabled();

    fireEvent.change(programBox(), { target: { value: '   ' } });
    expect(startButton()).toBeDisabled();
    fireEvent.change(programBox(), { target: { value: 'Find features that predict survival.' } });
    expect(startButton()).toBeEnabled();

    start();
    await waitFor(() => expect(svc.startBodies).toHaveLength(1));
    expect(svc.startBodies[0]).toMatchObject({ task: 'Find features that predict survival.', workspace_path: '/data/ws/slide.svs', dataset_scout: true });
    expect(svc.startBodies[0]).not.toHaveProperty('reuse_guide_from');
  });

  it('a pre-fill that arrives after typing does not overwrite the text', async () => {
    const svc = mockService({ program: null });
    render(<CoscientistPanel />);
    fireEvent.change(programBox(), { target: { value: 'typed by hand' } });
    await svc.answerProgram(0, 'saved program');
    expect(programBox().value).toBe('typed by hand');
  });

  it('"+" asks before discarding typed text, and then pre-fills again', async () => {
    mockService();
    render(<CoscientistPanel />);
    await waitFor(() => expect(programBox().value).toBe('program'));
    fireEvent.change(programBox(), { target: { value: 'my unsaved idea' } });
    fireEvent.click(newTask());
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(programBox().value).toBe('my unsaved idea');

    fireEvent.click(newTask());
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(programBox().value).toBe('program'));
  });

  it('a stale pre-fill is ignored: only the newest request writes', async () => {
    const svc = mockService({ program: null });
    render(<CoscientistPanel />);
    await waitFor(() => expect(svc.programRequests).toHaveLength(1));
    fireEvent.click(newTask());   // "+" starts over: a second request
    await svc.answerProgram(1, 'new program');
    expect(programBox().value).toBe('new program');
    await svc.answerProgram(0, 'old program');
    expect(programBox().value).toBe('new program');
    expect(startButton()).toBeEnabled();
  });
});

describe('CoscientistPanel start outcome', () => {
  it('a start the service refuses keeps the form and the typed program, with the reason above Start', async () => {
    const svc = mockService();
    render(<CoscientistPanel />);
    await waitFor(() => expect(programBox().value).toBe('program'));
    fireEvent.change(programBox(), { target: { value: 'what predicts decline?' } });
    start();
    await svc.startFails('Couldn\'t tell which column to predict.');

    expect(await screen.findByText("Couldn't tell which column to predict.")).toBeInTheDocument();
    expect(programBox().value).toBe('what predicts decline?');
    expect(startButton()).toBeEnabled();
    expect(svc.streams).toHaveLength(0);
  });

  it('a refused request shows the readable reason, also in FastAPI\'s validation shape', async () => {
    const svc = mockService();
    render(<CoscientistPanel />);
    await waitFor(() => expect(startButton()).toBeEnabled());
    start();
    await svc.startRefusedWith(422, { detail: [{ loc: ['body', 'worker_wall_clock_sec'], msg: 'Input should be greater than or equal to 120' }] });
    expect(await screen.findByText('worker_wall_clock_sec: Input should be greater than or equal to 120')).toBeInTheDocument();
    expect(screen.queryByText('Failed to start run')).toBeNull();
  });

  it('the worker time limit stays within what the service accepts', async () => {
    const svc = mockService();
    render(<CoscientistPanel />);
    fireEvent.click(screen.getByText('Advanced Parameters'));
    const limit = screen.getByLabelText('Worker Time Limit') as HTMLInputElement;
    expect(limit.value).toBe('30');
    fireEvent.change(limit, { target: { value: '1' } });
    expect(limit.value).toBe('2');
    fireEvent.change(limit, { target: { value: '' } });
    expect(limit.value).toBe('30');
    await waitFor(() => expect(startButton()).toBeEnabled());
    start();
    await waitFor(() => expect(svc.startBodies).toHaveLength(1));
    expect(svc.startBodies[0].worker_wall_clock_sec).toBe(1800);
  });

  it('shows the column the run predicts', async () => {
    const svc = mockService();
    render(<CoscientistPanel />);
    await waitFor(() => expect(startButton()).toBeEnabled());
    start();
    await svc.startReturns('run-a', 'slope');
    expect(await screen.findByText('slope')).toBeInTheDocument();
    expect(screen.getByText(/Predicting/)).toBeInTheDocument();
  });
});
