/**
 * Path access helpers: public read-only roots (Samples) write guards.
 */

import { PUBLIC_READ_ONLY_PATHS } from '@/constants/fm.constants';

/** Compare paths with POSIX separators so Windows ``\\`` matches ``/``. */
const toPosixPath = (path: string): string => path.trim().replace(/\\/g, '/');

const sameOrUnder = (path: string, root: string): boolean => {
  let p = toPosixPath(path).replace(/\/+$/, '');
  let r = toPosixPath(root).replace(/\/+$/, '');
  if (!p || !r) return false;
  // Windows drive / UNC paths are case-insensitive (matches Python ``normcase``).
  if (/^[a-zA-Z]:\//.test(p) || /^[a-zA-Z]:\//.test(r) || p.startsWith('//') || r.startsWith('//')) {
    p = p.toLowerCase();
    r = r.toLowerCase();
  }
  return p === r || p.startsWith(`${r}/`);
};

/**
 * True when *path* is under a public read-only root (`samples`, PUBLIC_DATA_PATH).
 * Aliases like `samples/Data` match because they sit under `samples/`.
 */
export const isPublicReadOnlyPath = (path: string | null | undefined): boolean => {
  if (!path) return false;

  const posix = toPosixPath(path);
  const normalized = posix.replace(/^\/+|\/+$/g, '');

  for (const publicPath of PUBLIC_READ_ONLY_PATHS) {
    if (sameOrUnder(posix, publicPath) || sameOrUnder(normalized, publicPath.replace(/^\/+|\/+$/g, ''))) {
      return true;
    }
  }
  return false;
};

/**
 * Write/extract block. Matches AI ``get_restricted_access_mode``. Only
 * ``samples`` is produced client-side now; ``viewer`` is kept so backend
 * denials that still carry it map to a sensible notice.
 */
export type RestrictedAccessMode = 'viewer' | 'samples';

/** Single client-side write gate: public Samples (path prefix). */
export function getRestrictedAccessMode(
  path?: string | null,
): RestrictedAccessMode | null {
  if (!path) return null;
  if (isPublicReadOnlyPath(path)) return 'samples';
  return null;
}

/** Public samples — cannot annotate / run workflows / mutate. */
export const isWriteBlockedPath = (path: string | null | undefined): boolean =>
  getRestrictedAccessMode(path) !== null;

type PathAccessNotice = {
  title: string;
  description: string;
};

const VIEWER_NOTICE: PathAccessNotice = {
  title: 'Viewer only',
  description: 'Copy this to your Personal workspace to edit it.',
};

const SAMPLES_NOTICE: PathAccessNotice = {
  title: 'Read-only samples',
  description: 'Copy this file to your Personal workspace to download, export, or edit.',
};

const GENERIC_NOTICE: PathAccessNotice = {
  title: 'Not allowed',
  description: 'Use your Personal workspace instead.',
};

export type WriteDenial = PathAccessNotice & {
  operation: string;
  accessMode: RestrictedAccessMode;
};

function noticeForMode(mode?: string | null): PathAccessNotice {
  if (mode === 'viewer') return VIEWER_NOTICE;
  if (mode === 'samples' || mode === 'public_samples') return SAMPLES_NOTICE;
  return GENERIC_NOTICE;
}

export function getWriteDenial(
  operation: string,
  path?: string | null,
): WriteDenial | null {
  const accessMode = getRestrictedAccessMode(path);
  if (!accessMode) return null;
  return { ...noticeForMode(accessMode), operation, accessMode };
}

/**
 * Client-side path ACL denial. Carries the same fields as backend denials so
 * ``isPathAccessDenied`` / ``toastIfDenied`` work for pre-checks too.
 */
export class PathAccessError extends Error {
  readonly errorCode: string;
  readonly accessMode: string;
  readonly operation: string;

  constructor(denial: WriteDenial) {
    const action = (denial.operation ?? '').trim();
    super(
      action && action !== 'access'
        ? `${denial.title} — can't ${action}. ${denial.description}`
        : `${denial.title}. ${denial.description}`,
    );
    this.name = 'PathAccessError';
    this.operation = denial.operation;
    this.accessMode = denial.accessMode;
    this.errorCode =
      denial.accessMode === 'viewer'
        ? 'VIEW_ONLY_FORBIDDEN'
        : 'PUBLIC_READ_ONLY_FORBIDDEN';
  }
}

export function assertCanWrite(path: string | null | undefined, operation: string): void {
  const denial = getWriteDenial(operation, path);
  if (denial) throw new PathAccessError(denial);
}

/** Runtime error_code values that mean a path ACL denial (not every 403). */
const PATH_ACCESS_ERROR_CODES = new Set([
  'VIEW_ONLY_FORBIDDEN',
  'VIEW_ONLY_EXTRACT_FORBIDDEN',
  'PUBLIC_SAMPLES_EXTRACT_FORBIDDEN',
  'PUBLIC_READ_ONLY_FORBIDDEN',
  'VIEW_ACL_UNAVAILABLE',
]);

const PATH_ACCESS_MODES = new Set(['viewer', 'samples', 'public_samples']);

function readErrorField(error: unknown, camel: 'errorCode' | 'accessMode'): string {
  if (!error || typeof error !== 'object') return '';
  const obj = error as Record<string, unknown>;
  const snake = camel === 'errorCode' ? 'error_code' : 'access_mode';
  for (const key of [camel, snake]) {
    const value = obj[key];
    if (typeof value === 'string' && value) return value;
  }
  const data = obj.data;
  if (data && typeof data === 'object') {
    const nested = data as Record<string, unknown>;
    for (const key of [camel, snake]) {
      const value = nested[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  return '';
}

/** True when an API/HTTP error is a path ACL denial (prefer this over message matching). */
export function isPathAccessDenied(error: unknown): boolean {
  if (error instanceof PathAccessError) return true;
  const code = readErrorField(error, 'errorCode');
  if (code && PATH_ACCESS_ERROR_CODES.has(code)) return true;
  const mode = readErrorField(error, 'accessMode');
  return Boolean(mode && PATH_ACCESS_MODES.has(mode));
}

/** Mode copy for a caught API/client path denial. */
export function noticeFromDeniedError(error: unknown): PathAccessNotice {
  const mode = readErrorField(error, 'accessMode');
  if (mode) return noticeForMode(mode);
  const code = readErrorField(error, 'errorCode');
  if (code === 'VIEW_ONLY_FORBIDDEN' || code === 'VIEW_ONLY_EXTRACT_FORBIDDEN') {
    return VIEWER_NOTICE;
  }
  if (code === 'PUBLIC_READ_ONLY_FORBIDDEN' || code === 'PUBLIC_SAMPLES_EXTRACT_FORBIDDEN') {
    return SAMPLES_NOTICE;
  }
  return GENERIC_NOTICE;
}
