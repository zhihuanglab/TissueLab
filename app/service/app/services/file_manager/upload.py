"""File uploads: multipart, chunked, and zarr batch."""
from fastapi import HTTPException, UploadFile, Request
from fastapi.responses import JSONResponse
import asyncio
import functools
import json
import math
import os
import shutil
import re
import sys
import tempfile
import uuid
import hashlib
import time
import threading
import schedule
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from filelock import FileLock, Timeout
from pathlib import Path
from typing import List, Dict, Any, Optional, Set

from app.core.auth import AuthUser
from app.core.errors import AppErrors
from app.repos.files import FilesRepo
from app.utils import resolve_path
from app.config.path_config import STORAGE_ROOT

from app.services.file_manager.common import (
    logger,
    build_file_id,
    normalize_rel_path,
    sanitize_filename,
    validate_user_access_to_path,
    assert_writable_async,
    assert_can_access_path_async,
    assert_can_write_path,
    ensure_quota_or_raise,
)

# Upload concurrency and limits
_UPLOAD_SEMAPHORE = threading.Semaphore(8)
_CHUNK_UPLOAD_CONCURRENCY = 16
_CHUNK_COMPLETE_CONCURRENCY = 4
_CHUNK_UPLOAD_SEMAPHORE = threading.Semaphore(_CHUNK_UPLOAD_CONCURRENCY)
_CHUNK_COMPLETE_SEMAPHORE = threading.Semaphore(_CHUNK_COMPLETE_CONCURRENCY)

# Chunk IO runs in its own pool, not the default asyncio executor.
#
# ``asyncio.to_thread`` dispatches into a pool of min(32, cpu+4) threads — 12 on
# an 8-core host — shared by every ACL guard, Firestore call and copy in the
# service. Sixteen concurrent chunk writes (each holding its thread for a
# multi-megabyte write plus a lock wait) would take every worker, and the rest
# of the service would queue behind one user's upload. Sized to the semaphores
# that already bound the two paths, so the pool can never be oversubscribed.
_UPLOAD_IO_EXECUTOR = ThreadPoolExecutor(
    max_workers=_CHUNK_UPLOAD_CONCURRENCY + _CHUNK_COMPLETE_CONCURRENCY,
    thread_name_prefix="upload-io",
)


async def _run_upload_io(fn, *args, **kwargs):
    """Run blocking upload IO in the dedicated pool (see _UPLOAD_IO_EXECUTOR)."""
    loop = asyncio.get_running_loop()
    if kwargs:
        return await loop.run_in_executor(
            _UPLOAD_IO_EXECUTOR, functools.partial(fn, *args, **kwargs)
        )
    return await loop.run_in_executor(_UPLOAD_IO_EXECUTOR, fn, *args)
_ZARR_BATCH_UPLOAD_SEMAPHORE = threading.Semaphore(4)
_ZARR_BATCH_UPLOAD_LOCKS: Dict[str, threading.Lock] = {}
_ZARR_BATCH_UPLOAD_LOCKS_GUARD = threading.Lock()
_CHUNK_UPLOAD_LOCKS: Dict[str, threading.Lock] = {}
_CHUNK_UPLOAD_LOCKS_GUARD = threading.Lock()
# Cross-process merge / session locks (filelock on all platforms).
_MERGE_LOCKS: Dict[str, FileLock] = {}
_MERGE_LOCKS_GUARD = threading.Lock()
# Per-chunk write locks, striped rather than kept in a table keyed by chunk.
# A table has to be purged when a session ends, and that purge can take a lock
# out from under a worker still inside it: the next worker builds a fresh Lock
# for the same chunk and both write the chunk file at once. A fixed pool cannot
# be purged, so it cannot have that problem. Two chunks occasionally share a
# stripe and serialize on each other, which costs one of them a short wait.
_CHUNK_FILE_LOCK_STRIPES = 64
_CHUNK_FILE_LOCKS: List[threading.Lock] = [
    threading.Lock() for _ in range(_CHUNK_FILE_LOCK_STRIPES)
]

# Mirror client CHUNK_UPLOAD_MIN_ASSUMED_SPEED_BPS (32 KB/s).
_CHUNK_UPLOAD_MIN_ASSUMED_SPEED_BPS = 32 * 1024
_COMPLETE_POLL_FAST_INTERVAL_SECONDS = 10
_COMPLETE_POLL_INTERVAL_SECONDS = 15

MAX_FILES_PER_UPLOAD = 500
MAX_ZARR_BATCH_BYTES = 64 * 1024 * 1024
MAX_ZARR_BATCH_HEADER_BYTES = 16 * 1024 * 1024
MAX_ZARR_BATCH_FILES = 2000
MAX_CHUNK_BYTES = MAX_ZARR_BATCH_BYTES
STALE_UPLOAD_SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600
STALE_MERGING_MAX_AGE_SECONDS = 4 * 3600
MERGED_PENDING_METADATA_RETRY_INTERVAL_SECONDS = 15 * 60
MERGED_PENDING_METADATA_ABANDON_SECONDS = 7 * 24 * 3600

CHUNK_TEMP_DIR = Path(STORAGE_ROOT) / ".temp_chunks"
# Ephemeral server-side staging; excluded from user quota (see ensure_quota_or_raise).
CHUNK_TEMP_DIR.mkdir(exist_ok=True)
# Completion records live one level down so they stay out of the directory scan
# every file listing performs — see _upload_completion_record_path.
COMPLETED_UPLOADS_DIR = CHUNK_TEMP_DIR / "completed"
COMPLETED_UPLOADS_DIR.mkdir(exist_ok=True)


def _local_upload_lock_dir() -> Path:
    """Machine-local hidden dir for FileLock sidecars (not on STORAGE_ROOT / NFS)."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()
        return Path(base) / "TissueLab-Ctrl" / "upload_locks"
    xdg = os.environ.get("XDG_CACHE_HOME")
    if xdg:
        return Path(xdg) / "tissuelab-ctrl" / "upload_locks"
    return Path.home() / ".cache" / "tissuelab-ctrl" / "upload_locks"


# Cross-process upload locks stay on local disk so NFS data mounts are never
# used for flock (unreliable) and lock files stay out of user storage.
UPLOAD_LOCK_DIR = _local_upload_lock_dir()
UPLOAD_LOCK_DIR.mkdir(parents=True, exist_ok=True)

_UPLOAD_LISTING_HIDDEN_STATUSES = frozenset({"uploading", "merging", "merged_pending_metadata", "cancelling"})
_INFLIGHT_QUOTA_STATUSES = frozenset({"uploading", "merging", "merged_pending_metadata"})


def _chunk_session_upload_id(info_path: Path, info: Dict[str, Any]) -> str:
    name = info_path.name
    if name.startswith("zarr_batch_"):
        return name[len("zarr_batch_"):-len(".json")]
    return str(info.get("upload_id") or info_path.stem)


def _zarr_top_level_names_from_session(session: Dict[str, Any]) -> Set[str]:
    return {root.split("/")[0] for root in _zarr_roots_for_session(session) if root.split("/")[0]}


def is_active_chunk_upload_destination(path_abs: str) -> bool:
    """True when path_abs is the destination of an in-progress chunked upload."""
    if not path_abs or not CHUNK_TEMP_DIR.is_dir():
        return False
    path_norm = os.path.normpath(path_abs)
    for info_path in CHUNK_TEMP_DIR.glob("*.json"):
        name = info_path.name
        if name.endswith(".done.json") or name.startswith("zarr_batch_"):
            continue
        try:
            with open(info_path, "r", encoding="utf-8") as f:
                info = json.load(f)
        except Exception:
            continue
        if not isinstance(info, dict):
            continue
        status = str(info.get("status") or "uploading")
        if status not in _UPLOAD_LISTING_HIDDEN_STATUSES:
            continue
        dest = str(info.get("destination_path") or "")
        if dest and os.path.normpath(dest) == path_norm:
            return True
    return is_active_zarr_upload_destination(path_abs)


def is_active_zarr_upload_destination(path_abs: str) -> bool:
    """True when path_abs is part of an in-progress zarr batch upload."""
    if not path_abs or not CHUNK_TEMP_DIR.is_dir():
        return False
    path_norm = os.path.normpath(path_abs)
    for info_path in CHUNK_TEMP_DIR.glob("zarr_batch_*.json"):
        try:
            with open(info_path, "r", encoding="utf-8") as f:
                session = json.load(f)
        except Exception:
            continue
        if not isinstance(session, dict):
            continue
        try:
            dest_folder = resolve_path(str(session.get("path") or ""))
        except Exception:
            continue
        dest_norm = os.path.normpath(dest_folder)
        if path_norm != dest_norm and not path_norm.startswith(dest_norm + os.sep):
            continue
        for root in _zarr_roots_for_session(session):
            abs_root = os.path.normpath(os.path.join(dest_folder, root.replace("/", os.sep)))
            if path_norm == abs_root or path_norm.startswith(abs_root + os.sep):
                return True
    return False


def is_active_upload_destination(path_abs: str) -> bool:
    return is_active_chunk_upload_destination(path_abs) or is_active_zarr_upload_destination(path_abs)


def active_upload_destination_roots() -> "tuple[Set[str], List[str]]":
    """One pass over the session files, for callers that test many paths.

    Returns ``(exact, prefixes)`` — normalized absolute destinations of
    in-progress chunked uploads, and normalized absolute ``.zarr`` roots of
    in-progress zarr batch uploads. ``is_active_upload_destination`` re-reads
    and re-parses every session JSON on each call; search would otherwise pay
    that once per hit.
    """
    exact: Set[str] = set()
    prefixes: List[str] = []
    if not CHUNK_TEMP_DIR.is_dir():
        return exact, prefixes
    for info_path in CHUNK_TEMP_DIR.glob("*.json"):
        name = info_path.name
        if name.endswith(".done.json"):
            continue
        try:
            with open(info_path, "r", encoding="utf-8") as f:
                info = json.load(f)
        except Exception:
            continue
        if not isinstance(info, dict):
            continue
        if name.startswith("zarr_batch_"):
            try:
                dest_folder = resolve_path(str(info.get("path") or ""))
            except Exception:
                continue
            for root in _zarr_roots_for_session(info):
                prefixes.append(
                    os.path.normpath(os.path.join(dest_folder, root.replace("/", os.sep)))
                )
            continue
        status = str(info.get("status") or "uploading")
        if status not in _UPLOAD_LISTING_HIDDEN_STATUSES:
            continue
        dest = str(info.get("destination_path") or "")
        if dest:
            exact.add(os.path.normpath(dest))
    return exact, prefixes


def matches_upload_destination_roots(
    path_abs: str, exact: Set[str], prefixes: List[str]
) -> bool:
    """Test one path against a pre-computed ``active_upload_destination_roots``."""
    if not path_abs:
        return False
    path_norm = os.path.normpath(path_abs)
    if path_norm in exact:
        return True
    return any(
        path_norm == root or path_norm.startswith(root + os.sep) for root in prefixes
    )


def active_upload_basenames_in_directory(directory_abs: str) -> Set[str]:
    """Names hidden from a listing because an upload is still writing them.

    Folds ``active_chunk_upload_basenames_in_directory`` and
    ``active_zarr_upload_basenames_in_directory`` into a single pass over the
    session files — the listing path called both, reading and parsing every
    session JSON twice per request.
    """
    hidden: Set[str] = set()
    if not directory_abs or not CHUNK_TEMP_DIR.is_dir():
        return hidden
    dir_norm = os.path.normpath(directory_abs)
    for info_path in CHUNK_TEMP_DIR.glob("*.json"):
        name = info_path.name
        if name.endswith(".done.json"):
            continue
        try:
            with open(info_path, "r", encoding="utf-8") as f:
                info = json.load(f)
        except Exception:
            continue
        if not isinstance(info, dict):
            continue
        try:
            if name.startswith("zarr_batch_"):
                if os.path.normpath(resolve_path(str(info.get("path") or ""))) == dir_norm:
                    hidden.update(_zarr_top_level_names_from_session(info))
                continue
            status = str(info.get("status") or "uploading")
            if status not in _UPLOAD_LISTING_HIDDEN_STATUSES:
                continue
            dest = str(info.get("destination_path") or "")
            if dest and os.path.normpath(os.path.dirname(dest)) == dir_norm:
                hidden.add(os.path.basename(dest))
        except Exception:
            continue
    return hidden


def subtree_has_active_upload_destination(path_abs: str) -> bool:
    """True when an in-progress upload targets ``path_abs`` or anything under it.

    Callers used to walk the whole subtree and call
    ``is_active_upload_destination`` per file — O(files) x O(sessions) JSON
    reads, which for a directory-format ``.zarr`` means millions of them. There
    are only ever a handful of active destinations, so test those against the
    directory instead and never touch the subtree at all.
    """
    if not path_abs:
        return False
    path_norm = os.path.normpath(path_abs)
    child_prefix = path_norm + os.sep
    exact, prefixes = active_upload_destination_roots()
    for dest in exact:
        if dest == path_norm or dest.startswith(child_prefix):
            return True
    for root in prefixes:
        # The upload root may sit inside this directory, or contain it.
        if (
            root == path_norm
            or root.startswith(child_prefix)
            or path_norm.startswith(root + os.sep)
        ):
            return True
    return False


def _normalize_chunk_size(chunk_size: int) -> int:
    try:
        size = int(chunk_size)
    except (TypeError, ValueError):
        size = MAX_CHUNK_BYTES
    if size <= 0:
        size = MAX_CHUNK_BYTES
    return min(size, MAX_CHUNK_BYTES)


def _load_chunk_upload_info(upload_id: str) -> Dict[str, Any]:
    upload_info_path = CHUNK_TEMP_DIR / f"{upload_id}.json"
    if not upload_info_path.exists():
        raise AppErrors.RESOURCE_NOT_FOUND()
    with open(upload_info_path, 'r') as f:
        upload_info = json.load(f)
    upload_info["uploaded_chunks"] = set(upload_info.get("uploaded_chunks") or [])
    return upload_info


def _assert_chunk_upload_owner(upload_info: Dict[str, Any], auth_user: AuthUser):
    owner = upload_info.get("owner")
    if owner and owner != auth_user.uid:
        raise AppErrors.USER_FORBIDDEN()



def _release_chunk_upload_lock(upload_id: str):
    with _CHUNK_UPLOAD_LOCKS_GUARD:
        _CHUNK_UPLOAD_LOCKS.pop(upload_id, None)


# Ceiling on any single cross-process upload lock. Generous enough for a
# legitimate cleanup of a large partial store, short enough that a wedged
# holder surfaces as an error instead of a hung request.
FILE_LOCK_TIMEOUT_SEC = 120.0


@contextmanager
def _file_lock(lock_path: Path, timeout: float = FILE_LOCK_TIMEOUT_SEC):
    """Cross-process FileLock for short critical sections.

    Lock files live under ``UPLOAD_LOCK_DIR`` (local disk). ``FileLock`` leaves
    empty sidecars in place by design — do not unlink on release (POSIX race).

    Bounded on purpose. filelock's default is -1, i.e. wait forever: a holder
    that crashes is fine (the kernel drops the lock), but a holder that *hangs*
    — a stalled unlink storm over a slow mount, say — would leave every other
    request for this upload waiting with no error and no recovery. The AI
    service's zarr_lock already settled on this shape. Raises filelock.Timeout,
    which is a far better outcome than a request that never returns.
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(lock_path), timeout=timeout):
        yield


def _chunk_session_lock_path(upload_id: str) -> Path:
    return UPLOAD_LOCK_DIR / f"{upload_id}.session.lock"


def _zarr_session_lock_path(upload_id: str) -> Path:
    return UPLOAD_LOCK_DIR / f"zarr_batch_{upload_id}.session.lock"


@contextmanager
def _destination_init_lock(destination_path: str):
    """Serialize chunked init for the same destination path across workers."""
    dest_norm = os.path.normpath(destination_path)
    lock_name = hashlib.sha256(dest_norm.encode("utf-8")).hexdigest()[:32]
    with _file_lock(UPLOAD_LOCK_DIR / f"dest_init_{lock_name}.lock"):
        yield


@contextmanager
def _chunk_session_lock(upload_id: str):
    """Cross-process lock for chunked session JSON read-modify-write."""
    with _file_lock(_chunk_session_lock_path(upload_id)):
        yield


@contextmanager
def _zarr_session_lock(upload_id: str):
    """Cross-process lock for zarr batch session JSON read-modify-write."""
    with _file_lock(_zarr_session_lock_path(upload_id)):
        yield


def _inflight_upload_bytes_for_user(
    uid: str,
    exclude_upload_ids: Optional[Set[str]] = None,
) -> int:
    """Sum total_size of in-progress chunked/zarr sessions owned by uid."""
    exclude = exclude_upload_ids or set()
    total = 0
    if not uid or not CHUNK_TEMP_DIR.exists():
        return 0
    for info_path in CHUNK_TEMP_DIR.glob("*.json"):
        name = info_path.name
        if name.endswith(".done.json"):
            continue
        try:
            with open(info_path, "r", encoding="utf-8") as f:
                info = json.load(f)
        except Exception:
            continue
        if not isinstance(info, dict):
            continue
        if str(info.get("owner") or "") != uid:
            continue
        if name.startswith("zarr_batch_"):
            upload_id = name[len("zarr_batch_"):-len(".json")]
            zarr_total = int(info.get("total_size") or 0)
            oversized = int(info.get("oversized_bytes") or 0)
            session_bytes = max(0, zarr_total - oversized)
        else:
            upload_id = _chunk_session_upload_id(info_path, info)
            status = str(info.get("status") or "uploading")
            if status not in _INFLIGHT_QUOTA_STATUSES:
                continue
            session_bytes = int(info.get("total_size") or 0)
        if upload_id in exclude:
            continue
        total += max(0, session_bytes)
    return total


def _staged_destination_bytes_on_disk_for_user(uid: str) -> int:
    """Bytes already materialized on disk for open chunked uploads (walk double-count guard)."""
    total = 0
    if not uid or not CHUNK_TEMP_DIR.is_dir():
        return total
    for info_path in CHUNK_TEMP_DIR.glob("*.json"):
        name = info_path.name
        if name.endswith(".done.json") or name.startswith("zarr_batch_"):
            continue
        try:
            with open(info_path, "r", encoding="utf-8") as f:
                info = json.load(f)
        except Exception:
            continue
        if not isinstance(info, dict) or str(info.get("owner") or "") != uid:
            continue
        status = str(info.get("status") or "uploading")
        if status not in _INFLIGHT_QUOTA_STATUSES:
            continue
        dest = str(info.get("destination_path") or "")
        expected = int(info.get("total_size") or 0)
        if dest and expected > 0 and _destination_matches_expected(dest, expected):
            total += expected
    return total


def _ensure_chunk_upload_quota_or_raise(
    auth_user: AuthUser,
    incoming_bytes: int,
    exclude_upload_ids: Optional[Set[str]] = None,
) -> None:
    staged = _staged_destination_bytes_on_disk_for_user(auth_user.uid)
    inflight = _inflight_upload_bytes_for_user(
        auth_user.uid,
        exclude_upload_ids=exclude_upload_ids,
    )
    # The directory walk already includes pre-allocated destinations; staged
    # subtracts them from the walk — exclude the same bytes from inflight too.
    inflight = max(0, inflight - staged)
    ensure_quota_or_raise(
        auth_user,
        incoming_bytes,
        inflight_bytes=inflight,
        staged_on_disk_bytes=staged,
    )


def _merge_lock_path(upload_id: str) -> Path:
    return UPLOAD_LOCK_DIR / f"{upload_id}.merge.lock"


def _probe_merge_lock_held(upload_id: str) -> bool:
    """True when any process holds the cross-process merge lock.

    Uses ``FileLock`` (not SoftFileLock): merge can span a long verify phase,
    and OS-level locks are released if the holder process dies. The empty
    sidecar may remain until ``_remove_merge_lock_file``; do not unlink here
    (POSIX flock + unlink race).
    """
    lock = FileLock(str(_merge_lock_path(upload_id)))
    try:
        lock.acquire(timeout=0)
        lock.release()
        return False
    except Timeout:
        return True


def _try_acquire_merge_lock(upload_id: str) -> bool:
    """Acquire merge lock for this process."""
    with _MERGE_LOCKS_GUARD:
        if upload_id in _MERGE_LOCKS:
            return False

    path = _merge_lock_path(upload_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = FileLock(str(path))
    try:
        lock.acquire(timeout=0)
    except Timeout:
        return False
    with _MERGE_LOCKS_GUARD:
        _MERGE_LOCKS[upload_id] = lock
    return True


def _release_merge_lock(upload_id: str) -> None:
    with _MERGE_LOCKS_GUARD:
        lock = _MERGE_LOCKS.pop(upload_id, None)
    if lock is None:
        return
    try:
        lock.release()
    except Timeout:
        pass


def _remove_merge_lock_file(upload_id: str) -> None:
    """Release the merge lock and delete its sidecar.

    Only call when the upload session is finished (or abandoned). Unlink after
    ``FileLock`` release is otherwise unsafe on POSIX while the lock name is
    still contended; here no other worker should acquire this upload_id again.
    """
    _release_merge_lock(upload_id)
    try:
        _merge_lock_path(upload_id).unlink(missing_ok=True)
    except OSError as exc:
        logger.warning(f"Failed to remove merge lock file for {upload_id}: {exc}")


def _get_chunk_file_lock(upload_id: str, chunk_index: int) -> threading.Lock:
    return _CHUNK_FILE_LOCKS[
        hash((upload_id, chunk_index)) % _CHUNK_FILE_LOCK_STRIPES
    ]


def _free_bytes_for_path(path: Path | str) -> Optional[int]:
    try:
        target = Path(path)
        check_path = target
        while not check_path.exists() and check_path != check_path.parent:
            check_path = check_path.parent
        # shutil.disk_usage works on Windows and Unix; os.statvfs is Unix-only.
        return shutil.disk_usage(check_path).free
    except OSError as exc:
        logger.warning(f"Unable to read free disk space for {path}: {exc}")
        return None


def _ensure_disk_space_for_chunked_upload(
    required_bytes: int,
    destination_path: Optional[str] = None,
    *,
    staged_bytes: int = 0,
) -> None:
    """Require free space for streaming chunked assembly.

    Chunks are written directly into the pre-allocated destination (peak ~1× file size).
    At init ``staged_bytes`` is 0 (need ``required`` free on the destination volume).
    At complete ``staged_bytes`` is ~file size (no additional space required).
    """
    required = int(required_bytes)
    if required <= 0:
        return
    staged = max(0, min(int(staged_bytes), required))
    needed = required - staged
    paths_to_check: List[Path] = []
    if destination_path:
        paths_to_check.append(Path(destination_path).parent)
    if not paths_to_check:
        paths_to_check.append(CHUNK_TEMP_DIR)

    for path in paths_to_check:
        free = _free_bytes_for_path(path)
        if free is None:
            raise AppErrors.SERVER_INTERNAL_ERROR(
                f"Unable to verify free disk space for {path}. Upload rejected."
            )
        if free < needed:
            raise AppErrors.SERVER_INTERNAL_ERROR(
                f"Insufficient disk space for upload on {path} "
                f"(need ~{needed // (1024 * 1024)}MB free; "
                f"~{staged // (1024 * 1024)}MB already staged)."
            )


def _remove_staged_upload_file(destination_path: str) -> None:
    """Remove a staged/incomplete upload destination regardless of size."""
    if not destination_path or not os.path.isfile(destination_path):
        return
    try:
        os.remove(destination_path)
    except OSError as exc:
        logger.warning(f"Failed to remove staged upload file {destination_path}: {exc}")



def _destination_matches_expected(destination_path: str, expected_size: int) -> bool:
    if not destination_path or expected_size <= 0 or not os.path.isfile(destination_path):
        return False
    try:
        return os.path.getsize(destination_path) == expected_size
    except OSError:
        return False


def _merge_in_progress_for_upload(
    upload_id: str,
    *,
    exclude_current_thread: bool = False,
) -> bool:
    """True when another worker/thread holds the merge lock."""
    if exclude_current_thread:
        with _MERGE_LOCKS_GUARD:
            if upload_id in _MERGE_LOCKS:
                return False
    return _probe_merge_lock_held(upload_id)


def _stale_merging_max_age_seconds(expected_size: int) -> int:
    """Scale merging timeout with file size ( +1h per 10GB above base )."""
    extra_hours = max(0, expected_size // (10 * 1024 * 1024 * 1024))
    return STALE_MERGING_MAX_AGE_SECONDS + extra_hours * 3600


def _compute_complete_phase_budget_seconds(total_size: int) -> int:
    """Mirror client computeCompletePhaseBudgetMs."""
    per_attempt_s = _stale_merging_max_age_seconds(total_size)
    poll_window_s = per_attempt_s + 30 * 60
    retry_attempts = max(120, math.ceil(poll_window_s / _COMPLETE_POLL_FAST_INTERVAL_SECONDS))
    return per_attempt_s * 2 + retry_attempts * _COMPLETE_POLL_INTERVAL_SECONDS


def _stale_session_max_idle_seconds(total_size: int) -> int:
    """Max idle time before abandoning a session — aligned with client computeUploadSessionTimeoutMs."""
    min_transfer_s = 30 * 60
    transfer_s = (
        math.ceil(total_size / _CHUNK_UPLOAD_MIN_ASSUMED_SPEED_BPS)
        if total_size > 0
        else min_transfer_s
    )
    computed = max(min_transfer_s, transfer_s + _compute_complete_phase_budget_seconds(total_size))
    return max(STALE_UPLOAD_SESSION_MAX_AGE_SECONDS, computed)


def _touch_upload_activity(upload_info: Dict[str, Any]) -> None:
    upload_info["last_activity_at"] = time.time()


def _chunk_upload_session_blocked(status: str) -> bool:
    return status in ("merging", "merged_pending_metadata", "cancelling")


def _recover_stale_merging_session(
    upload_id: str,
    *,
    session_lock_held: bool = False,
    allow_destructive_recovery: bool = True,
) -> Dict[str, Any]:
    """Recover phantom/stale merging sessions.

    When ``session_lock_held`` is True the caller already holds ``_chunk_session_lock``
    for this upload_id — do not acquire it again (FileLock is not reentrant).

    When ``allow_destructive_recovery`` is False (e.g. GET status), never delete
    assembled files or reset merging sessions to uploading.
    """

    def _recover() -> Dict[str, Any]:
        upload_info = _load_chunk_upload_info(upload_id)
        status = str(upload_info.get("status") or "uploading")
        if status != "merging":
            return upload_info

        destination_path = str(upload_info.get("destination_path") or "")
        expected_size = int(upload_info.get("total_size") or 0)

        # Merge finished but session stuck (crash before metadata/cleanup) — recover immediately.
        if _destination_matches_expected(destination_path, expected_size):
            uploaded = set(upload_info.get("uploaded_chunks") or [])
            expected = set(range(int(upload_info["total_chunks"])))
            if uploaded == expected:
                try:
                    _verify_streaming_assembly(destination_path, expected_size, upload_info)
                    upload_info["status"] = "merged_pending_metadata"
                    upload_info.pop("merging_started_at", None)
                    _save_chunk_upload_info(upload_id, upload_info)
                    logger.info(
                        f"Recovered merging session {upload_id}: destination verified, pending metadata"
                    )
                    return upload_info
                except (ValueError, OSError, FileNotFoundError) as verify_err:
                    logger.warning(
                        f"Merging recovery verify failed for {upload_id}: {verify_err}"
                    )

        if _merge_in_progress_for_upload(upload_id, exclude_current_thread=True):
            return upload_info

        if not allow_destructive_recovery:
            return upload_info

        # Phantom merging (e.g. process restart): status says merging but no active merge lock.
        _remove_staged_upload_file(destination_path)
        upload_info["status"] = "uploading"
        upload_info.pop("merging_started_at", None)
        _touch_upload_activity(upload_info)
        _save_chunk_upload_info(upload_id, upload_info)
        logger.warning(
            f"Recovered phantom merging upload session {upload_id} (no merge lock held)"
        )
        return upload_info

    if session_lock_held:
        return _recover()
    with _chunk_session_lock(upload_id):
        return _recover()


def _upsert_chunked_upload_metadata(
    upload_info: Dict[str, Any],
    destination_path: str,
    file_size: int,
    auth_user: AuthUser,
) -> None:
    rel_path = os.path.relpath(destination_path, STORAGE_ROOT).replace('\\', '/')
    if rel_path == '.':
        rel_path = ''
    repo = FilesRepo()
    file_id = build_file_id(rel_path)
    file_data = {
        'ownerId': auth_user.uid,
        'fileName': upload_info['filename'],
        'localPath': rel_path,
        'fileSize': file_size,
        'isPublic': False,
        'sharedWith': [],
    }
    if 'classifiers' in rel_path:
        original_filename = upload_info.get('original_filename', upload_info['filename'])
        file_data['originalFileName'] = original_filename
    repo.create_if_absent(file_id, file_data)


_METADATA_RETRY_MESSAGE = "File assembled but metadata registration failed. Retry complete."


def _chunked_upload_success_response(
    upload_info: Dict[str, Any],
    destination_path: str,
    *,
    duplicate: bool = False,
) -> JSONResponse:
    payload: Dict[str, Any] = {
        "success": True,
        "message": f"File '{upload_info['filename']}' uploaded successfully.",
        "file_path": destination_path,
    }
    if duplicate:
        payload["duplicate_complete"] = True
    return JSONResponse(content=payload)


def _upload_completion_record_path(upload_id: str) -> Path:
    """Where a completion record is written.

    In a subdirectory rather than beside the live sessions: every file-manager
    listing enumerates ``CHUNK_TEMP_DIR`` to hide files an upload is still
    writing, and these are kept for a week across every user, so they used to
    dominate that scan (20k of them cost tens of ms per listing on local disk,
    a paged bucket listing on gcsfuse). Nothing scans for them — they are looked
    up by exact upload id — so the move costs nothing.
    """
    return COMPLETED_UPLOADS_DIR / f"{upload_id}.done.json"


def _legacy_upload_completion_record_path(upload_id: str) -> Path:
    """Where completion records lived before they moved into ``completed/``.

    Read-only compatibility, deliberately temporary: an upload that finished
    just before this deployed still has its record here, and without the
    fallback a retried ``complete`` for it would look like a fresh one.

    Delete once those records have aged out — ``STALE_UPLOAD_SESSION_MAX_AGE_SECONDS``
    (7 days) after the deploy, since ``cleanup_stale_upload_sessions`` sweeps
    here too. Then drop this function, its two call sites, and that half of the
    sweep.
    """
    return CHUNK_TEMP_DIR / f"{upload_id}.done.json"


def _write_upload_completion_record(
    upload_id: str,
    upload_info: Dict[str, Any],
    destination_path: str,
    expected_size: int,
) -> None:
    record = {
        "upload_id": upload_id,
        "filename": upload_info.get("filename"),
        "destination_path": destination_path,
        "total_size": expected_size,
        "owner": upload_info.get("owner"),
        "completed_at": time.time(),
    }
    info_path = _upload_completion_record_path(upload_id)
    tmp_path = info_path.with_suffix(info_path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(record, f)
    os.replace(tmp_path, info_path)


def _load_upload_completion_record(upload_id: str) -> Optional[Dict[str, Any]]:
    info_path = _upload_completion_record_path(upload_id)
    if not info_path.is_file():
        # Written before the records moved into their own directory.
        info_path = _legacy_upload_completion_record_path(upload_id)
    if not info_path.is_file():
        return None
    try:
        with open(info_path, "r", encoding="utf-8") as f:
            record = json.load(f)
        return record if isinstance(record, dict) else None
    except Exception as exc:
        logger.warning(f"Failed to read completion record for {upload_id}: {exc}")
        return None


def _try_idempotent_complete_from_record(
    upload_id: str,
    auth_user: AuthUser,
) -> Optional[JSONResponse]:
    """Return success when complete is retried after session JSON was already cleaned up."""
    record = _load_upload_completion_record(upload_id)
    if not record:
        return None

    owner = record.get("owner")
    if owner and owner != auth_user.uid:
        raise AppErrors.USER_FORBIDDEN()

    destination_path = str(record.get("destination_path") or "")
    expected_size = int(record.get("total_size") or 0)
    if not _destination_matches_expected(destination_path, expected_size):
        return None

    upload_info = {
        "filename": record.get("filename") or "file",
        "original_filename": record.get("original_filename") or record.get("filename") or "file",
    }
    try:
        _upsert_chunked_upload_metadata(
            upload_info, destination_path, expected_size, auth_user
        )
    except Exception as exc:
        logger.warning(
            f"Idempotent complete metadata upsert failed for {upload_id}: {exc}"
        )
        raise AppErrors.SERVER_INTERNAL_ERROR(_METADATA_RETRY_MESSAGE)
    return _chunked_upload_success_response(upload_info, destination_path, duplicate=True)


def _mark_metadata_pending(upload_id: str, upload_info: Dict[str, Any]) -> None:
    upload_info["status"] = "merged_pending_metadata"
    upload_info.pop("merging_started_at", None)
    upload_info.setdefault("metadata_pending_at", time.time())
    _touch_upload_activity(upload_info)
    _save_chunk_upload_info(upload_id, upload_info)


def _auth_user_for_upload_owner(upload_info: Dict[str, Any]) -> Optional[AuthUser]:
    owner = str(upload_info.get("owner") or "")
    if not owner:
        return None
    return AuthUser(uid=owner, email=None, is_anonymous=False, provider_id="system")


def _try_recover_merged_pending_metadata(upload_id: str, upload_info: Dict[str, Any]) -> bool:
    """Retry Firestore metadata for an assembled file. Returns True when session is finalized."""
    if str(upload_info.get("status") or "") != "merged_pending_metadata":
        return False
    auth_user = _auth_user_for_upload_owner(upload_info)
    if auth_user is None:
        return False

    destination_path = str(upload_info.get("destination_path") or "")
    expected_size = int(upload_info.get("total_size") or 0)
    if not _destination_matches_expected(destination_path, expected_size):
        return False

    chunk_dir = CHUNK_TEMP_DIR / upload_id
    try:
        finalized = _finalize_assembled_upload(
            upload_id,
            upload_info,
            destination_path,
            expected_size,
            chunk_dir,
            auth_user,
            duplicate=True,
        )
        return finalized is not None
    except HTTPException:
        return False


def _abandon_merged_pending_session(upload_id: str, upload_info: Dict[str, Any]) -> None:
    destination_path = str(upload_info.get("destination_path") or "")
    expected_size = int(upload_info.get("total_size") or 0)
    if _destination_matches_expected(destination_path, expected_size):
        try:
            os.remove(destination_path)
        except OSError as exc:
            logger.warning(
                f"Failed to remove abandoned merged file {destination_path}: {exc}"
            )
    chunk_dir = CHUNK_TEMP_DIR / upload_id
    _cleanup_chunked_upload_artifacts(upload_id, chunk_dir)
    for record_path in (_upload_completion_record_path(upload_id),
                        _legacy_upload_completion_record_path(upload_id)):
        try:
            record_path.unlink(missing_ok=True)
        except OSError:
            pass
    logger.warning(f"Abandoned merged_pending_metadata session {upload_id}")


def _process_merged_pending_metadata_sessions(now: Optional[float] = None) -> int:
    """Retry or abandon sessions stuck after merge with failed metadata registration."""
    if not CHUNK_TEMP_DIR.exists():
        return 0

    current = now if now is not None else time.time()
    recovered = 0
    for info_path in list(CHUNK_TEMP_DIR.glob("*.json")):
        if info_path.name.startswith("zarr_batch_") or info_path.name.endswith(".done.json"):
            continue
        try:
            with open(info_path, "r", encoding="utf-8") as f:
                info = json.load(f)
            if str(info.get("status") or "") != "merged_pending_metadata":
                continue

            upload_id = str(info.get("upload_id") or info_path.stem)
            info["uploaded_chunks"] = set(info.get("uploaded_chunks") or [])

            retry_at = float(info.get("metadata_retry_at") or 0)
            if retry_at > 0 and (current - retry_at) < MERGED_PENDING_METADATA_RETRY_INTERVAL_SECONDS:
                continue

            info["metadata_retry_at"] = current
            with _chunk_session_lock(upload_id):
                fresh = _load_chunk_upload_info(upload_id)
                if str(fresh.get("status") or "") != "merged_pending_metadata":
                    continue
                fresh["metadata_retry_at"] = current
                _save_chunk_upload_info(upload_id, fresh)
                info = fresh

            if _try_recover_merged_pending_metadata(upload_id, info):
                recovered += 1
                continue

            pending_since = float(
                info.get("metadata_pending_at")
                or info.get("last_activity_at")
                or info.get("created_at")
                or 0
            )
            if pending_since > 0 and (current - pending_since) >= MERGED_PENDING_METADATA_ABANDON_SECONDS:
                _abandon_merged_pending_session(upload_id, info)
        except Exception as exc:
            logger.warning(f"Failed to process merged_pending_metadata {info_path}: {exc}")
    return recovered


def _handle_metadata_upsert_failure(
    upload_id: str,
    upload_info: Dict[str, Any],
    meta_err: Exception,
    log_context: str,
) -> None:
    logger.error(f"Metadata upsert failed {log_context}: {meta_err}", exc_info=True)
    _mark_metadata_pending(upload_id, upload_info)
    raise AppErrors.SERVER_INTERNAL_ERROR(_METADATA_RETRY_MESSAGE)


def _reset_merge_session(upload_id: str) -> None:
    with _chunk_session_lock(upload_id):
        upload_info = _load_chunk_upload_info(upload_id)
        upload_info["status"] = "uploading"
        upload_info.pop("merging_started_at", None)
        _save_chunk_upload_info(upload_id, upload_info)


def _finalize_assembled_upload(
    upload_id: str,
    upload_info: Dict[str, Any],
    destination_path: str,
    expected_size: int,
    chunk_dir: Path,
    auth_user: AuthUser,
    *,
    duplicate: bool = False,
) -> Optional[JSONResponse]:
    if not _destination_matches_expected(destination_path, expected_size):
        return None

    _remove_chunk_dir_if_present(chunk_dir)

    try:
        _upsert_chunked_upload_metadata(upload_info, destination_path, expected_size, auth_user)
    except Exception as meta_err:
        _handle_metadata_upsert_failure(
            upload_id,
            upload_info,
            meta_err,
            f"for completed upload {upload_id}",
        )

    _write_upload_completion_record(upload_id, upload_info, destination_path, expected_size)
    _remove_chunk_upload_session(upload_id)
    return _chunked_upload_success_response(upload_info, destination_path, duplicate=duplicate)


def _remove_chunk_dir_if_present(chunk_dir: Path) -> None:
    try:
        if chunk_dir.is_dir():
            shutil.rmtree(chunk_dir)
    except Exception as exc:
        logger.warning(f"Failed to remove chunk dir {chunk_dir}: {exc}")


def _remove_chunk_upload_session(upload_id: str) -> None:
    try:
        (CHUNK_TEMP_DIR / f"{upload_id}.json").unlink(missing_ok=True)
    except Exception as exc:
        logger.warning(f"Failed to remove upload session {upload_id}: {exc}")
    finally:
        _release_chunk_upload_lock(upload_id)
        _remove_merge_lock_file(upload_id)
        try:
            _chunk_session_lock_path(upload_id).unlink(missing_ok=True)
        except OSError:
            pass


def _cleanup_chunked_upload_artifacts(upload_id: str, chunk_dir: Path) -> None:
    _remove_chunk_dir_if_present(chunk_dir)
    _remove_chunk_upload_session(upload_id)


def _save_chunk_upload_info(upload_id: str, upload_info: Dict[str, Any]):
    upload_info_path = CHUNK_TEMP_DIR / f"{upload_id}.json"
    upload_info_serializable = upload_info.copy()
    uploaded = upload_info_serializable.get("uploaded_chunks")
    if isinstance(uploaded, set):
        upload_info_serializable["uploaded_chunks"] = list(uploaded)
    tmp_path = upload_info_path.with_suffix(upload_info_path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(upload_info_serializable, f)
    os.replace(tmp_path, upload_info_path)


def _purge_zarr_batch_artifacts(session: Dict[str, Any]):
    """Remove on-disk partial zarr files for a batch session (no auth — internal cleanup)."""
    try:
        destination_folder = resolve_path(str(session.get("path") or ""))
    except Exception:
        destination_folder = None
    if not destination_folder:
        return

    if not str(session.get("owner") or ""):
        return

    if bool(session.get("overwrite")):
        _remove_zarr_manifest_files_from_disk(session)
        return

    for root in _zarr_roots_for_session(session):
        abs_root = os.path.join(destination_folder, root.replace("/", os.sep))
        try:
            if os.path.isdir(abs_root):
                shutil.rmtree(abs_root, ignore_errors=True)
            elif os.path.isfile(abs_root):
                os.remove(abs_root)
        except Exception as e:
            logger.warning(f"Failed to remove stale zarr root {abs_root}: {e}")


def cleanup_stale_upload_sessions(max_age_seconds: int = STALE_UPLOAD_SESSION_MAX_AGE_SECONDS) -> int:
    """Delete chunked/zarr upload sessions older than max_age_seconds."""
    _process_merged_pending_metadata_sessions()

    if not CHUNK_TEMP_DIR.exists():
        return 0

    now = time.time()
    cleaned = 0
    completion_records = list(COMPLETED_UPLOADS_DIR.glob("*.done.json"))
    # Sweep the pre-move location too until everything there has aged out.
    completion_records += list(CHUNK_TEMP_DIR.glob("*.done.json"))
    for info_path in completion_records:
        try:
            with open(info_path, "r", encoding="utf-8") as f:
                record = json.load(f)
            completed_at = float(record.get("completed_at") or 0)
            if completed_at <= 0 or (now - completed_at) < max_age_seconds:
                continue
            info_path.unlink(missing_ok=True)
            cleaned += 1
        except Exception as exc:
            logger.warning(f"Failed to cleanup completion record {info_path}: {exc}")

    for info_path in list(CHUNK_TEMP_DIR.glob("*.json")):
        try:
            with open(info_path, 'r') as f:
                info = json.load(f)
            last_activity = float(info.get("last_activity_at") or info.get("created_at") or 0)
            total_size = int(info.get("total_size") or 0)
            idle_limit = _stale_session_max_idle_seconds(total_size) if total_size > 0 else max_age_seconds
            if last_activity <= 0 or (now - last_activity) < idle_limit:
                continue

            name = info_path.name
            if name.startswith("zarr_batch_"):
                upload_id = name[len("zarr_batch_"):-len(".json")]
                manifest = info.get("manifest_sizes") or {}
                restored = info.get("restored_paths") or []
                if (
                    isinstance(manifest, dict)
                    and manifest
                    and isinstance(restored, list)
                    and len(restored) >= len(manifest)
                ):
                    pending_since = float(info.get("last_activity_at") or info.get("created_at") or 0)
                    if pending_since > 0 and (now - pending_since) < MERGED_PENDING_METADATA_ABANDON_SECONDS:
                        continue
                if isinstance(info, dict):
                    _purge_zarr_batch_artifacts(info)
                _release_zarr_batch_upload_locks(upload_id)
                try:
                    _zarr_session_lock_path(upload_id).unlink(missing_ok=True)
                except OSError:
                    pass
            else:
                upload_id = str(info.get("upload_id") or info_path.stem)
                session_status = str(info.get("status") or "")
                if session_status == "merged_pending_metadata":
                    continue
                if session_status == "merging":
                    merging_started = float(info.get("merging_started_at") or 0)
                    if merging_started > 0:
                        merge_limit = _stale_merging_max_age_seconds(total_size)
                        if (now - merging_started) < merge_limit:
                            continue
                    elif _merge_in_progress_for_upload(upload_id):
                        continue
                if not name.startswith("zarr_batch_"):
                    dest = str(info.get("destination_path") or "")
                    _remove_staged_upload_file(dest)
                chunk_dir = CHUNK_TEMP_DIR / upload_id
                if chunk_dir.is_dir():
                    shutil.rmtree(chunk_dir, ignore_errors=True)
                _release_chunk_upload_lock(upload_id)
                _remove_merge_lock_file(upload_id)
                try:
                    _chunk_session_lock_path(upload_id).unlink(missing_ok=True)
                except OSError:
                    pass

            info_path.unlink(missing_ok=True)
            cleaned += 1
        except Exception as e:
            logger.warning(f"Failed to cleanup stale upload session {info_path}: {e}")

    return cleaned


def start_upload_session_cleanup_scheduler():
    """Periodically purge abandoned chunked/zarr upload sessions."""
    def run_cleanup():
        cleanup_stale_upload_sessions()

    schedule.every().hour.do(run_cleanup)

    def run_scheduler():
        while True:
            schedule.run_pending()
            time.sleep(60)

    cleanup_thread = threading.Thread(target=run_scheduler, daemon=True)
    cleanup_thread.start()


def uniquify_path(directory: str, filename: str) -> str:
    """If path exists, append (1), (2), ... before extension to make it unique."""
    name, ext = os.path.splitext(filename)
    candidate = filename
    counter = 1
    while os.path.exists(os.path.join(directory, candidate)):
        candidate = f"{name}({counter}){ext}"
        counter += 1
    return candidate


def uniquify_path_keep_both(directory: str, filename: str) -> str:
    """Keep-both style: name(1).ext, name(2).ext, ..."""
    name, ext = os.path.splitext(filename)
    _keep_both_match = re.match(r"^(.+?)\((\d+)\)$", name)
    base_name = _keep_both_match.group(1) if _keep_both_match else name
    try:
        existing = set(os.listdir(directory))
    except OSError:
        existing = set()
    used: set = set()
    if (base_name + ext) in existing or base_name in existing:
        used.add(0)
    pat = re.compile(r"^" + re.escape(base_name) + r"\((\d+)\)" + (re.escape(ext) if ext else "") + r"$")
    for item in existing:
        m = pat.match(item)
        if m:
            used.add(int(m.group(1)))
    counter = 1
    while counter in used:
        counter += 1
    return f"{base_name}({counter}){ext}"


def _normalize_batch_relative_path(relative_path: str) -> str:
    rel = (relative_path or "").replace("\\", "/").strip("/")
    if not rel:
        raise AppErrors.PARAMS_ERROR("Batch relativePath cannot be empty.")
    parts = [part for part in rel.split("/") if part]
    if any(part in (".", "..") for part in parts):
        raise AppErrors.PARAMS_ERROR("Invalid batch relativePath.")
    return "/".join(parts)


def _zarr_root_from_relative_path(relative_path: str) -> Optional[str]:
    parts = _normalize_batch_relative_path(relative_path).split("/")
    for idx, part in enumerate(parts):
        if part.lower().endswith(".zarr"):
            return "/".join(parts[:idx + 1])
    return None


def _zarr_batch_info_path(upload_id: str) -> Path:
    uid = str(upload_id or "")
    if not re.fullmatch(r"[a-f0-9]{32}", uid):
        raise AppErrors.PARAMS_ERROR("Invalid zarr batch upload_id.")
    return CHUNK_TEMP_DIR / f"zarr_batch_{uid}.json"


def _get_zarr_batch_upload_lock(upload_id: str, batch_index: int) -> threading.Lock:
    uid = str(upload_id or "")
    _zarr_batch_info_path(uid)
    key = f"{uid}:{int(batch_index)}"
    with _ZARR_BATCH_UPLOAD_LOCKS_GUARD:
        lock = _ZARR_BATCH_UPLOAD_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _ZARR_BATCH_UPLOAD_LOCKS[key] = lock
        return lock


def _release_zarr_batch_upload_locks(upload_id: str):
    uid = str(upload_id or "")
    prefix = f"{uid}:"
    with _ZARR_BATCH_UPLOAD_LOCKS_GUARD:
        for key in list(_ZARR_BATCH_UPLOAD_LOCKS):
            if key.startswith(prefix):
                _ZARR_BATCH_UPLOAD_LOCKS.pop(key, None)


def _rewrite_zarr_root(root: str, folder_rewrite: Dict[str, str]) -> str:
    parts = root.split("/")
    if parts and parts[0] in folder_rewrite:
        parts[0] = folder_rewrite[parts[0]]
        return "/".join(parts)
    return root


def _assert_no_active_zarr_upload_for_roots(
    destination_folder: str,
    zarr_roots: Set[str],
    folder_rewrite: Optional[Dict[str, str]] = None,
) -> None:
    rewrite = folder_rewrite if isinstance(folder_rewrite, dict) else {}
    for root in sorted(zarr_roots):
        rewritten = _rewrite_zarr_root(root, rewrite)
        abs_root = os.path.normpath(
            os.path.join(destination_folder, rewritten.replace("/", os.sep))
        )
        if is_active_zarr_upload_destination(abs_root):
            raise AppErrors.RESOURCE_CONFLICT(
                f"An active zarr batch upload already targets: {rewritten}"
            )


def _zarr_roots_for_session(session: Dict[str, Any]) -> Set[str]:
    """Return destination-relative .zarr root paths for this upload (with keep-both rewrite)."""
    roots: Set[str] = set()
    folder_rewrite = session.get("folder_rewrite") if isinstance(session.get("folder_rewrite"), dict) else {}
    for item in session.get("files") or []:
        if not isinstance(item, dict):
            continue
        rel = str(item.get("relativePath") or item.get("relative_path") or "")
        root = _zarr_root_from_relative_path(rel)
        if not root:
            continue
        parts = root.split("/")
        if parts and parts[0] in folder_rewrite:
            parts[0] = folder_rewrite[parts[0]]
            root = "/".join(parts)
        roots.add(root)
    return roots


def _zarr_manifest_file_on_disk(
    session: Dict[str, Any],
    rel: str,
    expected_size: int,
) -> bool:
    folder_rewrite = session.get("folder_rewrite") if isinstance(session.get("folder_rewrite"), dict) else {}
    destination_path, _, _ = _resolve_zarr_batch_destination(
        session["path"],
        rel,
        folder_rewrite,
    )
    if not os.path.isfile(destination_path):
        return False
    try:
        return os.path.getsize(destination_path) == int(expected_size)
    except OSError:
        return False


def _load_zarr_batch_session(upload_id: str) -> Dict[str, Any]:
    info_path = _zarr_batch_info_path(upload_id)
    if not info_path.exists():
        raise AppErrors.RESOURCE_NOT_FOUND()
    with open(info_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_zarr_batch_session(session: Dict[str, Any]):
    upload_id = session.get("upload_id")
    if not upload_id:
        raise AppErrors.PARAMS_ERROR("Missing zarr batch upload_id.")
    session["last_activity_at"] = time.time()
    info_path = _zarr_batch_info_path(upload_id)
    tmp_path = info_path.with_suffix(info_path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(session, f)
    os.replace(tmp_path, info_path)


def assert_zarr_batch_root_writable(auth_user: AuthUser, upload_path: str) -> None:
    """Read + write ACL for a zarr batch session, checked ONCE per request.

    This used to live inside :func:`_resolve_zarr_batch_destination`, which runs
    per file. Both guards walk Firestore — ``assert_can_write_path`` climbs every
    ancestor looking for a share root, one blocking round trip per level — so a
    zarr store with a few thousand chunks issued a few thousand serial Firestore
    reads on the event loop and blocked the whole (single-worker) service.

    Hoisting is sound because ACL is inherited downward: every batch destination
    is a descendant of ``upload_path``, so permission on the root is permission
    on all of them. The per-file traversal guard stays where it is — that is a
    string check, not a lookup, and it is what keeps a batch inside the root.
    """
    if not validate_user_access_to_path(auth_user, upload_path):
        raise AppErrors.USER_FORBIDDEN()
    assert_can_write_path(auth_user, upload_path)


def _resolve_zarr_batch_destination(
    upload_path: str,
    relative_path: str,
    folder_rewrite: Optional[Dict[str, str]] = None,
) -> tuple[str, str, str]:
    """Pure path resolution. Callers must have run assert_zarr_batch_root_writable."""
    rel = _normalize_batch_relative_path(relative_path)
    parts = rel.split("/")
    if folder_rewrite and parts and parts[0] in folder_rewrite:
        parts[0] = folder_rewrite[parts[0]]
        rel = "/".join(parts)

    dest_rel = os.path.normpath(os.path.join(upload_path, rel)).replace("\\", "/")
    if dest_rel.startswith("..") or "/.." in dest_rel or dest_rel.startswith("/"):
        raise AppErrors.PARAMS_ERROR("Invalid batch destination path.")

    dest_parent_rel = os.path.dirname(dest_rel)
    dest_dir_abs = resolve_path(dest_parent_rel)
    os.makedirs(dest_dir_abs, exist_ok=True)
    safe_name = sanitize_filename(os.path.basename(rel))
    destination_path = os.path.join(dest_dir_abs, safe_name)
    final_rel = normalize_rel_path(os.path.join(dest_parent_rel, safe_name))
    return destination_path, final_rel, safe_name


def _parse_zarr_batch_body(body: bytes) -> tuple[Dict[str, Any], memoryview]:
    if len(body) < 8:
        raise AppErrors.PARAMS_ERROR("Zarr batch body is too small.")
    header_len = int.from_bytes(body[:8], byteorder="little", signed=False)
    if header_len <= 0 or header_len > MAX_ZARR_BATCH_HEADER_BYTES:
        raise AppErrors.PARAMS_ERROR("Invalid zarr batch header length.")
    if len(body) < 8 + header_len:
        raise AppErrors.PARAMS_ERROR("Zarr batch body is truncated.")
    try:
        header = json.loads(body[8:8 + header_len].decode("utf-8"))
    except Exception:
        raise AppErrors.PARAMS_ERROR("Invalid zarr batch header JSON.")
    files = header.get("files")
    if not isinstance(files, list):
        raise AppErrors.PARAMS_ERROR("Zarr batch header must contain files.")
    if len(files) > MAX_ZARR_BATCH_FILES:
        raise AppErrors.PARAMS_ERROR("Too many files in zarr batch.")
    return header, memoryview(body)[8 + header_len:]


async def upload_files(
    path: str,
    files: List[UploadFile],
    overwrite: bool,
    relative_paths: Optional[str],
    keep_both: bool,
    auth_user: AuthUser
):
    """Upload one or more files. keep_both: Google Drive style - uniquify with ' (1)' instead of overwriting."""
    if len(files) > MAX_FILES_PER_UPLOAD:
        raise AppErrors.PARAMS_ERROR(
            f"Too many files. Maximum {MAX_FILES_PER_UPLOAD} files per upload."
        )
    if not _UPLOAD_SEMAPHORE.acquire(blocking=False):
        raise AppErrors.REQUEST_QUOTA_EXCEEDED()
    try:
        use_keep_both = keep_both
        rel_paths_list: Optional[List[str]] = None
        if relative_paths and relative_paths.strip():
            try:
                rel_paths_list = json.loads(relative_paths)
                if not isinstance(rel_paths_list, list) or len(rel_paths_list) != len(files):
                    rel_paths_list = None
            except Exception:
                rel_paths_list = None

        if path == 'classifiers':
            from app.config.path_config import SERVICE_ROOT_DIR
            destination_folder = os.path.join(SERVICE_ROOT_DIR, 'storage', 'classifiers')
        elif path == 'models':
            from app.config.path_config import SERVICE_ROOT_DIR
            destination_folder = os.path.join(SERVICE_ROOT_DIR, 'storage', 'models')
        else:
            await assert_writable_async(auth_user, path)
            destination_folder = resolve_path(path)

        if not os.path.isdir(destination_folder):
            if path in ['classifiers', 'models']:
                os.makedirs(destination_folder, exist_ok=True)
            else:
                raise AppErrors.PARAMS_ERROR("Destination path is not a valid directory.")

        incoming_total = 0
        for f in files:
            try:
                pos = f.file.tell()
                f.file.seek(0, os.SEEK_END)
                end_pos = f.file.tell()
                f.file.seek(pos, os.SEEK_SET)
                if end_pos >= 0:
                    incoming_total += max(0, end_pos - pos)
            except Exception:
                pass

        ensure_quota_or_raise(auth_user, incoming_total)

        # When keep_both: uniquify top-level folders when target exists (test -> test (1), test (1) -> test (2))
        folder_rewrite: Dict[str, str] = {}
        if use_keep_both and rel_paths_list and path not in ['classifiers', 'models']:
            dest_abs = resolve_path(path)
            for rp in rel_paths_list:
                top = (rp.replace("\\", "/").strip("/").split("/")[0:1] or [""])[0]
                if not top or top in folder_rewrite:
                    continue
                full = os.path.join(dest_abs, top)
                if os.path.exists(full):
                    folder_rewrite[top] = uniquify_path_keep_both(dest_abs, top)

        def rewrite_rel(r: str) -> str:
            if not folder_rewrite:
                return r
            parts = r.replace("\\", "/").strip("/").split("/")
            if parts and parts[0] in folder_rewrite:
                parts[0] = folder_rewrite[parts[0]]
                return "/".join(parts)
            return r

        successful_uploads = 0
        uploaded_files = []
        files_repo = FilesRepo()
        # Read the active upload sessions once for the whole request instead of
        # re-globbing and re-parsing them for each of up to MAX_FILES_PER_UPLOAD
        # destinations.
        upload_exact, upload_prefixes = active_upload_destination_roots()
        for idx, file in enumerate(files):
            if path in ['classifiers', 'models']:
                original_name = file.filename or "unknown"
                file_ext = os.path.splitext(original_name)[1]
                safe_name = f"{uuid.uuid4()}{file_ext}"
                dest_dir = destination_folder
            elif rel_paths_list and idx < len(rel_paths_list):
                rel = rewrite_rel(rel_paths_list[idx].replace("\\", "/").strip("/"))
                if not rel:
                    rel = sanitize_filename(file.filename)
                dest_rel = os.path.normpath(os.path.join(path, rel)).replace("\\", "/")
                if dest_rel.startswith("..") or "/.." in dest_rel or dest_rel.startswith("/"):
                    raise AppErrors.PARAMS_ERROR("Invalid relative path")
                await assert_writable_async(auth_user, os.path.dirname(dest_rel))
                dest_dir_abs = resolve_path(os.path.dirname(dest_rel))
                os.makedirs(dest_dir_abs, exist_ok=True)
                base_name = sanitize_filename(os.path.basename(rel))
                uniq_fn = uniquify_path_keep_both if use_keep_both else uniquify_path
                safe_name = base_name if overwrite else uniq_fn(dest_dir_abs, base_name)
                dest_dir = dest_dir_abs
            else:
                safe_name = sanitize_filename(file.filename)
                if not overwrite:
                    safe_name = (uniquify_path_keep_both if use_keep_both else uniquify_path)(destination_folder, safe_name)
                dest_dir = destination_folder

            destination_path = os.path.join(dest_dir, safe_name)

            if matches_upload_destination_roots(
                destination_path, upload_exact, upload_prefixes
            ):
                raise AppErrors.RESOURCE_CONFLICT(
                    "Another upload is already in progress for this destination."
                )
            
            try:
                # Before writing each file, re-check quota with an approximate size if we can detect it
                try:
                    cur_pos = file.file.tell()
                    file.file.seek(0, os.SEEK_END)
                    end_pos = file.file.tell()
                    file.file.seek(cur_pos, os.SEEK_SET)
                    file_size_est = max(0, end_pos - cur_pos)
                except Exception:
                    file_size_est = 0
                ensure_quota_or_raise(auth_user, file_size_est)

                def _write_upload(src=file.file, dest=destination_path) -> None:
                    with open(dest, "wb") as buffer:
                        shutil.copyfileobj(src, buffer)

                # Off the event loop: this copies the whole uploaded file, so it
                # runs for as long as the file is big — measured at ~120ms per
                # 200MB, and a slide is far larger than that. Inline, every other
                # request in the service waits for the copy to finish.
                await asyncio.to_thread(_write_upload)
                successful_uploads += 1
                
                try:
                    if rel_paths_list and idx < len(rel_paths_list):
                        rewritten = rewrite_rel(rel_paths_list[idx].replace("\\", "/").strip("/"))
                        rel_dir = os.path.dirname(rewritten)
                        rel_path = normalize_rel_path(os.path.join(path, rel_dir, safe_name) if rel_dir else os.path.join(path, safe_name))
                    else:
                        rel_path = normalize_rel_path(os.path.join(path, safe_name))
                    
                    # Track uploaded file info
                    uploaded_files.append({
                        'original_name': file.filename,
                        'actual_name': safe_name,
                        'path': rel_path
                    })
                    file_id = build_file_id(rel_path)
                    
                    # For classifiers, also save the original filename
                    file_data = {
                        'ownerId': auth_user.uid,
                        'fileName': safe_name,
                        'localPath': rel_path,
                        'fileSize': file_size_est,
                        'isPublic': False,
                        'sharedWith': [],
                    }
                    
                    # If this is a classifier upload, save the original filename
                    if path == 'classifiers':
                        file_data['originalFileName'] = file.filename
                    
                    files_repo.create_if_absent(file_id, file_data)
                except Exception as _e:
                    logger.warning(f"Failed to upsert file doc for {safe_name}: {_e}")
            finally:
                try:
                    file.file.close()
                except Exception:
                    pass

        return JSONResponse(content={
            "success": True,
            "message": f"{successful_uploads} file(s) uploaded successfully.",
            "uploaded_files": uploaded_files  # Include file mapping info
        })
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error uploading files to '{path}': {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()
    finally:
        _UPLOAD_SEMAPHORE.release()


async def upload_manifest(
    payload: Dict[str, Any],
    auth_user: AuthUser,
):
    """Initialize a directory-format Zarr batch upload."""
    upload_type = payload.get("upload_type")
    if upload_type != "zarr-batch":
        raise AppErrors.PARAMS_ERROR("Unsupported manifest upload_type.")

    path = normalize_rel_path(str(payload.get("path") or ""))
    overwrite = bool(payload.get("overwrite", False))
    keep_both = bool(payload.get("keep_both", False))
    files = payload.get("files")
    if not isinstance(files, list) or not files:
        raise AppErrors.PARAMS_ERROR("Manifest files are required.")

    await assert_writable_async(auth_user, path)
    destination_folder = resolve_path(path)
    if not os.path.isdir(destination_folder):
        raise AppErrors.PARAMS_ERROR("Destination path is not a valid directory.")

    normalized_files: List[Dict[str, Any]] = []
    total_size = 0
    zarr_roots: Set[str] = set()
    seen_paths: Set[str] = set()
    for item in files:
        if not isinstance(item, dict):
            raise AppErrors.PARAMS_ERROR("Manifest file entries must be objects.")
        rel = _normalize_batch_relative_path(str(item.get("relativePath") or item.get("relative_path") or ""))
        if rel in seen_paths:
            raise AppErrors.PARAMS_ERROR(f"Duplicate manifest relativePath: {rel}")
        seen_paths.add(rel)
        root = _zarr_root_from_relative_path(rel)
        if not root:
            raise AppErrors.PARAMS_ERROR("Zarr batch files must be inside a .zarr folder.")
        try:
            size = int(item.get("size", 0) or 0)
        except (TypeError, ValueError):
            raise AppErrors.PARAMS_ERROR("Invalid manifest file size.")
        if size < 0:
            raise AppErrors.PARAMS_ERROR("Invalid manifest file size.")
        total_size += size
        zarr_roots.add(root)
        normalized_files.append({"relativePath": rel, "size": size})

    batch_cfg = payload.get("batch") if isinstance(payload.get("batch"), dict) else {}
    max_batch_bytes = int(batch_cfg.get("max_batch_bytes") or MAX_ZARR_BATCH_BYTES)
    if max_batch_bytes <= 0:
        max_batch_bytes = MAX_ZARR_BATCH_BYTES
    max_batch_bytes = min(max_batch_bytes, MAX_ZARR_BATCH_BYTES)
    oversized_bytes = sum(
        item["size"] for item in normalized_files if item["size"] > max_batch_bytes
    )
    batchable_bytes = max(0, total_size - oversized_bytes)
    _ensure_chunk_upload_quota_or_raise(auth_user, batchable_bytes)

    folder_rewrite: Dict[str, str] = {}
    if keep_both:
        for root in sorted(zarr_roots):
            top = root.split("/")[0]
            if top and top not in folder_rewrite and os.path.exists(os.path.join(destination_folder, top)):
                folder_rewrite[top] = uniquify_path_keep_both(destination_folder, top)
    elif not overwrite:
        for root in sorted(zarr_roots):
            if os.path.exists(os.path.join(destination_folder, root)):
                raise AppErrors.RESOURCE_CONFLICT(f"Destination already exists: {root}")

    _assert_no_active_zarr_upload_for_roots(destination_folder, zarr_roots, folder_rewrite)

    upload_id = hashlib.md5(f"zarr_batch_{auth_user.uid}_{time.time()}_{uuid.uuid4()}".encode()).hexdigest()
    max_batch_files = int(batch_cfg.get("max_batch_files") or MAX_ZARR_BATCH_FILES)
    if max_batch_files <= 0:
        max_batch_files = MAX_ZARR_BATCH_FILES
    session = {
        "upload_id": upload_id,
        "upload_type": "zarr-batch",
        "owner": auth_user.uid,
        "path": path,
        "overwrite": overwrite,
        "keep_both": keep_both,
        "total_size": total_size,
        "oversized_bytes": oversized_bytes,
        "max_batch_bytes": max_batch_bytes,
        "max_batch_files": max_batch_files,
        "folder_rewrite": folder_rewrite,
        "files": normalized_files,
        "manifest_sizes": {item["relativePath"]: item["size"] for item in normalized_files},
        "uploaded_batches": [],
        "restored_files": [],
        "restored_paths": [],
        "created_at": time.time(),
        "last_activity_at": time.time(),
    }
    _save_zarr_batch_session(session)

    return JSONResponse(content={
        "success": True,
        "upload_id": upload_id,
        "total_size": total_size,
        "file_count": len(normalized_files),
        "folder_rewrite": folder_rewrite,
    })


async def upload_zarr_batch(request: Request, auth_user: AuthUser):
    """Receive one zarr batch blob and restore files to the original .zarr tree."""
    if not _ZARR_BATCH_UPLOAD_SEMAPHORE.acquire(blocking=False):
        raise AppErrors.REQUEST_QUOTA_EXCEEDED()
    try:
        body = await request.body()
        if len(body) > MAX_ZARR_BATCH_BYTES + MAX_ZARR_BATCH_HEADER_BYTES:
            raise AppErrors.PARAMS_ERROR("Zarr batch body is too large.")

        header, payload = _parse_zarr_batch_body(body)
        upload_id = (
            request.headers.get("X-Upload-Id")
            or header.get("uploadId")
            or header.get("upload_id")
        )
        if not upload_id:
            raise AppErrors.PARAMS_ERROR("Missing zarr batch upload_id.")

        try:
            batch_index = int(header.get("batchIndex", request.headers.get("X-Batch-Index", -1)))
            total_batches = int(header.get("totalBatches", request.headers.get("X-Total-Batches", 0)))
        except (TypeError, ValueError):
            raise AppErrors.PARAMS_ERROR("Invalid zarr batch index.")
        if batch_index < 0 or total_batches <= 0 or batch_index >= total_batches:
            raise AppErrors.PARAMS_ERROR("Invalid zarr batch index.")

        # The whole critical section runs in ONE worker thread.
        #
        # Both of these locks block the thread that acquires them: the batch
        # lock is a threading.Lock, and the session lock is a cross-process
        # FileLock that waits up to FILE_LOCK_TIMEOUT_SEC. Taken here on the
        # event loop, a sibling request holding either one froze the entire
        # service for the length of the hold. Worse, the awaits that used to sit
        # inside meant the batch lock was held across a suspension: a second
        # request for the same (upload_id, batch_index) then blocked the loop on
        # acquire(), and the holder needed that same loop to resume — a deadlock
        # nothing could clear.
        def _locked():
            with _get_zarr_batch_upload_lock(str(upload_id), batch_index):
                with _zarr_session_lock(str(upload_id)):
                    session = _load_zarr_batch_session(str(upload_id))
                    if session.get("owner") != auth_user.uid:
                        raise AppErrors.USER_FORBIDDEN()
                    uploaded_batches = set(int(x) for x in session.get("uploaded_batches", []))
                    if batch_index in uploaded_batches:
                        return JSONResponse(content={
                            "success": True,
                            "upload_id": upload_id,
                            "batch_index": batch_index,
                            "restored_files": 0,
                            "duplicate": True,
                        })

                    # Once per request, not once per file. Both guards hit
                    # Firestore.
                    assert_zarr_batch_root_writable(auth_user, session["path"])

                    max_batch_bytes = min(int(session.get("max_batch_bytes") or MAX_ZARR_BATCH_BYTES), MAX_ZARR_BATCH_BYTES)
                    if len(payload) > max_batch_bytes:
                        raise AppErrors.PARAMS_ERROR("Zarr batch payload is too large.")
                    max_batch_files = min(int(session.get("max_batch_files") or MAX_ZARR_BATCH_FILES), MAX_ZARR_BATCH_FILES)
                    if len(header.get("files") or []) > max_batch_files:
                        raise AppErrors.PARAMS_ERROR("Too many files in zarr batch.")

                    manifest_sizes = session.get("manifest_sizes") if isinstance(session.get("manifest_sizes"), dict) else {}
                    restored: List[Dict[str, Any]] = []
                    batch_paths: Set[str] = set()
                    folder_rewrite = session.get("folder_rewrite") if isinstance(session.get("folder_rewrite"), dict) else {}
                    write_plan: List[tuple] = []
                    for item in header["files"]:
                        if not isinstance(item, dict):
                            raise AppErrors.PARAMS_ERROR("Invalid zarr batch file entry.")
                        rel = _normalize_batch_relative_path(str(item.get("relativePath") or ""))
                        if not _zarr_root_from_relative_path(rel):
                            raise AppErrors.PARAMS_ERROR("Zarr batch files must be inside a .zarr folder.")
                        if rel in batch_paths:
                            raise AppErrors.PARAMS_ERROR(f"Duplicate file in zarr batch: {rel}")
                        batch_paths.add(rel)
                        if rel not in manifest_sizes:
                            raise AppErrors.PARAMS_ERROR(f"Batch file was not declared in manifest: {rel}")

                        try:
                            offset = int(item.get("offset", -1))
                            length = int(item.get("length", -1))
                        except (TypeError, ValueError):
                            raise AppErrors.PARAMS_ERROR(f"Invalid payload slice for {rel}.")
                        if offset < 0 or length < 0 or offset + length > len(payload):
                            raise AppErrors.PARAMS_ERROR(f"Invalid payload slice for {rel}.")
                        if length != int(manifest_sizes.get(rel, -1)):
                            raise AppErrors.PARAMS_ERROR(f"Batch file size does not match manifest: {rel}")

                        destination_path, final_rel, safe_name = _resolve_zarr_batch_destination(
                            session["path"],
                            rel,
                            folder_rewrite,
                        )
                        if os.path.exists(destination_path) and not session.get("overwrite", False) and not session.get("keep_both", False):
                            raise AppErrors.RESOURCE_CONFLICT(f"Destination already exists: {final_rel}")

                        write_plan.append((
                            destination_path,
                            payload[offset:offset + length],
                            {
                                "original_name": os.path.basename(rel),
                                "actual_name": safe_name,
                                "path": final_rel,
                                "source_path": rel,
                                "size": length,
                            },
                        ))

                    def _write_batch() -> None:
                        for dest, body, _m in write_plan:
                            with open(dest, "wb") as f:
                                f.write(body)

                    # Up to MAX_ZARR_BATCH_FILES writes per request, on the hot
                    # path of every zarr upload.
                    _write_batch()
                    restored = [meta for _, _, meta in write_plan]

                    latest_session = _load_zarr_batch_session(str(upload_id))
                    latest_uploaded_batches = set(int(x) for x in latest_session.get("uploaded_batches", []))
                    if batch_index in latest_uploaded_batches:
                        return JSONResponse(content={
                            "success": True,
                            "upload_id": upload_id,
                            "batch_index": batch_index,
                            "restored_files": 0,
                            "duplicate": True,
                        })
                    latest_restored_paths = set(str(x) for x in latest_session.get("restored_paths", []))
                    new_restored = [item for item in restored if str(item.get("source_path") or item.get("path") or "") not in latest_restored_paths]
                    for item in new_restored:
                        source_path = str(item.get("source_path") or item.get("path") or "")
                        if source_path:
                            latest_restored_paths.add(source_path)

                    latest_uploaded_batches.add(batch_index)
                    latest_session["uploaded_batches"] = sorted(latest_uploaded_batches)
                    latest_session["total_batches"] = total_batches
                    latest_session["restored_paths"] = sorted(latest_restored_paths)
                    latest_session.setdefault("restored_files", []).extend(new_restored)
                    latest_session["last_activity_at"] = time.time()
                    _save_zarr_batch_session(latest_session)
                    uploaded_count = len(latest_uploaded_batches)

                    return JSONResponse(content={
                        "success": True,
                        "upload_id": upload_id,
                        "batch_index": batch_index,
                        "uploaded_batches": uploaded_count,
                        "total_batches": total_batches,
                        "restored_files": len(restored),
                    })

        return await asyncio.to_thread(_locked)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading zarr batch: {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()
    finally:
        _ZARR_BATCH_UPLOAD_SEMAPHORE.release()


def _complete_zarr_batch_upload(payload: Dict[str, Any], auth_user: AuthUser):
    # Sync on purpose: the whole body is a cross-process FileLock critical
    # section. FileLock.acquire blocks the calling thread for up to
    # FILE_LOCK_TIMEOUT_SEC, so on the event loop it froze the entire
    # service. Callers dispatch this with asyncio.to_thread.
    upload_id = str(payload.get("upload_id") or "")
    if not upload_id:
        raise AppErrors.PARAMS_ERROR("Missing zarr batch upload_id.")

    with _zarr_session_lock(upload_id):
        session = _load_zarr_batch_session(upload_id)
        if session.get("owner") != auth_user.uid:
            raise AppErrors.USER_FORBIDDEN()

        total_batches = int(payload.get("total_batches") or session.get("total_batches") or 0)
        uploaded_batches = set(int(x) for x in session.get("uploaded_batches", []))
        if total_batches > 0 and uploaded_batches != set(range(total_batches)):
            missing = sorted(set(range(total_batches)) - uploaded_batches)
            raise AppErrors.PARAMS_ERROR(f"Missing zarr batches: {missing}")

        manifest_sizes = session.get("manifest_sizes") if isinstance(session.get("manifest_sizes"), dict) else {}
        restored_paths = set(str(x) for x in session.get("restored_paths", []))
        missing_files = sorted(
            rel for rel in manifest_sizes.keys()
            if rel not in restored_paths
            and not _zarr_manifest_file_on_disk(session, rel, manifest_sizes[rel])
        )
        if missing_files:
            preview = missing_files[:20]
            suffix = "..." if len(missing_files) > len(preview) else ""
            raise AppErrors.PARAMS_ERROR(f"Missing zarr files: {preview}{suffix}")

        restored_files = session.get("restored_files") or []

        try:
            _zarr_batch_info_path(upload_id).unlink()
        except Exception as e:
            logger.warning(f"Failed to cleanup zarr batch session {upload_id}: {e}")
        _release_zarr_batch_upload_locks(upload_id)

    return JSONResponse(content={
        "success": True,
        "upload_id": upload_id,
        "message": "Zarr batch upload completed successfully.",
        "restored_files": len(restored_files),
    })


def _remove_zarr_manifest_files_from_disk(session: Dict[str, Any]):
    """Remove only files declared in this upload manifest (safe for overwrite)."""
    manifest_sizes = session.get("manifest_sizes") if isinstance(session.get("manifest_sizes"), dict) else {}
    folder_rewrite = session.get("folder_rewrite") if isinstance(session.get("folder_rewrite"), dict) else {}
    for rel in manifest_sizes.keys():
        try:
            destination_path, _, _ = _resolve_zarr_batch_destination(
                str(session.get("path") or ""),
                str(rel),
                folder_rewrite,
            )
            if os.path.isfile(destination_path):
                os.remove(destination_path)
        except Exception as e:
            logger.warning(f"Failed to remove partial zarr file {rel}: {e}")


async def cancel_zarr_batch_upload(upload_id: str, auth_user: AuthUser):
    """Remove partial upload artifacts and session state after a failed or cancelled batch upload."""
    uid = str(upload_id or "")
    if not uid:
        raise AppErrors.PARAMS_ERROR("Missing zarr batch upload_id.")

    def _cleanup_partial_upload() -> None:
        """Blocking: takes a file lock and rmtree's a partial .zarr store."""
        session: Optional[Dict[str, Any]] = None
        with _zarr_session_lock(uid):
            try:
                session = _load_zarr_batch_session(uid)
            except Exception:
                session = None

            if session is not None:
                if session.get("owner") != auth_user.uid:
                    raise AppErrors.USER_FORBIDDEN()
                destination_folder = resolve_path(str(session.get("path") or ""))
                if bool(session.get("overwrite")):
                    _remove_zarr_manifest_files_from_disk(session)
                else:
                    for root in _zarr_roots_for_session(session):
                        abs_root = os.path.join(destination_folder, root.replace("/", os.sep))
                        try:
                            if os.path.isdir(abs_root):
                                shutil.rmtree(abs_root, ignore_errors=True)
                            elif os.path.isfile(abs_root):
                                os.remove(abs_root)
                        except Exception as e:
                            logger.warning(f"Failed to remove partial zarr root {abs_root}: {e}")

            try:
                _zarr_batch_info_path(uid).unlink(missing_ok=True)
            except Exception as e:
                logger.warning(f"Failed to cleanup zarr batch session {uid}: {e}")

    # Deleting a partially-uploaded pyramid is tens of thousands of unlinks
    # behind a file lock — never on the event loop.
    await asyncio.to_thread(_cleanup_partial_upload)
    _release_zarr_batch_upload_locks(uid)
    try:
        _zarr_session_lock_path(uid).unlink(missing_ok=True)
    except OSError:
        pass

    return JSONResponse(content={
        "success": True,
        "upload_id": uid,
        "message": "Zarr batch upload cancelled and partial files removed.",
    })


def _assert_no_active_upload_for_destination(
    destination_path: str,
    *,
    exclude_upload_id: Optional[str] = None,
) -> None:
    dest_norm = os.path.normpath(destination_path)
    if not CHUNK_TEMP_DIR.is_dir():
        return
    for info_path in CHUNK_TEMP_DIR.glob("*.json"):
        name = info_path.name
        if name.endswith(".done.json") or name.startswith("zarr_batch_"):
            continue
        try:
            with open(info_path, "r", encoding="utf-8") as f:
                info = json.load(f)
        except Exception:
            continue
        if not isinstance(info, dict):
            continue
        status = str(info.get("status") or "uploading")
        if status not in _UPLOAD_LISTING_HIDDEN_STATUSES:
            continue
        dest = str(info.get("destination_path") or "")
        if not dest or os.path.normpath(dest) != dest_norm:
            continue
        upload_id = _chunk_session_upload_id(info_path, info)
        if exclude_upload_id and upload_id == exclude_upload_id:
            continue
        raise AppErrors.RESOURCE_CONFLICT(
            "Another upload is already in progress for this destination."
        )


def _touch_upload_session_activity(upload_id: str, auth_user: AuthUser) -> None:
    with _chunk_session_lock(upload_id):
        upload_info = _load_chunk_upload_info(upload_id)
        _assert_chunk_upload_owner(upload_info, auth_user)
        _touch_upload_activity(upload_info)
        _save_chunk_upload_info(upload_id, upload_info)


# Chunked upload related APIs


async def init_chunked_upload(
    filename: str,
    total_size: int,
    path: str,
    chunk_size: int,
    overwrite: bool,
    relative_path: Optional[str],
    keep_both: bool,
    auth_user: AuthUser
):
    """Initialize chunked upload"""
    try:
        if int(total_size) <= 0:
            raise AppErrors.PARAMS_ERROR("total_size must be positive.")
        chunk_size = _normalize_chunk_size(chunk_size)
        # Special handling for classifiers and models paths
        if path == 'classifiers':
            from app.config.path_config import SERVICE_ROOT_DIR
            destination_folder = os.path.join(SERVICE_ROOT_DIR, 'storage', 'classifiers')
            if not os.path.isdir(destination_folder):
                os.makedirs(destination_folder, exist_ok=True)
        elif path == 'models':
            from app.config.path_config import SERVICE_ROOT_DIR
            destination_folder = os.path.join(SERVICE_ROOT_DIR, 'storage', 'models')
            if not os.path.isdir(destination_folder):
                os.makedirs(destination_folder, exist_ok=True)
        else:
            # Validate user has access to the destination path
            await assert_can_access_path_async(auth_user, path, "upload-init")

            destination_folder = resolve_path(path)
            if not os.path.isdir(destination_folder):
                raise AppErrors.PARAMS_ERROR("Destination path is not a valid directory.")

        # Quota check before accepting the session
        _ensure_chunk_upload_quota_or_raise(auth_user, int(total_size))

        use_keep_both = keep_both
        uniq_fn = uniquify_path_keep_both if use_keep_both else uniquify_path
        if path in ['classifiers', 'models']:
            file_ext = os.path.splitext(filename)[1]
            safe_filename_unique = f"{uuid.uuid4()}{file_ext}"
            destination_path_unique = os.path.join(destination_folder, safe_filename_unique)
        elif relative_path and relative_path.strip():
            rel = relative_path.replace("\\", "/").strip("/")
            top = rel.split("/")[0]
            dest_abs = resolve_path(path)
            if use_keep_both and top and os.path.exists(os.path.join(dest_abs, top)):
                rel = f"{uniquify_path_keep_both(dest_abs, top)}/" + "/".join(rel.split("/")[1:]) if "/" in rel else uniquify_path_keep_both(dest_abs, top)
            dest_rel = os.path.normpath(os.path.join(path, rel)).replace("\\", "/")
            dest_dir_abs = resolve_path(os.path.dirname(dest_rel))
            os.makedirs(dest_dir_abs, exist_ok=True)
            base_name = sanitize_filename(os.path.basename(rel))
            if not overwrite:
                safe_filename_unique = uniq_fn(dest_dir_abs, base_name)
            else:
                safe_filename_unique = base_name
            destination_path_unique = os.path.join(dest_dir_abs, safe_filename_unique)
        else:
            safe_filename = sanitize_filename(filename)
            destination_path = os.path.join(destination_folder, safe_filename)
            if not overwrite:
                safe_filename_unique = uniq_fn(destination_folder, safe_filename)
                destination_path_unique = os.path.join(destination_folder, safe_filename_unique)
            else:
                safe_filename_unique = safe_filename
                destination_path_unique = destination_path

        # Disk-space probe and the whole locked section in ONE worker thread.
        # _destination_init_lock is a cross-process FileLock: acquiring it on
        # the event loop froze every other request for as long as another
        # worker held it, up to FILE_LOCK_TIMEOUT_SEC.
        def _init_locked():
            _ensure_disk_space_for_chunked_upload(int(total_size), destination_path_unique)
            with _destination_init_lock(destination_path_unique):
                _assert_no_active_upload_for_destination(destination_path_unique)
                if is_active_zarr_upload_destination(destination_path_unique):
                    raise AppErrors.RESOURCE_CONFLICT(
                        "Destination is part of an active zarr batch upload."
                    )

                upload_id = uuid.uuid4().hex

                _preallocate_destination_file(destination_path_unique, int(total_size))

                upload_info = {
                    "upload_id": upload_id,
                    "owner": auth_user.uid,
                    "filename": safe_filename_unique,
                    "original_filename": filename,  # Save the original filename
                    "total_size": total_size,
                    "chunk_size": chunk_size,
                    "total_chunks": (total_size + chunk_size - 1) // chunk_size,
                    "uploaded_chunks": set(),
                    "chunk_digests": {},
                    "destination_path": destination_path_unique,
                    "created_at": time.time(),
                    "last_activity_at": time.time(),
                    "status": "uploading",
                    "streaming_assembly": True,
                }

                try:
                    _save_chunk_upload_info(upload_id, upload_info)
                except Exception:
                    _remove_staged_upload_file(destination_path_unique)
                    raise
            return upload_id, upload_info

        upload_id, upload_info = await asyncio.to_thread(_init_locked)
        
        return JSONResponse(content={
            "success": True,
            "upload_id": upload_id,
            "total_chunks": upload_info["total_chunks"],
            "chunk_size": chunk_size
        })
        
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error initializing chunked upload: {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


def _chunk_byte_offset(upload_info: Dict[str, Any], chunk_index: int) -> int:
    return chunk_index * int(upload_info["chunk_size"])


# Block size for streaming chunk IO — see _write_streaming_chunk.
_CHUNK_STREAM_BLOCK = 1024 * 1024


def _chunk_digest_on_disk(
    destination_path: str, upload_info: Dict[str, Any], chunk_index: int
) -> str:
    """Digest of one chunk's byte range, read in blocks.

    Reading the range whole cost a chunk-sized buffer (up to MAX_CHUNK_BYTES)
    per call, and completion calls it once per chunk while other uploads are
    doing the same. Streaming keeps it at one block.
    """
    start = _chunk_byte_offset(upload_info, chunk_index)
    remaining = _expected_chunk_byte_size(upload_info, chunk_index)
    digest = hashlib.sha256()
    with open(destination_path, "rb") as handle:
        handle.seek(start)
        while remaining > 0:
            block = handle.read(min(_CHUNK_STREAM_BLOCK, remaining))
            if not block:
                raise ValueError(
                    f"Chunk {chunk_index} read short: {remaining} bytes missing."
                )
            remaining -= len(block)
            digest.update(block)
    return digest.hexdigest()


def _chunk_digest_on_disk_matches(
    destination_path: str,
    upload_info: Dict[str, Any],
    chunk_index: int,
    expected_digest: str,
) -> bool:
    try:
        return _chunk_digest_on_disk(destination_path, upload_info, chunk_index) == expected_digest
    except (OSError, ValueError):
        return False


def _preallocate_destination_file(destination_path: str, total_size: int) -> None:
    parent = os.path.dirname(destination_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(destination_path, "wb") as handle:
        handle.truncate(int(total_size))


def _write_streaming_chunk(
    destination_path: str,
    upload_info: Dict[str, Any],
    chunk_index: int,
    chunk_data: UploadFile,
    expected_size: int,
) -> str:
    """Copy the uploaded chunk into place, hashing as it goes.

    Streamed in blocks rather than read() into one buffer: chunks are capped at
    MAX_CHUNK_BYTES (64 MB) and _CHUNK_UPLOAD_CONCURRENCY of them are now
    genuinely in flight at once, so a whole-chunk buffer each would be a
    gigabyte of upload sitting in RSS. The size is checked before the first
    byte lands, as before, by measuring the spooled file rather than reading it.
    """
    # seek-then-tell rather than the return value of seek(): SpooledTemporaryFile
    # only started returning a position from seek() in recent CPython, and the
    # file object here is whatever the ASGI server handed us.
    chunk_data.file.seek(0, os.SEEK_END)
    actual_size = chunk_data.file.tell()
    chunk_data.file.seek(0)
    if actual_size != expected_size:
        raise AppErrors.PARAMS_ERROR(
            f"Chunk size mismatch: expected {expected_size}, got {actual_size}."
        )
    offset = _chunk_byte_offset(upload_info, chunk_index)
    digest = hashlib.sha256()
    with open(destination_path, "r+b") as handle:
        handle.seek(offset)
        while True:
            block = chunk_data.file.read(_CHUNK_STREAM_BLOCK)
            if not block:
                break
            digest.update(block)
            handle.write(block)
    return digest.hexdigest()


def _verify_streaming_assembly(
    destination_path: str,
    expected_size: int,
    upload_info: Optional[Dict[str, Any]] = None,
) -> None:
    if not _destination_matches_expected(destination_path, expected_size):
        raise ValueError(
            f"Assembled file size mismatch: expected {expected_size}, "
            f"got {os.path.getsize(destination_path) if os.path.isfile(destination_path) else 'missing'}"
        )
    if upload_info is not None:
        _verify_streaming_chunk_digests(destination_path, upload_info)


def _verify_streaming_chunk_digests(
    destination_path: str,
    upload_info: Dict[str, Any],
) -> None:
    """Verify each uploaded chunk on disk matches the digest recorded at upload time."""
    uploaded = upload_info.get("uploaded_chunks")
    if not isinstance(uploaded, set):
        uploaded = set(uploaded or [])
    total_chunks = int(upload_info["total_chunks"])
    expected = set(range(total_chunks))
    if uploaded != expected:
        missing = sorted(expected - uploaded)
        raise ValueError(f"Missing chunks: {missing[:32]}{'...' if len(missing) > 32 else ''}")

    digests = upload_info.get("chunk_digests") or {}
    for chunk_index in range(total_chunks):
        key = str(chunk_index)
        expected_digest = digests.get(key)
        if not expected_digest:
            raise ValueError(f"Missing digest for chunk {chunk_index}.")
        if not _chunk_digest_on_disk_matches(
            destination_path, upload_info, chunk_index, str(expected_digest)
        ):
            raise ValueError(f"Chunk {chunk_index} digest mismatch (incomplete or corrupted data).")


def _record_uploaded_chunk(
    upload_id: str,
    chunk_index: int,
    auth_user: AuthUser,
    chunk_digest: Optional[str] = None,
) -> tuple[int, int]:
    """Mark chunk_index uploaded in session JSON; returns (uploaded_count, total_chunks)."""
    with _chunk_session_lock(upload_id):
        upload_info = _load_chunk_upload_info(upload_id)
        _assert_chunk_upload_owner(upload_info, auth_user)
        session_status = str(upload_info.get("status") or "uploading")
        if _chunk_upload_session_blocked(session_status):
            raise AppErrors.RESOURCE_CONFLICT("Upload is being merged; chunk uploads are not allowed.")
        if chunk_index < 0 or chunk_index >= upload_info["total_chunks"]:
            raise AppErrors.PARAMS_ERROR("Invalid chunk index.")

        upload_info["uploaded_chunks"].add(chunk_index)
        if chunk_digest:
            digests = upload_info.setdefault("chunk_digests", {})
            digests[str(chunk_index)] = chunk_digest
        _touch_upload_activity(upload_info)
        _save_chunk_upload_info(upload_id, upload_info)
        return len(upload_info["uploaded_chunks"]), upload_info["total_chunks"]


def _upload_chunk_sync(
    upload_id: str,
    chunk_index: int,
    chunk_data: UploadFile,
    auth_user: AuthUser
) -> Dict[str, Any]:
    """Blocking half of :func:`upload_chunk` — never call this on the event loop.

    Session JSON reads, the on-disk digest re-read, the chunk body read and its
    pwrite, and both locks (a threading.Lock for the chunk slot, a cross-process
    filelock for the session) are all synchronous. Running them inline froze the
    whole single-worker service for the length of every chunk of every upload —
    the zarr-batch path already offloads its writes for exactly this reason.
    """
    upload_info = _load_chunk_upload_info(upload_id)
    _assert_chunk_upload_owner(upload_info, auth_user)
    upload_info = _recover_stale_merging_session(upload_id)

    session_status = str(upload_info.get("status") or "uploading")
    if _chunk_upload_session_blocked(session_status):
        raise AppErrors.RESOURCE_CONFLICT("Upload is being merged; chunk uploads are not allowed.")

    if chunk_index >= upload_info["total_chunks"]:
        raise AppErrors.PARAMS_ERROR("Invalid chunk index.")

    destination_path = str(upload_info["destination_path"])
    expected_size = _expected_chunk_byte_size(upload_info, chunk_index)

    uploaded = upload_info.get("uploaded_chunks")
    if isinstance(uploaded, set) and chunk_index in uploaded:
        digests = upload_info.get("chunk_digests") or {}
        stored_digest = digests.get(str(chunk_index))
        if stored_digest and _chunk_digest_on_disk_matches(
            destination_path, upload_info, chunk_index, str(stored_digest)
        ):
            _touch_upload_session_activity(upload_id, auth_user)
            total_chunks = int(upload_info["total_chunks"])
            return {
                "success": True,
                "chunk_index": chunk_index,
                "uploaded_chunks": len(uploaded),
                "total_chunks": total_chunks,
                "duplicate": True,
            }

    chunk_lock = _get_chunk_file_lock(upload_id, chunk_index)
    with chunk_lock:
        with _chunk_session_lock(upload_id):
            upload_info = _load_chunk_upload_info(upload_id)
            session_status = str(upload_info.get("status") or "uploading")
            if session_status == "cancelling":
                raise AppErrors.RESOURCE_CONFLICT("Upload is being cancelled.")
            if _chunk_upload_session_blocked(session_status):
                raise AppErrors.RESOURCE_CONFLICT("Upload is being merged; chunk uploads are not allowed.")
        chunk_digest: Optional[str] = None
        if chunk_index in upload_info.get("uploaded_chunks", set()):
            digests = upload_info.get("chunk_digests") or {}
            stored_digest = digests.get(str(chunk_index))
            if stored_digest and _chunk_digest_on_disk_matches(
                destination_path, upload_info, chunk_index, str(stored_digest)
            ):
                chunk_digest = str(stored_digest)
            else:
                chunk_digest = _write_streaming_chunk(
                    destination_path,
                    upload_info,
                    chunk_index,
                    chunk_data,
                    expected_size,
                )
        else:
            chunk_digest = _write_streaming_chunk(
                destination_path,
                upload_info,
                chunk_index,
                chunk_data,
                expected_size,
            )

    uploaded_count, total_chunks = _record_uploaded_chunk(
        upload_id, chunk_index, auth_user, chunk_digest=chunk_digest
    )

    return {
        "success": True,
        "chunk_index": chunk_index,
        "uploaded_chunks": uploaded_count,
        "total_chunks": total_chunks
    }


async def upload_chunk(
    upload_id: str,
    chunk_index: int,
    chunk_data: UploadFile,
    auth_user: AuthUser
):
    """Upload a single chunk"""
    if chunk_index < 0:
        raise AppErrors.PARAMS_ERROR("Invalid chunk index.")

    # Bounds how many chunk writes are in flight, and therefore how many worker
    # threads the offload below can occupy.
    if not _CHUNK_UPLOAD_SEMAPHORE.acquire(blocking=False):
        raise AppErrors.REQUEST_QUOTA_EXCEEDED()
    try:
        payload = await _run_upload_io(
            _upload_chunk_sync, upload_id, chunk_index, chunk_data, auth_user
        )
        return JSONResponse(content=payload)

    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error uploading chunk {chunk_index}: {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()
    finally:
        _CHUNK_UPLOAD_SEMAPHORE.release()



def _expected_chunk_byte_size(upload_info: Dict[str, Any], chunk_index: int) -> int:
    chunk_size = int(upload_info["chunk_size"])
    total_size = int(upload_info["total_size"])
    total_chunks = int(upload_info["total_chunks"])
    if chunk_index < 0 or chunk_index >= total_chunks:
        raise ValueError("Invalid chunk index.")
    if chunk_index == total_chunks - 1:
        return total_size - (total_chunks - 1) * chunk_size
    return chunk_size


async def complete_chunked_upload(request: Request, upload_id: Optional[str], auth_user: AuthUser):
    """Finalize chunked upload (streaming assembly) or zarr batch upload.

    Chunked uploads write each chunk directly into the pre-allocated destination
    file during ``POST /v1/files/upload/chunk``. Complete verifies all chunks
    are present and registers metadata.

    Zarr batch uploads use ``application/json`` with ``upload_type: zarr-batch``.
    """
    if upload_id is None and request.headers.get("content-type", "").lower().startswith("application/json"):
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        if isinstance(payload, dict) and payload.get("upload_type") == "zarr-batch":
            return await asyncio.to_thread(
                _complete_zarr_batch_upload, payload, auth_user
            )
        upload_id = payload.get("upload_id") if isinstance(payload, dict) else None
    if not upload_id:
        raise AppErrors.PARAMS_ERROR("Missing upload_id.")
    if not _CHUNK_COMPLETE_SEMAPHORE.acquire(blocking=False):
        raise AppErrors.REQUEST_QUOTA_EXCEEDED()

    merge_fd = _try_acquire_merge_lock(upload_id)
    if not merge_fd:
        _CHUNK_COMPLETE_SEMAPHORE.release()
        raise AppErrors.RESOURCE_CONFLICT("Merge already in progress for this upload.")

    try:
        session_path = CHUNK_TEMP_DIR / f"{upload_id}.json"
        if not session_path.is_file():
            # Completion-record read + Firestore upsert.
            idempotent = await asyncio.to_thread(
                _try_idempotent_complete_from_record, upload_id, auth_user
            )
            if idempotent is not None:
                return idempotent
            raise AppErrors.RESOURCE_NOT_FOUND()

        def _claim_merge():
            """Take the session lock, run the pre-merge checks, flip to merging.

            Every step blocks: waiting on the cross-process session filelock,
            the session JSON IO, the Firestore quota read and the staged-bytes
            disk walk. Returns ``(early_response, prepared)`` — exactly one of
            the two is set.
            """
            with _chunk_session_lock(upload_id):
                upload_info = _load_chunk_upload_info(upload_id)
                _assert_chunk_upload_owner(upload_info, auth_user)
                upload_info = _recover_stale_merging_session(upload_id, session_lock_held=True)

                destination_path = upload_info["destination_path"]
                expected_size = int(upload_info["total_size"])
                chunk_dir = CHUNK_TEMP_DIR / upload_id
                session_status = str(upload_info.get("status") or "uploading")

                if session_status == "merged_pending_metadata":
                    finalized = _finalize_assembled_upload(
                        upload_id,
                        upload_info,
                        destination_path,
                        expected_size,
                        chunk_dir,
                        auth_user,
                        duplicate=True,
                    )
                    if finalized is not None:
                        return finalized, None
                    raise AppErrors.SERVER_INTERNAL_ERROR(_METADATA_RETRY_MESSAGE)

                expected_chunks = set(range(upload_info["total_chunks"]))
                uploaded_chunks = set(upload_info["uploaded_chunks"])
                if uploaded_chunks != expected_chunks:
                    missing_chunks = expected_chunks - uploaded_chunks
                    raise AppErrors.PARAMS_ERROR(f"Missing chunks: {sorted(missing_chunks)[:32]}{'...' if len(missing_chunks) > 32 else ''}")

                ensure_quota_or_raise(
                    auth_user,
                    expected_size,
                    inflight_bytes=_inflight_upload_bytes_for_user(
                        auth_user.uid,
                        exclude_upload_ids={upload_id},
                    ),
                    staged_on_disk_bytes=_staged_destination_bytes_on_disk_for_user(auth_user.uid),
                )
                _ensure_disk_space_for_chunked_upload(
                    expected_size,
                    destination_path,
                    staged_bytes=expected_size,
                )

                upload_info["status"] = "merging"
                upload_info["merging_started_at"] = time.time()
                _touch_upload_activity(upload_info)
                _save_chunk_upload_info(upload_id, upload_info)

            return None, (upload_info, destination_path, expected_size, chunk_dir)

        early_response, prepared = await _run_upload_io(_claim_merge)
        if early_response is not None:
            return early_response
        upload_info, destination_path, expected_size, chunk_dir = prepared

        try:
            await _run_upload_io(
                _verify_streaming_assembly,
                destination_path,
                expected_size,
                upload_info,
            )
        except (FileNotFoundError, ValueError, OSError) as verify_err:
            await asyncio.to_thread(_remove_staged_upload_file, destination_path)
            await asyncio.to_thread(_reset_merge_session, upload_id)
            logger.error(f"Error verifying chunked upload {upload_id}: {verify_err}", exc_info=True)
            raise AppErrors.SERVER_INTERNAL_ERROR(str(verify_err))

        # Chunk-dir cleanup plus the Firestore metadata upsert.
        finalized = await _run_upload_io(
            _finalize_assembled_upload,
            upload_id,
            upload_info,
            destination_path,
            expected_size,
            chunk_dir,
            auth_user,
        )
        if finalized is None:
            raise AppErrors.SERVER_INTERNAL_ERROR("Upload finished but destination file is missing.")
        return finalized

    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error completing chunked upload: {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()
    finally:
        _remove_merge_lock_file(upload_id)
        _CHUNK_COMPLETE_SEMAPHORE.release()


def get_upload_status(upload_id: str, auth_user: AuthUser):
    # Sync on purpose: the whole body is a cross-process FileLock critical
    # section. FileLock.acquire blocks the calling thread for up to
    # FILE_LOCK_TIMEOUT_SEC, so on the event loop it froze the entire
    # service. Callers dispatch this with asyncio.to_thread.
    """Get chunked or zarr-batch upload status (read-only; does not extend session lifetime)."""
    try:
        zarr_path = _zarr_batch_info_path(upload_id)
        if zarr_path.is_file():
            session = _load_zarr_batch_session(upload_id)
            if session.get("owner") != auth_user.uid:
                raise AppErrors.USER_FORBIDDEN()
            uploaded_batches = sorted(int(x) for x in (session.get("uploaded_batches") or []))
            folder_rewrite = session.get("folder_rewrite")
            if not isinstance(folder_rewrite, dict):
                folder_rewrite = {}
            return JSONResponse(content={
                "success": True,
                "upload_type": "zarr-batch",
                "upload_id": upload_id,
                "total_size": int(session.get("total_size") or 0),
                "file_count": len(session.get("files") or []),
                "uploaded_batches": uploaded_batches,
                "uploaded_batch_count": len(uploaded_batches),
                "total_batches": int(session.get("total_batches") or 0),
                "max_batch_bytes": int(session.get("max_batch_bytes") or MAX_ZARR_BATCH_BYTES),
                "folder_rewrite": folder_rewrite,
                "keep_both": bool(session.get("keep_both")),
                "overwrite": bool(session.get("overwrite")),
                "path": session.get("path"),
                "status": "uploading",
            })

        with _chunk_session_lock(upload_id):
            upload_info = _load_chunk_upload_info(upload_id)
            _assert_chunk_upload_owner(upload_info, auth_user)
            upload_info = _recover_stale_merging_session(
                upload_id,
                session_lock_held=True,
                allow_destructive_recovery=False,
            )

            return JSONResponse(content={
                "success": True,
                "upload_id": upload_id,
                "filename": upload_info["filename"],
                "total_size": upload_info["total_size"],
                "total_chunks": upload_info["total_chunks"],
                "uploaded_chunks": len(upload_info["uploaded_chunks"]),
                "missing_chunks": list(set(range(upload_info["total_chunks"])) - upload_info["uploaded_chunks"]),
                "progress": (
                    len(upload_info["uploaded_chunks"]) / upload_info["total_chunks"] * 100
                    if int(upload_info["total_chunks"]) > 0
                    else 0
                ),
                "status": upload_info.get("status", "uploading"),
            })
        
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error getting upload status: {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


def cancel_chunked_upload(upload_id: str, auth_user: AuthUser):
    # Sync on purpose: the whole body is a cross-process FileLock critical
    # section. FileLock.acquire blocks the calling thread for up to
    # FILE_LOCK_TIMEOUT_SEC, so on the event loop it froze the entire
    # service. Callers dispatch this with asyncio.to_thread.
    """Cancel chunked upload"""
    try:
        with _chunk_session_lock(upload_id):
            upload_info = _load_chunk_upload_info(upload_id)
            _assert_chunk_upload_owner(upload_info, auth_user)
            upload_info = _recover_stale_merging_session(upload_id, session_lock_held=True)

            if _merge_in_progress_for_upload(upload_id):
                raise AppErrors.RESOURCE_CONFLICT("Cannot cancel upload while merge is in progress.")

            session_status = str(upload_info.get("status") or "")
            if session_status == "merging":
                raise AppErrors.RESOURCE_CONFLICT("Cannot cancel upload while merge is in progress.")

            upload_info["status"] = "cancelling"
            _save_chunk_upload_info(upload_id, upload_info)

            destination_path = str(upload_info.get("destination_path") or "")
            expected_size = int(upload_info.get("total_size") or 0)
            if session_status == "merged_pending_metadata" and _destination_matches_expected(
                destination_path, expected_size
            ):
                try:
                    os.remove(destination_path)
                except OSError as exc:
                    logger.warning(f"Failed to remove merged file during cancel {destination_path}: {exc}")
            else:
                _remove_staged_upload_file(destination_path)

            chunk_dir = CHUNK_TEMP_DIR / upload_id
            _cleanup_chunked_upload_artifacts(upload_id, chunk_dir)

        return JSONResponse(content={
            "success": True,
            "message": "Upload cancelled successfully."
        })
        
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error cancelling upload: {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR() 


