"""Bake cell / patch classification colors onto a slide thumbnail.

Used by the cohort gallery's overlay-thumbnail variants. Given the base
thumbnail JPEG and the slide's `.zarr` classification, paint either per-cell
centroid dots (``kind="cell"``) or per-patch filled rectangles
(``kind="patch"``), scaling level-0 coordinates down to the thumbnail.

Returns ``None`` whenever the requested classification isn't present (or can't
be read), so callers fall back to serving the plain thumbnail unchanged. The
overlay itself is never the "critical" artifact — a missing/partial overlay
must degrade to the normal thumbnail, never raise.
"""

import io
import os
from typing import Dict, Optional, Tuple

import numpy as np
from PIL import Image, ImageDraw

from app.config.zarr_compat import as_zarr_path

# How opaque the painted overlay is over the thumbnail.
_CELL_ALPHA = 200   # centroid dots — near-opaque so sparse cells stay visible
_PATCH_ALPHA = 110  # patch fills — translucent so tissue shows through


def _zarr_path_for(wsi_path: str) -> str:
    """The slide's zarr store path (``<wsi>.zarr``), as used across the service."""
    return as_zarr_path(str(wsi_path))


def _array_dir_exists(zpath: str, *parts: str) -> bool:
    """True if a zarr array path exists on disk (v2/v3 directory store).

    Top-level analysis groups are created early with only ``userData`` (see
    ``write_node_userdata``), so group dirs alone are not proof of overlay data.
    Match what ``_bake_cell`` / ``_bake_patch`` actually require.
    """
    return os.path.isdir(os.path.join(zpath, *parts))


def overlay_available(wsi_path: str) -> Dict[str, bool]:
    """Cheap, no-data-load check of which overlays a slide supports.

    Checks for the real result arrays (not merely group folders that may only
    hold ``userData``). Returns ``{"cell": bool, "patch": bool}``.
    """
    zpath = _zarr_path_for(wsi_path)
    try:
        cell = (
            _array_dir_exists(zpath, "Cell-Segmentation", "centroids")
            and _array_dir_exists(zpath, "Cell-Classification", "class_indices")
        )
        patch = (
            _array_dir_exists(zpath, "Patch-Segmentation", "coordinates")
            and _array_dir_exists(zpath, "Patch-Classification", "class_indices")
        )
    except Exception:
        return {"cell": False, "patch": False}
    return {"cell": bool(cell), "patch": bool(patch)}


def _hex_to_rgb(h: str) -> Tuple[int, int, int]:
    h = str(h).lstrip("#")
    if len(h) != 6:
        return (128, 128, 128)
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        return (128, 128, 128)


def _resolve_palette(group) -> Optional[list]:
    """Hex color list indexed by class id — metadata attr first, then dataset.

    Mirrors SegmentationHandler.load_file: prefer ``attrs['class_colors']``
    (current format), fall back to the ``classes/color`` dataset (legacy).
    """
    try:
        mc = group.attrs.get("class_colors", None)
        if mc is not None and len(mc) > 0:
            return [str(c) for c in mc]
    except Exception:
        pass
    try:
        if "classes/color" in group:
            return [
                c.decode("utf-8") if isinstance(c, (bytes, bytearray)) else str(c)
                for c in group["classes/color"][:]
            ]
    except Exception:
        pass
    return None


def _palette_rgb(palette: list) -> np.ndarray:
    return np.array([_hex_to_rgb(c) for c in palette], dtype=np.uint8)


def _bake_cell(zf, size: Tuple[int, int], sx: float, sy: float) -> Optional[Image.Image]:
    if "Cell-Segmentation" not in zf or "Cell-Classification" not in zf:
        return None
    seg = zf["Cell-Segmentation"]
    cls = zf["Cell-Classification"]
    if "centroids" not in seg or "class_indices" not in cls:
        return None
    palette = _resolve_palette(cls)
    if not palette:
        return None
    centroids = np.asarray(seg["centroids"][:])
    class_id = np.asarray(cls["class_indices"][:]).astype(int)
    if centroids.ndim != 2 or centroids.shape[0] == 0:
        return None
    n = min(len(centroids), len(class_id))
    centroids, class_id = centroids[:n], class_id[:n]

    w, h = size
    valid = (class_id >= 0) & (class_id < len(palette))
    if not np.any(valid):
        return None
    xs = np.clip((centroids[valid, 0] * sx).astype(int), 0, w - 1)
    ys = np.clip((centroids[valid, 1] * sy).astype(int), 0, h - 1)
    cols = _palette_rgb(palette)[class_id[valid]]  # (M, 3)

    # Vectorized scatter into an RGBA buffer — handles 100k+ cells instantly.
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[ys, xs, 0:3] = cols
    arr[ys, xs, 3] = _CELL_ALPHA
    return Image.fromarray(arr, "RGBA")


def _bake_patch(zf, size: Tuple[int, int], sx: float, sy: float) -> Optional[Image.Image]:
    if "Patch-Segmentation" not in zf or "Patch-Classification" not in zf:
        return None
    seg = zf["Patch-Segmentation"]
    cls = zf["Patch-Classification"]
    if "coordinates" not in seg or "class_indices" not in cls:
        return None
    palette = _resolve_palette(cls)
    if not palette:
        return None
    coords = np.asarray(seg["coordinates"][:])
    class_id = np.asarray(cls["class_indices"][:]).astype(int)
    if coords.ndim != 2 or coords.shape[0] == 0 or coords.shape[1] < 4:
        return None
    n = min(len(coords), len(class_id))
    coords, class_id = coords[:n], class_id[:n]
    pal_rgb = _palette_rgb(palette)

    overlay = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay, "RGBA")
    painted = False
    for (x1, y1, x2, y2), cid in zip(coords, class_id):
        if cid < 0 or cid >= len(palette):
            continue
        r, g, b = (int(v) for v in pal_rgb[cid])
        draw.rectangle(
            [float(x1) * sx, float(y1) * sy, float(x2) * sx, float(y2) * sy],
            fill=(r, g, b, _PATCH_ALPHA),
        )
        painted = True
    return overlay if painted else None


def _tile_cell(zf, size: Tuple[int, int], region, sx: float, sy: float,
               dot_radius: int = 1) -> Optional[Image.Image]:
    """Overlay-only RGBA image of cell dots for cells inside `region` (level-0).

    ``dot_radius`` controls the painted square's half-size in tile pixels (0 = a
    single pixel, 2 = a 5x5 block), so the popup's size slider can fatten the
    dots for visibility when zoomed in.
    """
    if "Cell-Segmentation" not in zf or "Cell-Classification" not in zf:
        return None
    seg, cls = zf["Cell-Segmentation"], zf["Cell-Classification"]
    if "centroids" not in seg or "class_indices" not in cls:
        return None
    palette = _resolve_palette(cls)
    if not palette:
        return None
    cent = np.asarray(seg["centroids"][:])
    cid = np.asarray(cls["class_indices"][:]).astype(int)
    if cent.ndim != 2 or cent.shape[0] == 0:
        return None
    n = min(len(cent), len(cid))
    cent, cid = cent[:n], cid[:n]
    x0, y0, x1, y1 = region
    w, h = size
    inb = (
        (cent[:, 0] >= x0) & (cent[:, 0] < x1)
        & (cent[:, 1] >= y0) & (cent[:, 1] < y1)
        & (cid >= 0) & (cid < len(palette))
    )
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    if np.any(inb):
        px = np.clip(((cent[inb, 0] - x0) * sx).astype(int), 0, w - 1)
        py = np.clip(((cent[inb, 1] - y0) * sy).astype(int), 0, h - 1)
        cols = _palette_rgb(palette)[cid[inb]]
        r = max(0, min(int(dot_radius), 8))  # clamp; vectorized square stamp per offset
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                yy = np.clip(py + dy, 0, h - 1)
                xx = np.clip(px + dx, 0, w - 1)
                arr[yy, xx, 0:3] = cols
                arr[yy, xx, 3] = _CELL_ALPHA
    return Image.fromarray(arr, "RGBA")  # transparent where unpainted


def _tile_patch(zf, size: Tuple[int, int], region, sx: float, sy: float) -> Optional[Image.Image]:
    """Overlay-only RGBA image of patch fills intersecting `region` (level-0)."""
    if "Patch-Segmentation" not in zf or "Patch-Classification" not in zf:
        return None
    seg, cls = zf["Patch-Segmentation"], zf["Patch-Classification"]
    if "coordinates" not in seg or "class_indices" not in cls:
        return None
    palette = _resolve_palette(cls)
    if not palette:
        return None
    coords = np.asarray(seg["coordinates"][:])
    cid = np.asarray(cls["class_indices"][:]).astype(int)
    if coords.ndim != 2 or coords.shape[0] == 0 or coords.shape[1] < 4:
        return None
    n = min(len(coords), len(cid))
    coords, cid = coords[:n], cid[:n]
    x0, y0, x1, y1 = region
    pal_rgb = _palette_rgb(palette)
    inb = (
        (coords[:, 2] >= x0) & (coords[:, 0] < x1)
        & (coords[:, 3] >= y0) & (coords[:, 1] < y1)
        & (cid >= 0) & (cid < len(palette))
    )
    overlay = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay, "RGBA")
    for idx in np.where(inb)[0]:
        px1, py1, px2, py2 = coords[idx]
        r, g, b = (int(v) for v in pal_rgb[cid[idx]])
        draw.rectangle(
            [(float(px1) - x0) * sx, (float(py1) - y0) * sy,
             (float(px2) - x0) * sx, (float(py2) - y0) * sy],
            fill=(r, g, b, _PATCH_ALPHA),
        )
    return overlay


def bake_tile_overlay(
    wsi_path: str,
    kind: str,
    region_level0: Tuple[float, float, float, float],
    tile_px: Tuple[int, int],
    dot_radius: int = 1,
) -> Optional[bytes]:
    """Overlay-ONLY transparent PNG tile for a level-0 ``(x0,y0,x1,y1)`` region.

    Used as a second OSD tiled layer over the slide in the detail popup. Returns
    PNG bytes (transparent where nothing is painted), or ``None`` when the slide
    lacks the requested classification (caller serves a transparent tile).
    ``dot_radius`` only affects cell dots (the popup size slider).
    """
    if kind not in ("cell", "patch"):
        return None
    zpath = _zarr_path_for(wsi_path)
    if not os.path.isdir(zpath):
        return None
    try:
        from app.config.zarr_compat import open_group
        zf = open_group(zpath, mode="r")
        x0, y0, x1, y1 = (float(v) for v in region_level0)
        rw, rh = x1 - x0, y1 - y0
        tw, th = int(tile_px[0]), int(tile_px[1])
        if rw <= 0 or rh <= 0 or tw <= 0 or th <= 0:
            return None
        sx, sy = tw / rw, th / rh
        img = _tile_cell(zf, (tw, th), (x0, y0, x1, y1), sx, sy, dot_radius) if kind == "cell" \
            else _tile_patch(zf, (tw, th), (x0, y0, x1, y1), sx, sy)
        if img is None:
            return None
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        print(f"[overlay] bake_tile_overlay({kind}) failed for {wsi_path}: {e}")
        return None


def bake_overlay(
    base_jpeg: bytes,
    wsi_path: str,
    kind: str,
    level0_size: Tuple[int, int],
) -> Optional[bytes]:
    """Paint the ``kind`` ("cell"|"patch") classification onto a base thumbnail.

    ``level0_size`` is the slide's full-resolution (width, height), used to scale
    level-0 zarr coordinates down to the thumbnail. Returns JPEG bytes, or
    ``None`` if the overlay can't be produced (caller serves the plain thumb).
    """
    if kind not in ("cell", "patch"):
        return None
    zpath = _zarr_path_for(wsi_path)
    if not os.path.isdir(zpath):
        return None
    try:
        from app.config.zarr_compat import open_group
        zf = open_group(zpath, mode="r")
        base = Image.open(io.BytesIO(base_jpeg)).convert("RGBA")
        w, h = base.size
        l0w, l0h = level0_size
        if not l0w or not l0h:
            return None
        sx, sy = w / float(l0w), h / float(l0h)
        overlay = _bake_cell(zf, (w, h), sx, sy) if kind == "cell" \
            else _bake_patch(zf, (w, h), sx, sy)
        if overlay is None:
            return None
        out = Image.alpha_composite(base, overlay).convert("RGB")
        buf = io.BytesIO()
        out.save(buf, format="JPEG", quality=85)
        return buf.getvalue()
    except Exception as e:  # never let an overlay failure break the thumbnail
        print(f"[overlay] bake_overlay({kind}) failed for {wsi_path}: {e}")
        return None
