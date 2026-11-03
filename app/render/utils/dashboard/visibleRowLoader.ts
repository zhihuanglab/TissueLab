/**
 * Loads the data of the rows a virtualized file list has in view — the
 * analysis badges and the slide previews.
 *
 * Deliberately NOT a cache. Not every write to a slide announces itself, so
 * anything remembered here could keep showing stale results. Writes that do
 * announce themselves call `invalidate`, so no read that predates them is
 * handed out.
 *
 * What this does solve is the burst. Every visible row used to open its own
 * request the moment it scrolled into view, so a page flip fired one per row at
 * once — competing with each other and with the listing request itself. Rows
 * that ask within the same frame now share one batched request, few requests
 * run at once, and two rows asking for the same path share one read.
 *
 * The list is virtualized, so rows come and go as fast as the user scrolls.
 * Waiting reads therefore follow the viewport, not arrival order: the newest
 * requests are sent first, and a read whose every caller has aborted (row
 * scrolled away) is dropped before it is sent. Otherwise a long drag leaves a
 * backlog of rows nobody can see, and the screenful the user stopped on waits
 * behind it. A read that takes long once sent (a preview generated on the
 * server) can ask `wanted` and give up on paths nobody waits for any more.
 */

export interface VisibleRowLoaderOptions<T> {
  /**
   * Reads several paths in one request, keyed by path. A missing key counts as
   * a failure. `wanted(path)` turns false once every caller of that path has
   * aborted — nobody will see its result, and the path is detached so later
   * asks start afresh; the read may stop waiting for it or cancel its work.
   */
  readBatch: (paths: string[], wanted: (path: string) => boolean) => Promise<Record<string, T | undefined>>;
  /** Value to return for a path whose read failed. */
  onError: (path: string, error: unknown) => T;
  /** Requests in flight at once. */
  maxConcurrent?: number;
  /** Paths per request. */
  maxBatch?: number;
  /** How long to gather asks before sending, so a screenful goes out as one request. */
  collectMs?: number;
}

export interface VisibleRowLoader<T> {
  /**
   * Rejects with an `AbortError` if `signal` aborts first. A read still
   * waiting is dropped once no caller wants it; one already sent runs on and
   * can be joined again, until it gives the path up (see `wanted`).
   */
  get: (path: string, signal?: AbortSignal) => Promise<T>;
  /**
   * The stores matching `matches` (all when omitted) were just written. Reads
   * already sent for them may predate the write: later asks no longer share
   * them and start their own. Reads not yet sent are left alone.
   */
  invalidate: (matches?: (path: string) => boolean) => void;
}

interface Job<T> {
  path: string;
  waiters: number;
  started: boolean;
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const abortError = () => new DOMException('Read no longer needed', 'AbortError');

export const createVisibleRowLoader = <T,>(options: VisibleRowLoaderOptions<T>): VisibleRowLoader<T> => {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
  const maxBatch = Math.max(1, options.maxBatch ?? 24);
  const collectMs = options.collectMs ?? 16;
  const jobs = new Map<string, Job<T>>();
  // The end is the most recently requested.
  const pending: Job<T>[] = [];
  let active = 0;
  let collectTimer: ReturnType<typeof setTimeout> | undefined;

  const unqueue = (job: Job<T>) => {
    const i = pending.indexOf(job);
    if (i !== -1) pending.splice(i, 1);
  };

  const finish = (job: Job<T>, value: T) => {
    // Only for reads that overlap in time — once one settles the next caller
    // starts a fresh one, which is what keeps the badges current.
    if (jobs.get(job.path) === job) jobs.delete(job.path);
    job.resolve(value);
  };

  const flush = () => {
    while (active < maxConcurrent && pending.length > 0) {
      // Newest asks first, kept in the order they came in (top of the screen first).
      const batch = pending.splice(Math.max(0, pending.length - maxBatch));
      batch.forEach((job) => { job.started = true; });
      active += 1;
      const byPath = new Map(batch.map((job) => [job.path, job]));
      // A row that comes back while its read runs joins it again. Once the
      // read is told nobody waits and gives the path up, it is detached, so a
      // later ask starts its own instead of joining one that was abandoned.
      const wanted = (path: string) => {
        const job = byPath.get(path);
        if (!job || job.waiters > 0) return !!job;
        if (jobs.get(path) === job) jobs.delete(path);
        return false;
      };
      options.readBatch(batch.map((job) => job.path), wanted).then(
        (results) => {
          for (const job of batch) {
            const value = results[job.path];
            finish(job, value !== undefined ? value : options.onError(job.path, new Error('No result returned')));
          }
        },
        (error) => {
          for (const job of batch) finish(job, options.onError(job.path, error));
        },
      ).finally(() => {
        active -= 1;
        flush();
      });
    }
  };

  const schedule = () => {
    if (collectTimer !== undefined) return;
    collectTimer = setTimeout(() => {
      collectTimer = undefined;
      flush();
    }, collectMs);
  };

  const get = (path: string, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) return Promise.reject(abortError());

    let job = jobs.get(path);
    if (!job) {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => { resolve = r; });
      job = { path, waiters: 0, started: false, promise, resolve };
      jobs.set(path, job);
      pending.push(job);
    } else if (!job.started) {
      // Asked for again — it is on screen now, so move it to the front.
      unqueue(job);
      pending.push(job);
    }
    job.waiters += 1;
    const current = job;
    schedule();

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        current.waiters -= 1;
        if (!current.started && current.waiters === 0) {
          unqueue(current);
          if (jobs.get(path) === current) jobs.delete(path);
        }
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      void current.promise.then((value) => {
        signal?.removeEventListener('abort', onAbort);
        if (!signal?.aborted) resolve(value);
      });
    });
  };

  const invalidate = (matches?: (path: string) => boolean) => {
    for (const [path, job] of jobs) {
      if (job.started && (!matches || matches(path))) jobs.delete(path);
    }
  };

  return { get, invalidate };
};
