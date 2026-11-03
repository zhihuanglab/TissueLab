"""Resource detection and tile defaults, independent of app.core and libvips.

Reader children use these same defaults without initializing the service.
Linux cgroup v2 limits are read from the standard /sys/fs/cgroup mount.
"""
from functools import lru_cache
import os
from pathlib import Path, PurePosixPath
import sys

import psutil

MIB = 1 << 20


def integer_setting(name, default, low=1, high=128):
    try:
        return max(low, min(high, int(os.environ.get(name, default))))
    except (TypeError, ValueError):
        return default


def _text(path):
    try:
        return path.read_text().strip()
    except (OSError, UnicodeError):
        return ''


def _number(path):
    try:
        value = int(_text(path))
        return value if value >= 0 else None
    except ValueError:
        return None


def _v2_paths(root, membership):
    """Include ancestor constraints, including a container's mount root."""
    root = Path(root).resolve()
    relative = None
    for line in _text(Path(membership)).splitlines():
        fields = line.split(':', 2)
        if len(fields) == 3 and fields[:2] == ['0', '']:
            relative = PurePosixPath(fields[2])
            break
    if relative is None and not (root / 'cgroup.controllers').exists():
        return ()
    current = root
    if relative is not None and '..' not in relative.parts:
        candidate = root.joinpath(*(part for part in relative.parts if part != '/')).resolve()
        if candidate.is_relative_to(root) and candidate.is_dir():
            current = candidate
    paths = []
    while True:
        paths.append(current)
        if current == root:
            return tuple(paths)
        current = current.parent


@lru_cache(maxsize=1)
def _cgroup_paths():
    if not sys.platform.startswith('linux'):
        return ()
    try:
        return _v2_paths('/sys/fs/cgroup', '/proc/self/cgroup')
    except OSError:
        return ()


def _cpu_budget(host_count, affinity_count=None, paths=()):
    count = max(1, host_count or 1)
    if affinity_count:
        count = min(count, affinity_count)
    for path in paths:
        fields = _text(path / 'cpu.max').split()
        if len(fields) != 2 or fields[0] == 'max':
            continue
        try:
            quota, period = map(int, fields)
            if quota > 0 and period > 0:
                count = min(count, max(1, quota // period))
        except ValueError:
            continue
    return count


@lru_cache(maxsize=1)
def available_cpu_count():
    counter = getattr(os, 'process_cpu_count', os.cpu_count)
    affinity = None
    try:
        affinity = len(psutil.Process().cpu_affinity())
    except (AttributeError, NotImplementedError, OSError, psutil.Error):
        pass  # macOS and restricted process-query environments.
    return _cpu_budget(counter() or os.cpu_count(), affinity, _cgroup_paths())


def _memory_budget(host_total, host_available, paths=()):
    total, available = host_total, host_available
    for path in paths:
        limit = _number(path / 'memory.max')
        if limit is None:
            continue
        total = min(total, limit)
        used = _number(path / 'memory.current')
        available = min(available, max(0, limit - used) if used is not None else limit)
    return max(1, total), max(0, min(total, available))


@lru_cache(maxsize=1)
def total_memory_bytes():
    memory = psutil.virtual_memory()
    return _memory_budget(memory.total, memory.available, _cgroup_paths())[0]


def available_memory_bytes():
    # Called on the residency maintenance thread, never in the tile hot path.
    memory = psutil.virtual_memory()
    return _memory_budget(memory.total, memory.available, _cgroup_paths())[1]


def default_native_concurrency(cpus):
    return min(4, max(1, cpus))


def default_tile_workers(cpus, native_concurrency, reader_budget_mb=None):
    workers = min(32, max(1, cpus // native_concurrency))
    if reader_budget_mb is not None:
        workers = min(workers, max(1, reader_budget_mb // 128))
    return workers


def default_pending(workers):
    return max(128, min(512, 128 * workers), 32 * workers)


def default_reader_budget_mb(memory_bytes):
    # Quarter of effective RAM, without reserving a full GB on a small host.
    return max(128, min(65536, memory_bytes // MIB // 4))


def default_readers_per_slide(workers, budget_mb):
    # A single decode slot cannot use a second reader. Larger machines retain
    # the memory allowance for 64 files before adding per-file parallelism.
    return min(4, max(1, workers), max(2, workers // 8), max(2, budget_mb // 128 // 64))


def default_cache_bytes(memory_bytes):
    floor = min(128 * MIB, max(16 * MIB, memory_bytes // 16))
    return min(4 << 30, max(floor, memory_bytes // 128))
