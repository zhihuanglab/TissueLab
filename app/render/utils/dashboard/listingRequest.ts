/**
 * Rules governing one file-listing request's lifecycle.
 *
 * A listing is a server round trip per page, so several can be in flight or
 * superseded while the user keeps clicking. Deciding whether a response is
 * still wanted, and what the next fetch should target, is the part that goes
 * wrong; it lives here rather than inline in the component.
 */

/** Everything the server needs to build a page. */
export interface ListingQuery {
  offset: number;
  limit: number | null;
  sortKey: string;
  sortDir: string;
  showNonImage: boolean;
}

/** Trailing slashes and Windows separators must not read as a different folder. */
export const normalizeNavigationPath = (path: string): string =>
  (path || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');

/** Identity of a listing request. Two requests with the same key are the same page. */
export const listingQueryKeyOf = (query: ListingQuery): string =>
  `${query.offset}|${query.limit}|${query.sortKey}|${query.sortDir}|${query.showNonImage}`;

/**
 * True when a navigation to a DIFFERENT folder was queued while this one ran.
 *
 * Deliberately blind to same-folder requeues: those are page clicks, and the
 * response still describes the right folder — whether it describes the right
 * PAGE is `shouldApplyListingResponse`'s business.
 */
export const isNavigationSuperseded = (
  pendingPath: string | null,
  completedPath: string,
): boolean => {
  if (pendingPath == null || pendingPath === '') return false;
  return normalizeNavigationPath(pendingPath) !== normalizeNavigationPath(completedPath);
};

/**
 * Folder a query-driven refetch should target.
 *
 * While a navigation is in flight `currentDirectory` still names the folder
 * being left, so targeting it would queue a refetch of the OLD folder and make
 * the in-flight response look superseded by a different path — throwing away
 * the navigation the user asked for.
 */
export const listingRefetchTarget = (
  isFetching: boolean,
  inFlightPath: string,
  currentDirectory: string,
): string => (isFetching ? inFlightPath || currentDirectory : currentDirectory);

/**
 * Whether a completed response may be written to the UI.
 *
 * The page / sort / filter check is the one the path check cannot make: a stale
 * response for the same folder would otherwise write its rows AND its
 * pagination block, snapping the user back to the page they just left and
 * sending the queued refetch after that same old page.
 */
export const shouldApplyListingResponse = (params: {
  pendingPath: string | null;
  completedPath: string;
  requestedKey: string;
  currentKey: string;
}): boolean =>
  !isNavigationSuperseded(params.pendingPath, params.completedPath) &&
  params.requestedKey === params.currentKey;
