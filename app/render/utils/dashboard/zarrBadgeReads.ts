/**
 * Coordinates the `.zarr` structure reads behind the analysis badges.
 *
 * Deliberately NOT a cache. Badges must stay honest: an analysis that finishes
 * in the Image Viewer notifies nothing, so anything remembered here would keep
 * showing "no results" after the user just produced some. Re-reading on every
 * remount is the price of that, and it is the right price.
 *
 * What this does solve is the burst. Every visible row used to open its own
 * request the moment it scrolled into view, so a page flip fired one per row at
 * once — competing with each other and with the listing request itself. Reads
 * are capped, and two rows asking for the same store at the same time share one.
 */

export interface ZarrBadgeReaderOptions<T> {
  /** Performs the actual read. */
  read: (path: string) => Promise<T>;
  /** Value to return when `read` throws. */
  onError: (path: string, error: unknown) => T;
  maxConcurrent?: number;
}

export interface ZarrBadgeReader<T> {
  get: (path: string) => Promise<T>;
}

export const createZarrBadgeReader = <T,>(options: ZarrBadgeReaderOptions<T>): ZarrBadgeReader<T> => {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
  const inFlight = new Map<string, Promise<T>>();
  const queue: Array<() => void> = [];
  let active = 0;

  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < maxConcurrent) {
        active += 1;
        resolve();
        return;
      }
      queue.push(() => {
        active += 1;
        resolve();
      });
    });

  const release = () => {
    active -= 1;
    queue.shift()?.();
  };

  const get = (path: string): Promise<T> => {
    // Only for reads that overlap in time — once one settles the next caller
    // starts a fresh one, which is what keeps the badges current.
    const existing = inFlight.get(path);
    if (existing) return existing;

    const request = (async () => {
      await acquire();
      try {
        return await options.read(path);
      } catch (error) {
        return options.onError(path, error);
      } finally {
        release();
        inFlight.delete(path);
      }
    })();

    inFlight.set(path, request);
    return request;
  };

  return { get };
};
