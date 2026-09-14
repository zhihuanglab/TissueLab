import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { AI_SERVICE_API_ENDPOINT } from '@/config/api.config';
// The root store must be evaluated before the slice is imported on its own:
// authToken -> store -> slice -> apiFetch -> authToken is an import cycle in
// the renderer, and the app always reaches the store first.
import '@/store/zustand/store';
import { useWorkflowHistoryStore, type WorkflowHistoryStore } from '@/store/zustand/slice/workflowHistory';
import { envelope, installFetchMock, jsonResponse } from '../helpers/fetchMock';

// The session token comes from Firebase; pin it so the header assertions are stable.
vi.mock('@/utils/common/authToken', () => ({
  AUTH_MISSING_ERROR: 'Authentication required',
  LOCAL_DEFAULT_TOKEN: 'local-default-token',
  getAuthToken: vi.fn(async () => 'local'),
  forceRefreshAuthToken: vi.fn(async () => null),
  notifyMissingAuth: vi.fn(),
}));

const BASE = `${AI_SERVICE_API_ENDPOINT}/workflow_history/v1/workflow_history`;

const makeStore = () => create<WorkflowHistoryStore>()(useWorkflowHistoryStore);

const cloudEntries = [
  {
    id: 'entry-b',
    name: 'Tumor count',
    created_at: '2026-02-01T10:00:00Z',
    updated_at: '2026-02-01T10:00:00Z',
    zarr_path: 'users/local/CMU-1.svs.zarr',
    panels: [],
    output_path: 'users/local',
    color: 'green',
    number: 2,
  },
  {
    id: 'entry-a',
    name: 'Nuclei seg',
    created_at: '2026-01-01T10:00:00Z',
    updated_at: '2026-01-01T10:00:00Z',
    zarr_path: 'users/local/CMU-1.svs.zarr',
    panels: [],
    output_path: 'users/local',
  },
];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('store/zustand/slice/workflowHistory', () => {
  it('starts empty', () => {
    const store = makeStore();
    expect(store.getState().entries).toEqual([]);
    expect(store.getState().nextNumber).toBe(1);
    expect(store.getState().selectedHistoryId).toBeNull();
  });

  it('loadFromCloud GETs /workflow_history/v1/workflow_history and maps the entries', async () => {
    const { calls } = installFetchMock([{ method: 'GET', match: '/workflow_history/v1/workflow_history', reply: () => envelope({ entries: cloudEntries }) }]);
    const store = makeStore();

    await store.getState().loadFromCloud();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(BASE);
    expect(calls[0].headers.get('authorization')).toBe('Bearer local');

    const { entries, nextNumber } = store.getState();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: 'entry-b',
      name: 'Tumor count',
      number: 2,
      color: 'green',
      timestamp: Date.parse('2026-02-01T10:00:00Z'),
      outputPath: 'users/local',
      zarrPath: 'users/local/CMU-1.svs.zarr',
    });
    // Missing number/color are derived: position-based number, deterministic colour.
    expect(entries[1].id).toBe('entry-a');
    expect(entries[1].number).toBe(1);
    expect(typeof entries[1].color).toBe('string');
    expect(entries[1].color.length).toBeGreaterThan(0);
    expect(nextNumber).toBe(3);
  });

  it('loadFromCloud keeps the current state when the service is unreachable', async () => {
    installFetchMock([{ method: 'GET', match: '/workflow_history/v1/workflow_history', reply: () => jsonResponse({ detail: 'down' }, { status: 503 }) }]);
    const store = makeStore();
    store.setState({ entries: [{ id: 'x', number: 1, name: 'kept', color: 'blue', timestamp: 1, panels: [], outputPath: '', zarrPath: '' }], nextNumber: 2 });

    await expect(store.getState().loadFromCloud()).resolves.toBeUndefined();

    expect(store.getState().entries.map((e) => e.id)).toEqual(['x']);
    expect(console.warn).toHaveBeenCalled();
  });

  it('addEntry updates the store immediately and POSTs the entry to the service', async () => {
    const { calls } = installFetchMock([{ method: 'POST', match: '/workflow_history/v1/workflow_history', reply: () => envelope({ id: 'ignored' }) }]);
    const store = makeStore();
    const panels = [{ id: 'p1', type: 'StarDist', stepName: 'NucleiSeg', content: [] }] as any;

    store.getState().addEntry('Run 1', panels, 'users/local', 'users/local/CMU-1.svs.zarr');

    const [entry] = store.getState().entries;
    expect(entry).toMatchObject({ name: 'Run 1', number: 1, outputPath: 'users/local', zarrPath: 'users/local/CMU-1.svs.zarr' });
    expect(entry.panels).toEqual(panels);
    expect(entry.panels).not.toBe(panels); // deep-copied snapshot
    expect(store.getState().nextNumber).toBe(2);

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(BASE);
    expect(calls[0].headers.get('authorization')).toBe('Bearer local');
    expect(calls[0].body).toMatchObject({
      id: entry.id,
      name: 'Run 1',
      zarr_path: 'users/local/CMU-1.svs.zarr',
      output_path: 'users/local',
      panels,
      color: entry.color,
      number: 1,
    });
  });

  it('renameEntry and updateEntry re-save the entry; removeEntry DELETEs it', async () => {
    const { calls } = installFetchMock([
      { method: 'POST', match: '/workflow_history/v1/workflow_history', reply: () => envelope({}) },
      { method: 'DELETE', match: '/workflow_history/v1/workflow_history/', reply: () => envelope({}) },
    ]);
    const store = makeStore();
    store.getState().addEntry('Run 1', [], 'users/local', 'zarr');
    const id = store.getState().entries[0].id;
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    store.getState().renameEntry(id, 'Renamed');
    expect(store.getState().entries[0].name).toBe('Renamed');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].method).toBe('POST');
    expect(calls[1].body).toMatchObject({ id, name: 'Renamed' });

    store.getState().updateEntry(id, [{ id: 'p2', type: 'NuClass', stepName: 'NucleiClassify', content: [] }] as any, 'users/local/out');
    expect(store.getState().entries[0].outputPath).toBe('users/local/out');
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2].body).toMatchObject({ id, name: 'Renamed', output_path: 'users/local/out' });

    store.getState().selectEntry(id);
    store.getState().removeEntry(id);
    expect(store.getState().entries).toEqual([]);
    expect(store.getState().selectedHistoryId).toBeNull();
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls[3].method).toBe('DELETE');
    expect(calls[3].url).toBe(`${BASE}/${id}`);
  });

  it('a failed save is logged but does not roll back the local entry', async () => {
    installFetchMock([{ method: 'POST', match: '/workflow_history/v1/workflow_history', reply: () => envelope({}, 500, 'disk full') }]);
    const store = makeStore();
    store.getState().addEntry('Run 1', [], 'users/local', 'zarr');
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(store.getState().entries).toHaveLength(1);
  });

  it('stashLivePanels / clearSelection manage the preview snapshot', () => {
    const store = makeStore();
    const panels = [{ id: 'p', type: 'x', stepName: 'y', content: [] }] as any;
    store.getState().stashLivePanels(panels, 'users/local');
    expect(store.getState().stashedPanels).toEqual(panels);
    expect(store.getState().stashedOutputPath).toBe('users/local');
    store.getState().clearSelection();
    expect(store.getState().stashedPanels).toBeNull();
    expect(store.getState().stashedOutputPath).toBeNull();
  });
});
