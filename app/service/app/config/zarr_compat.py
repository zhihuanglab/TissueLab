"""
Zarr v3 compatibility, migration and concurrency helpers.

This module centralizes everything that changed when the application moved from
zarr-python v2 to v3:

* opening a slide sidecar ``.zarr`` store, transparently converting a legacy
  v2 store to v3 on the first open (read or write). After conversion no
  compatibility layer is kept: the v2 metadata files are removed;
* cross-process / cross-thread write locking via ``filelock`` — this replaces
  zarr's ``ThreadSynchronizer`` / ``ProcessSynchronizer`` which were removed in
  zarr v3 with no in-library replacement;
* construction of zarr v3 codecs (Blosc / LZ4 / Zstd / Gzip);
* a ``create_array`` helper mirroring the ergonomics of the removed
  ``Group.create_dataset`` (including the ``data=`` shortcut and the old
  ``compressor=`` keyword).

The on-disk conversion is metadata-only: zarr's official ``migrate_v2_to_v3``
writes a ``zarr.json`` next to every ``.zarray`` / ``.zgroup`` without touching
chunk data (v3 understands the v2 chunk key encoding), after which the v2
metadata files are deleted. This makes "open a v2 file -> it becomes v3" fast
and safe to run on every open.

If a previous conversion crashed mid-way (v2 sidecars and ``zarr.json``
coexist), :func:`ensure_v3` repairs the store: either finish by stripping v2
metadata when every node already has ``zarr.json``, or roll back partial
``zarr.json`` files and re-migrate from a clean v2 state. A failed migrate
also rolls back so the store is never left permanently mixed.

Detection and repair walk the **entire** tree: a v3 root with nested pure-v2
groups/arrays (e.g. a later ``classification/`` island) is converted too.

Truncated or otherwise invalid ``zarr.json`` is detected before any v2 sidecar
is deleted. When a v2 ``.zarray``/``.zgroup`` remains, the bad file is removed
and the node is remigrated; when no v2 fallback exists, a small sibling backup
(``<store>.tissuelab-v2-meta-backup.zip``, created just before stripping v2) is
restored if present; otherwise :class:`ZarrMetadataError` is raised. The backup
is deleted automatically once the store is verified pure v3.
"""

from __future__ import annotations

import hashlib
import logging
import os
import sys
import tempfile
import threading
import time
import warnings
from contextlib import contextmanager
from typing import Any, Dict, Optional

import numpy as np
import zarr
from zarr.storage import LocalStore

try:  # zarr v3 codecs
    from zarr.codecs import BloscCodec, BloscShuffle, GzipCodec, ZstdCodec
except Exception:  # pragma: no cover - extremely defensive
    BloscCodec = BloscShuffle = GzipCodec = ZstdCodec = None  # type: ignore

from filelock import FileLock, Timeout

# Silence zarr v3 "unstable data type" warnings. Our schema deliberately uses
# structured arrays and fixed-length string/bytes dtypes (cell annotations,
# class name/color tables, ...). These dtypes have no finalized zarr v3 spec
# yet, so zarr emits an UnstableSpecificationWarning on every write. We only
# read these stores within the TissueLab stack (no cross-library portability
# requirement), so the warning is pure noise.
from zarr.errors import UnstableSpecificationWarning

warnings.filterwarnings("ignore", category=UnstableSpecificationWarning)

logger = logging.getLogger(__name__)

# Sentinel so callers can distinguish "no fill_value given" (use the dtype
# default) from an explicit ``fill_value=None``.
_UNSET = object()

_V2_ROOT_META = (".zgroup", ".zarray")
_V3_META = "zarr.json"
_V2_META_FILES = (".zarray", ".zgroup", ".zattrs")


class ZarrMetadataError(RuntimeError):
    """Unrecoverable zarr metadata corruption (e.g. truncated ``zarr.json``
    with no v2 sidecar left to remigrate from)."""


def as_zarr_path(path: Optional[str]) -> Optional[str]:
    """Normalize a slide / store path to its companion ``.zarr`` store path.

    Strips trailing slashes, is case-insensitive for ``.zarr`` / ``.zarr.zip``,
    and appends ``.zarr`` when given a slide path (``.svs``, ``.tiff``, …).
    Returns ``None``/``""`` unchanged.
    """
    if not path:
        return path
    normalized = path.rstrip("/\\")
    lower = normalized.lower()
    if lower.endswith(".zarr.zip") or lower.endswith(".zarr"):
        return normalized
    return f"{normalized}.zarr"


def is_zarr_store_path(path: Optional[str]) -> bool:
    """True if *path* is a zarr directory, including Windows directory symlinks.

    Viewer single-file shares materialize the companion store as a directory
    symlink. ``os.path.exists`` / ``os.path.isdir`` can miss a file-typed
    reparse point that still resolves to a directory, and ``os.access(...,
    R_OK)`` is unreliable on Windows for directories and symlinks — callers
    must not treat it as a hard failure.
    """
    if not path:
        return False
    try:
        if os.path.isdir(path):
            return True
        if os.path.lexists(path):
            return os.path.isdir(os.path.realpath(path))
    except OSError:
        return False
    return False


# ---------------------------------------------------------------------------
# Format detection
# ---------------------------------------------------------------------------
def has_v3_metadata(path: str) -> bool:
    """True if a v3 ``zarr.json`` exists at the store root."""
    return os.path.exists(os.path.join(path, _V3_META))


def has_v2_metadata(path: str) -> bool:
    """True if a v2 ``.zgroup`` / ``.zarray`` exists at the store root."""
    return any(os.path.exists(os.path.join(path, m)) for m in _V2_ROOT_META)


def is_legacy_v2(path: str) -> bool:
    """True when the store on disk is still a pure zarr v2 store."""
    return (
        os.path.isdir(path)
        and has_v2_metadata(path)
        and not has_v3_metadata(path)
    )


def is_mixed_v2_v3(path: str) -> bool:
    """True when v2 and v3 metadata coexist (typically a crashed conversion)."""
    if not os.path.isdir(path):
        return False
    from app.utils.zarr_store import has_any_v2_metadata_files, has_any_v3_metadata_files

    return has_any_v2_metadata_files(path) and has_any_v3_metadata_files(path)


def needs_v3_conversion(path: str) -> bool:
    """True for pure-v2 stores, nested v2-only islands, leftover v2+v3 meta,
    or corrupt ``zarr.json`` that still needs repair / remigration.

    Walks the whole tree — root looking like v3 is not enough; a nested
    ``classification/`` group that is still pure v2 must also be converted.
    """
    if not os.path.isdir(path):
        return False
    from app.utils.zarr_store import (
        has_any_v2_metadata_files,
        has_any_v3_metadata_files,
        has_invalid_zarr_json,
        iter_v2_only_nodes,
    )

    # Truncated / bogus zarr.json must be repaired (or reported) before use.
    if has_invalid_zarr_json(path):
        return True
    # Any directory with .zarray/.zgroup but no valid zarr.json (root or nested).
    if next(iter_v2_only_nodes(path), None) is not None:
        return True
    # v2 sidecars still sitting next to zarr.json somewhere in the tree.
    if has_any_v2_metadata_files(path) and (
        has_v3_metadata(path) or has_any_v3_metadata_files(path)
    ):
        return True
    return False


# ---------------------------------------------------------------------------
# Concurrency: file lock (replaces removed zarr v2 synchronizers)
# ---------------------------------------------------------------------------
def _local_lock_dir() -> str:
    """Machine-local hidden dir for FileLock sidecars (never on the data volume)."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()
        return os.path.join(base, "TissueLab", "locks")
    xdg = os.environ.get("XDG_CACHE_HOME")
    if xdg:
        return os.path.join(xdg, "tissuelab", "locks")
    return os.path.join(os.path.expanduser("~"), ".cache", "tissuelab", "locks")


_ZARR_LOCK_DIR = _local_lock_dir()


def lock_path_for(path: str) -> str:
    """Return the lock-file path for a store path.

    Locks live under a local cache directory (hashed absolute path), not as a
    ``*.zarr.zarrlock`` sidecar next to the store — so NFS data volumes are
    never used for locking, and user folders stay clean. ``FileLock`` leaves
    empty lock files in place by design; that is intentional.
    """
    abs_path = os.path.normcase(os.path.abspath(os.path.normpath(path)))
    digest = hashlib.sha256(abs_path.encode("utf-8")).hexdigest()
    return os.path.join(_ZARR_LOCK_DIR, f"{digest}.lock")


def _legacy_lock_path(path: str) -> str:
    """Sidecar path used by older builds (``store.zarr.zarrlock``)."""
    return os.path.normpath(path) + ".zarrlock"


class _PathLock:
    """In-process gate (reentrant) in front of the cross-process file lock.

    ``FileLock`` instances do not share state, so two of them on one lock file
    contend even on the same thread: ``with zarr_lock(p):`` around a call that
    itself locks ``p`` deadlocked until the 120 s timeout. Reentrancy has to
    live in a real ``RLock``; the ``FileLock`` is taken once, by the outermost
    holder in this process. Queueing on the ``RLock`` also replaces N threads
    polling the lock file at filelock's 50 ms interval with a direct handoff.
    """

    def __init__(self, lock_file: str) -> None:
        self.rlock = threading.RLock()
        self.file_lock = FileLock(lock_file)
        # Only touched under ``rlock``, which owns the whole nest, so a plain int.
        self.depth = 0


_PATH_LOCKS: Dict[str, _PathLock] = {}
_PATH_LOCKS_GUARD = threading.Lock()


def _path_lock_for(path: str) -> _PathLock:
    """Return the process-wide :class:`_PathLock` for ``path`` (created on demand).

    Keyed by lock-file path so the two levels cannot disagree about identity.
    Never evicted: dropping a live entry would split the gate in two.
    """
    lock_file = lock_path_for(path)
    with _PATH_LOCKS_GUARD:
        entry = _PATH_LOCKS.get(lock_file)
        if entry is None:
            entry = _PathLock(lock_file)
            _PATH_LOCKS[lock_file] = entry
        return entry


@contextmanager
def zarr_lock(path: str, timeout: float = 120.0):
    """Cross-process write lock for a ``.zarr`` store.

    Wrap any block that *mutates* a store in this lock. Pure reads do not need
    it (concurrent reads are always safe in zarr v3). This is the replacement
    for the zarr v2 ``synchronizer=`` argument, which no longer exists.

    Reentrant within a thread: a nested ``zarr_lock`` on the same store is a
    no-op that returns immediately. ``timeout`` bounds the *total* wait across
    the in-process gate and the file lock, and raises :class:`filelock.Timeout`
    on expiry rather than proceeding unlocked.
    """
    os.makedirs(_ZARR_LOCK_DIR, exist_ok=True)
    # Best-effort cleanup of sidecars left by older builds that locked in-place.
    try:
        os.remove(_legacy_lock_path(path))
    except OSError:
        pass

    entry = _path_lock_for(path)
    deadline = time.monotonic() + timeout if timeout > 0 else None

    if not entry.rlock.acquire(timeout=timeout if timeout > 0 else -1):
        raise Timeout(entry.file_lock.lock_file)
    try:
        outermost = entry.depth == 0
        if outermost:
            # Spend only what is left of the caller's budget on the file lock,
            # so a slow in-process queue cannot turn `timeout` into 2x itself.
            remaining = -1.0 if deadline is None else max(0.0, deadline - time.monotonic())
            entry.file_lock.acquire(timeout=remaining)
        entry.depth += 1
        try:
            yield
        finally:
            entry.depth -= 1
            if entry.depth == 0:
                entry.file_lock.release()
    finally:
        entry.rlock.release()


# ---------------------------------------------------------------------------
# v2 -> v3 conversion
# ---------------------------------------------------------------------------
def _remove_v2_metadata(path: str) -> None:
    """Delete v2 metadata files once a *valid* sibling ``zarr.json`` exists.

    Never strips v2 next to a missing/truncated/bogus ``zarr.json`` — that would
    make the node unrecoverable. Chunk data is left untouched (v3 reads it via
    the v2 chunk key encoding recorded in ``zarr.json``).
    """
    from app.utils.zarr_store import is_valid_zarr_v3_json

    for root, _dirs, files in os.walk(path):
        if _V3_META not in files:
            continue
        if not is_valid_zarr_v3_json(os.path.join(root, _V3_META)):
            continue
        for fn in files:
            if fn in _V2_META_FILES:
                try:
                    os.remove(os.path.join(root, fn))
                except OSError:
                    pass
        if os.path.abspath(root) == os.path.abspath(path) and ".zmetadata" in files:
            try:
                os.remove(os.path.join(path, ".zmetadata"))
            except OSError:
                pass


def _import_migrator():
    """Locate zarr's official v2->v3 metadata migrator across zarr 3.x layouts."""
    try:  # zarr >= 3.1
        from zarr.metadata.migrate_v3 import migrate_v2_to_v3  # type: ignore
        return migrate_v2_to_v3
    except Exception:
        pass
    try:  # some builds re-export from zarr.storage
        from zarr.storage import migrate_v2_to_v3  # type: ignore
        return migrate_v2_to_v3
    except Exception as exc:  # pragma: no cover - unsupported zarr build
        raise ImportError("zarr v2->v3 migrator not found in this zarr build") from exc


def _drop_zmetadata(path: str) -> None:
    zmeta = os.path.join(path, ".zmetadata")
    if os.path.exists(zmeta):
        try:
            os.remove(zmeta)
        except OSError:
            pass


def _migrate_v2_subtree(path: str, migrate_v2_to_v3) -> None:
    """Run the official migrator on a pure-v2 subtree, rolling back on failure."""
    from app.utils.zarr_store import remove_partial_v3_metadata

    _drop_zmetadata(path)
    # Nested leftovers inside this island would abort the migrator.
    remove_partial_v3_metadata(path)
    try:
        migrate_v2_to_v3(input_store=LocalStore(path))
    except Exception:
        try:
            remove_partial_v3_metadata(path)
        except Exception:
            logger.exception(
                "Failed to roll back partial v3 metadata after migrate error: %s",
                path,
            )
        raise


def _migrate_nested_v2_islands(store_path: str, migrate_v2_to_v3) -> int:
    """Migrate every topmost nested v2-only island under a (possibly v3) root.

    Returns the number of islands converted.
    """
    from app.utils.zarr_store import topmost_v2_islands

    islands = topmost_v2_islands(store_path)
    for island in islands:
        logger.info("Migrating nested zarr v2 island to v3: %s", island)
        _migrate_v2_subtree(island, migrate_v2_to_v3)
    return len(islands)


def _strip_v2_with_backup(path: str) -> None:
    """Backup remaining v2 metadata, strip it next to valid ``zarr.json``, cleanup.

    Refuses to strip if a backup could not be created while v2 files still exist,
    so a later corrupt-``zarr.json`` failure remains recoverable.
    """
    from app.utils.zarr_store import (
        cleanup_v2_meta_backup_if_pure_v3,
        create_v2_meta_backup,
        has_any_v2_metadata_files,
        has_v2_meta_backup,
        is_valid_zarr_v3_json,
        purge_remaining_v2_metadata,
        v3_covers_all_v2_nodes,
    )

    if has_any_v2_metadata_files(path):
        try:
            backup = create_v2_meta_backup(path)
        except Exception as exc:
            raise ZarrMetadataError(
                f"Failed to create v2 metadata backup before strip for {path}: {exc}"
            ) from exc
        if backup is None or not has_v2_meta_backup(path):
            raise ZarrMetadataError(
                f"Failed to create v2 metadata backup before strip for {path}"
            )
        logger.info("Created v2 metadata backup before strip: %s", backup)

    _remove_v2_metadata(path)
    # Final sweep: orphan .zattrs/.zmetadata (no sibling .zarray/.zgroup) would
    # otherwise keep needs_v3_conversion true and block backup auto-cleanup.
    root_json = os.path.join(path, _V3_META)
    if is_valid_zarr_v3_json(root_json) and v3_covers_all_v2_nodes(path):
        n = purge_remaining_v2_metadata(path)
        if n:
            logger.info("Purged %d leftover v2 metadata file(s) under %s", n, path)

    if cleanup_v2_meta_backup_if_pure_v3(path):
        logger.info("Removed v2 metadata backup after successful v3 conversion: %s", path)


def _try_restore_from_v2_backup(path: str) -> bool:
    """Restore v2 sidecars from backup and clear all ``zarr.json`` for a clean remigrate."""
    from app.utils.zarr_store import (
        has_v2_meta_backup,
        remove_partial_v3_metadata,
        restore_v2_meta_backup,
    )

    if not has_v2_meta_backup(path):
        return False
    if not restore_v2_meta_backup(path):
        logger.error("Failed to restore v2 metadata backup for %s", path)
        return False
    remove_partial_v3_metadata(path)
    logger.warning(
        "Restored v2 metadata from backup and cleared zarr.json for remigrate: %s",
        path,
    )
    return True


def ensure_v3(path: str) -> bool:
    """Ensure the ``.zarr`` store at ``path`` uses zarr v3 metadata on disk.

    A legacy v2 store is migrated in place (metadata only, zero chunk copy)
    using zarr's official migrator, then the v2 metadata is removed so no
    compatibility layer remains. Nested v2-only groups/arrays under an already
    v3 root (e.g. a later-written ``classification/`` subtree) are found by
    walking the tree and migrated individually. Stores left mixed by a crashed
    earlier run are repaired. Truncated/bogus ``zarr.json`` next to v2 sidecars
    is dropped and remigrated; corrupt **root** ``zarr.json`` with no v2 left is
    recovered from ``<store>.tissuelab-v2-meta-backup.zip`` when present. The
    backup is removed automatically once the store is pure v3.

    Returns ``True`` if a conversion / repair was performed.
    """
    from app.utils.zarr_store import (
        cleanup_v2_meta_backup_if_pure_v3,
        has_v2_meta_backup_artifacts,
        is_valid_zarr_v3_json,
    )

    if not os.path.isdir(path):
        return False

    if not needs_v3_conversion(path):
        # Stale backup cleanup only — take the lock solely when a backup exists
        # so healthy opens stay cheap.
        if has_v2_meta_backup_artifacts(path):
            with zarr_lock(path):
                if not needs_v3_conversion(path):
                    cleanup_v2_meta_backup_if_pure_v3(path)
                    return False
            # Became dirty while waiting for the lock — fall through to repair.
        else:
            return False

    migrate_v2_to_v3 = _import_migrator()

    with zarr_lock(path):
        # Re-check inside the lock: another worker may have just converted it.
        if not needs_v3_conversion(path):
            cleanup_v2_meta_backup_if_pure_v3(path)
            return False

        from app.utils.zarr_store import (
            repair_invalid_zarr_json,
            v3_covers_all_v2_nodes,
        )

        # Drop truncated/bogus zarr.json when v2 sidecars can still remigrate.
        removed, unrecoverable = repair_invalid_zarr_json(path)
        if removed:
            logger.warning(
                "Removed %d corrupt zarr.json file(s) (v2 sidecar present, will remigrate): %s",
                len(removed),
                path,
            )
        if unrecoverable:
            root_json = os.path.join(path, _V3_META)
            root_norm = os.path.normpath(root_json)
            root_valid = is_valid_zarr_v3_json(root_json)
            root_broken = (not root_valid) or any(
                os.path.normpath(fp) == root_norm for fp in unrecoverable
            )
            from app.utils.zarr_store import (
                has_any_v2_metadata_files,
                remove_partial_v3_metadata,
            )

            # Corrupt zarr.json that still has v2 nearby, but os.remove failed:
            # clear all zarr.json and remigrate from the remaining v2 instead of
            # jumping straight to a nuclear backup restore.
            if root_broken and has_any_v2_metadata_files(path):
                logger.warning(
                    "Corrupt zarr.json could not be deleted in-place; "
                    "clearing all zarr.json to remigrate from v2: %s",
                    path,
                )
                remove_partial_v3_metadata(path)
            elif root_broken:
                # Nuclear remigrate from backup only when the store root itself
                # is unreadable — avoids wiping a healthy tree because of one
                # nested garbage zarr.json.
                if _try_restore_from_v2_backup(path):
                    pass
                else:
                    preview = ", ".join(unrecoverable[:5])
                    more = (
                        f" (+{len(unrecoverable) - 5} more)"
                        if len(unrecoverable) > 5
                        else ""
                    )
                    raise ZarrMetadataError(
                        f"Corrupt root zarr.json with no v2 sidecar "
                        f"(and no metadata backup) under {path}: {preview}{more}"
                    )
            else:
                preview = ", ".join(unrecoverable[:5])
                more = (
                    f" (+{len(unrecoverable) - 5} more)"
                    if len(unrecoverable) > 5
                    else ""
                )
                raise ZarrMetadataError(
                    f"Corrupt nested zarr.json with no v2 sidecar under {path}: "
                    f"{preview}{more}"
                )

        # Fast path: migrate already wrote valid ``zarr.json`` for every v2 node,
        # but crashed before (or during) deleting the v2 sidecars. Just finish
        # the cleanup — do not roll back and re-migrate.
        if has_v3_metadata(path) and v3_covers_all_v2_nodes(path):
            logger.info("Repairing mixed zarr store (strip leftover v2 metadata): %s", path)
            _strip_v2_with_backup(path)
            if not needs_v3_conversion(path):
                logger.info("Repaired zarr store to pure v3: %s", path)
                return True
            # Still inconsistent — fall through to (re)migrate remaining islands.

        # Whole-store migrate when the root itself is still pure v2.
        if is_legacy_v2(path) or (
            has_v2_metadata(path) and not has_v3_metadata(path)
        ):
            logger.info("Converting legacy / partial zarr v2 store to v3: %s", path)
            _migrate_v2_subtree(path, migrate_v2_to_v3)
            _strip_v2_with_backup(path)
            logger.info("Converted zarr store to v3: %s", path)
            return True

        # Root is already v3 (or mixed at root with coverage incomplete): migrate
        # every nested v2-only island recursively, then strip leftover v2 sidecars.
        n = _migrate_nested_v2_islands(path, migrate_v2_to_v3)
        _strip_v2_with_backup(path)
        if n:
            logger.info(
                "Converted %d nested zarr v2 island(s) under v3 root: %s", n, path
            )
        else:
            logger.info("Stripped leftover v2 metadata under store: %s", path)
        return True


def prepare_zarr_for_workflow(path: str) -> None:
    """Ensure a workflow/batch target ``.zarr`` store exists and is on zarr v3.

    Batch processing and cohort runs call ``/tasks/v1/start_workflow`` without
    opening the slide in the viewer, so they never hit ``upload_file_path``'s
    eager migration. Call this at workflow submission time so Model Zoo task
    nodes always see a v3 store (metadata migrated before any node opens it).
    """
    if not os.path.exists(path):
        open_zarr(path, mode="a")
        return
    if not os.path.isdir(path):
        raise NotADirectoryError(path)
    ensure_v3(path)


# ---------------------------------------------------------------------------
# Opening
# ---------------------------------------------------------------------------
def open_zarr(path: str, mode: str = "r", *, auto_convert: bool = True, **kwargs: Any):
    """Open a slide sidecar ``.zarr`` store, auto-converting legacy v2 -> v3.

    Drop-in replacement for ``zarr.open(path, mode)``. Use :func:`zarr_lock`
    for write coordination (zarr v3 removed the v2 ``synchronizer=`` argument).

    When ``auto_convert`` is True (default), a legacy v2 store is migrated to
    v3 on disk before the handle is opened — for both read and write modes.
    Symlinked stores (Viewer / Editor shares) are opened in place: migrating
    would write through to the owner's zarr and can fail the overlay bind.
    """
    if auto_convert and os.path.isdir(path) and not os.path.islink(path):
        try:
            ensure_v3(path)
        except ZarrMetadataError:
            raise
        except Exception as exc:  # pragma: no cover - best effort
            logger.warning("zarr v2->v3 auto-conversion failed for %s: %s", path, exc)
    return zarr.open(path, mode=mode, **kwargs)


@contextmanager
def open_zarr_cm(
    path: str,
    mode: str = "r",
    *,
    auto_convert: bool = True,
    lock: Optional[bool] = None,
    **kwargs: Any,
):
    """Context-manager form of :func:`open_zarr`.

    Yields the opened group/array, so call sites that previously used
    ``with zarr.open(path, mode) as zf:`` keep working unchanged (zarr v3
    groups/arrays are no longer context managers themselves).

    For write modes (anything other than ``"r"``) a :func:`zarr_lock` is
    acquired for the duration of the block. Pass ``lock=False`` to opt out or
    ``lock=True`` to force locking on a read.
    """
    use_lock = (mode != "r") if lock is None else lock
    if auto_convert and os.path.isdir(path) and not os.path.islink(path):
        try:
            ensure_v3(path)
        except ZarrMetadataError:
            raise
        except Exception as exc:  # pragma: no cover
            logger.warning("zarr v2->v3 auto-conversion failed for %s: %s", path, exc)
    if use_lock:
        with zarr_lock(path):
            yield zarr.open(path, mode=mode, **kwargs)
    else:
        yield zarr.open(path, mode=mode, **kwargs)


def open_group(path: str, mode: str = "r", *, auto_convert: bool = True, **kwargs: Any):
    """Like :func:`open_zarr` but always returns a group (``zarr.open_group``)."""
    if auto_convert and os.path.isdir(path) and not os.path.islink(path):
        try:
            ensure_v3(path)
        except ZarrMetadataError:
            raise
        except Exception as exc:  # pragma: no cover
            logger.warning("zarr v2->v3 auto-conversion failed for %s: %s", path, exc)
    return zarr.open_group(path, mode=mode, **kwargs)


# ---------------------------------------------------------------------------
# Codecs (zarr v3)
# ---------------------------------------------------------------------------
_SHUFFLE = {}
if BloscShuffle is not None:  # pragma: no branch
    _SHUFFLE = {
        "shuffle": BloscShuffle.shuffle,
        "bitshuffle": BloscShuffle.bitshuffle,
        "noshuffle": BloscShuffle.noshuffle,
    }


def blosc(cname: str = "zstd", clevel: int = 5, shuffle: str = "shuffle"):
    """A zarr v3 Blosc codec. ``shuffle`` is one of
    ``"shuffle"`` / ``"bitshuffle"`` / ``"noshuffle"``."""
    if BloscCodec is None:  # pragma: no cover
        return None
    return BloscCodec(cname=cname, clevel=clevel, shuffle=_SHUFFLE.get(shuffle, BloscShuffle.shuffle))


def lz4(clevel: int = 5, shuffle: str = "shuffle"):
    """LZ4 compression. In v3 this is expressed as Blosc(cname='lz4')."""
    return blosc(cname="lz4", clevel=clevel, shuffle=shuffle)


def zstd(level: int = 5):
    if ZstdCodec is not None:
        return ZstdCodec(level=level)
    return blosc(cname="zstd", clevel=level)  # pragma: no cover


def gzip(level: int = 5):
    if GzipCodec is not None:
        return GzipCodec(level=level)
    return None  # pragma: no cover


def default_compressors():
    """Default compressor list for new arrays."""
    codec = blosc()
    return [codec] if codec is not None else "auto"


# ---------------------------------------------------------------------------
# create_array helper (replaces removed Group.create_dataset)
# ---------------------------------------------------------------------------
def create_array(
    group,
    name: str,
    *,
    data=None,
    shape=None,
    dtype=None,
    chunks="auto",
    compressor=_UNSET,
    compressors=_UNSET,
    fill_value=_UNSET,
    overwrite: bool = False,
    **kwargs,
):
    """Create an array under ``group`` mirroring the old ``create_dataset`` API.

    Accepts either ``compressor=`` (legacy, single codec) or ``compressors=``
    (v3, list/codec). When ``data`` is given, ``shape``/``dtype`` are inferred.
    """
    call: dict[str, Any] = {"overwrite": overwrite}

    if compressors is not _UNSET:
        call["compressors"] = compressors
    elif compressor is not _UNSET:
        # Normalize a single legacy-style codec into the v3 ``compressors`` arg.
        call["compressors"] = [compressor] if compressor is not None else None

    if chunks is not None:
        call["chunks"] = chunks

    if data is not None:
        # zarr v3 infers shape/dtype from ``data`` and rejects passing ``data``
        # together with ``shape`` or ``dtype``. Honor a requested ``dtype`` by
        # coercing the data up front, then pass only ``data``.
        if isinstance(data, (bytes, bytearray, str)):
            # Legacy callers (mirroring zarr v2 ``create_dataset(data=<bytes>)``)
            # pass a raw text/bytes blob. zarr v3 needs an array-like with a
            # shape, so wrap it as a 0-d fixed-length bytes array.
            if isinstance(data, str):
                data = data.encode("utf-8")
            else:
                data = bytes(data)
            data = np.array(data, dtype=f"S{max(1, len(data))}")
        elif dtype is not None:
            data = np.asarray(data, dtype=dtype)
        call["data"] = data
    else:
        if shape is not None:
            call["shape"] = shape
        if dtype is not None:
            call["dtype"] = dtype

    if fill_value is not _UNSET:
        call["fill_value"] = fill_value

    call.update(kwargs)
    return group.create_array(name, **call)


def create_bytes_array(group, name: str, data, *, overwrite: bool = True):
    """Store a ``bytes``/``str`` payload as a 0-d fixed-length bytes array.

    Mirrors how zarr v2 ``create_dataset(name, data=<bytes>)`` stored small
    text blobs (e.g. JSON counts, params). Readers can ``arr[()]`` and decode.
    """
    if isinstance(data, str):
        data = data.encode("utf-8")
    arr = np.array(data, dtype=f"S{max(1, len(data))}")
    return group.create_array(name, data=arr, overwrite=overwrite)
