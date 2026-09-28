"""Loaders for TissueLab slide .zarr stores and the cohort that indexes them.

Copied into /shared/lib for sandboxed code and also used by the service
(data-intuition brief). Nothing here knows a particular dataset: the cohort
file and its identifier / slide / mpp columns come from the problem
(/shared/dataset.json inside the sandbox, or an explicit `layout`).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import zarr
from matplotlib.path import Path as MplPath

def dataset_layout(layout: dict[str, Any] | None = None) -> dict[str, Any]:
    """The cohort layout (cohort_file, id_column, slide_column, mpp_column):
    explicit, else the run's /shared/dataset.json."""
    if layout:
        return dict(layout)
    path = Path(os.environ.get("TL_SHARED_ROOT", "/shared")) / "dataset.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _decode_scalar(value: Any) -> Any:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    if hasattr(value, "item"):
        try:
            return _decode_scalar(value.item())
        except Exception:
            return value
    return value


# ── cohort ────────────────────────────────────────────────────────────────────

def load_cohort(data_root: str | Path, layout: dict[str, Any] | None = None) -> pd.DataFrame:
    """The cohort table (inside the sandbox: identifier, slide and mpp columns only)."""
    lay = dataset_layout(layout)
    # identifiers stay text: "001" must not become 1
    return pd.read_csv(Path(data_root) / lay["cohort_file"], dtype={lay["id_column"]: str, lay["slide_column"]: str})


def donor_ids(data_root: str | Path, layout: dict[str, Any] | None = None) -> list[str]:
    lay = dataset_layout(layout)
    return load_cohort(data_root, lay)[lay["id_column"]].tolist()


def _cohort_row(data_root: str | Path, donor_id: str, lay: dict[str, Any]) -> pd.Series:
    cohort = load_cohort(data_root, lay)
    rows = cohort.loc[cohort[lay["id_column"]] == str(donor_id)]
    if rows.empty:
        raise KeyError(f"{donor_id!r} is not in {lay['cohort_file']}")
    return rows.iloc[0]


def slide_path(data_root: str | Path, donor_id: str, layout: dict[str, Any] | None = None) -> Path:
    """The .zarr store of one donor's slide."""
    lay = dataset_layout(layout)
    return Path(data_root) / str(_cohort_row(data_root, donor_id, lay)[lay["slide_column"]])


def load_slide_metadata(data_root: str | Path, donor_id: str, layout: dict[str, Any] | None = None) -> dict[str, Any]:
    """Per-slide constants, chiefly microns per pixel.

    mpp comes from the cohort's mpp column, else metadata/<donor_id>.json, else
    the zarr root attributes; `mpp_x` is None when none of them has it (then
    coordinates are pixels).
    """
    lay = dataset_layout(layout)
    row = _cohort_row(data_root, donor_id, lay)
    meta: dict[str, Any] = {}
    json_path = Path(data_root) / "metadata" / f"{donor_id}.json"
    if json_path.is_file():
        meta.update(json.loads(json_path.read_text(encoding="utf-8")))
    mpp_col = lay.get("mpp_column")
    if mpp_col and mpp_col in row.index and pd.notna(row[mpp_col]):
        meta["mpp_x"] = meta["mpp_y"] = float(row[mpp_col])
    if meta.get("mpp_x") is None:
        try:
            attrs = dict(open_slide_zarr(Path(data_root) / str(row[lay["slide_column"]])).attrs)
        except Exception:
            attrs = {}
        for key in ("mpp_x", "mpp", "microns_per_pixel"):
            if attrs.get(key) is not None:
                meta["mpp_x"] = float(attrs[key])
                meta["mpp_y"] = float(attrs.get("mpp_y", attrs[key]))
                break
    meta.setdefault("mpp_x", None)
    meta.setdefault("mpp_y", meta["mpp_x"])
    return meta


# ── zarr stores ───────────────────────────────────────────────────────────────

def open_slide_zarr(zarr_path: str | Path):
    return zarr.open(str(Path(zarr_path)), mode="r")


def load_centroids(zarr_path: str | Path) -> np.ndarray:
    return np.asarray(open_slide_zarr(zarr_path)["Cell-Segmentation"]["centroids"][:], dtype=np.float32)


def load_contours(zarr_path: str | Path) -> np.ndarray:
    return np.asarray(open_slide_zarr(zarr_path)["Cell-Segmentation"]["contours"][:], dtype=np.float32)


def load_class_names(zarr_path: str | Path) -> list[str]:
    root = open_slide_zarr(zarr_path)
    if "Cell-Classification" not in root:
        return []
    return [str(_decode_scalar(name)) for name in root["Cell-Classification"]["classes/name"][:]]


def load_class_ids(zarr_path: str | Path) -> np.ndarray:
    root = open_slide_zarr(zarr_path)
    if "Cell-Classification" not in root:
        return np.full(len(load_centroids(zarr_path)), -1, dtype=np.int32)
    return np.asarray(root["Cell-Classification"]["class_indices"][:], dtype=np.int32)


# ── region annotations ────────────────────────────────────────────────────────

def _extract_polygon_points(annotation: dict[str, Any], *, scale: float) -> np.ndarray:
    geometry = annotation.get("target", {}).get("selector", {}).get("geometry", {})
    points = geometry.get("points")
    if points is None and geometry.get("coordinates"):
        coordinates = geometry["coordinates"]
        if coordinates and coordinates[0]:
            points = coordinates[0]
    if not points:
        return np.empty((0, 2), dtype=np.float32)
    polygon = np.asarray(points, dtype=np.float32)
    if polygon.ndim != 2 or polygon.shape[1] != 2:
        return np.empty((0, 2), dtype=np.float32)
    return polygon / float(scale)


def load_region_annotations(zarr_path: str | Path, *, scale: float = 1.0) -> list[dict[str, Any]]:
    """Region polygons drawn on the slide (CustomAnnotations), labelled by their comment.

    `scale` divides the stored coordinates into cell-centroid pixels (use the
    slide metadata's annotation_coordinate_scale when the data provides one).
    """
    root = open_slide_zarr(zarr_path)
    if "CustomAnnotations" not in root:
        return []
    annotations = root["CustomAnnotations"]
    rows: list[dict[str, Any]] = []
    for key in sorted(annotations.group_keys()):
        group = annotations[key]
        raw_json = _decode_scalar(group["annotation_json"][()])
        if not raw_json:
            continue
        try:
            annotation = json.loads(raw_json)
        except json.JSONDecodeError:
            continue
        label = str(_decode_scalar(group["comment"][()]) or "").strip() or "unlabelled"
        polygon = _extract_polygon_points(annotation, scale=scale)
        if len(polygon) < 3:
            continue
        rows.append({"annotation_id": key, "region": label, "points": polygon})
    return rows


def load_region_polygons(zarr_path: str | Path, *, scale: float = 1.0) -> dict[str, list[np.ndarray]]:
    grouped: dict[str, list[np.ndarray]] = {}
    for row in load_region_annotations(zarr_path, scale=scale):
        grouped.setdefault(row["region"], []).append(row["points"])
    return grouped


def _polygon_area(polygon: np.ndarray) -> float:
    # Shoelace on centred coordinates (avoids float32 cancellation on large
    # absolute slide coordinates).
    pts = np.asarray(polygon, dtype=np.float64)
    pts = pts - pts.mean(axis=0)
    x, y = pts[:, 0], pts[:, 1]
    return float(0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))))


def assign_centroids_to_regions(
    centroids: np.ndarray,
    region_polygons: dict[str, list[np.ndarray]],
) -> np.ndarray:
    """Region label per centroid, None outside every polygon.

    A centroid inside polygons of several regions goes to the smallest
    containing polygon — deterministic, independent of annotation order.
    """
    centroids = np.asarray(centroids, dtype=np.float32)
    labels = np.full(len(centroids), "", dtype=object)
    flat = [
        (region, polygon)
        for region, polygons in region_polygons.items()
        for polygon in polygons
        if len(polygon) >= 3
    ]
    flat.sort(key=lambda item: _polygon_area(item[1]))
    for region, polygon in flat:
        inside = MplPath(polygon, closed=True).contains_points(centroids)
        labels[inside & (labels == "")] = region
    labels[labels == ""] = None
    return labels


# ── per-cell table ────────────────────────────────────────────────────────────

def compute_contour_geometry(contours: np.ndarray) -> pd.DataFrame:
    """Area, perimeter, circularity, elongation per contour (pixel units)."""
    contour_array = np.asarray(contours, dtype=np.float32)
    if contour_array.ndim != 3 or contour_array.shape[-1] != 2:
        raise ValueError("Contours must have shape (n_cells, n_vertices, 2)")
    centered = contour_array - contour_array.mean(axis=1, keepdims=True)
    x = centered[:, :, 0]
    y = centered[:, :, 1]
    x_next = np.roll(x, -1, axis=1)
    y_next = np.roll(y, -1, axis=1)
    area = 0.5 * np.abs(np.sum(x * y_next - y * x_next, axis=1))
    perimeter = np.sqrt((x_next - x) ** 2 + (y_next - y) ** 2).sum(axis=1)
    circularity = np.where(perimeter > 0, 4.0 * np.pi * area / (perimeter ** 2), np.nan)
    cov = np.einsum("nij,nik->njk", centered, centered) / np.maximum(centered.shape[1], 1)
    eigvals = np.linalg.eigvalsh(cov)
    major = np.sqrt(np.clip(eigvals[:, 1], 1e-8, None))
    minor = np.sqrt(np.clip(eigvals[:, 0], 1e-8, None))
    return pd.DataFrame(
        {
            "area": area.astype(float),
            "perimeter": perimeter.astype(float),
            "circularity": circularity.astype(float),
            "elongation": (major / minor).astype(float),
        }
    )


def build_cell_table(
    zarr_path: str | Path,
    *,
    include_regions: bool = True,
    include_geometry: bool = False,
    region_scale: float = 1.0,
) -> pd.DataFrame:
    """One row per cell: cell_index, x, y (level-0 pixels), class_id, cell_type,
    region (when the slide has region annotations), plus optional contour
    geometry (area, perimeter, circularity, elongation; pixel units)."""
    centroids = load_centroids(zarr_path)
    class_ids = load_class_ids(zarr_path)
    names = load_class_names(zarr_path)
    frame = pd.DataFrame(
        {
            "cell_index": np.arange(len(centroids)),
            "x": centroids[:, 0],
            "y": centroids[:, 1],
            "class_id": class_ids,
            "cell_type": [
                names[int(cid)] if 0 <= int(cid) < len(names) else ("unclassified" if int(cid) < 0 else f"class_{int(cid)}")
                for cid in class_ids
            ],
        }
    )
    if include_regions:
        frame["region"] = assign_centroids_to_regions(
            centroids, load_region_polygons(zarr_path, scale=region_scale)
        )
    if include_geometry:
        frame = pd.concat([frame, compute_contour_geometry(load_contours(zarr_path))], axis=1)
    return frame
