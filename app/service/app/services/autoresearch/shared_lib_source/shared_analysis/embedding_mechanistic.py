from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from .artifacts import build_results_payload
from .pca import apply_pca_basis, fit_pca_basis, save_pca_basis
from .sea_ad_lfb import DEFAULT_CONFOUNDS, build_cell_table, load_training_cohort, open_slide_zarr
from .stats import bootstrap_partial_correlation, leave_one_out_summary


DEFAULT_CHUNK_SIZE = 20_000


@dataclass
class DonorPrimitive:
    donor_id: str
    slide_name: str
    slide_path: Path
    table: pd.DataFrame
    embeddings: np.ndarray


def _normalize_labels(values: str | Sequence[str] | None) -> list[str]:
    if values is None:
        return []
    if isinstance(values, str):
        return [values]
    return [str(value) for value in values if str(value).strip()]


def _mask_by_labels(series: pd.Series, labels: Sequence[str] | None) -> np.ndarray:
    wanted = {label.casefold() for label in _normalize_labels(labels)}
    if not wanted:
        return np.ones(len(series), dtype=bool)
    return series.fillna("").astype(str).str.casefold().isin(wanted).to_numpy(dtype=bool)


def load_embeddings_for_indices(
    zarr_path: str | Path,
    indices: Iterable[int],
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> np.ndarray:
    root = open_slide_zarr(zarr_path)
    embedding_node = root["SegmentationNode"]["embedding"]
    requested = np.asarray(list(indices), dtype=np.int64)
    if requested.size == 0:
        width = int(embedding_node.shape[1]) if len(embedding_node.shape) > 1 else 0
        return np.empty((0, width), dtype=np.float32)

    order = np.argsort(requested)
    sorted_indices = requested[order]
    chunks: list[np.ndarray] = []
    for start in range(0, len(sorted_indices), max(1, int(chunk_size))):
        take = sorted_indices[start : start + max(1, int(chunk_size))]
        chunk = np.asarray(embedding_node.oindex[take, :], dtype=np.float32)
        chunks.append(chunk)

    merged = np.vstack(chunks)
    inverse = np.empty_like(order)
    inverse[order] = np.arange(len(order))
    return merged[inverse]


def _neighbor_counts(
    focal_xy: np.ndarray,
    neighbor_xy: np.ndarray,
    *,
    radius: float,
) -> np.ndarray:
    if len(focal_xy) == 0:
        return np.zeros(0, dtype=np.int32)
    if len(neighbor_xy) == 0:
        return np.zeros(len(focal_xy), dtype=np.int32)
    tree = cKDTree(np.asarray(neighbor_xy, dtype=float))
    hits = tree.query_ball_point(np.asarray(focal_xy, dtype=float), r=float(radius))
    return np.asarray([len(match) for match in hits], dtype=np.int32)


def compute_local_positive_fraction(
    focal_xy: np.ndarray,
    positive_xy: np.ndarray,
    background_xy: np.ndarray,
    *,
    radius: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    positive_counts = _neighbor_counts(focal_xy, positive_xy, radius=radius)
    background_counts = _neighbor_counts(focal_xy, background_xy, radius=radius)
    fraction = np.full(len(positive_counts), np.nan, dtype=float)
    valid = background_counts > 0
    fraction[valid] = positive_counts[valid] / background_counts[valid]
    return fraction, positive_counts.astype(float), background_counts.astype(float)


def build_population_primitive(
    *,
    zarr_path: str | Path,
    donor_id: str,
    slide_name: str,
    region: str | None,
    population_cell_types: str | Sequence[str],
    niche_positive_cell_types: str | Sequence[str] | None = None,
    niche_background_cell_types: str | Sequence[str] | None = None,
    local_radius: float | None = None,
    include_geometry: bool = False,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> DonorPrimitive:
    slide_path = Path(zarr_path)
    cells = build_cell_table(
        slide_path,
        include_regions=bool(region),
        include_geometry=include_geometry,
    )

    region_mask = np.ones(len(cells), dtype=bool)
    if region:
        region_mask = cells["region"].fillna("").astype(str).str.upper().eq(str(region).upper()).to_numpy(dtype=bool)

    population_mask = region_mask & _mask_by_labels(cells["cell_type"], population_cell_types)
    population = cells.loc[population_mask].copy().reset_index(drop=True)
    population_embeddings = load_embeddings_for_indices(
        slide_path,
        population["cell_index"].astype(int).tolist(),
        chunk_size=chunk_size,
    )

    if local_radius is not None and niche_positive_cell_types:
        positive_mask = region_mask & _mask_by_labels(cells["cell_type"], niche_positive_cell_types)
        if niche_background_cell_types:
            background_mask = region_mask & _mask_by_labels(cells["cell_type"], niche_background_cell_types)
        else:
            background_mask = region_mask

        positive_xy = cells.loc[positive_mask, ["x", "y"]].to_numpy(dtype=float)
        background_xy = cells.loc[background_mask, ["x", "y"]].to_numpy(dtype=float)
        focal_xy = population.loc[:, ["x", "y"]].to_numpy(dtype=float)
        fraction, positive_counts, background_counts = compute_local_positive_fraction(
            focal_xy,
            positive_xy,
            background_xy,
            radius=float(local_radius),
        )
        population["niche_fraction"] = fraction
        population["niche_positive_count"] = positive_counts
        population["niche_background_count"] = background_counts
    else:
        population["niche_fraction"] = np.nan
        population["niche_positive_count"] = np.nan
        population["niche_background_count"] = np.nan

    return DonorPrimitive(
        donor_id=str(donor_id),
        slide_name=str(slide_name),
        slide_path=slide_path,
        table=population,
        embeddings=population_embeddings,
    )


def build_population_primitives_for_cohort(
    *,
    data_root: str | Path,
    region: str | None,
    population_cell_types: str | Sequence[str],
    niche_positive_cell_types: str | Sequence[str] | None = None,
    niche_background_cell_types: str | Sequence[str] | None = None,
    local_radius: float | None = None,
    include_geometry: bool = False,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> tuple[pd.DataFrame, list[DonorPrimitive]]:
    data_root = Path(data_root)
    cohort = load_training_cohort(data_root).copy()
    if "slide_name" not in cohort.columns:
        raise ValueError("training cohort is missing slide_name")
    primitives: list[DonorPrimitive] = []
    for _, row in cohort.iterrows():
        donor_id = str(row.get("donor_id") or "")
        slide_name = str(row["slide_name"])
        primitive = build_population_primitive(
            zarr_path=data_root / slide_name,
            donor_id=donor_id,
            slide_name=slide_name,
            region=region,
            population_cell_types=population_cell_types,
            niche_positive_cell_types=niche_positive_cell_types,
            niche_background_cell_types=niche_background_cell_types,
            local_radius=local_radius,
            include_geometry=include_geometry,
            chunk_size=chunk_size,
        )
        primitives.append(primitive)
    return cohort, primitives


def fit_basis_from_primitives(
    primitives: Sequence[DonorPrimitive],
    *,
    n_components: int = 2,
    random_state: int = 0,
) -> dict[str, np.ndarray] | None:
    matrices = [primitive.embeddings for primitive in primitives if primitive.embeddings.size]
    if not matrices:
        return None
    full_matrix = np.vstack(matrices)
    if len(full_matrix) < max(2, int(n_components)):
        return None
    return fit_pca_basis(full_matrix, n_components=int(n_components), random_state=random_state)


def summarize_embedding_scores(
    scores: np.ndarray,
    *,
    summary_mode: str,
    niche_values: np.ndarray | None = None,
    low_quantile: float = 0.25,
    high_quantile: float = 0.75,
    tail_quantile: float = 0.90,
) -> float:
    values = np.asarray(scores, dtype=float)
    finite = np.isfinite(values)
    if niche_values is not None:
        niche_arr = np.asarray(niche_values, dtype=float)
        finite &= np.isfinite(niche_arr)
    else:
        niche_arr = None

    values = values[finite]
    if niche_arr is not None:
        niche_arr = niche_arr[finite]
    if values.size == 0:
        return float("nan")

    mode = str(summary_mode).strip().lower()
    if mode == "mean":
        return float(np.mean(values))
    if mode == "median":
        return float(np.median(values))
    if mode == "upper_quantile":
        return float(np.quantile(values, float(tail_quantile)))
    if mode == "top_fraction":
        threshold = float(np.quantile(values, float(tail_quantile)))
        return float(np.mean(values >= threshold))

    if niche_arr is None or niche_arr.size == 0:
        return float("nan")

    if mode == "coupling":
        if values.size < 3 or np.std(values) == 0 or np.std(niche_arr) == 0:
            return float("nan")
        return float(np.corrcoef(values, niche_arr)[0, 1])

    low_cut = float(np.quantile(niche_arr, float(low_quantile)))
    high_cut = float(np.quantile(niche_arr, float(high_quantile)))
    low_mask = niche_arr <= low_cut
    high_mask = niche_arr >= high_cut

    if mode == "depleted_preserved_delta":
        if low_mask.sum() < 2 or high_mask.sum() < 2:
            return float("nan")
        return float(np.mean(values[low_mask]) - np.mean(values[high_mask]))

    if mode == "depleted_mean":
        if low_mask.sum() < 2:
            return float("nan")
        return float(np.mean(values[low_mask]))

    if mode == "preserved_mean":
        if high_mask.sum() < 2:
            return float("nan")
        return float(np.mean(values[high_mask]))

    raise ValueError(f"Unknown summary_mode: {summary_mode}")


def donor_scalar_from_basis(
    primitive: DonorPrimitive,
    basis: dict[str, np.ndarray],
    *,
    component: int = 0,
    summary_mode: str,
    niche_column: str = "niche_fraction",
    low_quantile: float = 0.25,
    high_quantile: float = 0.75,
    tail_quantile: float = 0.90,
) -> float:
    if primitive.embeddings.size == 0:
        return float("nan")
    if component >= len(np.asarray(basis["components"])):
        return float("nan")
    scores = apply_pca_basis(primitive.embeddings, basis, component=int(component))
    niche_values = None
    if niche_column in primitive.table.columns:
        niche_values = primitive.table[niche_column].to_numpy(dtype=float)
    return summarize_embedding_scores(
        scores,
        summary_mode=summary_mode,
        niche_values=niche_values,
        low_quantile=low_quantile,
        high_quantile=high_quantile,
        tail_quantile=tail_quantile,
    )


def _fold_local_predictive_r(
    *,
    cohort: pd.DataFrame,
    primitives: Sequence[DonorPrimitive],
    outcome_col: str,
    confounds: Sequence[str],
    component: int,
    summary_mode: str,
    niche_column: str,
    low_quantile: float,
    high_quantile: float,
    tail_quantile: float,
    n_components: int,
) -> float:
    indexed = {primitive.donor_id: primitive for primitive in primitives}
    confounds = list(confounds)
    preds: list[float] = []
    actuals: list[float] = []

    for held_out_donor in cohort["donor_id"].astype(str).tolist():
        train_rows = cohort.loc[cohort["donor_id"].astype(str) != held_out_donor].copy()
        test_rows = cohort.loc[cohort["donor_id"].astype(str) == held_out_donor].copy()
        train_primitives = [indexed[str(donor_id)] for donor_id in train_rows["donor_id"].astype(str).tolist()]
        basis = fit_basis_from_primitives(train_primitives, n_components=n_components)
        if basis is None or test_rows.empty:
            preds.append(float("nan"))
            actuals.append(float("nan"))
            continue

        feature_rows: list[dict[str, Any]] = []
        for donor_id in cohort["donor_id"].astype(str).tolist():
            primitive = indexed[donor_id]
            value = donor_scalar_from_basis(
                primitive,
                basis,
                component=component,
                summary_mode=summary_mode,
                niche_column=niche_column,
                low_quantile=low_quantile,
                high_quantile=high_quantile,
                tail_quantile=tail_quantile,
            )
            feature_rows.append({"donor_id": donor_id, "feature_value": value})

        feature_table = pd.DataFrame(feature_rows)
        train = train_rows.merge(feature_table, on="donor_id", how="left").replace([np.inf, -np.inf], np.nan).dropna(
            subset=["feature_value", outcome_col, *confounds]
        )
        test = test_rows.merge(feature_table, on="donor_id", how="left").replace([np.inf, -np.inf], np.nan).dropna(
            subset=["feature_value", outcome_col, *confounds]
        )
        if train.empty or test.empty or len(train) < 3:
            preds.append(float("nan"))
            actuals.append(float("nan"))
            continue

        x_train = np.hstack([np.ones((len(train), 1), dtype=float), train.loc[:, confounds].to_numpy(dtype=float)])
        x_test = np.hstack([np.ones((len(test), 1), dtype=float), test.loc[:, confounds].to_numpy(dtype=float)])
        feature_train = train["feature_value"].to_numpy(dtype=float)
        outcome_train = train[outcome_col].to_numpy(dtype=float)

        beta_feature, *_ = np.linalg.lstsq(x_train, feature_train, rcond=None)
        beta_outcome, *_ = np.linalg.lstsq(x_train, outcome_train, rcond=None)
        resid_feature_train = feature_train - x_train @ beta_feature
        resid_outcome_train = outcome_train - x_train @ beta_outcome
        denom = float(np.dot(resid_feature_train, resid_feature_train))
        if denom <= 0:
            preds.append(float("nan"))
            actuals.append(float("nan"))
            continue
        slope = float(np.dot(resid_feature_train, resid_outcome_train) / denom)

        resid_feature_test = test["feature_value"].to_numpy(dtype=float) - x_test @ beta_feature
        resid_outcome_test = test[outcome_col].to_numpy(dtype=float) - x_test @ beta_outcome
        preds.append(float(slope * resid_feature_test[0]))
        actuals.append(float(resid_outcome_test[0]))

    pred_arr = np.asarray(preds, dtype=float)
    act_arr = np.asarray(actuals, dtype=float)
    mask = np.isfinite(pred_arr) & np.isfinite(act_arr)
    if mask.sum() < 3 or np.std(pred_arr[mask]) == 0 or np.std(act_arr[mask]) == 0:
        return float("nan")
    return float(np.corrcoef(pred_arr[mask], act_arr[mask])[0, 1])


def build_mechanistic_embedding_round(
    *,
    data_root: str | Path,
    feature_name: str,
    feature_column: str,
    region: str | None,
    population_cell_types: str | Sequence[str],
    summary_mode: str,
    outcome_col: str,
    confounds: Sequence[str] = DEFAULT_CONFOUNDS,
    niche_positive_cell_types: str | Sequence[str] | None = None,
    niche_background_cell_types: str | Sequence[str] | None = None,
    local_radius: float | None = None,
    niche_column: str = "niche_fraction",
    component: int = 0,
    n_components: int = 2,
    low_quantile: float = 0.25,
    high_quantile: float = 0.75,
    tail_quantile: float = 0.90,
    include_geometry: bool = False,
    basis_path: str | Path | None = None,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> tuple[pd.DataFrame, dict[str, Any], dict[str, np.ndarray] | None]:
    cohort, primitives = build_population_primitives_for_cohort(
        data_root=data_root,
        region=region,
        population_cell_types=population_cell_types,
        niche_positive_cell_types=niche_positive_cell_types,
        niche_background_cell_types=niche_background_cell_types,
        local_radius=local_radius,
        include_geometry=include_geometry,
        chunk_size=chunk_size,
    )
    cohort["donor_id"] = cohort["donor_id"].astype(str)
    basis = fit_basis_from_primitives(primitives, n_components=n_components)
    feature_rows: list[dict[str, Any]] = []

    for primitive in primitives:
        value = (
            donor_scalar_from_basis(
                primitive,
                basis,
                component=component,
                summary_mode=summary_mode,
                niche_column=niche_column,
                low_quantile=low_quantile,
                high_quantile=high_quantile,
                tail_quantile=tail_quantile,
            )
            if basis is not None
            else float("nan")
        )
        feature_rows.append(
            {
                "donor_id": primitive.donor_id,
                "slide_name": primitive.slide_name,
                feature_column: value,
                "population_cell_count": int(len(primitive.table)),
            }
        )

    donor_table = cohort.merge(pd.DataFrame(feature_rows), on=["donor_id", "slide_name"], how="left")
    if basis is not None and basis_path is not None:
        save_pca_basis(basis_path, basis)

    analysis_frame = donor_table.loc[:, ["donor_id", "slide_name", feature_column, outcome_col, *confounds]].replace(
        [np.inf, -np.inf], np.nan
    ).dropna()

    stats = bootstrap_partial_correlation(
        analysis_frame,
        feature_col=feature_column,
        outcome_col=outcome_col,
        confounds=list(confounds),
        n_boot=2000,
        random_state=0,
    ) if not analysis_frame.empty else {"partial_r": float("nan"), "ci_lo": float("nan"), "ci_hi": float("nan"), "p_value": float("nan"), "n": 0.0}

    loo = leave_one_out_summary(
        analysis_frame,
        feature_col=feature_column,
        outcome_col=outcome_col,
        confounds=list(confounds),
        id_col="donor_id",
    ) if not analysis_frame.empty else {"unstable_count": 0, "max_shift": float("nan")}

    loo_predictive_r = _fold_local_predictive_r(
        cohort=cohort,
        primitives=primitives,
        outcome_col=outcome_col,
        confounds=list(confounds),
        component=component,
        summary_mode=summary_mode,
        niche_column=niche_column,
        low_quantile=low_quantile,
        high_quantile=high_quantile,
        tail_quantile=tail_quantile,
        n_components=n_components,
    ) if len(analysis_frame) >= 3 else float("nan")

    results = build_results_payload(
        status="ok",
        feature_name=feature_name,
        outcome=outcome_col,
        n_total=int(len(donor_table)),
        n_analyzable=int(len(analysis_frame)),
        partial_r=float(stats.get("partial_r", float("nan"))),
        ci_lo=float(stats.get("ci_lo", float("nan"))),
        ci_hi=float(stats.get("ci_hi", float("nan"))),
        p_value=float(stats.get("p_value", float("nan"))),
        loo_predictive_r=float(loo_predictive_r),
        loo_unstable_count=int(loo.get("unstable_count", 0)),
        loo_max_shift=float(loo.get("max_shift")) if loo.get("max_shift") is not None else None,
        donor_ids_used=analysis_frame["donor_id"].astype(str).tolist(),
        covariates=list(confounds),
        recomputed_from_raw=True,
        registry_written=False,
        artifacts={},
        feature_column=feature_column,
        summary_mode=summary_mode,
        region=region,
        population_cell_types=_normalize_labels(population_cell_types),
        niche_positive_cell_types=_normalize_labels(niche_positive_cell_types),
        niche_background_cell_types=_normalize_labels(niche_background_cell_types),
        local_radius=local_radius,
        component=int(component),
    )
    return donor_table, results, basis
