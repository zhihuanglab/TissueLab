import { describe, expect, it } from 'vitest';
import {
  appendJournalEntry,
  failPendingProposer,
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
});
