"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';

import { getZarrStructure } from '@/services/data.service';
import { createZarrBadgeReader } from '@/utils/dashboard/zarrBadgeReads';

/**
 * Lazy analysis badges for a WSI that has a companion .zarr.
 *
 * Group presence alone is not enough (`write_node_userdata` creates empty
 * groups with only userData). Also require the child named in
 * ZARR_GROUP_REQUIRED.
 *
 * Nothing is drawn until a read comes back, so a list of slides without
 * analyses stays still.
 *
 * Reads are viewport-gated, deduplicated and capped — but never cached, so a
 * remount or a list refresh always re-reads. An analysis finishing in the Image
 * Viewer notifies nothing, so a remembered result would keep showing "no
 * results" for work the user just did.
 */

type ZarrChild = {
  name?: string;
  type?: string;
  children?: ZarrChild[];
};

const ZARR_GROUP_TO_BADGE: Record<string, string> = {
  'Cell-Segmentation': 'Cell Segmentation',
  'Cell-Classification': 'Cell Classification',
  'Patch-Segmentation': 'Patch Segmentation',
  'Patch-Classification': 'Patch Classification',
  'Tissue-Segmentation': 'Tissue Segmentation',
};

/** Child that must exist under the group (not just userData). */
const ZARR_GROUP_REQUIRED: Record<string, string> = {
  'Cell-Segmentation': 'centroids',
  'Cell-Classification': 'class_indices',
  'Patch-Segmentation': 'embeddings',
  'Patch-Classification': 'class_indices',
  'Tissue-Segmentation': 'masks',
};

const BADGE_ORDER = [
  'Cell Segmentation',
  'Cell Classification',
  'Patch Segmentation',
  'Patch Classification',
  'Tissue Segmentation',
];

const deriveBadges = (groups: ZarrChild[]): string[] => {
  const set = new Set<string>();
  for (const group of groups) {
    if (group?.type !== 'group' || typeof group?.name !== 'string') continue;
    const label = ZARR_GROUP_TO_BADGE[group.name];
    const required = ZARR_GROUP_REQUIRED[group.name];
    if (!label || !required) continue;
    if ((group.children ?? []).some((c) => c?.name === required)) {
      set.add(label);
    }
  }
  return BADGE_ORDER.filter((b) => set.has(b));
};

/** Zarr reads are server-side I/O; a screenful of slides must not open a screenful of them. */
const MAX_CONCURRENT_BADGE_READS = 3;

const badgeReader = createZarrBadgeReader<string[]>({
  // depth 2: top-level groups + their immediate children (embeddings, etc.)
  read: async (path) => deriveBadges((await getZarrStructure(path, '/', false, 2))?.root?.children ?? []),
  onError: (path, error) => {
    // Non-critical: hide badges on failure; a remount or list refresh retries.
    console.warn('ZarrBadgesCell: failed to read', path, error);
    return [];
  },
  maxConcurrent: MAX_CONCURRENT_BADGE_READS,
});

interface ZarrBadgesCellProps {
  zarrPath: string;
}

const ZarrBadgesCell: React.FC<ZarrBadgesCellProps> = ({ zarrPath }) => {
  const [badges, setBadges] = useState<string[] | null>(null);
  const loadingRef = useRef(false);
  const pathRef = useRef(zarrPath);
  const [elementRef, setElementRef] = useState<HTMLSpanElement | null>(null);

  pathRef.current = zarrPath;

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    const path = zarrPath;
    loadingRef.current = true;
    try {
      const result = await badgeReader.get(path);
      if (pathRef.current !== path) return;
      setBadges(result);
    } finally {
      // Unconditional: the row may have been handed a different slide while
      // this read was in flight, and leaving the flag set would stop that one
      // from ever reading.
      loadingRef.current = false;
    }
  }, [zarrPath]);

  useEffect(() => {
    if (!elementRef || badges !== null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !loadingRef.current) {
            void load();
          }
        });
      },
      { threshold: 0.1, rootMargin: '50px' }
    );
    observer.observe(elementRef);
    return () => observer.disconnect();
  }, [elementRef, badges, load]);

  // A different slide — nothing read so far applies.
  useEffect(() => {
    loadingRef.current = false;
    setBadges(null);
  }, [zarrPath]);

  // Something just wrote into a store. The listing refreshes on these too, but
  // that alone does not reach us: the row keeps its React key, so this instance
  // is reused and would go on showing the groups it read before the run. Drop
  // what we know and let the observer read again.
  useEffect(() => {
    const forget = () => {
      loadingRef.current = false;
      setBadges(null);
    };
    window.addEventListener('tissuelab:preRunCompleted', forget);
    window.addEventListener('tissuelab:cloudUploadCompleted', forget);
    return () => {
      window.removeEventListener('tissuelab:preRunCompleted', forget);
      window.removeEventListener('tissuelab:cloudUploadCompleted', forget);
    };
  }, []);

  if (badges === null) {
    // Nothing known yet. This used to be a pulsing placeholder pill, which put
    // a shimmer on every slide in view and then removed most of them again —
    // few slides have analyses. A screenful of that reads as "still loading"
    // long after the rows themselves have arrived. Anchor the observer on
    // something the eye cannot find instead, and let real badges be the only
    // thing that ever appears.
    return <span ref={setElementRef} className="inline-block h-px w-px" aria-hidden />;
  }

  if (badges.length === 0) return null;

  return (
    <>
      {badges.map((label) => (
        <span
          key={label}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
          title={`This slide has ${label} results stored in its companion .zarr`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70" />
          {label}
        </span>
      ))}
    </>
  );
};

export default ZarrBadgesCell;
