"""Byte-bounded encoded tile cache. File I/O belongs to slide-open, never lookup."""
import hashlib
import json
import os
import threading
import time
from app.tile_resources import default_cache_bytes, total_memory_bytes
from collections import OrderedDict
from typing import Any, Dict

# A cache entry is a plain tuple (data: bytes, created: float, path: str).
# CPython stops tracking exact tuples of atomic values for garbage collection,
# so a full cache adds nothing to each full collection's scan; a dataclass or
# NamedTuple entry stays tracked and costs ~12 ms per collection at 130k tiles.
_DATA, _CREATED, _PATH = 0, 1, 2


class TileCacheService:
    def __init__(self, max_size=1000, max_age_seconds=3600, max_bytes=128 * 1024 * 1024):
        self.max_size = max(1, int(max_size))
        self.max_age_seconds = max_age_seconds
        self.max_bytes = max(1, int(max_bytes))
        self._lock = threading.RLock()
        self._cache = OrderedDict()
        self._keys_by_path = {}   # path -> keys of its cached tiles, for O(own tiles) clears
        self._file_hash_cache = {}
        self._bytes = 0
        self._revision = 0

    @property
    def revision(self):
        """Cheap scheduling hint; misses can be reused until cache mutation.

        Writers increment under the cache lock. Readers still validate file
        identity and use locked cache lookups whenever this hint changes.
        """
        return self._revision

    @staticmethod
    def _path(path):
        return os.path.normcase(os.path.abspath(path))

    def register_file(self, file_path):
        """Refresh identity on open/reopen; invalidate changed files outside tile traffic.

        No global cache lock is held while stat-ing a potentially slow network path.
        On-disk mutation of an open slide requires reopening it (the reader itself
        also retains pixels). Missing files raise here instead of caching an alias.
        """
        path = self._path(file_path)
        stat = os.stat(path)
        token = hashlib.sha1(f'{path}:{stat.st_size}:{stat.st_mtime_ns}:{stat.st_ctime_ns}'.encode()).hexdigest()
        with self._lock:
            previous = self._file_hash_cache.get(path)
            if previous != token:
                self._revision += 1
                self._clear_file_unlocked(path)
                for alias in tuple(self._file_hash_cache):
                    if alias.startswith(path + '_z') and alias[len(path)+2:].isdigit():
                        self._clear_file_unlocked(alias)
                        self._file_hash_cache[alias] = token
            self._file_hash_cache[path] = token
        return token

    def identity(self, file_path):
        path = self._path(file_path)
        with self._lock:
            # Compatibility for non-WSI callers: deterministic identity with no I/O.
            return self._file_hash_cache.setdefault(path, hashlib.sha1(path.encode()).hexdigest())

    def register_alias(self, alias, source):
        path = self._path(alias)
        with self._lock:
            # Keep source identity and alias assignment atomic with file reopen.
            token = self.identity(source)
            previous = self._file_hash_cache.get(path)
            if previous != token:
                self._revision += 1
                self._clear_file_unlocked(path)
            self._file_hash_cache[path] = token

    def _generate_cache_key(self, file_path, level, col, row, scale_factor=1.0,
                            color_mode=None, channels=None, colors=None, *, identity=None):
        data = [self._path(file_path), self.identity(file_path) if identity is None else identity, level, col, row,
                float(scale_factor), color_mode, channels or [], colors or []]
        return hashlib.sha1(json.dumps(data, sort_keys=True).encode()).hexdigest()

    def _remove(self, key):
        tile = self._cache.pop(key, None)
        if tile is not None:
            self._revision += 1
            self._bytes -= len(tile[_DATA])
            keys = self._keys_by_path.get(tile[_PATH])
            if keys is not None:
                keys.discard(key)
                if not keys:
                    del self._keys_by_path[tile[_PATH]]

    def _get_cached_key(self, key):
        # Caller owns _lock; reuse a prepared key during scheduler scans.
        tile = self._cache.get(key)
        if tile is None:
            return None
        if time.monotonic() - tile[_CREATED] > self.max_age_seconds:
            self._remove(key)
            return None
        self._cache.move_to_end(key)
        return tile[_DATA]

    def bind_tile_lookup(self, file_path, level, col, row, scale_factor=1.0,
                         color_mode=None, channels=None, colors=None, *, expected_identity):
        """Bind one request's identity/key without repeated path/hash work.

        Neither closure does filesystem I/O. Registration/clear invalidates
        both closures; a cache write becomes visible on the next lookup.
        """
        path = self._path(file_path)
        key = self._generate_cache_key(path, level, col, row, scale_factor,
                                       color_mode, channels, colors, identity=expected_identity)
        def current():
            with self._lock:
                return self._file_hash_cache.get(path) == expected_identity
        def lookup():
            with self._lock:
                if self._file_hash_cache.get(path) != expected_identity:
                    return None
                return self._get_cached_key(key)
        # The key covers file identity and every display parameter, so it also
        # serves as the tile's HTTP validator.
        return current, lookup, key

    def get_cached_tile(self, file_path, level, col, row, scale_factor=1.0,
                        color_mode=None, channels=None, colors=None):
        with self._lock:
            key = self._generate_cache_key(file_path, level, col, row, scale_factor,
                                           color_mode, channels, colors)
            return self._get_cached_key(key)

    def cache_tile(self, file_path, level, col, row, scale_factor, color_mode,
                   channels, colors, tile_bytes, *, expected_identity=None):
        data = bytes(tile_bytes)
        if len(data) > self.max_bytes:
            return False
        with self._lock:
            if expected_identity is not None and self.identity(file_path) != expected_identity:
                return False
            key = self._generate_cache_key(file_path, level, col, row, scale_factor,
                                           color_mode, channels, colors)
            self._remove(key)
            while self._cache and (len(self._cache) >= self.max_size or self._bytes + len(data) > self.max_bytes):
                self._remove(next(iter(self._cache)))
            path = self._path(file_path)
            self._cache[key] = (data, time.monotonic(), path)
            self._keys_by_path.setdefault(path, set()).add(key)
            self._bytes += len(data)
            self._revision += 1
        return True

    def _clear_file_unlocked(self, path):
        # Only this file's entries: a scan of a full cache held the lock ~40 ms.
        for key in tuple(self._keys_by_path.get(path, ())):
            self._remove(key)

    def clear_cache(self, file_path=None):
        with self._lock:
            self._revision += 1
            if file_path is not None:
                path = self._path(file_path)
                # Z-layer aliases belong to the source file as well.
                for candidate in tuple(self._file_hash_cache):
                    if candidate == path or (candidate.startswith(path + '_z') and candidate[len(path)+2:].isdigit()):
                        self._clear_file_unlocked(candidate)
                        self._file_hash_cache.pop(candidate, None)
            else:
                self._cache.clear()
                self._keys_by_path.clear()
                self._file_hash_cache.clear()
                self._bytes = 0

    def get_cache_stats(self) -> Dict[str, Any]:
        with self._lock:
            return dict(total_entries=len(self._cache), total_size_bytes=self._bytes,
                        total_size_mb=self._bytes / (1024 * 1024), max_entries=self.max_size,
                        max_size_bytes=self.max_bytes, max_age_seconds=self.max_age_seconds,
                        file_hash_entries=len(self._file_hash_cache),
                        cache_type='in_memory_lru_with_registered_file_identity')


def _default_cache_bytes():
    # 1/128 of RAM between 128 MB and 4 GB: unchanged on an 8 GB laptop, 4 GB
    # on a 755 GB server, where 500 tiles were evicted by a few viewers.
    try:
        megabytes = int(os.environ['TL_TILE_CACHE_MB'])
    except (KeyError, ValueError):
        return default_cache_bytes(total_memory_bytes())
    return max(16, megabytes) << 20


_cache_bytes = _default_cache_bytes()
# A 512 px JPEG tile is ~20-60 KB; the byte bound normally binds first.
# Keys carry the file identity, so an old entry is never wrong, only cold: a
# day lets viewers returning after a break hit; the byte bound limits memory.
_tile_cache = TileCacheService(max_size=max(500, _cache_bytes // (32 << 10)), max_bytes=_cache_bytes,
                               max_age_seconds=24 * 3600)


def get_tile_cache():
    return _tile_cache
