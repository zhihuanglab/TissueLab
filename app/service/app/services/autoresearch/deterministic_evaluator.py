"""
Deterministic evaluator for worker artifacts.

This stage does not reinterpret the science with an LLM. It validates the
worker's canonical machine-readable outputs and derives comparable evidence
flags used by synthesis, journaling, and later held-out evaluation.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path
from typing import Any

import pandas as pd

from .shared_lib_source.shared_analysis.artifacts import (
    coerce_results_payload,
    resolve_covariate_names,
    validate_donor_feature_table_columns,
)
from .shared_lib_source.shared_analysis.sea_ad_lfb import DEFAULT_CONFOUNDS, load_training_cohort
from .shared_lib_source.shared_analysis.stats import (
    bootstrap_partial_correlation_stability,
    bootstrap_partial_correlation,
    leave_one_out_summary,
    multifeature_residualized_correlation,
    multifeature_loo_predictive_correlation,
    residualized_loo_predictive_correlation,
)


PYTHON = sys.executable
REPO_ROOT = Path(__file__).resolve().parents[3]
SHARED_LIB_SOURCE = REPO_ROOT / "app" / "services" / "autoresearch" / "shared_lib_source"
REPLAY_TIMEOUT_SEC = 300
DEFAULT_EVAL_COVARIATES = [*DEFAULT_CONFOUNDS, "sex"]
CANONICAL_SCORE_FUNCTION = "compute_donor_score"
_RESULT_PLACEHOLDERS = {"", "unknown", "unknown_feature", "unknown_column"}
MIN_ANALYZABLE_DONORS = 28
MIN_COVERAGE_RATIO = 0.80
MIN_BOOTSTRAP_SIGN_CONSISTENCY = 0.80
MIN_BOOTSTRAP_VALID_SAMPLES = 100


def _prefer_result_value(*values: Any) -> Any:
    for value in values:
        if value is None:
            continue
        if isinstance(value, str):
            stripped = value.strip()
            if stripped.lower() in _RESULT_PLACEHOLDERS:
                continue
            return stripped
        return value
    return None


def _best_ranked_variation(results: dict[str, Any]) -> dict[str, Any]:
    ranked = results.get("ranked_variations")
    if not isinstance(ranked, list) or not ranked:
        return {}
    best_name = str(results.get("best_variation") or "").strip()
    if best_name:
        for entry in ranked:
            if not isinstance(entry, dict):
                continue
            if str(entry.get("name") or "").strip() == best_name:
                return entry
    first = ranked[0]
    return first if isinstance(first, dict) else {}


def _uses_function_interface(script_text: str) -> bool:
    return re.search(r"\bdef\s+compute_donor_score\s*\(", script_text) is not None


def materialize_donor_table_via_script_interface(
    *,
    script_path: Path,
    data_dir: Path,
    shared_dir: Path,
    scratch_dir: Path,
    env: dict[str, str],
    timeout_sec: int,
) -> tuple[Path | None, dict[str, Any], list[str]]:
    if not script_path.exists():
        return None, {}, [f"missing result script for evaluator materialization: {script_path}"]

    helper_path = scratch_dir / "__materialize_donor_table.py"
    output_table_path = scratch_dir / "donor_feature_table.csv"
    metadata_path = scratch_dir / "__materialized_interface_metadata.json"
    helper_path.write_text(
        textwrap.dedent(
            """
            from __future__ import annotations

            import importlib.util
            import inspect
            import json
            import math
            import sys
            from pathlib import Path

            import pandas as pd

            from shared_analysis.sea_ad_lfb import load_training_cohort, slide_id_from_name


            def _load_cohort(data_root: Path) -> pd.DataFrame:
                training = data_root / "training_cohort.csv"
                test = data_root / "test_cohort.csv"
                if training.exists():
                    cohort = load_training_cohort(data_root)
                elif test.exists():
                    cohort = pd.read_csv(test)
                    if "slide_id" not in cohort.columns and "slide_name" in cohort.columns:
                        cohort["slide_id"] = cohort["slide_name"].map(slide_id_from_name)
                else:
                    cohort = load_training_cohort(data_root)
                if "donor_id" not in cohort.columns:
                    raise ValueError("cohort is missing donor_id")
                return cohort


            def _load_module(script_path: Path):
                spec = importlib.util.spec_from_file_location("worker_result_module", script_path)
                if spec is None or spec.loader is None:
                    raise RuntimeError(f"Could not import {script_path}")
                module = importlib.util.module_from_spec(spec)
                sys.modules[spec.name] = module
                spec.loader.exec_module(module)
                return module


            def _infer_feature_column(table: pd.DataFrame, requested: str) -> str:
                if requested and requested in table.columns:
                    return requested
                id_like = {"donor_id", "slide_name", "slide_id"}
                candidates = [str(col) for col in table.columns if str(col) not in id_like]
                if len(candidates) == 1:
                    return candidates[0]
                numeric_candidates = [
                    str(col)
                    for col in candidates
                    if pd.api.types.is_numeric_dtype(table[col])
                ]
                if len(numeric_candidates) == 1:
                    return numeric_candidates[0]
                return requested or "feature_value"


            def _call_compute_donor_score(module, row_dict, data_root, shared_root, scratch_root):
                func = module.compute_donor_score
                signature = inspect.signature(func)
                params = signature.parameters
                accepts_kwargs = any(
                    param.kind == inspect.Parameter.VAR_KEYWORD
                    for param in params.values()
                )

                keyword_args = {}
                if "donor_id" in params or accepts_kwargs:
                    keyword_args["donor_id"] = row_dict.get("donor_id")
                if "slide_name" in params or accepts_kwargs:
                    keyword_args["slide_name"] = row_dict.get("slide_name")
                if "data_root" in params or accepts_kwargs:
                    keyword_args["data_root"] = data_root
                if "shared_root" in params or accepts_kwargs:
                    keyword_args["shared_root"] = shared_root
                if "scratch_root" in params or accepts_kwargs:
                    keyword_args["scratch_root"] = scratch_root

                if "donor_id" in params or accepts_kwargs:
                    return func(**keyword_args)

                positional_args = [row_dict]
                if any(name in params for name in ("data_root", "shared_root", "scratch_root")) or accepts_kwargs:
                    return func(*positional_args, **keyword_args)
                return func(*positional_args)


            def main() -> int:
                script_path = Path(sys.argv[1])
                data_root = Path(sys.argv[2])
                shared_root = Path(sys.argv[3])
                scratch_root = Path(sys.argv[4])
                output_table = Path(sys.argv[5])
                metadata_path = Path(sys.argv[6])

                module = _load_module(script_path)
                cohort = _load_cohort(data_root)
                donor_to_slide = {}
                if "donor_id" in cohort.columns and "slide_name" in cohort.columns:
                    donor_to_slide = {
                        str(donor_id): str(slide_name)
                        for donor_id, slide_name in cohort.loc[:, ["donor_id", "slide_name"]]
                        .dropna()
                        .itertuples(index=False, name=None)
                    }
                if donor_to_slide and hasattr(module, "_slide_path_for_donor"):
                    def _cohort_slide_path_for_donor(*, donor_id: str, data_root: Path):
                        slide_name = donor_to_slide.get(str(donor_id))
                        if slide_name is None:
                            return None
                        return slide_name, (data_root / slide_name)
                    module._slide_path_for_donor = _cohort_slide_path_for_donor

                feature_name = str(getattr(module, "FEATURE_NAME", "") or script_path.stem).strip() or "candidate_biomarker"
                feature_column = str(getattr(module, "FEATURE_COLUMN", "") or "feature_value").strip() or "feature_value"

                if hasattr(module, "compute_donor_score"):
                    rows = []
                    for _, donor_row in cohort.iterrows():
                        row_dict = donor_row.to_dict()
                        donor_id = row_dict.get("donor_id")
                        slide_name = row_dict.get("slide_name")
                        value = _call_compute_donor_score(
                            module,
                            row_dict,
                            data_root,
                            shared_root,
                            scratch_root,
                        )
                        row = {
                            "donor_id": donor_id,
                            "slide_name": slide_name,
                            feature_column: value,
                        }
                        if isinstance(value, dict):
                            row.update(value)
                            row.setdefault("donor_id", donor_id)
                            row.setdefault("slide_name", slide_name)
                        rows.append(row)
                    table = pd.DataFrame(rows)
                else:
                    raise RuntimeError(
                        "result.py must define compute_donor_score(...)"
                    )

                if table.empty:
                    raise RuntimeError("result interface returned no donor rows")
                if "donor_id" not in table.columns and "slide_name" in table.columns and "slide_name" in cohort.columns:
                    donor_lookup = cohort.loc[:, ["donor_id", "slide_name"]].drop_duplicates()
                    table = table.merge(donor_lookup, on="slide_name", how="left")
                if "donor_id" not in table.columns:
                    raise RuntimeError("materialized donor table is missing donor_id")

                feature_column = _infer_feature_column(table, feature_column)
                if feature_column not in table.columns:
                    raise RuntimeError(
                        f"could not infer feature column from materialized donor table: {feature_column}"
                    )

                output_table.parent.mkdir(parents=True, exist_ok=True)
                table.to_csv(output_table, index=False)
                metadata_path.write_text(
                    json.dumps(
                        {
                            "feature_name": feature_name,
                            "feature_column": feature_column,
                        },
                        indent=2,
                    ),
                    encoding="utf-8",
                )
                return 0


            if __name__ == "__main__":
                raise SystemExit(main())
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )

    try:
        proc = subprocess.run(
            [
                PYTHON,
                str(helper_path),
                str(script_path),
                str(data_dir),
                str(shared_dir),
                str(scratch_dir),
                str(output_table_path),
                str(metadata_path),
            ],
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            env=env,
            cwd=str(scratch_dir),
        )
    except subprocess.TimeoutExpired:
        return None, {}, [f"materializing donor table timed out after {timeout_sec}s"]

    if proc.returncode != 0:
        stderr = (proc.stderr or proc.stdout or "").strip()
        if stderr:
            return None, {}, [f"failed to materialize donor table from result interface: {stderr[-800:]}"]
        return None, {}, ["failed to materialize donor table from result interface"]

    metadata = _load_optional_json(metadata_path) or {}
    if not output_table_path.exists():
        return None, metadata, ["result interface completed but no donor_feature_table.csv was written"]
    return output_table_path, metadata, []


def _load_json(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _load_optional_json(path: Path | None) -> dict[str, Any] | None:
    if path is None or not path.exists():
        return None
    try:
        return _load_json(path)
    except Exception:
        return None


def _default_feature_name(
    *,
    worker_brief: dict[str, Any],
) -> str:
    return str(
        worker_brief.get("candidate_id")
        or worker_brief.get("scientific_question")
        or worker_brief.get("worker_name")
        or "candidate_biomarker"
    ).strip()


def _prepare_eval_cohort(cohort: pd.DataFrame) -> pd.DataFrame:
    cohort = cohort.copy()
    if "sex_binary" not in cohort.columns and "sex" in cohort.columns:
        sex = cohort["sex"].astype(str).str.strip().str.lower()
        cohort["sex_binary"] = sex.map({"male": 1, "m": 1, "female": 0, "f": 0})
    return cohort


def _load_eval_cohort(data_dir: str | Path) -> pd.DataFrame:
    data_dir = Path(data_dir)
    training = data_dir / "training_cohort.csv"
    test = data_dir / "test_cohort.csv"
    if training.exists():
        cohort = load_training_cohort(data_dir)
    elif test.exists():
        cohort = pd.read_csv(test)
    else:
        cohort = load_training_cohort(data_dir)
    return _prepare_eval_cohort(cohort)


def _slugify(value: Any) -> str:
    text = re.sub(r"[^A-Za-z0-9]+", "_", str(value or "").strip().lower())
    return text.strip("_")


def _synthesize_minimal_results(
    *,
    raw_results: dict[str, Any] | None,
    worker_brief: dict[str, Any],
    primary_outcome: str | None,
    donor_feature_table_path: Path | None = None,
) -> dict[str, Any]:
    raw = dict(raw_results or {})
    results = coerce_results_payload(raw)
    metrics = raw.get("metrics") or {}
    best_variation = _best_ranked_variation(raw)
    feature_name = (
        _prefer_result_value(
            results.get("feature_name"),
            metrics.get("feature_name"),
            best_variation.get("feature_column"),
            best_variation.get("name"),
        )
        or _default_feature_name(
            worker_brief=worker_brief,
        )
    )
    feature_column = (
        _prefer_result_value(
            results.get("feature_column"),
            metrics.get("feature_column"),
            best_variation.get("feature_column"),
            results.get("feature_name"),
            metrics.get("feature_name"),
            best_variation.get("name"),
        )
        or "feature_value"
    )
    outcome = (
        results.get("outcome")
        or primary_outcome
        or worker_brief.get("target_outcome")
        or "slope_zmem0"
    )
    artifacts = dict(results.get("artifacts") or {})
    if donor_feature_table_path is not None:
        artifacts.setdefault("donor_feature_table", str(donor_feature_table_path))
    return {
        **results,
        "status": results.get("status") or "unknown",
        "feature_name": feature_name,
        "feature_column": feature_column,
        "outcome": outcome,
        "covariates": list(results.get("covariates") or DEFAULT_EVAL_COVARIATES),
        "artifacts": artifacts,
        "donor_ids_used": list(results.get("donor_ids_used") or []),
        "registry_written": bool(results.get("registry_written", False)),
        "recomputed_from_raw": bool(results.get("recomputed_from_raw", False)),
    }


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _as_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _ci_excludes_zero(ci_lo: Any, ci_hi: Any) -> bool:
    lo = _as_float(ci_lo)
    hi = _as_float(ci_hi)
    if lo is None or hi is None:
        return False
    return lo * hi > 0


def _coverage_ratio(n_analyzable: Any, n_total: Any) -> float | None:
    used = _as_float(n_analyzable)
    total = _as_float(n_total)
    if used is None or total is None or total <= 0:
        return None
    return max(0.0, min(1.0, used / total))


def _selection_score(partial_r: Any, n_analyzable: Any, n_total: Any) -> float | None:
    partial = _as_float(partial_r)
    coverage = _coverage_ratio(n_analyzable, n_total)
    if partial is None or coverage is None:
        return None
    return abs(partial) * coverage


def _coverage_gate_passed(n_analyzable: Any, n_total: Any) -> bool:
    used = _as_int(n_analyzable)
    total = _as_int(n_total)
    coverage = _coverage_ratio(n_analyzable, n_total)
    if used is None or total is None or coverage is None:
        return False
    return used >= MIN_ANALYZABLE_DONORS or coverage >= MIN_COVERAGE_RATIO


def _bootstrap_stability_gate_passed(sign_consistency: Any, valid_samples: Any) -> bool:
    sign = _as_float(sign_consistency)
    valid = _as_int(valid_samples)
    if sign is None or valid is None:
        return False
    return sign >= MIN_BOOTSTRAP_SIGN_CONSISTENCY and valid >= MIN_BOOTSTRAP_VALID_SAMPLES


def _copy_tree(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for path in source.rglob("*"):
        if path.is_dir() or path.name == "__pycache__":
            continue
        relative = path.relative_to(source)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def _safe_write_text(path: Path, text: str) -> None:
    try:
        path.write_text(text, encoding="utf-8")
    except OSError:
        pass


def _infer_evidence_tier(
    *,
    status: str,
    ci_excludes_zero: bool,
    loo_reported: bool,
    issues: list[str],
) -> str:
    if status in {"error", "failed"}:
        return "rejected"
    if status == "not_testable":
        return "not_testable"
    if issues:
        return "exploratory"
    if ci_excludes_zero and loo_reported:
        return "internally_validated"
    if ci_excludes_zero:
        return "screened"
    return "exploratory"


def _resolve_artifact_path(
    *,
    artifact_path: str | None,
    scratch_dir: Path,
    shared_dir: Path,
    worker_dir: Path | None = None,
) -> Path | None:
    if not artifact_path:
        return None
    path = Path(str(artifact_path))
    if path.is_absolute():
        if str(path).startswith("/scratch/"):
            return scratch_dir / path.relative_to("/scratch")
        if str(path).startswith("/shared/"):
            return shared_dir / path.relative_to("/shared")
        return path
    if worker_dir is not None:
        return worker_dir / path
    return scratch_dir / path


def _resolve_worker_artifact_path(worker_dir: Path, artifact_path: str | None) -> Path | None:
    return _resolve_artifact_path(
        artifact_path=artifact_path,
        scratch_dir=worker_dir / "sandbox",
        shared_dir=worker_dir.parent.parent / "shared",
        worker_dir=worker_dir,
    )


def _infer_feature_column(
    *,
    table: pd.DataFrame,
    requested_feature_column: str | None,
    outcome_column: str,
    covariates: list[str],
) -> str:
    requested = str(requested_feature_column or "").strip()
    if requested and requested in table.columns:
        return requested

    excluded = {"donor_id", "slide_name", outcome_column, *covariates}
    if "feature_value" in table.columns and "feature_value" not in excluded:
        return "feature_value"

    candidates = [str(col) for col in table.columns if str(col) not in excluded]
    if len(candidates) == 1:
        return candidates[0]

    numeric_candidates = [
        str(col)
        for col in candidates
        if pd.api.types.is_numeric_dtype(table[col])
    ]
    if len(numeric_candidates) == 1:
        return numeric_candidates[0]
    return requested


def _copy_shared_runtime(source_shared_dir: Path, destination_shared_dir: Path) -> None:
    destination_shared_dir.mkdir(parents=True, exist_ok=True)
    for name in ("cache", "lib", "templates"):
        source = source_shared_dir / name
        if source.exists():
            _copy_tree(source, destination_shared_dir / name)
    for path in source_shared_dir.iterdir():
        if path.is_file():
            shutil.copy2(path, destination_shared_dir / path.name)


def _seed_replay_context(
    worker_dir: Path,
    scratch_dir: Path,
) -> None:
    source_sandbox = worker_dir / "sandbox"
    for name in (
        "worker_brief.json",
        "program.md",
    ):
        source = source_sandbox / name
        if source.exists():
            shutil.copy2(source, scratch_dir / name)


def _load_worker_brief(worker_dir: Path) -> dict[str, Any]:
    source = worker_dir / "sandbox" / "worker_brief.json"
    return _load_optional_json(source) or {}


def _objective_metrics_from_table_path(
    *,
    donor_feature_table_path: Path,
    data_dir: str | Path | None,
    results: dict[str, Any],
) -> tuple[dict[str, Any] | None, list[str]]:
    issues: list[str] = []
    if not donor_feature_table_path.exists():
        return None, [f"donor_feature_table artifact not found: {donor_feature_table_path}"]

    try:
        table = pd.read_csv(donor_feature_table_path)
    except Exception as exc:
        return None, [f"failed to load donor_feature_table: {exc}"]

    metrics = results.get("metrics") or {}
    best_variation = _best_ranked_variation(results)
    feature_col = str(
        _prefer_result_value(
            results.get("feature_column"),
            metrics.get("feature_column"),
            best_variation.get("feature_column"),
            results.get("feature_name"),
            metrics.get("feature_name"),
            best_variation.get("name"),
        )
        or ""
    ).strip()
    outcome_col = str(
        _prefer_result_value(
            results.get("outcome"),
            results.get("outcome_column"),
            metrics.get("outcome"),
            metrics.get("outcome_column"),
        )
        or ""
    ).strip()
    confounds = list(
        results.get("covariates")
        or results.get("confound_columns")
        or metrics.get("covariates")
        or metrics.get("confound_columns")
        or []
    )

    if not feature_col:
        issues.append("missing feature column")
    elif feature_col not in table.columns:
        issues.append(f"feature column missing from donor_feature_table: {feature_col}")

    if data_dir is not None and (
        outcome_col not in table.columns or any(col not in table.columns for col in confounds)
    ):
        try:
            cohort = _load_eval_cohort(data_dir)
            join_cols = [col for col in ("donor_id", "slide_name") if col in table.columns and col in cohort.columns]
            enrich_confounds = resolve_covariate_names(cohort.columns, confounds)
            enrich_cols = [col for col in [outcome_col, *enrich_confounds] if col in cohort.columns]
            if join_cols and enrich_cols:
                cohort_subset = cohort.loc[:, [*join_cols, *enrich_cols]].drop_duplicates()
                table = table.merge(cohort_subset, on=join_cols, how="left", suffixes=("", "__cohort"))
        except Exception as exc:
            issues.append(f"failed to enrich donor_feature_table from cohort: {exc}")

    confounds = resolve_covariate_names(table.columns, confounds)
    feature_col = _infer_feature_column(
        table=table,
        requested_feature_column=feature_col,
        outcome_column=outcome_col,
        covariates=confounds,
    )

    issues.extend(
        validate_donor_feature_table_columns(
            table.columns,
            feature_column=feature_col,
            outcome_column=outcome_col,
            covariates=confounds,
        )
    )
    if issues:
        return None, issues

    columns = [feature_col, outcome_col, *confounds]
    id_col = "donor_id" if "donor_id" in table.columns else None
    if id_col:
        columns.append(id_col)
    analysis_frame = table.loc[:, columns].replace([float("inf"), float("-inf")], pd.NA).dropna().copy()
    if analysis_frame.empty:
        return None, ["no analyzable donor rows in donor_feature_table"]

    stats = bootstrap_partial_correlation(
        analysis_frame,
        feature_col=feature_col,
        outcome_col=outcome_col,
        confounds=confounds,
        n_boot=2000,
        random_state=0,
    )
    stability_boot = bootstrap_partial_correlation_stability(
        analysis_frame,
        feature_col=feature_col,
        outcome_col=outcome_col,
        confounds=confounds,
        n_boot=400,
        sample_frac=0.8,
        random_state=0,
    )
    raw_r = None
    raw_p = None
    raw_frame = table.loc[:, [feature_col, outcome_col]].replace([float("inf"), float("-inf")], pd.NA).dropna().copy()
    if len(raw_frame) >= 3:
        corr = raw_frame[feature_col].corr(raw_frame[outcome_col])
        if pd.notna(corr):
            raw_r = float(corr)

    loo = leave_one_out_summary(
        analysis_frame,
        feature_col=feature_col,
        outcome_col=outcome_col,
        confounds=confounds,
        id_col=id_col,
    )
    loo_predictive_r = residualized_loo_predictive_correlation(
        analysis_frame,
        feature_col=feature_col,
        outcome_col=outcome_col,
        confounds=confounds,
    )
    donor_ids_used = analysis_frame[id_col].astype(str).tolist() if id_col else []
    coverage_ratio = _coverage_ratio(len(analysis_frame), len(table))
    selection_score = _selection_score(stats.get("partial_r"), len(analysis_frame), len(table))
    coverage_gate_passed = _coverage_gate_passed(len(analysis_frame), len(table))
    bootstrap_stability_passed = _bootstrap_stability_gate_passed(
        stability_boot.get("bootstrap_sign_consistency"),
        stability_boot.get("bootstrap_valid_samples"),
    )
    incumbent_score = selection_score if coverage_gate_passed and bootstrap_stability_passed else None
    # Compute IS-LOO gap and adjusted score (mirrors agent_final1 evaluation policy).
    # partial_r is the in-sample statistic; loo_predictive_r is the LOO statistic.
    # gap > 0.30 → disqualified (adjusted = -1).
    # gap 0.15–0.30 → gap_penalty = (gap - 0.15) * 0.5.
    # gap ≤ 0.15 → no penalty.
    _is_r = abs(_as_float(stats.get("partial_r")) or 0.0)
    _loo_r = abs(_as_float(loo_predictive_r) or 0.0)
    _gap = _is_r - _loo_r
    if _gap > 0.30:
        _gap_penalty = _gap
        _adjusted = -1.0
    else:
        _gap_penalty = max(0.0, _gap - 0.15) * 0.5
        _adjusted = _loo_r - _gap_penalty

    metrics = {
        "feature_column": feature_col,
        "n_total": int(len(table)),
        "n_analyzable": int(len(analysis_frame)),
        "coverage_ratio": round(coverage_ratio, 4) if coverage_ratio is not None else None,
        "partial_r": _as_float(stats.get("partial_r")),
        "ci_lo": _as_float(stats.get("ci_lo")),
        "ci_hi": _as_float(stats.get("ci_hi")),
        "p_value": _as_float(stats.get("p_value")),
        "bootstrap_median_partial_r": _as_float(stability_boot.get("bootstrap_median_partial_r")),
        "bootstrap_q25_partial_r": _as_float(stability_boot.get("bootstrap_q25_partial_r")),
        "bootstrap_q75_partial_r": _as_float(stability_boot.get("bootstrap_q75_partial_r")),
        "bootstrap_sign_consistency": _as_float(stability_boot.get("bootstrap_sign_consistency")),
        "bootstrap_positive_fraction": _as_float(stability_boot.get("bootstrap_positive_fraction")),
        "bootstrap_negative_fraction": _as_float(stability_boot.get("bootstrap_negative_fraction")),
        "bootstrap_valid_samples": _as_int(stability_boot.get("bootstrap_valid_samples")),
        "bootstrap_sample_size": _as_int(stability_boot.get("bootstrap_sample_size")),
        "loo_predictive_r": _as_float(loo_predictive_r),
        "selection_score": round(selection_score, 4) if selection_score is not None else None,
        "incumbent_score": round(incumbent_score, 4) if incumbent_score is not None else None,
        "coverage_gate_passed": coverage_gate_passed,
        "bootstrap_stability_passed": bootstrap_stability_passed,
        "incumbent_eligible": bool(incumbent_score is not None),
        "is_loo_gap": round(_gap, 4),
        "gap_penalty": round(_gap_penalty, 4),
        "adjusted_score": round(_adjusted, 4),
        "loo_unstable_count": int(loo.get("unstable_count", 0)),
        "loo_max_shift": _as_float(loo.get("max_shift")),
        "donor_ids_used": donor_ids_used,
        "raw_r": raw_r,
        "raw_p_value": raw_p,
        "artifacts": {
            **(results.get("artifacts") or {}),
            "donor_feature_table": str(donor_feature_table_path),
        },
    }
    return metrics, []


def _objective_metrics_from_feature_table(
    *,
    worker_dir: Path,
    data_dir: str | Path | None,
    results: dict[str, Any],
) -> tuple[dict[str, Any] | None, list[str]]:
    artifacts = results.get("artifacts") or {}
    donor_feature_table_path = _resolve_worker_artifact_path(
        worker_dir,
        artifacts.get("donor_feature_table"),
    )
    if donor_feature_table_path is None:
        conventional = worker_dir / "sandbox" / "donor_feature_table.csv"
        donor_feature_table_path = conventional if conventional.exists() else None
    if donor_feature_table_path is None and data_dir is not None:
        result_script_path = worker_dir / "result.py"
        if result_script_path.exists():
            with tempfile.TemporaryDirectory(prefix="autoresearch_materialize_") as tmpdir:
                tmp_root = Path(tmpdir)
                tmp_shared = tmp_root / "shared"
                tmp_scratch = tmp_root / "scratch"
                tmp_shared.mkdir(parents=True, exist_ok=True)
                tmp_scratch.mkdir(parents=True, exist_ok=True)
                _seed_replay_context(worker_dir, tmp_scratch)
                try:
                    _copy_shared_runtime(worker_dir.parent.parent / "shared", tmp_shared)
                except Exception:
                    pass
                env = os.environ.copy()
                env["PYTHONPATH"] = os.pathsep.join(
                    [str(tmp_shared / "lib"), str(SHARED_LIB_SOURCE), env.get("PYTHONPATH", "")]
                )
                donor_feature_table_path, interface_metadata, materialize_issues = materialize_donor_table_via_script_interface(
                    script_path=result_script_path,
                    data_dir=Path(data_dir),
                    shared_dir=tmp_shared,
                    scratch_dir=tmp_scratch,
                    env=env,
                    timeout_sec=REPLAY_TIMEOUT_SEC,
                )
                if donor_feature_table_path is None:
                    return None, materialize_issues or ["missing donor_feature_table artifact"]
                results = {
                    **results,
                    **{k: v for k, v in interface_metadata.items() if v},
                    "artifacts": {
                        **artifacts,
                        "donor_feature_table": str(donor_feature_table_path),
                    },
                }
                return _objective_metrics_from_table_path(
                    donor_feature_table_path=donor_feature_table_path,
                    data_dir=data_dir,
                    results=results,
                )
    if donor_feature_table_path is None:
        return None, ["missing donor_feature_table artifact"]
    return _objective_metrics_from_table_path(
        donor_feature_table_path=donor_feature_table_path,
        data_dir=data_dir,
        results=results,
    )


def _load_panel_state_from_worker_brief(worker_brief: dict[str, Any]) -> dict[str, Any]:
    accepted_panel = worker_brief.get("accepted_panel")
    if isinstance(accepted_panel, dict):
        return {
            "members": list(accepted_panel.get("members") or []),
            "best_panel_score": accepted_panel.get("best_panel_score"),
        }
    panel_state = worker_brief.get("panel_state")
    return dict(panel_state or {}) if isinstance(panel_state, dict) else {}


def _panel_member_feature_frame(
    *,
    member: dict[str, Any],
    data_dir: str | Path,
    primary_outcome: str | None,
) -> tuple[pd.DataFrame | None, str | None]:
    worker_dir_value = member.get("worker_dir")
    if not worker_dir_value:
        return None, None
    worker_dir = Path(str(worker_dir_value))
    if not worker_dir.exists():
        return None, None
    results_path = member.get("results_path")
    evaluation = evaluate_worker_artifacts(
        worker_name=str(member.get("feature_name") or worker_dir.name),
        worker_dir=worker_dir,
        data_dir=data_dir,
        results_path=results_path,
        primary_outcome=primary_outcome,
        panel_state={},
    )
    results = evaluation.get("results", {}) or {}
    table_path_value = ((results.get("artifacts") or {}).get("donor_feature_table"))
    feature_column = str(results.get("feature_column") or "").strip()
    feature_name = str(results.get("feature_name") or "").strip()
    if not table_path_value or not feature_column:
        return None, None
    table_path = Path(str(table_path_value))
    if not table_path.exists():
        return None, None
    try:
        table = pd.read_csv(table_path)
    except Exception:
        return None, None
    if feature_column not in table.columns:
        return None, None
    join_cols = [col for col in ("donor_id", "slide_name") if col in table.columns]
    if not join_cols:
        return None, None
    column_name = _slugify(feature_name or feature_column) or feature_column
    frame = table.loc[:, [*join_cols, feature_column]].copy()
    frame = frame.rename(columns={feature_column: column_name})
    return frame, column_name


def _panel_score_from_feature_table(
    *,
    donor_feature_table_path: Path,
    data_dir: str | Path,
    results: dict[str, Any],
    panel_state: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if panel_state is None:
        return None
    try:
        candidate_table = pd.read_csv(donor_feature_table_path)
    except Exception:
        return None

    metrics = results.get("metrics") or {}
    best_variation = _best_ranked_variation(results)
    candidate_feature_col = str(
        _prefer_result_value(
            results.get("feature_column"),
            metrics.get("feature_column"),
            best_variation.get("feature_column"),
            results.get("feature_name"),
            metrics.get("feature_name"),
            best_variation.get("name"),
        )
        or ""
    ).strip()
    outcome_col = str(
        _prefer_result_value(
            results.get("outcome"),
            results.get("outcome_column"),
            metrics.get("outcome"),
            metrics.get("outcome_column"),
        )
        or ""
    ).strip()
    confounds = list(
        results.get("covariates")
        or results.get("confound_columns")
        or metrics.get("covariates")
        or metrics.get("confound_columns")
        or []
    )
    if not candidate_feature_col or candidate_feature_col not in candidate_table.columns:
        return None

    cohort = _load_eval_cohort(data_dir)
    join_cols = [col for col in ("donor_id", "slide_name") if col in candidate_table.columns and col in cohort.columns]
    if not join_cols:
        return None
    enrich_confounds = resolve_covariate_names(cohort.columns, confounds)
    enrich_cols = [col for col in [outcome_col, *enrich_confounds] if col in cohort.columns]
    merged = candidate_table.loc[:, [*join_cols, candidate_feature_col]].copy()
    if enrich_cols:
        cohort_subset = cohort.loc[:, [*join_cols, *enrich_cols]].drop_duplicates()
        merged = merged.merge(cohort_subset, on=join_cols, how="left", suffixes=("", "__cohort"))

    panel_feature_cols: list[str] = []
    for member in panel_state.get("members", []) or []:
        if not isinstance(member, dict) or str(member.get("status") or "active") != "active":
            continue
        frame, panel_col = _panel_member_feature_frame(
            member=member,
            data_dir=data_dir,
            primary_outcome=outcome_col or None,
        )
        if frame is None or not panel_col:
            continue
        try:
            merged = merged.merge(frame, on=join_cols, how="left", suffixes=("", "__panel"))
        except Exception:
            continue
        if panel_col in merged.columns:
            panel_feature_cols.append(panel_col)

    if outcome_col not in merged.columns:
        return None
    resolved_confounds = resolve_covariate_names(merged.columns, confounds)
    baseline_feature_cols = [col for col in panel_feature_cols if col in merged.columns]
    candidate_name = _slugify(str(results.get("feature_name") or candidate_feature_col)) or candidate_feature_col
    candidate_panel_col = candidate_name if candidate_name not in merged.columns else candidate_feature_col
    if candidate_panel_col != candidate_feature_col:
        merged = merged.rename(columns={candidate_feature_col: candidate_panel_col})
    full_feature_cols = [*baseline_feature_cols, candidate_panel_col]

    baseline_score = (
        multifeature_residualized_correlation(
            merged,
            feature_cols=baseline_feature_cols,
            outcome_col=outcome_col,
            confounds=resolved_confounds,
        )
        if baseline_feature_cols
        else float("nan")
    )
    candidate_score = multifeature_residualized_correlation(
        merged,
        feature_cols=full_feature_cols,
        outcome_col=outcome_col,
        confounds=resolved_confounds,
    )
    if not math.isfinite(candidate_score):
        return None

    baseline_loo_score = (
        multifeature_loo_predictive_correlation(
            merged,
            feature_cols=baseline_feature_cols,
            outcome_col=outcome_col,
            confounds=resolved_confounds,
        )
        if baseline_feature_cols
        else float("nan")
    )
    candidate_loo_score = multifeature_loo_predictive_correlation(
        merged,
        feature_cols=full_feature_cols,
        outcome_col=outcome_col,
        confounds=resolved_confounds,
    )

    redundancy = None
    if baseline_feature_cols:
        candidate_series = pd.to_numeric(merged[candidate_panel_col], errors="coerce")
        corrs: list[float] = []
        for col in baseline_feature_cols:
            pair = pd.DataFrame({"candidate": candidate_series, "panel": pd.to_numeric(merged[col], errors="coerce")}).dropna()
            if len(pair) < 3:
                continue
            corr = pair["candidate"].corr(pair["panel"])
            if pd.notna(corr):
                corrs.append(abs(float(corr)))
        if corrs:
            redundancy = max(corrs)

    delta = None
    if math.isfinite(baseline_score):
        delta = candidate_score - baseline_score
    return {
        "panel_member_count": len(baseline_feature_cols),
        "panel_baseline_score": None if not math.isfinite(baseline_score) else round(float(baseline_score), 4),
        "panel_candidate_score": round(float(candidate_score), 4),
        "delta_panel_score": None if delta is None else round(float(delta), 4),
        "panel_baseline_loo_score": None if not math.isfinite(baseline_loo_score) else round(float(baseline_loo_score), 4),
        "panel_candidate_loo_score": None if not math.isfinite(candidate_loo_score) else round(float(candidate_loo_score), 4),
        "candidate_redundancy": None if redundancy is None else round(float(redundancy), 4),
    }


def evaluate_worker_artifacts(
    *,
    worker_name: str,
    worker_dir: str | Path,
    data_dir: str | Path | None = None,
    results_path: str | Path | None,
    primary_outcome: str | None = None,
    panel_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    worker_dir = Path(worker_dir)
    worker_brief = _load_worker_brief(worker_dir)
    if panel_state is None:
        panel_state = _load_panel_state_from_worker_brief(worker_brief)

    resolved_results_path: Path | None = None
    if results_path:
        candidate = Path(results_path)
        if candidate.exists():
            resolved_results_path = candidate
    if resolved_results_path is None:
        direct_results = worker_dir / "results.json"
        if direct_results.exists():
            resolved_results_path = direct_results
    if resolved_results_path is None:
        sandbox_results = worker_dir / "sandbox" / "results.json"
        if sandbox_results.exists():
            resolved_results_path = sandbox_results
    conventional_table = worker_dir / "sandbox" / "donor_feature_table.csv"
    results = _synthesize_minimal_results(
        raw_results=_load_optional_json(resolved_results_path) or {},
        worker_brief=worker_brief,
        primary_outcome=primary_outcome,
        donor_feature_table_path=conventional_table if conventional_table.exists() else None,
    )

    issues: list[str] = []
    warnings: list[str] = []

    canonical_results = dict(results)

    objective_metrics, objective_issues = _objective_metrics_from_feature_table(
        worker_dir=worker_dir,
        data_dir=data_dir,
        results=results,
    )
    if objective_issues:
        warnings.extend(objective_issues)

    if objective_metrics:
        canonical_results.update(objective_metrics)
        canonical_results["recomputed_from_raw"] = True

    donor_feature_table_value = ((canonical_results.get("artifacts") or {}).get("donor_feature_table"))
    if data_dir is not None and donor_feature_table_value:
        panel_metrics = _panel_score_from_feature_table(
            donor_feature_table_path=Path(str(donor_feature_table_value)),
            data_dir=data_dir,
            results=canonical_results,
            panel_state=panel_state,
        )
        if panel_metrics:
            canonical_results.update(panel_metrics)

    status = str(canonical_results.get("status", "")).strip() or "unknown"
    partial_r = _as_float(canonical_results.get("partial_r"))
    p_value = _as_float(canonical_results.get("p_value"))
    ci_lo = _as_float(canonical_results.get("ci_lo"))
    ci_hi = _as_float(canonical_results.get("ci_hi"))
    loo_predictive_r = _as_float(canonical_results.get("loo_predictive_r"))
    selection_score = _as_float(canonical_results.get("selection_score"))
    incumbent_score = _as_float(canonical_results.get("incumbent_score"))
    panel_baseline_score = _as_float(canonical_results.get("panel_baseline_score"))
    panel_candidate_score = _as_float(canonical_results.get("panel_candidate_score"))
    delta_panel_score = _as_float(canonical_results.get("delta_panel_score"))
    candidate_redundancy = _as_float(canonical_results.get("candidate_redundancy"))
    coverage_ratio = _as_float(canonical_results.get("coverage_ratio"))
    bootstrap_sign_consistency = _as_float(canonical_results.get("bootstrap_sign_consistency"))
    bootstrap_median_partial_r = _as_float(canonical_results.get("bootstrap_median_partial_r"))
    incumbent_eligible = bool(canonical_results.get("incumbent_eligible", False))
    loo_unstable_count = _as_int(canonical_results.get("loo_unstable_count"))
    loo_max_shift = _as_float(canonical_results.get("loo_max_shift"))
    n_total = _as_int(canonical_results.get("n_total"))
    n_analyzable = _as_int(canonical_results.get("n_analyzable"))

    if status in {"ok", "null", "screened", "internally_validated", "adjudicated"} and partial_r is None:
        issues.append("missing or non-finite partial_r")
    if status in {"ok", "null", "screened", "internally_validated", "adjudicated"} and (ci_lo is None or ci_hi is None):
        issues.append("missing or non-finite ci bounds")
    if loo_unstable_count is None:
        issues.append("missing loo_unstable_count")
    if canonical_results.get("recomputed_from_raw") is not True:
        issues.append("result not marked recomputed_from_raw")

    ci_ok = _ci_excludes_zero(ci_lo, ci_hi)
    loo_reported = loo_unstable_count is not None and loo_max_shift is not None
    outcome_matches_primary = primary_outcome is None or canonical_results.get("outcome") == primary_outcome
    credible_candidate = (
        not issues
        and outcome_matches_primary
        and ci_ok
        and canonical_results.get("recomputed_from_raw") is True
        and partial_r is not None
    )
    if not incumbent_eligible:
        # Keep the single-feature diagnostics for auditability, but do not let
        # a low-support or unstable winner advance the panel on train fit alone.
        panel_candidate_score = None
        delta_panel_score = None
        candidate_redundancy = None
    evidence_tier = _infer_evidence_tier(
        status=status,
        ci_excludes_zero=ci_ok,
        loo_reported=loo_reported,
        issues=issues,
    )

    feature_name = str(canonical_results.get("feature_name") or "unknown_feature")
    feature_description = str(
        canonical_results.get("feature_description")
        or canonical_results.get("definition")
        or canonical_results.get("summary")
        or worker_brief.get("approach")
        or worker_brief.get("scientific_question")
        or worker_brief.get("candidate_id")
        or feature_name
    ).strip()
    partial_text = f"partial_r={partial_r:.3f}" if partial_r is not None else "partial_r=?"
    selection_text = f"selection={selection_score:.3f}" if selection_score is not None else "selection=?"
    incumbent_text = f"incumbent={incumbent_score:.3f}" if incumbent_score is not None else "incumbent=?"
    panel_text = (
        f"panel_delta={delta_panel_score:.3f} (base={panel_baseline_score:.3f}, full={panel_candidate_score:.3f})"
        if delta_panel_score is not None and panel_baseline_score is not None and panel_candidate_score is not None
        else "panel_delta=?"
    )
    ci_text = f"CI=[{ci_lo:.3f}, {ci_hi:.3f}]" if ci_lo is not None and ci_hi is not None else "CI=?"
    n_text = (
        f"n={n_analyzable}/{n_total}"
        if n_analyzable is not None and n_total is not None
        else "n=?"
    )
    summary = f"{feature_name}: {partial_text}, {selection_text}, {incumbent_text}, {panel_text}, {ci_text}, {n_text}, tier={evidence_tier}"
    rationale_parts = [
        feature_description,
        f"status={status}",
        "credible-candidate" if credible_candidate else "not-credible-yet",
    ]
    if coverage_ratio is not None:
        rationale_parts.append(f"coverage={coverage_ratio:.3f}")
    if bootstrap_sign_consistency is not None:
        rationale_parts.append(f"bootstrap_sign_consistency={bootstrap_sign_consistency:.3f}")
    if bootstrap_median_partial_r is not None:
        rationale_parts.append(f"bootstrap_median_partial_r={bootstrap_median_partial_r:.3f}")
    if candidate_redundancy is not None:
        rationale_parts.append(f"candidate_redundancy={candidate_redundancy:.3f}")
    if delta_panel_score is not None:
        rationale_parts.append(f"delta_panel_score={delta_panel_score:.3f}")
    rationale_parts.append("incumbent-eligible" if incumbent_eligible else "not-incumbent-eligible")
    if issues:
        rationale_parts.append("issues: " + "; ".join(issues))
    if warnings:
        rationale_parts.append("warnings: " + "; ".join(warnings))
    rationale = " | ".join(rationale_parts)

    derived = {
        "ci_excludes_zero": ci_ok,
        "loo_reported": loo_reported,
        "credible_candidate": credible_candidate,
        "leaderboard_eligible": incumbent_eligible,
        "coverage_gate_passed": bool(canonical_results.get("coverage_gate_passed", False)),
        "bootstrap_stability_passed": bool(canonical_results.get("bootstrap_stability_passed", False)),
        "incumbent_eligible": incumbent_eligible,
        "evidence_tier": evidence_tier,
        "outcome_matches_primary": outcome_matches_primary,
        "issues": issues,
        "warnings": warnings,
    }

    normalized_results = dict(canonical_results)
    normalized_results.update(
        {
            "partial_r": partial_r,
            "p_value": p_value,
            "ci_lo": ci_lo,
            "ci_hi": ci_hi,
            "loo_predictive_r": loo_predictive_r,
            "selection_score": selection_score,
            "incumbent_score": incumbent_score,
            "coverage_ratio": coverage_ratio,
            "bootstrap_sign_consistency": bootstrap_sign_consistency,
            "bootstrap_median_partial_r": bootstrap_median_partial_r,
            "loo_unstable_count": loo_unstable_count,
            "loo_max_shift": loo_max_shift,
            "n_total": n_total,
            "n_analyzable": n_analyzable,
            "incumbent_eligible": incumbent_eligible,
            "feature_column": canonical_results.get("feature_column"),
            "panel_baseline_score": panel_baseline_score,
            "panel_candidate_score": panel_candidate_score,
            "delta_panel_score": delta_panel_score,
            "candidate_redundancy": candidate_redundancy,
        }
    )

    return {
        "worker_name": worker_name,
        "results": normalized_results,
        "derived": derived,
        "summary": summary,
        "rationale": rationale,
    }
