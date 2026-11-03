"""File-shared native readers with leases and a global resident process budget.

Sessions retain metadata/handles, not a promise of permanently resident children.
Idle readers may be evicted even while their slide is open; the next read reopens
them. Active reads and preparation pin a resident entry until they finish.
"""
from __future__ import annotations
import atexit
import os
import threading
import time
import psutil
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from .isolated_slide_wrapper import IsolatedSlideWrapper
from app.tile_resources import (
    available_cpu_count, available_memory_bytes, default_native_concurrency,
    default_reader_budget_mb, default_readers_per_slide, default_tile_workers,
    total_memory_bytes, integer_setting as _integer,
)


@dataclass(eq=False)
class _Entry:
    path: str
    key: tuple
    metadata: dict = field(default_factory=dict)
    reader: object = None
    refs: int = 0
    pins: int = 0
    opening: bool = False
    reserved: bool = False
    rss_bytes: int = 0
    touched: float = field(default_factory=time.monotonic)


_METADATA = ('dimensions', 'level_dimensions', 'level_downsamples', 'properties', 'associated_names')


# Free-memory hysteresis: start reclaiming below LOW, keep going until HIGH.
_FREE_LOW = 512 * 2**20
_FREE_HIGH = 768 * 2**20


class SharedReaderPool:
    """Reader residency follows browser tab discarding.

    The most recently used slide is the foreground tab: never discarded. Other
    slides idle for ``trim_timeout`` keep one reader (frozen); idle for
    ``idle_timeout`` they keep none (discarded; metadata stays and the next
    read restarts a reader). Memory pressure works through the same ladder in
    least-recently-used order: spare readers of background slides, then whole
    background slides, then the foreground slide's spare reader.
    """
    def __init__(self, max_processes=8, readers_per_file=2, factory=IsolatedSlideWrapper,
                 *, memory_budget_bytes=None, idle_timeout=0, trim_timeout=0):
        self.readers_per_file = max(1, min(readers_per_file, max_processes))
        self.max_resident = max(1, max_processes // self.readers_per_file)
        self.factory = factory
        self.entries = {}
        self.condition = threading.Condition()
        self.preparing = ThreadPoolExecutor(1, thread_name_prefix='tile-reader-prepare')
        self.closed = False
        self.memory_budget_bytes = memory_budget_bytes
        self.idle_timeout = max(0, idle_timeout)
        self.trim_timeout = max(0, trim_timeout)
        self._pressured = False
        self._reserve_bytes = 64 * 2**20 * self.readers_per_file
        if memory_budget_bytes is not None and memory_budget_bytes < self._reserve_bytes:
            raise ValueError('Reader memory budget must allow at least one file reservation')
        self._free_bytes = 0
        self._stop = threading.Event()
        self._maintenance_thread = None

    def acquire(self, path):
        stat = os.stat(path)
        key = (os.path.normcase(os.path.realpath(path)), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        self._start_maintenance()
        with self.condition:
            if self.closed:
                raise RuntimeError('Reader pool is closed')
            entry = self.entries.get(key)
            if entry is None:
                entry = self.entries[key] = _Entry(path, key)
            entry.refs += 1
        try:
            with self.pin(entry):
                pass
        except BaseException:
            self.release(entry)
            raise
        return entry

    @contextmanager
    def pin(self, entry):
        with self.condition:
            while entry.opening and not self.closed:
                self.condition.wait()
            if self.closed:
                raise RuntimeError('Reader pool is closed')
            entry.pins += 1
            opening = entry.reader is None
            if opening:
                entry.opening = True
        try:
            yield self._open(entry) if opening else entry.reader
        finally:
            with self.condition:
                entry.pins -= 1
                entry.touched = time.monotonic()
                self.condition.notify_all()
            self._retire_unused(entry)

    def _open(self, entry):
        reader = None
        deadline = time.monotonic() + 10
        try:
            while True:
                with self.condition:
                    if self.closed:
                        raise RuntimeError('Reader pool is closed')
                    if self._can_grow():
                        entry.reserved = True
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError('Timed out waiting for reader capacity')
                    idle = [e for e in self.entries.values() if e is not entry
                            and e.reader is not None and not e.pins and not e.opening]
                    if not idle:
                        self.condition.wait(min(.1, remaining))
                        continue
                    old = min(idle, key=lambda e: e.touched)
                    victim, old.reader = old.reader, None
                    old.opening = True
                # Closing still counts against the budget; opening and closing
                # never hold the shared lock or block reads of other files.
                self._close_entry(old, victim)
                if self.memory_budget_bytes is not None:
                    self._sample_memory()
            if entry.metadata:
                # Reopen after eviction: sessions still hold the old metadata
                # and cache identity, so a rewritten file must not be served.
                # Content only: ctime also moves on xattr/chmod (Finder tags).
                stat = os.stat(entry.path)
                if (stat.st_size, stat.st_mtime_ns) != entry.key[1:3]:
                    raise RuntimeError('Slide file changed on disk; reopen the slide')
            reader = self.factory(entry.path, workers=self.readers_per_file)
            metadata = {name: getattr(reader, name, ()) for name in _METADATA}
            if entry.metadata and metadata['level_dimensions'] != entry.metadata['level_dimensions']:
                raise RuntimeError('Slide file changed on disk; reopen the slide')
            with self.condition:
                if self.closed:
                    raise RuntimeError('Reader pool is closed')
                entry.reader, entry.metadata = reader, metadata
                if self.readers_per_file > 1 and hasattr(reader, 'prepare'):
                    self.preparing.submit(self._prepare, entry, reader)
            return reader
        finally:
            try:
                if reader is not None and entry.reader is None:
                    reader.close()
            finally:
                with self.condition:
                    if entry.reader is None:
                        entry.reserved = False
                    entry.opening = False
                    self.condition.notify_all()

    def _prepare(self, entry, reader):
        with self.condition:
            if self.closed or entry.reader is not reader:
                return
            entry.pins += 1
        try:
            reader.prepare()
        except Exception:
            # Failed preparation leaves lazy recovery/reader deadlines intact.
            pass
        finally:
            with self.condition:
                entry.pins -= 1
                entry.touched = time.monotonic()
                self.condition.notify_all()
            self._retire_unused(entry)

    def release(self, entry):
        with self.condition:
            entry.refs -= 1
            if entry.refs < 0:
                raise RuntimeError('Reader handle released twice')
            self.condition.notify_all()
        self._retire_unused(entry)

    def _retire_unused(self, entry):
        with self.condition:
            if entry.refs or entry.pins or entry.opening:
                return
            reader, entry.reader = entry.reader, None
            entry.opening = True
        self._close_entry(entry, reader)

    def _close_entry(self, entry, reader):
        try:
            if reader is not None:
                reader.close()
        finally:
            with self.condition:
                entry.opening = False
                entry.reserved = False
                entry.rss_bytes = 0
                if not entry.refs and self.entries.get(entry.key) is entry:
                    self.entries.pop(entry.key, None)
                self.condition.notify_all()

    def _start_maintenance(self):
        if self.memory_budget_bytes is None and not self.idle_timeout and not self.trim_timeout:
            return
        with self.condition:
            if self.closed or self._maintenance_thread is not None:
                return
            self._maintenance_thread = threading.Thread(
                target=self._maintain, name='tile-reader-residency', daemon=True)
            self._maintenance_thread.start()

    def _can_grow(self):
        # Called under condition: reservations include opening and closing readers.
        resident = [entry for entry in self.entries.values() if entry.reserved]
        if len(resident) >= self.max_resident:
            return False
        # Memory is a soft limit: low system memory must never make the only
        # requested slide unreadable.
        if self.memory_budget_bytes is None or not resident:
            return True
        estimate = max(self._reserve_bytes,
                       int(max((entry.rss_bytes for entry in resident), default=0) * 1.25))
        committed = sum(max(self._reserve_bytes, entry.rss_bytes) for entry in resident)
        unmeasured = sum(max(0, self._reserve_bytes - entry.rss_bytes) for entry in resident)
        return (committed + estimate <= self.memory_budget_bytes
                and self._free_bytes >= _FREE_LOW + estimate + unmeasured)

    def _sample_memory(self):
        # OS sampling never holds the shared lock or runs on the service loop.
        with self.condition:
            snapshot = [(entry, entry.reader) for entry in self.entries.values()
                        if entry.reader is not None]
        samples = []
        for entry, reader in snapshot:
            try:
                slots = tuple(reader._slots)
                rss = sum(psutil.Process(slot[0].pid).memory_info().rss for slot in slots if slot)
                samples.append((entry, reader, rss))
            except (psutil.Error, OSError, AttributeError, ValueError):
                pass  # Preserve the previous estimate if a child is retiring.
        try:
            available = available_memory_bytes()
        except (psutil.Error, OSError):
            available = 0  # Defer growth until memory sampling recovers.
        with self.condition:
            for entry, reader, rss in samples:
                if entry.reader is reader:
                    entry.rss_bytes = rss
            self._free_bytes = available
            self.condition.notify_all()

    def _next_reclaim(self):
        """Pick one (action, entry) under the lock, or None. See the class docstring."""
        budgeted = self.memory_budget_bytes is not None
        loaded = [entry for entry in self.entries.values() if entry.reader is not None]
        if budgeted:
            if self._free_bytes < _FREE_LOW:
                self._pressured = True
            elif self._free_bytes >= _FREE_HIGH or not loaded:
                self._pressured = False
        over_budget = budgeted and sum(max(self._reserve_bytes, entry.rss_bytes)
                                       for entry in loaded if entry.reserved) > self.memory_budget_bytes
        pressure = over_budget or self._pressured
        latest = max(loaded, key=lambda item: item.touched, default=None)
        now = time.monotonic()
        candidates = []
        for entry in loaded:
            if entry.pins or entry.opening:
                continue
            idle_for = now - entry.touched
            spare = entry.reader.resident_readers() > 1 if hasattr(entry.reader, 'resident_readers') else False
            background = entry is not latest
            if pressure:
                if background and spare:
                    candidates.append((0, entry.touched, 'trim', entry))
                elif background:
                    candidates.append((1, entry.touched, 'discard', entry))
                elif spare:
                    candidates.append((2, entry.touched, 'trim', entry))
            elif background and self.idle_timeout and idle_for >= self.idle_timeout:
                candidates.append((0, entry.touched, 'discard', entry))
            elif spare and self.trim_timeout and idle_for >= self.trim_timeout:
                candidates.append((0, entry.touched, 'trim', entry))
        if not candidates:
            return None
        _, _, action, entry = min(candidates, key=lambda item: item[:2])
        return action, entry

    def _reclaim_idle(self):
        if self.memory_budget_bytes is not None:
            self._sample_memory()
        while True:
            with self.condition:
                if self.closed:
                    return
                picked = self._next_reclaim()
                if picked is None:
                    return
                action, entry = picked
                reader = entry.reader
                if action == 'discard':
                    entry.reader = None
                    entry.opening = True
                else:
                    entry.pins += 1   # keep the reader alive while trimming outside the lock
            if action == 'discard':
                self._close_entry(entry, reader)
            else:
                try:
                    stopped = reader.trim(1)
                finally:
                    with self.condition:
                        entry.pins -= 1
                        self.condition.notify_all()
                    self._retire_unused(entry)
                if not stopped:
                    return   # its spare became busy; try again on the next tick
            if self.memory_budget_bytes is not None:
                self._sample_memory()

    def _maintain(self):
        while not self._stop.is_set():
            self._reclaim_idle()
            self._stop.wait(.25)

    def close(self):
        with self.condition:
            self.closed = True
            self._stop.set()
            self.condition.notify_all()
        if self._maintenance_thread is not None:
            self._maintenance_thread.join()
        self.preparing.shutdown(wait=True)
        with self.condition:
            while any(entry.pins for entry in self.entries.values()):
                self.condition.wait(.1)
            readers = [(entry, entry.reader) for entry in self.entries.values()
                       if entry.reader is not None]
            for entry, reader in readers:
                entry.reader = None
                entry.opening = True
        for entry, reader in readers:
            self._close_entry(entry, reader)
        with self.condition:
            self.entries.clear()


class _AssociatedImages(Mapping):
    """Read-on-access label/macro images, like openslide's mapping."""
    def __init__(self, slide):
        self._slide = slide

    def __getitem__(self, name):
        if name not in self._slide.associated_names:
            raise KeyError(name)
        return self._slide._read('read_associated', name)

    def __contains__(self, name):
        # Mapping's default would read the image over the pipe just to test it.
        return name in self._slide.associated_names

    def __iter__(self):
        return iter(self._slide.associated_names)

    def __len__(self):
        return len(self._slide.associated_names)


# Defaults scale with the machine, so one build fits a laptop and a server;
# environment variables still override each value.
# A quarter of effective RAM for readers (128 MB minimum, 64 GB maximum).
# Live host/container free memory still brakes actual growth.
_BUDGET_MB = _integer('TL_TILE_MEMORY_BUDGET_MB', default_reader_budget_mb(total_memory_bytes()), high=65536)
# As many readers as decodes one viewer may run (app.core.tile_scheduler's
# TILE_PER_SESSION), capped by useful decode capacity on small machines.
# Reader children must not import app.core, so use its same lightweight defaults.
_CPUS = available_cpu_count()
_NATIVE_CONCURRENCY = _integer('TL_TILE_VIPS_CONCURRENCY', default_native_concurrency(_CPUS))
_TILE_WORKERS = _integer('TL_TILE_WORKERS', default_tile_workers(_CPUS, _NATIVE_CONCURRENCY, _BUDGET_MB))
# Extra readers only where memory still keeps 64 slides open (budget 128 MB each).
_READERS_PER_SLIDE = _integer(
    'TL_TILE_READERS_PER_SLIDE', default_readers_per_slide(_TILE_WORKERS, _BUDGET_MB), high=4,
)
# One reader process measures 65-120 MB resident; budget 128 MB each. The cap
# grows with readers per slide so up to 64 slides stay open either way.
_pool = SharedReaderPool(max_processes=_integer('TL_TILE_PROCESS_BUDGET', max(4, min(64 * _READERS_PER_SLIDE, _BUDGET_MB // 128)), high=256),
                         readers_per_file=_READERS_PER_SLIDE,
                         memory_budget_bytes=_BUDGET_MB * 2**20,
                         idle_timeout=_integer('TL_TILE_READER_IDLE_SECONDS', 300, high=3600),
                         trim_timeout=_integer('TL_TILE_READER_TRIM_SECONDS', 60, high=3600))
atexit.register(_pool.close)


class SharedSlideWrapper:
    """Session handle composing a file-shared pool of isolated native readers."""
    def __init__(self, path, *, pool=None):
        self.path = path
        self._pool = pool or _pool
        self._entry = self._pool.acquire(path)
        self._handle_lock = threading.Lock()
        self._closed = False
        for name, value in self._entry.metadata.items():
            setattr(self, name, value.copy() if isinstance(value, dict) else value)

    @property
    def tile_resource(self):
        """All display variants of this file consume the same native capacity."""
        return (id(self._pool), self._entry.key)

    @property
    def tile_capacity(self):
        return self._pool.readers_per_file

    def retain(self):
        """Retain a job-owned handle without opening a reader or touching disk.

        Called only at admission. Closing the originating session cannot close
        the handle retained for an already admitted shared decode.
        """
        with self._handle_lock:
            if self._closed:
                raise RuntimeError('Slide handle is closed')
            with self._pool.condition:
                if self._pool.closed:
                    raise RuntimeError('Reader pool is closed')
                self._entry.refs += 1
            handle = object.__new__(type(self))
            handle.path = self.path
            handle._pool = self._pool
            handle._entry = self._entry
            handle._handle_lock = threading.Lock()
            handle._closed = False
            for name in _METADATA:
                value = getattr(self, name)
                setattr(handle, name, value.copy() if isinstance(value, dict) else value)
            return handle

    def _read(self, name, *args, **kwargs):
        # A session close cannot invalidate a read that already owns this handle.
        with self._handle_lock:
            if self._closed:
                raise RuntimeError('Slide handle is closed')
            with self._pool.condition:
                self._entry.refs += 1
        try:
            with self._pool.pin(self._entry) as reader:
                return getattr(reader, name)(*args, **kwargs)
        finally:
            self._pool.release(self._entry)

    def render_tile(self, *args):
        return self._read('render_tile', *args)

    def read_region_vips(self, *args):
        return self._read('read_region_vips', *args)

    def render_overview(self, *args):
        return self._read('render_overview', *args)

    def read_region(self, location, level, size, as_array=False, **kwargs):
        return self._read('read_region', location, level, size, as_array=as_array, **kwargs)

    def get_thumbnail(self, size):
        return self._read('get_thumbnail', size)

    @property
    def associated_images(self):
        return _AssociatedImages(self)

    def get_best_level_for_downsample(self, downsample):
        limit = max(1.0, float(downsample)) * 1.01
        return max((i for i, scale in enumerate(self.level_downsamples) if scale <= limit), default=0)

    def close(self):
        with self._handle_lock:
            if self._closed:
                return
            self._closed = True
        self._pool.release(self._entry)

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass


def read_whole_level(slide, level, max_side=2048):
    """A whole pyramid level as PIL, for previews that resize it afterwards.

    Isolated readers bound region reads, and a coarse level can still exceed
    that bound; they downscale inside the reader instead.
    """
    if isinstance(slide, SharedSlideWrapper):
        return slide.get_thumbnail((max_side, max_side))
    width, height = slide.level_dimensions[level]
    return slide.read_region((0, 0), level, (width, height))
