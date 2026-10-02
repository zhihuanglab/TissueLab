import { describe, expect, it } from 'vitest';
import {
  appendJournalEntry,
  detachedEndState,
  ensureRound,
  failPendingProposer,
  requestErrorMessage,
  roundIdOf,
  withWorker,
  stopRunningRows,
  stopRunningScout,
  type RoundState,
} from '@/components/imageViewer/sidebar/agent/chat/researchRunState';

const call = (status: 'running' | 'done' | 'error') => ({ turnId: 1, thought: '', command: 'ls', status });

const round = (): RoundState => ({
  roundId: 1,
  totalRounds: 2,
  focus: '',
  workers: [
    { name: 'proposer', question: '', status: 'completed', toolCalls: [] },
    { name: 'w1', question: '', status: 'running', toolCalls: [call('done'), call('running')] },
    { name: 'w2', question: '', status: 'failed', toolCalls: [call('error')] },
  ],
});

describe('research run state', () => {
  it('stops every running worker and tool call when the run ends, and keeps the settled ones', () => {
    const stopped = stopRunningRows(round())!;
    expect(stopped.workers.map((w) => w.status)).toEqual(['completed', 'stopped', 'failed']);
    expect(stopped.workers[1].toolCalls.map((c) => c.status)).toEqual(['done', 'stopped']);
    expect(stopped.workers[2].toolCalls.map((c) => c.status)).toEqual(['error']);
  });

  it('leaves a settled round (and no round) as it is', () => {
    const settled = stopRunningRows(round())!;
    expect(stopRunningRows(settled)).toBe(settled);
    expect(stopRunningRows(null)).toBeNull();
  });

  it('marks the proposer failed when the round ends without any worker starting', () => {
    const r: RoundState = { roundId: 1, totalRounds: 1, focus: '', workers: [{ name: 'proposer', question: '', status: 'running', toolCalls: [] }] };
    expect(failPendingProposer(r)!.workers[0].status).toBe('failed');
    const done = round();
    expect(failPendingProposer(done)).toBe(done);
  });

  it('stops a running scout, not a finished one', () => {
    expect(stopRunningScout({ status: 'running', calls: [call('running')] })).toEqual({
      status: 'failed', note: 'stopped', calls: [{ ...call('running'), status: 'stopped' }],
    });
    const done = { status: 'done' as const, calls: [] };
    expect(stopRunningScout(done)).toBe(done);
  });

  it('adds a round to the journal once (a reattached or resumed run may repeat one)', () => {
    const j = [{ roundId: 1, focus: 'a', summary: 's' }];
    expect(appendJournalEntry(j, { roundId: 1, focus: 'b', summary: 't' })).toBe(j);
    expect(appendJournalEntry(j, { roundId: 2, focus: 'b', summary: 't' })).toHaveLength(2);
  });

  it('finds an event\'s round from round_id, else from its worker\'s name', () => {
    expect(roundIdOf({ round_id: 3 })).toBe(3);
    expect(roundIdOf({ worker_name: 'round_0002_worker_1' })).toBe(2);
    expect(roundIdOf({ worker_name: 'proposer' })).toBeNull();
    expect(roundIdOf({})).toBeNull();
  });

  it('makes a stub round for an event of a round it never saw start (reattached mid-round)', () => {
    expect(ensureRound(null, 2, 3)).toEqual({ roundId: 2, totalRounds: 3, focus: '', workers: [] });
    // more rounds than planned (a resumed run): the total is at least this round
    expect(ensureRound(null, 5, 3)!.totalRounds).toBe(5);
    expect(ensureRound(null, null, 3)).toBeNull();
    const r = round();
    expect(ensureRound(r, 2, 3)).toBe(r);
  });

  it('updates a worker, adding a row for one first seen mid-way', () => {
    const r = withWorker(round(), 'w1', (w) => ({ ...w, status: 'completed' }));
    expect(r.workers.map((w) => w.status)).toEqual(['completed', 'completed', 'failed']);
    const added = withWorker(round(), 'w3', (w) => ({ ...w, question: 'q' }));
    expect(added.workers).toHaveLength(4);
    expect(added.workers[3]).toMatchObject({ name: 'w3', question: 'q', status: 'running', toolCalls: [] });
  });

  it('reads a refused request\'s reason: the service message, or FastAPI\'s validation detail', () => {
    expect(requestErrorMessage({ code: 400, message: 'A research run is already in progress in this folder.' }, 'x'))
      .toBe('A research run is already in progress in this folder.');
    expect(requestErrorMessage({ detail: [{ loc: ['body', 'rounds'], msg: 'too big' }, { msg: 'bad' }] }, 'x')).toBe('rounds: too big; bad');
    expect(requestErrorMessage({ detail: 'Not Found' }, 'x')).toBe('Not Found');
    expect(requestErrorMessage(null, 'Failed to start run')).toBe('Failed to start run');
  });

  it('maps run_detached\'s status to how the run ended', () => {
    expect(detachedEndState('completed')).toBe('finished');
    expect(detachedEndState('cancelled')).toBe('stopped');
    expect(detachedEndState('incomplete')).toBe('incomplete');
  });
});
