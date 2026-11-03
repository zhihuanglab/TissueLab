"use client";

import React, { useState, useEffect, useRef } from 'react';

import { getAnalysisGroupsBatch } from '@/services/data.service';
import { createVisibleRowLoader } from '@/utils/dashboard/visibleRowLoader';
import type { WorkflowRunFinishedPayload } from '@/utils/agent/workflow/completionSideEffects';
import { workflowZarrPathsMatch } from '@/utils/agent/workflow/pathNorm';
import eventBus from '@/utils/common/eventBus';

/**
 * Lazy analysis badges for a WSI that has a companion .zarr.
 *
 * Which analyses a store holds is decided by the service
 * (`ANALYSIS_GROUP_REQUIRED` in app/services/data.py): a group counts only
 * once the child proving its result exists, since `write_node_userdata`
 * creates empty groups holding only userData.
 *
 * Nothing is drawn until a read comes back, so a list of slides without
 * analyses stays still.
 *
 * Reads are viewport-gated (only rows that settle in view), batched,
 * deduplicated and capped. What they found is remembered (see `badgeCache`),
 * and a pre-run, upload or workflow run finishing makes the affected rows
 * read again.
 */

const ZARR_GROUP_TO_BADGE: Record<string, string> = {
  'Cell-Segmentation': 'Cell Segmentation',
  'Cell-Classification': 'Cell Classification',
  'Patch-Segmentation': 'Patch Segmentation',
  'Patch-Classification': 'Patch Classification',
  'Tissue-Segmentation': 'Tissue Segmentation',
};

const BADGE_ORDER = [
  'Cell Segmentation',
  'Cell Classification',
  'Patch Segmentation',
  'Patch Classification',
  'Tissue Segmentation',
];

const toBadges = (groups: readonly string[]): string[] => {
  const labels = new Set(groups.map((group) => ZARR_GROUP_TO_BADGE[group]));
  return BADGE_ORDER.filter((b) => labels.has(b));
};

/**
 * A screenful of slides goes out as one request; the server checks the stores
 * in parallel. Two in flight so a scroll can start the next screen while the
 * last one is still being read.
 */
const MAX_CONCURRENT_BADGE_REQUESTS = 2;
const MAX_STORES_PER_BADGE_REQUEST = 24;

const badgeReader = createVisibleRowLoader<string[]>({
  readBatch: async (paths) => {
    const results = await getAnalysisGroupsBatch(paths);
    const badges: Record<string, string[] | undefined> = {};
    for (const path of paths) {
      const result = results[path];
      if (result?.groups) {
        badges[path] = toBadges(result.groups);
      } else if (result?.error) {
        console.warn('ZarrBadgesCell: failed to read', path, result.error);
        badges[path] = [];
      }
    }
    return badges;
  },
  onError: (path, error) => {
    // Non-critical: hide badges on failure; a remount or list refresh retries.
    console.warn('ZarrBadgesCell: failed to read', path, error);
    return [];
  },
  maxConcurrent: MAX_CONCURRENT_BADGE_REQUESTS,
  maxBatch: MAX_STORES_PER_BADGE_REQUEST,
});

/** Rows scrolled past quicker than this never ask for a read. */
const VISIBLE_BEFORE_READ_MS = 150;

/** Rows mounted right now, so a write reaches each affected row once. */
type WriteSubscriber = { path: () => string; written: () => void };
const writeSubscribers = new Set<WriteSubscriber>();

/**
 * Badges read recently, so a row the virtualized list unmounts and brings back
 * shows them at once instead of going blank until a new read lands.
 *
 * A write that announces itself drops the entries it affects (see
 * `storesWritten`). One that does not — another user's run, a script — is
 * caught when the user comes back to the tab or presses Refresh (see
 * `revalidateBadges`), and otherwise by age: past BADGE_FRESH_MS an entry is
 * still shown, but read again while it is.
 */
const BADGE_FRESH_MS = 60_000;
const BADGE_CACHE_LIMIT = 5000;
const badgeCache = new Map<string, { badges: string[]; readAt: number }>();
// Bumped by every write. A read whose reply comes back after a write may
// predate it, so its reply is shown by version (see the cell) but not cached.
let writesSeen = 0;

const rememberBadges = (path: string, badges: string[]) => {
  badgeCache.delete(path);
  badgeCache.set(path, { badges, readAt: Date.now() });
  while (badgeCache.size > BADGE_CACHE_LIMIT) {
    const oldest = badgeCache.keys().next().value;
    if (oldest === undefined) break;
    badgeCache.delete(oldest);
  }
};

/** What the cache knows about `path`, as of `version` if still fresh. */
const fromCache = (path: string, version: number) => {
  const hit = badgeCache.get(path);
  if (!hit) return null;
  // Stale: shown, but at a version no read has reached, so it is read again.
  const asOf = Date.now() - hit.readAt < BADGE_FRESH_MS ? version : -1;
  return { zarrPath: path, badges: hit.badges, version: asOf };
};

/** Stores matching `matches` (all when omitted) were just written. */
const storesWritten = (matches?: (path: string) => boolean) => {
  // First, so the re-reads below cannot join a read sent before the write.
  badgeReader.invalidate(matches);
  writesSeen += 1;
  for (const path of [...badgeCache.keys()]) {
    if (!matches || matches(path)) badgeCache.delete(path);
  }
  writeSubscribers.forEach((s) => {
    if (!matches || matches(s.path())) s.written();
  });
};

/**
 * What is on screen may be out of date: the user pressed Refresh, or came back
 * to the tab after working elsewhere (another tab, the Image Viewer, someone
 * else's run). Badges stay up; every row on screen reads again in the
 * background, and every remembered entry is stale until it is read again.
 */
export const revalidateBadges = () => {
  for (const entry of badgeCache.values()) entry.readAt = 0;
  writeSubscribers.forEach((s) => s.written());
};

// One set of listeners for the whole list, not one per row.
if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') revalidateBadges();
  });
  const onAnyStoreWritten = () => storesWritten();
  window.addEventListener('tissuelab:preRunCompleted', onAnyStoreWritten);
  window.addEventListener('tissuelab:cloudUploadCompleted', onAnyStoreWritten);
  // A workflow run from the Image Viewer, whose sidebar list stays mounted
  // through it. Only the store it wrote; no path means we cannot tell.
  eventBus.on('workflow-graph-run-finished', (payload?: WorkflowRunFinishedPayload) => {
    const output = payload?.outputPath;
    storesWritten(output ? (path) => workflowZarrPathsMatch(output, path) : undefined);
  });
}

interface ZarrBadgesCellProps {
  zarrPath: string;
  /**
   * Badge labels to hide even though the group is present. Used while a
   * pre-run is still going on the slide: the seg node writes centroids before
   * it starts embedding, so a store read mid-run already satisfies the
   * "Cell Segmentation" rule and the result badge would sit next to the
   * "Processing" badge.
   */
  suppress?: readonly string[];
}

const ZarrBadgesCell: React.FC<ZarrBadgesCellProps> = ({ zarrPath, suppress }) => {
  // What was read, for which store, as of which write.
  const [known, setKnown] = useState<{ zarrPath: string; badges: string[]; version: number } | null>(null);
  // Bumped when this store is written. A read only counts if it was asked for
  // at the current version, so a reply sent before the write cannot settle it.
  const [version, setVersion] = useState(0);
  const [elementRef, setElementRef] = useState<HTMLSpanElement | null>(null);
  const pathRef = useRef(zarrPath);
  pathRef.current = zarrPath;

  // What this row read for this slide, else what the cache remembers.
  const current = known?.zarrPath === zarrPath ? known : fromCache(zarrPath, version);
  const needsRead = !current || current.version !== version;

  // Read only once the row has stayed in view for a moment. The list is
  // virtualized: dragging the scrollbar mounts and unmounts rows faster than
  // any read can finish, and those rows must not queue reads at all. Leaving
  // view, unmounting, switching slides or a newer write aborts — a read still
  // waiting is dropped, so the rows the user stops on go first.
  useEffect(() => {
    if (!elementRef || !needsRead) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const stop = () => {
      clearTimeout(timer);
      timer = undefined;
      controller?.abort();
      controller = undefined;
    };
    const start = () => {
      if (timer || controller) return;
      timer = setTimeout(() => {
        timer = undefined;
        const own = new AbortController();
        controller = own;
        const writesAtAsk = writesSeen;
        badgeReader.get(zarrPath, own.signal).then(
          (badges) => {
            if (own.signal.aborted) return;
            if (writesSeen === writesAtAsk) rememberBadges(zarrPath, badges);
            setKnown({ zarrPath, badges, version });
          },
          () => { /* aborted: the row left view, changed slide or was written again */ },
        );
      }, VISIBLE_BEFORE_READ_MS);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry?.isIntersecting) start();
        else stop();
      },
      { threshold: 0.1, rootMargin: '50px' }
    );
    observer.observe(elementRef);
    return () => {
      observer.disconnect();
      stop();
    };
  }, [elementRef, needsRead, zarrPath, version]);

  // Something just wrote into a store. The listing refreshes on these too, but
  // that alone does not reach us: the row keeps its React key, so this instance
  // is reused and would go on showing the groups it read before the run.
  useEffect(() => {
    const subscriber = { path: () => pathRef.current, written: () => setVersion((v) => v + 1) };
    writeSubscribers.add(subscriber);
    return () => { writeSubscribers.delete(subscriber); };
  }, []);

  // While a re-read is pending the old badges stay up, so a write elsewhere in
  // the list does not blank every row and bring them back a moment later.
  const shown = current
    ? (suppress?.length ? current.badges.filter((b) => !suppress.includes(b)) : current.badges)
    : [];

  return (
    <>
      {shown.map((label, i) => (
        <span
          key={label}
          // While a re-read is owed, the first badge is what the observer
          // watches: an extra element after the badges could wrap onto a line
          // of its own and make the row jump.
          ref={i === 0 && needsRead ? setElementRef : undefined}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
          title={`This slide has ${label} results stored in its companion .zarr`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70" />
          {label}
        </span>
      ))}
      {/* Nothing to show yet. This used to be a pulsing placeholder pill, which
          put a shimmer on every slide in view and then removed most of them
          again — few slides have analyses. Anchor the observer on something the
          eye cannot find instead, and let real badges be the only thing that
          ever appears. */}
      {needsRead && shown.length === 0 && (
        <span ref={setElementRef} className="inline-block h-px w-px" aria-hidden />
      )}
    </>
  );
};

export default ZarrBadgesCell;
