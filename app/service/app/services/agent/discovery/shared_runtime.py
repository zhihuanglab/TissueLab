"""
Materialize a reusable helper library and lightweight caches into /shared.

Workers only see /data, /scratch, and /shared inside the sandbox. This module
copies a small source bundle from the repo into /shared/lib and prepares cheap
run-level caches so workers do not have to rediscover the same boilerplate.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .shared_lib_source.shared_analysis.sea_ad_lfb import (
    build_slide_manifest,
    load_region_annotations,
)


RUNTIME_VERSION = 1
SOURCE_ROOT = Path(__file__).parent / "shared_lib_source"
LIB_SOURCE_ROOT = SOURCE_ROOT / "shared_analysis"
TEMPLATE_SOURCE_ROOT = SOURCE_ROOT / "templates"


def _copy_tree(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for path in source.rglob("*"):
        if path.is_dir() or path.name == "__pycache__":
            continue
        relative = path.relative_to(source)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def _render_quickstart(manifest: dict[str, Any]) -> str:
    modules = manifest.get("modules", [])
    cache_paths = manifest.get("cache_paths", {})
    template_paths = manifest.get("template_paths", {})
    capabilities = manifest.get("capabilities", {})
    mechanistic_template = template_paths.get("mechanistic_embedding") or ""
    lines = [
        "# Shared Runtime Quickstart",
        "",
        f"- Import helpers from `{manifest['python_import_root']}`. `PYTHONPATH` already includes it.",
        f"- Generic starter template: `{template_paths.get('generic', manifest.get('template_path', ''))}`",
    ]
    if mechanistic_template:
        lines.append(f"- Mechanistic embedding starter: `{mechanistic_template}`")
    lines.extend([
        "",
        "## Useful Imports",
    ])
    for module in modules:
        functions = ", ".join(module.get("functions", []))
        lines.append(f"- `{module['module']}`: {functions}")
    lines.extend(
        [
            "",
            "## Shared Caches",
            f"- `slide_manifest`: `{cache_paths.get('slide_manifest', '')}`",
            f"- `cohort_summary`: `{cache_paths.get('cohort_summary', '')}`",
        ]
    )
    if capabilities.get("custom_annotations"):
        lines.append(f"- `region_polygon_dir`: `{cache_paths.get('region_polygon_dir', '')}`")
    lines.extend(["", "## Recommended Flow"])
    for step in manifest.get("prompt_context", {}).get("recommended_flow", []):
        lines.append(f"- {step}")
    return "\n".join(lines).strip() + "\n"


def _region_cache_payload(zarr_path: Path) -> dict[str, Any]:
    annotations = load_region_annotations(zarr_path)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for annotation in annotations:
        grouped.setdefault(annotation["canonical_region"], []).append(
            {
                "annotation_id": annotation["annotation_id"],
                "raw_label": annotation["raw_label"],
                "points": annotation["points"].round(3).tolist(),
            }
        )
    return {
        "slide_name": zarr_path.name,
        "region_count": len(grouped),
        "regions": grouped,
    }


def ensure_shared_runtime(
    *,
    shared_dir: str | Path,
    data_dir: str | Path,
    dataset_guide_text: str = "",
) -> dict[str, Any]:
    shared_dir = Path(shared_dir)
    data_dir = Path(data_dir)
    lib_dir = shared_dir / "lib"
    templates_dir = shared_dir / "templates"
    cache_dir = shared_dir / "cache"
    region_dir = cache_dir / "region_polygons"
    manifest_path = cache_dir / "runtime_manifest.json"
    quickstart_path = cache_dir / "runtime_quickstart.md"
    cache_dir.mkdir(parents=True, exist_ok=True)
    region_dir.mkdir(parents=True, exist_ok=True)

    _copy_tree(LIB_SOURCE_ROOT, lib_dir / "shared_analysis")
    _copy_tree(TEMPLATE_SOURCE_ROOT, templates_dir)

    slide_manifest = build_slide_manifest(data_dir)
    cohort_summary = {
        "cohort_path": str((data_dir / "training_cohort.csv")) if (data_dir / "training_cohort.csv").exists() else None,
        "cohort_rows": slide_manifest["cohort_rows"],
        "slide_count": slide_manifest["slide_count"],
        "dataset_guide_present": bool(dataset_guide_text.strip()),
        "dataset_guide_excerpt": dataset_guide_text[:1200].strip(),
    }

    has_classification = any(bool(slide.get("has_classification_node")) for slide in slide_manifest.get("slides", []))
    has_custom_annotations = any(bool(slide.get("has_custom_annotations")) for slide in slide_manifest.get("slides", []))
    has_embeddings = any(int(slide.get("embedding_dim") or 0) > 0 for slide in slide_manifest.get("slides", []))

    region_files: list[str] = []
    for slide in slide_manifest.get("slides", []):
        zarr_path = Path(slide["zarr_path"])
        if not slide.get("has_custom_annotations"):
            continue
        cache_path = region_dir / f"{zarr_path.name}.json"
        payload = _region_cache_payload(zarr_path)
        cache_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        region_files.append(f"/shared/cache/region_polygons/{cache_path.name}")

    (cache_dir / "slide_manifest.json").write_text(json.dumps(slide_manifest, indent=2), encoding="utf-8")
    (cache_dir / "cohort_summary.json").write_text(json.dumps(cohort_summary, indent=2), encoding="utf-8")

    sea_ad_functions = [
        "load_training_cohort",
        "build_slide_manifest",
        "open_slide_zarr",
    ]
    if has_classification or has_custom_annotations:
        sea_ad_functions.extend(
            [
                "build_cell_table",
                "compute_contour_geometry",
            ]
        )
        if has_custom_annotations:
            sea_ad_functions.append("load_region_polygons")

    recommended_flow = [
        "Read /scratch/worker_brief.json and /shared/cache/runtime_quickstart.md first.",
        "Start from /shared/templates/worker_analysis_template.py unless your brief truly needs a custom layout.",
        "Import shared_analysis helpers instead of rewriting common loading, scoring, or output logic.",
    ]
    if has_classification and has_custom_annotations:
        recommended_flow.insert(
            2,
            "For niche-conditioned embedding hypotheses, start from /shared/templates/worker_embedding_mechanistic_template.py.",
        )
        recommended_flow.append(
            "You may inspect /shared/cache/region_polygons/*.json for quick orientation, but final result.py must replay from raw /data or sidecar files saved next to result.py.",
        )
    else:
        recommended_flow.append("Inspect the available data structures directly before implementing the planned candidate.")

    modules = [
        {
            "module": "shared_analysis.sea_ad_lfb",
            "functions": sea_ad_functions,
        },
        {
            "module": "shared_analysis.stats",
            "functions": [
                "partial_correlation",
                "bootstrap_partial_correlation",
                "leave_one_out_summary",
                "residualized_loo_predictive_correlation",
            ],
        },
        {
            "module": "shared_analysis.artifacts",
            "functions": [
                "coerce_results_payload",
                "build_results_payload",
                "write_donor_feature_table",
                "write_results_payload",
                "validate_results_payload",
            ],
        },
        {
            "module": "shared_analysis.context",
            "functions": [
                "load_worker_context",
                "load_runtime_manifest",
                "render_report",
            ],
        },
    ]
    if has_classification or has_custom_annotations:
        modules.append(
            {
                "module": "shared_analysis.pca",
                "functions": [
                    "fit_pca_basis",
                    "save_pca_basis",
                    "load_pca_basis",
                    "apply_pca_basis",
                ],
            }
        )
    if has_classification and has_custom_annotations:
        modules.append(
            {
                "module": "shared_analysis.embedding_mechanistic",
                "functions": [
                    "build_population_primitive",
                    "build_population_primitives_for_cohort",
                    "build_mechanistic_embedding_round",
                    "donor_scalar_from_basis",
                    "summarize_embedding_scores",
                ],
            }
        )

    manifest = {
        "runtime_version": RUNTIME_VERSION,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "shared_root": "/shared",
        "python_import_root": "/shared/lib",
        "template_path": "/shared/templates/worker_analysis_template.py",
        "template_paths": {
            "generic": "/shared/templates/worker_analysis_template.py",
            "mechanistic_embedding": "/shared/templates/worker_embedding_mechanistic_template.py" if has_classification and has_custom_annotations else "",
        },
        "cache_paths": {
            "slide_manifest": "/shared/cache/slide_manifest.json",
            "cohort_summary": "/shared/cache/cohort_summary.json",
            "region_polygon_dir": "/shared/cache/region_polygons" if has_custom_annotations else "",
        },
        "capabilities": {
            **({"classification_labels": True} if has_classification else {}),
            **({"custom_annotations": True, "region_polygons": True} if has_custom_annotations else {}),
        },
        "modules": modules,
        "prompt_context": {
            "slides_indexed": slide_manifest["slide_count"],
            "region_cache_files": len(region_files),
            "recommended_flow": recommended_flow,
        },
    }
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    quickstart_path.write_text(_render_quickstart(manifest), encoding="utf-8")
    return manifest
