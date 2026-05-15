import { useCallback } from 'react';
import { useDispatch } from 'react-redux';
import { store } from '@/store';
import { setGtHighlightIndices } from '@/store/slices/viewer/gtHighlightSlice';
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import { apiFetch } from '@/utils/common/apiFetch';

/**
 * Returns a function that refetches user-annotation (GT) indices and updates Redux.
 * No-op if "highlight GT" preference is off or no current path.
 * Call after save_annotation / save_tissue / mark as ground truth success.
 */
export function useRefreshGtHighlightIndices() {
  const dispatch = useDispatch();

  return useCallback(() => {
    const state = store.getState();
    const currentPath = state.svsPath?.currentPath ?? null;
    const highlightGtAnnotations = state.viewerSettings?.highlightGtAnnotations ?? false;
    if (!currentPath || !highlightGtAnnotations) return;

    const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/user_annotation_indices?file_path=${encodeURIComponent(currentPath)}`;
    apiFetch(url, { method: 'GET', returnAxiosFormat: true })
      .then((resp: any) => {
        const data = resp?.data?.data ?? resp?.data ?? {};
        const nucleiIndices = Array.isArray(data.nuclei_indices) ? data.nuclei_indices : [];
        const tissueIndices = Array.isArray(data.tissue_indices) ? data.tissue_indices : [];
        dispatch(setGtHighlightIndices({ nucleiIndices, tissueIndices }));
      })
      .catch(() => {
        dispatch(setGtHighlightIndices({ nucleiIndices: [], tissueIndices: [] }));
      });
  }, [dispatch]);
}
