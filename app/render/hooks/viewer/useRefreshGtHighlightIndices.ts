import { useCallback } from 'react';
import { useDispatch } from 'react-redux';
import { store } from '@/store';
import { setGtHighlightIndices } from '@/store/slices/viewer/gtHighlightSlice';
import { AI_SERVICE_API_ENDPOINT } from '@/config/api.config';
import { apiFetch } from '@/utils/common/apiFetch';
import { selectActiveSlidePath } from '@/utils/viewer/slidePath';
import { annotationTypeStore, type AnnotationTypeEntry } from '@/store/zustand/slice/annotationTypesStore';

/**
 * Apply the "Not <class>" labels the endpoint reports.
 *
 * A negative ("No") selection retracts the prediction it contradicts, leaving the
 * cell with no class. The overlay would render that as "Unclassified" — "nobody
 * has said anything about this cell" — which is the opposite of what just
 * happened. The backend hands back only the cells that actually ended up blank
 * (a cell marked "not QQQ" but predicted "Stroma" keeps Stroma and is absent),
 * so these overrides can be applied as-is. #808080 is the colour the overlay
 * already paints an unclassified cell, so only the label changes.
 */
const isNotLabel = (entry: AnnotationTypeEntry) =>
  entry.classIndex === -1 && entry.category.startsWith('Not ');

/** Cells showing a "Not <class>" label right now. */
function notLabelIds(): Set<string> {
  const ids = new Set<string>();
  annotationTypeStore.getState().annotationTypes.forEach((entry, id) => {
    if (isNotLabel(entry)) ids.add(id);
  });
  return ids;
}

function applyNegativeAnnotationLabels(data: any, labelledAtRequest: Set<string> | null) {
  const neg = data?.negative_annotations;
  const ids: unknown[] = Array.isArray(neg?.cell_ids) ? neg.cell_ids : [];
  const classes: unknown[] = Array.isArray(neg?.excluded_classes) ? neg.excluded_classes : [];
  // The response is the whole set. A "Not <class>" label on a cell it no longer
  // lists is stale — the mark was cleared, removed in review, or replaced — and
  // would otherwise stay until a reload. Only labels that were already there
  // when the request went out are dropped: one added since (a mark saved while
  // this was in flight) is newer than the answer. ``null`` (a slide other than
  // the one the viewer shows) drops none: the labels belong to the shown slide.
  if (labelledAtRequest?.size) {
    const reported = new Set(ids.slice(0, classes.length).map(String));
    const types = annotationTypeStore.getState().annotationTypes;
    const stale = [...labelledAtRequest].filter((id) => {
      const entry = types.get(id);
      return !reported.has(id) && !!entry && isNotLabel(entry);
    });
    if (stale.length) annotationTypeStore.getState().removeMany(stale);
  }
  if (!ids.length) return;
  annotationTypeStore.getState().setMany(
    ids.slice(0, classes.length).map((id, i) => ({
      id: String(id),
      classIndex: -1,
      color: '#808080',
      category: `Not ${String(classes[i])}`,
    })),
  );
}

/**
 * Returns a function that refetches user-annotation (GT) indices and updates Redux.
 * No-op if there is no current path.
 *
 * The fetch itself is NOT gated on the "highlight GT" preference: the same
 * response carries the "Not <class>" labels, which are not a highlighting
 * choice. Only the highlight dispatch is gated.
 *
 * Pass ``pathOverride`` when the caller is tied to a non-active viewer instance.
 */
export function useRefreshGtHighlightIndices() {
  const dispatch = useDispatch();

  return useCallback((pathOverride?: string | null) => {
    const state = store.getState();
    const currentPath =
      (typeof pathOverride === 'string' && pathOverride.length > 0
        ? pathOverride
        : null) ?? selectActiveSlidePath(state);
    if (!currentPath) return;
    const highlightGtAnnotations = state.viewerSettings?.highlightGtAnnotations ?? false;

    const labelledAtRequest = currentPath === selectActiveSlidePath(state) ? notLabelIds() : null;
    const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/user_annotation_indices?file_path=${encodeURIComponent(currentPath)}`;
    apiFetch(url, { method: 'GET', returnAxiosFormat: true })
      .then((resp: any) => {
        const data = resp?.data?.data ?? resp?.data ?? {};
        applyNegativeAnnotationLabels(data, labelledAtRequest);
        if (!highlightGtAnnotations) return;
        const nucleiIndices = Array.isArray(data.nuclei_indices) ? data.nuclei_indices : [];
        const tissueIndices = Array.isArray(data.tissue_indices) ? data.tissue_indices : [];
        dispatch(setGtHighlightIndices({ nucleiIndices, tissueIndices }));
      })
      .catch(() => {
        if (!highlightGtAnnotations) return;
        dispatch(setGtHighlightIndices({ nucleiIndices: [], tissueIndices: [] }));
      });
  }, [dispatch]);
}
