/**
 * What the viewer does with a `/seg/v1/classifications` response.
 *
 * Split out of OpenSeadragonContainer so the per-cell-override rule below is
 * reachable from a test — it is the difference between the overlay showing a
 * fresh classification and showing the colours from before the run.
 */
import { annotationTypeStore } from '@/store/zustand/slice/annotationTypesStore';
import { applyIncomingNucleiClasses } from '@/utils/annotations/nucleiClassList';
import type { AnnotationClass } from '@/store/slices/viewer/annotationSlice';
import { isSegmentationHandlerNotReadyError } from '@/utils/common/segFetch';

export type ClassificationLoadOutcome =
  /** Backend not ready / transient failure — keep whatever the overlay has. */
  | { kind: 'keep' }
  /** Zarr has classification data: adopt these classes. */
  | { kind: 'loaded'; classes: AnnotationClass[] }
  /** Definitively no classification data. */
  | { kind: 'empty' };

/** Messages that mean "handler not bound yet", not "no data". */
export function isNonFatalHandlerNotReadyMessage(value: unknown): boolean {
  return isSegmentationHandlerNotReadyError(value);
}

/**
 * Decide the outcome and, when data was loaded, drop stale per-cell overrides.
 *
 * The overrides have to go. DrawingOverlay resolves a cell's colour as
 * `annotationTypes.get(id) ?? nucleiClasses[class_id]`, so an override WINS over
 * the class the backend just computed. Reaching the `loaded` branch means the
 * handler has (re)loaded the zarr, and its load path writes user annotations
 * straight into `class_id`, so every frame from here already carries both the
 * manual labels and the new model result. Keeping the old entries would repaint
 * exactly the cells the user marked with their pre-run colour — which reads as
 * "the overlay did not refresh after classification".
 *
 * Before #969 this was implicit: the response carried `class_indices` and the
 * viewer overwrote the whole store with it on every load.
 */
export function applyLoadedClassification(
  responseData: any,
  currentClasses: AnnotationClass[],
  options: {
    /**
     * Ids of the per-cell overrides that existed when the run finished, or null
     * to keep every override.
     *
     * Deliberately a snapshot rather than "clear everything": a mark the user
     * makes between the run finishing and its reload landing has never been in
     * any frame, so wiping it would lose it outright. Only marks that predate
     * the run are superseded by the result.
     */
    staleOverrideIds?: readonly string[] | null;
  } = {},
): ClassificationLoadOutcome {
  const wrappedErrorCode =
    typeof responseData?.code === 'number' ? responseData.code : undefined;
  if (wrappedErrorCode !== undefined && wrappedErrorCode !== 0) {
    return { kind: 'keep' };
  }

  // An empty class list is not a successful load — treating it as one would
  // adopt zero classes and, worse, drop the user's marks for a result that
  // classified nothing.
  if (
    !responseData ||
    !Array.isArray(responseData.class_names) ||
    responseData.class_names.length === 0 ||
    !Array.isArray(responseData.class_colors)
  ) {
    return { kind: 'empty' };
  }

  const incomingNames = (responseData.class_names as unknown[]).map((rawName) =>
    typeof rawName === 'string' ? rawName : String(rawName ?? ''),
  );
  const classes = applyIncomingNucleiClasses({
    incomingNames,
    incomingColors: responseData.class_colors,
    current: currentClasses,
    mergeMode: 'load',
  });

  const stale = options.staleOverrideIds;
  if (stale && stale.length > 0) {
    annotationTypeStore.getState().removeMany([...stale]);
  }

  return { kind: 'loaded', classes };
}

/**
 * When may a classification load drop the per-cell overrides?
 *
 * Only in the window between a workflow run finishing and the next load that
 * lands on a rebuilt handler. The overrides are the user's manual marks;
 * useFileChangeHandler deliberately keeps them across everything except a real
 * slide switch, so any broader rule ("every set_path ack") silently loses marks
 * on a reconnect, a first bind, or simply leaving the page and coming back.
 */
export function shouldDropStaleOverrides(opts: {
  /** Caller forcing the answer (the explicit "request classification" flow). */
  explicit?: boolean;
  /** A workflow run has completed and its drop has not been consumed yet. */
  runJustFinished: boolean;
  /** A handler rebuild has landed, so the frames on screen are post-reload. */
  handlerRebuilt: boolean;
}): boolean {
  if (opts.explicit !== undefined) return opts.explicit;
  return opts.runJustFinished && opts.handlerRebuilt;
}

/**
 * Drop exactly these per-cell overrides.
 *
 * Split from {@link applyLoadedClassification} so the removal can be timed
 * independently of the classifications fetch: the fetch answers in ~100ms and the
 * frame carrying the new result lands a few hundred later, so removing the marks
 * when the fetch returns shows the user their work being undone first and the new
 * result second. Callers hand this to the frame instead.
 */
export function dropCellOverrides(ids: readonly string[]): void {
  if (ids.length === 0) return;
  annotationTypeStore.getState().removeMany([...ids]);
}

/**
 * Ids of the per-cell overrides on screen right now.
 *
 * Captured when a run finishes so the load that follows drops exactly those and
 * nothing the user has marked since.
 */
export function snapshotCellOverrideIds(): string[] {
  return [...annotationTypeStore.getState().annotationTypes.keys()];
}
