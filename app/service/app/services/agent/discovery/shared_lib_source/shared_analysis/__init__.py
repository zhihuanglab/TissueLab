"""Reusable helper library copied into /shared/lib for worker scripts.

Exports resolve lazily (PEP 562): the service process imports only the
submodules it uses (artifacts, stats, sea_ad_lfb), so the sandbox-only
dependencies of pca (scikit-learn) and embedding_mechanistic never load there.
Worker scripts keep writing ``from shared_analysis import X``.
"""

from __future__ import annotations

import importlib

_EXPORTS = {
    "build_results_payload": "artifacts",
    "coerce_results_payload": "artifacts",
    "normalize_covariate_names": "artifacts",
    "resolve_covariate_names": "artifacts",
    "validate_donor_feature_table_columns": "artifacts",
    "validate_feature_spec": "artifacts",
    "validate_results_payload": "artifacts",
    "write_donor_feature_table": "artifacts",
    "write_feature_spec": "artifacts",
    "write_results_payload": "artifacts",
    "load_runtime_manifest": "context",
    "load_worker_context": "context",
    "render_report": "context",
    "DonorPrimitive": "embedding_mechanistic",
    "build_mechanistic_embedding_round": "embedding_mechanistic",
    "build_population_primitive": "embedding_mechanistic",
    "build_population_primitives_for_cohort": "embedding_mechanistic",
    "compute_local_positive_fraction": "embedding_mechanistic",
    "donor_scalar_from_basis": "embedding_mechanistic",
    "fit_basis_from_primitives": "embedding_mechanistic",
    "load_embeddings_for_indices": "embedding_mechanistic",
    "summarize_embedding_scores": "embedding_mechanistic",
    "apply_pca_basis": "pca",
    "fit_pca_basis": "pca",
    "load_pca_basis": "pca",
    "save_pca_basis": "pca",
    "DEFAULT_CONFOUNDS": "sea_ad_lfb",
    "KNOWN_REGIONS": "sea_ad_lfb",
    "assign_centroids_to_regions": "sea_ad_lfb",
    "build_cell_table": "sea_ad_lfb",
    "build_slide_manifest": "sea_ad_lfb",
    "canonicalize_region_label": "sea_ad_lfb",
    "compute_contour_geometry": "sea_ad_lfb",
    "find_training_cohort": "sea_ad_lfb",
    "has_zarr_group": "sea_ad_lfb",
    "list_slide_paths": "sea_ad_lfb",
    "load_centroids": "sea_ad_lfb",
    "load_class_ids": "sea_ad_lfb",
    "load_class_lookup": "sea_ad_lfb",
    "load_class_names": "sea_ad_lfb",
    "load_contours": "sea_ad_lfb",
    "load_embeddings": "sea_ad_lfb",
    "load_region_annotations": "sea_ad_lfb",
    "load_region_polygons": "sea_ad_lfb",
    "load_training_cohort": "sea_ad_lfb",
    "open_slide_zarr": "sea_ad_lfb",
    "slide_id_from_name": "sea_ad_lfb",
    "bootstrap_partial_correlation": "stats",
    "leave_one_out_partial_correlation": "stats",
    "residualized_loo_predictive_correlation": "stats",
    "leave_one_out_summary": "stats",
    "partial_correlation": "stats",
    "residualize": "stats",
}

__all__ = sorted(_EXPORTS)


def __getattr__(name: str):
    module = _EXPORTS.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(f".{module}", __name__), name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(_EXPORTS))
