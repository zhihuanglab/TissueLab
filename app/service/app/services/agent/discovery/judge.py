"""The judge: scores every planned variation of a round against the accepted panel.

Each variation is tried as an addition (while a slot is free) and as a one-for-one
replacement of each member, with the paired nested-CV comparison and gates of
panel_cv plus the pre-registered expected_sign and coverage gates. The best
eligible action is admitted. Outcome and covariates come from the problem; the
cohort is read host-side and never enters the sandbox.
"""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .panel_cv import (
    PredictivePanelConfig,
    compare_predictive_panels,
    covariate_matrix,
    cv_unavailable_reason,
    panel_cv_predictions,
    predictive_result_fields,
)
from .problem import ProblemSpec, load_cohort


EPSILON = 1e-12


def _slug(value: Any) -> str:
    text = re.sub(r"[^A-Za-z0-9]+", "_", str(value or "").strip().lower())
    return text.strip("_") or "feature"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


TABLE_NAME = "donor_feature_table.csv"   # the worker's controller writes /scratch/<this>


def run_path(run_root: Path | None, value: Any) -> Path | None:
    """Resolve a recorded path without guessing missing or relocated files."""
    if not value:
        return None
    path = Path(str(value))
    return run_root / path if run_root is not None else path


def _member_table_and_column(member: dict[str, Any], run_root: Path | None) -> tuple[Path, str]:
    table_path = run_path(run_root, member.get("donor_feature_table"))
    feature_column = str(member.get("feature_column") or "").strip()
    if table_path is None or not table_path.is_file():
        raise FileNotFoundError(
            f"Could not locate donor table for accepted panel member {member.get('feature_name')}"
        )
    if not feature_column:
        raise ValueError(
            f"Accepted panel member has no canonical feature column: {member.get('feature_name')}"
        )
    return table_path, feature_column


def _candidate_table_and_column(worker_brief: dict[str, Any], worker_roundup: dict[str, Any]) -> tuple[Path, str]:
    table_path = Path(str(worker_roundup.get("worker_dir") or "")) / "sandbox" / TABLE_NAME
    if not table_path.exists():
        raise FileNotFoundError(f"Candidate worker did not produce {TABLE_NAME}")
    canonical = str(worker_brief.get("baseline_variation") or "").strip()
    table = pd.read_csv(table_path, nrows=2, dtype={"donor_id": str})
    if canonical not in table.columns:
        raise ValueError(
            f"Pre-specified primary variation {canonical!r} is not a donor-table column"
        )
    return table_path, canonical


def _load_feature_frame(
    table_path: Path,
    feature_column: str,
    output_column: str,
) -> pd.DataFrame:
    table = pd.read_csv(table_path, dtype={"donor_id": str})
    if "donor_id" not in table.columns:
        raise ValueError(f"Donor table lacks donor_id: {table_path}")
    if feature_column not in table.columns:
        raise ValueError(f"Donor table lacks {feature_column}: {table_path}")
    if table["donor_id"].duplicated().any():
        raise ValueError(f"Donor table contains duplicate donor IDs: {table_path}")
    return table.loc[:, ["donor_id", feature_column]].rename(
        columns={feature_column: output_column}
    )


def _merge_panel(
    cohort: pd.DataFrame,
    members: list[dict[str, Any]],
    run_root: Path | None,
) -> tuple[pd.DataFrame, list[str]]:
    merged = cohort.copy()
    feature_columns: list[str] = []
    for index, member in enumerate(members, start=1):
        table_path, source_column = _member_table_and_column(member, run_root)
        output_column = f"panel_{index:02d}__{_slug(source_column)}"
        frame = _load_feature_frame(table_path, source_column, output_column)
        merged = merged.merge(frame, on="donor_id", how="left", validate="one_to_one")
        feature_columns.append(output_column)
    return merged, feature_columns


def _comparison_summary(comparison: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in comparison.items()
        if key
        not in {
            "per_repeat",
            "donor_predictions",
            "baseline_tuning",
            "candidate_tuning",
        }
    }


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, (np.floating, float)):
        number = float(value)
        return number if np.isfinite(number) else None
    if isinstance(value, np.integer):
        return int(value)
    return value


def _write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    headers: list[str] = []
    for row in rows:
        for key in row:
            if key not in headers:
                headers.append(key)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


NEAR_DUPLICATE_R = 0.95


def _variation_redundancy(
    table_path: Path, columns: list[str]
) -> tuple[dict[str, float], list[list[str]], int]:
    """Pairwise Pearson r between the screened variations, the near-duplicate pairs (|r| > 0.95),
    and the number of distinct (non-near-duplicate) variations. Reported only: no gate or
    threshold is adjusted for the number of variations screened."""
    if len(columns) < 2:
        return {}, [], len(columns)
    table = pd.read_csv(table_path, usecols=["donor_id", *columns], dtype={"donor_id": str}).replace([np.inf, -np.inf], np.nan)
    corr: dict[str, float] = {}
    dup_pairs: list[list[str]] = []
    parent = {c: c for c in columns}

    def find(c: str) -> str:
        while parent[c] != c:
            c = parent[c]
        return c

    for i, a in enumerate(columns):
        for b in columns[i + 1:]:
            pair = table[[a, b]].dropna()
            r = float(pair[a].corr(pair[b])) if len(pair) >= 5 and pair[a].std() > 0 and pair[b].std() > 0 else float("nan")
            corr[f"{a}|{b}"] = r
            if np.isfinite(r) and abs(r) > NEAR_DUPLICATE_R:
                dup_pairs.append([a, b])
                parent[find(a)] = find(b)
    distinct = len({find(c) for c in columns})
    return corr, dup_pairs, distinct


def _planned_variation_columns(
    worker_brief: dict[str, Any], table_path: Path, primary_column: str
) -> list[str]:
    """Primary first, then every other pre-specified variation that exists in the donor table."""
    columns = set(pd.read_csv(table_path, nrows=1, dtype={"donor_id": str}).columns)
    ordered = [primary_column]
    for item in worker_brief.get("variations") or []:
        name = str((item.get("name") if isinstance(item, dict) else item) or "").strip()
        if name and name in columns and name not in ordered:
            ordered.append(name)
    return ordered


def _influence_stats(
    frame: pd.DataFrame, feature_column: str, outcome_column: str, covariates: list[str]
) -> dict[str, Any]:
    """In-sample, covariate-adjusted diagnostics used as structured feedback (not as a gate):
    partial r, its leave-one-donor range, and the single-donor share of the residual covariance."""
    data = frame.loc[:, ["donor_id", outcome_column, feature_column, *covariates]].dropna()
    n = len(data)
    if n < 6:
        return {"partial_r": None, "partial_r_loo_min": None, "partial_r_loo_max": None,
                "top_influence_donor": None, "top_influence_share": None, "n_used": int(n)}
    X = covariate_matrix(data, covariates)   # already carries the intercept column
    y = data[outcome_column].to_numpy(dtype=float)
    x = data[feature_column].to_numpy(dtype=float)

    def _partial(idx: np.ndarray) -> float:
        Xi, yi, xi = X[idx], y[idx], x[idx]
        ry = yi - Xi @ np.linalg.lstsq(Xi, yi, rcond=None)[0]
        rx = xi - Xi @ np.linalg.lstsq(Xi, xi, rcond=None)[0]
        if np.std(ry) == 0 or np.std(rx) == 0:
            return float("nan")
        return float(np.corrcoef(ry, rx)[0, 1])

    full = np.arange(n)
    pr = _partial(full)
    loo = [_partial(np.delete(full, i)) for i in range(n)]
    ry = y - X @ np.linalg.lstsq(X, y, rcond=None)[0]
    rx = x - X @ np.linalg.lstsq(X, x, rcond=None)[0]
    contrib = ry * rx
    total = float(np.abs(contrib).sum())
    top = int(np.argmax(np.abs(contrib))) if total > 0 else None
    return {
        "partial_r": None if not np.isfinite(pr) else pr,
        "partial_r_loo_min": float(np.nanmin(loo)),
        "partial_r_loo_max": float(np.nanmax(loo)),
        "top_influence_donor": str(data["donor_id"].iloc[top]) if top is not None else None,
        "top_influence_share": float(abs(contrib[top]) / total) if top is not None else None,
        "n_used": int(n),
    }


def _candidate_coverage(table_path: Path, feature_column: str, donor_ids: set[str]) -> float:
    table = pd.read_csv(table_path, usecols=["donor_id", feature_column], dtype={"donor_id": str})
    table = table.loc[table["donor_id"].astype(str).isin(donor_ids)]
    values = pd.to_numeric(table[feature_column], errors="coerce").replace(
        [np.inf, -np.inf], np.nan
    )
    return float(values.notna().sum() / len(donor_ids)) if donor_ids else 0.0


def review_candidate(
    *,
    accepted_panel: dict[str, Any],
    worker_brief: dict[str, Any],
    worker_roundup: dict[str, Any],
    data_dir: str | Path,
    spec: ProblemSpec,
    round_dir: str | Path,
    config: PredictivePanelConfig,
    run_root: str | Path | None = None,
) -> dict[str, Any]:
    """Evaluate add/replace actions against the frozen current panel. run_root is the
    run folder the accepted members' paths are recorded relative to."""
    primary_outcome = spec.outcome
    covariates = list(spec.covariates)
    round_dir = Path(round_dir)

    # Donor tables key on donor_id whatever the cohort calls its identifier.
    cohort = (
        load_cohort(spec, data_dir)
        .loc[:, [spec.id_column, primary_outcome, *covariates]]
        .rename(columns={spec.id_column: "donor_id"})
        .sort_values("donor_id")
        .reset_index(drop=True)
    )
    if not cohort[primary_outcome].notna().all():
        raise ValueError("Discovery cohort contains missing outcomes")
    current_members = [dict(member) for member in accepted_panel.get("members", [])]
    current_frame, current_columns = _merge_panel(
        cohort, current_members, Path(run_root) if run_root is not None else None
    )

    candidate_path, primary_column = _candidate_table_and_column(
        worker_brief, worker_roundup
    )
    variation_columns = _planned_variation_columns(worker_brief, candidate_path, primary_column)
    # Pre-registered direction per variation (+1/-1; None = undeclared -> cannot be admitted).
    expected_signs: dict[str, int | None] = {}
    for item in worker_brief.get("variations") or []:
        if isinstance(item, dict) and item.get("name"):
            sign = item.get("expected_sign")
            expected_signs[str(item["name"])] = int(sign) if sign in (1, -1, 1.0, -1.0) else None
    panel_full = len(current_members) >= config.max_panel_size
    panel_frame = current_frame
    donor_ids = set(panel_frame["donor_id"].astype(str))

    unavailable = cv_unavailable_reason(panel_frame, covariates, config)
    if unavailable:
        variations = []
        for column in variation_columns:
            # Validate the produced table even when statistical scoring is unavailable.
            _load_feature_frame(candidate_path, column, f"candidate__{_slug(column)}")
            variations.append({"variation": column, "is_primary": column == primary_column,
                               "coverage": _candidate_coverage(candidate_path, column, donor_ids)})
        review = {
            "decision": "not_evaluable", "reason": "insufficient_residual_degrees_of_freedom",
            "evaluation_note": unavailable, "n_donors": len(panel_frame), "keep": False,
            "chosen_review": None, "variation_summaries": variations,
            "screened_variations": len(variations), "current_panel_size": len(current_members),
            "max_panel_size": config.max_panel_size, "panel_full": panel_full,
            "accepted_panel_score": None, "accepted_panel_rmse": None, "accepted_panel_delta": None,
        }
        (round_dir / "predictive_cv_review.json").write_text(
            json.dumps(review, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        return review

    action_reviews: list[dict[str, Any]] = []
    repeat_rows: list[dict[str, Any]] = []
    prediction_rows: list[dict[str, Any]] = []
    tuning_rows: list[dict[str, Any]] = []
    full_comparisons: list[dict[str, Any]] = []
    variation_summaries: list[dict[str, Any]] = []
    base_results = dict(worker_roundup.get("results") or {})
    comparison: dict[str, Any] | None = None
    # The current panel's CV predictions are the same for every variation and action.
    baseline = panel_cv_predictions(
        panel_frame, outcome_column=primary_outcome, covariates=covariates,
        feature_columns=current_columns, config=config,
    )

    # Every pre-specified variation is judged (and counted as a screened candidate); the
    # best eligible one across variations x actions is admitted. Primary is listed first.
    for candidate_source_column in variation_columns:
        is_primary = candidate_source_column == primary_column
        candidate_column = f"candidate__{_slug(candidate_source_column)}"
        candidate_frame = _load_feature_frame(
            candidate_path, candidate_source_column, candidate_column
        )
        current_frame = panel_frame.merge(
            candidate_frame, on="donor_id", how="left", validate="one_to_one"
        )
        coverage = _candidate_coverage(candidate_path, candidate_source_column, donor_ids)
        influence = _influence_stats(current_frame, candidate_column, primary_outcome, covariates)
        expected_sign = expected_signs.get(candidate_source_column)
        observed_pr = influence.get("partial_r")
        observed_sign = None if observed_pr is None else (1 if observed_pr > 0 else -1 if observed_pr < 0 else 0)
        # Pre-registered-direction gate: the covariate-adjusted partial r must carry the declared sign.
        sign_passed = bool(expected_sign is not None and observed_sign is not None and observed_sign == expected_sign)

        actions: list[dict[str, Any]] = []
        if len(current_members) < config.max_panel_size:
            actions.append(
                {
                    "action": "add",
                    "slot": None,
                    "proposed_columns": [*current_columns, candidate_column],
                }
            )
        for index in range(len(current_members)):
            actions.append(
                {
                    "action": "replace",
                    "slot": index + 1,
                    "replaced_feature_name": current_members[index].get("feature_name"),
                    "proposed_columns": [
                        *[column for position, column in enumerate(current_columns) if position != index],
                        candidate_column,
                    ],
                }
            )
        if not actions:
            raise RuntimeError("No valid panel actions were generated")

        variation_reviews: list[dict[str, Any]] = []
        for action in actions:
            comparison = compare_predictive_panels(
                current_frame,
                outcome_column=primary_outcome,
                covariates=covariates,
                baseline_feature_columns=current_columns,
                candidate_feature_columns=action["proposed_columns"],
                config=config,
                baseline=baseline,
            )
            fields = predictive_result_fields(comparison)
            coverage_passed = coverage >= config.min_candidate_coverage
            eligible = bool(comparison["acceptance_passed"] and coverage_passed and sign_passed)
            fields.update(
                {
                    "feature_column": candidate_source_column,
                    "candidate_coverage": coverage,
                    "candidate_coverage_passed": coverage_passed,
                    "predictive_validation_passed": eligible,
                    "artifacts": {
                        **(base_results.get("artifacts") or {}),
                        # the sandbox path: valid wherever the run folder is moved
                        "donor_feature_table": f"/scratch/{TABLE_NAME}",
                    },
                }
            )
            evaluation = {
                **(worker_roundup.get("evaluation") or {}),
                "results": {**base_results, **fields},
                "summary": (
                    f"{candidate_source_column}: mean CV RMSE gain="
                    f"{comparison['mean_rmse_improvement']:.6f}, "
                    f"better in {comparison['fraction_repeats_better_rmse']:.0%} of repeats"
                ),
            }
            review = {
                **action,
                "variation": candidate_source_column,
                "is_primary": is_primary,
                "evaluation": evaluation,
                "candidate_panel_score": fields["panel_candidate_score"],
                "candidate_panel_rmse": fields["panel_candidate_rmse"],
                "baseline_panel_score": fields["panel_baseline_score"],
                "baseline_panel_rmse": fields["panel_baseline_rmse"],
                "mean_rmse_improvement": fields["mean_rmse_improvement"],
                "fraction_repeats_better_rmse": fields[
                    "fraction_repeats_better_rmse"
                ],
                "consensus_rmse_improvement": comparison.get("consensus_rmse_improvement"),
                "consensus_pearson_delta": comparison.get("consensus_pearson_delta"),
                "worst_leave_one_donor_rmse_improvement": comparison.get("worst_leave_one_donor_rmse_improvement"),
                "candidate_coverage": coverage,
                "acceptance_gates": {
                    **comparison["acceptance_gates"],
                    "candidate_coverage": coverage_passed,
                    "expected_sign": sign_passed,
                },
                "eligible": eligible,
            }
            action_reviews.append(review)
            variation_reviews.append(review)
            action_label = (
                action["action"]
                if action.get("slot") is None
                else f"{action['action']}_slot_{action['slot']}"
            )
            action_label = f"{candidate_source_column}:{action_label}"
            for row in comparison["per_repeat"]:
                repeat_rows.append(
                    {
                        "action": action_label,
                        "repeat": row["repeat"],
                        "baseline_rmse": row["baseline"]["rmse"],
                        "candidate_rmse": row["candidate"]["rmse"],
                        "rmse_improvement": row["rmse_improvement"],
                        "baseline_pearson_r": row["baseline"]["pearson_r"],
                        "candidate_pearson_r": row["candidate"]["pearson_r"],
                        "pearson_delta": row["pearson_delta"],
                    }
                )
            for row in comparison["donor_predictions"]:
                prediction_rows.append({"action": action_label, **row})
            for model_name in ("baseline", "candidate"):
                for row in comparison[f"{model_name}_tuning"]:
                    tuning_rows.append(
                        {"action": action_label, "model": model_name, **row}
                    )
            full_comparisons.append(
                {
                    "action": action_label,
                    "variation": candidate_source_column,
                    "is_primary": is_primary,
                    "slot": action.get("slot"),
                    "replaced_feature_name": action.get("replaced_feature_name"),
                    "candidate_coverage": coverage,
                    "eligible": eligible,
                    "comparison": _comparison_summary(comparison),
                }
            )
        best = min(variation_reviews, key=lambda r: float(r["candidate_panel_rmse"]))
        gates = dict(best["acceptance_gates"])
        cv_gate_names = list(gates)
        variation_summaries.append(
            {
                "variation": candidate_source_column,
                "is_primary": is_primary,
                "coverage": coverage,
                **influence,
                "best_action": best["action"] if best.get("slot") is None else f"{best['action']}_slot_{best['slot']}",
                "best_action_replaced_feature": best.get("replaced_feature_name"),
                "expected_sign": expected_sign,
                "observed_sign": observed_sign,
                "mean_rmse_improvement": best["mean_rmse_improvement"],
                "fraction_repeats_better_rmse": best["fraction_repeats_better_rmse"],
                "consensus_rmse_improvement": best.get("consensus_rmse_improvement"),
                "consensus_pearson_delta": best.get("consensus_pearson_delta"),
                "worst_leave_one_donor_rmse_improvement": best.get("worst_leave_one_donor_rmse_improvement"),
                "candidate_panel_rmse": best["candidate_panel_rmse"],
                "baseline_panel_rmse": best["baseline_panel_rmse"],
                "gates": gates,
                "cv_gates_passed": int(sum(1 for g in cv_gate_names if gates.get(g))),
                "cv_gates_total": len(cv_gate_names),
                "eligible": best["eligible"],
            }
        )
    candidate_source_column = primary_column
    if comparison is None:
        raise RuntimeError("No variation could be evaluated")
    # Measurement only (no instruction to the proposer): how redundant are the three variations?
    variation_correlations, near_duplicate_pairs, distinct_screened = _variation_redundancy(
        candidate_path, variation_columns
    )

    _write_csv(round_dir / "predictive_cv_repeat_metrics.csv", repeat_rows)
    _write_csv(round_dir / "predictive_cv_predictions.csv", prediction_rows)
    _write_csv(round_dir / "predictive_cv_tuning.csv", tuning_rows)
    review_artifact = round_dir / "predictive_cv_review.json"
    review_artifact.write_text(
        json.dumps(
            _json_safe({
                "config": comparison["config"],
                "primary_outcome": primary_outcome,
                "covariates": covariates,
                "primary_variation": primary_column,
                "screened_variations": len(variation_columns),
                "distinct_screened_variations": distinct_screened,
                "variation_correlations": variation_correlations,
                "near_duplicate_pairs": near_duplicate_pairs,
                "variations": variation_summaries,
                "candidate_table": str(candidate_path),
                "current_panel_size": len(current_members),
                "max_panel_size": config.max_panel_size,
                "panel_full": panel_full,
                "actions": full_comparisons,
            }),
            indent=2,
            allow_nan=False,
        )
        + "\n",
        encoding="utf-8",
    )

    eligible_reviews = [review for review in action_reviews if review["eligible"]]
    # Lowest CV RMSE across all variations x actions; ties favour the pre-specified primary.
    chosen = min(
        eligible_reviews or action_reviews,
        key=lambda review: (float(review["candidate_panel_rmse"]), not review.get("is_primary")),
    )
    improves_incumbent = float(chosen["candidate_panel_rmse"]) < float(chosen["baseline_panel_rmse"]) - EPSILON
    keep = bool(chosen["eligible"] and improves_incumbent)

    reason = "predictive_cv_improved" if keep else "predictive_cv_gates_failed"
    if not improves_incumbent:
        reason = "no_predictive_rmse_improvement"
    if keep and chosen.get("action") == "replace":
        reason = f"predictive_replace_slot_{chosen['slot']}"

    return {
        "decision": "keep" if keep else "discard",
        "reason": reason,
        "keep": keep,
        "chosen_review": chosen,
        "chosen_variation": chosen.get("variation"),
        "current_panel_size": len(current_members),
        "max_panel_size": config.max_panel_size,
        "panel_full": panel_full,
        "screened_variations": len(variation_columns),
        "distinct_screened_variations": distinct_screened,
        "variation_correlations": variation_correlations,
        "near_duplicate_pairs": near_duplicate_pairs,
        "variation_summaries": variation_summaries,
        "accepted_panel_score": (
            chosen["candidate_panel_score"]
            if keep
            else chosen["baseline_panel_score"]
        ),
        "accepted_panel_rmse": (
            chosen["candidate_panel_rmse"]
            if keep
            else chosen["baseline_panel_rmse"]
        ),
        "accepted_panel_delta": (
            chosen["candidate_panel_score"] - chosen["baseline_panel_score"]
            if keep
            else 0.0
        ),
    }
