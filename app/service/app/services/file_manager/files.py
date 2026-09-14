"""Browse, CRUD, download, and metadata for file manager."""
from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse, FileResponse
from starlette.background import BackgroundTask
import asyncio
import functools
import json
import os
import shutil
import time
import zipfile
import tempfile
import secrets
import threading
import schedule
from pathlib import Path
from typing import List, Dict, Any, Optional, Set

from app.core.auth import AuthUser
from app.core.errors import AppErrors
from app.core.response import AppResponse, success_response
from app.repos.files import FilesRepo
from app.utils import resolve_path

from app.config.path_config import (
    STORAGE_ROOT,
    abs_to_client_path,
    resolve_virtual_path,
    is_virtual_path,
    get_virtual_children,
    get_public_virtual_links,
    is_public_read_only_path,
)
from app.services.file_manager.common import (
    logger,
    build_file_id,
    get_user_storage_usage_bytes,
    get_user_storage_quota_bytes,
    gather_guards,
    assert_writable_async,
    validate_user_access_to_path,
    assert_can_access_path,
    assert_can_access_path_async,
    assert_can_extract_path,
    assert_can_extract_path_async,
    assert_can_write_path_async,
    normalize_rel_path,
    sanitize_filename,
    is_path_busy_error,
    is_permission_denied_error,
)
from app.services.file_manager import listing_view
from app.services.file_manager import upload as fm_upload
from app.services.file_manager.schemas import (
    FileOperationRequest,
    MoveRequest,
    CopyToPersonalRequest,
    RefreshMetadataRequest,
)

# Direct download links storage
DOWNLOAD_LINKS_DIR = Path(STORAGE_ROOT) / ".download_links"
DOWNLOAD_LINKS_DIR.mkdir(exist_ok=True)
DOWNLOAD_LINK_EXPIRY_HOURS = 1


def get_accessible_paths_for_user(auth_user: AuthUser | None) -> List[str]:
    """Get list of accessible paths for a user."""
    accessible_paths = []
    if not auth_user or auth_user.is_anonymous:
        accessible_paths.append('samples')
        return accessible_paths
    accessible_paths.append(f"users/{auth_user.uid}")
    accessible_paths.append('samples')
    return accessible_paths


def scan_directory_entries(directory_abs: str) -> Dict[str, os.DirEntry]:
    """One readdir pass over a directory, with each entry's type resolved.

    ``is_dir()`` rides along on the directory read, so warming it is free.

    ``stat()`` deliberately is NOT warmed: it is a syscall per entry (a network
    round-trip per entry on a mounted bucket) and ~84% of the cost of scanning a
    large directory, yet most rows never need it — the Firestore subcollection
    already carries size and mtime, and a store about to be folded onto its
    slide has both discarded. Which rows those are is only known later, so the
    stat stays lazy on the ``DirEntry`` and ``get_file_details`` takes it for the
    rows that need one. That loop therefore runs off the event loop; see
    ``_build_listing_items``.
    """
    entries: Dict[str, os.DirEntry] = {}
    with os.scandir(directory_abs) as it:
        for entry in it:
            try:
                entry.is_dir()
            except OSError:
                # Vanished mid-listing, or a dangling symlink — keep the entry
                # and let get_file_details report the failure.
                pass
            entries[entry.name] = entry
    return entries


def get_file_details(
    absolute_path: str, entry: Optional[os.DirEntry] = None
) -> Dict[str, Any]:
    """Helper to get file details, with a path the client can address.

    Pass ``entry`` (from :func:`scan_directory_entries`) to reuse the stat the
    directory scan already took instead of issuing two more syscalls.
    """
    try:
        stat = entry.stat() if entry is not None else os.stat(absolute_path)
        is_dir = entry.is_dir() if entry is not None else os.path.isdir(absolute_path)
        # Not os.path.relpath against STORAGE_ROOT: a virtual link target sits
        # outside it, where relpath yields a `../../..` string on POSIX and
        # raises on Windows across drives — dropping the row via the except
        # below. The alias form is the only path a client can navigate to.
        relative_path = abs_to_client_path(absolute_path)
        etag = None
        if not is_dir:
            try:
                etag = f"W/\"{stat.st_size}-{int(stat.st_mtime * 1000)}\""
            except Exception:
                etag = None
        return {
            "name": os.path.basename(absolute_path),
            "path": relative_path,
            "is_dir": is_dir,
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "etag": etag,
        }
    except FileNotFoundError:
        # Expected, not a fault: the entry was in the directory read but has no
        # target — a file deleted between readdir and stat, or a symlink whose
        # target is gone (a "use without copying" sample that was removed).
        # The caller falls back to the Firestore record when there is one, so
        # this must not shout on every listing of the folder.
        logger.debug(f"No target on disk for {absolute_path}")
        return None
    except Exception as e:
        logger.error(f"Error getting details for {absolute_path}: {e}", exc_info=e)
        return None


def _backfill_file_size_from_disk(abs_path: str, size: int) -> None:
    """Best-effort heal of stale Firestore fileSize=0 after a disk re-stat.

    Never backfill directory-format ``.zarr`` stores — they are intentionally
    tracked as fileSize=0 (walking chunks for quota/size is too expensive).
    ``.zarr.zip`` is a normal file and may be backfilled.
    """
    if size <= 0:
        return
    name = os.path.basename(abs_path).lower()
    if name.endswith('.zarr') and not name.endswith('.zarr.zip'):
        return
    try:
        rel = os.path.relpath(abs_path, STORAGE_ROOT).replace('\\', '/')
        if rel.startswith('..'):
            return
        FilesRepo().upsert_file(build_file_id(rel), {
            'fileName': os.path.basename(abs_path),
            'localPath': rel,
            'fileSize': size,
        })
    except Exception as e:
        logger.debug(f"backfill fileSize skipped for {abs_path}: {e}")


def _is_zarr_dir_name(name: str) -> bool:
    """Directory-format zarr store (not .zarr.zip archive)."""
    n = (name or '').lower()
    return n.endswith('.zarr') and not n.endswith('.zarr.zip')


VIEW_LINK_EXTENSIONS = (
    ".nii",
    ".nii.gz",
    ".dcm",
    ".nrrd",
    ".mha",
    ".mhd",
)


def _is_view_link_allowed_path(file_path: str) -> bool:
    name = (file_path or "").rstrip("/").lower()
    return any(name.endswith(ext) for ext in VIEW_LINK_EXTENSIONS)


def generate_download_token() -> str:
    """Generate a secure random token for download links."""
    return secrets.token_urlsafe(32)


def create_download_link(
    file_path: str,
    auth_user: AuthUser | None,
    *,
    purpose: str = "download",
) -> str:
    """Create a temporary download/view link for a file or .zarr directory.

    purpose=download → extract ACL (Samples/Viewer blocked)
    purpose=view → read ACL only, radiology-like files for in-viewer load
    """
    try:
        purpose_norm = (purpose or "download").strip().lower()
        if purpose_norm == "view":
            if not _is_view_link_allowed_path(file_path):
                raise AppErrors.PARAMS_ERROR(
                    "View links are limited to radiology volume formats."
                )
            assert_can_access_path(auth_user, file_path, "view-link")
        else:
            assert_can_extract_path(auth_user, file_path, "download-link")
            assert_can_access_path(auth_user, file_path, "download-link")

        abs_path = resolve_path(file_path)
        if not os.path.exists(abs_path):
            raise AppErrors.RESOURCE_NOT_FOUND()
        is_zarr_dir = os.path.isdir(abs_path) and file_path.rstrip('/').lower().endswith('.zarr')
        if purpose_norm == "view" and (is_zarr_dir or os.path.isdir(abs_path)):
            raise AppErrors.PARAMS_ERROR("View links cannot target directories.")
        if not is_zarr_dir and os.path.isdir(abs_path):
            raise AppErrors.RESOURCE_NOT_FOUND()
        token = generate_download_token()
        if is_zarr_dir:
            base_name = os.path.basename(abs_path.rstrip(os.sep)) or "archive"
            filename = f"{base_name}.zip"
        else:
            filename = os.path.basename(abs_path) or "download"
        link_data = {
            "token": token,
            "file_path": file_path,
            "created_at": time.time(),
            "expires_at": time.time() + (DOWNLOAD_LINK_EXPIRY_HOURS * 3600),
            "user_id": auth_user.uid if auth_user else None,
            "filename": filename,
            "stream_as_zip": is_zarr_dir,
            "purpose": purpose_norm,
        }
        link_file = DOWNLOAD_LINKS_DIR / f"{token}.json"
        with open(link_file, 'w') as f:
            json.dump(link_data, f)
        return token
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating download link: {e}", exc_info=e)
        raise AppErrors.SERVER_INTERNAL_ERROR()


def validate_download_token(token: str) -> dict:
    """Validate a download token and return link data if valid."""
    try:
        link_file = DOWNLOAD_LINKS_DIR / f"{token}.json"
        if not link_file.exists():
            raise AppErrors.RESOURCE_NOT_FOUND()
        with open(link_file, 'r') as f:
            link_data = json.load(f)
        if time.time() > link_data.get("expires_at", 0):
            try:
                link_file.unlink()
            except Exception:
                pass
            raise AppErrors.RESOURCE_NOT_FOUND()
        file_path = link_data.get("file_path")
        user_id = link_data.get("user_id")
        if not file_path or not user_id:
            try:
                link_file.unlink()
            except Exception:
                pass
            raise AppErrors.USER_FORBIDDEN("Anonymous download tokens are not valid.")
        temp_auth_user = AuthUser(uid=user_id, email="", is_anonymous=False, provider_id='firebase')
        purpose = (link_data.get("purpose") or "download").strip().lower()
        try:
            assert_can_access_path(
                temp_auth_user, file_path, "download-token-redeem"
            )
            if purpose != "view":
                assert_can_extract_path(temp_auth_user, file_path, "download-token-redeem")
        except HTTPException:
            try:
                link_file.unlink()
            except Exception:
                pass
            raise
        return link_data
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error validating download token: {e}", exc_info=e)
        raise AppErrors.SERVER_INTERNAL_ERROR()


def cleanup_expired_links():
    """Clean up expired download links."""
    try:
        current_time = time.time()
        cleaned_count = 0
        for link_file in DOWNLOAD_LINKS_DIR.glob("*.json"):
            try:
                with open(link_file, 'r') as f:
                    link_data = json.load(f)
                if current_time > link_data.get("expires_at", 0):
                    link_file.unlink()
                    cleaned_count += 1
            except Exception:
                try:
                    link_file.unlink()
                    cleaned_count += 1
                except Exception:
                    pass
        if cleaned_count > 0:
            logger.info(f"Cleaned up {cleaned_count} expired download links")
    except Exception as e:
        logger.warning(f"Error cleaning up expired links: {e}")


def start_cleanup_scheduler():
    """Start the background cleanup scheduler for expired download links."""
    def run_cleanup():
        cleanup_expired_links()

    schedule.every().hour.do(run_cleanup)

    def run_scheduler():
        while True:
            schedule.run_pending()
            time.sleep(60)

    cleanup_thread = threading.Thread(target=run_scheduler, daemon=True)
    cleanup_thread.start()
    logger.info("Started download link cleanup scheduler")


def _hidden_names_for_personal_root(
    sub_meta: Optional[Dict[str, Dict[str, Any]]],
) -> Set[str]:
    """Names to omit from Personal root listing.

    Viewer / Editor umbrellas physically live under ``users/<uid>/`` and are
    now listed here too (they carry ``shareMode`` / ``sharedBy`` so the client
    can badge them and keep Viewer read-only) — they simply also appear under
    "Shared with me". Only the sibling ``.zarr`` companion of a single-file
    view share stays hidden: it is surfaced as a badge on the slide row, never
    as a row of its own.
    """
    hide: Set[str] = set()
    if not sub_meta:
        return hide
    for meta_name, meta in sub_meta.items():
        if not meta_name:
            continue
        mode = (meta.get("shareMode") or "").strip().lower()
        if mode in ("view", "collaborate"):
            hide.add(f"{meta_name}.zarr")
    return hide


def _query_subcollection_sync(uid: str, dir_rel: str) -> Optional[Dict[str, Dict[str, Any]]]:
    """No file table in the open edition: every row is stat'ed from disk."""
    return None


async def _query_subcollection_for_listing(uid: str, dir_rel: str) -> Optional[Dict[str, Dict[str, Any]]]:
    """Query file metadata for immediate children of dir_rel from Firestore."""
    # `to_thread`, not `run_in_executor`: it carries the contextvars across, so
    # the warning `_query_subcollection_sync` logs when it falls back to disk
    # still names the request it belongs to.
    return await asyncio.to_thread(_query_subcollection_sync, uid, dir_rel)


def _add_dir_to_zip(zf: zipfile.ZipFile, src_path: str, arc_root: Optional[str] = None) -> None:
    """Add a directory recursively to a zip file."""
    for root, dirs, files in os.walk(src_path, followlinks=True):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for file in files:
            full = os.path.join(root, file)
            rel_inside = os.path.relpath(full, os.path.dirname(src_path))
            if arc_root is not None:
                rel_inside = os.path.join(arc_root, rel_inside)
            zf.write(full, rel_inside)


def _sync_firestore_on_path_change(
    old_rel: str, new_rel: str, new_abs: str, *, include_descendants: bool = True
) -> None:
    """Sync Firestore after a rename or move.

    Enumerates the docs that actually exist under the old path instead of
    walking the moved tree on disk. Only tracked files have docs, and a
    directory-format ``.zarr`` contributes one doc for hundreds of thousands
    of files — the old walk did a Firestore read per file on disk, which for a
    folder of slides meant minutes of blocking calls and a matching bill.

    ``new_abs`` is accepted for call-site compatibility and no longer read.

    ``include_descendants=False`` skips the subtree query for a path that cannot
    have descendant docs — a directory-format ``.zarr`` store is deliberately
    tracked as a single doc (nothing lists, searches or backfills inside one),
    so enumerating it is two Firestore queries guaranteed to come back empty.
    """
    files_repo = FilesRepo()
    old_prefix = (old_rel or '').rstrip('/')
    new_prefix = (new_rel or '').rstrip('/')

    def _move_doc(old_r: str, new_r: str) -> None:
        old_id = build_file_id(old_r)
        new_id = build_file_id(new_r)
        doc = files_repo.get_file(old_id)
        if not doc:
            return
        updated = {**doc, 'localPath': new_r, 'fileName': os.path.basename(new_r)}
        updated.pop('id', None)
        files_repo.upsert_file(new_id, updated)
        if old_id != new_id:
            files_repo.delete_file(old_id)

    # Materialize the descendant list before writing anything — the writes
    # below delete docs the query would otherwise still be streaming.
    descendants: List[str] = []
    try:
        subtree = (
            files_repo.iter_subtree_by_prefix(old_prefix) if include_descendants else ()
        )
        for doc in subtree:
            child_old_r = str(doc.get('localPath') or '')
            if child_old_r.startswith(old_prefix + '/'):
                descendants.append(child_old_r)
    except Exception as e:
        logger.warning(f"Failed to enumerate Firestore subtree for {old_prefix}: {e}")

    try:
        _move_doc(old_rel, new_rel)
    except Exception as e:
        logger.warning(f"Failed to sync Firestore doc for {old_rel} -> {new_rel}: {e}")

    for child_old_r in descendants:
        child_new_r = new_prefix + child_old_r[len(old_prefix):]
        try:
            _move_doc(child_old_r, child_new_r)
        except Exception as e:
            logger.warning(f"Failed to sync Firestore for child {child_old_r}: {e}")


async def get_config(auth_user: AuthUser | None = None):
    """Returns backend configuration for the file manager, including defaultPath.

    - If authenticated: defaultPath = f"users/{uid}"
    - If not: defaultPath = "samples"
    Ensures the folder exists. All paths use forward slashes for web.
    """
    # Determine default relative path
    default_rel = f"users/{auth_user.uid}" if auth_user and getattr(auth_user, 'uid', None) else "samples"
    abs_default = resolve_path(default_rel)
    uid = getattr(auth_user, 'uid', None) if auth_user else None

    def _ensure_default_folder() -> None:
        try:
            os.makedirs(abs_default, exist_ok=True)
        except Exception as e:
            logger.warning(f"Failed to ensure default folder exists at {abs_default}: {e}")

    def _quota() -> Optional[int]:
        return get_user_storage_quota_bytes(auth_user) if auth_user else None

    def _usage() -> int:
        if not uid:
            return 0
        try:
            # Summed from the file table (Firestore users/{uid}/files) rather
            # than by walking the storage tree — os.walk over a mounted bucket
            # with large directory-format datasets (zarr) can take minutes.
            return get_user_storage_usage_bytes(uid)
        except Exception:
            return 0

    # This is the first call after sign-in, and all three pieces block: two
    # Firestore round trips and a mkdir that lands on a mounted bucket. Run
    # inline they would hold the event loop — freezing every other request for
    # the duration — and they would run one after another for no reason.
    # Nothing here depends on anything else here.
    _, storage_quota, storage_usage = await asyncio.gather(
        asyncio.to_thread(_ensure_default_folder),
        asyncio.to_thread(_quota),
        asyncio.to_thread(_usage),
    )

    return JSONResponse(content={
        # Don't expose the full storage root path for security reasons
        # "storageRoot": web_friendly_root,
        "defaultPath": default_rel.replace('\\', '/'),
        "storageUsage": storage_usage,
        "storageQuota": storage_quota,
        "virtualLinks": get_public_virtual_links()
    })


def is_inside_zarr_store(rel_path: str) -> bool:
    """True when any segment of ``rel_path`` is a directory-format ``.zarr`` store.

    A store is a directory on disk but one opaque file everywhere else — never
    navigated into, folded onto its slide in listings, sorted and typed as a
    file. Anything moved inside one is stranded in a directory nothing will list.
    """
    return any(
        listing_view.is_zarr_dir(part)
        for part in (rel_path or '').replace('\\', '/').split('/')
        if part
    )


def _entry_is_dir(entry: Optional[os.DirEntry]) -> bool:
    """``is_dir()`` off the warmed readdir, tolerating an entry that vanished."""
    if entry is None:
        return False
    try:
        return entry.is_dir()
    except OSError:
        return False


def _foldable_zarr_names(
    visible_items: List[str],
    dir_entries: Dict[str, os.DirEntry],
    group_zarr: bool,
) -> frozenset:
    """Names whose row the grouping step is certain to discard.

    Folding keeps only the store's path, so its size and mtime are stat'd and
    then thrown away — and roughly half a slide folder is stores.

    "Certain" is load-bearing: a row that escapes folding carrying a synthetic
    mtime of 0 sinks to the bottom of the listing. So the conditions match
    ``group_wsi_and_zarr`` exactly, including its ``not is_dir`` test (a
    *directory* named ``x.svs`` never enters its ``wsi_by_name``, so
    ``x.svs.zarr`` beside one is not folded), and its longest-prefix fallback is
    deliberately not reproduced — anything less than certain keeps its stat.
    """
    if not group_zarr:
        return frozenset()
    wsi_names = {
        name for name in visible_items
        if listing_view.is_wsi(name) and not _entry_is_dir(dir_entries.get(name))
    }
    if not wsi_names:
        return frozenset()
    return frozenset(
        name for name in visible_items
        if listing_view.is_zarr(name) and listing_view.wsi_base_name(name) in wsi_names
    )


def _build_listing_items(
    visible_items: List[str],
    hide_from_personal: Set[str],
    sub_meta: Optional[Dict[str, Dict[str, Any]]],
    dir_entries: Dict[str, os.DirEntry],
    current_path: str,
    effective_rel: str,
    foldable_zarr: frozenset = frozenset(),
) -> List[Dict[str, Any]]:
    """Turn scanned names into listing rows. Runs in a worker thread.

    Every filesystem touch left in a listing lives here — the lazy ``stat`` for
    rows the subcollection does not cover, and the blocking ``fileSize`` backfill
    it can trigger — which is why the caller hands the whole loop to a thread
    rather than running it on the event loop.
    """
    items: List[Dict[str, Any]] = []
    for name in visible_items:
        if name in hide_from_personal:
            continue
        if sub_meta is not None and name in sub_meta:
            meta = sub_meta[name]
            full_path = os.path.join(current_path, name)
            # The subcollection now contains docs for:
            #   - regular files owned by this user (the original case)
            #   - share/collaborate UMBRELLA roots in the recipient's tree
            #     (isShareRoot=True)
            #   - the sharer's OWN source path once it's been shared
            #     with someone (the doc carries sharedWith=[recipient])
            # The third case represents a real on-disk directory, so we
            # MUST NOT synthesize a file entry for it. Falling back to
            # get_file_details is correct for both folder-shaped cases.
            is_share_root = bool(meta.get('isShareRoot'))
            scanned = dir_entries.get(name)
            is_real_dir = scanned.is_dir() if scanned else os.path.isdir(full_path)
            if is_share_root or is_real_dir:
                detail = get_file_details(full_path, dir_entries.get(name))
                if detail:
                    # Directory-format .zarr stays size 0 / uncounted
                    # (frontend shows "—"). Do not use inode st_size.
                    if _is_zarr_dir_name(name):
                        detail['size'] = 0
                        detail['etag'] = None
                    if meta.get('linkedFrom'):
                        detail['linkedFrom'] = meta['linkedFrom']
                    if meta.get('sharedBy'):
                        detail['sharedBy'] = meta['sharedBy']
                    if meta.get('shareMode'):
                        detail['shareMode'] = meta['shareMode']
                    items.append(detail)
                continue
            # Firestore fileSize=0 is common when writers bypass the upload
            # path (workflow saves, incomplete docs, etc.). Re-stat so the
            # FM doesn't keep showing "0 B" for real WSI/files on disk.
            # Directory .zarr never reaches here (is_real_dir above).
            meta_size = int(meta.get('size') or 0)
            if meta_size <= 0:
                detail = get_file_details(full_path, dir_entries.get(name))
                if detail and not detail.get('is_dir'):
                    detail['path'] = f"{effective_rel}/{name}"
                    if meta.get('linkedFrom'):
                        detail['linkedFrom'] = meta['linkedFrom']
                    if meta.get('sharedBy'):
                        detail['sharedBy'] = meta['sharedBy']
                    if meta.get('shareMode'):
                        detail['shareMode'] = meta['shareMode']
                    items.append(detail)
                    disk_size = int(detail.get('size') or 0)
                    if disk_size > 0:
                        _backfill_file_size_from_disk(full_path, disk_size)
                    continue
                # stat failed or path is unexpectedly a dir — fall through
                # to meta entry rather than dropping the row.
            etag = (
                f"W/\"{meta['size']}-{int(meta['mtime'] * 1000)}\""
                if meta.get('size') and meta.get('mtime')
                else None
            )
            entry = {
                'name': name,
                'path': f"{effective_rel}/{name}",
                'is_dir': False,
                'size': meta.get('size') or 0,
                'mtime': meta.get('mtime') or 0,
                'etag': etag,
            }
            if meta.get('linkedFrom'):
                entry['linkedFrom'] = meta['linkedFrom']
            if meta.get('sharedBy'):
                entry['sharedBy'] = meta['sharedBy']
            if meta.get('shareMode'):
                entry['shareMode'] = meta['shareMode']
            items.append(entry)
        elif name in foldable_zarr:
            # Folded onto its slide below; only `path` is read from this row.
            scanned = dir_entries.get(name)
            items.append({
                'name': name,
                'path': f"{effective_rel}/{name}",
                'is_dir': scanned.is_dir() if scanned else _is_zarr_dir_name(name),
                'size': 0,
                'mtime': 0,
                'etag': None,
            })
        else:
            detail = get_file_details(
                os.path.join(current_path, name), dir_entries.get(name)
            )
            if detail:
                if _is_zarr_dir_name(name):
                    detail['size'] = 0
                    detail['etag'] = None
                items.append(detail)
    return items


async def list_files(
    path: str = "",
    auth_user: AuthUser | None = None,
    *,
    offset: int = 0,
    limit: Optional[int] = None,
    sort_by: str = "mtime",
    sort_dir: str = "desc",
    include_non_image: bool = True,
    group_zarr: bool = False,
    dirs_only: bool = False,
):
    """List files and directories relative to the storage root.

    If path is empty, fallback to user folder (authenticated) or samples (guest).
    Only shows files and directories the user has access to.
    Handles virtual path aliases and appends virtual children.

    For authenticated users browsing their own storage space, file metadata (size,
    mtime) is served from the Firestore users/{uid}/files subcollection via a
    ``parentPath`` equality query (direct children only). os.listdir() is always
    called as the source of truth for which items exist. Directories and files
    not yet in the subcollection fall back to os.stat() via get_file_details().

    Response shape depends on ``limit``:

    * ``limit`` set — ``{"items": [...], "pagination": {...}}``, with filtering,
      zarr grouping, sorting and slicing applied by :mod:`listing_view` so the
      client renders the page as-is instead of pulling the whole directory down
      to compute it. See that module for the client helpers this mirrors.
    * ``limit is None`` — a bare JSON array of the whole directory. Not a
      deprecated path: upload conflict detection needs every name in the target
      folder, and the viewer's folder browsers and the study page need whole
      listings too. Paginating those would be wrong, not merely slower.
    """
    try:
        effective_rel = path or (f"users/{auth_user.uid}" if auth_user and getattr(auth_user, 'uid', None) else "samples")

        # Validate user has access to the requested path (before resolving virtual)
        await assert_can_access_path_async(auth_user, effective_rel, "list")

        # Resolve virtual path to real storage path
        resolved_rel = resolve_virtual_path(effective_rel)
        current_path = resolve_path(resolved_rel)
        logger.info(f"Listing files for relative path: '{path}' -> virtual resolved: '{resolved_rel}' -> absolute: '{current_path}'")

        virtual_children = get_virtual_children(effective_rel)

        # Allow virtual public roots like `samples` to exist purely as a container
        # for synthetic child entries (for example `samples/Data` -> `/data/public`).
        # If the physical directory is absent but virtual children are configured,
        # return those children instead of failing with RESOURCE_NOT_FOUND.
        has_real_directory = os.path.exists(current_path) and os.path.isdir(current_path)
        if not has_real_directory and not virtual_children:
            raise AppErrors.RESOURCE_NOT_FOUND()

        # Get all items and filter out hidden files/folders (starting with .).
        # One thread hop covers the readdir, every entry's stat, and the
        # upload-session scan, so the loop below touches no filesystem.
        #
        # The disk scan and the Firestore query need nothing from each other and
        # both are latency-dominated, so issue them together rather than paying
        # for each in series.
        def _scan():
            return (
                scan_directory_entries(current_path),
                fm_upload.active_upload_basenames_in_directory(current_path),
            )

        async def _scan_disk():
            return await asyncio.to_thread(_scan) if has_real_directory else ({}, set())

        # Attempt subcollection metadata lookup to avoid os.stat for files.
        # Only applies to authenticated, non-anonymous users browsing their own storage space.
        # Directories are always resolved via disk (no subcollection docs exist for them).
        async def _query_meta():
            if not auth_user or getattr(auth_user, 'is_anonymous', True):
                return None
            user_prefix = f"users/{auth_user.uid}"
            if effective_rel != user_prefix and not effective_rel.startswith(user_prefix + '/'):
                return None
            return await _query_subcollection_for_listing(auth_user.uid, resolved_rel)

        # gather(return_exceptions=True) so a failure on one side is handed back
        # rather than left as an unretrieved task exception on the other.
        scan_result, meta_result = await asyncio.gather(
            _scan_disk(), _query_meta(), return_exceptions=True
        )
        if isinstance(scan_result, BaseException):
            raise scan_result
        dir_entries, uploading_names = scan_result
        # The metadata query is an optimisation; falling back to os.stat via
        # get_file_details is correct, just slower.
        sub_meta: Optional[Dict[str, Dict[str, Any]]] = None
        if isinstance(meta_result, BaseException):
            logger.warning(f"[list_files] subcollection lookup failed for {resolved_rel}: {meta_result}")
        else:
            sub_meta = meta_result

        visible_items = [name for name in dir_entries if not name.startswith('.')]
        if uploading_names:
            visible_items = [name for name in visible_items if name not in uploading_names]
        if dirs_only:
            # Narrowing here rather than after the rows are built costs a stat
            # per FOLDER instead of per entry; `is_dir()` already rode in on the
            # readdir. build_listing_view still applies the same predicate.
            visible_items = [
                name for name in visible_items
                if _entry_is_dir(dir_entries.get(name)) and not listing_view.is_zarr(name)
            ]

        # Personal root listing: Viewer / Editor umbrellas live on disk under
        # users/<uid>/ and are listed here as well as under "Shared with me";
        # their ``shareMode`` / ``sharedBy`` ride along so the client badges
        # them and keeps Viewer read-only. Only the ``.zarr`` companion of a
        # single-file view share is hidden (surfaced as a badge on the slide).
        listing_personal_root = (
            auth_user
            and not getattr(auth_user, 'is_anonymous', True)
            and effective_rel == f"users/{auth_user.uid}"
        )
        hide_from_personal: Set[str] = set()
        if listing_personal_root:
            hide_from_personal = _hidden_names_for_personal_root(sub_meta)
        items = await asyncio.to_thread(
            _build_listing_items,
            visible_items,
            hide_from_personal,
            sub_meta,
            dir_entries,
            current_path,
            effective_rel,
            _foldable_zarr_names(visible_items, dir_entries, group_zarr and not dirs_only),
        )

        # If browsing through a virtual alias, rewrite returned paths so the client stays in the alias
        # For absolute target paths (like /data), get_file_details returns paths relative to STORAGE_ROOT
        # which creates directory traversal paths like ../../data/file - we need to rebuild these properly
        if effective_rel != resolved_rel and is_virtual_path(effective_rel):
            for item in items:
                item_name = item.get("name", "")
                if not item_name:
                    continue
                item_name = os.path.basename(item_name)
                item["path"] = f"{effective_rel}/{item_name}"

        # Add virtual children if any exist for this directory
        for virtual_link in virtual_children:
            # Create synthetic directory entry for the virtual link
            virtual_entry = {
                "name": virtual_link['display_name'],
                "path": virtual_link['alias'],  # Use alias as the path
                "is_dir": True,
                "size": 0,
                "mtime": 0,  # Virtual entries have no real mtime
                "etag": None,
                "is_virtual": True,  # Mark as virtual for client awareness
            }
            items.append(virtual_entry)

        if limit is None and not dirs_only:
            return JSONResponse(content=items)

        return JSONResponse(content=listing_view.build_listing_view(
            items,
            offset=offset,
            limit=limit,
            sort_by=sort_by,
            sort_dir=sort_dir,
            include_non_image=include_non_image,
            group_zarr=group_zarr,
            dirs_only=dirs_only,
        ))
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error listing files for relative path '{path}': {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


async def create_download_link_endpoint(path: str, auth_user: AuthUser | None = None):
    """Create a temporary download link for a file.

    Returns a token that can be used to download the file without authentication.
    The link expires after 1 hour by default.
    Only allows creating download links for files the user has access to.
    Handles virtual path aliases.
    """
    try:
        # Expiry is swept hourly by start_cleanup_scheduler(). Doing it here as
        # well meant every single link creation globbed the whole links dir and
        # json-parsed each file, synchronously, on the event loop — with one
        # uvicorn worker that stalled every other user's request.
        rel = normalize_rel_path(path)
        await assert_can_extract_path_async(auth_user, rel, "download-link")

        # Validate user has access to the file (before resolving virtual)
        await assert_can_access_path_async(auth_user, rel, "download-link")

        # Disallow access to hidden temp chunk dir
        if rel.startswith('.temp_chunks') or '/.temp_chunks/' in rel:
            raise AppErrors.USER_FORBIDDEN()

        # Resolve virtual path to real storage path
        resolved_rel = resolve_virtual_path(rel)

        abs_path = resolve_path(resolved_rel)
        if fm_upload.is_active_upload_destination(abs_path):
            raise AppErrors.RESOURCE_NOT_FOUND()

        # Create download link using resolved path
        token = create_download_link(resolved_rel, auth_user, purpose="download")

        # Compute size and weak ETag for convenience
        try:
            st = os.stat(abs_path)
            size = st.st_size
            etag = None if os.path.isdir(abs_path) else f"W/\"{size}-{int(st.st_mtime * 1000)}\""
        except Exception:
            size = None
            etag = None

        return JSONResponse(content={
            "success": True,
            "download_token": token,
            "expires_in": DOWNLOAD_LINK_EXPIRY_HOURS * 3600,  # seconds
            "expires_at": time.time() + (DOWNLOAD_LINK_EXPIRY_HOURS * 3600),
            "size": size,
            "etag": etag,
        })
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating download link for '{path}': {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


async def create_view_link_endpoint(path: str, auth_user: AuthUser | None = None):
    """Create a temporary in-viewer load link (read ACL, radiology formats only).

    Used by Niivue and similar renderers that must fetch bytes to display the
    volume, without treating the operation as an extract/download.
    """
    try:
        # See create_download_link_endpoint — expiry is the scheduler's job.
        rel = normalize_rel_path(path)
        if not _is_view_link_allowed_path(rel):
            raise AppErrors.PARAMS_ERROR(
                "View links are limited to radiology volume formats."
            )
        await assert_can_access_path_async(auth_user, rel, "view-link")
        if rel.startswith('.temp_chunks') or '/.temp_chunks/' in rel:
            raise AppErrors.USER_FORBIDDEN()
        resolved_rel = resolve_virtual_path(rel)
        abs_path = resolve_path(resolved_rel)
        if fm_upload.is_active_upload_destination(abs_path):
            raise AppErrors.RESOURCE_NOT_FOUND()
        token = create_download_link(resolved_rel, auth_user, purpose="view")
        try:
            st = os.stat(abs_path)
            size = st.st_size
            etag = None if os.path.isdir(abs_path) else f"W/\"{size}-{int(st.st_mtime * 1000)}\""
        except Exception:
            size = None
            etag = None
        return JSONResponse(content={
            "success": True,
            "download_token": token,
            "expires_in": DOWNLOAD_LINK_EXPIRY_HOURS * 3600,
            "expires_at": time.time() + (DOWNLOAD_LINK_EXPIRY_HOURS * 3600),
            "size": size,
            "etag": etag,
            "purpose": "view",
        })
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating view link for '{path}': {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


async def download_file_direct(token: str, request: Request):
    """Download a file using a direct link token (no authentication required).
    
    This endpoint allows downloading files using a temporary token generated by
    the create_download_link_endpoint. The token expires after a set time.
    For .zarr directories, streams zip on-the-fly without persisting zip in storage (Google Drive style).
    """
    try:
        # Validate token and get link data
        link_data = validate_download_token(token)

        # Get file path from link data
        file_path = link_data.get("file_path")
        if not file_path:
            raise AppErrors.RESOURCE_NOT_FOUND()

        # Resolve and validate path
        abs_path = resolve_path(file_path)
        if not os.path.exists(abs_path):
            raise AppErrors.RESOURCE_NOT_FOUND()
        if fm_upload.is_active_upload_destination(abs_path):
            raise AppErrors.RESOURCE_NOT_FOUND()

        stream_as_zip = link_data.get("stream_as_zip", False)
        filename = link_data.get("filename") or os.path.basename(abs_path) or "download"

        if stream_as_zip and os.path.isdir(abs_path):
            # Zarr directory: create zip in temp file, stream, then delete after send (no persistence in user storage)
            with tempfile.NamedTemporaryFile(
                suffix=".zip", delete=False, dir=tempfile.gettempdir()
            ) as tmp:
                tmp_path = tmp.name
            with zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                _add_dir_to_zip(zf, abs_path)

            def _cleanup_temp(path: str) -> None:
                try:
                    if path and os.path.exists(path):
                        os.unlink(path)
                except Exception as e:
                    logger.warning(f"Failed to remove temp zip {path}: {e}")

            return FileResponse(
                tmp_path,
                media_type="application/zip",
                filename=filename,
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
                background=BackgroundTask(_cleanup_temp, tmp_path),
            )

        if os.path.isdir(abs_path):
            raise AppErrors.PARAMS_ERROR("Cannot download a directory")

        # Regular file download
        headers = {}
        try:
            st = os.stat(abs_path)
            etag_value = f'W/"{st.st_size}-{int(st.st_mtime * 1000)}"'
            headers["ETag"] = etag_value
            inm = request.headers.get("if-none-match")
            if inm and inm.strip() == etag_value:
                return Response(status_code=304, headers=headers)
        except Exception:
            pass

        return FileResponse(
            abs_path,
            media_type="application/octet-stream",
            filename=filename,
            headers=headers,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error downloading file with token '{token}': {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


# Service directories that never hold user-visible files. Hidden names are
# pruned wholesale, so this only names the ones worth calling out.
SEARCH_SKIP_DIR_NAMES = frozenset({'.temp_chunks', '.download_links'})
# A guard against a pathological response size, not a page size — the walk
# costs the same either way, so capping low would just hide real matches. When
# it does bite, the response carries X-Search-Truncated so the client can say
# so instead of quietly showing a short list.
SEARCH_MAX_RESULTS = 5000


def _search_files_sync(lower_query: str, accessible_paths: List[str]) -> List[Dict[str, Any]]:
    """Blocking filesystem walk behind ``search_files`` — call via to_thread.

    Directory-format ``.zarr`` stores match by name but are never descended
    into: one WSI pyramid holds tens of thousands of chunk files whose names
    ('0.0.0', '.zarray') are noise, and walking them dominated the search.

    Uses an explicit ``os.scandir`` stack rather than ``os.walk`` so each entry
    carries its type and a cached stat — a hit costs no extra syscall to
    describe. Symlinks are not followed, matching ``os.walk``'s default and
    keeping the walk inside the roots the caller already cleared.
    """
    # Read the in-progress upload sessions once instead of re-parsing every
    # session JSON for each hit.
    upload_exact, upload_prefixes = fm_upload.active_upload_destination_roots()

    file_items: List[Dict[str, Any]] = []

    # Every visited entry is a descendant of a root already cleared by the
    # caller, so no per-item ACL re-check is needed — this matches how
    # list_files treats an accessible directory.
    for base_path in accessible_paths:
        if len(file_items) >= SEARCH_MAX_RESULTS:
            break
        base_abs_path = resolve_path(base_path)
        if not os.path.isdir(base_abs_path):
            continue

        stack = [base_abs_path]
        while stack and len(file_items) < SEARCH_MAX_RESULTS:
            current = stack.pop()
            try:
                with os.scandir(current) as it:
                    entries = list(it)
            except OSError as e:
                logger.debug(f"search: cannot read {current}: {e}")
                continue

            for entry in entries:
                if len(file_items) >= SEARCH_MAX_RESULTS:
                    break
                name = entry.name
                if name.startswith('.') or name in SEARCH_SKIP_DIR_NAMES:
                    continue

                try:
                    # follow_symlinks=False for the traversal decision, so a
                    # linked share is matched by name but not walked into.
                    is_real_dir = entry.is_dir(follow_symlinks=False)
                except OSError:
                    is_real_dir = False
                is_zarr_store = is_real_dir and _is_zarr_dir_name(name)
                if is_real_dir and not is_zarr_store:
                    # Queue before matching: a hit must not short-circuit the
                    # rest of the tree.
                    stack.append(entry.path)

                if lower_query not in name.lower():
                    continue
                if fm_upload.matches_upload_destination_roots(
                    entry.path, upload_exact, upload_prefixes
                ):
                    continue

                details = get_file_details(entry.path, entry)
                if not details:
                    continue
                if details.get('is_dir') and _is_zarr_dir_name(name):
                    # Same convention as list_files: directory .zarr is
                    # reported as size 0 rather than its inode size.
                    details['size'] = 0
                    details['etag'] = None
                file_items.append(details)

    if len(file_items) >= SEARCH_MAX_RESULTS:
        logger.info(
            f"search: capped at {SEARCH_MAX_RESULTS} results for {lower_query!r}"
        )

    # Sort for predictable order, especially useful for testing and debugging
    file_items.sort(key=lambda item: item.get('path') or '')

    return file_items


async def search_files(query: str, scope: Optional[str] = None, auth_user: AuthUser | None = None):
    """
    Recursively searches for files and folders matching the query within
    `scope` (when provided and accessible) or the user's accessible paths.
    Returns a flat list of matching items, capped at SEARCH_MAX_RESULTS.
    """
    try:
        lower_query = query.lower().strip()

        if not lower_query:
            return JSONResponse(content=[])

        # Pick the search roots. If the client passed a scope that the user
        # can actually access, search only there; otherwise fall back to
        # the user's accessible paths (own folder + samples).
        if scope and scope.strip():
            scope_rel = scope.strip()
            await assert_can_access_path_async(auth_user, scope_rel, "search")
            accessible_paths = [scope_rel]
        else:
            accessible_paths = get_accessible_paths_for_user(auth_user)

        # The walk is blocking I/O. Running it inline on the event loop meant
        # one search froze every other request on the server for its whole
        # duration — offload it like the other heavy FM endpoints do.
        file_items = await asyncio.to_thread(
            _search_files_sync, lower_query, accessible_paths
        )

        headers = {}
        if len(file_items) >= SEARCH_MAX_RESULTS:
            headers["X-Search-Truncated"] = "1"
        return JSONResponse(content=file_items, headers=headers)
    except HTTPException as e:
        raise e # Re-raise known HTTP exceptions
    except Exception as e:
        logger.error(f"Error during search for query '{query}': {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


async def create_item(req: FileOperationRequest, auth_user: AuthUser):
    """Create a file or folder using a relative path."""
    try:
        # Check if path is in a read-only directory (including virtual paths)
        if is_public_read_only_path(req.path):
            raise AppErrors.USER_FORBIDDEN()

        # Validate user has access to the parent directory
        parent_path = os.path.dirname(req.path)
        if parent_path and parent_path != req.path:
            await assert_writable_async(auth_user, parent_path)
        await assert_can_write_path_async(auth_user, req.path)

        target_path = resolve_path(req.path)
        if os.path.exists(target_path):
            raise AppErrors.PARAMS_ERROR("File or folder already exists.")

        if fm_upload.is_active_upload_destination(target_path):
            raise AppErrors.RESOURCE_CONFLICT(
                "Cannot create an item at a path with an upload in progress."
            )

        if req.path.endswith('/'):
            os.makedirs(target_path)
        else:
            with open(target_path, 'w') as f:
                if req.content:
                    f.write(req.content)

        return JSONResponse(content={"success": True, "message": f"'{req.path}' created."})
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error creating '{req.path}': {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


def _slide_sidecar_zarr(abs_path: str) -> Optional[str]:
    """Absolute path of the sibling ``<slide>.zarr`` store, when there is one.

    A slide's whole analysis (segmentation, classification, annotations) lives
    in that store, and the listing pairs the two by name — so a rename/move that
    takes only the slide orphans it: the store drops out of the slide's row and
    the next viewer open creates an empty one, which reads to the user as "my
    annotations are gone". Returns ``None`` for directories (a ``.zarr`` store
    itself included) and when no companion exists.
    """
    if os.path.isdir(abs_path):
        return None
    sidecar = abs_path + ".zarr"
    return sidecar if os.path.lexists(sidecar) else None


def _pick_move_destination(
    destination_folder: str, base_name: str, *, with_zarr: bool
) -> str:
    """Free destination path for a move, keeping the ``.zarr`` companion aligned.

    Suffixes ``_moved`` (then ``_moved(2)``, …) until the item name and — for a
    slide — its companion store name are both free. One ``_moved`` was not
    enough: a second collision landed on an existing path, and ``shutil.move``
    then moves a directory *inside* the destination instead of beside it.
    """
    name, ext = os.path.splitext(base_name)

    def _free(candidate: str) -> bool:
        target = os.path.join(destination_folder, candidate)
        if os.path.lexists(target):
            return False
        return not (with_zarr and os.path.lexists(target + ".zarr"))

    if _free(base_name):
        return os.path.join(destination_folder, base_name)
    counter = 1
    while True:
        suffix = "_moved" if counter == 1 else f"_moved({counter})"
        candidate = f"{name}{suffix}{ext}"
        if _free(candidate):
            return os.path.join(destination_folder, candidate)
        counter += 1


async def rename_item(req: FileOperationRequest, auth_user: AuthUser):
    """Rename a file or folder using relative paths."""
    try:
        # Check if source or destination is in a read-only directory (including virtual paths)
        if is_public_read_only_path(req.path):
            raise AppErrors.USER_FORBIDDEN()
        
        if req.new_path and is_public_read_only_path(req.new_path):
            raise AppErrors.USER_FORBIDDEN()

        # Validate user has access to both source and destination paths
        await assert_writable_async(auth_user, req.path)

        if not req.new_path:
            raise AppErrors.PARAMS_ERROR("new_path is required")

        # Split new_path into parent and basename
        new_parent = os.path.dirname(req.new_path)
        if new_parent and new_parent != req.path:
            await assert_writable_async(auth_user, new_parent)

        old_path = resolve_path(req.path)
        # Sanitize only the final segment of the new path to avoid introducing separators
        new_basename = os.path.basename(req.new_path)
        safe_basename = sanitize_filename(new_basename)
        sanitized_new_path_rel = os.path.join(new_parent, safe_basename).replace('\\', '/')
        new_path = resolve_path(sanitized_new_path_rel)

        if not os.path.exists(old_path):
            raise AppErrors.RESOURCE_NOT_FOUND()
        if os.path.exists(new_path):
            raise AppErrors.PARAMS_ERROR("Destination path already exists.")

        # Covers the path itself and anything under it, without walking it.
        if fm_upload.subtree_has_active_upload_destination(old_path):
            raise AppErrors.RESOURCE_CONFLICT(
                "Cannot rename an item that is currently being uploaded."
            )

        # A slide travels with its sibling ``<name>.zarr`` analysis store.
        old_zarr = _slide_sidecar_zarr(old_path)
        new_zarr = new_path + ".zarr" if old_zarr else None
        if old_zarr:
            if os.path.lexists(new_zarr):
                raise AppErrors.PARAMS_ERROR("Destination path already exists.")
            if fm_upload.subtree_has_active_upload_destination(old_zarr):
                raise AppErrors.RESOURCE_CONFLICT(
                    "Cannot rename an item that is currently being uploaded."
                )

        old_rel = normalize_rel_path(req.path)

        # Attempt to rename with better error handling
        # No up-front "is it in use?" probe: attempt the rename and classify
        # what the OS reports. Renaming a directory fails the same way when a
        # file inside it is held open, so this covers the folder case too —
        # without walking it.
        try:
            os.rename(old_path, new_path)
        except OSError as e:
            if is_path_busy_error(e):
                raise AppErrors.RESOURCE_CONFLICT(
                    f"Cannot rename '{os.path.basename(old_path)}' because it is being used by another process."
                )
            if is_permission_denied_error(e):
                raise AppErrors.USER_FORBIDDEN()
            raise AppErrors.SERVER_INTERNAL_ERROR()

        if old_zarr:
            try:
                os.rename(old_zarr, new_zarr)
            except OSError as e:
                # Never leave the pair split: put the slide back, then report.
                try:
                    os.rename(new_path, old_path)
                except OSError:
                    logger.error(
                        f"Renamed '{old_path}' but could not move its .zarr store "
                        f"or undo the rename; slide and store are now split."
                    )
                if is_path_busy_error(e):
                    raise AppErrors.RESOURCE_CONFLICT(
                        f"Cannot rename '{os.path.basename(old_path)}' because its "
                        f"analysis data is being used by another process."
                    )
                if is_permission_denied_error(e):
                    raise AppErrors.USER_FORBIDDEN()
                raise AppErrors.SERVER_INTERNAL_ERROR()

        try:
            # Blocking Firestore round-trips — keep them off the event loop.
            await asyncio.to_thread(
                _sync_firestore_on_path_change, old_rel, sanitized_new_path_rel, new_path
            )
            if old_zarr:
                await asyncio.to_thread(
                    functools.partial(
                        _sync_firestore_on_path_change,
                        old_rel + ".zarr",
                        sanitized_new_path_rel + ".zarr",
                        new_zarr,
                        include_descendants=False,
                    )
                )
        except Exception as _fe:
            logger.warning(f"Failed to sync Firestore after rename {old_rel} -> {sanitized_new_path_rel}: {_fe}")

        return JSONResponse(content={"success": True, "message": "Item renamed successfully.", "new_path": sanitized_new_path_rel})
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error renaming '{req.path}' to '{req.new_path}': {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


async def move_items(req: MoveRequest, auth_user: AuthUser):
    """Move files or folders using relative paths."""
    try:
        # Check if any source items are in read-only directories (including virtual paths)
        for item_path in req.items:
            if is_public_read_only_path(item_path):
                raise AppErrors.USER_FORBIDDEN()
        
        # Check if destination is in read-only directory (including virtual paths)
        if is_public_read_only_path(req.new_path):
            raise AppErrors.USER_FORBIDDEN()

        # Validate user has access to all source items.
        # Each item's guard walks Firestore, so a 50-file multi-select used to
        # be 50 serial ancestor walks on the event loop. Fan them out instead.
        await gather_guards(*(assert_writable_async(auth_user, p) for p in req.items))

        # Validate user has access to destination directory
        await assert_writable_async(auth_user, req.new_path)

        # A store passes the isdir() check below because it really is a
        # directory, but a file dropped into one is hidden for good. Moving OUT
        # stays allowed so anything already stranded can be recovered.
        if is_inside_zarr_store(req.new_path):
            raise AppErrors.PARAMS_ERROR(
                "Cannot move items into a .zarr store."
            )

        source_paths = [resolve_path(p) for p in req.items]
        destination_folder = resolve_path(req.new_path)

        if not os.path.isdir(destination_folder):
            raise AppErrors.PARAMS_ERROR("Destination is not a directory.")

        for item_path in source_paths:
            if not os.path.exists(item_path):
                continue
            # Covers the item and anything under it, without walking it.
            # The sidecar store moves with the slide, so it is checked too.
            sidecar = _slide_sidecar_zarr(item_path)
            for probe in (item_path, sidecar):
                if probe and fm_upload.subtree_has_active_upload_destination(probe):
                    raise AppErrors.RESOURCE_CONFLICT(
                        f"Cannot move '{os.path.basename(item_path)}' while it is being uploaded."
                    )

        # If all checks pass, proceed with moving
        for item_path in source_paths:
            if not os.path.exists(item_path):
                logger.warning(f"Item not found for moving, skipping: {item_path}")
                continue

            base_name = os.path.basename(item_path)
            # A slide travels with its sibling ``<name>.zarr`` analysis store, and
            # the destination is picked so both names stay free and aligned.
            sidecar = _slide_sidecar_zarr(item_path)
            destination_path = _pick_move_destination(
                destination_folder, base_name, with_zarr=sidecar is not None
            )

            old_rel = os.path.relpath(item_path, STORAGE_ROOT).replace('\\', '/')
            try:
                # A same-filesystem move is a rename, but a cross-device one
                # copies every byte — a folder of slides would otherwise hold
                # the event loop for the whole copy.
                await asyncio.to_thread(shutil.move, item_path, destination_path)
            except OSError as e:
                # Same attempt-then-classify contract as rename.
                if is_path_busy_error(e):
                    raise AppErrors.RESOURCE_CONFLICT(
                        f"Cannot move '{base_name}' because it is being used by another process."
                    )
                if is_permission_denied_error(e):
                    raise AppErrors.USER_FORBIDDEN()
                raise AppErrors.SERVER_INTERNAL_ERROR()

            dest_sidecar = destination_path + ".zarr" if sidecar else None
            if sidecar:
                try:
                    await asyncio.to_thread(shutil.move, sidecar, dest_sidecar)
                except OSError as e:
                    # Never leave the pair split: put the slide back, then report.
                    # A cross-device move copies before it deletes, so a failure
                    # can leave a half-written store at the destination — that
                    # partial copy has to go, or the next attempt uniquifies
                    # around it and the pair drifts apart anyway.
                    try:
                        if os.path.lexists(dest_sidecar):
                            await asyncio.to_thread(
                                shutil.rmtree, dest_sidecar, ignore_errors=True
                            )
                        await asyncio.to_thread(shutil.move, destination_path, item_path)
                    except OSError:
                        logger.error(
                            f"Moved '{item_path}' but could not move its .zarr store "
                            f"or undo the move; slide and store are now split."
                        )
                    if is_path_busy_error(e):
                        raise AppErrors.RESOURCE_CONFLICT(
                            f"Cannot move '{base_name}' because its analysis data is "
                            f"being used by another process."
                        )
                    if is_permission_denied_error(e):
                        raise AppErrors.USER_FORBIDDEN()
                    raise AppErrors.SERVER_INTERNAL_ERROR()

            new_rel = os.path.relpath(destination_path, STORAGE_ROOT).replace('\\', '/')
            try:
                await asyncio.to_thread(
                    _sync_firestore_on_path_change, old_rel, new_rel, destination_path
                )
                if sidecar:
                    await asyncio.to_thread(
                        functools.partial(
                            _sync_firestore_on_path_change,
                            old_rel + ".zarr",
                            new_rel + ".zarr",
                            dest_sidecar,
                            include_descendants=False,
                        )
                    )
            except Exception as _fe:
                logger.warning(f"Failed to sync Firestore after move {old_rel} -> {new_rel}: {_fe}")

        return JSONResponse(content={"success": True, "message": f"Items moved to '{req.new_path}'."})
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"Error moving items to '{req.new_path}': {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()


async def copy_file_to_personal(req: CopyToPersonalRequest, auth_user: AuthUser):
    """Copy a single slide file from the read-only ``samples/`` directory into the user's personal root.
    Only sources under ``samples/`` are allowed. Business logic (concurrency control, quota, I/O)
    is handled by CopyPersonalService.
    """
    from app.services.copy import get_copy_service, CopyBusyError
    service = get_copy_service()
    if req.link:
        result = await service.link_file(req.source_path, auth_user)
    else:
        result = await service.copy_file(
            req.source_path, auth_user, include_zarr=req.include_zarr
        )
    if isinstance(result, CopyBusyError):
        return AppResponse(
            code=503,
            message=result.message,
            data={
                "error_code": result.error_code,
                "retry_after": result.retry_after,
            },
        ).to_response()
    return success_response({
        "copied_path": result.destination,
        "destination": result.destination,
        "message": "Copied to Personal",
    })


async def copy_folder_to_personal(req: CopyToPersonalRequest, auth_user: AuthUser):
    """Recursively copy or symlink a folder from the read-only ``samples/``
    directory into the user's personal root.

    ``req.link`` toggles between byte-copy and symlink-based sharing
    (each slide gets a sparse ``.zarr`` overlay; linked sizes still count
    against quota via file-table docs).
    """
    from app.services.copy import get_copy_service, CopyBusyError
    service = get_copy_service()
    if req.link:
        result = await service.link_folder(req.source_path, auth_user)
    else:
        result = await service.copy_folder(
            req.source_path, auth_user, include_zarr=req.include_zarr
        )
    if isinstance(result, CopyBusyError):
        return AppResponse(
            code=503,
            message=result.message,
            data={
                "error_code": result.error_code,
                "retry_after": result.retry_after,
            },
        ).to_response()
    return success_response({
        "copied_path": result.destination,
        "destination": result.destination,
        "message": "Copied to Personal",
    })


# ===== Scan / Backfill API =====


async def refresh_file_metadata(req: RefreshMetadataRequest, auth_user: AuthUser):
    """Re-stat one or more files on disk and write the current size / mtime into
    the file table (global `files/{id}` + per-user `users/{uid}/files/{id}`).

    Use after any service writes a file directly to disk and bypasses the normal
    upload flow (workflow `save_classifier_path`, classifier_tasknode_save, etc.)
    so the web file manager doesn't keep showing a stale 0 / placeholder size.

    Only accepts paths the caller owns (anti-tamper). Best-effort per path —
    individual failures are reported, never raised.
    """
    raw_paths: List[str] = []
    if req.path:
        raw_paths.append(req.path)
    if req.paths:
        raw_paths.extend(p for p in req.paths if isinstance(p, str) and p)
    if not raw_paths:
        raise AppErrors.PARAMS_ERROR("path or paths is required")

    files_repo = FilesRepo()
    refreshed: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    # One read of the active upload sessions for the whole request, not one
    # per path in the batch.
    upload_exact, upload_prefixes = fm_upload.active_upload_destination_roots()

    for raw in raw_paths:
        try:
            # Storage-relative is the canonical form for ownership / access checks;
            # tolerate absolute paths under STORAGE_ROOT by relativising them.
            rel = raw.replace('\\', '/').strip()
            abs_path = resolve_path(rel)
            if os.path.isabs(rel):
                try:
                    rel = os.path.relpath(abs_path, STORAGE_ROOT).replace('\\', '/')
                except ValueError:
                    skipped.append({"path": raw, "reason": "outside_storage_root"})
                    continue

            if is_public_read_only_path(rel):
                skipped.append({"path": raw, "reason": "read_only"})
                continue
            # Sync on purpose: this whole loop is blocking anyway (os.stat plus a
            # Firestore write per item). Threading only the guard would buy
            # nothing; if this ever matters, the loop body moves to a thread.
            if not validate_user_access_to_path(auth_user, rel):
                skipped.append({"path": raw, "reason": "forbidden"})
                continue
            if not os.path.isfile(abs_path):
                skipped.append({"path": raw, "reason": "not_a_file"})
                continue
            if fm_upload.matches_upload_destination_roots(
                abs_path, upload_exact, upload_prefixes
            ):
                skipped.append({"path": raw, "reason": "upload_in_progress"})
                continue

            try:
                size = os.path.getsize(abs_path)
                mtime = os.path.getmtime(abs_path)
            except OSError as e:
                skipped.append({"path": raw, "reason": f"stat_failed: {e}"})
                continue

            # Derive owner from the storage-relative path. Only files under
            # `users/<uid>/...` have a per-user subcollection target; other paths
            # (samples, shared) still update the global doc.
            parts = rel.split('/', 2)
            owner_id = parts[1] if len(parts) >= 2 and parts[0] == 'users' else ''

            file_id = build_file_id(rel)
            payload: Dict[str, Any] = {
                'fileName': os.path.basename(abs_path),
                'localPath': rel,
                'fileSize': size,
            }
            if owner_id:
                payload['ownerId'] = owner_id

            files_repo.upsert_file(file_id, payload)
            refreshed.append({"path": rel, "size": size, "mtime": mtime})
        except Exception as e:
            logger.warning(f"refresh_file_metadata: failed for {raw!r}: {e}")
            skipped.append({"path": raw, "reason": str(e)})

    return JSONResponse(content={"success": True, "refreshed": refreshed, "skipped": skipped})
