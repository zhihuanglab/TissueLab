"""Copy-to-personal service.

Copies slide data files/folders from the read-only ``samples/`` directory into
a user's personal root directory.

Concurrency model
-----------------
An ``asyncio.Semaphore`` (non-blocking for the event loop) limits simultaneous
heavy-copy operations to ``_COPY_CONCURRENCY``.  When the semaphore cannot be
acquired within ``_COPY_QUEUE_TIMEOUT`` seconds, a ``CopyBusyError`` is returned
so the caller can surface a 503 + Retry-After response.

All blocking I/O (shutil copy, directory size walk) is offloaded to the
default thread-pool via ``asyncio.to_thread`` so the event loop is never stalled.

Allowed source paths
--------------------
The source must reside under ``samples/``.  Any other path is rejected with
a 400 error before validation or I/O is attempted.

Slide format allowlist
----------------------
When recursively copying a folder only files whose extension matches
``SLIDE_EXTENSIONS`` are included.  Derived artifacts such as ``.zarr``
directories are silently skipped.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import stat
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import AsyncIterator, Callable, Dict, FrozenSet, List, Optional, Set

from app.core.auth import AuthUser
from app.core.errors import AppError, AppErrors
from app.config.path_config import PUBLIC_VIRTUAL_LINKS, resolve_virtual_path
from app.utils import resolve_path
from app.repos.files import FilesRepo
from app.services.file_manager.common import (
    build_file_id,
    path_involves_symlink_async,
    calculate_directory_size_bytes,
    get_user_root_path,
    get_user_storage_quota_bytes,
    get_user_storage_usage_bytes,
    normalize_rel_path,
    validate_user_access_to_path_async,
)
from app.services.symlinks import symlink_relative

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Concurrency constants
# ---------------------------------------------------------------------------

_COPY_CONCURRENCY = 2      # Max simultaneous copy operations
_COPY_QUEUE_TIMEOUT = 60   # Seconds to wait for a free slot before giving up
# When materializing a folder/cohort link, cap the per-request fan-out so a
# single 100-patient link doesn't monopolize the default thread pool.
_LINK_SUB_CONCURRENCY = 8
_COPY_RETRY_AFTER = 10     # Retry-After header value returned to the client

# asyncio.Semaphore is event-loop-safe; it never blocks the thread.
_COPY_SEMAPHORE = asyncio.Semaphore(_COPY_CONCURRENCY)

# ---------------------------------------------------------------------------
# Destination-name reservation
# ---------------------------------------------------------------------------
#
# _COPY_SEMAPHORE admits _COPY_CONCURRENCY callers at once, so "pick a free
# name, then create it" was never atomic: the create happens in a worker thread
# after an await, so two requests carrying the same source name both saw the
# name free and picked the same destination. The single-file paths then wrote
# over each other, and the folder paths were worse — the loser's copytree
# raised FileExistsError and its rollback rmtree'd the winner's half-written
# tree.
#
# A name is now chosen and marked in-flight under a per-destination-root lock,
# and stays reserved until materialization finishes; the pickers treat a
# reserved name as taken, so the second request uniquifies past it.
_DEST_LOCK_STRIPES = 64
# Built on first use inside the running loop, never at import: an asyncio.Lock
# binds to the loop that first awaits it and refuses every other one, so a
# module-level pool is poisoned for anything that runs a loop of its own.
_DEST_LOCKS: List[asyncio.Lock] = []
_DEST_LOCKS_LOOP: Optional[asyncio.AbstractEventLoop] = None
_DEST_RESERVED: Dict[str, Set[str]] = {}


def _dest_root_key(root: str) -> str:
    return os.path.normcase(os.path.abspath(root))


def _fold(name: str) -> str:
    """Key a reserved name the way a case-folding filesystem sees it.

    The reservation is an in-memory approximation of a question only the
    filesystem can answer — "is this name taken?" — and the two directions of
    error are not equal:

    * over-reserving (holding ``a.svs`` because ``A.svs`` is in flight) costs a
      needless ``(1)`` suffix, and on the private-copy share path it can make a
      re-share miss the recipient's leftover overlay and start a fresh one;
    * under-reserving costs a **silent overwrite** on macOS/Windows and on any
      case-insensitive mount, where those two names are one file.

    So the approximation deliberately errs wide, rather than trying to detect
    per-volume case sensitivity. Both errors are confined to the window where
    two copies of names differing only in case are in flight at once.

    ``os.path.normcase`` is not usable here: it does not fold case on macOS.
    """
    return name.casefold()


def _dest_lock(key: str) -> asyncio.Lock:
    """One of a fixed pool of pick locks, chosen by hash of the destination root.

    A dict keyed by root would grow by one Lock for every user who ever copied
    or received a share, and reclaiming those safely needs refcounting that
    accounts for waiters as well as holders. A fixed pool cannot grow at all.
    Two roots occasionally share a stripe and serialize on each other's pick —
    a handful of stats — and with _COPY_CONCURRENCY at 2 that is rare and cheap.

    Copies all run on the service's request loop; the loop check exists so a
    second loop gets its own pool instead of a "bound to a different event loop"
    error, not because two loops are expected to copy at once.
    """
    global _DEST_LOCKS_LOOP
    loop = asyncio.get_running_loop()
    if loop is not _DEST_LOCKS_LOOP:
        _DEST_LOCKS_LOOP = loop
        _DEST_LOCKS[:] = [asyncio.Lock() for _ in range(_DEST_LOCK_STRIPES)]
    return _DEST_LOCKS[hash(key) % _DEST_LOCK_STRIPES]


@asynccontextmanager
async def _reserve_dest_name(
    root: str, pick: Callable[[FrozenSet[str]], str]
) -> AsyncIterator[str]:
    """Pick a destination name under *root* and hold it for the whole copy.

    *pick* receives the names currently reserved by other in-flight copies and
    must return a name that is free of both those and the on-disk contents.
    Only the pick runs under the lock — the copy itself does not, so two
    unrelated destinations still proceed concurrently.

    The pick runs in a thread: it stats the destination directory, and for a
    folder share it can walk a revoke shell (_folder_is_revoked_private_copy_shell).
    That is unbounded work, and the lock would hold it in front of the event
    loop. One thread hop against an operation that then copies for seconds.
    """
    key = _dest_root_key(root)
    async with _dest_lock(key):
        # Snapshot for the picker, then look the bucket up again after the await.
        # The pick runs in a thread, so it suspends; a release in that window
        # empties the bucket and drops it from the table. Holding a reference
        # across the await meant add()ing into a set nobody could see any more,
        # and the next copy then picked the same name — two copies, one
        # destination, silently. Nothing is created before the pick, so a picker
        # that raises leaves no empty bucket behind either.
        name = await asyncio.to_thread(
            pick, frozenset(_DEST_RESERVED.get(key) or ())
        )
        _DEST_RESERVED.setdefault(key, set()).add(_fold(name))
    try:
        yield name
    finally:
        # Deliberately not awaiting anything: this runs in a finally, and a
        # cancelled copy must still give its name back.
        reserved = _DEST_RESERVED.get(key)
        if reserved is not None:
            reserved.discard(_fold(name))
            if not reserved:
                _DEST_RESERVED.pop(key, None)

# ---------------------------------------------------------------------------
# Slide format allowlist
# ---------------------------------------------------------------------------

SLIDE_EXTENSIONS: frozenset[str] = frozenset({
    ".svs",
    ".tif",
    ".tiff",
    ".ndpi",
    ".vsi",
    ".scn",
    ".czi",
    ".lif",
    ".qptiff",
    ".btf",
    ".dcm",
    ".mrxs",
    ".isyntax",
})

# Directories to always skip during recursive copy (analysis outputs, caches, etc.)
_SKIP_DIR_SUFFIXES: tuple[str, ...] = (".zarr", ".cache", ".pyramids")

# Zarr child-groups that are PURE read-only inputs during downstream analysis
# and large enough to be worth sharing rather than duplicating. These hold the
# precomputed segmentation + embedding tensors the classifier only reads:
#   - ``Cell-Segmentation``  : centroids/contours/embeddings for NucleiClassify
#   - ``Patch-Segmentation`` : patch coordinates/embeddings for TissueClassify
# Symlinking these reuses the multi-GB stores in place instead of copying them.
#
# Everything ELSE the source zarr contains (Cell-Classification /
# Patch-Classification / User-Annotations / arbitrary other groups) is SKIPPED
# entirely by the overlay builder — the recipient starts with a blank slate and
# produces their own annotations/classifications, no leakage of the sharer's
# downstream state.
#
# SAFETY — read this before adding a name:
#   Only list groups the recipient's analysis NEVER writes. A symlinked group
#   points at the shared source on disk, so any write/delete THROUGH the link
#   would mutate that source. Classification/annotation tasknodes write to
#   ``Cell-Classification`` / ``Patch-Classification`` / ``User-Annotations``
#   — those MUST stay out of this set.
#
#   Re-running an UPSTREAM node (e.g. segmentation, which writes
#   ``Cell-Segmentation``) on an overlay would write through the symlink; that
#   is not a supported operation on a linked sample. Mounting the source folder
#   read-only at the OS level neutralises this entirely (EROFS on write-through).
_OVERLAY_SYMLINK_GROUPS: frozenset[str] = frozenset({"Cell-Segmentation", "Patch-Segmentation"})


def _is_zarr_directory(path: str) -> bool:
    """True for a real zarr dir or a (possibly file-typed) symlink to one."""
    try:
        if os.path.isdir(path):
            return True
        if os.path.lexists(path):
            return os.path.isdir(os.path.realpath(path))
    except OSError:
        return False
    return False


def _slide_only_ignore(directory: str, contents: list[str]) -> set[str]:
    """``shutil.copytree`` ignore callable.

    Skips anything that is not a recognised slide file, and skips known
    analysis-output directories (e.g. ``.zarr``).
    """
    ignored: set[str] = set()
    for name in contents:
        full = os.path.join(directory, name)
        if os.path.isdir(full):
            if any(name.endswith(suffix) for suffix in _SKIP_DIR_SUFFIXES):
                ignored.add(name)
        else:
            _, ext = os.path.splitext(name)
            if ext.lower() not in SLIDE_EXTENSIONS:
                ignored.add(name)
    return ignored


def _dir_size(path: str) -> int:
    """Total byte size of a directory tree (best-effort; skips unreadable files)."""
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def _copy_sibling_zarrs(src_dir: str, dst_dir: str) -> None:
    """Copy every ``*.zarr`` store under *src_dir* into *dst_dir* at the same
    relative path (the folder copy already mirrored the slide layout there).

    Used by the ``include_zarr`` copy path so the recipient gets the full
    precomputed analysis (Cell-Classification etc.), not just the WSI. We copy
    each ``.zarr`` whole via ``copytree`` and do NOT descend into it (its chunk
    files aren't slide files and would otherwise be walked needlessly). Other
    derived dirs (.cache/.pyramids) stay skipped.
    """
    for root, dirs, _files in os.walk(src_dir):
        keep: list[str] = []
        for d in dirs:
            if d.endswith(".zarr"):
                src = os.path.join(root, d)
                rel = os.path.relpath(src, src_dir)
                dst = os.path.join(dst_dir, rel)
                if not os.path.exists(dst):
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copytree(src, dst)
                # don't recurse into the store's internals
            elif any(d.endswith(s) for s in _SKIP_DIR_SUFFIXES):
                pass  # skip .cache/.pyramids (and any other .zarr handled above)
            else:
                keep.append(d)
        dirs[:] = keep


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass
class CopyResult:
    """Returned on a successful copy."""
    destination: str   # Relative path of the newly created file/folder


@dataclass
class CopyBusyError:
    """Returned when the copy semaphore cannot be acquired within the timeout."""
    retry_after: int = field(default=_COPY_RETRY_AFTER)
    error_code: str = field(default="COPY_BUSY_RETRY")
    message: str = field(default="Copy queue is busy. Please retry shortly.")


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _uniquify_copy_name(
    directory: str,
    filename: str,
    extra_suffixes: tuple[str, ...] = (),
    reserved: FrozenSet[str] = frozenset(),
) -> str:
    """Return *filename* unchanged if neither it nor any companion artifact
    exists in *directory*; otherwise insert ``(1)``, ``(2)``, … before the
    extension until a free name is found.

    *reserved* are names another in-flight copy has already claimed under
    *directory* but has not created on disk yet — see :func:`_reserve_dest_name`.
    They are matched case-insensitively, folded or not (see :func:`_fold`).

    *extra_suffixes* are companion artifacts that must also be free for a
    candidate to be accepted. A slide passes ``(".zarr",)`` so the WSI and its
    overlay share one index: given ``A.svs`` and ``A(1).svs.zarr`` already in
    *directory*, the next name is ``A(2).svs`` (so its ``A(2).svs.zarr`` overlay
    is free too).

    Examples::

        slide.svs          -> slide.svs
        slide.svs (exists) -> slide(1).svs
    """
    name, ext = os.path.splitext(filename)
    reserved = {_fold(r) for r in reserved}

    def _taken(candidate: str) -> bool:
        # lexists: a broken leftover symlink still occupies the name.
        if _fold(candidate) in reserved or os.path.lexists(
            os.path.join(directory, candidate)
        ):
            return True
        return any(
            _fold(candidate + suffix) in reserved
            or os.path.lexists(os.path.join(directory, candidate + suffix))
            for suffix in extra_suffixes
        )

    candidate = filename
    counter = 1
    while _taken(candidate):
        candidate = f"{name}({counter}){ext}"
        counter += 1
    return candidate


def _pick_private_copy_dest_name(
    recipient_root: str,
    original_name: str,
    *,
    is_dir: bool,
    reserved: FrozenSet[str] = frozenset(),
) -> str:
    """Choose a destination name for Private-copy share, reclaiming revoke leftovers.

    After revoke we keep the recipient's ``.zarr`` overlay (classification) but
    remove the WSI symlink. A naive uniquify that treats leftover ``.zarr`` as
    a collision would create ``Slide(1).svs`` and orphan the old analysis.
    Reclaim the original name when the slide/folder slot itself is free (or is
    an existing revoke shell we can rematerialize into).
    """
    reserved = frozenset(_fold(r) for r in reserved)
    preferred = original_name
    if _fold(preferred) in reserved:
        # Another share is already materializing into this name.
        return _uniquify_copy_name(
            recipient_root, original_name, () if is_dir else (".zarr",), reserved
        )
    abs_preferred = os.path.join(recipient_root, preferred)
    # Broken leftovers (partial unshare) still occupy the name via lexists —
    # clear them so we reconnect to any sibling .zarr instead of uniquifying.
    if os.path.islink(abs_preferred) and not os.path.exists(abs_preferred):
        try:
            os.unlink(abs_preferred)
        except OSError as e:
            logger.warning(
                f"Failed to clear broken private-copy dest '{abs_preferred}': {e}"
            )
    if is_dir:
        if not os.path.lexists(abs_preferred):
            return preferred
        # Only reclaim a leftover revoke shell — never a personal folder that
        # happens to share the same name (would inject symlinks into it).
        if (
            os.path.isdir(abs_preferred)
            and not os.path.islink(abs_preferred)
            and _folder_is_revoked_private_copy_shell(abs_preferred)
        ):
            return preferred
        return _uniquify_copy_name(recipient_root, original_name, (), reserved)
    # Single slide: only the WSI path blocks reclaim; leftover ``.zarr`` is OK.
    if not os.path.lexists(abs_preferred):
        return preferred
    return _uniquify_copy_name(recipient_root, original_name, (".zarr",), reserved)


def _pick_live_share_dest_name(
    recipient_root: str,
    original_name: str,
    *,
    is_dir: bool,
    reserved: FrozenSet[str] = frozenset(),
) -> str:
    """Destination name for a live (view / collaborate) share.

    Returns the original name when the slot is free, or when it holds only a
    leftover the caller is allowed to clear (a broken symlink, or — for folders
    — a revoke shell); otherwise uniquifies past it. Pure decision: clearing
    the leftover is the caller's job, done under the name reservation.
    """
    suffixes: tuple[str, ...] = () if is_dir else (".zarr",)
    reserved = frozenset(_fold(r) for r in reserved)
    preferred = original_name
    if _fold(preferred) in reserved:
        return _uniquify_copy_name(recipient_root, original_name, suffixes, reserved)
    abs_preferred = os.path.join(recipient_root, preferred)
    if os.path.islink(abs_preferred) and not os.path.exists(abs_preferred):
        return preferred  # broken leftover from a partial unshare
    if not os.path.lexists(abs_preferred):
        return preferred
    if (
        is_dir
        and os.path.isdir(abs_preferred)
        and not os.path.islink(abs_preferred)
        and _folder_is_revoked_private_copy_shell(abs_preferred)
    ):
        return preferred  # private-copy revoke shell
    return _uniquify_copy_name(recipient_root, original_name, suffixes, reserved)


def _folder_is_revoked_private_copy_shell(abs_dir: str) -> bool:
    """True when *abs_dir* looks like a post-revoke Private-copy leftover.

    After revoke, slide symlinks are gone and only ``*.zarr`` overlays (plus
    empty parent dirs) remain. Require at least one leftover ``.zarr`` so an
    empty personal folder with the same name is never treated as reclaimable.
    Any real file / lingering symlink (file *or* directory) means this is not
    a clean revoke shell.
    """
    try:
        found_zarr = False
        for dirpath, dirnames, filenames in os.walk(abs_dir):
            for name in list(dirnames):
                full = os.path.join(dirpath, name)
                # os.walk does not follow dir symlinks, but they still appear
                # in dirnames — reject them explicitly.
                if os.path.islink(full):
                    return False
                if name.endswith(".zarr"):
                    found_zarr = True
                    dirnames.remove(name)
            for name in filenames:
                full = os.path.join(dirpath, name)
                if os.path.islink(full) or os.path.isfile(full):
                    return False
        return found_zarr
    except OSError:
        return False


def _clear_path_for_live_share_dest(abs_path: str) -> None:
    """Remove a revoke leftover so view/collaborate can take the same name.

    Private-copy leaves real overlay dirs behind; live shares need a clean
    symlink slot. Only deletes known leftover shapes (real dir / symlink).
    """
    try:
        if os.path.islink(abs_path):
            os.unlink(abs_path)
        elif os.path.isdir(abs_path):
            shutil.rmtree(abs_path, ignore_errors=True)
        elif os.path.isfile(abs_path):
            os.remove(abs_path)
    except OSError as e:
        logger.warning(f"Failed to clear live-share dest '{abs_path}': {e}")


def _enforce_samples_source(source_rel: str) -> None:
    """Raise 400 if *source_rel* is not under ``samples/``.

    Uses ``os.path.normpath`` to collapse ``..`` components before the check,
    preventing path-traversal payloads like ``samples/../users/victim/``.
    """
    # Collapse '..' / '.' and accept Windows '\' from desktop clients.
    normalized = os.path.normpath(source_rel.replace("\\", "/")).replace("\\", "/").lstrip("/")
    if normalized != "samples" and not normalized.startswith("samples/"):
        raise AppError(
            status_code=400,
            error_code="INVALID_SOURCE_PATH",
            message="Source must be under the samples/ directory.",
        )


def _incoming_share_doc(sharer_uid: str, source_rel: str) -> Optional[dict]:
    """Nearest doc at or above *source_rel* marking it as received from someone else.

    Checking only the doc for *source_rel* itself missed the subpath case: a
    recipient of a view/collaborate folder could re-share
    ``users/<them>/CollabFolder/sub``, which has no doc of its own, and hand a
    third user symlinks into the original owner's storage. The umbrella that
    carries ``sharedBy`` sits on an ancestor, so the check has to climb — the
    same walk ``resolve_share_root_doc`` does for the write guards.

    Stops at the sharer's own root; ``users/<uid>`` itself is never a share.
    """
    repo = FilesRepo()
    root = f"users/{sharer_uid}"
    cur = source_rel
    seen: set[str] = set()
    while cur and cur != root and cur not in seen:
        seen.add(cur)
        doc = repo.find_by_owner_and_path(sharer_uid, cur)
        if doc:
            mode = (doc.get("shareMode") or "").strip().lower()
            if doc.get("sharedBy") or mode in ("view", "collaborate"):
                return doc
        parent = os.path.dirname(cur).replace("\\", "/").strip("/")
        if not parent or parent == cur:
            break
        cur = parent
    return None


def _barcode_from_filename(name: str) -> Optional[str]:
    """Extract the patient barcode (first 3 dash tokens) from a TCGA-style
    filename, e.g. ``TCGA-AD-6548-01Z-00-DX1.<uuid>.svs`` → ``TCGA-AD-6548``.
    Returns ``None`` if the filename doesn't follow that convention."""
    base = os.path.basename(name)
    parts = base.split("-")
    if len(parts) >= 3 and parts[0].upper() == "TCGA":
        return f"{parts[0]}-{parts[1]}-{parts[2]}".upper()
    return None


def _collect_slides_for_barcodes(
    project_dir: str, wanted_barcodes: set[str]
) -> list[tuple[str, str, int]]:
    """Walk *project_dir* and return ``(rel_path, abs_path, size)`` for every
    slide file whose barcode is in *wanted_barcodes*. Skips ``.zarr`` etc."""
    out: list[tuple[str, str, int]] = []
    for root, dirs, files in os.walk(project_dir):
        dirs[:] = [
            d for d in dirs
            if not any(d.endswith(s) for s in _SKIP_DIR_SUFFIXES)
        ]
        for fname in files:
            _, ext = os.path.splitext(fname)
            if ext.lower() not in SLIDE_EXTENSIONS:
                continue
            barcode = _barcode_from_filename(fname)
            if barcode is None or barcode not in wanted_barcodes:
                continue
            full = os.path.join(root, fname)
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            rel = os.path.relpath(full, project_dir)
            out.append((rel, full, size))
    return out


def _project_samples_rel(abs_project_dir: str) -> Optional[str]:
    """Reverse-resolve an absolute project directory back to its
    samples-relative virtual path, e.g.
    ``/tissuelab/data/TCGA/TCGA-COAD`` → ``samples/Data/TCGA/TCGA-COAD``.

    Returns ``None`` if no virtual link matches.
    """
    abs_norm = os.path.normpath(abs_project_dir)
    for link in PUBLIC_VIRTUAL_LINKS:
        target = os.path.normpath(link["target"])
        if abs_norm == target:
            return link["alias"]
        if abs_norm.startswith(target + os.sep):
            tail = abs_norm[len(target) + 1 :]
            return f"{link['alias']}/{tail}".replace("\\", "/")
    return None


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class CopyPersonalService:
    """Copies slide data from ``samples/`` into a user's personal directory."""

    # ------------------------------------------------------------------
    # Public async API
    # ------------------------------------------------------------------

    async def copy_file(
        self, source_path: str, auth_user: AuthUser, include_zarr: bool = False
    ) -> CopyResult | CopyBusyError:
        """Copy a single slide file from ``samples/`` into the caller's personal root.

        When ``include_zarr`` is set and the slide has a sibling ``<name>.zarr``
        store, that store is copied too (segmentation + Cell-Classification +
        annotations) so the recipient inherits the precomputed analysis.

        Returns ``CopyResult`` on success, ``CopyBusyError`` when the queue is
        full.  Raises ``HTTPException`` for validation / quota errors.
        """
        # Block anonymous/guest users — they have no personal directory
        if auth_user.is_anonymous:
            raise AppErrors.USER_FORBIDDEN()

        source_rel = normalize_rel_path(source_path)

        # Must originate from samples/
        _enforce_samples_source(source_rel)

        # Fine-grained access check (handles virtual paths, read-only enforcement)
        if not await validate_user_access_to_path_async(auth_user, source_rel):
            raise AppErrors.USER_FORBIDDEN()

        abs_source = self._resolve_abs(source_rel)

        if not os.path.exists(abs_source):
            raise AppErrors.RESOURCE_NOT_FOUND()
        if os.path.isdir(abs_source):
            raise AppError(
                status_code=400,
                error_code="INVALID_SOURCE_TYPE",
                message="Source is a directory. Use POST /v1/folders/copy-to-personal instead.",
            )

        # Validate slide format
        _, ext = os.path.splitext(abs_source)
        if ext.lower() not in SLIDE_EXTENSIONS:
            raise AppError(
                status_code=400,
                error_code="UNSUPPORTED_SLIDE_FORMAT",
                message=f"File type '{ext}' is not a supported slide format.",
            )

        # Sibling .zarr (only when include_zarr) — copied alongside the WSI.
        abs_source_zarr = abs_source + ".zarr"
        copy_zarr = include_zarr and await asyncio.to_thread(os.path.isdir, abs_source_zarr)

        # Quota check (offloaded so the event loop is not stalled). Count the
        # .zarr too when we're going to copy it — it's usually far larger than
        # the WSI, so ignoring it would let a copy blow past the quota.
        file_size = await asyncio.to_thread(os.path.getsize, abs_source)
        if copy_zarr:
            file_size += await asyncio.to_thread(_dir_size, abs_source_zarr)
        user_root = get_user_root_path(auth_user)
        os.makedirs(user_root, exist_ok=True)
        await self._check_quota_async(auth_user, user_root, file_size)

        # Concurrency-controlled I/O (asyncio.Semaphore — never blocks the loop)
        try:
            await asyncio.wait_for(
                _COPY_SEMAPHORE.acquire(),
                timeout=_COPY_QUEUE_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.warning(f"Copy queue full for user {auth_user.uid}")
            return CopyBusyError()

        # Hold the destination name for the whole copy: the semaphore admits
        # several callers, so picking a free name is not enough on its own.
        try:
            original_name = os.path.basename(abs_source)
            async with _reserve_dest_name(
                user_root,
                lambda taken: _uniquify_copy_name(
                    user_root, original_name, (".zarr",), taken
                ),
            ) as dest_name:
                abs_dest = os.path.join(user_root, dest_name)
                abs_dest_zarr = abs_dest + ".zarr"
                try:
                    await asyncio.to_thread(shutil.copy2, abs_source, abs_dest)
                    # dest_name reserved the ".zarr" companion name, so this is free.
                    if copy_zarr:
                        await asyncio.to_thread(
                            shutil.copytree, abs_source_zarr, abs_dest_zarr
                        )
                except Exception:
                    # Best-effort cleanup of partial destinations (WSI + .zarr)
                    try:
                        if os.path.exists(abs_dest):
                            await asyncio.to_thread(os.remove, abs_dest)
                        if os.path.isdir(abs_dest_zarr):
                            await asyncio.to_thread(shutil.rmtree, abs_dest_zarr, ignore_errors=True)
                    except Exception:
                        logger.warning(f"Failed to remove partial copy at '{abs_dest}'")
                    raise
        finally:
            _COPY_SEMAPHORE.release()

        dest_rel = f"users/{auth_user.uid}/{dest_name}"
        return CopyResult(destination=dest_rel)

    async def copy_folder(
        self, source_path: str, auth_user: AuthUser, include_zarr: bool = False
    ) -> CopyResult | CopyBusyError:
        """Recursively copy a folder from ``samples/`` into the caller's personal root.

        Only files matching ``SLIDE_EXTENSIONS`` are copied; derived artifacts
        (e.g. ``.zarr``) are silently skipped — UNLESS ``include_zarr`` is set,
        in which case each slide's sibling ``.zarr`` store (segmentation +
        Cell-Classification + annotations) is copied alongside it.

        Returns ``CopyResult`` on success, ``CopyBusyError`` when the queue is
        full.  Raises ``HTTPException`` for validation / quota errors.
        """
        # Block anonymous/guest users — they have no personal directory
        if auth_user.is_anonymous:
            raise AppErrors.USER_FORBIDDEN()

        source_rel = normalize_rel_path(source_path)

        # Must originate from samples/
        _enforce_samples_source(source_rel)

        # Fine-grained access check
        if not await validate_user_access_to_path_async(auth_user, source_rel):
            raise AppErrors.USER_FORBIDDEN()

        abs_source = self._resolve_abs(source_rel)

        if not os.path.exists(abs_source):
            raise AppErrors.RESOURCE_NOT_FOUND()
        if not os.path.isdir(abs_source):
            raise AppError(
                status_code=400,
                error_code="INVALID_SOURCE_TYPE",
                message="Source is a file. Use POST /v1/files/copy-to-personal instead.",
            )

        # Quota check — only count slide files that will actually be copied
        # (avoids overestimating due to .zarr or other derived artifacts in source),
        # plus the .zarr stores when include_zarr is set (they dominate the size).
        slide_size = await asyncio.to_thread(self._slide_only_size, abs_source)
        if include_zarr:
            slide_size += await asyncio.to_thread(self._zarr_only_size, abs_source)
        user_root = get_user_root_path(auth_user)
        os.makedirs(user_root, exist_ok=True)
        await self._check_quota_async(auth_user, user_root, slide_size)

        # Concurrency-controlled I/O
        try:
            await asyncio.wait_for(
                _COPY_SEMAPHORE.acquire(),
                timeout=_COPY_QUEUE_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.warning(f"Copy queue full for user {auth_user.uid}")
            return CopyBusyError()

        # Reserved for the whole copy — see copy_file.
        try:
            original_name = os.path.basename(abs_source.rstrip("/\\"))
            async with _reserve_dest_name(
                user_root,
                lambda taken: _uniquify_copy_name(user_root, original_name, (), taken),
            ) as dest_name:
                abs_dest = os.path.join(user_root, dest_name)
                try:
                    await asyncio.to_thread(
                        shutil.copytree,
                        abs_source,
                        abs_dest,
                        ignore=_slide_only_ignore,
                    )
                    # Slides copied; now pull each slide's sibling .zarr into the same
                    # relative spot (dst already mirrors the slide layout).
                    if include_zarr:
                        await asyncio.to_thread(_copy_sibling_zarrs, abs_source, abs_dest)
                except Exception:
                    # Best-effort cleanup of a potentially partial destination directory
                    try:
                        if os.path.exists(abs_dest):
                            await asyncio.to_thread(shutil.rmtree, abs_dest, ignore_errors=True)
                    except Exception:
                        logger.warning(f"Failed to remove partial copy at '{abs_dest}'")
                    raise
        finally:
            _COPY_SEMAPHORE.release()

        dest_rel = f"users/{auth_user.uid}/{dest_name}"
        return CopyResult(destination=dest_rel)

    async def link_file(
        self, source_path: str, auth_user: AuthUser
    ) -> CopyResult | CopyBusyError:
        """Link a sample slide into the caller's personal root WITHOUT copying bytes.

        Unlike :meth:`copy_file`, this creates a symlink to the samples WSI and a
        *sparse overlay* of its sibling ``.zarr`` (if present): heavy read-only
        groups (``_OVERLAY_SYMLINK_GROUPS`` — the embedding store) are symlinked
        back to the source, while everything else is copied so the overlay is
        independently writable. The classifier then reads embeddings through the
        symlink and writes annotations/predictions into the user-owned copies —
        no multi-GB duplication.

        A file-table doc is registered carrying the source's real ``fileSize`` so
        the slide counts against the user's quota even though its bytes are
        shared. The lazy disk-scan that normally creates docs skips symlinks, so
        this explicit registration is required.

        Returns ``CopyResult`` on success, ``CopyBusyError`` when the queue is
        full. Raises ``AppError`` for validation / quota errors.
        """
        if auth_user.is_anonymous:
            raise AppErrors.USER_FORBIDDEN()

        source_rel = normalize_rel_path(source_path)
        _enforce_samples_source(source_rel)
        if not await validate_user_access_to_path_async(auth_user, source_rel):
            raise AppErrors.USER_FORBIDDEN()

        abs_source = self._resolve_abs(source_rel)
        if not os.path.exists(abs_source):
            raise AppErrors.RESOURCE_NOT_FOUND()
        if os.path.isdir(abs_source):
            raise AppError(
                status_code=400,
                error_code="INVALID_SOURCE_TYPE",
                message="Source is a directory. Linking is only supported for slide files.",
            )

        _, ext = os.path.splitext(abs_source)
        if ext.lower() not in SLIDE_EXTENSIONS:
            raise AppError(
                status_code=400,
                error_code="UNSUPPORTED_SLIDE_FORMAT",
                message=f"File type '{ext}' is not a supported slide format.",
            )

        # A linked slide still counts against the user (its real size is
        # attributed via the file-table doc below), so the quota check must use
        # file-table usage — NOT the disk walk, which skips symlinks and would
        # under-count previously linked slides, letting a user link past quota.
        file_size = await asyncio.to_thread(os.path.getsize, abs_source)
        user_root = get_user_root_path(auth_user)
        os.makedirs(user_root, exist_ok=True)
        await self._check_quota_filetable_async(auth_user, file_size)

        try:
            await asyncio.wait_for(
                _COPY_SEMAPHORE.acquire(),
                timeout=_COPY_QUEUE_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.warning(f"Copy queue full for user {auth_user.uid}")
            return CopyBusyError()

        # Reserved for the whole link so two concurrent requests cannot race
        # on the same unique name — see copy_file.
        try:
            original_name = os.path.basename(abs_source)
            async with _reserve_dest_name(
                user_root,
                lambda taken: _uniquify_copy_name(
                    user_root, original_name, (".zarr",), taken
                ),
            ) as dest_name:
                abs_dest = os.path.join(user_root, dest_name)
                abs_source_zarr = abs_source + ".zarr"
                abs_dest_zarr = abs_dest + ".zarr"
                try:
                    await asyncio.to_thread(symlink_relative, abs_source, abs_dest)
                    if await asyncio.to_thread(os.path.isdir, abs_source_zarr):
                        await asyncio.to_thread(
                            self._build_overlay_zarr, abs_source_zarr, abs_dest_zarr
                        )
                except Exception:
                    await asyncio.to_thread(self._cleanup_linked, abs_dest, abs_dest_zarr)
                    raise
        finally:
            _COPY_SEMAPHORE.release()

        dest_rel = f"users/{auth_user.uid}/{dest_name}"
        # Register the file-table doc (outside the I/O semaphore). Carries the
        # source size so quota counts it; keyed by the destination path.
        await asyncio.to_thread(
            self._register_linked_doc, dest_rel, auth_user.uid, original_name, file_size, source_rel
        )
        return CopyResult(destination=dest_rel)

    async def link_folder(
        self, source_path: str, auth_user: AuthUser
    ) -> "CopyResult | CopyBusyError":
        """Recursively symlink every slide in *source_path* into a new personal
        folder.

        Mirrors the source's subdirectory structure. For each slide file
        found, creates the symlink + sparse ``.zarr`` overlay just like
        :meth:`link_file`, and registers a file-table doc so the linked
        bytes count against quota.

        Returns :class:`CopyResult` on success, :class:`CopyBusyError` when
        the queue is full. Raises ``AppError`` for validation / quota
        errors.
        """
        if auth_user.is_anonymous:
            raise AppErrors.USER_FORBIDDEN()

        source_rel = normalize_rel_path(source_path)
        _enforce_samples_source(source_rel)
        if not await validate_user_access_to_path_async(auth_user, source_rel):
            raise AppErrors.USER_FORBIDDEN()

        abs_source = self._resolve_abs(source_rel)
        if not os.path.exists(abs_source):
            raise AppErrors.RESOURCE_NOT_FOUND()
        if not os.path.isdir(abs_source):
            raise AppError(
                status_code=400,
                error_code="INVALID_SOURCE_TYPE",
                message="Source is a file. Use POST /v1/files/copy-to-personal with link=true instead.",
            )

        # Walk + size every slide we'll link, BEFORE we hold the queue
        # semaphore. Linked slides count against quota via file-table docs.
        slides = await asyncio.to_thread(self._collect_slide_entries, abs_source)
        total_size = sum(s[2] for s in slides)
        user_root = get_user_root_path(auth_user)
        os.makedirs(user_root, exist_ok=True)
        await self._check_quota_filetable_async(auth_user, total_size)

        try:
            await asyncio.wait_for(
                _COPY_SEMAPHORE.acquire(), timeout=_COPY_QUEUE_TIMEOUT
            )
        except asyncio.TimeoutError:
            logger.warning(f"Copy queue full for user {auth_user.uid}")
            return CopyBusyError()

        try:
            original_name = os.path.basename(abs_source.rstrip("/\\"))
            async with _reserve_dest_name(
                user_root,
                lambda taken: _uniquify_copy_name(user_root, original_name, (), taken),
            ) as dest_name:
                abs_dest = os.path.join(user_root, dest_name)

                try:
                    created = await self._materialize_slide_links_concurrent(
                        abs_source,
                        abs_dest,
                        source_rel,
                        auth_user.uid,
                        dest_name,
                        slides,
                    )
                except Exception:
                    try:
                        if os.path.exists(abs_dest):
                            await asyncio.to_thread(shutil.rmtree, abs_dest, ignore_errors=True)
                    except Exception:
                        logger.warning(f"Failed to remove partial link tree at '{abs_dest}'")
                    raise
        finally:
            _COPY_SEMAPHORE.release()

        # Register file-table docs outside the I/O semaphore so a slow Firestore
        # call doesn't stall the next caller. Run all writes concurrently —
        # the previous sequential loop made 30-patient cohorts take ~5 s of
        # round-trip time even though each Firestore write is independent.
        await asyncio.gather(*(
            asyncio.to_thread(
                self._register_linked_doc,
                dest_rel_slide,
                auth_user.uid,
                os.path.basename(dest_rel_slide),
                size,
                source_rel_slide,
            )
            for dest_rel_slide, source_rel_slide, size in created
        ))

        dest_rel = f"users/{auth_user.uid}/{dest_name}"
        return CopyResult(destination=dest_rel)

    async def link_cohort(
        self,
        project: str,
        barcodes: list[str],
        folder_name: str,
        auth_user: AuthUser,
    ) -> "CopyResult | CopyBusyError":
        """Materialize a StudyBuilder cohort into a new personal folder.

        Layout produced:
            users/<uid>/<folder_name>/
                <slide_file>                      symlink + sparse .zarr overlay
                ...

        Slide files are discovered by matching the first three dash tokens
        of each filename against the cohort's barcode list (the standard
        TCGA naming convention — see ``tcgaPatientIdFromName`` in the
        frontend).
        """
        if auth_user.is_anonymous:
            raise AppErrors.USER_FORBIDDEN()
        if not folder_name or "/" in folder_name or "\\" in folder_name or folder_name in (".", ".."):
            raise AppError(
                status_code=400,
                error_code="INVALID_FOLDER_NAME",
                message="Folder name must be a single, non-empty path segment.",
            )
        if not barcodes:
            raise AppError(
                status_code=400,
                error_code="EMPTY_COHORT",
                message="No barcodes supplied — cannot link an empty cohort.",
            )

        # A cohort can span multiple datasets — the frontend sends a comma-
        # joined project list (e.g. "TCGA-BRCA,TCGA-COAD"). Resolve each
        # project's source dir, collect its matching slides, and merge them all
        # into one folder. Each project keeps its own samples-relative source
        # path (needed per slide for the file-table docs).
        raise AppError(
            status_code=501,
            error_code="NOT_IMPLEMENTED",
            message="Cohort linking is not available in the open edition.",
        )

    async def share_to_user(
        self,
        sharer_uid: str,
        recipient_uid: str,
        source_rel: str,
        share_mode: str = "share",
    ) -> "CopyResult | CopyBusyError":
        """Symlink a sharer's file/folder into the recipient's Personal root.

        Modes:

        * ``share`` (default): symlink each slide individually + build a
          sparse ``.zarr`` overlay per slide (same primitive as the
          samples → Personal "shared with me" flow). The recipient's
          User-Annotations / Cell-Classification etc. land in *their*
          overlay — isolated from the sharer. Recipient pays the
          linked size against their quota.

        * ``collaborate`` (folder only): single folder-level symlink pointing
          back to the sharer's directory. Reads
          AND writes transparently traverse to the source, so the two
          users share the *same* underlying data — annotations made by
          either are immediately visible to the other. No quota is
          charged because nothing is duplicated.

        * ``view``: same disk materialization as collaborate for folders
          (full symlink so the recipient sees the owner's overlays), or
          for a single slide: WSI symlink + full sibling ``.zarr`` symlink
          (not a sparse overlay). Writes are blocked by FM / AI ACL —
          this mode is read-only. No quota charged.

        Each created file-table doc carries:
          - ``linkedFrom`` = the sharer's source path
          - ``sharedBy``   = sharer_uid
          - ``shareMode``  = "share" | "collaborate" | "view"
        """
        if sharer_uid == recipient_uid:
            raise AppError(
                status_code=400,
                error_code="INVALID_SHARE_RECIPIENT",
                message="A user cannot share with themselves.",
            )
        share_mode = (share_mode or "share").strip().lower()
        if share_mode not in ("share", "collaborate", "view"):
            raise AppError(
                status_code=400,
                error_code="INVALID_SHARE_MODE",
                message=f"Unknown share_mode {share_mode!r}; expected 'share', 'collaborate', or 'view'.",
            )

        # Canonical storage key for linkedFrom / lookups (no backslashes,
        # no trailing slash). Validation and registration must use the same
        # string or unshare/find_links_from miss the umbrella.
        source_rel = os.path.normpath(source_rel).replace(os.sep, "/").strip("/")
        sharer_prefix = f"users/{sharer_uid}"
        if source_rel != sharer_prefix and not source_rel.startswith(sharer_prefix + "/"):
            raise AppError(
                status_code=400,
                error_code="INVALID_SHARE_SOURCE",
                message="Source must be under the sharer's own users/ directory.",
            )

        # Refuse cascading shares of live view/collab links (or anything
        # already received from another user via sharedBy) — including a
        # subpath whose umbrella doc sits on an ancestor. One Firestore round
        # trip per level, so it runs off the event loop.
        try:
            incoming = await asyncio.to_thread(
                _incoming_share_doc, sharer_uid, source_rel
            )
        except Exception as e:
            # Fail closed when the path could be a live share we cannot verify;
            # a plain personal path (no symlink anywhere above it) still goes
            # through. Mirrors _share_mode_fail_closed in file_manager.common.
            logger.warning(f"cascade-share check failed for {source_rel}: {e}")
            if await path_involves_symlink_async(source_rel):
                raise AppError(
                    status_code=403,
                    error_code="SHARE_ACL_UNAVAILABLE",
                    message=(
                        "Cannot verify share permissions right now. "
                        "Sharing through linked folders is blocked until access "
                        "can be confirmed."
                    ),
                )
            incoming = None
        if incoming is not None:
            raise AppError(
                status_code=400,
                error_code="CASCADE_SHARE_FORBIDDEN",
                message="Cannot re-share a file or folder that was shared with you.",
            )

        abs_source = self._resolve_abs(source_rel)
        if not os.path.exists(abs_source):
            raise AppErrors.RESOURCE_NOT_FOUND()

        is_dir = os.path.isdir(abs_source)
        if not is_dir:
            _, ext = os.path.splitext(abs_source)
            if ext.lower() not in SLIDE_EXTENSIONS:
                raise AppError(
                    status_code=400,
                    error_code="UNSUPPORTED_SLIDE_FORMAT",
                    message=f"File type '{ext}' is not a supported slide format.",
                )
        if share_mode == "collaborate" and not is_dir:
            raise AppError(
                status_code=400,
                error_code="COLLABORATE_REQUIRES_FOLDER",
                message="Collaborate sharing is only supported for folders.",
            )

        recipient_root = resolve_path(f"users/{recipient_uid}")
        os.makedirs(recipient_root, exist_ok=True)

        if share_mode == "collaborate":
            # Folder-level symlink; no quota check, no zarr overlay, no
            # per-slide docs — just one umbrella doc.
            return await self._collaborate_to_user(
                sharer_uid=sharer_uid,
                recipient_uid=recipient_uid,
                source_rel=source_rel,
                abs_source=abs_source,
                recipient_root=recipient_root,
                share_mode="collaborate",
            )

        if share_mode == "view":
            if is_dir:
                return await self._collaborate_to_user(
                    sharer_uid=sharer_uid,
                    recipient_uid=recipient_uid,
                    source_rel=source_rel,
                    abs_source=abs_source,
                    recipient_root=recipient_root,
                    share_mode="view",
                )
            return await self._view_file_to_user(
                sharer_uid=sharer_uid,
                recipient_uid=recipient_uid,
                source_rel=source_rel,
                abs_source=abs_source,
                recipient_root=recipient_root,
            )

        # Share mode below — recipient quota check first.
        recipient_proxy = AuthUser(
            uid=recipient_uid, email=None, is_anonymous=False, provider_id="share"
        )

        if is_dir:
            slides = await asyncio.to_thread(
                self._collect_slide_entries, abs_source
            )
            total_size = sum(s[2] for s in slides)
        else:
            total_size = await asyncio.to_thread(os.path.getsize, abs_source)
            slides = None

        await self._check_quota_filetable_async(recipient_proxy, total_size)

        try:
            await asyncio.wait_for(
                _COPY_SEMAPHORE.acquire(), timeout=_COPY_QUEUE_TIMEOUT
            )
        except asyncio.TimeoutError:
            logger.warning(f"Copy queue full for share from {sharer_uid}")
            return CopyBusyError()

        try:
            original_name = os.path.basename(abs_source.rstrip("/\\"))
            # Reclaim revoke leftovers (orphan .zarr / folder overlays) so
            # re-share reconnects to the recipient's existing classification.
            # Held for the whole materialization so a second share carrying
            # the same source name cannot pick the same destination.
            async with _reserve_dest_name(
                recipient_root,
                lambda taken: _pick_private_copy_dest_name(
                    recipient_root, original_name, is_dir=is_dir, reserved=taken
                ),
            ) as dest_name:
                abs_dest = os.path.join(recipient_root, dest_name)
                dest_rel = f"users/{recipient_uid}/{dest_name}".replace("\\", "/")
                # Track pre-existing paths so failure rollback never wipes a
                # reclaim leftover overlay, but still cleans brand-new partials.
                # View leftovers are .zarr *symlinks* — isdir follows them and would
                # falsely mark "existed"; after _build_overlay replaces the link
                # with a real dir, a failed share must still be allowed to rmtree.
                dest_existed = os.path.lexists(abs_dest)
                abs_dest_zarr_probe = abs_dest + ".zarr"
                dest_zarr_existed = (
                    False
                    if is_dir
                    else (
                        os.path.isdir(abs_dest_zarr_probe)
                        and not os.path.islink(abs_dest_zarr_probe)
                    )
                )

                if is_dir:
                    try:
                        created = await self._materialize_slide_links_concurrent(
                            abs_source,
                            abs_dest,
                            source_rel,
                            recipient_uid,
                            dest_name,
                            slides,
                        )
                    except Exception:
                        try:
                            if dest_existed:
                                await asyncio.to_thread(
                                    self._revoke_private_copy_tree, abs_dest
                                )
                            elif os.path.exists(abs_dest):
                                await asyncio.to_thread(
                                    shutil.rmtree, abs_dest, ignore_errors=True
                                )
                        except Exception:
                            logger.warning(
                                f"Failed to roll back partial private-copy folder at '{abs_dest}'"
                            )
                        raise
                else:
                    try:
                        await asyncio.to_thread(symlink_relative, abs_source, abs_dest)
                        abs_source_zarr = abs_source + ".zarr"
                        abs_dest_zarr = abs_dest + ".zarr"
                        if await asyncio.to_thread(os.path.isdir, abs_source_zarr):
                            await asyncio.to_thread(
                                self._build_overlay_zarr,
                                abs_source_zarr,
                                abs_dest_zarr,
                            )
                        created = [(dest_rel, source_rel, total_size)]
                    except Exception:
                        try:
                            if await asyncio.to_thread(os.path.islink, abs_dest):
                                await asyncio.to_thread(os.unlink, abs_dest)
                            if not dest_zarr_existed:
                                # cleanup_linked handles symlink / real dir / file;
                                # plain isdir+rmtree would miss a leftover link.
                                await asyncio.to_thread(
                                    self._cleanup_linked, abs_dest + ".zarr"
                                )
                        except Exception:
                            logger.warning(
                                f"Failed to roll back partial private-copy slide at '{abs_dest}'"
                            )
                        raise
        finally:
            _COPY_SEMAPHORE.release()

        # Register per-slide / single-file docs concurrently.
        await asyncio.gather(*(
            asyncio.to_thread(
                self._register_shared_doc,
                d_rel,
                recipient_uid,
                os.path.basename(d_rel),
                size,
                s_rel,
                sharer_uid,
            )
            for d_rel, s_rel, size in created
        ))

        # Folder shares get an umbrella doc at the destination root. It's the
        # only doc whose linkedFrom equals the *folder* source path — exactly
        # what unshare_from_user queries on.
        if is_dir:
            await asyncio.to_thread(
                self._register_share_root_doc,
                dest_rel,
                recipient_uid,
                dest_name,
                source_rel,
                sharer_uid,
                "share",
            )

        return CopyResult(destination=dest_rel)

    async def _collaborate_to_user(
        self,
        *,
        sharer_uid: str,
        recipient_uid: str,
        source_rel: str,
        abs_source: str,
        recipient_root: str,
        share_mode: str = "collaborate",
    ) -> "CopyResult | CopyBusyError":
        """Folder-level symlink that exposes the sharer's directory live in
        the recipient's Personal root. No quota, no zarr overlay.

        Used for both ``collaborate`` (read/write) and ``view`` (read-only
        at the ACL layer) — disk layout is identical."""
        try:
            await asyncio.wait_for(
                _COPY_SEMAPHORE.acquire(), timeout=_COPY_QUEUE_TIMEOUT
            )
        except asyncio.TimeoutError:
            logger.warning(f"Copy queue full for {share_mode} from {sharer_uid}")
            return CopyBusyError()

        try:
            original_name = os.path.basename(abs_source.rstrip("/\\"))
            # Private-copy revoke may leave a real folder shell, and a partial
            # unshare a broken symlink; both occupy the name via lexists. The
            # picker reclaims those (the clear below) rather than uniquifying
            # past them, and holds the name for the whole materialization.
            async with _reserve_dest_name(
                recipient_root,
                lambda taken: _pick_live_share_dest_name(
                    recipient_root, original_name, is_dir=True, reserved=taken
                ),
            ) as dest_name:
                abs_dest = os.path.join(recipient_root, dest_name)
                dest_rel = f"users/{recipient_uid}/{dest_name}".replace("\\", "/")
                # Reclaimed slot: a live share needs the name as a clean symlink.
                if os.path.lexists(abs_dest):
                    await asyncio.to_thread(_clear_path_for_live_share_dest, abs_dest)
                try:
                    await asyncio.to_thread(symlink_relative, abs_source, abs_dest)
                except Exception:
                    # Best-effort cleanup in case the symlink half-landed.
                    try:
                        if await asyncio.to_thread(os.path.islink, abs_dest):
                            await asyncio.to_thread(os.unlink, abs_dest)
                    except Exception:
                        pass
                    raise
        finally:
            _COPY_SEMAPHORE.release()

        await asyncio.to_thread(
            self._register_share_root_doc,
            dest_rel,
            recipient_uid,
            dest_name,
            source_rel,
            sharer_uid,
            share_mode,
        )
        return CopyResult(destination=dest_rel)

    async def _view_file_to_user(
        self,
        *,
        sharer_uid: str,
        recipient_uid: str,
        source_rel: str,
        abs_source: str,
        recipient_root: str,
    ) -> "CopyResult | CopyBusyError":
        """Single-slide view share: WSI symlink + full sibling ``.zarr``
        symlink (so the recipient sees the owner's overlays). No quota."""
        try:
            await asyncio.wait_for(
                _COPY_SEMAPHORE.acquire(), timeout=_COPY_QUEUE_TIMEOUT
            )
        except asyncio.TimeoutError:
            logger.warning(f"Copy queue full for view from {sharer_uid}")
            return CopyBusyError()

        try:
            original_name = os.path.basename(abs_source.rstrip("/\\"))
            # After Private-copy revoke the slide link is gone but a sparse
            # overlay dir may remain; after a partial view unshare a .zarr
            # symlink may remain. View needs clean symlink slots, so the picker
            # reclaims the name (cleared below) and holds it for this share.
            async with _reserve_dest_name(
                recipient_root,
                lambda taken: _pick_live_share_dest_name(
                    recipient_root, original_name, is_dir=False, reserved=taken
                ),
            ) as dest_name:
                abs_dest = os.path.join(recipient_root, dest_name)
                dest_rel = f"users/{recipient_uid}/{dest_name}".replace("\\", "/")
                abs_dest_zarr = abs_dest + ".zarr"
                if dest_name == original_name:
                    # Reclaimed slot — uniquified names are free by construction.
                    for leftover in (abs_dest, abs_dest_zarr):
                        if os.path.lexists(leftover):
                            await asyncio.to_thread(
                                _clear_path_for_live_share_dest, leftover
                            )
                try:
                    await asyncio.to_thread(symlink_relative, abs_source, abs_dest)
                    abs_source_zarr = abs_source + ".zarr"
                    # Directory OR a (possibly file-typed) symlink to a zarr store.
                    source_zarr_ok = await asyncio.to_thread(
                        _is_zarr_directory, abs_source_zarr
                    )
                    if source_zarr_ok:
                        # Full zarr symlink — unlike sparse share overlay — so
                        # User-Annotations / classifications are visible.
                        await asyncio.to_thread(
                            symlink_relative,
                            abs_source_zarr,
                            abs_dest_zarr,
                            target_is_directory=True,
                        )
                except Exception:
                    await asyncio.to_thread(
                        self._cleanup_linked, abs_dest, abs_dest_zarr
                    )
                    raise
        finally:
            _COPY_SEMAPHORE.release()

        await asyncio.to_thread(
            self._register_share_root_doc,
            dest_rel,
            recipient_uid,
            dest_name,
            source_rel,
            sharer_uid,
            "view",
        )
        return CopyResult(destination=dest_rel)

    def unshare_from_user_sync(
        self, sharer_uid: str, recipient_uid: str, source_rel: str
    ) -> int:
        """Synchronous variant of :meth:`unshare_from_user` for callers
        running in a worker thread (e.g. the background delete worker).
        Same return semantics.

        ``view`` / ``collaborate``: drop the live symlink(s) only (never
        follow into the sharer's tree).

        ``share`` (Private copy): unlink the WSI (and folder-tree slide
        links) plus preprocess group symlinks inside the recipient's
        sparse ``.zarr`` overlay. Keep the overlay itself so the
        recipient's Cell-Classification / annotations survive revoke.
        """
        # Lookup is exact-match on linkedFrom + sharedBy, so this returns
        # the umbrella doc (for folder shares) or the single slide doc
        # (for file shares). Per-slide docs from a folder share have
        # linkedFrom = per-slide source so they don't match here; they get
        # swept up by delete_subtree_by_prefix below.
        source_rel = (source_rel or "").replace("\\", "/").strip("/")
        docs = FilesRepo().find_links_from(recipient_uid, source_rel, sharer_uid)
        removed = 0
        for doc in docs:
            dest_rel = doc.get("localPath") or ""
            if not dest_rel:
                continue
            abs_dest = self._resolve_abs(dest_rel)
            is_share_root = bool(doc.get("isShareRoot"))
            share_mode = (doc.get("shareMode") or "share").strip().lower()
            try:
                if share_mode in ("collaborate", "view"):
                    # Live symlink (folder or single-file view). Never follow
                    # into the sharer's tree.
                    if os.path.islink(abs_dest):
                        os.unlink(abs_dest)
                    elif os.path.isdir(abs_dest):
                        logger.warning(
                            f"unshare {share_mode}: expected symlink at {abs_dest}, found real dir; skipping fs cleanup"
                        )
                    if share_mode == "view":
                        abs_zarr = abs_dest + ".zarr"
                        try:
                            if os.path.islink(abs_zarr):
                                os.unlink(abs_zarr)
                        except Exception:
                            logger.warning(f"unshare view: failed to unlink {abs_zarr}")
                    FilesRepo().delete_file(doc.get("id"))
                elif share_mode == "share":
                    # Private copy: drop WSI / preprocess links; keep overlays.
                    if is_share_root:
                        if os.path.isdir(abs_dest) and not os.path.islink(abs_dest):
                            self._revoke_private_copy_tree(abs_dest)
                        # Sweep umbrella + per-slide docs even if disk is gone.
                        FilesRepo().delete_subtree_by_prefix(dest_rel)
                    else:
                        self._revoke_private_copy_slide(abs_dest)
                        FilesRepo().delete_file(doc.get("id"))
                else:
                    logger.warning(
                        f"unshare: unknown shareMode {share_mode!r} at {dest_rel}"
                    )
                    self._cleanup_linked(abs_dest, abs_dest + ".zarr")
                    FilesRepo().delete_file(doc.get("id"))
                removed += 1
            except Exception:
                logger.exception(f"unshare cleanup failed for '{dest_rel}'")
        return removed

    async def unshare_from_user(
        self, sharer_uid: str, recipient_uid: str, source_rel: str
    ) -> int:
        """Async wrapper around :meth:`unshare_from_user_sync`. Offloads
        the Firestore + filesystem work to a worker thread so the FastAPI
        event loop stays responsive."""
        return await asyncio.to_thread(
            self.unshare_from_user_sync, sharer_uid, recipient_uid, source_rel
        )

    async def change_share_mode(
        self,
        sharer_uid: str,
        recipient_uid: str,
        source_rel: str,
        new_mode: str,
    ) -> "CopyResult | None":
        """Update an existing recipient's share role (Viewer / Editor / Share).

        Fast path: folder ``view`` <-> ``collaborate`` share the same disk
        layout (one folder symlink), so we only flip ``shareMode`` on the
        umbrella doc.

        Otherwise: unshare then re-share under the new mode so the
        filesystem materialization matches (sparse overlay vs full
        symlink, etc.).

        If rematerialize fails after unshare, raises
        ``MODE_CHANGE_REMATERIALIZE_FAILED`` — the recipient no longer has
        disk access; the caller must drop them from ``sharedWith``.
        """
        new_mode = (new_mode or "share").strip().lower()
        if new_mode not in ("share", "collaborate", "view"):
            raise AppError(
                status_code=400,
                error_code="INVALID_SHARE_MODE",
                message=f"Unknown share_mode {new_mode!r}; expected 'share', 'collaborate', or 'view'.",
            )

        source_rel = (source_rel or "").replace("\\", "/").strip("/")

        # Validate before tear-down — otherwise a file→collaborate flip would
        # unshare successfully then fail rematerialize and leave the recipient
        # with no access.
        if new_mode == "collaborate":
            abs_source = self._resolve_abs(source_rel)
            if not os.path.isdir(abs_source):
                raise AppError(
                    status_code=400,
                    error_code="COLLABORATE_REQUIRES_FOLDER",
                    message="Collaborate mode is only supported for folders.",
                )

        repo = FilesRepo()
        umbrella = None
        # Query is sorted isShareRoot-first; take the best match for this recipient.
        for doc in repo.query_recipient_umbrellas_for_source(sharer_uid, source_rel):
            if doc.get("ownerId") == recipient_uid:
                umbrella = doc
                break

        old_mode = ((umbrella or {}).get("shareMode") or "share").strip().lower()
        if old_mode == new_mode:
            return None

        # Same FS layout — metadata-only flip for *folder* view <-> collaborate
        # (one directory symlink). Single-file view is WSI + .zarr symlinks and
        # must not be flipped to collaborate via this fast path.
        if umbrella and {old_mode, new_mode} <= {"view", "collaborate"}:
            dest_rel = umbrella.get("localPath") or ""
            abs_dest = self._resolve_abs(dest_rel) if dest_rel else ""
            if abs_dest and os.path.islink(abs_dest) and os.path.isdir(abs_dest):
                doc_id = umbrella.get("id")
                if not doc_id:
                    raise AppError(
                        status_code=500,
                        error_code="MALFORMED_UMBRELLA",
                        message="Share umbrella is missing an id.",
                    )
                await asyncio.to_thread(
                    repo.upsert_file, doc_id, {"shareMode": new_mode}
                )
                return None

        # Different materialization — tear down and rebuild.
        await self.unshare_from_user(sharer_uid, recipient_uid, source_rel)
        try:
            result = await self.share_to_user(
                sharer_uid=sharer_uid,
                recipient_uid=recipient_uid,
                source_rel=source_rel,
                share_mode=new_mode,
            )
        except AppError:
            raise AppError(
                status_code=500,
                error_code="MODE_CHANGE_REMATERIALIZE_FAILED",
                message=(
                    "Failed to re-create the share after changing permissions; "
                    "the recipient's access was removed. Share again to restore."
                ),
            )
        except Exception as e:
            logger.error(
                f"change_share_mode rematerialize failed "
                f"({sharer_uid} -> {recipient_uid}, {source_rel} {old_mode}->{new_mode}): {e}",
                exc_info=True,
            )
            raise AppError(
                status_code=500,
                error_code="MODE_CHANGE_REMATERIALIZE_FAILED",
                message=(
                    "Failed to re-create the share after changing permissions; "
                    "the recipient's access was removed. Share again to restore."
                ),
            ) from e

        if isinstance(result, CopyBusyError):
            raise AppError(
                status_code=503,
                error_code="MODE_CHANGE_REMATERIALIZE_FAILED",
                message=(
                    "Share queue busy while changing permissions; "
                    "the recipient's access was removed. Share again to restore."
                ),
            )
        return result

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _collect_slide_entries(abs_source_root: str) -> list[tuple[str, str, int]]:
        """Walk *abs_source_root* and return ``(rel_path, abs_path, size)``
        for every slide file. Skips ``.zarr`` / ``.cache`` / ``.pyramids``
        subtrees, mirroring :data:`_SKIP_DIR_SUFFIXES`."""
        out: list[tuple[str, str, int]] = []
        for root, dirs, files in os.walk(abs_source_root):
            dirs[:] = [
                d for d in dirs
                if not any(d.endswith(s) for s in _SKIP_DIR_SUFFIXES)
            ]
            for fname in files:
                _, ext = os.path.splitext(fname)
                if ext.lower() not in SLIDE_EXTENSIONS:
                    continue
                full = os.path.join(root, fname)
                try:
                    size = os.path.getsize(full)
                except OSError:
                    continue
                rel = os.path.relpath(full, abs_source_root)
                out.append((rel, full, size))
        return out

    @staticmethod
    def _link_one_slide_sync(abs_slide: str, dest_slide: str) -> None:
        """Per-slide work: symlink + sparse zarr overlay.

        Safe to re-run after Private-copy revoke: recreates the WSI link and
        refreshes preprocess group symlinks without wiping recipient-owned
        Classification / annotations already in the overlay.
        """
        if os.path.lexists(dest_slide):
            if os.path.islink(dest_slide):
                os.unlink(dest_slide)
            else:
                raise FileExistsError(
                    f"Cannot link private-copy slide over existing path: {dest_slide}"
                )
        symlink_relative(abs_slide, dest_slide)
        zarr_source = abs_slide + ".zarr"
        if os.path.isdir(zarr_source):
            CopyPersonalService._build_overlay_zarr(
                zarr_source, dest_slide + ".zarr"
            )

    async def _materialize_slide_links_concurrent(
        self,
        abs_source_root: str,
        abs_dest_root: str,
        source_rel_root: str,
        uid: str,
        dest_name: str,
        slides: list[tuple[str, str, int]],
    ) -> list[tuple[str, str, int]]:
        """Materialize every slide in *slides* in parallel (bounded by
        ``_LINK_SUB_CONCURRENCY``).

        Returns ``[(dest_rel, source_rel, size), ...]`` for the caller to
        register Firestore docs against.
        """
        # All parent directories up-front (cheap, single thread). After this
        # the per-slide tasks just call symlink + overlay — no further mkdirs
        # so concurrent callers don't race on directory creation.
        os.makedirs(abs_dest_root, exist_ok=True)
        for rel, _, _ in slides:
            parent = os.path.dirname(os.path.join(abs_dest_root, rel))
            if parent and parent != abs_dest_root:
                os.makedirs(parent, exist_ok=True)

        sub_sem = asyncio.Semaphore(_LINK_SUB_CONCURRENCY)

        async def _one(rel: str, abs_slide: str, size: int) -> tuple[str, str, int]:
            dest_slide = os.path.join(abs_dest_root, rel)
            async with sub_sem:
                await asyncio.to_thread(
                    self._link_one_slide_sync, abs_slide, dest_slide
                )
            dest_rel_slide = f"users/{uid}/{dest_name}/{rel}".replace("\\", "/")
            source_rel_slide = f"{source_rel_root}/{rel}".replace("\\", "/")
            return (dest_rel_slide, source_rel_slide, size)

        # Wait for all workers before raising — otherwise the caller's
        # rollback races siblings still writing overlays.
        results = await asyncio.gather(
            *(_one(*s) for s in slides), return_exceptions=True
        )
        failures = [r for r in results if isinstance(r, BaseException)]
        if failures:
            raise failures[0]
        return [r for r in results if not isinstance(r, BaseException)]

    async def _materialize_cohort_concurrent(
        self,
        source_rel_project: str,
        abs_dest_root: str,
        uid: str,
        dest_name: str,
        slides: list[tuple[str, str, int]],
    ) -> list[tuple[str, str, int]]:
        """Same as :meth:`_materialize_slide_links_concurrent` but flattens
        the destination layout (slides land directly under
        ``abs_dest_root``)."""
        os.makedirs(abs_dest_root, exist_ok=True)
        sub_sem = asyncio.Semaphore(_LINK_SUB_CONCURRENCY)

        async def _one(rel_in_project: str, abs_slide: str, size: int) -> tuple[str, str, int]:
            slide_name = os.path.basename(rel_in_project)
            dest_slide = os.path.join(abs_dest_root, slide_name)
            async with sub_sem:
                await asyncio.to_thread(
                    self._link_one_slide_sync, abs_slide, dest_slide
                )
            dest_rel_slide = f"users/{uid}/{dest_name}/{slide_name}".replace("\\", "/")
            source_rel_slide = f"{source_rel_project}/{rel_in_project}".replace("\\", "/")
            return (dest_rel_slide, source_rel_slide, size)

        results = await asyncio.gather(
            *(_one(*s) for s in slides), return_exceptions=True
        )
        failures = [r for r in results if isinstance(r, BaseException)]
        if failures:
            raise failures[0]
        return [r for r in results if not isinstance(r, BaseException)]

    @staticmethod
    def _build_overlay_zarr(abs_source_zarr: str, abs_dest_zarr: str) -> None:
        """Create or refresh a sparse overlay of *abs_source_zarr* at *abs_dest_zarr*.

        Top-level entries are handled individually:
          - directories named in ``_OVERLAY_SYMLINK_GROUPS``
            (Cell-Segmentation / Patch-Segmentation) → symlinked to the source
            (bytes shared, read-only inputs the recipient never overwrites)
          - every other directory (Cell-Classification / Patch-Classification /
            User-Annotations / arbitrary other model outputs) → SKIPPED. The
            recipient starts with no annotations / classifications and produces
            their own; nothing of the sharer's downstream state leaks into the
            overlay. On re-share after revoke, existing recipient groups are
            preserved (we never delete/replace non-symlink groups here).
          - root metadata files (zarr v3 ``zarr.json`` or legacy v2
            ``.zgroup`` / ``.zattrs``) → copied (tiny), needed so the zarr root
            is parseable. Legacy consolidated metadata (``.zmetadata``) is
            intentionally NOT copied: it enumerates the full child hierarchy and
            would be inconsistent with this sparse overlay (which omits
            Classification / User-Annotations groups).
        """
        # Never write through a leftover view/collab .zarr symlink — that
        # would mutate the sharer's store (copy2 / chmod on followed paths).
        if os.path.islink(abs_dest_zarr):
            try:
                os.unlink(abs_dest_zarr)
            except OSError as e:
                raise OSError(
                    f"Cannot replace leftover .zarr symlink at '{abs_dest_zarr}': {e}"
                ) from e
        os.makedirs(abs_dest_zarr, exist_ok=True)
        if os.path.islink(abs_dest_zarr):
            raise OSError(
                f"Overlay destination resolved as symlink after makedirs: {abs_dest_zarr}"
            )
        for entry in os.scandir(abs_source_zarr):
            dest_path = os.path.join(abs_dest_zarr, entry.name)
            if entry.is_dir(follow_symlinks=False):
                if entry.name in _OVERLAY_SYMLINK_GROUPS:
                    # Re-share after revoke: preprocess links were detached;
                    # replace only symlink/broken slots, never a real dir.
                    try:
                        if os.path.islink(dest_path) or (
                            os.path.lexists(dest_path) and not os.path.exists(dest_path)
                        ):
                            os.unlink(dest_path)
                        elif os.path.isdir(dest_path):
                            continue
                    except OSError:
                        logger.warning(
                            f"Failed to clear stale overlay link at '{dest_path}'"
                        )
                        continue
                    if not os.path.lexists(dest_path):
                        symlink_relative(entry.path, dest_path)
                # else: skip — recipient generates these themselves
            else:
                if entry.name == ".zmetadata":
                    # Stale consolidated metadata would reference skipped groups.
                    continue
                shutil.copy2(entry.path, dest_path)
                CopyPersonalService._add_user_write(dest_path)
        CopyPersonalService._add_user_write(abs_dest_zarr)

    @staticmethod
    def _add_user_write(path: str) -> None:
        """Add the owner-write bit (and exec for dirs) to *path*.

        copytree/copy2 preserve the source mode, and the samples source is made
        read-only at the OS level — without this the copied groups land
        read-only in the user's overlay, which both blocks writes during a run
        and makes ``shutil.rmtree`` unable to delete them afterwards. Never
        follows symlinks (would change the shared samples source's perms).
        """
        try:
            if os.path.islink(path):
                return
            mode = os.stat(path).st_mode | stat.S_IWUSR
            if os.path.isdir(path):
                mode |= stat.S_IXUSR
            os.chmod(path, mode)
        except OSError:
            pass

    @staticmethod
    def _make_tree_writable(root: str) -> None:
        """Recursively ensure every copied entry under *root* is owner-writable."""
        CopyPersonalService._add_user_write(root)
        for dirpath, dirnames, filenames in os.walk(root):
            for name in dirnames + filenames:
                CopyPersonalService._add_user_write(os.path.join(dirpath, name))

    @staticmethod
    def _detach_overlay_preprocess_links(abs_zarr: str) -> None:
        """Unlink preprocess group symlinks inside a sparse overlay.

        Leaves real groups (Cell-Classification / User-Annotations / …)
        untouched so revoke does not wipe the recipient's own analysis.
        """
        if not abs_zarr or not os.path.isdir(abs_zarr) or os.path.islink(abs_zarr):
            return
        for name in _OVERLAY_SYMLINK_GROUPS:
            path = os.path.join(abs_zarr, name)
            try:
                if os.path.islink(path):
                    os.unlink(path)
            except Exception:
                logger.warning(f"Failed to detach overlay preprocess link at '{path}'")

    @staticmethod
    def _revoke_private_copy_slide(abs_slide: str) -> None:
        """Revoke one Private-copy slide: drop WSI link, keep overlay work."""
        try:
            if os.path.islink(abs_slide):
                os.unlink(abs_slide)
        except Exception:
            logger.warning(f"Failed to unlink private-copy slide at '{abs_slide}'")
        CopyPersonalService._detach_overlay_preprocess_links(abs_slide + ".zarr")

    @staticmethod
    def _revoke_private_copy_tree(abs_root: str) -> None:
        """Revoke a Private-copy folder tree without deleting recipient overlays."""
        if not os.path.isdir(abs_root) or os.path.islink(abs_root):
            return
        for dirpath, dirnames, filenames in os.walk(abs_root, topdown=True):
            # Treat each ``*.zarr`` store as a unit — detach preprocess links,
            # do not walk into chunk groups (would be huge / wrong).
            for name in list(dirnames):
                if name.endswith(".zarr"):
                    CopyPersonalService._detach_overlay_preprocess_links(
                        os.path.join(dirpath, name)
                    )
                    dirnames.remove(name)
                    continue
                full = os.path.join(dirpath, name)
                if os.path.islink(full):
                    try:
                        os.unlink(full)
                    except Exception:
                        logger.warning(
                            f"Failed to unlink private-copy dir link at '{full}'"
                        )
                    dirnames.remove(name)
            for name in filenames:
                full = os.path.join(dirpath, name)
                try:
                    if os.path.islink(full):
                        os.unlink(full)
                except Exception:
                    logger.warning(
                        f"Failed to unlink private-copy file link at '{full}'"
                    )

    @staticmethod
    def _cleanup_linked(*paths: str) -> None:
        """Best-effort removal of a partial link/overlay.

        Order matters: check ``islink`` BEFORE ``isdir`` so a symlink is removed
        via ``unlink`` (never following it), and only a *real* directory is
        handed to ``rmtree``. ``rmtree`` itself unlinks any nested symlinks
        rather than recursing into them, so the samples source is never touched.
        """
        for p in paths:
            try:
                if os.path.islink(p):
                    os.unlink(p)
                elif os.path.isdir(p):
                    shutil.rmtree(p, ignore_errors=True)
                elif os.path.exists(p):
                    os.remove(p)
            except Exception:
                logger.warning(f"Failed to clean up linked artifact at '{p}'")

    @staticmethod
    def _register_linked_doc(
        dest_rel: str, uid: str, file_name: str, file_size: int, source_rel: str
    ) -> None:
        """Create the file-table doc for a linked slide.

        Carries the real source size (so it counts against quota) and
        ``linkedFrom`` = the samples path it was linked from. The presence of
        ``linkedFrom`` is what marks the file as a shared link in the UI
        (a badge), letting users know it can't have segmentation / embedding
        re-run on it.
        """
        FilesRepo().create_if_absent(
            build_file_id(dest_rel),
            {
                "ownerId": uid,
                "fileName": file_name,
                "localPath": dest_rel,
                "fileSize": file_size,
                "isPublic": False,
                "sharedWith": [],
                "linkedFrom": source_rel,
            },
        )

    @staticmethod
    def _register_shared_doc(
        dest_rel: str,
        recipient_uid: str,
        file_name: str,
        file_size: int,
        source_rel: str,
        sharer_uid: str,
    ) -> None:
        """Like ``_register_linked_doc`` but tags the doc as a user-to-user
        share (``sharedBy``) so the UI can show a "shared by X" badge and
        distinguish it from a samples-link."""
        FilesRepo().create_if_absent(
            build_file_id(dest_rel),
            {
                "ownerId": recipient_uid,
                "fileName": file_name,
                "localPath": dest_rel,
                "fileSize": file_size,
                "isPublic": False,
                "sharedWith": [],
                "linkedFrom": source_rel,
                "sharedBy": sharer_uid,
                # Explicit so ShareDialog / unshare don't have to guess.
                "shareMode": "share",
                # Clear any prior umbrella flag if this path was previously a
                # view/collab root (create_if_absent merges).
                "isShareRoot": False,
            },
        )

    @staticmethod
    def _register_share_root_doc(
        dest_rel: str,
        recipient_uid: str,
        folder_name: str,
        source_rel: str,
        sharer_uid: str,
        share_mode: str = "share",
    ) -> None:
        """Umbrella doc for a folder share or a collaborate. ``linkedFrom``
        points at the FOLDER source path (per-slide docs from a share
        point at per-slide sources), so
        ``find_links_from(recipient_uid, source_rel)`` returns this one
        doc — that's how :meth:`unshare_from_user` locates the
        destination root. ``shareMode`` tells the unshare path whether
        the destination is a real folder tree (``share``) or a single
        folder-level symlink (``collaborate``)."""
        FilesRepo().create_if_absent(
            build_file_id(dest_rel),
            {
                "ownerId": recipient_uid,
                "fileName": folder_name,
                "localPath": dest_rel,
                "fileSize": 0,
                "isPublic": False,
                "sharedWith": [],
                "linkedFrom": source_rel,
                "sharedBy": sharer_uid,
                "isShareRoot": True,
                "shareMode": share_mode,
            },
        )

    @staticmethod
    async def _check_quota_filetable_async(
        auth_user: AuthUser, required_bytes: int
    ) -> None:
        """Quota check against file-table usage (counts linked slides correctly)."""
        current_usage = await asyncio.to_thread(
            get_user_storage_usage_bytes, auth_user.uid
        )
        quota = get_user_storage_quota_bytes(auth_user)
        if current_usage + required_bytes > quota:
            raise AppErrors.STORAGE_QUOTA_EXCEEDED()

    @staticmethod
    def _resolve_abs(source_rel: str) -> str:
        resolved_rel = resolve_virtual_path(source_rel)
        return resolve_path(resolved_rel) if not os.path.isabs(resolved_rel) else resolved_rel

    @staticmethod
    def _slide_only_size(directory: str) -> int:
        """Return total byte size of only slide-format files under *directory*.

        Mirrors the ``_slide_only_ignore`` filter: skips ``.zarr`` dirs and any
        file whose extension is not in ``SLIDE_EXTENSIONS``.
        """
        total = 0
        for root, dirs, files in os.walk(directory):
            # Skip directories that would be ignored during copytree
            dirs[:] = [
                d for d in dirs
                if not any(d.endswith(suffix) for suffix in _SKIP_DIR_SUFFIXES)
            ]
            for fname in files:
                _, ext = os.path.splitext(fname)
                if ext.lower() in SLIDE_EXTENSIONS:
                    try:
                        total += os.path.getsize(os.path.join(root, fname))
                    except OSError:
                        pass
        return total

    @staticmethod
    def _zarr_only_size(directory: str) -> int:
        """Total byte size of every ``*.zarr`` store under *directory* — the
        extra footprint an ``include_zarr`` copy adds on top of the slides."""
        total = 0
        for root, dirs, _files in os.walk(directory):
            keep: list[str] = []
            for d in dirs:
                if d.endswith(".zarr"):
                    total += _dir_size(os.path.join(root, d))
                    # counted whole; don't descend
                elif any(d.endswith(s) for s in _SKIP_DIR_SUFFIXES):
                    pass
                else:
                    keep.append(d)
            dirs[:] = keep
        return total

    @staticmethod
    async def _check_quota_async(
        auth_user: AuthUser, user_root: str, required_bytes: int
    ) -> None:
        """Async-safe quota check: offloads the directory walk to a thread."""
        current_usage = await asyncio.to_thread(
            calculate_directory_size_bytes, user_root
        )
        quota = get_user_storage_quota_bytes(auth_user)
        if current_usage + required_bytes > quota:
            raise AppErrors.STORAGE_QUOTA_EXCEEDED()


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def get_copy_service() -> CopyPersonalService:
    """Return a ``CopyPersonalService`` instance (stateless, safe to recreate per request)."""
    return CopyPersonalService()
