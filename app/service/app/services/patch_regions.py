"""Region polygons, crops and overviews from patch-classification masks.

Closes the loop between patch classification and region-level analysis code:

    Patch-Classification  --(patch_masks)-->  Tissue-Segmentation/masks/<class>/mask
                          --(this module)-->  contours JSON  +  per-region crops  +  overview PNG

``masks_to_contours``        one polygon list per class, in level-0 pixels, from the patch-grid
                             masks: close/open on the grid (kernel in patches), then contour
                             tracing; outer rings by default.
``crop_regions``             one PNG per polygon, cut from the slide around the polygon with the
                             outline drawn, in the layout <out_dir>/<i>/image.png.
``overview_with_contours``   slide thumbnail with every class's polygons drawn.
``build_case``               all three for one slide -> a case folder an analysis script or the
                             reflector agent can consume directly.

Morphology and coordinate conventions follow the offline experiment scripts
(close then open with a k x k patch kernel, vertex (col, row) -> (origin + col*scale, origin + row*scale)).
"""
import argparse
import json
import os
from typing import Any, Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

from app.config.zarr_compat import open_zarr_cm

TISSUE_SEGMENTATION_GROUP = "Tissue-Segmentation"
DEFAULT_COLORS = ["#e41a1c", "#377eb8", "#4daf4a", "#984ea3", "#ff7f00", "#a65628", "#f781bf", "#999999"]


def _norm(name: Any) -> str:
    return str(name or "").strip().lower().replace("_", " ")


def _hex_to_bgr(h: str) -> Tuple[int, int, int]:
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return (b, g, r)


def _mask_group_for(masks_group, class_name: str):
    """masks/<sub> whose subgroup name or class_name attr matches ``class_name``."""
    target = _norm(class_name)
    for sub in masks_group.keys():
        grp = masks_group[sub]
        if _norm(sub) == target or _norm(getattr(grp, "attrs", {}).get("class_name")) == target:
            return sub, grp
    return None, None


def _read_mpp(zf) -> Optional[float]:
    for path in ("Patch-Segmentation/metadata", "Patch-Classification/metadata"):
        if path in zf:
            v = zf[path].attrs.get("mpp")
            if v not in (None, ""):
                try:
                    return float(v)
                except (TypeError, ValueError):
                    pass
    return None


def morph_close_open(mask: np.ndarray, k_close: int, k_open: int) -> np.ndarray:
    m = mask.astype(np.uint8)
    if k_close and k_close > 1:
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k_close, k_close)))
    if k_open and k_open > 1:
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (k_open, k_open)))
    return m


def grid_contours(mask: np.ndarray, scale: int, origin: Sequence[int] = (0, 0),
                  include_holes: bool = False, min_points: int = 3) -> List[Dict[str, Any]]:
    """Trace a patch-grid mask; polygons in level-0 pixels (patch corner convention)."""
    cnts, hier = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    if hier is None or not len(cnts):
        return out
    for i, c in enumerate(cnts):
        pts = c.reshape(-1, 2)
        if len(pts) < min_points:
            continue
        is_hole = hier[0][i][3] != -1
        if is_hole and not include_holes:
            continue
        poly = (pts.astype(np.int64) * int(scale) + np.array(origin, dtype=np.int64)).tolist()
        out.append({"points": poly, "is_hole": bool(is_hole),
                    "area_px2": float(abs(cv2.contourArea(c)) * scale * scale)})
    return out


def masks_to_contours(zarr_path: str, classes: Dict[str, str], connect_patches: int = 3,
                      open_patches: Optional[int] = None, include_holes: bool = False,
                      slide_name: Optional[str] = None, mpp: Optional[float] = None) -> Dict[str, Any]:
    """``classes`` maps output key -> class name, e.g. {"lymphnode_contours": "Lymph node",
    "tumor_contours": "Tumor"}. Returns {slide_name, mpp, <key>: [[[x, y], ...], ...], _meta}."""
    k_open = connect_patches if open_patches is None else open_patches
    result: Dict[str, Any] = {"slide_name": slide_name or os.path.basename(zarr_path).replace(".zarr", ""),
                              "mpp": mpp}
    meta: Dict[str, Any] = {"connect_patches": connect_patches, "open_patches": k_open,
                            "include_holes": include_holes, "classes": {}}
    with open_zarr_cm(zarr_path, "r") as zf:
        if result["mpp"] is None:
            result["mpp"] = _read_mpp(zf)
        if TISSUE_SEGMENTATION_GROUP not in zf or "masks" not in zf[TISSUE_SEGMENTATION_GROUP]:
            raise ValueError(f"{zarr_path}: no {TISSUE_SEGMENTATION_GROUP}/masks (run patch_masks.ensure_patch_masks first)")
        masks = zf[TISSUE_SEGMENTATION_GROUP]["masks"]
        for key, class_name in classes.items():
            sub, grp = _mask_group_for(masks, class_name)
            if grp is None:
                result[key] = []
                meta["classes"][key] = {"class": class_name, "found": False}
                continue
            attrs = dict(grp.attrs)
            scale = int(attrs.get("scale", 1) or 1)
            origin = [int(v) for v in (attrs.get("origin") or [0, 0])]
            mask = np.asarray(grp["mask"][:]).astype(bool)
            cleaned = morph_close_open(mask, connect_patches, k_open)
            regions = grid_contours(cleaned, scale, origin, include_holes)
            result[key] = [r["points"] for r in regions]
            meta["classes"][key] = {"class": class_name, "mask": sub, "scale": scale, "origin": origin,
                                    "patches": int(mask.sum()), "patches_after_morphology": int(cleaned.sum()),
                                    "regions": len(regions)}
    result["_meta"] = meta
    return result


def _open_slide(slide_path: str):
    import tiffslide
    return tiffslide.TiffSlide(slide_path)


def _best_level(slide, span_px: float, max_side: int) -> int:
    """Highest-resolution level at which ``span_px`` level-0 pixels fit in ``max_side``."""
    level = 0
    for i, ds in enumerate(slide.level_downsamples):
        if span_px / ds <= max_side:
            return i
        level = i
    return level


def crop_regions(slide_path: str, contours: Sequence[Sequence[Sequence[float]]], out_dir: str,
                 margin: float = 0.15, max_side: int = 1024, draw: bool = True,
                 color: str = "#00ff00", thickness: int = 3) -> List[str]:
    """One PNG per polygon at <out_dir>/<i>/image.png (the reflector's crop layout)."""
    slide = _open_slide(slide_path)
    W0, H0 = slide.dimensions
    paths: List[str] = []
    try:
        for i, poly in enumerate(contours):
            pts = np.asarray(poly, dtype=np.float64).reshape(-1, 2)
            x0, y0 = pts.min(axis=0)
            x1, y1 = pts.max(axis=0)
            mw, mh = (x1 - x0) * margin, (y1 - y0) * margin
            bx0, by0 = int(max(0, x0 - mw)), int(max(0, y0 - mh))
            bx1, by1 = int(min(W0, x1 + mw + 1)), int(min(H0, y1 + mh + 1))
            span = max(bx1 - bx0, by1 - by0, 1)
            level = _best_level(slide, span, max_side)
            ds = float(slide.level_downsamples[level])
            lw, lh = max(1, int((bx1 - bx0) / ds)), max(1, int((by1 - by0) / ds))
            img = np.array(slide.read_region((bx0, by0), level, (lw, lh)).convert("RGB"))
            f = max_side / max(lw, lh)
            if f < 1:
                img = cv2.resize(img, (max(1, int(lw * f)), max(1, int(lh * f))), interpolation=cv2.INTER_AREA)
                ds = ds / f
            if draw:
                p = np.stack([(pts[:, 0] - bx0) / ds, (pts[:, 1] - by0) / ds], axis=1).astype(np.int32).reshape(-1, 1, 2)
                bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
                cv2.polylines(bgr, [p], isClosed=True, color=_hex_to_bgr(color), thickness=thickness, lineType=cv2.LINE_AA)
                img = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            d = os.path.join(out_dir, str(i))
            os.makedirs(d, exist_ok=True)
            out = os.path.join(d, "image.png")
            cv2.imwrite(out, cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
            paths.append(out)
    finally:
        slide.close()
    return paths


def overview_with_contours(slide_path: str, contours_by_class: Dict[str, Sequence[Sequence[Sequence[float]]]],
                           out_png: str, max_dim: int = 2400, colors: Optional[Dict[str, str]] = None,
                           thickness: int = 2, legend: bool = True) -> str:
    """Thumbnail of the whole slide with each class's polygons drawn; returns ``out_png``."""
    slide = _open_slide(slide_path)
    try:
        W0, H0 = slide.dimensions
        level = _best_level(slide, max(W0, H0), max_dim)
        lw, lh = slide.level_dimensions[level]
        img = np.array(slide.read_region((0, 0), level, (lw, lh)).convert("RGB"))
    finally:
        slide.close()
    f = max_dim / max(lw, lh)
    if f < 1:
        img = cv2.resize(img, (max(1, int(lw * f)), max(1, int(lh * f))), interpolation=cv2.INTER_AREA)
    th, tw = img.shape[:2]
    fx, fy = tw / W0, th / H0
    bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    colors = colors or {}
    for ci, (name, polys) in enumerate(contours_by_class.items()):
        col = _hex_to_bgr(colors.get(name, DEFAULT_COLORS[ci % len(DEFAULT_COLORS)]))
        for poly in polys:
            pts = np.asarray(poly, dtype=np.float64).reshape(-1, 2)
            p = np.stack([pts[:, 0] * fx, pts[:, 1] * fy], axis=1).astype(np.int32).reshape(-1, 1, 2)
            cv2.polylines(bgr, [p], isClosed=True, color=col, thickness=thickness, lineType=cv2.LINE_AA)
    if legend:
        y = 28
        for ci, name in enumerate(contours_by_class):
            col = _hex_to_bgr(colors.get(name, DEFAULT_COLORS[ci % len(DEFAULT_COLORS)]))
            cv2.rectangle(bgr, (10, y - 16), (30, y + 2), col, -1)
            cv2.putText(bgr, f"{name} ({len(contours_by_class[name])})", (38, y), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2, cv2.LINE_AA)
            y += 28
    os.makedirs(os.path.dirname(os.path.abspath(out_png)), exist_ok=True)
    cv2.imwrite(out_png, bgr)
    return out_png


def build_case(zarr_path: str, slide_path: Optional[str], out_dir: str, classes: Dict[str, str],
               crop_keys: Optional[Sequence[str]] = None, connect_patches: int = 3,
               case_name: Optional[str] = None, max_crop_side: int = 1024) -> Dict[str, Any]:
    """Write <out_dir>/<case>.json, overview.png and <key-without-_contours>/<i>/image.png crops."""
    case = case_name or os.path.basename(zarr_path).replace(".zarr", "")
    os.makedirs(out_dir, exist_ok=True)
    data = masks_to_contours(zarr_path, classes, connect_patches=connect_patches, slide_name=case)
    json_path = os.path.join(out_dir, f"{case}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f)
    summary: Dict[str, Any] = {"case": case, "json": json_path, "meta": data["_meta"], "crops": {}, "overview": None}
    if slide_path:
        summary["overview"] = overview_with_contours(
            slide_path, {classes[k]: data[k] for k in classes}, os.path.join(out_dir, "overview.png"))
        for key in (crop_keys or []):
            sub = key[:-len("_contours")] if key.endswith("_contours") else key
            summary["crops"][key] = crop_regions(slide_path, data[key], os.path.join(out_dir, sub), max_side=max_crop_side)
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser(description="Regions (contours JSON, crops, overview) from patch-classification masks")
    ap.add_argument("--zarr", required=True)
    ap.add_argument("--slide", default="", help="WSI path; without it only the contours JSON is written")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--classes", required=True,
                    help='key=class pairs, e.g. "lymphnode_contours=Lymph node,tumor_contours=Tumor"')
    ap.add_argument("--crop", default="", help="comma-separated keys to crop per region, e.g. lymphnode_contours")
    ap.add_argument("--connect-patches", type=int, default=3)
    ap.add_argument("--name", default="")
    a = ap.parse_args(argv)
    classes = dict(kv.split("=", 1) for kv in a.classes.split(",") if "=" in kv)
    s = build_case(a.zarr, a.slide or None, a.out_dir, classes,
                   [k for k in a.crop.split(",") if k], a.connect_patches, a.name or None)
    print(json.dumps({k: (v if k != "crops" else {kk: len(vv) for kk, vv in v.items()}) for k, v in s.items()}, indent=1))


if __name__ == "__main__":
    main()
