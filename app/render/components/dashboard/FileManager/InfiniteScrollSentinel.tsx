"use client";
import React, { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';

export interface InfiniteScrollSentinelProps {
  /** Scrolling element the list lives in; the viewport when omitted. */
  scrollRoot?: React.RefObject<HTMLElement | null>;
  hasMore: boolean;
  isLoading: boolean;
  /** Ask for more rows. Returns false when it declined, so the next check retries. */
  onLoadMore: () => boolean;
  /** Rows currently rendered — a change re-checks whether more are needed. */
  loadedCount: number;
}

/** How far below the visible area the sentinel already counts as reached. */
const PREFETCH_PX = 400;

/**
 * Sits under a file list and asks for more rows as it nears the viewport.
 *
 * An IntersectionObserver only reports changes, so a sentinel still on screen
 * after a load (the new rows did not fill the panel) would never fire again.
 * The effect below re-checks whenever a load finishes, which keeps pulling
 * until the panel is full or the list ends. It measures the sentinel then and
 * there: the observer's last report can be a frame old, from before the new
 * rows pushed the sentinel down.
 *
 * A virtualized list settles a frame or two after its rows change — estimated
 * heights give way to measured ones — and can bring the sentinel back within
 * reach without crossing the observer's threshold. So the check also runs once
 * the list has settled, and on every scroll of the root.
 *
 * One request per batch of rows: `isLoading` can clear a render before the rows
 * it loaded arrive, and the sentinel — still sitting under the old rows — would
 * ask again. Nothing more is requested until the row count has moved, or the
 * user scrolls the sentinel out of reach and back.
 */
export const InfiniteScrollSentinel: React.FC<InfiniteScrollSentinelProps> = ({
  scrollRoot,
  hasMore,
  isLoading,
  onLoadMore,
  loadedCount,
}) => {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const isVisibleRef = useRef(false);
  const requestedAtCountRef = useRef<number | null>(null);
  const latest = useRef({ hasMore, isLoading, onLoadMore, loadedCount });
  latest.current = { hasMore, isLoading, onLoadMore, loadedCount };

  const tryLoadMore = () => {
    const { hasMore: more, isLoading: loading, onLoadMore: load, loadedCount: count } = latest.current;
    if (!more || loading || requestedAtCountRef.current === count) return;
    if (load()) requestedAtCountRef.current = count;
  };

  const isWithinReach = (): boolean => {
    const el = sentinelRef.current;
    if (!el) return false;
    const bottom = scrollRoot?.current
      ? scrollRoot.current.getBoundingClientRect().bottom
      : window.innerHeight;
    return el.getBoundingClientRect().top <= bottom + PREFETCH_PX;
  };

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = !!entries[0]?.isIntersecting;
        // Scrolled away and back: the user is asking again.
        if (visible && !isVisibleRef.current) requestedAtCountRef.current = null;
        isVisibleRef.current = visible;
        if (visible) tryLoadMore();
      },
      { root: scrollRoot?.current ?? null, rootMargin: `0px 0px ${PREFETCH_PX}px 0px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRoot]);

  const checkReach = () => {
    if (isWithinReach()) tryLoadMore();
  };

  useEffect(() => {
    const root = scrollRoot?.current;
    if (!root) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        checkReach();
      });
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRoot]);

  useEffect(() => {
    checkReach();
    // Again once the list has laid out its new rows with measured heights.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(checkReach);
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, isLoading, loadedCount]);

  return (
    <div ref={sentinelRef} aria-hidden={!(hasMore && isLoading)}>
      {hasMore && isLoading && (
        <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Loading more…</span>
        </div>
      )}
    </div>
  );
};
