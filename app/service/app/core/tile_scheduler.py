"""Bounded tile admission with per-waiter demand and file-wide singleflight.

Waiting tasks own no threads/readers. Fair user queues share independent jobs;
only native capacity is admitted, and each client validates its own delivery.
"""
from __future__ import annotations
import asyncio
import time
import weakref
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable
from app.tile_resources import (
    available_cpu_count, default_native_concurrency, default_pending,
    default_reader_budget_mb, default_tile_workers, total_memory_bytes,
    integer_setting as _integer,
)


_CPUS = available_cpu_count()
NATIVE_TILE_CONCURRENCY = _integer('TL_TILE_VIPS_CONCURRENCY', default_native_concurrency(_CPUS))
_READER_BUDGET_MB = _integer(
    'TL_TILE_MEMORY_BUDGET_MB', default_reader_budget_mb(total_memory_bytes()), high=65536,
)
# Each admitted decode uses a reader with NATIVE_TILE_CONCURRENCY threads.
# CPU capacity sets the default, bounded by the reader memory allowance.
TILE_WORKERS = _integer(
    'TL_TILE_WORKERS', default_tile_workers(_CPUS, NATIVE_TILE_CONCURRENCY, _READER_BUDGET_MB),
)
# Up to 4 decodes per viewer where cores allow (a 96-tile burst finishes ~2x
# sooner than with 2); small machines keep 2. TILE_WORKERS still caps the total,
# and TileScheduler drops back toward 2 per viewer when many viewers decode.
TILE_PER_SESSION = _integer('TL_TILE_PER_SESSION', min(4, max(2, TILE_WORKERS // 8), TILE_WORKERS), high=TILE_WORKERS)
# Absorb a 64-viewer burst (6 requests each) without a one-second retry wave.
# Waiting jobs hold no readers or executor threads. Keep the smaller budget
# on 1-3-worker hosts and the existing scaling above 16 workers; admission,
# per-session bounds and obsolete-demand checks still limit actual work.
TILE_MAX_PENDING = _integer(
    'TL_TILE_MAX_PENDING', default_pending(TILE_WORKERS),
    high=65536,
)


class TileQueueFull(Exception):
    pass


class StaleTile(Exception):
    pass


@dataclass(eq=False)
class _Waiter:
    owner: str
    work: Callable
    valid: Callable
    future: asyncio.Future
    priority: tuple = (1, 0)
    cached: Callable | None = None
    prepare: Callable | None = None
    disconnected: Callable | None = None


@dataclass(eq=False)
class _Job:
    key: tuple
    created: float
    resource: object = None
    resource_limit: int = 1
    waiters: set = field(default_factory=set)
    started: bool = False


class TileScheduler:
    def __init__(self, executor, max_running=TILE_WORKERS, per_session=TILE_PER_SESSION,
                 max_pending=TILE_MAX_PENDING, max_pending_per_session=32, max_queue_age=10.0):
        self.executor = executor
        self.max_running = max_running
        self.per_session = per_session
        self.max_pending = max_pending
        self.max_pending_per_session = max_pending_per_session
        self.max_queue_age = max_queue_age
        self._jobs = {}
        # Ordered owners provide round-robin; each queue indexes shared jobs.
        self._pending = OrderedDict()
        self._running = {}
        self._waiters_per_owner = {}
        self._resources = {}
        self._active = 0
        self._started = 0   # started jobs still in _jobs; queued = len(_jobs) - _started
        self._tasks = set()
        self._pump_handle = None
        self.counts = dict(submitted=0, shared=0, stale=0, rejected=0, cache_hits=0)

    def _valid(self, waiter):
        return waiter.valid() and not waiter.future.done()

    def _session_limit(self):
        # Full per-viewer parallelism while few viewers decode; once their
        # demand would exceed the workers, share them (never below 2) so a
        # busy viewer cannot push other viewers' tiles back.
        busy = len(self._running.keys() | self._pending.keys())
        return max(min(2, self.per_session), min(self.per_session, self.max_running // max(1, busy)))

    def _unlink(self, job, owner=None):
        users = {w.owner for w in job.waiters} if owner is None else (owner,)
        for user in users:
            queue = self._pending.get(user)
            if queue is None:
                continue
            if queue.get(job.key) is job:
                queue.pop(job.key)
            if not queue:
                self._pending.pop(user, None)

    def _reap(self, job):
        expired = not job.started and time.monotonic() - job.created > self.max_queue_age
        removed_owners = set()
        for waiter in tuple(job.waiters):
            valid = self._valid(waiter)
            if expired or not valid:
                if not waiter.future.done():
                    if not valid:
                        waiter.future.set_exception(StaleTile('Obsolete tile request'))
                        self.counts['stale'] += 1
                    else:
                        # Waiting too long does not invalidate the pixels. A
                        # stale response permanently blocks revival in OSD.
                        waiter.future.set_exception(TileQueueFull('Tile queue wait expired; retry shortly'))
                        self.counts['rejected'] += 1
                job.waiters.discard(waiter)
                removed_owners.add(waiter.owner)
        if not job.started:
            owners = {w.owner for w in job.waiters}
            for owner in removed_owners - owners:
                self._unlink(job, owner)
            if not job.waiters:
                self._drop(job)

    def _drop(self, job):
        if self._jobs.get(job.key) is job:
            self._jobs.pop(job.key)
            if job.started:
                self._started -= 1

    def _queued(self):
        return len(self._jobs) - self._started

    def _finish(self, job, result=None, error=None):
        for waiter in tuple(job.waiters):
            if waiter.future.done():
                continue
            if not self._valid(waiter):
                waiter.future.set_exception(StaleTile('Tile became obsolete before delivery'))
                self.counts['stale'] += 1
            elif error is not None:
                if isinstance(error, asyncio.CancelledError):
                    waiter.future.cancel()
                else:
                    waiter.future.set_exception(error)
            else:
                waiter.future.set_result(result)
        self._unlink(job)
        self._drop(job)

    async def request(self, key, owner, work, valid=lambda: True, *,
                      disconnected=None, priority=(1, 0),
                      resource=None, resource_limit=1, cached=None, prepare=None):
        if not valid() or (disconnected is not None and await disconnected()):
            raise StaleTile('Tile client changed or disconnected')
        # Singleflight bounds decode jobs, not HTTP waiters. Count duplicates
        # too, allowing the existing pending budget plus this session's decodes.
        if self._waiters_per_owner.get(owner, 0) >= self.max_pending_per_session + self.per_session:
            self.counts['rejected'] += 1
            raise TileQueueFull('Too many tile requests for session; retry shortly')
        queue = self._pending.get(owner, {})
        pending = self._queued()
        if pending >= self.max_pending or len(queue) >= self.max_pending_per_session:
            self._pump()
            for existing in tuple(self._jobs.values()):
                if not existing.started:
                    self._reap(existing)
            queue = self._pending.get(owner, {})
            pending = self._queued()
        job = self._jobs.get(key)
        can_start = (self._active < self.max_running and self._running.get(owner, 0) < self._session_limit()
                     and (resource is None or self._resources.get(resource, 0) < resource_limit))
        full_global = job is None and pending >= self.max_pending and not can_start
        full_owner = ((job is None or (not job.started and key not in queue))
                      and len(queue) >= self.max_pending_per_session)
        if full_global or full_owner:
            # Only overview demand may replace queued work. Ordinary detail
            # overload keeps the cheap rejection path and existing backpressure.
            # Every waiter must be lower priority; shared overviews stay protected.
            victims = [existing for existing in self._jobs.values()
                       if not existing.started and existing is not job
                       and existing.waiters
                       and min(w.priority[0] for w in existing.waiters) > priority[0]
                       and (not full_owner or any(w.owner == owner for w in existing.waiters))] if priority[0] == 0 else []
            if not victims:
                self.counts['rejected'] += 1
                raise TileQueueFull('Tile queue is full; retry shortly')
            victim = max(victims, key=lambda existing: (
                min(w.priority for w in existing.waiters), -existing.created))
            self.counts['rejected'] += sum(not w.future.done() for w in victim.waiters)
            self._finish(victim, error=TileQueueFull('Tile replaced by higher priority demand'))
            pending = self._queued()
        must_start = job is None and pending >= self.max_pending and can_start
        if job is None:
            job = self._jobs[key] = _Job(key, time.monotonic(), resource, max(1, resource_limit))
            self.counts['submitted'] += 1
        else:
            self.counts['shared'] += 1
        future = asyncio.get_running_loop().create_future()
        future.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
        waiter = _Waiter(owner, work, valid, future, priority, cached, prepare, disconnected)
        job.waiters.add(waiter)
        if not job.started:
            self._pending.setdefault(owner, {})[key] = job
        if must_start:
            self._pump()
        else:
            self._wake()
        self._waiters_per_owner[owner] = self._waiters_per_owner.get(owner, 0) + 1
        try:
            while True:
                if not valid():
                    raise StaleTile('Obsolete tile waiter')
                if not job.started:
                    if time.monotonic() - job.created > self.max_queue_age:
                        self.counts['rejected'] += 1
                        raise TileQueueFull('Tile request waited too long; retry shortly')
                    # Late cache hits resolve without consuming native capacity,
                    # even while every decode slot is busy. O(1) per waiter.
                    self._resolve_cached(job, waiter)
                if disconnected is not None and await disconnected():
                    raise StaleTile('Tile client disconnected')
                # A reader's TimeoutError is a task failure, not our polling timeout.
                # wait() reports readiness without intercepting the result exception.
                done, _ = await asyncio.wait({future}, timeout=0.05)
                if not done:
                    continue
                result = future.result()
                if not valid():
                    raise StaleTile('Session changed before delivery')
                if disconnected is not None and await disconnected():
                    raise StaleTile('Tile client disconnected before delivery')
                return result
        finally:
            self._waiters_per_owner[owner] -= 1
            if not self._waiters_per_owner[owner]:
                self._waiters_per_owner.pop(owner)
            if not future.done():
                future.cancel()
            self._reap(job)
            self._wake()

    def _resolve_cached(self, job, waiter):
        if waiter.cached is None:
            return False
        try:
            result = waiter.cached()
        except Exception as error:
            self._finish(job, error=error)
            return True
        if result is None:
            return False
        self.counts['cache_hits'] += 1
        self._finish(job, result)
        return True

    def _wake(self):
        # OSD submits bursts and several reads may finish together. Replenish
        # once per loop turn instead of repeatedly scanning the same demand.
        if self._pump_handle is None:
            self._pump_handle = asyncio.get_running_loop().call_soon(self._pump)

    def _pump(self):
        if self._pump_handle is not None:
            self._pump_handle.cancel()
            self._pump_handle = None
        while self._active < self.max_running and self._pending:
            selected = None
            limit = self._session_limit()
            for _ in range(len(self._pending)):
                if not self._pending:
                    break
                owner = next(iter(self._pending))
                queue = self._pending[owner]
                self._pending.move_to_end(owner)
                if self._running.get(owner, 0) >= limit:
                    continue
                now = time.monotonic()
                def rank(job):
                    priority = min((w.priority for w in job.waiters if w.owner == owner), default=(9, 0))
                    # Aging avoids starvation within a class, never ahead of
                    # a newer overview or foreground request.
                    return ((priority[0], -1) if now - job.created >= 1 else priority, job.created)
                # Saturated files cannot run this turn; do not rank/sort their backlog.
                eligible = (job for job in queue.values() if job.resource is None
                            or self._resources.get(job.resource, 0) < job.resource_limit)
                for job in sorted(eligible, key=rank):
                    # Validate only the job about to start: drops its stale or
                    # expired waiters, and skips it if none of this owner's remain.
                    self._reap(job)
                    mine = [w for w in job.waiters if w.owner == owner]
                    if not mine or queue.get(job.key) is not job:
                        continue
                    waiter = min(mine, key=lambda w: w.priority)
                    if self._resolve_cached(job, waiter):
                        continue
                    try:
                        work, cleanup = waiter.prepare() if waiter.prepare is not None else (waiter.work, None)
                    except StaleTile as error:
                        waiter.future.set_exception(error)
                        self._reap(job)
                        continue
                    except Exception as error:
                        self._finish(job, error=error)
                        continue
                    selected = job
                    break
                if selected is not None:
                    break
            if selected is None:
                return
            self._unlink(selected)
            selected.started = True
            self._started += 1
            self._active += 1
            self._running[owner] = self._running.get(owner, 0) + 1
            if selected.resource is not None:
                self._resources[selected.resource] = self._resources.get(selected.resource, 0) + 1
            task = asyncio.create_task(self._run(selected, owner, work, cleanup))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _run(self, job, owner, work, cleanup):
        cleanup_owned_by_worker = False
        try:
            # ASGI disconnect checks are async; recheck immediately before
            # executor submission, after the job has been waiting in the queue.
            for waiter in tuple(job.waiters):
                if (not self._valid(waiter) or
                        (waiter.disconnected is not None and await waiter.disconnected())):
                    if not waiter.future.done():
                        waiter.future.set_exception(StaleTile('Tile client disconnected before decoding'))
                        self.counts['stale'] += 1
                    job.waiters.discard(waiter)
            if not job.waiters:
                self._finish(job, error=StaleTile('Tile has no remaining demand'))
                return
            def execute():
                try:
                    return work()
                finally:
                    if cleanup is not None:
                        cleanup()
            future = asyncio.get_running_loop().run_in_executor(self.executor, execute)
            cleanup_owned_by_worker = True
            result = await future
            self._finish(job, result)
        except BaseException as error:
            self._finish(job, error=error)
        finally:
            try:
                # Also release a retained handle if submission was abandoned or
                # the executor was shut down before the worker took ownership.
                if cleanup is not None and not cleanup_owned_by_worker:
                    cleanup()
            finally:
                self._active -= 1
                self._running[owner] -= 1
                if not self._running[owner]:
                    self._running.pop(owner)
                if job.resource is not None:
                    self._resources[job.resource] -= 1
                    if not self._resources[job.resource]:
                        self._resources.pop(job.resource)
                self._wake()

    def stats(self):
        return dict(self.counts, running=self._active,
                    waiters=sum(self._waiters_per_owner.values()),
                    pending=self._queued(),
                    owners=len(self._pending), in_flight=len(self._jobs),
                    active_files=len(self._resources))


_schedulers = weakref.WeakKeyDictionary()


def get_tile_scheduler():
    loop = asyncio.get_running_loop()
    scheduler = _schedulers.get(loop)
    if scheduler is None:
        from app.core.executors import tile_executor
        scheduler = TileScheduler(tile_executor)
        _schedulers[loop] = scheduler
    return scheduler
