import { StateCreator, StoreApi } from 'zustand';
import { WorkflowPanel } from '@/store/slices/chat/workflowSlice';
import {
  CloudWorkflowHistoryEntry,
  saveWorkflowHistory,
  fetchWorkflowHistoryList,
  deleteWorkflowHistoryEntry,
} from '@/utils/workflowHistoryApi';

const MAX_ENTRIES = 50;

const TAG_COLORS = ['purple', 'blue', 'yellow', 'green', 'orange', 'cyan', 'pink'] as const;

function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Deterministic color from id — stable across sessions */
function pickColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

export interface WorkflowHistoryEntry {
  id: string;
  number: number;
  name: string;
  color: string;
  timestamp: number;
  panels: WorkflowPanel[];
  outputPath: string;
  zarrPath: string;
}

function cloudToLocal(e: CloudWorkflowHistoryEntry, number: number): WorkflowHistoryEntry {
  return {
    id: e.id,
    number: e.number ?? number,
    name: e.name,
    color: e.color ?? pickColor(e.id),
    timestamp: e.created_at ? new Date(e.created_at).getTime() : Date.now(),
    panels: e.panels,
    outputPath: e.output_path,
    zarrPath: e.zarr_path,
  };
}

type WorkflowHistoryState = {
  entries: WorkflowHistoryEntry[];
  nextNumber: number;
  selectedHistoryId: string | null;
  /** Snapshot of the live (editable) panels before a history preview was loaded */
  stashedPanels: WorkflowPanel[] | null;
  stashedOutputPath: string | null;
};

type WorkflowHistoryAction = {
  /** Save a new entry locally and sync to Firebase (fire-and-forget) */
  addEntry: (name: string, panels: WorkflowPanel[], outputPath: string, zarrPath: string) => void;
  updateEntry: (id: string, panels: WorkflowPanel[], outputPath: string) => void;
  removeEntry: (id: string) => void;
  clearAll: () => void;
  selectEntry: (id: string) => void;
  clearSelection: () => void;
  stashLivePanels: (panels: WorkflowPanel[], outputPath: string) => void;
  /** Rename an existing entry */
  renameEntry: (id: string, name: string) => void;
  /** Fetch all entries from Firebase and populate the store */
  loadFromCloud: () => Promise<void>;
};

export type WorkflowHistoryStore = WorkflowHistoryState & WorkflowHistoryAction;

const initialState: WorkflowHistoryState = {
  entries: [],
  nextNumber: 1,
  selectedHistoryId: null,
  stashedPanels: null,
  stashedOutputPath: null,
};

const workflowHistoryActions = (
  set: StoreApi<WorkflowHistoryStore>['setState'],
  get: StoreApi<WorkflowHistoryStore>['getState']
): WorkflowHistoryAction => ({
  addEntry: (name, panels, outputPath, zarrPath) => {
    const state = get();
    const id = generateId();
    const color = pickColor(id);
    const number = state.nextNumber;
    const entry: WorkflowHistoryEntry = {
      id,
      number,
      name,
      color,
      timestamp: Date.now(),
      panels: JSON.parse(JSON.stringify(panels)),
      outputPath,
      zarrPath,
    };
    const newEntries = [entry, ...state.entries].slice(0, MAX_ENTRIES);
    set({ entries: newEntries, nextNumber: number + 1 });

    // Sync to Firebase (fire-and-forget — UI is already updated)
    saveWorkflowHistory({
      id,
      name,
      zarr_path: zarrPath,
      panels,
      output_path: outputPath,
      color,
      number,
    }).catch((err) => console.error('[workflowHistory] Firebase save failed:', err));
  },
  updateEntry: (id, panels, outputPath) => {
    const state = get();
    const existing = state.entries.find((e) => e.id === id);
    const newEntries = state.entries.map((e) =>
      e.id === id
        ? { ...e, panels: JSON.parse(JSON.stringify(panels)), outputPath, timestamp: Date.now() }
        : e
    );
    set({ entries: newEntries });

    if (existing) {
      saveWorkflowHistory({
        id,
        name: existing.name,
        zarr_path: existing.zarrPath,
        panels,
        output_path: outputPath,
        color: existing.color,
        number: existing.number,
      }).catch((err) => console.error('[workflowHistory] Firebase update failed:', err));
    }
  },
  removeEntry: (id) => {
    const state = get();
    const newEntries = state.entries.filter((e) => e.id !== id);
    const clearSel = state.selectedHistoryId === id;
    set({
      entries: newEntries,
      ...(clearSel ? { selectedHistoryId: null, stashedPanels: null, stashedOutputPath: null } : {}),
    });

    deleteWorkflowHistoryEntry(id).catch((err) =>
      console.error('[workflowHistory] Firebase delete failed:', err)
    );
  },
  clearAll: () => {
    const { entries } = get();
    set({ entries: [], nextNumber: 1, selectedHistoryId: null, stashedPanels: null, stashedOutputPath: null });

    // Delete all from Firebase (fire-and-forget)
    entries.forEach((e) =>
      deleteWorkflowHistoryEntry(e.id).catch(() => {})
    );
  },
  selectEntry: (id) => {
    set({ selectedHistoryId: id });
  },
  clearSelection: () => {
    set({ selectedHistoryId: null, stashedPanels: null, stashedOutputPath: null });
  },
  stashLivePanels: (panels, outputPath) => {
    // Always snapshot whatever is currently on screen before navigating to another history entry,
    // so the Workflow sidebar button can restore the previous preview instead of dropping it.
    set({
      stashedPanels: JSON.parse(JSON.stringify(panels)),
      stashedOutputPath: outputPath,
    });
  },
  renameEntry: (id, name) => {
    const state = get();
    const existing = state.entries.find((e) => e.id === id);
    if (!existing) return;
    const newEntries = state.entries.map((e) => (e.id === id ? { ...e, name } : e));
    set({ entries: newEntries });

    saveWorkflowHistory({
      id,
      name,
      zarr_path: existing.zarrPath,
      panels: existing.panels,
      output_path: existing.outputPath,
      color: existing.color,
      number: existing.number,
    }).catch((err) => console.error('[workflowHistory] Firebase rename failed:', err));
  },
  loadFromCloud: async () => {
    try {
      const cloud = await fetchWorkflowHistoryList();
      const local = cloud.map((e, i) => cloudToLocal(e, cloud.length - i));
      const maxNumber = local.reduce((m, e) => Math.max(m, e.number), 0);
      set({ entries: local, nextNumber: maxNumber + 1 });
    } catch (err) {
      // Backend may be offline (e.g. local UI iteration) — degrade silently to existing/empty state.
      // Use warn instead of error so the Next.js dev overlay doesn't treat it as a runtime crash.
      if (typeof window !== 'undefined') {
        console.warn('[workflowHistory] loadFromCloud skipped — backend unreachable:', err);
      }
    }
  },
});

export const useWorkflowHistoryStore: StateCreator<WorkflowHistoryStore> = (
  set,
  get,
  api
) => ({
  ...initialState,
  ...workflowHistoryActions(set, get),
});
