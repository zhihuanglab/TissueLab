"""Descriptive candidate ranking; no donor-level inference or predictive claims."""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


def _anchor(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def describe(values: pd.Series, ids: list[str], variation: dict[str, Any]) -> dict[str, Any]:
    numeric = pd.to_numeric(values, errors="coerce").replace([np.inf, -np.inf], np.nan)
    valid = numeric.dropna()
    indexed = dict(zip(ids, (float(v) if pd.notna(v) else None for v in numeric)))
    q25, q75 = (float(valid.quantile(q)) for q in (.25, .75)) if len(valid) else (None, None)
    spread = q75 - q25 if q25 is not None else None
    if spread is not None and not math.isfinite(spread):
        spread = None
    try:
        reference = float(variation.get("reference_scale"))
    except (ValueError, TypeError):
        reference = None
    if reference is not None and (not math.isfinite(reference) or reference <= 0):
        reference = None
    method, contrast, score = "unscaled", None, None
    if spread is not None:
        if reference is not None:
            method = "declared_reference_scale"
            contrast = spread / reference
            # Stable saturation even when magnitudes are very large.
            score = 1.0 - 1.0 / (1.0 + contrast)
        elif str(variation.get("measurement_scale", "")).lower() == "ratio" and valid.min() >= 0:
            method = "relative_interquartile_dispersion"
            score = (1 - q25 / q75) / (1 + q25 / q75) if q75 else 0.0
    return {
        "donor_values": indexed, "n_donors": len(numeric),
        "ranking_basis": "observed_cohort_dispersion",
        "units": str(variation.get("units") or "unspecified"),
        "measurement_scale": str(variation.get("measurement_scale") or "unspecified"),
        "reference_scale": reference, "normalization": method,
        "normalized_contrast": contrast if contrast is None or math.isfinite(contrast) else None,
        "candidate_score": score, "coverage": len(valid) / len(numeric) if len(numeric) else 0.0,
        "n_observed": len(valid), "median": float(valid.median()) if len(valid) else None,
        "q25": q25, "q75": q75, "iqr": spread,
        "min": float(valid.min()) if len(valid) else None,
        "max": float(valid.max()) if len(valid) else None,
        "tissue_stability": "not_assessed",
    }


def review_descriptive(*, spec, panel_frame, current_columns, current_members,
                       candidate_path, variation_columns, primary_column, worker_brief,
                       worker_roundup, round_dir, config):
    # Imported lazily to avoid a judge <-> descriptive initialization cycle.
    from .judge import _load_feature_frame, _slug

    ids = panel_frame["donor_id"].astype(str).tolist()
    definitions = {v['name']: v for v in worker_brief.get('variations', [])}
    anchor = str(worker_brief.get('biological_anchor') or worker_brief.get('approach') or '').strip()
    member_scores = [float(m.get('candidate_score') or 0.0) for m in current_members]
    baseline = float(sum(member_scores))
    actions, summaries = [], []
    for source in variation_columns:
        column = f"candidate__{_slug(source)}"
        frame = panel_frame.merge(_load_feature_frame(candidate_path, source, column),
                                 on="donor_id", how="left", validate="one_to_one")
        summary = describe(frame[column], ids, definitions.get(source, {}))
        summary.update(variation=source, is_primary=source == primary_column)
        score = summary['candidate_score']
        duplicates = set()
        for i, (member, existing_column) in enumerate(zip(current_members, current_columns)):
            if _anchor(anchor) and _anchor(anchor) == _anchor(member.get('biological_anchor')):
                duplicates.add(i)
            elif member.get('descriptive_summary', {}).get('units') == summary['units']:
                old = pd.to_numeric(frame[existing_column], errors='coerce').to_numpy(dtype=float)
                new = pd.to_numeric(frame[column], errors='coerce').to_numpy(dtype=float)
                if np.allclose(old, new, rtol=1e-9, atol=0, equal_nan=True):
                    duplicates.add(i)
        gates = {
            "coverage": summary['coverage'] >= config.min_candidate_coverage,
            "cohort_variation_present": summary['iqr'] is not None and summary['iqr'] > 0,
            "scorable_nonzero_dispersion": score is not None and score > 0,
            "biological_anchor": bool(anchor),
        }
        options = []
        if len(current_members) < config.max_panel_size:
            options.append(("add", None))
        options.extend(("replace", i) for i in range(len(current_members)))
        for action, index in options:
            nonredundant = not (duplicates - ({index} if index is not None else set()))
            proposed = baseline + (score or 0) - (member_scores[index] if index is not None else 0)
            action_gates = {**gates, "nonredundant": nonredundant, "score_improved": proposed > baseline + 1e-12}
            eligible = all(action_gates.values())
            results = {
                **(worker_roundup.get('results') or {}),
                "evaluation_mode": "descriptive", "feature_column": source,
                "candidate_score": score, "descriptive_summary": summary,
                "biological_anchor": anchor,
                "panel_baseline_score": baseline, "panel_candidate_score": proposed,
                "delta_panel_score": proposed - baseline,
                "panel_baseline_rmse": None, "panel_candidate_rmse": None,
                "predictive_validation_passed": False, "descriptive_eligibility_passed": eligible,
            }
            actions.append({
                "action": action, "slot": index + 1 if index is not None else None,
                "variation": source, "is_primary": source == primary_column,
                "candidate_panel_score": proposed, "candidate_panel_rmse": None,
                "baseline_panel_score": baseline, "baseline_panel_rmse": None,
                "eligible": eligible, "acceptance_gates": action_gates,
                "evaluation": {"results": results,
                               "summary": f"{source}: cohort IQR={summary['iqr']}; descriptive dispersion score={score}"},
            })
        relevant = [a for a in actions if a['variation'] == source]
        best = max(relevant, key=lambda a: (a['eligible'], a['candidate_panel_score'])) if relevant else None
        summary.update(eligible=bool(best and best['eligible']), gates=best['acceptance_gates'] if best else gates,
                       best_action=best['action'] if best else None,
                       redundant_with=[current_members[i].get('feature_name') for i in sorted(duplicates)])
        summaries.append(summary)
    chosen = max(actions, key=lambda a: (a['eligible'], a['candidate_panel_score'], a['is_primary'], a['action'] == 'replace'), default=None)
    keep = bool(chosen and chosen['eligible'])
    review = {
        "evaluation_mode": "descriptive", "evaluation_reason": spec.evaluation_reason,
        "decision": "keep" if keep else "discard", "keep": keep,
        "reason": "descriptive_shortlist_improved" if keep else "descriptive_eligibility_failed",
        "chosen_review": chosen, "chosen_variation": chosen['variation'] if chosen else None,
        "n_donors": len(ids), "ranking_basis": "observed_cohort_dispersion",
        "current_panel_size": len(current_members), "max_panel_size": config.max_panel_size,
        "panel_full": len(current_members) >= config.max_panel_size,
        "screened_variations": len(summaries), "variation_summaries": summaries,
        "accepted_panel_score": chosen['candidate_panel_score'] if keep else baseline,
        "accepted_panel_rmse": None,
        "accepted_panel_delta": chosen['candidate_panel_score'] - baseline if keep else 0.0,
    }
    Path(round_dir, 'descriptive_review.json').write_text(json.dumps(review, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    return review


def findings_descriptive(panel, spec, run_root=None):
    from .judge import _write_csv
    members = sorted(panel.get('members') or [], key=lambda m: (-float(m.get('candidate_score') or 0), str(m.get('feature_column'))))
    lines = ["Evaluation: descriptive candidate biomarker discovery",
             f"Clinical context: {spec.outcome or 'not specified'}",
             f"Selection: {spec.evaluation_reason}",
             f"Accepted exploratory candidates: {len(members)}",
             "Candidates are shortlisted by observed dispersion across the cohort, not disease association, significance, or predictive performance.",
             "Covariates are documented, not adjusted. Tissue stability has not been assessed.", "",
             "| Rank | Candidate | Observed donors | Median | IQR | Units | Search score |",
             "| --- | --- | --- | --- | --- | --- | --- |"]
    rows = []
    for rank, member in enumerate(members, 1):
        summary = member.get('descriptive_summary') or {}
        name = str(member.get('feature_column') or member.get('feature_name') or '')
        rows.append({"rank": rank, "candidate": name, "biological_anchor": member.get('biological_anchor'),
                     **{k: v for k, v in summary.items() if not isinstance(v, (dict, list))},
                     **{f'donor:{donor}': value for donor, value in summary.get('donor_values', {}).items()},
                     "implementation": member.get('score_path') or member.get('result_path'), "donor_table": member.get('donor_feature_table'),
                     "description": member.get('description')})
        def fmt(key):
            value = summary.get(key)
            return f"{value:.6g}" if isinstance(value, (float, int)) else 'NA'
        lines.append(f"| {rank} | {name.replace('|', '/')} | {fmt('n_observed')} | {fmt('median')} | {fmt('iqr')} | {str(summary.get('units', '')).replace('|', '/')} | {fmt('candidate_score')} |")
    if not members:
        lines.append("\nNo candidate met descriptive eligibility rules; this is not evidence of absent biological signal.")
    # Computed measurements remain useful even when no candidate is admitted.
    if run_root is not None:
        root = Path(run_root)
        reviews = sorted(root.glob('round_*/**/descriptive_review.json'))
        if reviews:
            latest_round = reviews[-1].relative_to(root).parts[0]
            lines.extend(['', 'Measured candidates — latest evaluated round (including unaccepted candidates)', '',
                          '| Candidate | Observed donors | Median | IQR | Eligibility |',
                          '| --- | --- | --- | --- | --- |'])
            for path in reviews:
                if path.relative_to(root).parts[0] != latest_round:
                    continue
                review = json.loads(path.read_text(encoding='utf-8'))
                for s in review.get('variation_summaries') or []:
                    def stat(key):
                        value = s.get(key)
                        return f'{value:.6g}' if isinstance(value, (int, float)) else 'NA'
                    failed = [key for key, passed in (s.get('gates') or {}).items() if not passed]
                    status = 'eligible' if s.get('eligible') else ', '.join(failed) or 'not admitted'
                    name = str(s.get('variation') or '').replace('|', '/')
                    lines.append(f"| {name} | {stat('n_observed')} | {stat('median')} | {stat('iqr')} | {status} |")
        failed_workers = []
        for path in sorted(root.glob('round_*/**/results.json')):
            result = json.loads(path.read_text(encoding='utf-8'))
            if result.get('status') != 'failed':
                continue
            checks = result.get('controller_checks') or {}
            coverage = checks.get('primary_coverage')
            failed = [key for key, value in checks.items() if value is False]
            label = str(result.get('feature_column') or result.get('feature_name') or path.parent.name).replace('|', '/')
            coverage_text = f'{coverage:.0%}' if isinstance(coverage, (int, float)) else 'NA'
            failed_workers.append(f"| {label} | {coverage_text} | {', '.join(failed) or 'worker failed'} |")
        if failed_workers:
            lines.extend(['', 'Incomplete feature computations — excluded before candidate evaluation', '',
                          '| Candidate | Donor coverage | Failed checks |',
                          '| --- | --- | --- |', *failed_workers])
    lines.append("\nThe search reused the same donors. Independent biological replication is required; no donor-level significance or prediction is established.")
    if run_root is not None:
        root = Path(run_root)
        if rows:
            _write_csv(root / 'ranked_biomarker_panel.csv', rows)
        else:
            (root / 'ranked_biomarker_panel.csv').write_text('rank,candidate,n_donors,n_observed,median,iqr,units,candidate_score,implementation\n', encoding='utf-8')
    return '\n'.join(lines) + '\n'
