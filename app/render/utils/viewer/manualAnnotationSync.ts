/**
 * Coalescing serial write queue for User-Annotations/manual.json.
 * Hydrate waits until this instance is idle, then replaces from disk.
 *
 * Only APPROVED ids reach disk (see `approveManualPersist`): a drawing stays a
 * canvas-only draft until the annotation popup's Save button is clicked.
 */

import type { ManualAnnotationRecord } from '@/utils/viewer/annotation.utils';
import {
  extractManualPayload,
  manualRecordToAnnotorious,
  registerTrackedManualIdPredicate,
} from '@/utils/viewer/annotation.utils';
import {
  apiDeleteManualAnnotation,
  apiSaveManualAnnotation,
} from '@/utils/viewer/manualAnnotation.api';
import { isWriteBlockedPath } from '@/utils/common/pathAccess.utils';
import { toast } from 'sonner';

export type ManualUpsertPayload = ManualAnnotationRecord & { path: string };

type QueueItem =
  | {
      kind: 'upsert';
      id: string;
      instanceId: string;
      payload: ManualUpsertPayload;
      attempts?: number;
    }
  | {
      kind: 'delete';
      id: string;
      instanceId: string;
      path: string;
      attempts?: number;
    };

const pending = new Map<string, QueueItem>();
const order: string[] = [];
/** Last successfully written content fingerprint (excludes datetime/annotator). */
const lastSyncedKey = new Map<string, string>();
/**
 * Ids hydrated or queued for disk. Annotorious may drop properties.source;
 * isManualAnnotation reads this via registerTrackedManualIdPredicate.
 */
const knownManualIds = new Set<string>();
/** Upserts that exhausted retries — keep on canvas + allow deselect to re-enqueue. */
const needsResyncIds = new Set<string>();
/**
 * Ids allowed to reach manual.json: hydrated from disk, or explicitly saved
 * with the popup's Save button. A freshly drawn shape is a canvas-only DRAFT
 * until then — annotating / clearing / marking with it (or just deselecting)
 * must never write it to the Zarr sidecar.
 */
const persistApprovedIds = new Set<string>();

const MAX_ATTEMPTS = 3;

let inFlight: QueueItem | null = null;
let flushing = false;

type IdleWaiter = {
  path: string;
  resolve: () => void;
};
const idleWaiters: IdleWaiter[] = [];

registerTrackedManualIdPredicate((id) => knownManualIds.has(id));

/** Footer Save (or hydrate): from now on this drawing syncs to manual.json. */
export function approveManualPersist(id: string | null | undefined): void {
  const s = String(id || '');
  if (s) persistApprovedIds.add(s);
}

/** False while the drawing is still an unsaved draft. */
export function isManualPersistApproved(id: string | null | undefined): boolean {
  const s = String(id || '');
  return !!s && persistApprovedIds.has(s);
}

function contentKey(payload: ManualUpsertPayload): string {
  return JSON.stringify({
    id: payload.id,
    shape: payload.shape,
    vertices: payload.vertices,
    style: payload.style || '#00ff00',
    comment: payload.comment || '',
    path: payload.path,
  });
}

/** True when this exact content is already on disk, in-flight, or queued. */
export function isManualUpsertSynced(payload: ManualUpsertPayload): boolean {
  const id = String(payload.id);
  const key = contentKey(payload);
  const queued = pending.get(id);
  if (queued?.kind === 'upsert' && contentKey(queued.payload) === key) return true;
  if (
    inFlight?.kind === 'upsert' &&
    inFlight.id === id &&
    contentKey(inFlight.payload) === key
  ) {
    return true;
  }
  if (queued || inFlight?.id === id) return false;
  if (needsResyncIds.has(id)) return false;
  return lastSyncedKey.get(id) === key;
}

function itemPath(item: QueueItem): string {
  return item.kind === 'upsert' ? item.payload.path : item.path;
}

export function hasManualSyncWorkForPath(path: string | null | undefined): boolean {
  if (!path) return false;
  if (inFlight && itemPath(inFlight) === path) return true;
  for (const item of pending.values()) {
    if (itemPath(item) === path) return true;
  }
  return false;
}

/**
 * True when id still has queue / in-flight work, or a failed upsert awaiting retry.
 * Hydrate keep must NOT use knownManualIds — those survive peer deletes.
 */
export function isTrackedManualWrite(id: string | null | undefined): boolean {
  const s = String(id || '');
  if (!s) return false;
  return pending.has(s) || inFlight?.id === s || needsResyncIds.has(s);
}

/** True when a delete is queued or in-flight — hydrate must not resurrect from disk. */
export function isPendingManualDelete(id: string | null | undefined): boolean {
  const s = String(id || '');
  if (!s) return false;
  const queued = pending.get(s);
  if (queued?.kind === 'delete') return true;
  return inFlight?.kind === 'delete' && inFlight.id === s;
}

/** Resolve when no queue work remains for this zarr path, or after timeoutMs. */
export function whenManualSyncIdleOrTimeout(
  path: string,
  timeoutMs: number,
): Promise<void> {
  if (!hasManualSyncWorkForPath(path)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const waiter: IdleWaiter = {
      path,
      resolve: () => {
        clearTimeout(timer);
        done();
      },
    };
    const timer = setTimeout(() => {
      const idx = idleWaiters.indexOf(waiter);
      if (idx >= 0) idleWaiters.splice(idx, 1);
      done();
    }, timeoutMs);
    idleWaiters.push(waiter);
  });
}

function notifyIdle() {
  for (let i = idleWaiters.length - 1; i >= 0; i--) {
    const w = idleWaiters[i];
    if (!hasManualSyncWorkForPath(w.path)) {
      idleWaiters.splice(i, 1);
      w.resolve();
    }
  }
}

function toastBackgroundError(kind: 'upsert' | 'delete') {
  // Stable id — coalesce spam when several drawings fail together.
  toast.error(
    kind === 'delete'
      ? 'Failed to delete drawing from disk'
      : 'Failed to sync drawing to disk',
    { id: `manual-sync-${kind}` },
  );
}

function enqueueOrder(id: string) {
  if (!order.includes(id)) order.push(id);
}

function notifyManualAnnotationsChanged(
  instanceId: string,
  path?: string,
) {
  try {
    window.dispatchEvent(
      new CustomEvent('manual-annotations-changed', {
        detail: { instanceId, path },
      }),
    );
  } catch {}
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flushLoop() {
  if (flushing) return;
  flushing = true;
  try {
    while (order.length > 0) {
      const id = order.shift()!;
      const item = pending.get(id);
      pending.delete(id);
      if (!item) continue;

      const writePath =
        item.kind === 'upsert' ? item.payload.path : item.path;
      // Drop quietly if Viewer/Samples ACL landed after enqueue (open-slide race).
      if (isWriteBlockedPath(writePath)) {
        inFlight = null;
        notifyIdle();
        continue;
      }

      inFlight = item;
      try {
        if (item.kind === 'upsert') {
          await apiSaveManualAnnotation(item.instanceId, item.payload);
        } else {
          await apiDeleteManualAnnotation(item.instanceId, item.path, id);
        }
      } catch (err) {
        if (inFlight === item) inFlight = null;
        // Newer coalesced upsert may already be pending — loop will pick it up.
        if (pending.get(id)?.kind === 'upsert') {
          notifyIdle();
          continue;
        }
        const attempts = (item.attempts ?? 0) + 1;
        if (attempts < MAX_ATTEMPTS && !pending.has(id)) {
          pending.set(id, { ...item, attempts });
          enqueueOrder(id);
          await sleep(250 * attempts);
          notifyIdle();
          continue;
        }
        if (item.kind === 'upsert') {
          needsResyncIds.add(id);
        } else {
          // Canvas already dropped the shape; bring disk copy back so UI matches.
          try {
            window.dispatchEvent(
              new CustomEvent('manual-annotations-changed', {
                // Empty instanceId → every pane on this path re-pulls (incl. self).
                detail: { instanceId: '', path: item.path },
              }),
            );
          } catch {}
        }
        toastBackgroundError(item.kind);
        console.error('[manual-sync]', item.kind, 'failed', id, err);
        notifyIdle();
        continue;
      }
      if (inFlight === item) inFlight = null;
      needsResyncIds.delete(id);
      if (item.kind === 'upsert') {
        lastSyncedKey.set(id, contentKey(item.payload));
        knownManualIds.add(id);
      } else {
        lastSyncedKey.delete(id);
        // Keep knownManualIds after delete HTTP so Cmd+Z restore still passes
        // isManualAnnotation (REMOTE stamps drop properties.source; history
        // entries often lack it too). Hydrate keep uses isTrackedManualWrite,
        // not this set — stale ids after delete are harmless.
      }
      const path =
        item.kind === 'upsert' ? item.payload.path : item.path;
      notifyManualAnnotationsChanged(item.instanceId, path);
      notifyIdle();
    }
  } finally {
    flushing = false;
    notifyIdle();
    if (order.length > 0) void flushLoop();
  }
}

export function enqueueManualUpsert(
  instanceId: string,
  payload: ManualUpsertPayload,
): void {
  const id = String(payload.id);
  if (isWriteBlockedPath(payload.path)) {
    knownManualIds.add(id);
    return;
  }
  // Unsaved draft: track it as a manual drawing on canvas, but keep it off disk
  // until the popup's Save button approves it.
  if (!isManualPersistApproved(id)) {
    knownManualIds.add(id);
    return;
  }
  // Prefer newer upsert over queued delete (Cmd+Z restore after Delete).
  if (isManualUpsertSynced(payload)) return;

  knownManualIds.add(id);
  pending.set(id, { kind: 'upsert', id, instanceId, payload });
  enqueueOrder(id);
  void flushLoop();
}

/** Track a canvas-only manual id (e.g. view-only path) without enqueueing HTTP. */
export function rememberManualId(id: string | null | undefined): void {
  const s = String(id || '');
  if (s) knownManualIds.add(s);
}

export function enqueueManualDelete(
  instanceId: string,
  path: string,
  annotationId: string,
): void {
  if (isWriteBlockedPath(path)) return;
  const id = String(annotationId);
  // Never approved → nothing of it on disk; skip the pointless HTTP delete.
  if (!isManualPersistApproved(id)) {
    needsResyncIds.delete(id);
    lastSyncedKey.delete(id);
    return;
  }
  needsResyncIds.delete(id);
  pending.set(id, { kind: 'delete', id, instanceId, path });
  enqueueOrder(id);
  lastSyncedKey.delete(id);
  void flushLoop();
}

/** Seed fingerprints after hydrate so no-op deselect does not rewrite disk. */
export function seedManualSyncedFromDisk(
  path: string,
  records: ManualAnnotationRecord[],
): void {
  for (const rec of records) {
    if (!rec?.id || !rec.shape || !Array.isArray(rec.vertices)) continue;
    // Fingerprint must match extractManualPayload(live) after hydrate — raw disk
    // rectangle corner order can differ from bounds→TL-TR-BR-BL normalization.
    const ann = manualRecordToAnnotorious(rec);
    if (!ann) continue;
    const extracted = extractManualPayload(ann);
    if (!extracted) continue;
    const id = String(rec.id);
    // Already on disk — edits to it may sync without a fresh Save click.
    approveManualPersist(id);
    // Do not clear dirty / overwrite fingerprint for failed local upserts.
    if (needsResyncIds.has(id)) continue;
    const queued = pending.get(id);
    if (queued?.kind === 'delete' || queued?.kind === 'upsert') continue;
    if (inFlight?.id === id) continue;
    const payload: ManualUpsertPayload = {
      ...extracted,
      path,
      annotator: rec.annotator,
      datetime: rec.datetime,
    };
    knownManualIds.add(id);
    lastSyncedKey.set(id, contentKey(payload));
  }
}
