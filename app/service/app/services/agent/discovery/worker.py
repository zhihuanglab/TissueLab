"""The worker: one candidate, one deliverable (result.py), then the controller's checks.

Contract (prompts/worker.md):
  * The worker's only job is to write /scratch/result.py defining
        compute_donor_features(donor_id, data_root) -> {variation_name: float | nan}
    run it once on all donors, and reply DONE.
  * The controller (this module) then, inside the same sandbox, imports result.py
    and calls it for every cohort donor -> /scratch/donor_feature_table.csv, and
    checks: import works, planned columns present, no duplicate donors, primary
    coverage >= 80%, no mention of the outcome or covariates in the code or the
    shell commands, and the problem's class rules. results.json is written from
    the plan.

Guards: per-command timeout floor, a rewrite cap with a nudge, a hard turn cap,
and materialization even when the conversation died (a usable result.py still
yields a round). Outcomes never enter the sandbox: the cohort file is shadowed
by an identifier-only copy.
"""

from __future__ import annotations

import json
import re
import shutil
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Optional

import pandas as pd

from .client import custom_tool_call_output, custom_tool_calls, output_text, response_id, responses_create
from .panel_cv import PredictivePanelConfig
from .problem import ProblemSpec, write_public_cohort
from .sandbox import SandboxSession
from .tools import SHELL_TOOL_NAME, SHELL_TOOL_SPEC, bounded_tool_text, is_done, load_prompt

RESULT_NAME = "result.py"
TABLE_NAME = "donor_feature_table.csv"
RESULTS_NAME = "results.json"
MATERIALIZE_SCRIPT = ".tl_materialize.py"
MATERIALIZE_REPORT = "materialize_report.json"

MIN_COVERAGE = PredictivePanelConfig.min_candidate_coverage   # the judge gates on it too
MAX_REWRITES = 4
MAX_TURNS = 40
MIN_COMMAND_TIMEOUT = 120
MATERIALIZE_TIMEOUT = 1800


class ControllerChecksFailed(RuntimeError):
    """The worker's result.py ran but failed the controller's checks — a verdict, not a crash."""


def _kickoff_message(plan: dict[str, Any]) -> str:
    names = [v.get("name", "") for v in plan.get("variations", [])]
    return (
        "Your task: implement the plan in /scratch/plan.json.\n"
        "Write /scratch/result.py that defines\n"
        "    compute_donor_features(donor_id, data_root) -> dict\n"
        f"returning exactly these keys: {names} (float, or float('nan') when not analyzable).\n"
        "Use the shared loaders in shared_analysis.slides (see /shared/data_intuition.md for "
        "the classes, regions and spacings in these slides).\n"
        "Run it once on every donor (cd /scratch && python result.py) to confirm it works "
        "and prints per-donor values. Then reply with the single word DONE.\n"
        "Do not write any other deliverable; the controller builds the donor table and "
        "all metadata from your script."
    )


def _materialize_script(plan: dict[str, Any]) -> str:
    names = [v.get("name", "") for v in plan.get("variations", [])]
    return f'''
import json, math, os, sys, traceback
_shared = os.environ.get("TL_SHARED_ROOT") or "/shared"
for _p in (os.path.join(_shared, "lib"), "/scratch"):
    if _p not in sys.path:
        sys.path.insert(0, _p)
import pandas as pd
from shared_analysis.slides import donor_ids
names = {json.dumps(names)}
report = {{"status": "ok", "errors": {{}}, "rows": 0, "coverage": {{}}, "import_error": None}}
try:
    import importlib.util
    spec = importlib.util.spec_from_file_location("result", "/scratch/result.py")
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    fn = getattr(mod, "compute_donor_features", None)
    if fn is None:
        raise AttributeError("result.py does not define compute_donor_features")
except Exception as exc:
    report["status"] = "import_failed"; report["import_error"] = "".join(traceback.format_exception(exc))[-3000:]
    json.dump(report, open("/scratch/{MATERIALIZE_REPORT}", "w"), indent=1); sys.exit(0)
rows = []
for donor_id in donor_ids("/data"):
    rec = {{"donor_id": donor_id}}
    try:
        out = fn(donor_id, "/data")
        if out is None: out = {{}}
        if not isinstance(out, dict):
            raise TypeError(f"compute_donor_features returned {{type(out).__name__}}, expected dict")
        for k in names:
            v = out.get(k, float("nan"))
            try:
                v = float(v)
            except Exception:
                v = float("nan")
            rec[k] = v if math.isfinite(v) else float("nan")
        extra = sorted(set(out) - set(names))
        if extra: report.setdefault("extra_keys", sorted(set(report.get("extra_keys", [])) | set(extra)))
    except Exception as exc:
        report["errors"][donor_id] = "".join(traceback.format_exception(exc))[-1500:]
        for k in names: rec[k] = float("nan")
    rows.append(rec)
    print(donor_id, {{k: rec[k] for k in names}}, flush=True)
table = pd.DataFrame(rows, columns=["donor_id"] + names)
table.to_csv("/scratch/{TABLE_NAME}", index=False)
report["rows"] = int(len(table))
for k in names:
    report["coverage"][k] = float(table[k].notna().mean()) if len(table) else 0.0
report["n_errors"] = len(report["errors"])
json.dump(report, open("/scratch/{MATERIALIZE_REPORT}", "w"), indent=1)
print("MATERIALIZED", report["rows"], report["coverage"])
'''


def _worker_scripts(scratch_dir: Path) -> list[Path]:
    """Python files the worker wrote in /scratch (result.py and any helper it imports)."""
    return sorted(p for p in scratch_dir.glob("*.py") if not p.name.startswith("."))


def class_rule_violations(scripts: list[Path], spec: ProblemSpec) -> list[str]:
    """Lines that break the problem's class rules.

    * an excluded class may not appear as a string literal at all (outside comments);
    * an exclude-only class may not be selected: `== 'X'`, `.eq('X')`, `isin([... 'X' ...])`;
    * when any rule is set, numeric class_id selection is rejected: classes are selected
      by cell_type name, since ids differ per classifier.
    """
    if not (spec.excluded_classes or spec.exclude_only_classes):
        return []

    def literal(name: str) -> str:
        return r"""['"]""" + re.escape(name) + r"""['"]"""

    excluded = [re.compile(literal(n)) for n in spec.excluded_classes]
    selected = [
        re.compile(r"""(==\s*|\.eq\(\s*|\.isin\([^)]*)""" + literal(n)) for n in spec.exclude_only_classes
    ] + [re.compile(literal(n) + r"""\s*==""") for n in spec.exclude_only_classes]
    cid_select = re.compile(r"""class_id['"\]]*\s*(==|\.eq\(|\.isin\()""")
    hits: list[str] = []
    for path in scripts:
        for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            code = line.split("#", 1)[0]
            stripped = code.strip()
            if not stripped:
                continue
            if any(p.search(code) for p in excluded) or any(p.search(code) for p in selected):
                hits.append(f"{path.name}:{lineno}: {stripped[:160]}")
            elif cid_select.search(code):
                hits.append(f"{path.name}:{lineno}: {stripped[:160]} (numeric class_id selection)")
    return hits


def outcome_references(worker_dir: Path, scripts: list[Path], names: list[str]) -> list[str]:
    """Lines in the worker's scripts or shell commands naming the outcome or a covariate."""
    names = [n for n in names if n]
    if not names:
        return []
    pattern = re.compile(r"\b(" + "|".join(re.escape(n) for n in names) + r")\b")
    hits: list[str] = []
    for path in [*scripts, *sorted(worker_dir.glob("turn_*.command.sh"))]:
        for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if pattern.search(line):
                hits.append(f"{path.name}:{lineno}: {line.strip()[:160]}")
    return hits


def run_worker(
    *,
    worker_brief: dict[str, Any],
    round_dir: str | Path,
    spec: ProblemSpec,
    data_dir: str | Path,
    shared_dir: str | Path,
    model: str,
    reasoning_effort: str = "high",
    worker_wall_clock_sec: int = 1800,
    command_timeout_sec: int = 900,
    on_event: Optional[Callable[[dict[str, Any]], None]] = None,
    cancel_event: Optional[threading.Event] = None,
) -> dict[str, Any]:
    """Run one worker. Raises if no usable result.py was produced or the checks fail."""
    round_dir = Path(round_dir)
    worker_name = worker_brief["worker_name"]
    worker_dir = round_dir / worker_name
    worker_dir.mkdir(parents=True, exist_ok=True)
    scratch_dir = worker_dir / "sandbox"
    if scratch_dir.exists():
        shutil.rmtree(scratch_dir, ignore_errors=True)
    (scratch_dir / "logs").mkdir(parents=True, exist_ok=True)

    plan = {
        k: worker_brief.get(k)
        for k in ("candidate_id", "scientific_question", "approach", "variations", "baseline_variation", "notes", "rationale")
    }
    (scratch_dir / "plan.json").write_text(json.dumps(plan, indent=2), encoding="utf-8")

    def emit(event: dict[str, Any]) -> None:
        if on_event:
            try:
                on_event(event)
            except Exception:
                pass

    instructions = load_prompt("worker.md", spec) + "\n\n# Research question\n" + spec.question
    public_cohort = write_public_cohort(spec, data_dir, worker_dir / "cohort_public.csv")
    session = SandboxSession(
        scratch_dir, data_dir=data_dir, shared_dir=shared_dir, command_timeout_sec=command_timeout_sec,
        file_overlays={f"/data/{spec.cohort_file}": public_cohort},
    )
    state: dict[str, Any] = {"turns": 0, "rewrites": 0, "error": None}
    result_path_sb = scratch_dir / RESULT_NAME
    deadline = time.monotonic() + max(120, int(worker_wall_clock_sec))
    previous_response: Optional[str] = None
    pending_input: Any = _kickoff_message(plan)
    last_mtime = 0.0
    nudged = False
    done = False

    stop_cancel_watch = session.watch_cancel(cancel_event)
    try:
        session.start()
        try:
            for turn_id in range(1, MAX_TURNS + 1):
                if cancel_event is not None and cancel_event.is_set():
                    raise RuntimeError(f"{worker_name} cancelled")
                remaining = deadline - time.monotonic()
                if remaining < 60:
                    state["error"] = "wall clock exhausted"
                    break
                payload = {
                    "model": model,
                    "instructions": instructions,
                    "input": pending_input,
                    "tools": [SHELL_TOOL_SPEC],
                    "parallel_tool_calls": False,
                    "store": True,
                    "reasoning": {"effort": reasoning_effort, "summary": "auto"},
                }
                if previous_response:
                    payload["previous_response_id"] = previous_response
                prefix = worker_dir / f"turn_{turn_id:02d}"
                response = responses_create(payload, timeout=int(min(1800, max(120, remaining))))
                prefix.with_suffix(".response.json").write_text(json.dumps(response, indent=2, default=str), encoding="utf-8")
                previous_response = response_id(response)
                state["turns"] = turn_id
                text = output_text(response)
                calls = custom_tool_calls(response, SHELL_TOOL_NAME)
                if not calls:
                    if is_done(text):
                        done = True
                        break
                    pending_input = (
                        "Use the shell_exec tool to continue (write/run /scratch/result.py), "
                        "or reply exactly DONE if result.py is finished and ran successfully."
                    )
                    continue
                tool_outputs = []
                for call in calls:
                    command = str(call.get("input") or "")
                    prefix.with_suffix(".command.sh").write_text(command + "\n", encoding="utf-8")
                    remaining = deadline - time.monotonic()
                    timeout = int(min(command_timeout_sec, max(MIN_COMMAND_TIMEOUT, remaining)))
                    emit({"type": "worker_tool_call", "worker_name": worker_name, "turn_id": turn_id,
                          "tool_name": SHELL_TOOL_NAME, "command_preview": command[:120]})
                    result = session.exec(command, timeout_sec=timeout)
                    (scratch_dir / "logs" / f"turn_{turn_id:02d}.stdout.txt").write_text(str(result.get("stdout") or ""), encoding="utf-8")
                    (scratch_dir / "logs" / f"turn_{turn_id:02d}.stderr.txt").write_text(str(result.get("stderr") or ""), encoding="utf-8")
                    emit({"type": "worker_tool_result", "worker_name": worker_name, "turn_id": turn_id,
                          "tool_name": SHELL_TOOL_NAME, "exit_code": result.get("exit_code")})
                    note = ""
                    if result_path_sb.exists():
                        mt = result_path_sb.stat().st_mtime
                        if mt != last_mtime:
                            if last_mtime:
                                state["rewrites"] += 1
                            last_mtime = mt
                    if state["rewrites"] >= MAX_REWRITES and not nudged:
                        nudged = True
                        note = (
                            f"CONTROLLER NOTE: result.py has been rewritten {state['rewrites']} times. "
                            "Stop refactoring. If the last run succeeded, reply DONE now; otherwise fix "
                            "only the specific error and run once more."
                        )
                    payload_out = {
                        "exit_code": result.get("exit_code"),
                        "stdout": bounded_tool_text(result.get("stdout"), 6000),
                        "stderr": bounded_tool_text(result.get("stderr"), 3000),
                        "full_stdout": f"/scratch/logs/turn_{turn_id:02d}.stdout.txt",
                        "full_stderr": f"/scratch/logs/turn_{turn_id:02d}.stderr.txt",
                    }
                    if note:
                        payload_out["controller_note"] = note
                    tool_outputs.append(custom_tool_call_output(str(call.get("call_id", "")), payload_out))
                pending_input = tool_outputs
            else:
                state["error"] = f"turn cap {MAX_TURNS} reached"
        except Exception as exc:  # conversation died; fall through to materialization
            if cancel_event is not None and cancel_event.is_set():
                raise
            state["error"] = f"{type(exc).__name__}: {exc}"
            (worker_dir / "worker_failure.json").write_text(
                json.dumps({"error": str(exc), "traceback": traceback.format_exc()}, indent=2), encoding="utf-8"
            )

        if not result_path_sb.exists():
            raise RuntimeError(f"{worker_name}: no result.py produced ({state.get('error') or 'worker ended without writing it'})")
        # ---- controller materialization (whether the conversation ended in DONE or not)
        (scratch_dir / MATERIALIZE_SCRIPT).write_text(_materialize_script(plan), encoding="utf-8")
        emit({"type": "worker_materialize", "worker_name": worker_name})
        mat = session.exec(f"cd /scratch && python {MATERIALIZE_SCRIPT}", timeout_sec=max(command_timeout_sec, MATERIALIZE_TIMEOUT))
        (worker_dir / "materialize.exec.json").write_text(json.dumps(mat, indent=2, default=str), encoding="utf-8")
    finally:
        stop_cancel_watch()
        session.stop()

    report_path_sb = scratch_dir / MATERIALIZE_REPORT
    mreport = (
        json.loads(report_path_sb.read_text(encoding="utf-8"))
        if report_path_sb.exists()
        else {"status": "no_report", "coverage": {}, "errors": {}}
    )
    primary = str(plan.get("baseline_variation") or (plan.get("variations") or [{}])[0].get("name") or "")
    names = [v.get("name", "") for v in plan.get("variations", [])]
    table_sb = scratch_dir / TABLE_NAME
    checks: dict[str, Any] = {
        "result_py_exists": True,
        "import_ok": mreport.get("status") == "ok",
        "table_written": table_sb.exists(),
        "planned_columns_present": False,
        "no_duplicate_donors": False,
        "primary_coverage": float((mreport.get("coverage") or {}).get(primary, 0.0) or 0.0),
        "primary_coverage_ok": False,
        "donor_errors": int(mreport.get("n_errors", len(mreport.get("errors", {})))),
    }
    if table_sb.exists():
        table = pd.read_csv(table_sb, dtype={"donor_id": str})
        checks["planned_columns_present"] = all(n in table.columns for n in names) and "donor_id" in table.columns
        checks["no_duplicate_donors"] = bool("donor_id" in table.columns and not table["donor_id"].duplicated().any())
        checks["primary_coverage_ok"] = checks["primary_coverage"] >= MIN_COVERAGE
    # Leak audit: worker code and shell commands must never name the outcome or covariates.
    scripts = _worker_scripts(scratch_dir)
    refs = outcome_references(worker_dir, scripts, spec.protected_names)
    checks["outcome_reference_free"] = not refs
    checks["outcome_references"] = refs
    violations = class_rule_violations(scripts, spec)
    checks["class_rules_ok"] = not violations
    checks["class_rule_violations"] = violations
    passed = all(
        checks[key]
        for key in ("import_ok", "table_written", "planned_columns_present", "no_duplicate_donors",
                    "primary_coverage_ok", "outcome_reference_free", "class_rules_ok")
    )

    result_path = worker_dir / RESULT_NAME
    shutil.copy2(result_path_sb, result_path)
    results_path = worker_dir / RESULTS_NAME
    results_payload = {
        "status": "ok" if passed else "failed",
        "feature_name": plan.get("candidate_id") or primary,
        "feature_column": primary,
        "outcome": spec.outcome,
        "covariates": list(spec.covariates),
        "artifacts": {"donor_feature_table": f"/scratch/{TABLE_NAME}"},
        "controller_checks": checks,
        "materialize_report": {k: v for k, v in mreport.items() if k != "errors"},
        "worker_state": {"turns": state["turns"], "rewrites": state["rewrites"], "error": state["error"], "done_said": done},
    }
    results_path.write_text(json.dumps(results_payload, indent=2), encoding="utf-8")
    summary = (
        f"{'OK' if passed else 'FAILED CHECKS'}: primary={primary} coverage={checks['primary_coverage']:.2f} "
        f"turns={state['turns']} rewrites={state['rewrites']} done_said={done} errors={checks['donor_errors']}"
        + ("" if checks["class_rules_ok"] else f" CLASS_RULE={[h.split(': ', 1)[1][:60] for h in violations][:2]}")
        + ("" if checks["outcome_reference_free"] else " OUTCOME_REFERENCE")
    )
    if not passed:
        raise ControllerChecksFailed(f"{worker_name}: controller checks failed -> {summary}")
    return {
        "worker_name": worker_name,
        "worker_dir": str(worker_dir),
        "results_path": str(results_path),
        "result_path": str(result_path),
        "summary": summary,
        "results": results_payload,
        "controller_checks": checks,
    }
