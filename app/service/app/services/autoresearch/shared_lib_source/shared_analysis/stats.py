from __future__ import annotations

from typing import Iterable

import numpy as np
import pandas as pd
from scipy.stats import pearsonr


def _clean_frame(df: pd.DataFrame, columns: Iterable[str]) -> pd.DataFrame:
    cleaned = df.loc[:, list(columns)].replace([np.inf, -np.inf], np.nan).dropna()
    if cleaned.empty:
        raise ValueError("No rows left after dropping missing values")
    return cleaned


def _design_matrix(confounds: pd.DataFrame) -> np.ndarray:
    matrix = confounds.astype(float).to_numpy()
    intercept = np.ones((len(confounds), 1), dtype=float)
    return np.hstack([intercept, matrix])


def residualize(values: pd.Series | np.ndarray, confounds: pd.DataFrame) -> np.ndarray:
    y = np.asarray(values, dtype=float)
    x = _design_matrix(confounds)
    beta, *_ = np.linalg.lstsq(x, y, rcond=None)
    return y - x @ beta


def partial_correlation(
    df: pd.DataFrame,
    *,
    feature_col: str,
    outcome_col: str,
    confounds: list[str],
) -> dict[str, float]:
    frame = _clean_frame(df, [feature_col, outcome_col, *confounds])
    feature_resid = residualize(frame[feature_col], frame[confounds])
    outcome_resid = residualize(frame[outcome_col], frame[confounds])
    if np.std(feature_resid) == 0 or np.std(outcome_resid) == 0:
        return {"n": float(len(frame)), "partial_r": float("nan"), "p_value": float("nan")}
    corr, p_value = pearsonr(feature_resid, outcome_resid)
    return {"n": float(len(frame)), "partial_r": float(corr), "p_value": float(p_value)}


def bootstrap_partial_correlation(
    df: pd.DataFrame,
    *,
    feature_col: str,
    outcome_col: str,
    confounds: list[str],
    n_boot: int = 2000,
    random_state: int = 0,
) -> dict[str, float]:
    frame = _clean_frame(df, [feature_col, outcome_col, *confounds]).reset_index(drop=True)
    base = partial_correlation(
        frame,
        feature_col=feature_col,
        outcome_col=outcome_col,
        confounds=confounds,
    )
    rng = np.random.default_rng(random_state)
    samples: list[float] = []
    if len(frame) < 4:
        return {**base, "ci_lo": float("nan"), "ci_hi": float("nan"), "bootstraps_used": 0.0}
    for _ in range(int(n_boot)):
        indices = rng.integers(0, len(frame), size=len(frame))
        sampled = frame.iloc[indices]
        result = partial_correlation(
            sampled,
            feature_col=feature_col,
            outcome_col=outcome_col,
            confounds=confounds,
        )
        value = result["partial_r"]
        if np.isfinite(value):
            samples.append(value)
    if not samples:
        return {**base, "ci_lo": float("nan"), "ci_hi": float("nan"), "bootstraps_used": 0.0}
    ci_lo, ci_hi = np.percentile(np.asarray(samples, dtype=float), [2.5, 97.5])
    return {
        **base,
        "ci_lo": float(ci_lo),
        "ci_hi": float(ci_hi),
        "bootstraps_used": float(len(samples)),
    }


def bootstrap_partial_correlation_stability(
    df: pd.DataFrame,
    *,
    feature_col: str,
    outcome_col: str,
    confounds: list[str],
    n_boot: int = 400,
    sample_frac: float = 0.8,
    random_state: int = 0,
) -> dict[str, float]:
    frame = _clean_frame(df, [feature_col, outcome_col, *confounds]).reset_index(drop=True)
    n = len(frame)
    if n < 6:
        return {
            "bootstrap_median_partial_r": float("nan"),
            "bootstrap_q25_partial_r": float("nan"),
            "bootstrap_q75_partial_r": float("nan"),
            "bootstrap_sign_consistency": float("nan"),
            "bootstrap_positive_fraction": float("nan"),
            "bootstrap_negative_fraction": float("nan"),
            "bootstrap_valid_samples": 0.0,
            "bootstrap_sample_size": float("nan"),
        }

    sample_size = max(6, min(n, int(round(n * sample_frac))))
    rng = np.random.default_rng(random_state)
    samples: list[float] = []
    for _ in range(int(n_boot)):
        indices = rng.choice(n, size=sample_size, replace=False)
        sampled = frame.iloc[indices]
        result = partial_correlation(
            sampled,
            feature_col=feature_col,
            outcome_col=outcome_col,
            confounds=confounds,
        )
        value = result["partial_r"]
        if np.isfinite(value):
            samples.append(float(value))

    if not samples:
        return {
            "bootstrap_median_partial_r": float("nan"),
            "bootstrap_q25_partial_r": float("nan"),
            "bootstrap_q75_partial_r": float("nan"),
            "bootstrap_sign_consistency": float("nan"),
            "bootstrap_positive_fraction": float("nan"),
            "bootstrap_negative_fraction": float("nan"),
            "bootstrap_valid_samples": 0.0,
            "bootstrap_sample_size": float(sample_size),
        }

    arr = np.asarray(samples, dtype=float)
    pos_fraction = float((arr > 0).mean())
    neg_fraction = float((arr < 0).mean())
    q25, q75 = np.percentile(arr, [25, 75])
    return {
        "bootstrap_median_partial_r": float(np.median(arr)),
        "bootstrap_q25_partial_r": float(q25),
        "bootstrap_q75_partial_r": float(q75),
        "bootstrap_sign_consistency": float(max(pos_fraction, neg_fraction)),
        "bootstrap_positive_fraction": pos_fraction,
        "bootstrap_negative_fraction": neg_fraction,
        "bootstrap_valid_samples": float(len(arr)),
        "bootstrap_sample_size": float(sample_size),
    }


def leave_one_out_partial_correlation(
    df: pd.DataFrame,
    *,
    feature_col: str,
    outcome_col: str,
    confounds: list[str],
    id_col: str | None = None,
) -> pd.DataFrame:
    frame = _clean_frame(df, [feature_col, outcome_col, *confounds, *( [id_col] if id_col else [] )]).reset_index(drop=True)
    base = partial_correlation(
        frame,
        feature_col=feature_col,
        outcome_col=outcome_col,
        confounds=confounds,
    )
    rows = []
    for idx in range(len(frame)):
        reduced = frame.drop(index=idx).reset_index(drop=True)
        result = partial_correlation(
            reduced,
            feature_col=feature_col,
            outcome_col=outcome_col,
            confounds=confounds,
        )
        row = {
            "index": idx,
            "partial_r": result["partial_r"],
            "delta_from_full": result["partial_r"] - base["partial_r"],
        }
        if id_col:
            row[id_col] = frame.loc[idx, id_col]
        rows.append(row)
    return pd.DataFrame(rows)


def leave_one_out_summary(
    df: pd.DataFrame,
    *,
    feature_col: str,
    outcome_col: str,
    confounds: list[str],
    id_col: str | None = None,
    unstable_delta: float = 0.10,
) -> dict[str, object]:
    loo = leave_one_out_partial_correlation(
        df,
        feature_col=feature_col,
        outcome_col=outcome_col,
        confounds=confounds,
        id_col=id_col,
    )
    if loo.empty:
        return {"max_shift": float("nan"), "unstable_donors": []}
    shifts = loo["delta_from_full"].abs()
    unstable = loo.loc[shifts > unstable_delta]
    return {
        "max_shift": float(shifts.max()),
        "unstable_count": int((shifts > unstable_delta).sum()),
        "unstable_donors": unstable.to_dict(orient="records"),
    }


def residualized_loo_predictive_correlation(
    df: pd.DataFrame,
    *,
    feature_col: str,
    outcome_col: str,
    confounds: list[str],
) -> float:
    frame = _clean_frame(df, [feature_col, outcome_col, *confounds]).reset_index(drop=True)
    preds: list[float] = []
    actuals: list[float] = []
    for idx in range(len(frame)):
        train = frame.drop(index=idx).reset_index(drop=True)
        test = frame.iloc[[idx]].reset_index(drop=True)

        x_train_conf = _design_matrix(train[confounds])
        x_test_conf = _design_matrix(test[confounds])

        beta_feature, *_ = np.linalg.lstsq(
            x_train_conf,
            train[feature_col].to_numpy(dtype=float),
            rcond=None,
        )
        beta_outcome, *_ = np.linalg.lstsq(
            x_train_conf,
            train[outcome_col].to_numpy(dtype=float),
            rcond=None,
        )

        resid_feature_train = train[feature_col].to_numpy(dtype=float) - x_train_conf @ beta_feature
        resid_outcome_train = train[outcome_col].to_numpy(dtype=float) - x_train_conf @ beta_outcome

        denom = float(np.dot(resid_feature_train, resid_feature_train))
        if denom <= 0:
            preds.append(float("nan"))
            actuals.append(float("nan"))
            continue

        slope = float(np.dot(resid_feature_train, resid_outcome_train) / denom)
        resid_feature_test = test[feature_col].to_numpy(dtype=float) - x_test_conf @ beta_feature
        resid_outcome_test = test[outcome_col].to_numpy(dtype=float) - x_test_conf @ beta_outcome

        preds.append(float(slope * resid_feature_test[0]))
        actuals.append(float(resid_outcome_test[0]))

    pred_arr = np.asarray(preds, dtype=float)
    act_arr = np.asarray(actuals, dtype=float)
    mask = np.isfinite(pred_arr) & np.isfinite(act_arr)
    if mask.sum() < 3 or np.std(pred_arr[mask]) == 0 or np.std(act_arr[mask]) == 0:
        return float("nan")
    return float(np.corrcoef(pred_arr[mask], act_arr[mask])[0, 1])


def multifeature_residualized_correlation(
    df: pd.DataFrame,
    *,
    feature_cols: list[str],
    outcome_col: str,
    confounds: list[str],
) -> float:
    frame = _clean_frame(df, [*feature_cols, outcome_col, *confounds]).reset_index(drop=True)
    if not feature_cols:
        return float("nan")

    resid_feature_cols = [residualize(frame[col], frame[confounds]) for col in feature_cols]
    resid_outcome = residualize(frame[outcome_col], frame[confounds])
    x_panel = np.column_stack(resid_feature_cols)
    if x_panel.ndim != 2 or x_panel.shape[1] == 0:
        return float("nan")
    if np.linalg.matrix_rank(x_panel) == 0 or np.std(resid_outcome) == 0:
        return float("nan")

    beta_panel, *_ = np.linalg.lstsq(x_panel, resid_outcome, rcond=None)
    pred = x_panel @ beta_panel
    if np.std(pred) == 0:
        return float("nan")
    return float(np.corrcoef(pred, resid_outcome)[0, 1])


def multifeature_loo_predictive_correlation(
    df: pd.DataFrame,
    *,
    feature_cols: list[str],
    outcome_col: str,
    confounds: list[str],
) -> float:
    frame = _clean_frame(df, [*feature_cols, outcome_col, *confounds]).reset_index(drop=True)
    if not feature_cols:
        return float("nan")

    preds: list[float] = []
    actuals: list[float] = []
    for idx in range(len(frame)):
        train = frame.drop(index=idx).reset_index(drop=True)
        test = frame.iloc[[idx]].reset_index(drop=True)

        x_train_conf = _design_matrix(train[confounds])
        x_test_conf = _design_matrix(test[confounds])

        beta_outcome, *_ = np.linalg.lstsq(
            x_train_conf,
            train[outcome_col].to_numpy(dtype=float),
            rcond=None,
        )
        resid_outcome_train = train[outcome_col].to_numpy(dtype=float) - x_train_conf @ beta_outcome
        resid_outcome_test = test[outcome_col].to_numpy(dtype=float) - x_test_conf @ beta_outcome

        resid_feature_train_cols: list[np.ndarray] = []
        resid_feature_test_cols: list[np.ndarray] = []
        for feature_col in feature_cols:
            beta_feature, *_ = np.linalg.lstsq(
                x_train_conf,
                train[feature_col].to_numpy(dtype=float),
                rcond=None,
            )
            resid_feature_train_cols.append(
                train[feature_col].to_numpy(dtype=float) - x_train_conf @ beta_feature
            )
            resid_feature_test_cols.append(
                test[feature_col].to_numpy(dtype=float) - x_test_conf @ beta_feature
            )

        x_panel_train = np.column_stack(resid_feature_train_cols)
        x_panel_test = np.column_stack(resid_feature_test_cols)
        if x_panel_train.ndim != 2 or x_panel_train.shape[1] == 0:
            preds.append(float("nan"))
            actuals.append(float("nan"))
            continue
        if np.linalg.matrix_rank(x_panel_train) == 0:
            preds.append(float("nan"))
            actuals.append(float("nan"))
            continue

        beta_panel, *_ = np.linalg.lstsq(x_panel_train, resid_outcome_train, rcond=None)
        pred = x_panel_test @ beta_panel
        preds.append(float(pred[0]))
        actuals.append(float(resid_outcome_test[0]))

    pred_arr = np.asarray(preds, dtype=float)
    act_arr = np.asarray(actuals, dtype=float)
    mask = np.isfinite(pred_arr) & np.isfinite(act_arr)
    if mask.sum() < 3 or np.std(pred_arr[mask]) == 0 or np.std(act_arr[mask]) == 0:
        return float("nan")
    return float(np.corrcoef(pred_arr[mask], act_arr[mask])[0, 1])
