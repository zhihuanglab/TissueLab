/**
 * The page most recently rendered for a folder, so a return trip can show it
 * at once instead of waiting on the network.
 *
 * Producing a page costs the server the whole folder - one readdir, one
 * subcollection stream, one sort - even though ten rows come back, so it grows
 * with the library rather than with the page. Bouncing Personal -> Shared ->
 * Personal paid that each way and stared at a blank list while it ran.
 *
 * Lives at MODULE scope, not in a ref, because switching folders remounts the
 * file manager (StorageFolderCards keys it on the nav request). A ref would be
 * destroyed by exactly the switch this is meant to make fast.
 *
 * Surviving the component means it also outlives a sign-out, so every entry is
 * scoped to the signed-in user and `syncAuthScope` drops them when that
 * changes. Deliberately small and short-lived besides: this makes a return trip
 * feel instant, it is not a way to avoid fetching. Every recall is still
 * followed by the real request, which replaces what was painted.
 */

import { normalizeNavigationPath } from '@/utils/dashboard/listingRequest';

export interface RecentListing<Row, Pagination> {
  rows: Row[];
  /** null for listings the client pages itself - it recomputes the block from the rows. */
  pagination: Pagination | null;
  at: number;
}

/** Identifies one page: whose it is, which folder, and which query built it. */
export interface ListingIdentity {
  /** Signed-in uid, or 'guest'. Keeps one user's rows out of another's list. */
  scope: string;
  path: string;
  queryKey: string;
}

export interface RecallRequest extends ListingIdentity {
  /** Folder currently displayed. */
  currentPath: string;
  /**
   * Whether rows for `currentPath` are actually on screen.
   *
   * Arriving where we already are is normally a same-folder refetch - a page
   * click, a sort, the refresh after a delete - and the live rows are the right
   * ones, so painting a remembered copy over them could flash a row that was
   * just removed. After a remount there are no live rows to protect, and
   * comparing paths alone would leave the list blank for the whole request.
   */
  hasRowsOnScreen: boolean;
}

export interface RecentListingsOptions {
  /** Beyond this age a remembered page is more likely to mislead than to help. */
  ttlMs?: number;
  /** Bounded to the handful of folders a user actually bounces between. */
  maxEntries?: number;
  now?: () => number;
}

export interface RecentListings<Row, Pagination> {
  remember(id: ListingIdentity, rows: Row[], pagination: Pagination | null): void;
  /** The page to paint on arriving at `path`, or null. */
  recall(request: RecallRequest): RecentListing<Row, Pagination> | null;
  /** Forget everything. Used on sign-out and when a write makes every page suspect. */
  clear(): void;
  readonly size: number;
}

export const DEFAULT_RECENT_LISTING_TTL_MS = 30_000;
export const DEFAULT_RECENT_LISTING_ENTRIES = 24;

const cacheKey = ({ scope, path, queryKey }: ListingIdentity) =>
  `${scope} ${normalizeNavigationPath(path)} ${queryKey}`;

export function createRecentListings<Row, Pagination>(
  options: RecentListingsOptions = {},
): RecentListings<Row, Pagination> {
  const ttlMs = options.ttlMs ?? DEFAULT_RECENT_LISTING_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_RECENT_LISTING_ENTRIES;
  // Called through rather than captured, so a caller can substitute the clock.
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, RecentListing<Row, Pagination>>();

  return {
    remember(id, rows, pagination) {
      const key = cacheKey(id);
      const at = now();
      // Expiry otherwise only happens on recall, so a folder visited once and
      // never returned to would hold its rows for the life of the session. A
      // page of a large folder is megabytes, and this store outlives the
      // component, so sweep on the way in. At `maxEntries` this is trivial.
      for (const [k, entry] of entries) {
        if (at - entry.at > ttlMs) entries.delete(k);
      }
      // Re-insert so a refreshed page counts as the newest for eviction.
      entries.delete(key);
      entries.set(key, { rows, pagination, at });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },

    recall(request) {
      const { currentPath, hasRowsOnScreen, ...id } = request;
      if (
        hasRowsOnScreen &&
        normalizeNavigationPath(id.path) === normalizeNavigationPath(currentPath)
      ) {
        return null;
      }
      const key = cacheKey(id);
      const hit = entries.get(key);
      if (!hit) return null;
      if (now() - hit.at > ttlMs) {
        entries.delete(key);
        return null;
      }
      return hit;
    },

    clear() {
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}

/**
 * The shared instance. Module scope is the point - see the note above.
 * Rows stay untyped here so the store does not drag component types across
 * modules; the file manager narrows it at the call site.
 */
export const recentListings = createRecentListings<any, any>();

/**
 * Who the remembered pages belong to. Module scope for the same reason the
 * store is: a component ref restarts at its initial value on every remount, and
 * `onAuthStateChanged` fires immediately on subscribe, so comparing against one
 * would read every remount as a user change and clear the store each time -
 * silently undoing the whole point of keeping it out of the component.
 */
let lastKnownScope: string | null = null;

/**
 * Tell the store who is signed in. Drops every remembered page when the user
 * actually changes, because the rows are someone's file names. The first call
 * of a session establishes the scope without clearing (nothing is remembered
 * yet), so a reload does not throw away a cache it never had.
 */
export const syncAuthScope = (scope: string): void => {
  if (lastKnownScope !== null && lastKnownScope !== scope) recentListings.clear();
  lastKnownScope = scope;
};
