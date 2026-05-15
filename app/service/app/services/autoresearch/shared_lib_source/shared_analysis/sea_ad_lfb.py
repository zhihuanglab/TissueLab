from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import zarr
from matplotlib.path import Path as MplPath


KNOWN_REGIONS = ("CA1", "CA2", "CA3", "CA4", "DG", "EC", "SB", "TEC")
DEFAULT_CONFOUNDS = ["max_age_vis", "braak_numeric", "cerad_ordinal"]


def _is_ignored_name(name: str) -> bool:
    return name.startswith("._") or name.startswith(".DS_Store")


def _decode_scalar(value: Any) -> Any:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    if hasattr(value, "item"):
        try:
            return _decode_scalar(value.item())
        except Exception:
            return value
    return value


def slide_id_from_name(name: str) -> str:
    base = Path(name).name
    for suffix in (".svs.zarr", ".svs"):
        if base.endswith(suffix):
            return base[: -len(suffix)]
    return base


def canonicalize_region_label(label: str | None) -> str:
    token = (label or "").strip().upper()
    for region in sorted(KNOWN_REGIONS, key=len, reverse=True):
        if token.startswith(region):
            return region
    return token or "UNKNOWN"


def find_training_cohort(data_root: str | Path) -> Path:
    data_root = Path(data_root)
    direct = data_root / "training_cohort.csv"
    if direct.exists():
        return direct
    matches = sorted(
        path
        for path in data_root.glob("*.csv")
        if not _is_ignored_name(path.name) and "training_cohort" in path.name
    )
    if matches:
        return matches[0]
    raise FileNotFoundError(f"Could not locate training_cohort.csv under {data_root}")


def list_slide_paths(data_root: str | Path) -> list[Path]:
    data_root = Path(data_root)
    return sorted(
        path
        for path in data_root.glob("*.svs.zarr")
        if not _is_ignored_name(path.name)
    )


def load_training_cohort(data_root: str | Path) -> pd.DataFrame:
    cohort_path = find_training_cohort(data_root)
    cohort = pd.read_csv(cohort_path)
    if "slide_id" not in cohort.columns and "slide_name" in cohort.columns:
        cohort["slide_id"] = cohort["slide_name"].map(slide_id_from_name)
    if "slide_id" not in cohort.columns and "slide_path" in cohort.columns:
        cohort["slide_id"] = cohort["slide_path"].map(slide_id_from_name)
    return cohort


def open_slide_zarr(zarr_path: str | Path):
    return zarr.open(str(Path(zarr_path)), mode="r")


def has_zarr_group(zarr_path: str | Path, group_name: str) -> bool:
    root = open_slide_zarr(zarr_path)
    return str(group_name) in root


def load_centroids(zarr_path: str | Path) -> np.ndarray:
    root = open_slide_zarr(zarr_path)
    return np.asarray(root["SegmentationNode"]["centroids"][:], dtype=np.float32)


def load_contours(zarr_path: str | Path) -> np.ndarray:
    root = open_slide_zarr(zarr_path)
    return np.asarray(root["SegmentationNode"]["contours"][:], dtype=np.float32)


def load_embeddings(zarr_path: str | Path) -> np.ndarray:
    root = open_slide_zarr(zarr_path)
    return np.asarray(root["SegmentationNode"]["embedding"][:], dtype=np.float32)


def load_class_names(zarr_path: str | Path) -> list[str]:
    root = open_slide_zarr(zarr_path)
    if "ClassificationNode" not in root:
        return []
    names = root["ClassificationNode"]["nuclei_class_name"][:]
    return [str(_decode_scalar(name)) for name in names]


def load_class_lookup(zarr_path: str | Path) -> dict[int, str]:
    names = load_class_names(zarr_path)
    if not names:
        return {-1: "segmented_object"}
    return {idx: name for idx, name in enumerate(names)}


def load_class_ids(zarr_path: str | Path) -> np.ndarray:
    root = open_slide_zarr(zarr_path)
    if "ClassificationNode" not in root:
        return np.full(len(load_centroids(zarr_path)), -1, dtype=np.int32)
    return np.asarray(root["ClassificationNode"]["nuclei_class_id"][:], dtype=np.int32)


def _extract_polygon_points(annotation: dict[str, Any], *, scale: float) -> np.ndarray:
    geometry = (
        annotation.get("target", {})
        .get("selector", {})
        .get("geometry", {})
    )
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


def load_region_annotations(zarr_path: str | Path, *, scale: float = 16.0) -> list[dict[str, Any]]:
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
        raw_label = str(_decode_scalar(group["comment"][()]) or "").strip()
        polygon = _extract_polygon_points(annotation, scale=scale)
        if len(polygon) < 3:
            continue
        rows.append(
            {
                "annotation_id": key,
                "raw_label": raw_label,
                "canonical_region": canonicalize_region_label(raw_label),
                "points": polygon,
            }
        )
    return rows


def load_region_polygons(zarr_path: str | Path, *, scale: float = 16.0) -> dict[str, list[np.ndarray]]:
    grouped: dict[str, list[np.ndarray]] = {}
    for row in load_region_annotations(zarr_path, scale=scale):
        grouped.setdefault(row["canonical_region"], []).append(row["points"])
    return grouped


def assign_centroids_to_regions(
    centroids: np.ndarray,
    region_polygons: dict[str, list[np.ndarray]],
) -> np.ndarray:
    centroids = np.asarray(centroids, dtype=np.float32)
    labels = np.full(len(centroids), "", dtype=object)
    for region, polygons in region_polygons.items():
        region_mask = np.zeros(len(centroids), dtype=bool)
        for polygon in polygons:
            if len(polygon) < 3:
                continue
            region_mask |= MplPath(polygon, closed=True).contains_points(centroids)
        assignable = region_mask & (labels == "")
        labels[assignable] = region
    labels[labels == ""] = None
    return labels


def compute_contour_geometry(contours: np.ndarray) -> pd.DataFrame:
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
    elongation = major / minor
    return pd.DataFrame(
        {
            "area": area.astype(float),
            "perimeter": perimeter.astype(float),
            "circularity": circularity.astype(float),
            "elongation": elongation.astype(float),
        }
    )


def build_cell_table(
    zarr_path: str | Path,
    *,
    include_regions: bool = True,
    include_geometry: bool = False,
    scale: float = 16.0,
) -> pd.DataFrame:
    centroids = load_centroids(zarr_path)
    class_ids = load_class_ids(zarr_path)
    class_lookup = load_class_lookup(zarr_path)
    frame = pd.DataFrame(
        {
            "cell_index": np.arange(len(centroids)),
            "x": centroids[:, 0],
            "y": centroids[:, 1],
            "class_id": class_ids,
            "cell_type": [class_lookup.get(int(cid), f"class_{int(cid)}") for cid in class_ids],
        }
    )
    if include_regions:
        polygons = load_region_polygons(zarr_path, scale=scale)
        frame["region"] = assign_centroids_to_regions(centroids, polygons)
    if include_geometry:
        geometry = compute_contour_geometry(load_contours(zarr_path))
        frame = pd.concat([frame, geometry], axis=1)
    return frame


def build_slide_manifest(data_root: str | Path) -> dict[str, Any]:
    data_root = Path(data_root)
    cohort = load_training_cohort(data_root)
    slide_paths = list_slide_paths(data_root)
    slides: list[dict[str, Any]] = []
    for zarr_path in slide_paths:
        slide_name = zarr_path.name
        slide_id = slide_id_from_name(slide_name)
        svs_path = zarr_path.with_suffix("")
        row_matches = cohort.loc[cohort.get("slide_name", pd.Series(dtype=str)) == slide_name]
        if row_matches.empty and "slide_id" in cohort.columns:
            row_matches = cohort.loc[cohort["slide_id"] == slide_id]
        root = open_slide_zarr(zarr_path)
        seg = root["SegmentationNode"]
        has_classification = "ClassificationNode" in root
        has_custom_annotations = "CustomAnnotations" in root
        slide_info = {
            "slide_name": slide_name,
            "slide_id": slide_id,
            "zarr_path": str(zarr_path),
            "svs_path": str(svs_path) if svs_path.exists() else None,
            "n_cells": int(seg["centroids"].shape[0]),
            "embedding_dim": int(seg["embedding"].shape[1]),
            "cohort_match_count": int(len(row_matches)),
            "donor_id": row_matches.iloc[0]["donor_id"] if len(row_matches) else None,
        }
        if has_classification:
            slide_info["has_classification_node"] = True
            slide_info["class_labels"] = load_class_names(zarr_path)
        if has_custom_annotations:
            slide_info["has_custom_annotations"] = True
        slides.append(slide_info)
    return {
        "data_root": str(data_root),
        "slide_count": len(slides),
        "cohort_rows": int(len(cohort)),
        "slides": slides,
    }
