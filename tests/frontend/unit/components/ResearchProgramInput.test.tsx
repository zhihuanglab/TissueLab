import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResearchProgramInput } from '@/components/imageViewer/sidebar/agent/chat/ResearchProgramInput';

const cohort = { file: 'cases.csv', rows: 3, columns: [], id_column: 'case', slide_column: 'slide', mpp_column: null, slides_found: 3, outcome_candidates: ['score'], covariate_candidates: [] };
const setup = (question: string, cohorts: object[] = [cohort]) => ({
  ok: true, status: 200,
  data: { code: 0, data: { problem: { found: true, content: question, fields: { outcome: 'score', question, covariates: [], cohort_file: 'cases.csv', id_column: 'case', slide_column: 'slide', mpp_column: 'mpp' }, error: null }, cohorts } },
});

function deferredFetch() {
  const pending: Record<string, (v: unknown) => void> = {};
  const authedFetch = vi.fn((url: string) => {
    if (url.includes('/problem/resolve')) return new Promise(() => {});   // not under test
    const dir = decodeURIComponent(url.split('data_dir=')[1]);
    return new Promise((resolve) => { pending[dir] = resolve; });
  });
  return { authedFetch: authedFetch as any, answer: (dir: string, v: unknown) => act(async () => pending[dir](v)) };
}

describe('ResearchProgramInput workspace scan', () => {
  it('ignores the answer for a folder that is no longer open', async () => {
    const { authedFetch, answer } = deferredFetch();
    const { rerender } = render(<ResearchProgramInput workspaceDir="/a" authedFetch={authedFetch} resetKey={0} onChange={() => {}} />);
    rerender(<ResearchProgramInput workspaceDir="/b" authedFetch={authedFetch} resetKey={0} onChange={() => {}} />);
    await answer('/b', setup('question of b'));
    await answer('/a', setup('question of a'));
    expect(screen.getByLabelText('Research Program')).toHaveValue('question of b');
  });

  it('drops the last folder\'s program when the scan of the next one fails', async () => {
    const { authedFetch, answer } = deferredFetch();
    const { rerender } = render(<ResearchProgramInput workspaceDir="/a" authedFetch={authedFetch} resetKey={0} onChange={() => {}} />);
    await answer('/a', setup('question of a'));
    expect(screen.getByLabelText('Research Program')).toHaveValue('question of a');
    rerender(<ResearchProgramInput workspaceDir="/b" authedFetch={authedFetch} resetKey={0} onChange={() => {}} />);
    await answer('/b', { ok: false, status: 500, data: { code: 1, message: 'Could not read /b' } });
    expect(screen.getByLabelText('Research Program')).toHaveValue('');
    expect(screen.getByText('Could not read /b')).toBeInTheDocument();
    expect(screen.queryByText(/cases\.csv/)).toBeNull();
  });

  it('says why Start is unavailable when the folder has no patient table', async () => {
    const { authedFetch, answer } = deferredFetch();
    render(<ResearchProgramInput workspaceDir="/a" authedFetch={authedFetch} resetKey={0} onChange={() => {}} />);
    await answer('/a', setup('q', []));
    await waitFor(() => expect(screen.getByText(/No patient table \(CSV\) found in this folder/)).toBeInTheDocument());
  });
});
