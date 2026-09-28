"""Per-class tissue masks derived from patch classification.

Patch classifiers (MUSK / H-optimus-0 / Virchow task nodes) label each patch
and leave the labels in ``Patch-Classification/class_indices``. Region-level
analysis wants a raster, not a list of boxes, so before analysis code runs the
service turns those labels into one mask per class under the same
``Tissue-Segmentation/masks/<tissue>/mask`` layout VISTA writes. The viewer,
the mask API and the coding agent then see patch classes and VISTA tissues
through one interface.

Masks are stored at PATCH-GRID resolution, not slide resolution: one cell per
patch. A 40x slide is ~100k px across but only a few hundred patches, so the
full-resolution raster would be gigabytes of redundant bits. The mask group
carries the transform back to level-0 pixels:

    scale   -- level-0 pixels per cell (the patch stride)
    origin  -- level-0 pixel of cell (0, 0), i.e. the smallest patch corner

    level0_x = origin[0] + col * scale
    level0_y = origin[1] + row * scale

``get_segmentation_mask`` honours these when it serves a viewport, so the
overlay renders correctly without the frontend knowing about the grid.

Masks are written raw: exactly the patches the classifier labelled, no
morphology. Cleaning (close/open, hole filling) is analysis-specific and
belongs in the analysis code, where its parameters are visible.

``Patch-Classification`` is single-label and holds only the LAST classification
run, but classifiers are often independent binary models (a tumour classifier
and an epithelium classifier both fire on tumour patches). So masks
ACCUMULATE across runs: each run writes the masks for its own classes, keyed
by class name, and leaves masks from earlier runs in place. Same name = same
concept, latest run wins; every mask records which run produced it
(``run_digest``, ``classifier``, ``model``, ``derived_at``). The derivation is
called after every task-node run and again before analysis code, and is
idempotent: a digest of the current labels/classes/grid is stored on the
group and a repeat call with the same classification is a no-op.

Masks this module wrote are tagged ``source = "patch_classification"``; masks
from other producers (VISTA) are never touched, so both can coexist in one
store. Resetting the patch classification removes every mask this module
wrote, from every run.
"""
import hashlib
import logging
import re
import time
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from app.config.zarr_compat import create_array, open_zarr_cm

logger = logging.getLogger(__name__)

PATCH_CLASSIFICATION_GROUP = "Patch-Classification"
TISSUE_SEGMENTATION_GROUP = "Tissue-Segmentation"
MASK_SOURCE = "patch_classification"

# Attrs on the Tissue-Segmentation group that let a later call recognise its
# own output.
DIGEST_ATTR = "patch_masks_digest"
OWNED_CLASSES_ATTR = "patch_masks_classes"
UPDATED_ATTR = "patch_masks_updated_at"

_BYTES_DTYPE = "S256"


def sanitize_class_name(name: str) -> str:
    """Zarr-safe subgroup name for a class, matching the task nodes'
    ``_sanitize_class_name``: separators become underscores, case is kept
    ("Lymph node" -> "Lymph_node"). Readers compare with ``_norm_tissue_key``,
    which folds case and separators, so display name and subgroup still match.
    """
    s = re.sub(r"[\s/\\]+", "_", str(name or "").strip())
    s = re.sub(r"[^A-Za-z0-9_\-]", "", s)
    return s or "class"


def _decode(values) -> List[str]:
    out = []
    for v in np.asarray(values).ravel().tolist():
        if isinstance(v, (bytes, bytearray)):
            v = v.decode("utf-8", errors="replace")
        out.append(str(v))
    return out


def _read_classes(pc_group) -> Tuple[List[str], List[str]]:
    """(names, colors) of the patch classes, from ``classes/{name,color}``
    with the group attrs as fallback."""
    names: List[str] = []
    colors: List[str] = []
    if "classes" in pc_group:
        cls = pc_group["classes"]
        if "name" in cls:
            names = _decode(cls["name"][:])
        if "color" in cls:
            colors = _decode(cls["color"][:])
    if not names:
        names = [str(n) for n in (pc_group.attrs.get("class_names") or [])]
        colors = [str(c) for c in (pc_group.attrs.get("class_colors") or [])]
    colors = (colors + [""] * len(names))[: len(names)]
    return names, colors


def _grid_from_coordinates(coords: np.ndarray) -> Tuple[int, Tuple[int, int], np.ndarray, np.ndarray]:
    """Patch stride, grid origin and the (row, col) of every patch.

    Coordinates are ``[x1, y1, x2, y2]`` level-0 boxes on a regular grid. The
    stride is the modal box width — read from the boxes rather than the
    metadata ``patch_size``, which is in level pixels and diverges from the
    level-0 span when the run used a pyramid level.
    """
    x1 = coords[:, 0].astype(np.int64)
    y1 = coords[:, 1].astype(np.int64)
    widths = (coords[:, 2] - coords[:, 0]).astype(np.int64)
    widths = widths[widths > 0]
    if widths.size == 0:
        raise ValueError("patch coordinates have no positive width")
    vals, counts = np.unique(widths, return_counts=True)
    scale = int(vals[np.argmax(counts)])
    origin = (int(x1.min()), int(y1.min()))
    cols = (x1 - origin[0]) // scale
    rows = (y1 - origin[1]) // scale
    return scale, origin, rows, cols


def _digest(class_indices: np.ndarray, names: Sequence[str], scale: int,
            origin: Tuple[int, int], shape: Tuple[int, int]) -> str:
    h = hashlib.sha1()
    h.update(np.ascontiguousarray(class_indices, dtype=np.int32).tobytes())
    h.update("\x00".join(names).encode("utf-8"))
    h.update(f"|{scale}|{origin[0]},{origin[1]}|{shape[0]}x{shape[1]}|v1".encode())
    return h.hexdigest()


def _owned_subgroups(masks_group) -> List[str]:
    out = []
    for sub in list(masks_group.keys()):
        try:
            grp = masks_group[sub]
            if hasattr(grp, "attrs") and grp.attrs.get("source") == MASK_SOURCE:
                out.append(sub)
        except Exception:
            continue
    return out


def _write_classes(ts_group, names: Sequence[str], colors: Sequence[str]) -> None:
    cls = ts_group.require_group("classes")
    create_array(cls, "index", data=np.arange(len(names), dtype=np.int32), overwrite=True)
    create_array(cls, "name",
                 data=np.array([n.encode("utf-8") for n in names], dtype=_BYTES_DTYPE),
                 overwrite=True)
    create_array(cls, "color",
                 data=np.array([c.encode("utf-8") for c in colors], dtype=_BYTES_DTYPE),
                 overwrite=True)


def _read_ts_classes(ts_group) -> Tuple[List[str], List[str]]:
    if "classes" not in ts_group:
        return [], []
    cls = ts_group["classes"]
    names = _decode(cls["name"][:]) if "name" in cls else []
    colors = _decode(cls["color"][:]) if "color" in cls else []
    colors = (colors + [""] * len(names))[: len(names)]
    return names, colors


def _norm(name: str) -> str:
    return str(name or "").strip().lower().replace("_", " ")


def clear_patch_masks(zf) -> List[str]:
    """Remove every mask this module wrote from an open (writable) store.

    Other producers' masks and class entries stay. The Tissue-Segmentation
    group itself is dropped only when nothing else is left in it. Returns the
    store paths removed.
    """
    removed: List[str] = []
    if TISSUE_SEGMENTATION_GROUP not in zf:
        return removed
    ts = zf[TISSUE_SEGMENTATION_GROUP]
    owned_names = [str(n) for n in (ts.attrs.get(OWNED_CLASSES_ATTR) or [])]
    if "masks" in ts:
        masks = ts["masks"]
        for sub in _owned_subgroups(masks):
            del masks[sub]
            removed.append(f"{TISSUE_SEGMENTATION_GROUP}/masks/{sub}")
        remaining = list(masks.keys())
    else:
        remaining = []
    if owned_names:
        names, colors = _read_ts_classes(ts)
        drop = {_norm(n) for n in owned_names}
        kept = [(n, c) for n, c in zip(names, colors) if _norm(n) not in drop]
        if kept:
            _write_classes(ts, [n for n, _ in kept], [c for _, c in kept])
        elif "classes" in ts:
            del ts["classes"]
    for key in (DIGEST_ATTR, OWNED_CLASSES_ATTR, UPDATED_ATTR):
        if key in ts.attrs:
            del ts.attrs[key]
    if not remaining and "classes" not in ts:
        del zf[TISSUE_SEGMENTATION_GROUP]
        removed.append(TISSUE_SEGMENTATION_GROUP)
    return removed


def _run_provenance(pc_group) -> Dict[str, str]:
    """What the task node recorded about this classification run, if anything."""
    out: Dict[str, str] = {}
    try:
        if "metadata" in pc_group:
            attrs = dict(pc_group["metadata"].attrs)
            for key in ("classifier", "model", "classification_method", "created_at", "patch_size"):
                if key in attrs and attrs[key] is not None:
                    out[key] = str(attrs[key])
    except Exception:
        pass
    return out


def ensure_patch_masks(zarr_path: str) -> Dict:
    """Add the current ``Patch-Classification`` run to ``Tissue-Segmentation/masks``.

    One boolean mask per class of the current run, on the patch grid (see
    module docstring). Masks from earlier runs whose class names are not in
    this run stay. Returns a small status dict; ``status`` is one of

        skipped    -- no patch classification in the store
        unchanged  -- this classification run was already applied
        written    -- masks for this run (re)built

    Never raises for a missing or malformed classification: analysis should
    still run on whatever the store holds. Storage errors do propagate.
    """
    t0 = time.time()
    with open_zarr_cm(zarr_path, "a") as zf:
        if PATCH_CLASSIFICATION_GROUP not in zf:
            return {"status": "skipped", "reason": "no Patch-Classification group"}
        pc = zf[PATCH_CLASSIFICATION_GROUP]
        if "class_indices" not in pc or "coordinates" not in pc:
            return {"status": "skipped", "reason": "Patch-Classification lacks class_indices/coordinates"}

        class_indices = np.asarray(pc["class_indices"][:]).astype(np.int32).ravel()
        coords = np.asarray(pc["coordinates"][:])
        if coords.ndim != 2 or coords.shape[1] < 4 or coords.shape[0] != class_indices.shape[0]:
            return {"status": "skipped",
                    "reason": f"coordinates {coords.shape} do not match class_indices {class_indices.shape}"}
        if class_indices.size == 0:
            return {"status": "skipped", "reason": "no patches"}

        names, colors = _read_classes(pc)
        if not names:
            return {"status": "skipped", "reason": "no class names"}

        scale, origin, rows, cols = _grid_from_coordinates(coords)
        shape = (int(rows.max()) + 1, int(cols.max()) + 1)
        digest = _digest(class_indices, names, scale, origin, shape)

        ts = zf.require_group(TISSUE_SEGMENTATION_GROUP)
        if ts.attrs.get(DIGEST_ATTR) == digest and "masks" in ts:
            return {"status": "unchanged", "classes": names, "shape": list(shape), "scale": scale}

        provenance = _run_provenance(pc)
        derived_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        masks = ts.require_group("masks")
        # Class names this module owns from earlier runs. Anything else under
        # masks/ or in classes/ belongs to another producer and is preserved.
        previous_owned = [str(n) for n in (ts.attrs.get(OWNED_CLASSES_ATTR) or [])]
        written = []
        for cls_idx, (name, color) in enumerate(zip(names, colors)):
            sub = sanitize_class_name(name)
            if sub in masks:
                existing = masks[sub]
                if getattr(existing, "attrs", {}).get("source") != MASK_SOURCE:
                    logger.info("[patch_masks] masks/%s belongs to another producer; leaving it", sub)
                    continue
                del masks[sub]
            grid = np.zeros(shape, dtype=bool)
            sel = class_indices == cls_idx
            grid[rows[sel], cols[sel]] = True
            grp = masks.create_group(sub)
            create_array(grp, "mask", data=grid, overwrite=True)
            grp.attrs.update({
                "source": MASK_SOURCE,
                "class_name": name,
                "class_index": int(cls_idx),
                "color": color,
                "scale": int(scale),
                "origin": [int(origin[0]), int(origin[1])],
                "patch_count": int(sel.sum()),
                "coordinate_space": "patch grid; level0 = origin + cell * scale",
                "run_digest": digest,
                "derived_at": derived_at,
                **provenance,
            })
            written.append(name)

        # classes/{index,name,color}: keep every existing entry (other
        # producers' and earlier runs'), refresh the colour of names this run
        # wrote, append names that are new. The viewer matches masks to
        # classes by NAME, so order only affects the menu.
        existing_names, existing_colors = _read_ts_classes(ts)
        run_color = {_norm(n): c for n, c in zip(written, colors[: len(written)])}
        final = [(n, run_color.get(_norm(n), c)) for n, c in zip(existing_names, existing_colors)]
        have = {_norm(n) for n, _ in final}
        for n in written:
            if _norm(n) not in have:
                final.append((n, run_color[_norm(n)]))
                have.add(_norm(n))
        _write_classes(ts, [n for n, _ in final], [c for _, c in final])

        owned = list(previous_owned)
        owned_norm = {_norm(n) for n in owned}
        for n in written:
            if _norm(n) not in owned_norm:
                owned.append(n)
                owned_norm.add(_norm(n))
        ts.attrs[DIGEST_ATTR] = digest
        ts.attrs[OWNED_CLASSES_ATTR] = owned
        ts.attrs[UPDATED_ATTR] = derived_at

    logger.info("[patch_masks] %s: wrote %d masks (%s) on a %dx%d grid (scale %d) in %.2fs; %d classes now",
                zarr_path, len(written), ", ".join(written), shape[0], shape[1], scale,
                time.time() - t0, len(owned))
    return {"status": "written", "classes": written, "all_classes": owned,
            "shape": list(shape), "scale": scale}


def mask_grid_transform(mask_group) -> Tuple[int, Tuple[int, int]]:
    """(scale, origin) recorded on a ``masks/<tissue>`` group; ``(1, (0, 0))``
    for masks stored at slide resolution (VISTA) or when attrs are unreadable."""
    try:
        attrs = mask_group.attrs
        scale = int(attrs.get("scale", 1) or 1)
        origin = attrs.get("origin") or [0, 0]
        ox, oy = int(origin[0]), int(origin[1])
        if scale < 1:
            scale = 1
        return scale, (ox, oy)
    except Exception:
        return 1, (0, 0)
