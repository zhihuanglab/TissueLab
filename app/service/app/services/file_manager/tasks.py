"""Background tasks: delete, compress, decompress, status streaming."""
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
import asyncio
import json
import os
import shutil
import uuid
import zipfile
import zlib
import threading
import time
import stat
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from app.core.auth import AuthUser
from app.core.errors import AppErrors
from app.repos.files import FilesRepo
from app.utils import resolve_path

from app.config.path_config import STORAGE_ROOT, is_public_read_only_path
from app.services.file_manager.common import (
    logger,
    build_file_id,
    normalize_rel_path,
    sanitize_filename,
    gather_guards,
    assert_writable_async,
    assert_deletable_async,
    ensure_quota_or_raise,
    is_path_busy_error,
    is_permission_denied_error,
)
from app.services.file_manager.schemas import DeleteRequest, CompressRequest, DecompressRequest
from app.services.file_manager import upload as fm_upload

# Task status tracking for background operations (compression, decompression, deletion)
_background_tasks: Dict[str, Dict[str, Any]] = {}
_task_lock = threading.Lock()

# ...mirrored to local disk. The dict alone lived and died with the process, so
# a deploy or a crash mid-delete left every watching client polling a task id
# that answered "Task not found" — indistinguishable, from the UI, from a task
# that never existed. The mirror lets a reconnecting client read the last known
# state, and lets startup tell the truth about work a restart interrupted.
# Local disk, not STORAGE_ROOT: this is per-process bookkeeping, not user data.

_INSTANCE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def _instance_key() -> str:
    """What separates two ctrl-service instances sharing a host.

    The listening port, resolved the way main.py resolves it. Two instances on
    one host necessarily listen on different ports — that is what makes this a
    COMPLETE discriminator, and why no per-record ownership tracking is needed:
    a directory is only ever read by the instance that wrote it. It is also
    stable across restarts of an instance, which is what the mirror needs.

    A deployment that bind-mounted one cache directory into several containers
    would break that assumption. Nothing does today (Cloud Run gives each
    instance its own filesystem); if one ever does, give it an explicit key
    here rather than reintroducing ownership stamps on every record.
    """
    argv = sys.argv[1:]
    if "--port" in argv:
        index = argv.index("--port")
        if index + 1 < len(argv):
            candidate = argv[index + 1].strip()
            if _INSTANCE_KEY_RE.match(candidate):
                return candidate
    env_port = (os.environ.get("PORT") or "").strip()
    if _INSTANCE_KEY_RE.match(env_port):
        return env_port
    return "dev" if "--dev" in argv else "default"


def _posix_cache_home() -> Path:
    """``~/.cache``, or the temp dir when there is no home to speak of.

    ``Path.home()`` raises when the process runs as a uid with no passwd entry
    and no ``HOME`` — a container started with ``runAsUser: 10001``, say.
    TASK_STATE_DIR is computed at import time, so letting that propagate would
    stop the whole service from booting over a bookkeeping cache.
    """
    try:
        return Path.home() / ".cache"
    except (RuntimeError, OSError, KeyError) as e:
        fallback = Path(tempfile.gettempdir())
        logger.warning(f"[fm_tasks] no home directory ({e}); using {fallback}")
        return fallback


def _local_task_state_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()
        root = Path(base) / "TissueLab-Ctrl" / "fm_tasks"
    else:
        xdg = os.environ.get("XDG_CACHE_HOME")
        if xdg:
            root = Path(xdg) / "tissuelab-ctrl" / "fm_tasks"
        else:
            root = _posix_cache_home() / "tissuelab-ctrl" / "fm_tasks"
    return root / _instance_key()


TASK_STATE_DIR = _local_task_state_dir()
try:
    TASK_STATE_DIR.mkdir(parents=True, exist_ok=True)
except OSError as e:  # read-only FS — degrade to memory-only, do not crash boot
    logger.warning(f"[fm_tasks] cannot create task state dir {TASK_STATE_DIR}: {e}")

_TASK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _task_state_path(task_id: str) -> Optional[Path]:
    # Task ids are uuid4 hex we minted ourselves, but this is a filename — keep
    # anything else from reaching the filesystem.
    if not _TASK_ID_RE.match(task_id or ""):
        return None
    return TASK_STATE_DIR / f"{task_id}.json"


def _write_task_state(task_id: str, meta: Dict[str, Any]) -> None:
    path = _task_state_path(task_id)
    if path is None:
        return
    try:
        tmp = path.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(meta, f)
        os.replace(tmp, path)
    except Exception as e:
        # Never let bookkeeping break the operation it is describing.
        logger.warning(f"[fm_tasks] failed to persist {task_id}: {e}")


def _read_task_state(task_id: str) -> Optional[Dict[str, Any]]:
    path = _task_state_path(task_id)
    if path is None or not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        return meta if isinstance(meta, dict) else None
    except Exception:
        try:
            path.unlink()
        except OSError:
            pass
        return None


def _drop_task_state(task_id: str) -> None:
    path = _task_state_path(task_id)
    if path is None:
        return
    try:
        path.unlink()
    except OSError:
        pass


def reconcile_interrupted_tasks() -> int:
    """Mark tasks a restart killed as failed, and drop expired leftovers.

    Called once at startup. The directory belongs to this instance alone (see
    _instance_key), so a pending/processing record in it was owned by a thread
    that died with the previous process — it is never coming back, and saying so
    beats leaving the client to time out.
    """
    now = time.time()
    reconciled = 0
    try:
        state_files = list(TASK_STATE_DIR.glob("*.json"))
    except OSError:
        return 0
    for path in state_files:
        task_id = path.stem
        meta = _read_task_state(task_id)
        if not meta:
            continue
        status = meta.get("status")
        if status in ("completed", "failed"):
            finished = float(meta.get("finished_at") or meta.get("updated_at") or 0.0)
            if now - finished >= TASK_RESULT_TTL_SEC:
                _drop_task_state(task_id)
            continue
        meta["status"] = "failed"
        meta["error"] = "The service restarted while this task was running."
        meta["updated_at"] = now
        meta["finished_at"] = now
        _write_task_state(task_id, meta)
        with _task_lock:
            _background_tasks[task_id] = meta
        reconciled += 1
    if reconciled:
        logger.warning(f"[fm_tasks] marked {reconciled} interrupted task(s) as failed")
    return reconciled

# Concurrency limits for compress/decompress (disk/CPU heavy)
_HEAVY_OPS_SEMAPHORE = threading.Semaphore(2)

# Delete concurrency: split from compress/decompress and partitioned per-user so a
# single user's big-folder delete can't starve the rest. Post-BulkWriter optimization,
# deletes are mostly network-bound on Firestore round-trips and can run more in
# parallel safely. Tune the two caps if Firestore-side rate limits become a problem.
_DELETE_GLOBAL_MAX = 8        # total concurrent delete tasks across all users
_DELETE_PER_USER_MAX = 2      # max concurrent delete tasks per user
_DELETE_LOCK = threading.Lock()
_DELETE_GLOBAL_INFLIGHT: int = 0
_DELETE_PER_USER_INFLIGHT: Dict[str, int] = {}

# Hard limits for zip extraction
MAX_DECOMPRESS_FILES = 10000
MAX_DECOMPRESS_TOTAL_BYTES = 10 * 1024 * 1024 * 1024  # 10GB


def _try_acquire_delete_slot(uid: Optional[str]):
    """Reserve a slot to run a delete task. Returns a release callable on success,
    or None when the user or the global pool is already at capacity.

    Anonymous / no-uid callers share the global pool but bypass the per-user cap.
    The release callable is idempotent — safe to call from `on_complete` plus an
    error path without double-counting.
    """
    global _DELETE_GLOBAL_INFLIGHT
    with _DELETE_LOCK:
        if _DELETE_GLOBAL_INFLIGHT >= _DELETE_GLOBAL_MAX:
            return None
        if uid and _DELETE_PER_USER_INFLIGHT.get(uid, 0) >= _DELETE_PER_USER_MAX:
            return None
        _DELETE_GLOBAL_INFLIGHT += 1
        if uid:
            _DELETE_PER_USER_INFLIGHT[uid] = _DELETE_PER_USER_INFLIGHT.get(uid, 0) + 1

    released = {'done': False}

    def release():
        if released['done']:
            return
        released['done'] = True
        global _DELETE_GLOBAL_INFLIGHT
        with _DELETE_LOCK:
            _DELETE_GLOBAL_INFLIGHT = max(0, _DELETE_GLOBAL_INFLIGHT - 1)
            if uid:
                remaining = _DELETE_PER_USER_INFLIGHT.get(uid, 0) - 1
                if remaining <= 0:
                    _DELETE_PER_USER_INFLIGHT.pop(uid, None)
                else:
                    _DELETE_PER_USER_INFLIGHT[uid] = remaining

    return release


def _update_task_status(task_id: str, status: str, result: Optional[Dict[str, Any]] = None, error: Optional[str] = None, owner: Optional[str] = None):
    """Update task status in thread-safe manner."""
    with _task_lock:
        if task_id not in _background_tasks:
            _background_tasks[task_id] = {}
        _background_tasks[task_id]['status'] = status
        _background_tasks[task_id]['updated_at'] = time.time()
        if result:
            _background_tasks[task_id]['result'] = result
        if error:
            _background_tasks[task_id]['error'] = error
        if owner is not None:
            _background_tasks[task_id]['owner'] = owner
        if status in ('completed', 'failed'):
            # Keep terminal results briefly so SSE reconnect / HTTP poll can still read them.
            _background_tasks[task_id]['finished_at'] = time.time()
        snapshot = dict(_background_tasks[task_id])
    _write_task_state(task_id, snapshot)


# How long to retain completed/failed task payloads for clients that reconnect after a proxy drop.
TASK_RESULT_TTL_SEC = 120.0


def _purge_expired_task_results() -> None:
    now = time.time()
    with _task_lock:
        expired = [
            tid
            for tid, meta in _background_tasks.items()
            if meta.get('status') in ('completed', 'failed')
            and (now - float(meta.get('finished_at') or meta.get('updated_at') or 0.0)) >= TASK_RESULT_TTL_SEC
        ]
        for tid in expired:
            _background_tasks.pop(tid, None)
    for tid in expired:
        _drop_task_state(tid)


def _get_task_status(task_id: str) -> Optional[Dict[str, Any]]:
    """Get task status in thread-safe manner."""
    _purge_expired_task_results()
    with _task_lock:
        meta = _background_tasks.get(task_id, None)
        if meta is not None:
            return meta

    # Not in memory: either this process never had it, or it was restarted.
    # The on-disk mirror is what makes a reconnect after a deploy answer with
    # the real outcome instead of "Task not found".
    meta = _read_task_state(task_id)
    if meta is None:
        return None
    if meta.get('status') in ('completed', 'failed'):
        finished = float(meta.get('finished_at') or meta.get('updated_at') or 0.0)
        if time.time() - finished >= TASK_RESULT_TTL_SEC:
            _drop_task_state(task_id)
            return None
    with _task_lock:
        _background_tasks.setdefault(task_id, meta)
        return _background_tasks[task_id]


def _rmtree_force_writable(func, path, exc_info):
    """``shutil.rmtree`` onerror handler: clear a blocking read-only bit and retry."""
    try:
        if os.path.islink(path):
            os.unlink(path)
            return
        parent = os.path.dirname(path)
        for p in (parent, path):
            try:
                if p and not os.path.islink(p):
                    want = os.stat(p).st_mode | stat.S_IWUSR
                    if os.path.isdir(p):
                        want |= stat.S_IXUSR
                    os.chmod(p, want)
            except OSError:
                pass
        func(path)
    except Exception as e:
        logger.warning(f"rmtree onerror could not remove {path}: {e}")


def _purge_records_for_missing(paths: List[str]) -> int:
    """Drop the Firestore records for paths that are no longer on disk.

    A record with no file behind it is a row the user can see, cannot open and
    — until this — could not delete, because every delete path skipped anything
    `lexists` said was absent. `delete_subtree_by_prefix` covers both shapes:
    an exact match for a file, plus descendants if the missing item was a folder.
    """
    if not paths:
        return 0
    files_repo = FilesRepo()
    removed = 0
    for path in paths:
        if os.path.lexists(path):
            continue
        try:
            rel = os.path.relpath(path, STORAGE_ROOT).replace('\\', '/')
            if rel.startswith('..'):
                continue
            removed += files_repo.delete_subtree_by_prefix(rel) or 0
        except Exception as e:
            logger.warning(f"Failed to clean up stale Firestore record for {path}: {e}")
    return removed


def _background_delete(task_id: str, secured_items: List[str], auth_user: AuthUser, on_complete=None):
    """Background task to perform the actual deletion in a separate thread."""
    def _delete_worker():
        """Worker function that runs in a separate thread to avoid blocking the event loop."""
        try:
            _update_task_status(task_id, 'processing')
            
            deleted_count = 0
            failed_items = []
            
            files_repo = FilesRepo()
            # No up-front "is it in use?" scan: the delete below reports the
            # same condition through the OS, and probing every file in a
            # folder first meant walking a .zarr store's whole chunk tree.
            total_items = sum(1 for p in secured_items if os.path.lexists(p))
            for item_path in secured_items:
                if not os.path.lexists(item_path):
                    # Gone from disk already — still take its record, or the row
                    # comes back on the next listing and can never be removed.
                    _purge_records_for_missing([item_path])
                    continue

                try:
                    is_dir = os.path.isdir(item_path) and not os.path.islink(item_path)
                    item_basename = os.path.basename(item_path)

                    # Cascade-unshare: before the bytes are gone, find every
                    # file-table doc at this path (or beneath it) that has
                    # non-empty `sharedWith`, and remove each recipient's
                    # symlink + doc. We do this BEFORE the fs delete so the
                    # source still exists for any per-recipient logging /
                    # path lookup, and so a partial-cascade failure can't
                    # strand recipients with dangling symlinks.
                    try:
                        rel_for_cascade = os.path.relpath(item_path, STORAGE_ROOT).replace('\\', '/')
                        me_uid = getattr(auth_user, 'uid', None) or ''
                        if me_uid and rel_for_cascade:
                            from app.services.copy import get_copy_service
                            copy_svc = get_copy_service()
                            for shared_doc in files_repo.iter_subtree_by_prefix(rel_for_cascade):
                                # Only act on docs the caller owns — defense
                                # in depth; users can't unilaterally clean up
                                # someone else's docs even if a misconfigured
                                # query returned them.
                                if shared_doc.get('ownerId') != me_uid:
                                    continue
                                doc_local = shared_doc.get('localPath') or ''
                                if not doc_local:
                                    continue

                                # Case A — outgoing shares: caller is the
                                # sharer. For each recipient, run the full
                                # unshare (drops their symlink/copy + doc).
                                recipients = shared_doc.get('sharedWith') or []
                                for rid in recipients:
                                    if not isinstance(rid, str) or not rid:
                                        continue
                                    try:
                                        copy_svc.unshare_from_user_sync(
                                            sharer_uid=me_uid,
                                            recipient_uid=rid,
                                            source_rel=doc_local,
                                        )
                                    except Exception as _cascade_one_err:
                                        logger.warning(
                                            f"Cascade unshare failed: sharer={me_uid} -> "
                                            f"recipient={rid}, source={doc_local}: {_cascade_one_err}"
                                        )

                                # Case B — caller is the recipient deleting a
                                # received share (view / collab / private-copy).
                                # Strip them from the sharer's sharedWith so
                                # ShareDialog stays consistent. Samples links
                                # have no sharedBy and are skipped.
                                share_mode = (shared_doc.get('shareMode') or 'share').strip().lower()
                                sharer_of = shared_doc.get('sharedBy') or ''
                                source_for = shared_doc.get('linkedFrom') or ''
                                if (
                                    share_mode in ('collaborate', 'view', 'share')
                                    and sharer_of
                                    and source_for
                                ):
                                    try:
                                        sharer_doc = files_repo.find_by_owner_and_path(sharer_of, source_for)
                                        if sharer_doc:
                                            current = sharer_doc.get('sharedWith') or []
                                            if me_uid in current:
                                                files_repo.upsert_file(
                                                    sharer_doc.get('id'),
                                                    {'sharedWith': [u for u in current if u != me_uid]},
                                                )
                                    except Exception as _reverse_err:
                                        logger.warning(
                                            f"Reverse share cleanup failed: recipient={me_uid} "
                                            f"-> sharer={sharer_of}, source={source_for}: {_reverse_err}"
                                        )
                    except Exception as _cascade_err:
                        logger.warning(
                            f"Cascade unshare phase failed for {item_path}: {_cascade_err}"
                        )

                    # Symlinks (the collab-umbrella case in particular) MUST
                    # use os.unlink — shutil.rmtree on a symlinked directory
                    # raises, and following it would touch the sharer's data.
                    # Check islink BEFORE isdir, since os.path.isdir follows.
                    if os.path.islink(item_path):
                        os.unlink(item_path)
                        # Companion .zarr: full symlink (view) or sparse real
                        # overlay (private-copy / samples link). Delete removes
                        # both so Personal does not keep an orphan store.
                        abs_zarr = item_path + ".zarr"
                        try:
                            if os.path.islink(abs_zarr):
                                os.unlink(abs_zarr)
                            elif os.path.isdir(abs_zarr):
                                shutil.rmtree(abs_zarr, onerror=_rmtree_force_writable)
                        except Exception:
                            logger.warning(
                                f"Failed to remove sibling zarr for deleted link: {abs_zarr}"
                            )
                    elif is_dir:
                        shutil.rmtree(item_path, onerror=_rmtree_force_writable)
                    else:
                        os.remove(item_path)
                    deleted_count += 1
                    logger.info(f"Successfully deleted: {item_path}")

                    try:
                        rel_path = os.path.relpath(item_path, STORAGE_ROOT).replace('\\', '/')

                        if is_dir:
                            # Folder: one prefix range query + BulkWriter, instead of
                            # N serial `delete_file` round-trips per descendant.
                            def _on_fs_progress(fs_deleted: int, _name=item_basename, _idx=deleted_count, _total=total_items):
                                _update_task_status(task_id, 'processing', result={
                                    'phase': 'firestore_cleanup',
                                    'item': _name,
                                    'firestore_deleted': fs_deleted,
                                    'item_index': _idx,
                                    'item_total': _total,
                                })

                            fs_count = files_repo.delete_subtree_by_prefix(rel_path, on_progress=_on_fs_progress)
                            logger.info(f"Firestore subtree cleanup for {rel_path}: removed {fs_count} doc(s)")
                        else:
                            files_repo.delete_file(build_file_id(rel_path))
                    except Exception as _e:
                        logger.warning(f"Failed to clean up Firestore record for {item_path}: {_e}")

                except OSError as e:
                    if is_path_busy_error(e):
                        failed_items.append({
                            'path': item_path,
                            'error': f"Cannot delete '{os.path.basename(item_path)}' because it is in use."
                        })
                    elif is_permission_denied_error(e):
                        failed_items.append({
                            'path': item_path,
                            'error': f"Cannot delete '{os.path.basename(item_path)}' because access is denied."
                        })
                    else:
                        failed_items.append({
                            'path': item_path,
                            'error': f"Failed to delete '{os.path.basename(item_path)}': {str(e)}"
                        })
                except Exception as e:
                    failed_items.append({
                        'path': item_path,
                        'error': f"Unexpected error deleting '{os.path.basename(item_path)}': {str(e)}"
                    })

            # Update task status
            if failed_items:
                error_msg = f"Failed to delete {len(failed_items)} item(s). Successfully deleted {deleted_count} item(s)."
                _update_task_status(task_id, 'completed', result={
                    'deleted_count': deleted_count,
                    'failed_items': failed_items,
                    'message': error_msg
                })
            else:
                _update_task_status(task_id, 'completed', result={
                    'deleted_count': deleted_count,
                    'message': f'Successfully deleted {deleted_count} item(s).'
                })
        except Exception as e:
            error_msg = str(e)
            logger.error(f"Error in background deletion task: {e}", exc_info=True)
            _update_task_status(task_id, 'failed', error=error_msg)
        finally:
            if on_complete:
                try:
                    on_complete()
                except Exception:
                    pass

    # Start the deletion in a separate thread to avoid blocking the event loop
    thread = threading.Thread(target=_delete_worker, daemon=True)
    thread.start()


async def delete_items(req: DeleteRequest, auth_user: AuthUser):
    """Delete files or folders using relative paths (background task)."""
    try:
        # Check if any items are in read-only directories (including virtual paths)
        for item_path in req.items:
            if is_public_read_only_path(item_path):
                raise AppErrors.USER_FORBIDDEN()

        # Validate user has access to all items to be deleted. Both guards
        # reach Firestore, so a multi-select delete used to run one serial
        # ancestor walk per item on the event loop.
        await gather_guards(*(assert_deletable_async(auth_user, p) for p in req.items))

        secured_items = [resolve_path(p) for p in req.items]

        for item in secured_items:
            # Covers the item and anything under it, without walking it — the
            # old per-file check turned deleting one .zarr into a traversal of
            # its whole chunk tree before the request was even accepted.
            if fm_upload.subtree_has_active_upload_destination(item):
                raise AppErrors.RESOURCE_CONFLICT(
                    f"Cannot delete '{os.path.basename(item)}' while it is being uploaded."
                )

        # Safety net: never delete outside STORAGE_ROOT.
        # follows symlinks, so a linked sample resolves to its user-space path
        # (so os.remove unlinks the link, not the shared source) — but guard
        # explicitly so a crafted or absolute path can't make the worker touch
        # anything outside the managed store. Compared against the abspath form
        # because resolve_path returns abspath (matching, no symlink resolution).
        storage_root_abs = os.path.abspath(STORAGE_ROOT)
        for item in secured_items:
            if not (item == storage_root_abs or item.startswith(storage_root_abs + os.sep)):
                logger.warning(f"delete_items: refusing path outside STORAGE_ROOT: {item}")
                raise AppErrors.USER_FORBIDDEN()

        # Check if any items exist (lexists: include dangling share symlinks)
        existing_items = [p for p in secured_items if os.path.lexists(p)]
        if not existing_items:
            # Nothing on disk, but the listing renders these rows from their
            # Firestore records — so returning "deleted" without touching those
            # left an undeletable ghost that still counted against quota. The
            # user asked for these exact paths to go; take the records with them.
            removed = await asyncio.to_thread(_purge_records_for_missing, secured_items)
            return JSONResponse(content={
                "success": True,
                "message": ("No items found to delete."
                            if removed == 0
                            else f"Removed {removed} stale record(s) for files no longer on disk."),
            })

        # Concurrency: per-user cap + global cap so one user's big-folder delete
        # can't starve the rest of the multi-user pool.
        owner_uid = getattr(auth_user, 'uid', None)
        release_delete_slot = _try_acquire_delete_slot(owner_uid)
        if release_delete_slot is None:
            raise AppErrors.REQUEST_QUOTA_EXCEEDED()

        # Generate task ID and initialize task status. If anything between here
        # and the worker thread.start() raises, the slot would leak — release
        # it explicitly on failure so the per-user cap stays accurate.
        task_id = str(uuid.uuid4())
        try:
            _update_task_status(task_id, 'pending', result={
                'items': req.items,
                'type': 'delete'
            }, owner=owner_uid)

            # Start deletion in a separate thread (releases the delete slot when done)
            _background_delete(task_id, secured_items, auth_user, on_complete=release_delete_slot)
        except Exception:
            release_delete_slot()
            raise

        # Touch on enqueue rather than completion — the background worker has no
        # easy hook back into the request scope, and the user IS active right now.
        return JSONResponse(content={
            "success": True,
            "task_id": task_id,
            "message": "Deletion started in background.",
            "status": "pending"
        })
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error starting deletion for items {req.items}: {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


# ===== Compression APIs =====


def _collect_zip_members(src_abs_list: List[str]) -> List[tuple]:
    """One walk over the sources -> ``[(abs_path, arcname, size), ...]``.

    ``followlinks=True`` is kept so a linked overlay .zarr archives the
    shared groups it points at, but that makes a symlink cycle an infinite
    walk — so directories are tracked by (device, inode) and visited once.
    """
    members: List[tuple] = []
    seen_dirs: Set[tuple] = set()

    def _size_of(path: str) -> int:
        try:
            return os.path.getsize(path)
        except OSError:
            return 0

    for src_path in src_abs_list:
        if not os.path.isdir(src_path):
            members.append((src_path, os.path.basename(src_path), _size_of(src_path)))
            continue

        parent = os.path.dirname(src_path.rstrip(os.sep))
        for root, dirs, files in os.walk(src_path, followlinks=True):
            try:
                st = os.stat(root)
                key = (st.st_dev, st.st_ino)
            except OSError:
                continue
            if key in seen_dirs:
                dirs[:] = []
                logger.warning(f"compress: skipping already-visited directory {root}")
                continue
            seen_dirs.add(key)

            for file in files:
                full = os.path.join(root, file)
                members.append((full, os.path.relpath(full, parent), _size_of(full)))
    return members


# Zarr metadata is small JSON and always worth deflating; chunk payloads are
# whatever the array's own compressor produced, which is usually blosc/zstd.
_ZARR_METADATA_NAMES = frozenset({'.zarray', '.zattrs', '.zgroup', '.zmetadata', 'zarr.json'})
# DEFLATE that fails to shrink a sample by more than this is buying nothing.
_INCOMPRESSIBLE_RATIO = 0.95
_COMPRESSION_PROBE_FILES = 5
_COMPRESSION_PROBE_BYTES = 128 * 1024


def _is_zarr_metadata_name(name: str) -> bool:
    return os.path.basename(name) in _ZARR_METADATA_NAMES


def _payload_is_precompressed(members: List[tuple]) -> bool:
    """Sample a few payload files to decide whether DEFLATE is worth its CPU.

    A WSI pyramid's chunks are already compressed by zarr itself, so deflating
    them again spends minutes of CPU to save nothing. Rather than guessing from
    file names — a chunk is called ``0.0.0`` and an array can legitimately be
    stored uncompressed — read a small slice of the largest few files and let
    the data answer. The probe is a handful of reads no matter how many
    hundreds of thousands of files the store holds.
    """
    candidates = sorted(
        (m for m in members if not _is_zarr_metadata_name(m[1]) and m[2] > 0),
        key=lambda m: m[2],
        reverse=True,
    )[:_COMPRESSION_PROBE_FILES]
    if not candidates:
        return False

    raw_total = 0
    packed_total = 0
    for full_path, _arc, _size in candidates:
        try:
            with open(full_path, 'rb') as fh:
                sample = fh.read(_COMPRESSION_PROBE_BYTES)
        except OSError:
            continue
        if not sample:
            continue
        raw_total += len(sample)
        packed_total += len(zlib.compress(sample, 1))

    if raw_total == 0:
        return False
    ratio = packed_total / raw_total
    logger.info(
        f"compress: probed {len(candidates)} file(s), deflate ratio {ratio:.3f} "
        f"-> {'store' if ratio > _INCOMPRESSIBLE_RATIO else 'deflate'}"
    )
    return ratio > _INCOMPRESSIBLE_RATIO


def _background_compress(task_id: str, src_abs_list: List[str], zip_abs_path: str, auth_user: AuthUser, on_complete=None):
    """Background task to perform the actual compression in a separate thread."""
    def _compress_worker():
        """Worker function that runs in a separate thread to avoid blocking the event loop."""
        try:
            _update_task_status(task_id, 'processing')
            
            # One traversal, not two. The old code walked every source to sum
            # sizes for the quota check and then walked it again to write the
            # archive — on a directory-format .zarr that is a second pass over
            # hundreds of thousands of files for nothing.
            members = _collect_zip_members(src_abs_list)
            estimated_bytes = sum(size for _, _, size in members)
            ensure_quota_or_raise(auth_user, max(0, estimated_bytes))

            total_members = len(members)
            store_payloads = _payload_is_precompressed(members)
            with zipfile.ZipFile(zip_abs_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
                for index, (full_path, arcname, _size) in enumerate(members):
                    # Metadata always deflates well; payloads follow the probe.
                    compress_type = (
                        zipfile.ZIP_STORED
                        if store_payloads and not _is_zarr_metadata_name(arcname)
                        else zipfile.ZIP_DEFLATED
                    )
                    zf.write(full_path, arcname, compress_type=compress_type)
                    # A big archive is otherwise a silent multi-minute wait.
                    if total_members and index % 500 == 0:
                        _update_task_status(task_id, 'processing', result={
                            'phase': 'compressing',
                            'written': index,
                            'total': total_members,
                        })

            rel_zip_path = os.path.relpath(zip_abs_path, STORAGE_ROOT).replace('\\', '/')
            logger.info(f"Compression completed: {zip_abs_path}")
            _update_task_status(task_id, 'completed', result={
                'zip_path': rel_zip_path,
                'message': 'Compression completed successfully'
            })
        except Exception as e:
            error_msg = str(e)
            logger.error(f"Error in background compression task: {e}", exc_info=True)
            _update_task_status(task_id, 'failed', error=error_msg)
        finally:
            if on_complete:
                try:
                    on_complete()
                except Exception:
                    pass

    # Start the compression in a separate thread to avoid blocking the event loop
    thread = threading.Thread(target=_compress_worker, daemon=True)
    thread.start()


async def compress_items(payload: CompressRequest, auth_user: AuthUser):
    try:
        if not payload.items or len(payload.items) == 0:
            raise AppErrors.PARAMS_ERROR("No items provided to compress")

        # Validate access to all source items and ensure they are .zarr directories
        async def _assert_compressible(rel: str) -> None:
            await assert_writable_async(auth_user, rel)
            if not rel.lower().endswith('.zarr'):
                raise AppErrors.PARAMS_ERROR("Only .zarr directories can be compressed")

        await gather_guards(*(_assert_compressible(rel) for rel in payload.items))

        # Determine destination directory
        if payload.dest_path:
            await assert_writable_async(auth_user, payload.dest_path)
            dest_dir_abs = resolve_path(payload.dest_path)
        else:
            # default to the parent dir of the first item
            first_parent_rel = os.path.dirname(payload.items[0].rstrip('/'))
            await assert_writable_async(auth_user, first_parent_rel)
            dest_dir_abs = resolve_path(first_parent_rel)

        if not os.path.isdir(dest_dir_abs):
            raise AppErrors.PARAMS_ERROR("Destination path is not a directory")

        # Determine zip filename
        if payload.zip_name and payload.zip_name.strip():
            base_name = sanitize_filename(payload.zip_name.strip())
            if not base_name.lower().endswith('.zip'):
                base_name = f"{base_name}.zip"
        else:
            if len(payload.items) == 1:
                base = os.path.basename(payload.items[0].rstrip('/')) or 'archive'
                base_name = sanitize_filename(f"{base}.zip")
            else:
                base_name = "archive.zip"

        zip_abs_path = os.path.join(dest_dir_abs, base_name)
        if not payload.overwrite:
            # uniquify if needed
            name, ext = os.path.splitext(base_name)
            counter = 1
            while os.path.exists(zip_abs_path):
                zip_abs_path = os.path.join(dest_dir_abs, f"{name}_{counter}{ext}")
                counter += 1

        # Build list of absolute source paths. The upload sessions are read
        # once for the whole request, not once per item.
        upload_exact, upload_prefixes = fm_upload.active_upload_destination_roots()
        src_abs_list = []
        for rel in payload.items:
            p = resolve_path(rel)
            if not os.path.exists(p):
                raise AppErrors.RESOURCE_NOT_FOUND()
            if not os.path.isdir(p):
                raise AppErrors.PARAMS_ERROR("Only .zarr directories can be compressed")
            if fm_upload.matches_upload_destination_roots(p, upload_exact, upload_prefixes):
                raise AppErrors.RESOURCE_CONFLICT(
                    "Cannot compress a .zarr directory while an upload is in progress."
                )
            src_abs_list.append(p)

        # Concurrency limit: heavy ops (compress) max 2 concurrent
        if not _HEAVY_OPS_SEMAPHORE.acquire(blocking=False):
            raise AppErrors.REQUEST_QUOTA_EXCEEDED()

        # Generate task ID and initialize task status
        task_id = str(uuid.uuid4())
        rel_zip_path = os.path.relpath(zip_abs_path, STORAGE_ROOT).replace('\\', '/')
        owner_uid = getattr(auth_user, 'uid', None)
        _update_task_status(task_id, 'pending', result={
            'zip_path': rel_zip_path,
            'type': 'compress'
        }, owner=owner_uid)

        # Start compression in a separate thread (releases semaphore when done)
        _background_compress(task_id, src_abs_list, zip_abs_path, auth_user, on_complete=_HEAVY_OPS_SEMAPHORE.release)

        return JSONResponse(content={
            "success": True,
            "task_id": task_id,
            "zip_path": rel_zip_path,
            "message": "Compression started in background.",
            "status": "pending"
        })
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting compression for items {payload.items}: {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


def _background_decompress(task_id: str, zip_abs: str, target_dir: str, auth_user: AuthUser, on_complete=None):
    """Background task to perform the actual decompression in a separate thread."""
    def _decompress_worker():
        """Worker function that runs in a separate thread to avoid blocking the event loop."""
        try:
            _update_task_status(task_id, 'processing')
            
            # Zip bomb protection: check total uncompressed size and file count before extracting
            with zipfile.ZipFile(zip_abs, 'r') as zf:
                total_bytes = 0
                file_count = 0
                for info in zf.infolist():
                    if not info.is_dir():
                        file_count += 1
                        total_bytes += max(0, getattr(info, 'file_size', 0))
                        if file_count > MAX_DECOMPRESS_FILES:
                            raise ValueError(f"Zip contains too many files (max {MAX_DECOMPRESS_FILES}). Extraction aborted.")
                        if total_bytes > MAX_DECOMPRESS_TOTAL_BYTES:
                            raise ValueError(f"Zip uncompressed size exceeds limit (max {MAX_DECOMPRESS_TOTAL_BYTES // (1024**3)}GB). Extraction aborted.")
                est = total_bytes
            ensure_quota_or_raise(auth_user, max(0, est))

            os.makedirs(target_dir, exist_ok=True)

            # Secure extraction against Zip Slip
            def is_within_directory(directory: str, target: str) -> bool:
                abs_directory = os.path.abspath(directory)
                abs_target = os.path.abspath(target)
                return os.path.commonprefix([abs_directory + os.sep, abs_target + os.sep]) == abs_directory + os.sep

            # Extract files preserving the original zip structure
            with zipfile.ZipFile(zip_abs, 'r') as zf:
                for member in zf.infolist():
                    member_path = member.filename
                    # Normalize path separators (zip uses '/')
                    normalized = member_path.replace('\\', '/')
                    if normalized.startswith('..') or normalized.startswith('/'):
                        continue
                    if not normalized or normalized == '.':
                        continue
                    
                    # Convert zip path separator to OS path separator, preserving original structure
                    relative_path_os = normalized.replace('/', os.sep)
                    dest_path = os.path.join(target_dir, relative_path_os)
                    if not is_within_directory(target_dir, dest_path):
                        continue
                    
                    if member.is_dir():
                        os.makedirs(dest_path, exist_ok=True)
                    else:
                        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                        with zf.open(member, 'r') as src, open(dest_path, 'wb') as out:
                            shutil.copyfileobj(src, out)

            rel_out = os.path.relpath(target_dir, STORAGE_ROOT).replace('\\', '/')
            logger.info(f"Decompression completed: {target_dir}")
            _update_task_status(task_id, 'completed', result={
                'extracted_path': rel_out,
                'message': 'Extraction completed successfully'
            })
        except Exception as e:
            error_msg = str(e)
            logger.error(f"Error in background decompression task: {e}", exc_info=True)
            _update_task_status(task_id, 'failed', error=error_msg)
        finally:
            if on_complete:
                try:
                    on_complete()
                except Exception:
                    pass

    # Start the decompression in a separate thread to avoid blocking the event loop
    thread = threading.Thread(target=_decompress_worker, daemon=True)
    thread.start()


async def decompress_zip(payload: DecompressRequest, auth_user: AuthUser):
    try:
        rel_zip = normalize_rel_path(payload.zip_path)
        await assert_writable_async(auth_user, rel_zip)

        zip_abs = resolve_path(rel_zip)
        if not os.path.exists(zip_abs) or not os.path.isfile(zip_abs):
            raise AppErrors.RESOURCE_NOT_FOUND()
        if not zip_abs.lower().endswith('.zip'):
            raise AppErrors.PARAMS_ERROR("Only .zip files are supported")

        # Determine destination directory
        if payload.dest_path:
            await assert_writable_async(auth_user, payload.dest_path)
            dest_dir_abs = resolve_path(payload.dest_path)
        else:
            dest_dir_abs = os.path.dirname(zip_abs)

        if not os.path.isdir(dest_dir_abs):
            raise AppErrors.PARAMS_ERROR("Destination path is not a directory")

        # Always extract directly to destination directory, preserving zip's internal structure
        target_dir = dest_dir_abs

        if fm_upload.is_active_upload_destination(target_dir):
            raise AppErrors.RESOURCE_CONFLICT(
                "Cannot decompress into a path with an upload in progress."
            )

        # If overwrite is False, check for conflicts
        if not payload.overwrite:
            def _first_conflicting_member() -> Optional[str]:
                """Reads the archive and stats every member — a zipped .zarr
                has hundreds of thousands of them, so never on the event loop.
                """
                with zipfile.ZipFile(zip_abs, 'r') as zf:
                    for member in zf.infolist():
                        # Skip directories, only check files
                        if member.is_dir():
                            continue

                        normalized = member.filename.replace('\\', '/')
                        if normalized.startswith('..') or normalized.startswith('/'):
                            continue
                        if not normalized or normalized == '.':
                            continue

                        # Convert zip path separator to OS path separator
                        relative_path_os = normalized.replace('/', os.sep)
                        potential_path = os.path.join(target_dir, relative_path_os)

                        if os.path.exists(potential_path):
                            return normalized
                return None

            conflict = await asyncio.to_thread(_first_conflicting_member)
            if conflict:
                raise AppErrors.RESOURCE_CONFLICT(
                    f"File conflict: '{conflict}' already exists in destination. Set overwrite=True to overwrite."
                )

        # Concurrency limit: heavy ops (decompress) max 2 concurrent
        if not _HEAVY_OPS_SEMAPHORE.acquire(blocking=False):
            raise AppErrors.REQUEST_QUOTA_EXCEEDED()

        # Generate task ID and initialize task status
        task_id = str(uuid.uuid4())
        rel_out = os.path.relpath(target_dir, STORAGE_ROOT).replace('\\', '/')
        owner_uid = getattr(auth_user, 'uid', None)
        _update_task_status(task_id, 'pending', result={
            'extracted_path': rel_out,
            'type': 'decompress'
        }, owner=owner_uid)

        # Start decompression in a separate thread (releases semaphore when done)
        _background_decompress(task_id, zip_abs, target_dir, auth_user, on_complete=_HEAVY_OPS_SEMAPHORE.release)

        return JSONResponse(content={
            "success": True,
            "task_id": task_id,
            "extracted_path": rel_out,
            "message": "Extraction started in background.",
            "status": "pending"
        })
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting decompression for zip '{payload.zip_path}': {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


async def get_task_status(task_id: str, auth_user: AuthUser):
    """Get the status of a background task (compression, decompression, or deletion)."""
    try:
        task_status = _get_task_status(task_id)
        if not task_status:
            raise AppErrors.RESOURCE_NOT_FOUND()
        
        # Ensure only the owner can view the task
        if task_status.get('owner') != getattr(auth_user, 'uid', None):
            raise AppErrors.USER_FORBIDDEN()
        
        # Return task status
        response = {
            "task_id": task_id,
            "status": task_status.get('status', 'unknown'),
            "updated_at": task_status.get('updated_at', 0)
        }
        
        if 'result' in task_status:
            response['result'] = task_status['result']
        if 'error' in task_status:
            response['error'] = task_status['error']
        
        return JSONResponse(content=response)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting task status for {task_id}: {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


async def _generate_task_status_events(task_id: str, request: Request):
    """Async generator for SSE task status updates."""
    last_status = None
    last_updated = 0
    last_send_monotonic = 0.0
    # Proxies idle-kill SSE after ~60–100s with no bytes (long zip/delete plateaus).
    HEARTBEAT_INTERVAL_SEC = 15.0
    
    while True:
        # Break out if the client has disconnected
        if await request.is_disconnected():
            break
        
        now = time.monotonic()
        task_status = _get_task_status(task_id)
        
        if not task_status:
            # Task not found, send error and close
            yield f"event: error\ndata: {json.dumps({'error': 'Task not found'})}\n\n"
            break
        
        current_status = task_status.get('status', 'unknown')
        current_updated = task_status.get('updated_at', 0)
        
        # Only send update if status or timestamp changed
        if current_status != last_status or current_updated != last_updated:
            event_data = {
                "task_id": task_id,
                "status": current_status,
                "updated_at": current_updated
            }
            
            if 'result' in task_status:
                event_data['result'] = task_status['result']
            if 'error' in task_status:
                event_data['error'] = task_status['error']
            
            yield f"event: status\ndata: {json.dumps(event_data, ensure_ascii=False)}\n\n"
            last_send_monotonic = now
            
            last_status = current_status
            last_updated = current_updated
            
            # If task is completed or failed, send final event and close.
            # Do not pop immediately — retain for TASK_RESULT_TTL_SEC so a
            # reconnecting client / HTTP poll can still read the result.
            if current_status in ['completed', 'failed']:
                yield f"event: done\ndata: {json.dumps({'status': current_status})}\n\n"
                break
        elif (
            current_status in ('pending', 'processing')
            and (now - last_send_monotonic) >= HEARTBEAT_INTERVAL_SEC
        ):
            yield f"event: heartbeat\ndata: {json.dumps({'heartbeat': True, 'ts': int(time.time())})}\n\n"
            last_send_monotonic = now
        
        # Wait before next check
        await asyncio.sleep(1)


async def stream_task_status(task_id: str, request: Request):
    """Stream task status updates via Server-Sent Events (SSE).
    
    Supports all background task types: compression, decompression, and deletion.
    """
    try:
        # EventSource cannot set headers; the open edition has one principal.
        from app.core.identity import LOCAL_USER_ID
        uid = LOCAL_USER_ID

        # Verify task exists
        task_status = _get_task_status(task_id)
        if not task_status:
            raise AppErrors.RESOURCE_NOT_FOUND()
        
        # Ensure only the owner can view the task
        if task_status.get('owner') != uid:
            raise AppErrors.USER_FORBIDDEN()
        
        return StreamingResponse(
            _generate_task_status_events(task_id, request),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"  # Needed for some Nginx setups
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error streaming task status for {task_id}: {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


