"""Outcome-blind "data intuition" brief for the proposer.

Computed from the slides alone (cells, classes, region polygons, mpp) — never
from outcomes or covariates. It tells the proposer how the data are physically
organised: which cell classes and regions exist, how many cells each region
holds per donor, region areas and densities, class composition, and typical
nearest-neighbour spacings, so spatial parameters and support rules can be
calibrated before a hypothesis is proposed. Class and region names are read
from the slides, not assumed.

Output: <shared>/data_intuition.md (read by the proposer and worker).
"""
from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np
from scipy.spatial import cKDTree

from .problem import ProblemSpec
from .shared_lib_source.shared_analysis.slides import (
    build_cell_table,
    load_cohort,
    load_region_polygons,
    load_slide_metadata,
)

MAX_POINTS = 30000
MAX_TABLE_CLASSES = 12


def _region_area(polygons: list[np.ndarray], scale_xy: np.ndarray) -> float | None:
    """Summed area of a region's polygons, in scaled units^2 (overlaps count twice)."""
    polys = [np.asarray(p, dtype=np.float64) for p in polygons if len(p) >= 3]
    if not polys:
        return None
    total = 0.0
    for p in polys:
        q = (p - p.mean(axis=0)) * scale_xy
        x, y = q[:, 0], q[:, 1]
        total += 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))
    return total


def _nn_stats(points: np.ndarray) -> dict[str, float] | None:
    """Median/p10/p90 of same-class nearest-neighbour distances."""
    if len(points) < 5:
        return None
    if len(points) > MAX_POINTS:
        points = points[np.random.default_rng(0).choice(len(points), MAX_POINTS, replace=False)]
    dist, _ = cKDTree(points).query(points, k=2)
    d = dist[:, 1]
    return {"median": float(np.median(d)), "p10": float(np.percentile(d, 10)), "p90": float(np.percentile(d, 90))}


def donor_summary(data_dir: Path, layout: dict[str, Any], donor_id: str, zarr_path: Path) -> dict[str, Any]:
    meta = load_slide_metadata(data_dir, donor_id, layout)
    mpp_x = meta.get("mpp_x")
    mpp_y = meta.get("mpp_y") or mpp_x
    scale_xy = np.array([mpp_x, mpp_y]) if mpp_x else np.array([1.0, 1.0])
    region_scale = float(meta.get("annotation_coordinate_scale") or 1.0)
    cells = build_cell_table(zarr_path, region_scale=region_scale)
    xy = cells[["x", "y"]].to_numpy(dtype=np.float64) * scale_xy
    polygons = load_region_polygons(zarr_path, scale=region_scale)
    out: dict[str, Any] = {"donor_id": donor_id, "n_cells": int(len(cells)), "mpp_x": mpp_x, "regions": {}}
    region_series = cells["region"].astype(object)
    classes = sorted(cells["cell_type"].astype(str).unique().tolist())
    for region in ["whole_slide", *sorted(polygons)]:
        mask = np.ones(len(cells), dtype=bool) if region == "whole_slide" else (region_series == region).to_numpy()
        n = int(mask.sum())
        if region != "whole_slide" and n == 0:
            continue
        area = None if region == "whole_slide" else _region_area(polygons.get(region, []), scale_xy)
        counts = cells.loc[mask, "cell_type"].astype(str).value_counts()
        entry: dict[str, Any] = {
            "n_cells": n,
            "area": area,
            "density": (n / area) if area else None,
            "class_counts": {c: int(counts.get(c, 0)) for c in classes},
            "class_fractions": {c: (float(counts.get(c, 0)) / n if n else None) for c in classes},
            "nn_same_class": {},
        }
        for c in classes:
            s = _nn_stats(xy[mask & (cells["cell_type"].astype(str) == c).to_numpy()])
            if s:
                entry["nn_same_class"][c] = s
        out["regions"][region] = entry
    return out


def _agg(values: list[float | None]) -> dict[str, float] | None:
    v = [float(x) for x in values if x is not None and math.isfinite(float(x))]
    if not v:
        return None
    return {"median": float(np.median(v)), "min": float(min(v)), "max": float(max(v)), "n": len(v)}


def _fmt_range(stat: dict[str, float] | None, digits: int = 1, scale: float = 1.0) -> str:
    if not stat:
        return "–"
    return f"{stat['median']*scale:.{digits}f} [{stat['min']*scale:.{digits}f}–{stat['max']*scale:.{digits}f}]"


def render_markdown(donors: list[dict[str, Any]]) -> str:
    n_d = len(donors)
    microns = all(d.get("mpp_x") for d in donors)
    unit = "µm" if microns else "px"
    area_unit, area_scale = ("mm^2", 1e-6) if microns else ("px^2", 1.0)
    regions = sorted({r for d in donors for r in d["regions"] if r != "whole_slide"})
    class_totals: dict[str, int] = {}
    for d in donors:
        for c, k in d["regions"]["whole_slide"]["class_counts"].items():
            class_totals[c] = class_totals.get(c, 0) + k
    classes = [c for c, _ in sorted(class_totals.items(), key=lambda kv: -kv[1])][:MAX_TABLE_CLASSES]
    all_regions = ["whole_slide", *regions]

    lines = [
        f"# Data intuition brief (outcome-blind, computed from the {n_d} slides)",
        "",
        f"Values are median [min–max] across donors. Distances in {unit}, areas in {area_unit}, "
        f"densities in cells per {area_unit}."
        + ("" if microns else " (microns-per-pixel is unknown for at least one slide, so everything is in pixels.)"),
        f"Donors: {n_d}. Cells per donor: {_fmt_range(_agg([d['n_cells'] for d in donors]), 0)}.",
        f"Cell classes (by total count): {', '.join(classes) or 'none (no classification in these slides)'}.",
        f"Regions: {', '.join(regions) or 'none (no region annotations in these slides)'}.",
        "",
        "## Region availability, size and density",
        f"| region | donors with region | cells in region | area {area_unit} | density /{area_unit} |",
        "|---|---|---|---|---|",
    ]
    for region in all_regions:
        present = [d["regions"][region] for d in donors if region in d["regions"]]
        density_scale = 1.0 / area_scale
        lines.append(
            f"| {region} | {len(present)}/{n_d} | {_fmt_range(_agg([e['n_cells'] for e in present]), 0)} | "
            f"{_fmt_range(_agg([e['area'] for e in present]), 2, area_scale)} | "
            f"{_fmt_range(_agg([e['density'] for e in present]), 0, density_scale)} |"
        )
    if classes:
        lines += ["", "## Class composition per region (median fraction of cells, %)",
                  "| region | " + " | ".join(classes) + " |", "|---|" + "---|" * len(classes)]
        for region in all_regions:
            present = [d["regions"][region] for d in donors if region in d["regions"]]
            if not present:
                continue
            row = []
            for c in classes:
                a = _agg([e["class_fractions"].get(c) for e in present])
                row.append(f"{a['median']*100:.1f}" if a else "–")
            lines.append(f"| {region} | " + " | ".join(row) + " |")
        lines += ["", "## Typical cell counts per region per donor (median [min–max]) — use for support floors",
                  "| region | " + " | ".join(classes) + " |", "|---|" + "---|" * len(classes)]
        for region in regions:
            present = [d["regions"][region] for d in donors if region in d["regions"]]
            if present:
                lines.append(f"| {region} | " + " | ".join(
                    _fmt_range(_agg([e["class_counts"].get(c) for e in present]), 0) for c in classes) + " |")
        lines += ["", f"## Nearest-neighbour spacing within a class (median distance to the nearest same-class cell, {unit}; median across donors)",
                  "| region | " + " | ".join(classes) + " |", "|---|" + "---|" * len(classes)]
        for region in all_regions:
            present = [d["regions"][region] for d in donors if region in d["regions"]]
            if not present:
                continue
            row = []
            for c in classes:
                a = _agg([e["nn_same_class"].get(c, {}).get("median") for e in present])
                row.append(f"{a['median']:.0f}" if a else "–")
            lines.append(f"| {region} | " + " | ".join(row) + " |")
    lines += ["", "## Converting densities to neighbour counts",
              "For any class and radius r you choose: expected number of cells of that class within r of a point "
              "≈ (class count in region / region area) × π r². Use the per-region counts and areas above."]
    if regions:
        lines += ["", "## Per-donor region presence (cells in region)",
                  "| donor | " + " | ".join(regions) + " |", "|---|" + "---|" * len(regions)]
        for d in donors:
            lines.append(f"| {d['donor_id']} | " + " | ".join(
                str(d["regions"][r]["n_cells"]) if r in d["regions"] else "–" for r in regions) + " |")
        lines += ["", "Region = region-annotation label; a cell inside several polygons goes to the smallest one."]
    return "\n".join(lines) + "\n"


def build_data_intuition(spec: ProblemSpec, data_dir: str | Path, shared_dir: str | Path) -> dict[str, Any]:
    data_dir = Path(data_dir)
    shared_dir = Path(shared_dir)
    shared_dir.mkdir(parents=True, exist_ok=True)
    layout = spec.dataset_layout()
    cohort = load_cohort(data_dir, layout)
    summaries: list[dict[str, Any]] = []
    for _, row in cohort.iterrows():
        zarr_path = data_dir / str(row[spec.slide_column])
        if not zarr_path.exists():
            continue
        summaries.append(donor_summary(data_dir, layout, str(row[spec.id_column]), zarr_path))
    md = render_markdown(summaries) if summaries else "# Data intuition brief\n\nNo readable slides were found.\n"
    (shared_dir / "data_intuition.md").write_text(md, encoding="utf-8")
    return {"n_donors": len(summaries)}
