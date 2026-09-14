import { useCallback } from 'react';
import { useDispatch } from 'react-redux';
import { store } from '@/store';
import { setGtHighlightIndices } from '@/store/slices/viewer/gtHighlightSlice';
import { AI_SERVICE_API_ENDPOINT } from '@/config/api.config';
import { apiFetch } from '@/utils/common/apiFetch';
import { selectActiveSlidePath } from '@/utils/viewer/slidePath';
import { annotationTypeStore } from '@/store/zustand/slice/annotationTypesStore';

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
function applyNegativeAnnotationLabels(data: any) {
  const neg = data?.negative_annotations;
  const ids: unknown[] = Array.isArray(neg?.cell_ids) ? neg.cell_ids : [];
  const classes: unknown[] = Array.isArray(neg?.excluded_classes) ? neg.excluded_classes : [];
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

    const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/user_annotation_indices?file_path=${encodeURIComponent(currentPath)}`;
    apiFetch(url, { method: 'GET', returnAxiosFormat: true })
      .then((resp: any) => {
        const data = resp?.data?.data ?? resp?.data ?? {};
        applyNegativeAnnotationLabels(data);
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
