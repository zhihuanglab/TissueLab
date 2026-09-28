"""Run an analysis script over the training cases and score it against ground truth.

The script is executed in a subprocess (one interpreter for all cases) so a
crash in generated code never takes the caller down; per-case exceptions are
captured individually.
"""
import json
import os
import subprocess
import sys
from typing import Any, Dict, Optional, Tuple

from .data import Cases, norm_label

EVAL_TIMEOUT = 1800

_RUNNER = r'''
import importlib.util, json, sys, traceback
code_path, cases_path, out_path, label_key = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("analysis_mod", code_path)
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
cases = json.load(open(cases_path))
out = {}
for case, jp in cases.items():
    try:
        res = mod.analyze_medical_image(jp)
        out[case] = {"pred": res.get(label_key) if isinstance(res, dict) else None, "details": res, "error": None}
    except Exception as e:
        out[case] = {"pred": None, "details": None,
                     "error": f"{type(e).__name__}: {e}\n" + traceback.format_exc()[-1500:]}
json.dump(out, open(out_path, "w"), default=str)
'''


def evaluate(code_path: str, cases: Cases, label_key: str, workdir: str,
             timeout: int = EVAL_TIMEOUT) -> Tuple[Dict[str, Dict[str, Any]], Optional[str]]:
    """Returns ({case: {pred, details, error}}, fatal_error_or_None)."""
    os.makedirs(workdir, exist_ok=True)
    cases_path = os.path.join(workdir, "cases_index.json")
    out_path = os.path.join(workdir, "predictions.json")
    runner = os.path.join(workdir, "_eval_runner.py")
    with open(cases_path, "w") as f:
        json.dump({c: cases.json[c] for c in cases.ids}, f)
    with open(runner, "w") as f:
        f.write(_RUNNER)
    try:
        r = subprocess.run([sys.executable, runner, code_path, cases_path, out_path, label_key],
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {}, f"evaluation timed out after {timeout}s"
    if r.returncode != 0 or not os.path.exists(out_path):
        return {}, (r.stderr or r.stdout)[-3000:]
    with open(out_path) as f:
        return json.load(f), None


def is_correct(results: Dict[str, Dict[str, Any]], cases: Cases, case: str) -> bool:
    r = results.get(case) or {}
    return not r.get("error") and norm_label(r.get("pred")) == norm_label(cases.gt[case])


def score(results: Dict[str, Dict[str, Any]], cases: Cases) -> Dict[str, Any]:
    errors = [c for c in cases.ids if not is_correct(results, cases, c)]
    crashed = [c for c in errors if (results.get(c) or {}).get("error")]
    n = len(cases)
    return {"n": n, "correct": n - len(errors), "accuracy": (n - len(errors)) / max(n, 1),
            "errors": errors, "crashed": crashed}


def compare(before: Dict[str, Dict[str, Any]], after: Dict[str, Dict[str, Any]], cases: Cases) -> Dict[str, Any]:
    """The acceptance criterion of the published runs: improved vs regressed cases."""
    improved = [c for c in cases.ids if not is_correct(before, cases, c) and is_correct(after, cases, c)]
    regressed = [c for c in cases.ids if is_correct(before, cases, c) and not is_correct(after, cases, c)]
    return {"improved": improved, "regressed": regressed,
            "correct_before": sum(is_correct(before, cases, c) for c in cases.ids),
            "correct_after": sum(is_correct(after, cases, c) for c in cases.ids)}
