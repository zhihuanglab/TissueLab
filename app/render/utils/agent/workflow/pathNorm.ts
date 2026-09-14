import { formatPath } from "@/utils/common/path.utils";

/**
 * Normalize slide / zarr paths for equality checks across Windows/Unix,
 * absolute vs relative, and optional `.zarr` suffix.
 */
export function normalizeWorkflowZarrPath(path: string): string {
  // Strip trailing slashes before `.zarr` so `slide.svs.zarr/` still normalizes.
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.zarr$/i, "")
    .toLowerCase();
}

/** Strip a trailing `.zarr` (any case) without changing the rest of the path. */
export function stripZarrSuffix(path: string): string {
  return path.replace(/\.zarr$/i, "");
}

/**
 * Companion `.zarr` path for a slide. Appends `.zarr` unless the path already
 * has that suffix (any case). Does not rewrite separators — web storage paths
 * must stay `/`. Viewer/local-disk callers should use `toLocalWorkflowZarrPath`.
 */
export function toWorkflowZarrPath(path: string | null | undefined): string {
  if (!path) return "";
  const trimmed = path.trim();
  if (!trimmed) return "";
  return /\.zarr$/i.test(trimmed) ? trimmed : `${trimmed}.zarr`;
}

/**
 * Viewer / local-disk slide → companion `.zarr` with OS-native separators.
 * Do not use for web-storage paths (those must keep `/`); use `toWorkflowZarrPath`.
 */
export function toLocalWorkflowZarrPath(path: string | null | undefined): string {
  if (!path) return "";
  return toWorkflowZarrPath(formatPath(path) || path);
}

/**
 * True when two paths refer to the same slide/zarr for viewer reload purposes.
 * Accepts absolute vs storage-relative forms when one path's segments are a
 * trailing segment-suffix of the other (not a raw string suffix — avoids
 * matching `prefix_a/slide` with `a/slide`).
 * Basename-only comparisons (single segment) only match via exact equality above,
 * so bare `slide` does not match `.../other/slide`.
 */
export function workflowZarrPathsMatch(a: string, b: string): boolean {
  const na = normalizeWorkflowZarrPath(a);
  const nb = normalizeWorkflowZarrPath(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const sa = na.split("/").filter(Boolean);
  const sb = nb.split("/").filter(Boolean);
  if (sa.length === 0 || sb.length === 0) return false;

  const [shorter, longer] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  // Require at least two path segments for suffix matching.
  if (shorter.length < 2) return false;

  const offset = longer.length - shorter.length;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[offset + i]) return false;
  }
  return true;
}
