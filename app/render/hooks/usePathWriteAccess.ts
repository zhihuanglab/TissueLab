import { useCallback, useRef } from 'react';
import { toast } from 'sonner';
import {
  getWriteDenial,
  isPathAccessDenied,
  type WriteDenial,
} from '@/utils/common/pathAccess.utils';

function showDenialToast(denial: WriteDenial) {
  const action = (denial.operation ?? '').trim();
  toast.error(denial.title, {
    id: 'path-access-denied',
    description:
      action && action !== 'access'
        ? `Can't ${action}. ${denial.description}`
        : denial.description,
  });
}

/**
 * Shared write/extract gate for UI: disable controls + toast on assert.
 * Pass the path being written (usually the open slide; folder only if none).
 */
export function usePathWriteAccess(path?: string | null) {
  const pathKey = path ?? '';
  const pathRef = useRef(path);
  pathRef.current = path;

  const denial = getWriteDenial('access', path);
  const allowed = denial === null;
  const tooltip = denial ? `${denial.title}. ${denial.description}` : undefined;

  const assertWritable = useCallback(
    (operation: string): boolean => {
      const next = getWriteDenial(operation, pathRef.current);
      if (!next) return true;
      showDenialToast(next);
      return false;
    },
    [pathKey],
  );

  const toastIfDenied = useCallback(
    (error: unknown, operation: string, fallback: string): boolean => {
      if (!isPathAccessDenied(error)) return false;
      const next = getWriteDenial(operation, pathRef.current);
      if (next) {
        showDenialToast(next);
        return true;
      }
      toast.error(fallback);
      return true;
    },
    [pathKey],
  );

  return {
    allowed,
    tooltip,
    assertWritable,
    toastIfDenied,
  };
}

/** Imperative toast gate for handlers that cannot use the hook. */
export function denyWriteToast(
  operation: string,
  path?: string | null,
): boolean {
  const denial = getWriteDenial(operation, path);
  if (!denial) return false;
  showDenialToast(denial);
  return true;
}
