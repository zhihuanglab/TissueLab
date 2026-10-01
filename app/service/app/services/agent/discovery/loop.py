"""The discovery loop.

Before round 1 the dataset scout (optional) explores the folder and writes a
dataset guide. Each round:
1. the proposer (one model call per worker) commits to a hypothesis with a
   primary formula and pre-specified variations, each with an expected sign;
   with several workers the plans are asked in turn so that they differ;
2. the workers, in parallel sandboxes, write result.py; the controller runs each
   over every donor and checks coverage and outcome references;
3. the judge scores every variation against the accepted panel with paired
   repeated nested CV (add while a slot is free, else replace a member) plus the
   expected-sign and coverage gates; at most one candidate per round is admitted;
4. structured feedback on every variation goes back to the next proposer.

State lives in the run folder: run_state.json, accepted_panel.json, results.tsv,
round_NNNN/ (plans, proposer and worker traces, judge CSVs, feedback), and
research_findings.md at the end. run_state.json's "guide" records that the scout
wrote shared/dataset_guide.md (or it was copied from an earlier run): workers
can write /shared too, so the file alone is not trusted.
"""

from __future__ import annotations

import asyncio
import csv
import json
import shutil
import threading
import traceback
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Awaitable, Callable, Optional

from .client import discovery_model, pin_run_client
from .scout import GUIDE_NAME, run_scout
from .judge import review_candidate
from .panel_cv import PredictivePanelConfig
from .problem import ProblemSpec, write_dataset_layout
from .proposer import run_proposer
from .worker import ControllerChecksFailed, run_worker

DEFAULT_WORKER_WALL_CLOCK = 1800
WORKER_COMMAND_TIMEOUT = 900
MAX_WORKERS_PER_ROUND = 5
RESULTS_TSV_NAME = "results.tsv"
ACCEPTED_PANEL_NAME = "accepted_panel.json"
ROUND_FEEDBACK_NAME = "round_feedback.json"
FINDINGS_NAME = "research_findings.md"
SHARED_LIB_SOURCE = Path(__file__).parent / "shared_lib_source" / "shared_analysis"

RESULTS_HEADERS = [
    "round_id",
    "worker",
    "candidate_id",
    "feature_name",
    "chosen_variation",
    "status",
    "decision",
    "review_action",
    "review_slot",
    "accepted_panel_score",
    "baseline_panel_score",
    "candidate_panel_score",
    "accepted_panel_delta",
    "delta_panel_score",
    "partial_r",
    "accepted_panel_rmse",
    "candidate_panel_rmse",
    "mean_rmse_improvement",
    "fraction_repeats_better_rmse",
    "description",
    "artifact_dir",
    "error",
]


# ── files ─────────────────────────────────────────────────────────────────────

def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(text)
        tmp_path = Path(handle.name)
    tmp_path.replace(path)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    _write_text_atomic(path, json.dumps(payload, indent=2, default=str) + "\n")


def copy_tree(source: Path, destination: Path) -> None:
    """Copy source files (never bytecode caches) into destination."""
    destination.mkdir(parents=True, exist_ok=True)
    for path in source.rglob("*"):
        if path.is_dir() or "__pycache__" in path.parts:
            continue
        target = destination / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def _load_or_init_state(*, run_root: Path, config: dict[str, Any]) -> dict[str, Any]:
    path = run_root / "run_state.json"
    if path.exists():
        raw = _read_json(path)
        return {"next_round_id": int(raw.get("next_round_id", 1) or 1), "config": dict(raw.get("config") or config),
                "guide": guide_recorded(raw, run_root)}
    state = {"next_round_id": 1, "config": config, "guide": False}
    _write_json(path, state)
    return state


def _load_or_init_accepted_panel(run_root: Path) -> dict[str, Any]:
    path = run_root / ACCEPTED_PANEL_NAME
    if path.exists():
        payload = _read_json(path)
        for key in ("best_panel_score", "best_panel_rmse"):
            payload.setdefault(key, None)
        payload.setdefault("members", [])
        return payload
    payload = {"best_panel_score": None, "best_panel_rmse": None, "members": []}
    _write_json(path, payload)
    return payload


def guide_recorded(state: dict[str, Any], run_root: Path) -> bool:
    """Whether shared/dataset_guide.md came from the run's scout (or a reused guide).
    Runs from before the "guide" flag only ever had their scout write it."""
    if "guide" in state:
        return bool(state["guide"])
    return (run_root / "shared" / GUIDE_NAME).is_file()


def read_run_state(run_root: Path) -> dict[str, Any]:
    """run_state.json: {"next_round_id", "config", "guide"}; {} when the run never started."""
    path = run_root / "run_state.json"
    return _read_json(path) if path.exists() else {}


def load_results_rows(run_root: Path) -> list[dict[str, Any]]:
    path = run_root / RESULTS_TSV_NAME
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle, delimiter="\t"))


def _append_results_row(run_root: Path, row: dict[str, Any]) -> None:
    rows = load_results_rows(run_root)
    rows.append({key: row.get(key, "") for key in RESULTS_HEADERS})
    with NamedTemporaryFile("w", encoding="utf-8", newline="", dir=run_root, delete=False) as handle:
        writer = csv.DictWriter(handle, fieldnames=RESULTS_HEADERS, delimiter="\t")
        writer.writeheader()
        writer.writerows(rows)
        tmp_path = Path(handle.name)
    tmp_path.replace(run_root / RESULTS_TSV_NAME)


# ── feedback for the proposer ─────────────────────────────────────────────────

def _fmt(value: Any, digits: int = 3) -> str:
    try:
        if value is None:
            return "NA"
        return f"{float(value):+.{digits}f}" if abs(float(value)) < 1e3 else f"{float(value):.3g}"
    except (TypeError, ValueError):
        return str(value)


def _safe_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def build_round_feedback(
    *, round_id: int, plan: dict[str, Any], worker_status: str, decision: str, reason: str,
    review: dict[str, Any], worker_summary: str = "",
) -> dict[str, Any]:
    """Structured, outcome-aggregate feedback: every variation's coverage, covariate-adjusted
    partial r (+ LOO range, top-donor influence), each CV gate, and the decision. No per-donor
    outcome values are included."""
    variations = []
    for v in review.get("variation_summaries") or []:
        gates = v.get("gates") or {}
        variations.append(
            {
                "name": v.get("variation"),
                "is_primary": bool(v.get("is_primary")),
                "coverage": v.get("coverage"),
                "tested_as": v.get("best_action"),
                "replaced_feature": v.get("best_action_replaced_feature"),
                "expected_sign": v.get("expected_sign"),
                "observed_sign": v.get("observed_sign"),
                "partial_r": v.get("partial_r"),
                "partial_r_loo_range": [v.get("partial_r_loo_min"), v.get("partial_r_loo_max")],
                "top_influence_donor": v.get("top_influence_donor"),
                "top_influence_share": v.get("top_influence_share"),
                "mean_rmse_improvement": v.get("mean_rmse_improvement"),
                "fraction_repeats_better_rmse": v.get("fraction_repeats_better_rmse"),
                "consensus_pearson_delta": v.get("consensus_pearson_delta"),
                "worst_leave_one_donor_rmse_improvement": v.get("worst_leave_one_donor_rmse_improvement"),
                "gates": gates,
                "gates_passed": f"{v.get('cv_gates_passed')}/{v.get('cv_gates_total')}",
                "eligible": bool(v.get("eligible")),
                "near_miss": bool(
                    not v.get("eligible")
                    and v.get("cv_gates_total")
                    and int(v.get("cv_gates_passed") or 0) >= int(v.get("cv_gates_total")) - 1
                ),
            }
        )
    return {
        "round_id": round_id,
        "candidate_id": plan.get("candidate_id", ""),
        "scientific_question": plan.get("scientific_question", ""),
        "approach": str(plan.get("approach", ""))[:600],
        "worker_status": worker_status,
        "worker_summary": worker_summary,
        "decision": decision,
        "reason": reason,
        "chosen_variation": review.get("chosen_variation"),
        "panel_size_before": review.get("current_panel_size"),
        "max_panel_size": review.get("max_panel_size"),
        "panel_full": bool(review.get("panel_full")),
        "screened_variations": review.get("screened_variations") or len(variations),
        "distinct_screened_variations": review.get("distinct_screened_variations"),
        "variation_correlations": review.get("variation_correlations") or {},
        "near_duplicate_pairs": review.get("near_duplicate_pairs") or [],
        "variations": variations,
        "near_miss_variations": [v["name"] for v in variations if v["near_miss"]],
    }


def render_feedback_text(fb: dict[str, Any]) -> str:
    lines = [
        f"round={fb.get('round_id')} candidate={fb.get('candidate_id')} decision={fb.get('decision')} "
        f"reason={fb.get('reason')} worker_status={fb.get('worker_status')}"
        + (f" admitted_variation={fb['chosen_variation']}" if fb.get("decision") == "keep" else ""),
        f"  question: {fb.get('scientific_question', '')}",
    ]
    if fb.get("panel_full"):
        lines.append(
            f"  PANEL FULL ({fb.get('panel_size_before')}/{fb.get('max_panel_size')}): no add test was possible this round; "
            "each variation below was tested only as a one-for-one swap against the named member (a harder test than adding)."
        )
    for v in fb.get("variations") or []:
        g = v.get("gates") or {}
        fails = [k for k, ok in g.items() if ok is False]
        tested = v.get("tested_as") or "add"
        if v.get("replaced_feature"):
            tested += f" ({v['replaced_feature']})"
        sign_note = ""
        if v.get("expected_sign") is None:
            sign_note = " sign=UNDECLARED(ineligible)"
        elif v.get("observed_sign") is not None and v.get("observed_sign") != v.get("expected_sign"):
            sign_note = f" sign=UNEXPECTED_DIRECTION(expected {v['expected_sign']:+d}, observed {v['observed_sign']:+d}; ineligible)"
        lines.append(
            f"  - {v.get('name')}{' (primary)' if v.get('is_primary') else ''}: tested_as={tested}{sign_note} coverage={_fmt(v.get('coverage'), 2)} "
            f"partial_r={_fmt(v.get('partial_r'))} LOO_range=[{_fmt((v.get('partial_r_loo_range') or [None, None])[0])},"
            f"{_fmt((v.get('partial_r_loo_range') or [None, None])[1])}] top_donor_share={_fmt(v.get('top_influence_share'), 2)} "
            f"| CV: dRMSE={_fmt(v.get('mean_rmse_improvement'), 5)} repeats_better={_fmt(v.get('fraction_repeats_better_rmse'), 2)} "
            f"consensus_dr={_fmt(v.get('consensus_pearson_delta'))} worst_LODO={_fmt(v.get('worst_leave_one_donor_rmse_improvement'), 5)} "
            f"gates={v.get('gates_passed')} "
            f"failed={fails or 'none'} eligible={v.get('eligible')}{' NEAR_MISS' if v.get('near_miss') else ''}"
        )
    if not fb.get("variations"):
        summary = str(fb.get("worker_summary") or "")[:200]
        lines.append(f"  (no variation results: {fb.get('reason')}{(' — ' + summary) if summary else ''})")
    corr = fb.get("variation_correlations") or {}
    if corr:
        lines.append("  variation_correlations: " + ", ".join(f"{k}={_fmt(v, 2)}" for k, v in corr.items())
                     + f" (distinct={fb.get('distinct_screened_variations')} of {fb.get('screened_variations')})")
    return "\n".join(lines)


def load_feedback_history(run_root: Path) -> str:
    """Structured feedback for every prior round."""
    lines: list[str] = []
    for row in load_results_rows(run_root):
        fb_path = feedback_path(run_root / f"round_{int(row.get('round_id') or 0):04d}", row.get("worker"))
        if fb_path.exists():
            try:
                lines.append(render_feedback_text(_read_json(fb_path)))
                continue
            except (OSError, json.JSONDecodeError, ValueError):
                pass
        lines.append(
            f"round={row.get('round_id', '')} candidate={row.get('candidate_id', '')} "
            f"status={row.get('status', '')} decision={row.get('decision', '')} error={row.get('error', '')}"
        )
    return "\n".join(lines)


# ── panel ─────────────────────────────────────────────────────────────────────

def accepted_panel_summary(accepted_panel: dict[str, Any]) -> dict[str, Any]:
    members = [
        {
            "slot": idx,
            "feature_name": member.get("feature_name"),
            "feature_column": member.get("feature_column"),
            "round_id": member.get("round_id"),
            "panel_candidate_score": member.get("panel_candidate_score"),
            "panel_candidate_rmse": member.get("panel_candidate_rmse"),
        }
        for idx, member in enumerate(accepted_panel.get("members") or [], start=1)
        if isinstance(member, dict)
    ]
    return {
        "best_panel_score": accepted_panel.get("best_panel_score"),
        "best_panel_rmse": accepted_panel.get("best_panel_rmse"),
        "member_count": len(members),
        "members": members,
    }


def _build_worker_brief(
    *, round_id: int, plan: dict[str, Any], accepted_panel: dict[str, Any], slot: int = 1, workers: int = 1,
) -> dict[str, Any]:
    return {
        "worker_name": f"round_{round_id:04d}_worker" + (f"_{slot}" if workers > 1 else ""),
        "round_id": round_id,
        "candidate_id": plan.get("candidate_id", ""),
        "accepted_panel": {
            "members": accepted_panel.get("members", []),
            "best_panel_score": accepted_panel.get("best_panel_score"),
        },
        "scientific_question": plan.get("scientific_question", ""),
        "approach": plan.get("approach", ""),
        "variations": plan.get("variations", []),
        "baseline_variation": plan.get("baseline_variation", ""),
        "notes": plan.get("notes", ""),
        "rationale": plan.get("rationale", ""),
    }


def _panel_member_record(*, round_id: int, plan: dict[str, Any], worker_roundup: dict[str, Any], slot: int) -> dict[str, Any]:
    results = worker_roundup.get("results") or {}
    return {
        "slot": slot,
        "feature_name": str(results.get("feature_name") or plan.get("candidate_id") or f"round_{round_id}"),
        "feature_column": results.get("feature_column"),
        "round_id": round_id,
        "panel_candidate_score": _safe_float(results.get("panel_candidate_score")),
        "panel_candidate_rmse": _safe_float(results.get("panel_candidate_rmse")),
        "delta_panel_score": _safe_float(results.get("delta_panel_score")),
        "donor_feature_table": (results.get("artifacts") or {}).get("donor_feature_table"),
        "worker_dir": worker_roundup.get("worker_dir", ""),
        "results_path": worker_roundup.get("results_path", ""),
        "result_path": worker_roundup.get("result_path", ""),
    }


def _apply_panel_review(
    *, accepted_panel: dict[str, Any], round_id: int, plan: dict[str, Any],
    worker_roundup: dict[str, Any], review: dict[str, Any],
) -> dict[str, Any]:
    results = worker_roundup.get("results") or {}
    members = [dict(entry) for entry in (accepted_panel.get("members") or []) if isinstance(entry, dict)]
    chosen = review.get("chosen_review") or {}
    slot = chosen.get("slot")
    if chosen.get("action") == "replace" and isinstance(slot, int) and 1 <= slot <= len(members):
        members[slot - 1] = _panel_member_record(round_id=round_id, plan=plan, worker_roundup=worker_roundup, slot=slot)
    else:
        members.append(_panel_member_record(round_id=round_id, plan=plan, worker_roundup=worker_roundup, slot=len(members) + 1))
    return {
        "best_panel_score": _safe_float(results.get("panel_candidate_score")),
        "best_panel_rmse": _safe_float(results.get("panel_candidate_rmse")),
        "members": members,
    }


def _round_summary_text(plan: dict[str, Any], results: dict[str, Any], decision: str, reason: str, review: dict[str, Any]) -> str:
    chosen = review.get("chosen_review") or {}
    action = str(chosen.get("action") or "add")
    if chosen.get("slot") is not None:
        action += f"(slot={chosen['slot']})"
    return (
        f"{plan.get('candidate_id', '')}: decision={decision} ({reason}), action={action}, "
        f"variation={review.get('chosen_variation') or 'NA'}, "
        f"panel RMSE {_fmt(review.get('accepted_panel_rmse'), 4)}, "
        f"CV RMSE gain {_fmt(results.get('mean_rmse_improvement'), 5)}"
    )


def findings_markdown(accepted_panel: dict[str, Any], spec: ProblemSpec) -> str:
    members = [m for m in (accepted_panel.get("members") or []) if isinstance(m, dict)]
    lines = [
        f"Outcome: {spec.outcome}",
        f"Accepted panel members: {len(members)}",
        f"Panel CV RMSE: {_fmt(accepted_panel.get('best_panel_rmse'), 4)}",
    ]
    if members:
        lines.append("")
        for member in members:
            lines.append(
                f"- {member.get('feature_name', '')} [{member.get('feature_column', '')}] "
                f"(round {member.get('round_id', '?')}, panel RMSE {_fmt(member.get('panel_candidate_rmse'), 4)})"
            )
    return "\n".join(lines) + "\n"


def _numbered(name: str, slot: int, workers: int) -> str:
    """plan.json with one worker per round; plan_2.json for the second of several."""
    if workers <= 1:
        return name
    stem, dot, ext = name.partition(".")
    return f"{stem}_{slot}{dot}{ext}"


def feedback_path(round_dir: Path, worker: Any) -> Path:
    """A candidate's feedback file (rows of single-worker runs have no worker number)."""
    worker = str(worker or "").strip()
    return round_dir / (ROUND_FEEDBACK_NAME if worker in ("", "0") else _numbered(ROUND_FEEDBACK_NAME, int(worker), 2))


def _record_candidate(
    *, run_root: Path, round_dir: Path, slot: int, workers: int, feedback: dict[str, Any], results_row: dict[str, Any],
) -> None:
    if workers <= 1:
        results_row = {**results_row, "worker": ""}
    _append_results_row(run_root, results_row)
    _write_json(feedback_path(round_dir, results_row.get("worker")), feedback)


def _finish_round(*, run_root: Path, accepted_panel: dict[str, Any], state: dict[str, Any], next_round_id: int) -> dict[str, Any]:
    _write_json(run_root / ACCEPTED_PANEL_NAME, accepted_panel)
    persisted = {"next_round_id": next_round_id, "config": dict(state.get("config") or {}),
                 "guide": bool(state.get("guide"))}
    _write_json(run_root / "run_state.json", persisted)
    return persisted


def _discard_review(accepted_panel: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "decision": "discard",
        "reason": reason,
        "keep": False,
        "chosen_review": None,
        "accepted_panel_score": accepted_panel.get("best_panel_score"),
        "accepted_panel_rmse": accepted_panel.get("best_panel_rmse"),
        "accepted_panel_delta": 0.0,
    }


# ── threads per run folder ────────────────────────────────────────────────────
# A cancelled run's coroutine stops at once, but a thread it was awaiting (an
# LLM call, a judge fit) runs to the end of its step. Counting them per run
# folder lets a resume wait until the folder is really quiet.

_BUSY: dict[str, int] = {}
_BUSY_LOCK = threading.Lock()


def run_folder_busy(run_root: Path) -> bool:
    with _BUSY_LOCK:
        return _BUSY.get(str(Path(run_root).resolve()), 0) > 0


async def _in_thread(run_root: Path, fn: Callable[..., Any], /, **kwargs: Any) -> Any:
    key = str(run_root.resolve())

    # Counted from inside the thread: a call cancelled while still queued never
    # runs, so it must never have been counted.
    def call() -> Any:
        with _BUSY_LOCK:
            _BUSY[key] = _BUSY.get(key, 0) + 1
        try:
            return fn(**kwargs)
        finally:
            with _BUSY_LOCK:
                _BUSY[key] -= 1
                if not _BUSY[key]:
                    del _BUSY[key]

    return await asyncio.to_thread(call)


# ── the loop ──────────────────────────────────────────────────────────────────

async def run_discovery(
    *,
    spec: ProblemSpec,
    data_dir: str | Path,
    run_root: str | Path,
    emit: Callable[[dict[str, Any]], Awaitable[None]],
    rounds: int,
    model: Optional[str] = None,
    reasoning_effort: str = "high",
    worker_wall_clock_sec: int = DEFAULT_WORKER_WALL_CLOCK,
    dataset_scout: bool = True,
    guide_from: Optional[str] = None,
    workers_per_round: int = 1,
    cancel_event: Optional[threading.Event] = None,
) -> dict[str, Any]:
    """Run `rounds` rounds in run_root (resuming from run_state.json if present).

    dataset_scout: before round 1, an agent explores the data folder and writes
    shared/dataset_guide.md for the proposer and workers (once per run).
    guide_from: the run whose guide was copied in instead (the scout is skipped).
    workers_per_round: plans (and workers, in parallel) per round; at most one is admitted.

    cancel_event stops the proposer / worker threads and their sandboxes: the
    awaiting coroutine can be cancelled, but the threads it waits on cannot.
    """
    model = model or discovery_model()
    pin_run_client()
    panel_config = PredictivePanelConfig()
    data_dir = Path(data_dir)
    run_root = Path(run_root)
    shared_dir = run_root / "shared"
    shared_dir.mkdir(parents=True, exist_ok=True)
    # State first: a run cancelled before round 1 is still listed and resumable.
    state = _load_or_init_state(
        run_root=run_root,
        config={"rounds": rounds, "model": model, "reasoning_effort": reasoning_effort,
                "worker_wall_clock_sec": worker_wall_clock_sec, "dataset_scout": dataset_scout,
                "guide_from": guide_from, "workers_per_round": workers_per_round},
    )
    # A resume may add rounds: the run's total is what status and listing go by.
    total_rounds = int(state.get("next_round_id", 1) or 1) + rounds - 1
    if state["config"].get("rounds") != total_rounds:
        state["config"]["rounds"] = total_rounds
        _write_json(run_root / "run_state.json", state)
    workers = max(1, min(MAX_WORKERS_PER_ROUND, int(workers_per_round)))
    accepted_panel = _load_or_init_accepted_panel(run_root)
    await asyncio.to_thread(copy_tree, SHARED_LIB_SOURCE, shared_dir / "lib" / "shared_analysis")
    write_dataset_layout(spec, shared_dir)
    loop = asyncio.get_running_loop()

    def forward(event: dict[str, Any]) -> None:
        try:
            asyncio.run_coroutine_threadsafe(emit(event), loop)
        except Exception:
            pass

    # A failed scout costs the guide, not the run.
    guide_path = shared_dir / GUIDE_NAME
    if guide_from and guide_path.exists() and not state["guide"]:
        state["guide"] = True
        _write_json(run_root / "run_state.json", state)
        await emit({"type": "scout_done", "status": "reused", "from": guide_from})
    elif dataset_scout and not state["guide"]:
        await emit({"type": "scout_started"})
        try:
            scouted = await _in_thread(
                run_root, run_scout, spec=spec, data_dir=data_dir, shared_dir=shared_dir, run_root=run_root,
                model=model, on_event=forward, cancel_event=cancel_event,
            )
            if scouted.get("status") == "completed":
                state["guide"] = True
                _write_json(run_root / "run_state.json", state)
            await emit({"type": "scout_done", **scouted})
        except Exception as exc:
            if cancel_event is not None and cancel_event.is_set():
                raise
            await emit({"type": "scout_done", "status": "error", "error": f"{type(exc).__name__}: {exc}"})
    dataset_guide_text = guide_path.read_text(encoding="utf-8") if state["guide"] and guide_path.exists() else ""

    next_round_id = int(state.get("next_round_id", 1) or 1)
    rounds_done = 0
    for round_id in range(next_round_id, next_round_id + rounds):
        round_dir = run_root / f"round_{round_id:04d}"
        round_dir.mkdir(parents=True, exist_ok=True)
        await emit({"type": "round_started", "round_id": round_id, "total_rounds": next_round_id + rounds - 1,
                    "workers": workers})

        # 1. One plan per worker, asked in turn so that each differs from those before it.
        plans: list[tuple[int, dict[str, Any]]] = []
        proposer_failures: list[tuple[int, str]] = []
        for slot in range(1, workers + 1):
            try:
                plan = await _in_thread(
                    run_root,
                    run_proposer,
                    round_dir=round_dir,
                    spec=spec,
                    dataset_guide_text=dataset_guide_text,
                    accepted_panel_summary=accepted_panel_summary(accepted_panel),
                    results_log_text=load_feedback_history(run_root),
                    round_id=round_id,
                    model=model,
                    reasoning_effort=reasoning_effort,
                    proposed_this_round=[p for _, p in plans],
                    slot=slot,
                    cancel_event=cancel_event,
                )
            except Exception as exc:
                if cancel_event is not None and cancel_event.is_set():
                    raise
                # A failed proposer costs one worker's slot, not the round.
                _write_json(round_dir / _numbered("proposer_failure.json", slot, workers),
                            {"error_type": type(exc).__name__, "error": str(exc), "traceback": traceback.format_exc()})
                note = f"proposer failed: {type(exc).__name__}: {exc}"
                await emit({"type": "proposer_failed", "round_id": round_id, "slot": slot, "error": note})
                proposer_failures.append((slot, note))
                continue
            _write_json(round_dir / _numbered("plan.json", slot, workers), plan)
            plans.append((slot, plan))
            await emit({
                "type": "candidate_proposed",
                "round_id": round_id,
                "slot": slot,
                "candidate_id": plan.get("candidate_id", ""),
                "scientific_question": plan.get("scientific_question", ""),
            })

        # 2. The workers run side by side, each in its own sandbox.
        briefs = [
            (slot, plan, _build_worker_brief(round_id=round_id, plan=plan, accepted_panel=accepted_panel,
                                             slot=slot, workers=workers))
            for slot, plan in plans
        ]
        for _, _, brief in briefs:
            await emit({"type": "worker_started", "worker_name": brief["worker_name"],
                        "scientific_question": brief["scientific_question"]})

        async def work(brief: dict[str, Any]) -> dict[str, Any]:
            try:
                result = await _in_thread(
                    run_root,
                    run_worker,
                    worker_brief=brief,
                    round_dir=round_dir,
                    spec=spec,
                    data_dir=data_dir,
                    shared_dir=shared_dir,
                    model=model,
                    reasoning_effort=reasoning_effort,
                    worker_wall_clock_sec=worker_wall_clock_sec,
                    command_timeout_sec=WORKER_COMMAND_TIMEOUT,
                    on_event=forward,
                    cancel_event=cancel_event,
                )
                status = "completed"
            except Exception as exc:
                worker_dir = round_dir / brief["worker_name"]
                worker_dir.mkdir(parents=True, exist_ok=True)
                if not isinstance(exc, ControllerChecksFailed):
                    _write_json(worker_dir / "worker_failure.json",
                                {"error_type": type(exc).__name__, "error": str(exc), "traceback": traceback.format_exc()})
                result = {"worker_name": brief["worker_name"], "worker_dir": str(worker_dir),
                          "summary": f"FAILED: {exc}", "results_path": "", "result_path": "", "results": {}}
                status = "failed"
            await emit({"type": f"worker_{status}", "worker_name": result.get("worker_name", ""),
                        "summary": result.get("summary", "")})
            return {**result, "status": status}

        roundups = await asyncio.gather(*(work(brief) for _, _, brief in briefs))

        # 3. Each finished worker is judged against the same panel.
        if any(r["status"] == "completed" for r in roundups):
            await emit({"type": "judging", "round_id": round_id})
        candidates: list[dict[str, Any]] = []
        for (slot, plan, brief), roundup in zip(briefs, roundups):
            # Why nothing was admitted, when it was not the judge's verdict.
            note = "" if roundup["status"] == "completed" else str(roundup.get("summary", ""))
            if roundup["status"] == "completed":
                try:
                    review = await _in_thread(
                        run_root,
                        review_candidate,
                        accepted_panel=accepted_panel,
                        worker_brief=brief,
                        worker_roundup=roundup,
                        data_dir=data_dir,
                        spec=spec,
                        round_dir=Path(roundup["worker_dir"]),
                        config=panel_config,
                    )
                except Exception as exc:
                    _write_json(Path(roundup["worker_dir"]) / "judge_failure.json",
                                {"error_type": type(exc).__name__, "error": str(exc), "traceback": traceback.format_exc()})
                    review = _discard_review(accepted_panel, "judge_error")
                    note = f"judge failed: {type(exc).__name__}: {exc}"
            else:
                review = _discard_review(accepted_panel, "worker_failed")
            chosen_evaluation = (review.get("chosen_review") or {}).get("evaluation") or {}
            if chosen_evaluation.get("results"):
                roundup["results"] = chosen_evaluation["results"]
                if roundup.get("results_path"):
                    _write_json(Path(roundup["results_path"]), roundup["results"])
            candidates.append({"slot": slot, "plan": plan, "roundup": roundup, "review": review, "note": note})

        # 4. At most one enters the panel: the eligible candidate with the lowest panel RMSE.
        eligible = [c for c in candidates if c["review"].get("keep")]
        winner = min(eligible, key=lambda c: _safe_float(c["review"].get("accepted_panel_rmse")) or float("inf"),
                     default=None)
        for c in eligible:
            if c is not winner:
                c["review"] = {**c["review"], "decision": "discard", "reason": "another_worker_better", "keep": False,
                               "accepted_panel_rmse": accepted_panel.get("best_panel_rmse"),
                               "accepted_panel_score": accepted_panel.get("best_panel_score")}
        if winner:
            accepted_panel = _apply_panel_review(
                accepted_panel=accepted_panel, round_id=round_id, plan=winner["plan"],
                worker_roundup=winner["roundup"], review=winner["review"],
            )

        summaries = []
        for slot, note in proposer_failures:
            summaries.append(note)
            _record_candidate(
                run_root=run_root, round_dir=round_dir, slot=slot, workers=workers,
                feedback={"round_id": round_id, "decision": "discard", "reason": "proposer_failed",
                          "worker_status": "not_run", "summary": note},
                results_row={"round_id": round_id, "worker": slot, "status": "proposer_failed", "decision": "discard",
                             "error": note},
            )
        for c in candidates:
            plan, roundup, review = c["plan"], c["roundup"], c["review"]
            results = roundup.get("results") or {}
            decision = str(review.get("decision") or "discard")
            reason = str(review.get("reason") or "no_improvement")
            summary_text = _round_summary_text(plan, results, decision, reason, review)
            summaries.append(summary_text)
            feedback = build_round_feedback(
                round_id=round_id, plan=plan, worker_status=roundup["status"], decision=decision, reason=reason,
                review=review, worker_summary=c["note"],
            )
            feedback["summary"] = summary_text
            chosen = review.get("chosen_review") or {}
            _record_candidate(
                run_root=run_root, round_dir=round_dir, slot=c["slot"], workers=workers, feedback=feedback,
                results_row={
                    "round_id": round_id,
                    "worker": c["slot"],
                    "candidate_id": plan.get("candidate_id", ""),
                    "feature_name": results.get("feature_name", plan.get("candidate_id", "")),
                    "chosen_variation": review.get("chosen_variation") or "",
                    "status": roundup["status"],
                    "decision": decision,
                    "review_action": chosen.get("action", ""),
                    "review_slot": chosen.get("slot", ""),
                    "accepted_panel_score": review.get("accepted_panel_score"),
                    "baseline_panel_score": results.get("panel_baseline_score"),
                    "candidate_panel_score": results.get("panel_candidate_score"),
                    "accepted_panel_delta": review.get("accepted_panel_delta"),
                    "delta_panel_score": results.get("delta_panel_score"),
                    # partial r of the variation the judge chose (the RMSE columns refer to it too)
                    "partial_r": next(
                        (v.get("partial_r") for v in (review.get("variation_summaries") or [])
                         if v.get("variation") == review.get("chosen_variation")),
                        None,
                    ),
                    "accepted_panel_rmse": review.get("accepted_panel_rmse"),
                    "candidate_panel_rmse": results.get("panel_candidate_rmse"),
                    "mean_rmse_improvement": results.get("mean_rmse_improvement"),
                    "fraction_repeats_better_rmse": results.get("fraction_repeats_better_rmse"),
                    "description": plan.get("scientific_question", ""),
                    "artifact_dir": roundup.get("worker_dir", ""),
                    "error": c["note"],
                },
            )
        state = _finish_round(run_root=run_root, accepted_panel=accepted_panel, state=state, next_round_id=round_id + 1)
        await emit({"type": "round_summary", "round_id": round_id, "summary": "\n".join(summaries)})
        await emit({"type": "round_completed", "round_id": round_id})
        rounds_done += 1

    answer = findings_markdown(accepted_panel, spec)
    # Shown live (complete event) and when the run is reopened from history.
    _write_text_atomic(run_root / FINDINGS_NAME, answer)
    return {
        "answer": answer,
        "status": "completed",
        "iterations": rounds_done,
        "accepted_panel": accepted_panel,
        "best_panel_rmse": accepted_panel.get("best_panel_rmse"),
    }
