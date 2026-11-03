"use client";

import React, { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import { Image as ImageIcon } from 'lucide-react';
import { InlineSpinner } from '@/components/assets/PageLoading';
import { cancelPreviewTasks, getPreviewStatusBatch, submitPreviewBatch } from '@/services/file.service';
import { ImagePreviewType } from '@/types/fileManager.types';
import type { WorkflowRunFinishedPayload } from '@/utils/agent/workflow/completionSideEffects';
import { workflowZarrPathsMatch } from '@/utils/agent/workflow/pathNorm';
import eventBus from '@/utils/common/eventBus';
import { createVisibleRowLoader } from '@/utils/dashboard/visibleRowLoader';

interface ImagePreviewCellProps {
  fileName: string;
  fullPath: string;
  imageType: ImagePreviewType;
  /** Small tile (Image Viewer sidebar): no captions, small spinner and icon. */
  compact?: boolean;
}

type PreviewData = {
  thumbnail?: string | null;
  macro?: string | null;
  label?: string | null;
  cell_overlay?: string | null;
  patch_overlay?: string | null;
  filename: string;
  available: string[];
  source_file?: string;
};

/**
 * Previews already fetched, so a row the virtualized file list unmounts and
 * brings back shows its images at once instead of fetching them again.
 *
 * Keyed by path and preview type: the thumbnail / label / macro cells of one
 * slide all read the bundled 'all' preview, so they share one entry and one
 * read. A Map keeps insertion order, which makes the oldest entry the
 * first one — re-inserting on read turns that into least-recently-used.
 * Failures are not stored, so Retry and the next mount still try again.
 */
const PREVIEW_CACHE_LIMIT = 200;
const previewCache = new Map<string, PreviewData>();

type PreviewKind = 'all' | 'cell_overlay' | 'patch_overlay';

const previewTypeFor = (imageType: ImagePreviewType): PreviewKind =>
  imageType === 'cell_overlay' || imageType === 'patch_overlay' ? imageType : 'all';

const previewCacheKey = (fullPath: string, imageType: ImagePreviewType) =>
  `${fullPath}|${previewTypeFor(imageType)}`;

const readCachedPreview = (key: string): PreviewData | null => {
  const hit = previewCache.get(key);
  if (!hit) return null;
  previewCache.delete(key);
  previewCache.set(key, hit);
  return hit;
};

const rememberPreview = (key: string, data: PreviewData) => {
  previewCache.delete(key);
  previewCache.set(key, data);
  while (previewCache.size > PREVIEW_CACHE_LIMIT) {
    const oldest = previewCache.keys().next().value;
    if (oldest === undefined) break;
    previewCache.delete(oldest);
  }
};

const PREVIEW_SIZE = 200;
/** How often one status request covers every preview still being generated. */
const PREVIEW_POLL_MS = 500;
const PREVIEW_TIMEOUT_MS = 60_000;
/** Rows scrolled past quicker than this never ask for a preview. */
const VISIBLE_BEFORE_READ_MS = 150;

const splitKey = (key: string): [string, PreviewKind] => {
  const at = key.lastIndexOf('|');
  return [key.slice(0, at), key.slice(at + 1) as PreviewKind];
};

/**
 * Every preview task still being generated, across all batches, so one status
 * request every PREVIEW_POLL_MS covers them all. A task whose row is gone, or
 * that ran out of time, stops being waited for and is cancelled if it has not
 * started.
 */
type WaitingTask = { wanted: () => boolean; deadline: number; done: (data: PreviewData | null) => void };
const waitingTasks = new Map<string, WaitingTask>();
const STATUS_IDS_PER_REQUEST = 100;
let pollScheduled = false;

const schedulePoll = () => {
  if (pollScheduled || waitingTasks.size === 0) return;
  pollScheduled = true;
  setTimeout(() => { void pollPreviewTasks(); }, PREVIEW_POLL_MS);
};

const pollPreviewTasks = async () => {
  try {
    const now = Date.now();
    const dropped: string[] = [];
    for (const [id, task] of waitingTasks) {
      if (!task.wanted() || now > task.deadline) {
        waitingTasks.delete(id);
        dropped.push(id);
        task.done(null);
      }
    }
    if (dropped.length) void cancelPreviewTasks(dropped).catch(() => { /* best effort: it just runs */ });
    const ids = [...waitingTasks.keys()];
    for (let i = 0; i < ids.length; i += STATUS_IDS_PER_REQUEST) {
      const chunk = ids.slice(i, i + STATUS_IDS_PER_REQUEST);
      let statuses: Awaited<ReturnType<typeof getPreviewStatusBatch>>;
      try {
        statuses = await getPreviewStatusBatch(chunk);
      } catch {
        continue;   // a blip: these tasks are asked about again next time
      }
      for (const id of chunk) {
        const task = waitingTasks.get(id);
        const st = statuses[id];
        if (!task || st?.status === 'pending' || st?.status === 'processing') continue;
        waitingTasks.delete(id);
        task.done(st?.status === 'completed' ? st.result : null);
      }
    }
  } finally {
    pollScheduled = false;
    schedulePoll();
  }
};

const waitForTask = (taskId: string, wanted: () => boolean) =>
  new Promise<PreviewData | null>((done) => {
    waitingTasks.set(taskId, { wanted, deadline: Date.now() + PREVIEW_TIMEOUT_MS, done });
    schedulePoll();
  });

/**
 * Previews are generated on the server, a slide open each, by a few workers.
 * One row, one task and one status poll a second used to mean a drag through
 * the list queued a task for every slide it passed and kept polling for all
 * of them, while the slides the user stopped on waited behind. Now a screenful
 * is one submit, every task still running shares one poll, and a task whose
 * row left before it started is cancelled.
 */
const previewReader = createVisibleRowLoader<PreviewData | null>({
  readBatch: async (keys, wanted) => {
    const out: Record<string, PreviewData | null> = {};
    const byKind = new Map<PreviewKind, string[]>();
    for (const key of keys) {
      const [, kind] = splitKey(key);
      byKind.set(kind, [...(byKind.get(kind) ?? []), key]);
    }
    const waits: Promise<void>[] = [];
    for (const [kind, kindKeys] of byKind) {
      let submitted: Awaited<ReturnType<typeof submitPreviewBatch>>;
      try {
        submitted = await submitPreviewBatch(kindKeys.map((k) => splitKey(k)[0]), kind, PREVIEW_SIZE);
      } catch {
        kindKeys.forEach((key) => { out[key] = null; });
        continue;
      }
      for (const key of kindKeys) {
        const entry = submitted[splitKey(key)[0]];
        if (entry?.result) {
          out[key] = entry.result;
        } else if (entry?.task_id) {
          waits.push(waitForTask(entry.task_id, () => wanted(key)).then((data) => { out[key] = data; }));
        } else {
          out[key] = null;
        }
      }
    }
    await Promise.all(waits);
    return out;
  },
  // Failures are not remembered: Retry and the next mount try again.
  onError: () => null,
  // A batch holds its slot while its slides are generated; the server bounds
  // the actual work, so allow enough that a new screen never waits for a slot.
  maxConcurrent: 16,
  maxBatch: 24,
});

/** Overlay cells mounted right now; their images change when results are written. */
type OverlaySubscriber = { path: () => string; written: () => void };
const overlaySubscribers = new Set<OverlaySubscriber>();

/**
 * Previews of slides matching `matches` (all when omitted) are out of date:
 * overlays when results were written, every kind when the slide itself may
 * have been replaced.
 */
const previewsOutdated = (kinds: 'overlays' | 'all', matches?: (slidePath: string) => boolean) => {
  const affected = (key: string) => {
    const [path, kind] = splitKey(key);
    return (kinds === 'all' || kind !== 'all') && (!matches || matches(path));
  };
  previewReader.invalidate(affected);
  for (const key of [...previewCache.keys()]) {
    if (affected(key)) previewCache.delete(key);
  }
  overlaySubscribers.forEach((s) => {
    if (!matches || matches(s.path())) s.written();
  });
};

if (typeof window !== 'undefined') {
  // An upload can replace a slide under the same path. Mounted thumbnails keep
  // what they show until they remount, as before; nothing new joins an old read.
  window.addEventListener('tissuelab:cloudUploadCompleted', () => previewsOutdated('all'));
  // A finished analysis rewrites the overlay previews.
  window.addEventListener('tissuelab:preRunCompleted', () => previewsOutdated('overlays'));
  eventBus.on('workflow-graph-run-finished', (payload?: WorkflowRunFinishedPayload) => {
    const output = payload?.outputPath;
    previewsOutdated('overlays', output ? (path) => workflowZarrPathsMatch(output, path) : undefined);
  });
}

const ImagePreviewCell: React.FC<ImagePreviewCellProps> = ({
  fileName,
  fullPath,
  imageType,
  compact = false,
}) => {
  const cacheKey = previewCacheKey(fullPath, imageType);
  const isOverlay = previewTypeFor(imageType) !== 'all';
  const [previewData, setPreviewData] = useState<PreviewData | null>(
    () => readCachedPreview(cacheKey),
  );
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry and, for overlays, by a write to the slide's results.
  const [attempt, setAttempt] = useState(0);
  const [elementRef, setElementRef] = useState<HTMLDivElement | null>(null);
  const pathRef = useRef(fullPath);
  pathRef.current = fullPath;

  // A different slide or preview type: show its cached preview, if any.
  useEffect(() => {
    setPreviewData(readCachedPreview(cacheKey));
    setError(null);
  }, [cacheKey]);

  useEffect(() => {
    if (!isOverlay) return;
    const subscriber = {
      path: () => pathRef.current,
      written: () => {
        setPreviewData(null);
        setError(null);
        setAttempt((n) => n + 1);
      },
    };
    overlaySubscribers.add(subscriber);
    return () => { overlaySubscribers.delete(subscriber); };
  }, [isOverlay]);

  // Ask only once the row has stayed in view for a moment; leaving view,
  // unmounting or switching slides aborts, which cancels a task not yet started.
  useEffect(() => {
    if (!elementRef || previewData || error) return;
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
        previewReader.get(cacheKey, own.signal).then(
          (data) => {
            if (own.signal.aborted) return;
            if (data) {
              rememberPreview(cacheKey, data);
              setPreviewData(data);
            } else {
              // Shown as "No <type>", as before; not remembered, so the next
              // mount tries again.
              setError('Failed to load preview');
              setPreviewData({ thumbnail: null, macro: null, label: null, filename: fileName, available: [], source_file: fullPath });
            }
          },
          () => { /* aborted: the row left view or changed slide */ },
        );
      }, VISIBLE_BEFORE_READ_MS);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry?.isIntersecting) start();
        else stop();
      },
      { threshold: 0.1, rootMargin: '50px' },
    );
    observer.observe(elementRef);
    return () => {
      observer.disconnect();
      stop();
    };
  }, [elementRef, previewData, error, cacheKey, attempt, fileName, fullPath]);

  const getCurrentImage = () => {
    if (!previewData) return null;
    // Ensure we're getting the correct image type
    const imageData = previewData[imageType];

    // Additional validation to prevent cross-contamination
    if (imageData && typeof imageData === 'string' && imageData.startsWith('data:image/')) {
      return imageData;
    }

    return null;
  };

  if (compact && !previewData) {
    return (
      <div ref={setElementRef} className="flex h-full w-full items-center justify-center rounded bg-muted">
        {error ? <ImageIcon className="h-3 w-3 text-muted-foreground" /> : <InlineSpinner size={12} color="var(--primary)" />}
      </div>
    );
  }

  if (error && !previewData) {
    return (
      <div
        ref={setElementRef}
        className="flex h-full w-full items-center justify-center rounded bg-destructive/10"
      >
        <div className="p-1 text-center">
          <div className="mb-1 text-xs text-destructive">Error</div>
          <button
            onClick={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
            className="text-xs text-primary hover:underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!previewData) {
    return (
      <div
        ref={setElementRef}
        className="flex h-full w-full items-center justify-center rounded bg-muted"
      >
        <div className="flex flex-col items-center">
          <InlineSpinner size={24} color="#6352a3" />
          <div className="mt-1 px-1 text-center text-xs text-muted-foreground">
            Loading...
          </div>
        </div>
      </div>
    );
  }

  const currentImage = getCurrentImage();

  return (
    <div
      ref={setElementRef}
      className={`flex h-full w-full items-center justify-center ${compact ? '' : 'p-1'}`}
    >
      {currentImage ? (
        <div className="relative w-full h-full">
          <Image
            src={currentImage}
            alt={`${fileName} ${imageType}`}
            fill
            className="object-contain rounded"
            onError={(e) => {
              console.error('Image load error for:', fileName, imageType);
              e.currentTarget.style.display = 'none';
            }}
          />
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded bg-muted">
          {compact ? (
            <ImageIcon className="h-3 w-3 text-muted-foreground" />
          ) : (
            <div className="text-center">
              <ImageIcon className="mx-auto mb-1 h-6 w-6 text-muted-foreground" />
              <div className="text-xs text-muted-foreground">No {imageType}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ImagePreviewCell;

