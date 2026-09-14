/**
 * Canonical slide path helpers for viewer sessions.
 * Source of truth: ``wsi.instances[id].filePath``.
 */
import { useSelector } from 'react-redux';
import { RootState } from '@/store';
import {
  selectActiveInstanceFilePath,
  selectInstanceFilePath,
} from '@/store/slices/wsiSlice';

export { selectActiveInstanceFilePath, selectInstanceFilePath } from '@/store/slices/wsiSlice';

/** Active instance ``filePath`` (null when no active instance). */
export function selectActiveSlidePath(state: RootState): string | null {
  return selectActiveInstanceFilePath(state);
}

export function useActiveSlidePath(): string | null {
  return useSelector(selectActiveSlidePath);
}

/** Slide path for a specific viewer ``instanceId``. */
export function useInstanceSlidePath(instanceId: string | null | undefined): string | null {
  return useSelector((state: RootState) => selectInstanceFilePath(state, instanceId));
}
