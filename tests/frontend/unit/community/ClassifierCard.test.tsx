import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMUNITY_API_ENDPOINT } from '@/config/api.config';
import ClassifierCard from '@/components/community/ClassifierCard';
import ModelCard from '@/components/community/ModelCard';
import type { ClassifierData, ModelData } from '@/types/community.types';
import { envelope, installFetchMock } from '../helpers/fetchMock';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn(), message: vi.fn() },
}));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {} }) }));
vi.mock('@/utils/common/authToken', () => ({
  AUTH_MISSING_ERROR: 'Authentication required',
  LOCAL_DEFAULT_TOKEN: 'local-default-token',
  getAuthToken: vi.fn(async () => 'firebase-token'),
  forceRefreshAuthToken: vi.fn(async () => null),
  notifyMissingAuth: vi.fn(),
}));

const classifier: ClassifierData = {
  id: 'uploaded-1',
  title: 'Tumor vs Stroma',
  description: 'Per-cell classifier separating tumor from stroma.',
  author: { name: 'e2e-auth', avatar: '/avatars/default.jpg', user_id: 'author-card-1', username: 'author-card-1' },
  stats: { classes: 2, size: '240.0 KB', downloads: 12, stars: 4, updatedAt: '2026-01-02', createdAt: '2026-01-01T00:00:00.000Z' },
  tags: ['Pathology'],
  thumbnail: '/thumbnails/default.jpg',
  factory: 'nuclei_classification',
  node: 'NuClass',
  model: 'NuClass',
};

const model: ModelData = {
  id: 'uploaded-101',
  title: 'StarDist fluorescence weights',
  description: 'Fine-tuned StarDist weights for DAPI nuclei.',
  author: { name: 'e2e-auth', avatar: '/avatars/default.jpg', user_id: 'author-card-2', username: 'author-card-2' },
  stats: { size: '50.00 MB', downloads: 7, stars: 2, updatedAt: '2026-01-02', createdAt: '2026-01-01T00:00:00.000Z' },
  tags: ['Cell Segmentation + Embedding', 'StarDist'],
  thumbnail: '/thumbnails/default.jpg',
  factory: 'cell_segmentation',
  node: 'StarDist',
  model: 'StarDist',
};

const profile = (uid: string, displayName: string) => ({
  method: 'GET',
  match: `/community/v1/users/${uid}/public-profile`,
  reply: () => envelope({ uid, displayName, avatarUrl: null }),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('components/community/ClassifierCard', () => {
  it('shows the title, the author resolved from the community and the live star / download counts', async () => {
    const { calls } = installFetchMock([
      profile('author-card-1', 'Alpha Pathologist'),
      {
        method: 'GET',
        match: '/community/v1/classifiers/uploaded-1',
        reply: () => envelope({ success: true, classifier: { ...classifier, stats: { downloads: 15 } }, star_count: 9, is_starred: false }),
      },
    ]);
    const { container } = render(<ClassifierCard classifier={classifier} />);

    expect(screen.getByText('Tumor vs Stroma')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Alpha Pathologist').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText(/Stars:\s*9/)).toBeInTheDocument());
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByTitle('Add star')).toBeEnabled();
    // Star + Download only: no delete control unless the viewer owns the classifier.
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /download/i })).toBeEnabled();

    for (const call of calls) {
      expect(call.url.startsWith(COMMUNITY_API_ENDPOINT)).toBe(true);
      expect(call.headers.get('authorization')).toBe('Bearer firebase-token');
    }
  });

  it('Download mints a token link on the community and opens the direct download URL', async () => {
    let downloads = 12;
    const { calls } = installFetchMock([
      profile('author-card-1', 'Alpha Pathologist'),
      {
        method: 'POST',
        match: '/community/v1/classifiers/uploaded-1/download-link',
        reply: () => {
          downloads = 13;
          return envelope({ success: true, download_token: 'tok-1', file_name: 'tumor.tlcls' });
        },
      },
      {
        method: 'GET',
        match: '/community/v1/classifiers/uploaded-1',
        reply: () => envelope({ success: true, classifier: { ...classifier, stats: { downloads } }, star_count: 4, is_starred: false }),
      },
    ]);
    let anchor: HTMLAnchorElement | null = null;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchor = this;
    });

    render(<ClassifierCard classifier={classifier} />);
    fireEvent.click(screen.getByRole('button', { name: /download/i }));

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(anchor!.href).toBe(`${COMMUNITY_API_ENDPOINT}/community/v1/classifiers/download/tok-1`);
    expect(anchor!.download).toBe('tumor_vs_stroma.tlcls');
    const link = calls.find((c) => c.url.endsWith('/download-link'));
    expect(link?.method).toBe('POST');
    expect(link?.headers.get('authorization')).toBe('Bearer firebase-token');
    // The card polls the detail route until the download count moves.
    await waitFor(() => expect(screen.getByText('13')).toBeInTheDocument());
  });

  it('Star toggles through the community star route and refreshes the count', async () => {
    let starred = false;
    const { calls } = installFetchMock([
      profile('author-card-1', 'Alpha Pathologist'),
      {
        method: 'POST',
        match: '/community/v1/classifiers/uploaded-1/star',
        reply: () => {
          starred = true;
          return envelope({ success: true, starCount: 5 });
        },
      },
      {
        method: 'GET',
        match: '/community/v1/classifiers/uploaded-1',
        reply: () => envelope({ success: true, classifier, star_count: starred ? 5 : 4, is_starred: starred }),
      },
    ]);
    const onStatsUpdate = vi.fn();
    render(<ClassifierCard classifier={classifier} onStatsUpdate={onStatsUpdate} />);
    await waitFor(() => expect(screen.getByText(/Stars:\s*4/)).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Add star'));
    await waitFor(() => expect(screen.getByTitle('Remove star')).toBeInTheDocument());
    expect(within(screen.getByTitle('Remove star')).getByText(/Stars:\s*5/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/star'))).toBe(true);
    expect(onStatsUpdate).toHaveBeenCalledWith('uploaded-1', { stars: 5 });
  });
});

describe('components/community/ModelCard', () => {
  it('shows the title, the resolved author and star / download counts from the community', async () => {
    installFetchMock([
      profile('author-card-2', 'Beta Researcher'),
      {
        method: 'GET',
        match: '/community/v1/models/uploaded-101',
        reply: () => envelope({ success: true, model: { ...model, stats: { downloads: 8 } }, star_count: 3, is_starred: true }),
      },
    ]);
    render(<ModelCard model={model} />);
    expect(screen.getByText('StarDist fluorescence weights')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Beta Researcher').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByTitle('Remove star')).toBeInTheDocument());
    expect(within(screen.getByTitle('Remove star')).getByText(/Stars:\s*3/)).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download/i })).toBeEnabled();
  });
});
