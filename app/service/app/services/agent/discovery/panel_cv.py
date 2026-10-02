"""Leakage-safe predictive scoring for small-cohort biomarker panels.

Compares a frozen current panel with one proposed panel using paired, repeated
nested cross-validated ridge predictions on the discovery cohort.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np
import pandas as pd
from scipy.stats import rankdata
from sklearn.linear_model import Ridge
from sklearn.model_selection import KFold


@dataclass(frozen=True)
class PredictivePanelConfig:
    outer_folds: int = 5
    # 5 x 5-fold: enough repeats to tell a steady gain from fold luck at a quarter of the fits.
    outer_repeats: int = 5
    inner_folds: int = 4
    seed: int = 20260821
    ridge_alphas: tuple[float, ...] = (
        1e-4,
        4.641588833612782e-4,
        2.154434690031882e-3,
        1e-2,
        4.641588833612777e-2,
        2.154434690031882e-1,
        1.0,
        4.641588833612772,
        21.54434690031882,
        100.0,
        464.1588833612772,
        2154.4346900318824,
        10000.0,
    )
    # The RMSE thresholds below are in units of the outcome's standard deviation,
    # so the gates mean the same whatever scale the outcome is recorded in.
    # A meaningful gain: mean RMSE lower by at least 1% of the outcome's SD.
    min_mean_rmse_improvement: float = 0.01
    # Better in at least this share of the repeats, as a whole count (rounded up):
    # with 5 repeats, 0.8 = at least 4 of 5.
    min_fraction_repeats_better_rmse: float = 0.8
    min_consensus_rmse_improvement: float = 0.0
    min_consensus_pearson_delta: float = -0.02
    min_worst_leave_one_donor_rmse_improvement: float = -1e-3
    min_candidate_coverage: float = 0.80
    max_panel_size: int = 5


def min_repeats_better(config: PredictivePanelConfig) -> int:
    """How many of the outer repeats the candidate must beat the baseline in."""
    return math.ceil(round(config.min_fraction_repeats_better_rmse * config.outer_repeats, 9))


def _sex_values(series: pd.Series) -> np.ndarray:
    numeric = pd.to_numeric(series, errors="coerce")
    if numeric.notna().all():
        return numeric.astype(float).to_numpy()
    normalized = series.astype(str).str.strip().str.lower()
    mapped = normalized.map(
        {
            "male": 1.0,
            "m": 1.0,
            "female": 0.0,
            "f": 0.0,
        }
    )
    if mapped.isna().any():
        unknown = sorted(normalized.loc[mapped.isna()].unique().tolist())
        raise ValueError(f"Unsupported sex values: {unknown}")
    return mapped.astype(float).to_numpy()


def covariate_matrix(frame: pd.DataFrame, covariates: list[str]) -> np.ndarray:
    columns: list[np.ndarray] = [np.ones(len(frame), dtype=float)]
    for name in covariates:
        if name not in frame.columns:
            raise ValueError(f"Missing covariate column: {name}")
        if name.lower() in {"sex", "gender"}:
            columns.append(_sex_values(frame[name]))
            continue
        values = pd.to_numeric(frame[name], errors="coerce")
        if values.isna().any():
            raise ValueError(f"Covariate contains missing or non-numeric values: {name}")
        columns.append(values.astype(float).to_numpy())
    return np.column_stack(columns)


def _transform_features(
    train: np.ndarray,
    validation: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, int]:
    if train.shape[1] == 0:
        return train.copy(), validation.copy(), 0
    medians = np.nanmedian(train, axis=0)
    medians = np.where(np.isnan(medians), 0.0, medians)
    train_imputed = np.where(np.isnan(train), medians, train)
    validation_imputed = np.where(np.isnan(validation), medians, validation)

    standard_deviation = train_imputed.std(axis=0, ddof=0)
    keep = np.isfinite(standard_deviation) & (standard_deviation > 1e-12)
    if not keep.any():
        return np.empty((len(train), 0)), np.empty((len(validation), 0)), 0

    train_kept = train_imputed[:, keep]
    validation_kept = validation_imputed[:, keep]
    means = train_kept.mean(axis=0)
    standard_deviation = train_kept.std(axis=0, ddof=0)
    return (
        (train_kept - means) / standard_deviation,
        (validation_kept - means) / standard_deviation,
        int(keep.sum()),
    )


def _prepare_incremental_problem(
    features_train: np.ndarray,
    features_validation: np.ndarray,
    covariates_train: np.ndarray,
    covariates_validation: np.ndarray,
    outcome_train: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, int]:
    covariate_coefficients = np.linalg.lstsq(
        covariates_train, outcome_train, rcond=None
    )[0]
    covariate_train_prediction = covariates_train @ covariate_coefficients
    covariate_validation_prediction = covariates_validation @ covariate_coefficients
    outcome_residual = outcome_train - covariate_train_prediction

    transformed_train, transformed_validation, retained = _transform_features(
        features_train, features_validation
    )
    if retained == 0:
        return (
            transformed_train,
            transformed_validation,
            outcome_residual,
            covariate_validation_prediction,
            retained,
        )

    feature_covariate_coefficients = np.linalg.lstsq(
        covariates_train, transformed_train, rcond=None
    )[0]
    residual_train = (
        transformed_train - covariates_train @ feature_covariate_coefficients
    )
    residual_validation = (
        transformed_validation
        - covariates_validation @ feature_covariate_coefficients
    )
    return (
        residual_train,
        residual_validation,
        outcome_residual,
        covariate_validation_prediction,
        retained,
    )


def _predict_with_alpha(
    features_train: np.ndarray,
    features_validation: np.ndarray,
    covariates_train: np.ndarray,
    covariates_validation: np.ndarray,
    outcome_train: np.ndarray,
    alpha: float,
) -> tuple[np.ndarray, int]:
    residual_train, residual_validation, outcome_residual, baseline, retained = (
        _prepare_incremental_problem(
            features_train,
            features_validation,
            covariates_train,
            covariates_validation,
            outcome_train,
        )
    )
    if retained == 0:
        return baseline, retained
    model = Ridge(alpha=float(alpha), fit_intercept=False)
    model.fit(residual_train, outcome_residual)
    return baseline + model.predict(residual_validation), retained


def _choose_alpha(
    features: np.ndarray,
    covariates: np.ndarray,
    outcome: np.ndarray,
    *,
    alphas: tuple[float, ...],
    seed: int,
    inner_folds: int,
) -> float:
    if features.shape[1] == 0:
        return float(alphas[-1])
    fold_count = min(inner_folds, len(features))
    if fold_count < 2:
        return float(alphas[-1])
    splitter = KFold(n_splits=fold_count, shuffle=True, random_state=seed)
    squared_errors = {float(alpha): [] for alpha in alphas}
    for train_index, validation_index in splitter.split(features):
        for alpha in alphas:
            prediction, _ = _predict_with_alpha(
                features[train_index],
                features[validation_index],
                covariates[train_index],
                covariates[validation_index],
                outcome[train_index],
                float(alpha),
            )
            squared_errors[float(alpha)].extend(
                ((outcome[validation_index] - prediction) ** 2).tolist()
            )
    mean_rmse = {
        alpha: float(np.sqrt(np.mean(errors)))
        for alpha, errors in squared_errors.items()
    }
    return min(mean_rmse, key=lambda alpha: (mean_rmse[alpha], -alpha))


def prediction_metrics(outcome: np.ndarray, prediction: np.ndarray) -> dict[str, float]:
    residual = outcome - prediction
    centered = outcome - outcome.mean()
    denominator = float(np.sum(centered**2))
    pearson = (
        float(np.corrcoef(outcome, prediction)[0, 1])
        if prediction.std() > 0 and outcome.std() > 0
        else float("nan")
    )
    spearman = (
        float(np.corrcoef(rankdata(outcome), rankdata(prediction))[0, 1])
        if prediction.std() > 0 and outcome.std() > 0
        else float("nan")
    )
    return {
        "pearson_r": pearson,
        "spearman_r": spearman,
        # undefined for a constant outcome (e.g. a leave-one-donor subset without its one positive)
        "r2": 1.0 - float(np.sum(residual**2)) / denominator if denominator > 0 else float("nan"),
        "rmse": float(np.sqrt(np.mean(residual**2))),
        "mae": float(np.mean(np.abs(residual))),
    }


def _panel_predictions(
    features: np.ndarray,
    covariates: np.ndarray,
    outcome: np.ndarray,
    *,
    config: PredictivePanelConfig,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    predictions = np.full((config.outer_repeats, len(outcome)), np.nan, dtype=float)
    tuning: list[dict[str, Any]] = []
    # A cohort smaller than outer_folds is cross-validated leave-one-out.
    outer_folds = min(config.outer_folds, len(outcome))
    if outer_folds < 2:
        raise ValueError(f"Cross-validation needs at least 2 donors, got {len(outcome)}")
    for repeat in range(config.outer_repeats):
        outer = KFold(
            n_splits=outer_folds,
            shuffle=True,
            random_state=config.seed + repeat,
        )
        for outer_fold, (train_index, validation_index) in enumerate(outer.split(features)):
            alpha = _choose_alpha(
                features[train_index],
                covariates[train_index],
                outcome[train_index],
                alphas=config.ridge_alphas,
                seed=config.seed + repeat * 1000 + outer_fold * 50,
                inner_folds=config.inner_folds,
            )
            prediction, retained = _predict_with_alpha(
                features[train_index],
                features[validation_index],
                covariates[train_index],
                covariates[validation_index],
                outcome[train_index],
                alpha,
            )
            predictions[repeat, validation_index] = prediction
            tuning.append(
                {
                    "repeat": repeat,
                    "outer_fold": outer_fold,
                    "selected_alpha": alpha,
                    "input_features": int(features.shape[1]),
                    "retained_features": retained,
                }
            )
    if not np.isfinite(predictions).all():
        raise RuntimeError("Cross-validation produced missing predictions")
    return predictions, tuning


def _feature_array(frame: pd.DataFrame, feature_columns: list[str]) -> np.ndarray:
    if not feature_columns:
        return np.empty((len(frame), 0), dtype=float)
    values = frame.loc[:, feature_columns].apply(pd.to_numeric, errors="coerce")
    return values.replace([np.inf, -np.inf], np.nan).to_numpy(dtype=float)


def _repeat_metrics(
    outcome: np.ndarray,
    predictions: np.ndarray,
) -> list[dict[str, float]]:
    return [prediction_metrics(outcome, predictions[index]) for index in range(len(predictions))]


def _leave_one_donor_improvements(
    outcome: np.ndarray,
    baseline_prediction: np.ndarray,
    candidate_prediction: np.ndarray,
) -> np.ndarray:
    improvements: list[float] = []
    for index in range(len(outcome)):
        keep = np.arange(len(outcome)) != index
        baseline = prediction_metrics(outcome[keep], baseline_prediction[keep])
        candidate = prediction_metrics(outcome[keep], candidate_prediction[keep])
        improvements.append(baseline["rmse"] - candidate["rmse"])
    return np.asarray(improvements, dtype=float)


def panel_cv_predictions(
    frame: pd.DataFrame,
    *,
    outcome_column: str,
    covariates: list[str],
    feature_columns: list[str],
    config: PredictivePanelConfig,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    """One panel's repeated nested-CV predictions (repeats x donors) and alpha tuning,
    for compare_predictive_panels(baseline=...) on frames with the same donor order."""
    return _panel_predictions(
        _feature_array(frame, feature_columns),
        covariate_matrix(frame, covariates),
        pd.to_numeric(frame[outcome_column], errors="raise").to_numpy(dtype=float),
        config=config,
    )


def compare_predictive_panels(
    frame: pd.DataFrame,
    *,
    outcome_column: str,
    covariates: list[str],
    baseline_feature_columns: list[str],
    candidate_feature_columns: list[str],
    config: PredictivePanelConfig,
    baseline: tuple[np.ndarray, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """Compare two fixed panels with identical repeated outer folds. `baseline`: the
    baseline panel's panel_cv_predictions, when already computed on this donor order."""
    if len(candidate_feature_columns) > config.max_panel_size:
        raise ValueError(
            f"Candidate panel has {len(candidate_feature_columns)} features; "
            f"maximum is {config.max_panel_size}"
        )
    required = ["donor_id", outcome_column, *covariates]
    missing = [column for column in required if column not in frame.columns]
    if missing:
        raise ValueError(f"Missing required columns: {missing}")
    if frame["donor_id"].duplicated().any():
        raise ValueError("Each donor must appear exactly once")

    outcome = pd.to_numeric(frame[outcome_column], errors="raise").to_numpy(dtype=float)
    covariate_values = covariate_matrix(frame, covariates)
    candidate_features = _feature_array(frame, candidate_feature_columns)

    baseline_predictions, baseline_tuning = baseline or _panel_predictions(
        _feature_array(frame, baseline_feature_columns),
        covariate_values,
        outcome,
        config=config,
    )
    candidate_predictions, candidate_tuning = _panel_predictions(
        candidate_features,
        covariate_values,
        outcome,
        config=config,
    )
    baseline_repeat = _repeat_metrics(outcome, baseline_predictions)
    candidate_repeat = _repeat_metrics(outcome, candidate_predictions)

    per_repeat: list[dict[str, Any]] = []
    for repeat, (baseline, candidate) in enumerate(zip(baseline_repeat, candidate_repeat)):
        per_repeat.append(
            {
                "repeat": repeat,
                "baseline": baseline,
                "candidate": candidate,
                "rmse_improvement": baseline["rmse"] - candidate["rmse"],
                "pearson_delta": candidate["pearson_r"] - baseline["pearson_r"],
                "r2_delta": candidate["r2"] - baseline["r2"],
            }
        )

    baseline_consensus_prediction = baseline_predictions.mean(axis=0)
    candidate_consensus_prediction = candidate_predictions.mean(axis=0)
    baseline_consensus = prediction_metrics(outcome, baseline_consensus_prediction)
    candidate_consensus = prediction_metrics(outcome, candidate_consensus_prediction)
    rmse_improvements = np.asarray(
        [record["rmse_improvement"] for record in per_repeat], dtype=float
    )
    pearson_deltas = np.asarray(
        [record["pearson_delta"] for record in per_repeat], dtype=float
    )
    leave_one_donor_improvements = _leave_one_donor_improvements(
        outcome,
        baseline_consensus_prediction,
        candidate_consensus_prediction,
    )
    consensus_rmse_improvement = (
        baseline_consensus["rmse"] - candidate_consensus["rmse"]
    )
    consensus_pearson_delta = (
        candidate_consensus["pearson_r"] - baseline_consensus["pearson_r"]
    )
    mean_rmse_improvement = float(rmse_improvements.mean())
    repeats_better = int((rmse_improvements > 0).sum())
    fraction_better = repeats_better / len(rmse_improvements)
    worst_leave_one_donor = float(leave_one_donor_improvements.min())
    outcome_sd = float(outcome.std())

    # NaN metrics (a constant outcome) compare False: such a panel is not admitted.
    gates = {
        "mean_rmse_improvement": (
            mean_rmse_improvement >= config.min_mean_rmse_improvement * outcome_sd
        ),
        "fraction_repeats_better_rmse": repeats_better >= min_repeats_better(config),
        "consensus_rmse_improvement": (
            consensus_rmse_improvement
            >= config.min_consensus_rmse_improvement * outcome_sd
        ),
        "consensus_pearson_delta": (
            consensus_pearson_delta >= config.min_consensus_pearson_delta
        ),
        "leave_one_donor_sensitivity": (
            worst_leave_one_donor
            >= config.min_worst_leave_one_donor_rmse_improvement * outcome_sd
        ),
    }
    accepted = all(gates.values())

    donor_records: list[dict[str, Any]] = []
    donor_ids = frame["donor_id"].astype(str).tolist()
    for donor_index, donor_id in enumerate(donor_ids):
        for repeat in range(config.outer_repeats):
            donor_records.append(
                {
                    "donor_id": donor_id,
                    "repeat": repeat,
                    "outcome": float(outcome[donor_index]),
                    "baseline_prediction": float(
                        baseline_predictions[repeat, donor_index]
                    ),
                    "candidate_prediction": float(
                        candidate_predictions[repeat, donor_index]
                    ),
                }
            )

    return {
        "config": asdict(config),
        "n_donors": len(frame),
        "outcome_sd": outcome_sd,
        "baseline_feature_columns": list(baseline_feature_columns),
        "candidate_feature_columns": list(candidate_feature_columns),
        "baseline_mean_metrics": {
            key: float(np.mean([row[key] for row in baseline_repeat]))
            for key in baseline_repeat[0]
        },
        "candidate_mean_metrics": {
            key: float(np.mean([row[key] for row in candidate_repeat]))
            for key in candidate_repeat[0]
        },
        "baseline_consensus_metrics": baseline_consensus,
        "candidate_consensus_metrics": candidate_consensus,
        "mean_rmse_improvement": mean_rmse_improvement,
        "median_rmse_improvement": float(np.median(rmse_improvements)),
        "fraction_repeats_better_rmse": fraction_better,
        "repeats_better_rmse": repeats_better,
        "min_repeats_better_rmse": min_repeats_better(config),
        "mean_pearson_delta": float(pearson_deltas.mean()),
        "consensus_rmse_improvement": float(consensus_rmse_improvement),
        "consensus_pearson_delta": float(consensus_pearson_delta),
        "worst_leave_one_donor_rmse_improvement": worst_leave_one_donor,
        "median_leave_one_donor_rmse_improvement": float(
            np.median(leave_one_donor_improvements)
        ),
        "acceptance_gates": gates,
        "acceptance_passed": accepted,
        "per_repeat": per_repeat,
        "donor_predictions": donor_records,
        "baseline_tuning": baseline_tuning,
        "candidate_tuning": candidate_tuning,
    }


def predictive_result_fields(comparison: dict[str, Any]) -> dict[str, Any]:
    baseline_mean = comparison["baseline_mean_metrics"]
    candidate_mean = comparison["candidate_mean_metrics"]
    baseline_consensus = comparison["baseline_consensus_metrics"]
    candidate_consensus = comparison["candidate_consensus_metrics"]
    return {
        "panel_baseline_score": baseline_consensus["pearson_r"],
        "panel_candidate_score": candidate_consensus["pearson_r"],
        "delta_panel_score": comparison["consensus_pearson_delta"],
        "panel_baseline_rmse": baseline_mean["rmse"],
        "panel_candidate_rmse": candidate_mean["rmse"],
        "mean_rmse_improvement": comparison["mean_rmse_improvement"],
        "fraction_repeats_better_rmse": comparison[
            "fraction_repeats_better_rmse"
        ],
        "consensus_rmse_improvement": comparison[
            "consensus_rmse_improvement"
        ],
        "worst_leave_one_donor_rmse_improvement": comparison[
            "worst_leave_one_donor_rmse_improvement"
        ],
        "predictive_validation_passed": comparison["acceptance_passed"],
        "predictive_acceptance_gates": comparison["acceptance_gates"],
    }
