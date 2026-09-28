from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd


RESULTS_REQUIRED_FIELDS = {
    "status",
    "feature_name",
    "outcome",
    "n_total",
    "n_analyzable",
    "partial_r",
    "ci_lo",
    "ci_hi",
    "p_value",
    "loo_predictive_r",
    "loo_unstable_count",
    "loo_max_shift",
    "donor_ids_used",
    "covariates",
    "recomputed_from_raw",
    "registry_written",
    "artifacts",
}

DEFAULT_RESULT_COVARIATES = [
    "max_age_vis",
    "braak_numeric",
    "cerad_ordinal",
    "sex",
]

_RESULT_PLACEHOLDERS = {
    "",
    "unknown",
    "unknown_feature",
    "unknown_column",
}


def validate_feature_spec(spec: dict[str, Any]) -> None:
    if not isinstance(spec, dict):
        raise ValueError("Feature spec must be a JSON object")


def write_feature_spec(path: str | Path, spec: dict[str, Any]) -> Path:
    validate_feature_spec(spec)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(spec, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    return path

_COVARIATE_ALIASES = {
    "sex": "sex_binary",
    "gender": "sex_binary",
    "braak": "braak_numeric",
    "braak_label": "braak_numeric",
    "cerad": "cerad_ordinal",
    "cerad_label": "cerad_ordinal",
}


def normalize_covariate_names(covariates: list[str] | tuple[str, ...] | None) -> list[str]:
    normalized: list[str] = []
    for covariate in covariates or []:
        if covariate is None:
            continue
        key = str(covariate).strip()
        if not key:
            continue
        candidate = _COVARIATE_ALIASES.get(key, key)
        if candidate not in normalized:
            normalized.append(candidate)
    return normalized


def resolve_covariate_names(columns: Any, covariates: list[str] | tuple[str, ...] | None) -> list[str]:
    available = {str(col) for col in columns}
    resolved: list[str] = []
    for covariate in normalize_covariate_names(covariates):
        if covariate in available:
            candidate = covariate
        else:
            aliases = [alias for alias, mapped in _COVARIATE_ALIASES.items() if mapped == covariate]
            candidate = next((alias for alias in aliases if alias in available), covariate)
        if candidate not in resolved:
            resolved.append(candidate)
    return resolved


def _best_ranked_variation(raw: dict[str, Any]) -> dict[str, Any]:
    ranked = raw.get("ranked_variations")
    if not isinstance(ranked, list) or not ranked:
        return {}
    best_name = str(raw.get("best_variation") or "").strip()
    if best_name:
        for entry in ranked:
            if not isinstance(entry, dict):
                continue
            if str(entry.get("name") or "").strip() == best_name:
                return entry
    first = ranked[0]
    return first if isinstance(first, dict) else {}


def _clean_result_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.lower() in _RESULT_PLACEHOLDERS:
            return None
        return stripped
    return value


def _coalesce_result_values(*values: Any) -> Any:
    for value in values:
        cleaned = _clean_result_value(value)
        if cleaned is not None:
            return cleaned
    return None


def coerce_results_payload(results: dict[str, Any]) -> dict[str, Any]:
    raw = dict(results or {})
    metrics = raw.get("metrics") or {}
    boot = metrics.get("boot") or {}
    loo_summary = metrics.get("loo_summary") or {}
    best_variation = _best_ranked_variation(raw)
    artifacts = dict(raw.get("artifacts") or {})

    if not artifacts:
        table_path = raw.get("table_path") or raw.get("input_table")
        if table_path:
            artifacts["donor_feature_table"] = table_path

    coerced = {
        "status": raw.get("status") or "unknown",
        "feature_name": (
            _coalesce_result_values(
                raw.get("feature_name"),
                metrics.get("feature_name"),
                raw.get("feature_column"),
                metrics.get("feature_column"),
                best_variation.get("feature_column"),
                best_variation.get("name"),
            )
            or "unknown_feature"
        ),
        "outcome": _coalesce_result_values(
            raw.get("outcome"),
            raw.get("outcome_column"),
            metrics.get("outcome"),
            metrics.get("outcome_column"),
        )
        or "",
        "n_total": raw.get("n_total"),
        "n_analyzable": (
            raw.get("n_analyzable", raw.get("analyzable_donor_count", boot.get("n")))
            if raw.get("n_analyzable", raw.get("analyzable_donor_count", boot.get("n"))) is not None
            else best_variation.get("n_analyzable")
        ),
        "partial_r": _coalesce_result_values(
            raw.get("partial_r"),
            boot.get("partial_r"),
            metrics.get("partial_r"),
            best_variation.get("partial_r"),
        ),
        "ci_lo": raw.get("ci_lo", boot.get("ci_lo")),
        "ci_hi": raw.get("ci_hi", boot.get("ci_hi")),
        "p_value": raw.get("p_value", boot.get("p_value")),
        "loo_predictive_r": _coalesce_result_values(
            raw.get("loo_predictive_r"),
            metrics.get("loo_predictive_r"),
            best_variation.get("loo_predictive_r"),
        ),
        "coverage_ratio": _coalesce_result_values(
            raw.get("coverage_ratio"),
            metrics.get("coverage_ratio"),
            best_variation.get("coverage_ratio"),
        ),
        "selection_score": _coalesce_result_values(
            raw.get("selection_score"),
            metrics.get("selection_score"),
            best_variation.get("selection_score"),
        ),
        "incumbent_score": _coalesce_result_values(
            raw.get("incumbent_score"),
            metrics.get("incumbent_score"),
            best_variation.get("incumbent_score"),
        ),
        "coverage_gate_passed": _coalesce_result_values(
            raw.get("coverage_gate_passed"),
            metrics.get("coverage_gate_passed"),
            best_variation.get("coverage_gate_passed"),
        ),
        "bootstrap_stability_passed": _coalesce_result_values(
            raw.get("bootstrap_stability_passed"),
            metrics.get("bootstrap_stability_passed"),
            best_variation.get("bootstrap_stability_passed"),
        ),
        "bootstrap_median_partial_r": _coalesce_result_values(
            raw.get("bootstrap_median_partial_r"),
            metrics.get("bootstrap_median_partial_r"),
            best_variation.get("bootstrap_median_partial_r"),
        ),
        "bootstrap_sign_consistency": _coalesce_result_values(
            raw.get("bootstrap_sign_consistency"),
            metrics.get("bootstrap_sign_consistency"),
            best_variation.get("bootstrap_sign_consistency"),
        ),
        "adjusted_score": _coalesce_result_values(
            raw.get("adjusted_score"),
            metrics.get("adjusted_score"),
            best_variation.get("adjusted_score"),
        ),
        "is_loo_gap": _coalesce_result_values(
            raw.get("is_loo_gap"),
            metrics.get("is_loo_gap"),
            best_variation.get("gap"),
        ),
        "gap_penalty": _coalesce_result_values(
            raw.get("gap_penalty"),
            metrics.get("gap_penalty"),
            best_variation.get("penalty"),
        ),
        "loo_unstable_count": raw.get("loo_unstable_count", loo_summary.get("unstable_count", 0)),
        "loo_max_shift": raw.get("loo_max_shift", loo_summary.get("max_shift")),
        "donor_ids_used": raw.get("donor_ids_used") or [],
        "covariates": normalize_covariate_names(
            raw.get("covariates")
            or raw.get("confound_columns")
            or metrics.get("covariates")
            or DEFAULT_RESULT_COVARIATES
        ),
        "recomputed_from_raw": bool(raw.get("recomputed_from_raw", False)),
        "registry_written": bool(raw.get("registry_written", False)),
        "artifacts": artifacts,
    }
    coerced.update(raw)
    coerced.update(
        {
            "status": coerced["status"],
            "feature_name": coerced["feature_name"],
            "outcome": coerced["outcome"],
            "n_total": coerced["n_total"],
            "n_analyzable": coerced["n_analyzable"],
            "partial_r": coerced["partial_r"],
            "ci_lo": coerced["ci_lo"],
            "ci_hi": coerced["ci_hi"],
            "p_value": coerced["p_value"],
            "loo_predictive_r": coerced["loo_predictive_r"],
            "coverage_ratio": coerced["coverage_ratio"],
            "selection_score": coerced["selection_score"],
            "incumbent_score": coerced["incumbent_score"],
            "coverage_gate_passed": coerced["coverage_gate_passed"],
            "bootstrap_stability_passed": coerced["bootstrap_stability_passed"],
            "bootstrap_median_partial_r": coerced["bootstrap_median_partial_r"],
            "bootstrap_sign_consistency": coerced["bootstrap_sign_consistency"],
            "adjusted_score": coerced["adjusted_score"],
            "is_loo_gap": coerced["is_loo_gap"],
            "gap_penalty": coerced["gap_penalty"],
            "loo_unstable_count": coerced["loo_unstable_count"],
            "loo_max_shift": coerced["loo_max_shift"],
            "donor_ids_used": coerced["donor_ids_used"],
            "covariates": coerced["covariates"],
            "recomputed_from_raw": coerced["recomputed_from_raw"],
            "registry_written": coerced["registry_written"],
            "artifacts": coerced["artifacts"],
        }
    )
    coerced["feature_column"] = (
        _coalesce_result_values(
            raw.get("feature_column"),
            metrics.get("feature_column"),
            best_variation.get("feature_column"),
            raw.get("feature_name"),
            metrics.get("feature_name"),
            best_variation.get("name"),
        )
        or coerced["feature_name"]
    )
    return coerced
def validate_results_payload(results: dict[str, Any]) -> None:
    missing = sorted(RESULTS_REQUIRED_FIELDS - set(results))
    if missing:
        raise ValueError(f"Results payload missing required fields: {', '.join(missing)}")
    donor_ids = results.get("donor_ids_used")
    if not isinstance(donor_ids, list):
        raise ValueError("Results payload requires donor_ids_used as a list")
    covariates = results.get("covariates")
    if not isinstance(covariates, list) or not covariates:
        raise ValueError("Results payload requires a non-empty covariates list")
    artifacts = results.get("artifacts")
    if not isinstance(artifacts, dict):
        raise ValueError("Results payload requires artifacts as an object")
    if not isinstance(results.get("recomputed_from_raw"), bool):
        raise ValueError("Results payload requires boolean recomputed_from_raw")
    if not isinstance(results.get("registry_written"), bool):
        raise ValueError("Results payload requires boolean registry_written")


def validate_donor_feature_table_columns(
    columns: Any,
    *,
    feature_column: str,
    outcome_column: str,
    covariates: list[str],
) -> list[str]:
    issues: list[str] = []
    available = {str(col) for col in columns}
    resolved_covariates = resolve_covariate_names(columns, covariates)
    if not feature_column:
        issues.append("missing feature column")
    elif feature_column not in available:
        issues.append(f"feature column missing from donor_feature_table: {feature_column}")
    if not outcome_column:
        issues.append("missing outcome column")
    elif outcome_column not in available:
        issues.append(f"outcome column missing from donor_feature_table: {outcome_column}")
    missing_confounds = [col for col in resolved_covariates if col not in available]
    if missing_confounds:
        issues.append("missing confound columns from donor_feature_table: " + ", ".join(missing_confounds))
    return issues


def write_donor_feature_table(
    path: str | Path,
    table: pd.DataFrame,
    *,
    feature_column: str,
    outcome_column: str,
    covariates: list[str],
    id_columns: list[str] | None = None,
    extra_columns: list[str] | None = None,
) -> Path:
    id_columns = id_columns or ["donor_id", "slide_name"]
    extra_columns = extra_columns or []
    resolved_covariates = resolve_covariate_names(table.columns, covariates)
    issues = validate_donor_feature_table_columns(
        table.columns,
        feature_column=feature_column,
        outcome_column=outcome_column,
        covariates=resolved_covariates,
    )
    if issues:
        raise ValueError("; ".join(issues))

    ordered_cols: list[str] = []
    for col in [*id_columns, feature_column, outcome_column, *resolved_covariates, *extra_columns]:
        if col in table.columns and col not in ordered_cols:
            ordered_cols.append(col)

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    table.loc[:, ordered_cols].to_csv(path, index=False)
    return path
def write_results_payload(path: str | Path, results: dict[str, Any]) -> Path:
    validate_results_payload(results)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(results, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    return path


def build_results_payload(
    *,
    status: str,
    feature_name: str,
    outcome: str,
    n_total: int | float | None,
    n_analyzable: int | float | None,
    partial_r: float | None,
    ci_lo: float | None,
    ci_hi: float | None,
    p_value: float | None,
    loo_predictive_r: float | None = None,
    loo_unstable_count: int = 0,
    loo_max_shift: float | None = None,
    donor_ids_used: list[str] | None = None,
    covariates: list[str] | None = None,
    recomputed_from_raw: bool = True,
    registry_written: bool = False,
    artifacts: dict[str, Any] | None = None,
    **extras: Any,
) -> dict[str, Any]:
    results = {
        "status": status,
        "feature_name": feature_name,
        "outcome": outcome,
        "n_total": n_total,
        "n_analyzable": n_analyzable,
        "partial_r": partial_r,
        "ci_lo": ci_lo,
        "ci_hi": ci_hi,
        "p_value": p_value,
        "loo_predictive_r": loo_predictive_r,
        "loo_unstable_count": loo_unstable_count,
        "loo_max_shift": loo_max_shift,
        "donor_ids_used": donor_ids_used or [],
        "covariates": covariates or [],
        "recomputed_from_raw": recomputed_from_raw,
        "registry_written": registry_written,
        "artifacts": artifacts or {},
    }
    results.update(extras)
    return results
