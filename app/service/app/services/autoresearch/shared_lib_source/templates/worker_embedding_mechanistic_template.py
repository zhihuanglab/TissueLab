from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from shared_analysis import (
    DEFAULT_CONFOUNDS,
    build_mechanistic_embedding_round,
    build_population_primitive,
    donor_scalar_from_basis,
    load_pca_basis,
    load_training_cohort,
    write_donor_feature_table,
    write_results_payload,
)


FEATURE_NAME = "mechanistic_embedding_biomarker"
FEATURE_COLUMN = "feature_value"
OUTCOME_COLUMN = "slope_zmem0"
CONFOUNDS = list(DEFAULT_CONFOUNDS) + ["sex"]

# Replace these constants with the planned hypothesis.
REGION = "CA1"
POPULATION_CELL_TYPES = ["Reactive Astrocyte"]
NICHE_POSITIVE_CELL_TYPES = ["Pyramidal Neuron"]
NICHE_BACKGROUND_CELL_TYPES = None
LOCAL_RADIUS = 120.0
SUMMARY_MODE = "depleted_preserved_delta"
PCA_COMPONENT = 0
PCA_COMPONENTS = 2
LOW_QUANTILE = 0.25
HIGH_QUANTILE = 0.75
TAIL_QUANTILE = 0.90
NICHE_COLUMN = "niche_fraction"
INCLUDE_GEOMETRY = False
CHUNK_SIZE = 20_000


def _paths(scratch_root: str | Path = "/scratch") -> dict[str, Path]:
    scratch = Path(scratch_root)
    return {
        "scratch": scratch,
        "basis": scratch / "embedding_basis.npz",
        "config": scratch / "embedding_config.json",
        "table": scratch / "donor_feature_table.csv",
        "results": scratch / "results.json",
    }


def _config_dict() -> dict[str, object]:
    return {
        "region": REGION,
        "population_cell_types": POPULATION_CELL_TYPES,
        "niche_positive_cell_types": NICHE_POSITIVE_CELL_TYPES,
        "niche_background_cell_types": NICHE_BACKGROUND_CELL_TYPES,
        "local_radius": LOCAL_RADIUS,
        "summary_mode": SUMMARY_MODE,
        "component": PCA_COMPONENT,
        "n_components": PCA_COMPONENTS,
        "low_quantile": LOW_QUANTILE,
        "high_quantile": HIGH_QUANTILE,
        "tail_quantile": TAIL_QUANTILE,
        "niche_column": NICHE_COLUMN,
        "include_geometry": INCLUDE_GEOMETRY,
        "chunk_size": CHUNK_SIZE,
    }


def _adjusted_metrics(partial_r: float | None, loo_predictive_r: float | None) -> tuple[float, float, float]:
    is_r = abs(float(partial_r)) if partial_r is not None and np.isfinite(partial_r) else 0.0
    loo_r = abs(float(loo_predictive_r)) if loo_predictive_r is not None and np.isfinite(loo_predictive_r) else 0.0
    gap = is_r - loo_r
    if gap > 0.30:
        return float(gap), float(gap), -1.0
    penalty = max(0.0, gap - 0.15) * 0.5
    return float(gap), float(penalty), float(loo_r - penalty)


def _selection_score(partial_r: float | None, n_analyzable: int | None, n_total: int | None) -> float:
    if partial_r is None or not np.isfinite(partial_r):
        return float("nan")
    if n_analyzable is None or n_total is None or n_total <= 0:
        return float("nan")
    coverage = max(0.0, min(1.0, float(n_analyzable) / float(n_total)))
    return float(abs(float(partial_r)) * coverage)


def _load_eval_cohort(data_root: str | Path):
    data_root = Path(data_root)
    training = data_root / "training_cohort.csv"
    test = data_root / "test_cohort.csv"
    if training.exists():
        return load_training_cohort(data_root)
    if test.exists():
        return pd.read_csv(test)
    return load_training_cohort(data_root)


def compute_donor_score(
    *,
    donor_id: str,
    data_root: str | Path,
    scratch_root: str | Path = "/scratch",
):
    paths = _paths(scratch_root)
    if not paths["basis"].exists() or not paths["config"].exists():
        return None

    config = json.loads(paths["config"].read_text(encoding="utf-8"))
    cohort = _load_eval_cohort(data_root)
    donor_rows = cohort.loc[cohort["donor_id"].astype(str) == str(donor_id)]
    if donor_rows.empty:
        return None

    slide_name = str(donor_rows.iloc[0]["slide_name"])
    primitive = build_population_primitive(
        zarr_path=Path(data_root) / slide_name,
        donor_id=str(donor_id),
        slide_name=slide_name,
        region=config["region"],
        population_cell_types=config["population_cell_types"],
        niche_positive_cell_types=config["niche_positive_cell_types"],
        niche_background_cell_types=config["niche_background_cell_types"],
        local_radius=config["local_radius"],
        include_geometry=bool(config["include_geometry"]),
        chunk_size=int(config["chunk_size"]),
    )
    basis = load_pca_basis(paths["basis"])
    value = donor_scalar_from_basis(
        primitive,
        basis,
        component=int(config["component"]),
        summary_mode=str(config["summary_mode"]),
        niche_column=str(config["niche_column"]),
        low_quantile=float(config["low_quantile"]),
        high_quantile=float(config["high_quantile"]),
        tail_quantile=float(config["tail_quantile"]),
    )
    return float(value) if value is not None and np.isfinite(value) else float("nan")


def main() -> int:
    data_root = Path("/data")
    paths = _paths("/scratch")
    paths["scratch"].mkdir(parents=True, exist_ok=True)

    donor_table, results, _basis = build_mechanistic_embedding_round(
        data_root=data_root,
        feature_name=FEATURE_NAME,
        feature_column=FEATURE_COLUMN,
        region=REGION,
        population_cell_types=POPULATION_CELL_TYPES,
        summary_mode=SUMMARY_MODE,
        outcome_col=OUTCOME_COLUMN,
        confounds=CONFOUNDS,
        niche_positive_cell_types=NICHE_POSITIVE_CELL_TYPES,
        niche_background_cell_types=NICHE_BACKGROUND_CELL_TYPES,
        local_radius=LOCAL_RADIUS,
        niche_column=NICHE_COLUMN,
        component=PCA_COMPONENT,
        n_components=PCA_COMPONENTS,
        low_quantile=LOW_QUANTILE,
        high_quantile=HIGH_QUANTILE,
        tail_quantile=TAIL_QUANTILE,
        include_geometry=INCLUDE_GEOMETRY,
        basis_path=paths["basis"],
        chunk_size=CHUNK_SIZE,
    )
    paths["config"].write_text(json.dumps(_config_dict(), indent=2) + "\n", encoding="utf-8")

    write_donor_feature_table(
        paths["table"],
        donor_table,
        feature_column=FEATURE_COLUMN,
        outcome_column=OUTCOME_COLUMN,
        covariates=CONFOUNDS,
        extra_columns=["population_cell_count"],
    )

    gap, penalty, adjusted = _adjusted_metrics(results.get("partial_r"), results.get("loo_predictive_r"))
    selection = _selection_score(results.get("partial_r"), results.get("n_analyzable"), results.get("n_total"))
    results["feature_column"] = FEATURE_COLUMN
    results["selection_score"] = selection
    results["is_loo_gap"] = gap
    results["gap_penalty"] = penalty
    results["adjusted_score"] = adjusted
    results["artifacts"] = {
        **(results.get("artifacts") or {}),
        "donor_feature_table": str(paths["table"]),
        "embedding_basis": str(paths["basis"]),
        "embedding_config": str(paths["config"]),
    }
    write_results_payload(paths["results"], results)

    print(f"HYPOTHESIS: {FEATURE_NAME}")
    print(f"  IS partial r:      {results.get('partial_r', float('nan')): .4f}")
    print(f"  Selection score:   {selection: .4f}  *** PRIMARY ***")
    print(f"  LOO predictive r:  {results.get('loo_predictive_r', float('nan')): .4f}  (diagnostic)")
    print(f"  IS-LOO Gap:        {gap: .4f}  (penalty={penalty: .4f})")
    print(f"  Adjusted Score:    {adjusted: .4f}")
    print()
    print("FEATURE-OUTCOME CORRELATIONS (IS):")
    print(f"  {FEATURE_COLUMN}: r={results.get('partial_r', float('nan')): .3f}")
    print()
    print("PER-DONOR (LOO):")
    preview = donor_table.loc[:, ["donor_id", OUTCOME_COLUMN, FEATURE_COLUMN]].copy()
    for row in preview.itertuples(index=False):
        row_dict = row._asdict()
        feature_value = float(row_dict.get(FEATURE_COLUMN, float("nan")))
        outcome_value = float(row_dict.get(OUTCOME_COLUMN, float("nan")))
        print(f"  {row_dict.get('donor_id', '')}  {outcome_value: .4f}  {feature_value: .4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
