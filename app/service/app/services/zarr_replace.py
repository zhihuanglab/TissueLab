"""Whole-.zarr replacement (user-supplied preprocessing, incl. nuclei segmentation).

Ctrl-Service owns user storage, so both the compatibility check and the crash-safe
swap live here. The candidate is uploaded via the normal file-manager upload into a
staging folder under the user's own directory; these helpers then validate it against
the slide (dimensions passed from the frontend — no slide reader needed here) and,
on confirmation, atomically swap it into place. Staging is already an uploaded copy
and is deleted after a successful swap, so the incoming tree is renamed (same
filesystem) rather than copytree'd.
"""
import json
import os
import shutil
import threading
import zipfile
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

try:
    import zarr
    ZARR_AVAILABLE = True
except Exception:
    ZARR_AVAILABLE = False

_REQUIRED_SEG_ARRAYS = ["centroids", "contours", "probabilities"]
_SKIP_WALK_DIRS = {"__MACOSX"}
_RESTORED_INCOMING_NAME = "_incoming_restored"
_EXTRACT_DONE = ".extract_complete"


def find_zarr_root(base_dir: str) -> Optional[str]:
    """Shallowest dir under base_dir that looks like a Zarr store root (v3 'zarr.json'
    or v2 '.zgroup'). Handles uploads that wrap the store in a '<name>.zarr/' folder.

    Does not descend into a found store — chunk directories can contain millions of
    files and walking them would stall the HTTP request.
    """
    if not os.path.isdir(base_dir):
        return None
    base = os.path.abspath(base_dir)
    best = None
    best_depth = None
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in _SKIP_WALK_DIRS]
        if "zarr.json" in files or ".zgroup" in files:
            depth = root[len(base):].count(os.sep)
            if best_depth is None or depth < best_depth:
                best, best_depth = root, depth
            dirs.clear()
            if best_depth == 0:
                return best
    return best


def prepare_candidate(staging_abs: str) -> Optional[str]:
    """Resolve the Zarr-store root inside a staging dir. If the upload was a single
    .zip, extract it first (once). Returns the store-root abs path, or None."""
    # Extract a staged zip on first use.
    for name in os.listdir(staging_abs) if os.path.isdir(staging_abs) else []:
        if name.lower().endswith(".zip"):
            _extract_zip_once(os.path.join(staging_abs, name), os.path.join(staging_abs, "_extracted"))
            break
    zroot = find_zarr_root(staging_abs)
    if zroot:
        _strip_ds_store_in_groups(zroot)
    return zroot


def recover_interrupted_swap(
    staging_abs: str,
    target_zarr_abs: str,
    *,
    dispose: bool = True,
) -> None:
    """Undo a half-finished swap so a retry can still find the candidate and the live sidecar.

    Crash window: the candidate may have been renamed to ``<target>.incoming`` and the
    live sidecar to ``<target>.old``. Deleting those leftovers would destroy both copies.

    ``dispose=False`` (validate) only restores what is needed to re-read the candidate;
    leftover ``.old`` / ``.incoming`` that do not belong to this staging folder are left
    for replace to delete. ``.trash-*`` dirs from a killed process are always reaped.
    """
    tgt = os.path.abspath(target_zarr_abs)
    staging = os.path.abspath(staging_abs)
    incoming = tgt + ".incoming"
    old = tgt + ".old"
    _reap_swap_trash(tgt, staging)

    if not os.path.isdir(tgt) and os.path.isdir(old):
        os.rename(old, tgt)
    elif dispose and os.path.isdir(tgt) and os.path.isdir(old):
        _dispose_dir(old)

    if not os.path.isdir(incoming):
        return
    # Incoming is this attempt's candidate only when staging no longer has a store
    # (it was renamed out). A brand-new zip upload has no `_extracted` yet — leftover
    # incoming from an older attempt must not be pulled into the new staging folder.
    has_store = find_zarr_root(staging) is not None
    extracted = os.path.isdir(os.path.join(staging, "_extracted"))
    has_zip = any(n.lower().endswith(".zip") for n in os.listdir(staging)) if os.path.isdir(staging) else False
    belongs_here = (not has_store) and (extracted or not has_zip)
    if belongs_here:
        dest = os.path.join(staging, _RESTORED_INCOMING_NAME)
        if os.path.isdir(dest):
            _dispose_dir(dest)
        os.makedirs(staging, exist_ok=True)
        os.rename(incoming, dest)
    elif dispose:
        _dispose_dir(incoming)


def validate_replacement(
    candidate_zarr_abs: str,
    slide_wh: Optional[Tuple[int, int]] = None,
) -> Dict[str, Any]:
    """Validate a candidate .zarr as a whole-sidecar replacement. `slide_wh` is the
    target slide's (width, height) in level-0 pixels (from the frontend). Returns
    {ok, errors[], warnings[], summary}. Errors block; warnings are advisory."""
    if not ZARR_AVAILABLE:
        return {"ok": False, "errors": ["Server is missing the 'zarr' dependency."], "warnings": [], "summary": {}}

    errors: List[str] = []
    warnings: List[str] = []
    summary: Dict[str, Any] = {}

    try:
        g = zarr.open_group(candidate_zarr_abs, mode="r")
    except Exception as e:
        return {"ok": False, "errors": [f"Not a readable Zarr store: {e}"], "warnings": [], "summary": {}}

    top = list(g.keys())
    summary["top_level_groups"] = top
    if "Cell-Segmentation" not in top:
        errors.append("Missing required group 'Cell-Segmentation' (nuclei segmentation).")
        return {"ok": False, "errors": errors, "warnings": warnings, "summary": summary}

    seg = g["Cell-Segmentation"]
    present = list(seg.keys())
    for a in _REQUIRED_SEG_ARRAYS:
        if a not in present:
            errors.append(f"Cell-Segmentation is missing required array '{a}'.")

    def _arr(name):
        try:
            return seg[name]
        except Exception:
            return None

    cen, con, prob, emb = _arr("centroids"), _arr("contours"), _arr("probabilities"), _arr("embeddings")

    counts: Dict[str, int] = {}
    for nm, a in (("centroids", cen), ("contours", con), ("probabilities", prob), ("embeddings", emb)):
        if a is not None:
            counts[nm] = int(a.shape[0])
    summary["counts"] = counts
    if len(set(counts.values())) > 1:
        errors.append(f"Inconsistent cell counts across arrays: {counts}")
    summary["nuclei_count"] = int(cen.shape[0]) if cen is not None else None

    if cen is not None and (cen.ndim != 2 or cen.shape[1] != 2):
        errors.append(f"'centroids' must be shape (N, 2); got {tuple(cen.shape)}.")
    if con is not None and (con.ndim != 3 or con.shape[2] != 2):
        errors.append(f"'contours' must be shape (N, K, 2); got {tuple(con.shape)}.")

    if emb is None:
        warnings.append("No Cell-Segmentation/embeddings — cell classification will need to re-run embedding.")

    if cen is not None and cen.ndim == 2 and cen.shape[1] == 2 and cen.shape[0] > 0:
        try:
            mn, mx = _centroid_bounds(cen)
        except Exception as e:
            errors.append(f"Could not read centroids: {e}")
        else:
            summary["centroid_min"], summary["centroid_max"] = mn, mx
            if min(mn) < 0:
                errors.append(f"Negative centroid coordinates {mn} — invalid coordinate space.")
            if slide_wh:
                W, H = slide_wh
                summary["slide_dimensions"] = [int(W), int(H)]
                if mx[0] >= W or mx[1] >= H:
                    errors.append(
                        f"Centroids exceed the slide size: max {mx} vs slide (W={W}, H={H}). "
                        f"This looks like a different slide or resolution."
                    )
            else:
                summary["slide_dimensions"] = None
                warnings.append("Slide dimensions not provided — skipped the coordinate-bounds check.")

    if "Patch-Segmentation" not in top:
        warnings.append("No Patch-Segmentation — patch/tissue workflows will be unavailable on this slide.")

    return {"ok": len(errors) == 0, "errors": errors, "warnings": warnings, "summary": summary}


def apply_replacement(
    candidate_zarr_abs: str,
    target_zarr_abs: str,
    slide_wh: Optional[Tuple[int, int]] = None,
) -> Dict[str, Any]:
    """Crash-safe whole-.zarr swap. Re-validates first and refuses on any error, so
    the target is never touched unless the candidate is valid. Staging is already an
    uploaded copy, so the incoming tree is renamed into place on the same filesystem;
    copytree is only used across devices.

    On failure the candidate is renamed back to its staging path (not deleted), so
    the user can retry without re-uploading.
    """
    v = validate_replacement(candidate_zarr_abs, slide_wh)
    if not v["ok"]:
        raise ValueError("Candidate failed validation: " + "; ".join(v["errors"]))

    cand = os.path.abspath(candidate_zarr_abs)
    tgt = os.path.abspath(target_zarr_abs)
    if cand == tgt:
        raise ValueError("Candidate and target are the same path.")
    if not os.path.isdir(cand):
        raise ValueError(f"Candidate Zarr not found: {cand}")

    incoming = tgt + ".incoming"
    old = tgt + ".old"

    # A previous swap may have moved the live sidecar aside; put it back first.
    if not os.path.isdir(tgt) and os.path.isdir(old):
        os.rename(old, tgt)
    elif os.path.isdir(tgt) and os.path.isdir(old):
        _dispose_dir(old)

    # Staging is already an uploaded copy (deleted after swap), so prefer a
    # same-filesystem rename over copytree — a full copy of a large .zarr can
    # take minutes and trip reverse-proxy idle timeouts ("network error").
    moved = _stage_incoming(cand, incoming)

    had_old = os.path.isdir(tgt)
    try:
        if had_old:
            os.rename(tgt, old)      # move current aside (transient, not a backup)
        os.rename(incoming, tgt)     # new preprocessing into place
    except Exception as e:
        if not os.path.isdir(tgt) and os.path.isdir(old):
            try:
                os.rename(old, tgt)
            except OSError:
                pass
        _restore_candidate(incoming, cand, moved)
        raise ValueError(f"Swap failed; target left unchanged: {e}")

    # Deleting the replaced tree can take minutes; don't hold the HTTP request.
    if os.path.isdir(old):
        _dispose_dir(old)
    return {"ok": True, "target_zarr": tgt, "nuclei_count": v["summary"].get("nuclei_count"), "warnings": v["warnings"]}


def _same_device(src: str, dst_parent: str) -> bool:
    try:
        return os.stat(src).st_dev == os.stat(dst_parent).st_dev
    except OSError:
        return False


def _stage_incoming(cand: str, incoming: str) -> bool:
    """Place the candidate at ``incoming``. Returns True if cand was moved
    (same-device rename), False if it was copied."""
    if os.path.abspath(cand) == os.path.abspath(incoming):
        return False
    if os.path.isdir(incoming):
        if not os.path.isdir(cand):
            return True  # already moved here by a previous attempt
        _dispose_dir(incoming)
    parent = os.path.dirname(incoming)
    os.makedirs(parent, exist_ok=True)
    if _same_device(cand, parent):
        try:
            os.rename(cand, incoming)
            return True
        except OSError:
            pass
    shutil.copytree(cand, incoming)
    return False


def _restore_candidate(incoming: str, cand: str, moved: bool) -> None:
    """After a failed swap, put the candidate back (or drop a disposable copy)."""
    if not os.path.isdir(incoming):
        return
    if moved and not os.path.isdir(cand):
        try:
            os.makedirs(os.path.dirname(cand), exist_ok=True)
            os.rename(incoming, cand)
            return
        except OSError:
            pass
    if not moved:
        _dispose_dir(incoming)


def _rmtree_bg(path: str) -> None:
    if path and os.path.isdir(path):
        threading.Thread(
            target=shutil.rmtree, args=(path,), kwargs={"ignore_errors": True}, daemon=True
        ).start()


def _reap_prefixed_dirs(parent: str, prefixes: Tuple[str, ...]) -> None:
    if not os.path.isdir(parent):
        return
    try:
        names = os.listdir(parent)
    except OSError:
        return
    for name in names:
        if any(name.startswith(p) for p in prefixes):
            _rmtree_bg(os.path.join(parent, name))


def _reap_swap_trash(target_zarr_abs: str, staging_abs: str) -> None:
    """Background-delete ``.trash-*`` leftovers left by a process that exited mid-delete."""
    tgt = os.path.abspath(target_zarr_abs)
    base = os.path.basename(tgt)
    _reap_prefixed_dirs(
        os.path.dirname(tgt),
        (base + ".old.trash-", base + ".incoming.trash-", base + ".trash-"),
    )
    _reap_prefixed_dirs(staging_abs, (_RESTORED_INCOMING_NAME + ".trash-",))


def _dispose_dir(path: str) -> None:
    """Rename ``path`` aside and delete it in a daemon thread so callers are not blocked."""
    if not path or not os.path.isdir(path):
        return
    trash = f"{path}.trash-{os.getpid()}-{threading.get_ident()}"
    n = 0
    while os.path.exists(trash):
        n += 1
        trash = f"{path}.trash-{os.getpid()}-{threading.get_ident()}-{n}"
    try:
        os.rename(path, trash)
    except OSError:
        shutil.rmtree(path, ignore_errors=True)
        return
    _rmtree_bg(trash)


def _remove_extract_marker(root: str) -> None:
    try:
        os.remove(os.path.join(root, _EXTRACT_DONE))
    except OSError:
        pass


def _extract_zip_once(zip_path: str, extract_dir: str) -> None:
    """Extract ``zip_path`` into ``extract_dir`` once. Writes to a temp dir first so a
    failed/interrupted extract cannot leave a half-written tree that would be skipped
    on retry. A completed tmp (marker file present) is renamed into place instead of
    being deleted and extracted again."""
    tmp = extract_dir + ".tmp"
    if os.path.isdir(extract_dir):
        _rmtree_bg(tmp)
        _remove_extract_marker(extract_dir)
        return
    if os.path.isdir(tmp) and os.path.isfile(os.path.join(tmp, _EXTRACT_DONE)):
        try:
            os.rename(tmp, extract_dir)
            _remove_extract_marker(extract_dir)
            return
        except OSError:
            pass
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    try:
        with zipfile.ZipFile(zip_path) as zf:
            tmp_root = os.path.realpath(tmp)
            for member in zf.namelist():
                dest = os.path.realpath(os.path.join(tmp, member))
                if dest != tmp_root and not dest.startswith(tmp_root + os.sep):
                    continue  # zip-slip guard
                zf.extract(member, tmp)
        with open(os.path.join(tmp, _EXTRACT_DONE), "wb"):
            pass
        os.rename(tmp, extract_dir)
        _remove_extract_marker(extract_dir)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def _centroid_bounds(cen) -> Tuple[List[int], List[int]]:
    """Min/max over centroids without loading the whole array into memory."""
    n = int(cen.shape[0])
    chunks = getattr(cen, "chunks", None)
    step = int(chunks[0]) if chunks and chunks[0] else 262144
    step = min(max(step, 65536), 1_048_576)
    mn = mx = None
    for i in range(0, n, step):
        sl = np.asarray(cen[i : i + step])
        if sl.size == 0:
            continue
        sl_min = sl.min(axis=0)
        sl_max = sl.max(axis=0)
        mn = sl_min if mn is None else np.minimum(mn, sl_min)
        mx = sl_max if mx is None else np.maximum(mx, sl_max)
    if mn is None or mx is None:
        raise ValueError("centroids array is empty")
    return [int(x) for x in mn], [int(x) for x in mx]


def _zarr_json_node_type(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        nt = meta.get("node_type")
        return nt if isinstance(nt, str) else None
    except Exception:
        return None


def _is_group_dir(root: str, files: List[str]) -> bool:
    if ".zgroup" in files:
        return True
    if "zarr.json" in files:
        return _zarr_json_node_type(os.path.join(root, "zarr.json")) == "group"
    return False


def _strip_ds_store_in_groups(zroot: str) -> None:
    """Remove .DS_Store from group directories only — never walk array chunk trees."""
    for root, dirs, files in os.walk(zroot):
        dirs[:] = [d for d in dirs if d not in _SKIP_WALK_DIRS]
        if ".DS_Store" in files:
            try:
                os.remove(os.path.join(root, ".DS_Store"))
            except OSError:
                pass
        if root != zroot and not _is_group_dir(root, files):
            dirs.clear()
