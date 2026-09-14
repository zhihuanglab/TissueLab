"""Small filesystem helpers for ``.zarr`` stores.

Kept as a leaf util (imports only the stdlib, never ``app.config.zarr_compat``)
so ``zarr_compat`` can call into it without an import cycle.
"""
from __future__ import annotations

import json
import os
import time
import zipfile
from typing import Iterator, List, Optional, Tuple

# v3 store metadata filename. Hardcoded here (mirrors zarr_compat._V3_META) so
# this module stays dependency-free of the zarr compat/migration module.
_ZARR_V3_META = "zarr.json"
_V2_NODE_META = (".zarray", ".zgroup")
_V2_META_FILES = (".zarray", ".zgroup", ".zattrs", ".zmetadata")

# Sidecar zip of v2 metadata written just before stripping ``.zarray``/``.zgroup``.
# Stored *next to* the ``.zarr`` directory (not inside it) so zarr's hierarchy
# walker does not warn about an unrecognized root object. Removed automatically
# once the store is verified pure v3.
_V2_META_BACKUP_SUFFIX = ".tissuelab-v2-meta-backup.zip"
_V2_META_BACKUP_TMP_SUFFIX = ".tissuelab-v2-meta-backup.zip.tmp"


def v2_meta_backup_path(store_path: str) -> str:
    return os.path.normpath(store_path) + _V2_META_BACKUP_SUFFIX


def has_v2_meta_backup(store_path: str) -> bool:
    return os.path.isfile(v2_meta_backup_path(store_path))


def has_v2_meta_backup_artifacts(store_path: str) -> bool:
    """True if a backup zip or its in-progress ``.tmp`` sibling exists."""
    return has_v2_meta_backup(store_path) or os.path.isfile(
        os.path.normpath(store_path) + _V2_META_BACKUP_TMP_SUFFIX
    )


def iter_v2_metadata_file_paths(store_path: str) -> Iterator[str]:
    """Yield absolute paths of v2 metadata files under the store."""
    for root, _dirs, files in os.walk(store_path):
        for fn in files:
            if fn in _V2_META_FILES:
                yield os.path.join(root, fn)


def create_v2_meta_backup(store_path: str) -> Optional[str]:
    """Zip all v2 metadata under ``store_path`` into a sibling backup zip.

    Written via a temp file + ``os.replace`` so a crash mid-write cannot leave a
    half-baked backup that later restore would trust. Returns the backup path,
    or ``None`` when there is nothing to back up.
    """
    members = list(iter_v2_metadata_file_paths(store_path))
    if not members:
        return None

    final_path = v2_meta_backup_path(store_path)
    tmp_path = os.path.normpath(store_path) + _V2_META_BACKUP_TMP_SUFFIX
    try:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        with zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for abs_path in members:
                arcname = os.path.relpath(abs_path, store_path).replace("\\", "/")
                zf.write(abs_path, arcname)
        os.replace(tmp_path, final_path)
        return final_path
    except Exception:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        raise


def restore_v2_meta_backup(store_path: str) -> bool:
    """Restore v2 metadata files from the sidecar zip. Returns True on success.

    Returns False if the zip is missing/unreadable, extracts nothing, or does not
    restore at least one root ``.zgroup``/``.zarray`` (so callers never treat an
    empty restore as success and then wipe all ``zarr.json``).
    """
    backup = v2_meta_backup_path(store_path)
    if not os.path.isfile(backup):
        return False
    try:
        store_norm = os.path.normpath(store_path)
        extracted = 0
        with zipfile.ZipFile(backup, "r") as zf:
            # Safety: only extract known v2 metadata basenames, never ``..`` paths.
            for info in zf.infolist():
                name = info.filename.replace("\\", "/")
                if name.endswith("/") or ".." in name.split("/"):
                    continue
                base = os.path.basename(name)
                if base not in _V2_META_FILES:
                    continue
                dest = os.path.normpath(os.path.join(store_path, name))
                try:
                    common = os.path.commonpath([store_norm, dest])
                    if os.path.normcase(common) != os.path.normcase(store_norm):
                        continue
                except ValueError:
                    continue
                parent = os.path.dirname(dest)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                with zf.open(info, "r") as src, open(dest, "wb") as out:
                    out.write(src.read())
                extracted += 1
        if extracted == 0:
            return False
        if not any(
            os.path.isfile(os.path.join(store_path, m)) for m in _V2_NODE_META
        ):
            return False
        return True
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile):
        return False


def cleanup_v2_meta_backup(store_path: str) -> bool:
    """Delete the sidecar backup zip if present. Returns True if removed."""
    backup = v2_meta_backup_path(store_path)
    tmp = os.path.normpath(store_path) + _V2_META_BACKUP_TMP_SUFFIX
    removed = False
    for p in (backup, tmp):
        try:
            if os.path.isfile(p):
                os.remove(p)
                removed = True
        except OSError:
            pass
    return removed


def is_pure_v3_store(store_path: str) -> bool:
    """True when root has valid ``zarr.json`` and no v2 / corrupt v3 leftovers."""
    root_json = os.path.join(store_path, _ZARR_V3_META)
    if not is_valid_zarr_v3_json(root_json):
        return False
    if has_any_v2_metadata_files(store_path):
        return False
    if has_invalid_zarr_json(store_path):
        return False
    return True


def cleanup_v2_meta_backup_if_pure_v3(store_path: str) -> bool:
    """Drop the backup once the store is verified pure v3 (auto-cleanup)."""
    if not os.path.isdir(store_path):
        return False
    if not has_v2_meta_backup_artifacts(store_path):
        return False
    if not is_pure_v3_store(store_path):
        return False
    return cleanup_v2_meta_backup(store_path)


def has_any_v2_metadata_files(path: str) -> bool:
    """True if any v2 metadata file exists anywhere under the store."""
    for _root, files in walk_node_dirs(path):
        if any(fn in _V2_META_FILES for fn in files):
            return True
    return False


def has_any_v3_metadata_files(path: str) -> bool:
    """True if any ``zarr.json`` exists anywhere under the store."""
    for _root, files in walk_node_dirs(path):
        if _ZARR_V3_META in files:
            return True
    return False


def v3_node_type(filepath: str) -> Optional[str]:
    """``"array"`` / ``"group"`` for a valid v3 ``zarr.json``, else ``None``.

    ``None`` covers truncated / empty / non-JSON files and objects missing the
    ``zarr_format`` / ``node_type`` fields the rest of the stack expects.
    """
    try:
        with open(filepath, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    if data.get("zarr_format") != 3:
        return None
    node_type = data.get("node_type")
    if node_type not in ("array", "group"):
        return None
    return node_type


def is_valid_zarr_v3_json(filepath: str) -> bool:
    """True when ``filepath`` is readable JSON with zarr v3 array/group shape."""
    return v3_node_type(filepath) is not None


def walk_node_dirs(path: str) -> Iterator[Tuple[str, List[str]]]:
    """``os.walk`` over the store, skipping the chunk trees under v3 arrays.

    Node metadata (``zarr.json`` / ``.zarray`` / ``.zgroup``) only ever sits at a
    node's own directory. Below a v3 *array* there is nothing but chunk data, so
    descending into it cannot find metadata — it just walks every chunk
    directory in the store. On a 250k-cell slide that is ~1000 directories
    instead of ~15, and `ensure_v3` re-walks the tree three times on **every**
    store open: measured at 78 ms per open, 310 ms of the 370 ms a single
    `save_annotation` took.

    The array's own directory is still yielded before the prune, so leftover v2
    sidecars sitting next to its ``zarr.json`` are still seen.
    """
    for root, dirs, files in os.walk(path):
        yield root, files
        if _ZARR_V3_META in files and v3_node_type(os.path.join(root, _ZARR_V3_META)) == "array":
            dirs[:] = []


# How long to wait before calling an unreadable ``zarr.json`` corrupt rather
# than half-written. Writers outside this service (the NuClass task node uses a
# plain ``zarr.open_group``) never take ``zarr_lock``, so a truncated read on a
# healthy live store is normal — and everything downstream of "invalid" either
# deletes metadata or fails the open.
_SETTLE_SEC = 0.25


def _meta_fingerprint(filepath: str) -> Optional[Tuple[int, int]]:
    """``(mtime_ns, size)`` for ``filepath``, or ``None`` if it cannot be stat'd."""
    try:
        st = os.stat(filepath)
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def is_stably_invalid_zarr_json(filepath: str, settle_sec: float = _SETTLE_SEC) -> bool:
    """True only for a ``zarr.json`` that is invalid *and* not being written.

    The costly branch (one ``settle_sec`` sleep) is only ever reached for a file
    that already failed to parse, so a healthy store pays nothing.
    """
    if is_valid_zarr_v3_json(filepath):
        return False
    before = _meta_fingerprint(filepath)
    if before is None:
        # Vanished between the read and the stat — a writer is mid-replace.
        return False
    if settle_sec > 0:
        time.sleep(settle_sec)
    if is_valid_zarr_v3_json(filepath):
        # The writer finished during the window: it was in flight, not corrupt.
        return False
    after = _meta_fingerprint(filepath)
    if after is None or after != before:
        return False
    return True


def iter_invalid_zarr_json(path: str) -> Iterator[str]:
    """Yield absolute paths of ``zarr.json`` files that are *stably* invalid.

    Files a writer currently holds open are skipped — see
    :func:`is_stably_invalid_zarr_json`.
    """
    for root, files in walk_node_dirs(path):
        if _ZARR_V3_META not in files:
            continue
        fp = os.path.join(root, _ZARR_V3_META)
        if is_stably_invalid_zarr_json(fp):
            yield fp


def has_invalid_zarr_json(path: str) -> bool:
    return next(iter_invalid_zarr_json(path), None) is not None


def repair_invalid_zarr_json(path: str) -> Tuple[List[str], List[str]]:
    """Delete corrupt ``zarr.json`` files that still have sibling v2 node meta.

    Returns ``(removed, unrecoverable)``:
    * ``removed`` — corrupt files deleted because ``.zarray``/``.zgroup`` remains
      (safe to remigrate from v2);
    * ``unrecoverable`` — corrupt files with no v2 sibling (cannot remigrate
      without a metadata backup; caller may restore from backup first).
    """
    removed: List[str] = []
    unrecoverable: List[str] = []
    for root, _dirs, files in os.walk(path):
        if _ZARR_V3_META not in files:
            continue
        fp = os.path.join(root, _ZARR_V3_META)
        # Re-check with the settle guard at the point of deletion, not just at
        # detection: the store may have been judged some time (and a lock
        # acquisition) ago, and this is the call that actually removes a file.
        if not is_stably_invalid_zarr_json(fp):
            continue
        if any(fn in _V2_NODE_META for fn in files):
            try:
                os.remove(fp)
                removed.append(fp)
            except OSError:
                unrecoverable.append(fp)
        else:
            unrecoverable.append(fp)
    return removed, unrecoverable


def v3_covers_all_v2_nodes(path: str) -> bool:
    """True when every v2 array/group node has a *valid* sibling ``zarr.json``.

    Used to detect "migrate finished writing v3, cleanup of v2 sidecars did not"
    so we can finish by deleting v2 metadata instead of rolling back. A truncated
    or bogus ``zarr.json`` does **not** count as coverage — stripping v2 next to
    it would make the store unrecoverable.
    """
    saw_valid_v3 = False
    for root, _dirs, files in os.walk(path):
        zjson = os.path.join(root, _ZARR_V3_META) if _ZARR_V3_META in files else None
        valid = bool(zjson and is_valid_zarr_v3_json(zjson))
        if valid:
            saw_valid_v3 = True
        if any(fn in _V2_NODE_META for fn in files) and not valid:
            return False
    return saw_valid_v3


def iter_v2_only_nodes(path: str):
    """Yield directories that have v2 array/group meta but no *valid* sibling ``zarr.json``.

    These are nodes the official migrator still needs to convert (recursively
    under the store, not just at the root). A directory whose only ``zarr.json``
    is corrupt is treated as v2-only when v2 meta is present.
    """
    for root, files in walk_node_dirs(path):
        if not any(fn in _V2_NODE_META for fn in files):
            continue
        zjson = os.path.join(root, _ZARR_V3_META)
        if _ZARR_V3_META in files and is_valid_zarr_v3_json(zjson):
            continue
        yield root


def topmost_v2_islands(path: str) -> list[str]:
    """Return the shallowest v2-only nodes under ``path``.

    Each returned directory is a self-contained v2 subtree that can be passed to
    ``migrate_v2_to_v3`` independently. Deeper v2-only children are omitted
    because the migrator walks them when converting their ancestor island.
    """
    nodes = sorted(
        {os.path.normpath(p) for p in iter_v2_only_nodes(path)},
        key=lambda p: (p.count(os.sep), p),
    )
    islands: list[str] = []
    island_set: set[str] = set()
    for node in nodes:
        parent = os.path.dirname(node)
        # Skip if an ancestor was already selected as an island.
        cur = parent
        under_island = False
        while True:
            if cur in island_set:
                under_island = True
                break
            nxt = os.path.dirname(cur)
            if nxt == cur:
                break
            cur = nxt
        if under_island:
            continue
        islands.append(node)
        island_set.add(node)
    return islands


def purge_remaining_v2_metadata(path: str) -> int:
    """Delete any leftover v2 metadata files under ``path``.

    Intended for the final sweep after every array/group node already has a
    valid ``zarr.json`` — catches orphan ``.zattrs`` / ``.zmetadata`` that are
    not paired with ``.zarray``/``.zgroup`` and would otherwise keep
    ``needs_v3_conversion`` true forever (and block backup auto-cleanup).
    Returns the number of files removed.
    """
    removed = 0
    for root, _dirs, files in os.walk(path):
        for fn in files:
            if fn not in _V2_META_FILES:
                continue
            try:
                os.remove(os.path.join(root, fn))
                removed += 1
            except OSError:
                pass
    return removed


def remove_partial_v3_metadata(path: str) -> None:
    """Delete ``zarr.json`` files left by an INTERRUPTED / failed v2->v3 migration.

    Call this only when the store still has authoritative v2 root metadata (or
    as a rollback after a failed migrate). Chunk data is never touched.
    """
    for root, _dirs, files in os.walk(path):
        if _ZARR_V3_META in files:
            try:
                os.remove(os.path.join(root, _ZARR_V3_META))
            except OSError:
                pass
