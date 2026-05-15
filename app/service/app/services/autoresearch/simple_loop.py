"""
Minimal autoresearch loop aligned with the Karpathy-style keep/discard model.

The loop is intentionally simple:

1. Propose one candidate biomarker round
2. Run one worker to implement it
3. Evaluate the candidate against the accepted panel
4. Keep, replace, or discard based on simple local panel surgery
5. Append one row to results.tsv

State is centered on accepted_panel.json and a compact run_state.json.
"""

from __future__ import annotations

import csv
import json
import re
import traceback
import asyncio
from tempfile import NamedTemporaryFile
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from .client import call_model, output_text
from .deterministic_evaluator import evaluate_worker_artifacts
from .scout import run_scout
from .shared_runtime import ensure_shared_runtime
from .shared_lib_source.shared_analysis.artifacts import write_results_payload
from .worker import run_worker


DEFAULT_MODEL = "gpt-5.4"
DEFAULT_ROUNDS = 10
DEFAULT_WORKER_WALL_CLOCK = 600
DEFAULT_SYNTHESIS_BUFFER = 120
DEFAULT_COMMAND_TIMEOUT = 300
RESULTS_TSV_NAME = "results.tsv"
ACCEPTED_PANEL_NAME = "accepted_panel.json"
EPSILON = 1e-4
REQUIRED_VARIATION_COUNT = 20
PROMPTS_DIR = Path(__file__).parent / "prompts"

RESULTS_HEADERS = [
    "round_id",
    "candidate_type",
    "candidate_id",
    "feature_name",
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
    "selection_score",
    "description",
    "artifact_dir",
    "error",
]


def _load_prompt(name: str) -> str:
    return (PROMPTS_DIR / name).read_text(encoding="utf-8")


def _parse_json(text: str) -> dict[str, Any]:
    match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)
    if match:
        text = match.group(1)
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                pass
    return {}


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(text)
        tmp_path = Path(handle.name)
    tmp_path.replace(path)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    _write_text_atomic(path, json.dumps(payload, indent=2) + "\n")


def _load_or_init_state(
    *,
    run_root: Path,
    rounds: int,
    model: str,
    reasoning_effort: str,
    worker_wall_clock_sec: int,
    primary_outcome: str,
) -> dict[str, Any]:
    path = run_root / "run_state.json"
    if path.exists():
        raw_state = _read_json(path)
        state = {
            "next_round_id": int(raw_state.get("next_round_id", 1) or 1),
            "config": dict(raw_state.get("config") or {}),
        }
        config = state["config"]
        config.setdefault("rounds", rounds)
        config.setdefault("model", model)
        config.setdefault("reasoning_effort", reasoning_effort)
        config.setdefault("worker_wall_clock_sec", worker_wall_clock_sec)
        config.setdefault("primary_outcome", primary_outcome)
        return state

    state = {
        "next_round_id": 1,
        "config": {
            "rounds": rounds,
            "model": model,
            "reasoning_effort": reasoning_effort,
            "worker_wall_clock_sec": worker_wall_clock_sec,
            "primary_outcome": primary_outcome,
        },
    }
    _write_json(path, state)
    return state


def _load_or_init_accepted_panel(run_root: Path) -> dict[str, Any]:
    path = run_root / ACCEPTED_PANEL_NAME
    if path.exists():
        payload = _read_json(path)
        payload.setdefault("best_panel_score", None)
        payload.setdefault("members", [])
        return payload

    payload = {"best_panel_score": None, "members": []}
    _write_json(path, payload)
    return payload


def _load_results_rows(run_root: Path) -> list[dict[str, Any]]:
    path = run_root / RESULTS_TSV_NAME
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle, delimiter="\t"))


def _append_results_row(run_root: Path, row: dict[str, Any]) -> None:
    rows = _load_results_rows(run_root)
    rows.append({key: row.get(key, "") for key in RESULTS_HEADERS})
    path = run_root / RESULTS_TSV_NAME
    with NamedTemporaryFile("w", encoding="utf-8", newline="", dir=run_root, delete=False) as handle:
        writer = csv.DictWriter(handle, fieldnames=RESULTS_HEADERS, delimiter="\t")
        writer.writeheader()
        writer.writerows(rows)
        tmp_path = Path(handle.name)
    tmp_path.replace(path)


def _load_recent_results_text(run_root: Path, *, limit: int = 12) -> str:
    path = run_root / RESULTS_TSV_NAME
    if not path.exists():
        return ""
    with path.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle, delimiter="\t"))
    if not rows:
        return ""
    lines: list[str] = []
    for row in rows[-limit:]:
        lines.append(
            " | ".join(
                [
                    f"round={row.get('round_id', '')}",
                    f"candidate={row.get('candidate_id', '')}",
                    f"description={row.get('description', '')}",
                    f"status={row.get('status', '')}",
                    f"decision={row.get('decision', '')}",
                    f"action={row.get('review_action', '')}",
                    f"accepted={row.get('accepted_panel_score', '')}",
                    f"base={row.get('baseline_panel_score', '')}",
                    f"full={row.get('candidate_panel_score', '')}",
                    f"delta={row.get('delta_panel_score', '')}",
                    f"gain={row.get('accepted_panel_delta', '')}",
                    f"partial_r={row.get('partial_r', '')}",
                ]
            )
        )
    return "\n".join(lines)


def _normalize_candidate_plan(raw: dict[str, Any], *, candidate_type: str, round_id: int) -> dict[str, Any]:
    candidate_id = str(raw.get("candidate_id") or "").strip()
    if not candidate_id:
        candidate_id = f"candidate_round_{round_id:04d}"

    scientific_question = str(
        raw.get("scientific_question")
        or raw.get("round_focus")
        or raw.get("question")
        or candidate_id
    ).strip()
    approach = str(raw.get("approach") or "").strip()
    rationale = str(raw.get("rationale") or "").strip()
    notes = str(raw.get("notes") or "").strip()

    variations: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in raw.get("variations") or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        variations.append(
            {
                "name": name,
                "description": str(entry.get("description") or scientific_question).strip(),
            }
        )
        if len(variations) >= REQUIRED_VARIATION_COUNT:
            break

    if not variations:
        variations = [
            {
                "name": candidate_id,
                "description": scientific_question or approach or candidate_id,
            }
        ]

    baseline_variation = str(raw.get("baseline_variation") or "").strip()
    if baseline_variation not in {entry["name"] for entry in variations}:
        baseline_variation = variations[0]["name"]

    return {
        "candidate_type": candidate_type,
        "candidate_id": candidate_id,
        "scientific_question": scientific_question,
        "rationale": rationale,
        "approach": approach,
        "variations": variations,
        "baseline_variation": baseline_variation,
        "notes": notes,
    }


def _accepted_panel_summary(accepted_panel: dict[str, Any]) -> dict[str, Any]:
    members: list[dict[str, Any]] = []
    for idx, member in enumerate(accepted_panel.get("members", []) or [], start=1):
        if not isinstance(member, dict):
            continue
        members.append(
            {
                "slot": idx,
                "feature_name": member.get("feature_name"),
                "round_id": member.get("round_id"),
                "panel_candidate_score": member.get("panel_candidate_score"),
            }
        )
    return {
        "best_panel_score": accepted_panel.get("best_panel_score"),
        "member_count": len(members),
        "members": members,
    }


def _propose_candidate(
    *,
    program_text: str,
    data_summary: str,
    accepted_panel: dict[str, Any],
    results_log_text: str,
    round_id: int,
    model: str,
    reasoning_effort: str,
) -> dict[str, Any]:
    candidate_type = "seed" if not (accepted_panel.get("members") or []) else "candidate"
    prompt = _load_prompt("candidate_prompt.md")
    payload = {
        "program": program_text,
        "data_summary": data_summary[:5000],
        "accepted_panel": _accepted_panel_summary(accepted_panel),
        "recent_results": results_log_text or "(no prior rounds)",
        "round_id": round_id,
        "candidate_type": candidate_type,
        "required_variation_count": REQUIRED_VARIATION_COUNT,
    }
    response = call_model(
        prompt + "\n\n" + json.dumps(payload, indent=2),
        model=model,
        reasoning_effort=reasoning_effort,
    )
    plan = _normalize_candidate_plan(
        _parse_json(output_text(response)),
        candidate_type=candidate_type,
        round_id=round_id,
    )
    plan["prompt_text"] = prompt
    return plan


def _build_worker_brief(
    *,
    round_id: int,
    plan: dict[str, Any],
    accepted_panel: dict[str, Any],
) -> dict[str, Any]:
    return {
        "worker_name": f"round_{round_id:04d}_worker",
        "round_id": round_id,
        "candidate_id": plan.get("candidate_id", ""),
        "candidate_type": plan.get("candidate_type", "candidate"),
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


def _safe_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _feature_name(results: dict[str, Any], fallback: str) -> str:
    return str(results.get("feature_name") or results.get("feature_column") or fallback).strip()


def _candidate_score(evaluation: dict[str, Any] | None) -> float | None:
    return _safe_float(((evaluation or {}).get("results") or {}).get("panel_candidate_score"))


def _select_best_panel_action(
    *,
    accepted_panel: dict[str, Any],
    action_reviews: list[dict[str, Any]],
) -> dict[str, Any]:
    incumbent_score = _safe_float(accepted_panel.get("best_panel_score"))
    scored_reviews = [review for review in action_reviews if _candidate_score(review.get("evaluation")) is not None]
    if not scored_reviews:
        return {
            "decision": "discard",
            "reason": "no_panel_score",
            "keep": False,
            "chosen_review": None,
            "accepted_panel_score": incumbent_score,
            "accepted_panel_delta": 0.0 if incumbent_score is not None else None,
        }

    chosen_review = max(scored_reviews, key=lambda review: _candidate_score(review.get("evaluation")) or float("-inf"))
    chosen_score = _candidate_score(chosen_review.get("evaluation"))
    accepted_delta = None
    if incumbent_score is not None and chosen_score is not None:
        accepted_delta = chosen_score - incumbent_score

    if incumbent_score is None:
        return {
            "decision": "keep",
            "reason": "seed_panel",
            "keep": True,
            "chosen_review": chosen_review,
            "accepted_panel_score": chosen_score,
            "accepted_panel_delta": accepted_delta,
        }

    if chosen_score is not None and chosen_score > incumbent_score + EPSILON:
        reason = "panel_improved"
        if chosen_review.get("action") == "replace" and chosen_review.get("slot") is not None:
            reason = f"replace_slot_{chosen_review['slot']}"
        return {
            "decision": "keep",
            "reason": reason,
            "keep": True,
            "chosen_review": chosen_review,
            "accepted_panel_score": chosen_score,
            "accepted_panel_delta": accepted_delta,
        }

    return {
        "decision": "discard",
        "reason": "no_improvement",
        "keep": False,
        "chosen_review": chosen_review,
        "accepted_panel_score": incumbent_score,
        "accepted_panel_delta": 0.0 if incumbent_score is not None else None,
    }


def _review_candidate_against_panel(
    *,
    accepted_panel: dict[str, Any],
    worker_brief: dict[str, Any],
    worker_roundup: dict[str, Any],
    data_dir: Path,
    primary_outcome: str,
) -> dict[str, Any]:
    if worker_roundup.get("status") != "completed":
        return {
            "decision": "discard",
            "reason": "worker_failed",
            "keep": False,
            "chosen_review": None,
            "accepted_panel_score": _safe_float(accepted_panel.get("best_panel_score")),
            "accepted_panel_delta": None,
        }

    action_reviews = [
        {
            "action": "add",
            "slot": None,
            "evaluation": worker_roundup.get("evaluation") or {"results": worker_roundup.get("results") or {}},
        }
    ]

    members = [dict(member) for member in (accepted_panel.get("members") or []) if isinstance(member, dict)]
    for idx, member in enumerate(members, start=1):
        reduced_members = [dict(entry) for pos, entry in enumerate(members, start=1) if pos != idx]
        replacement_eval = evaluate_worker_artifacts(
            worker_name=worker_brief["worker_name"],
            worker_dir=worker_roundup["worker_dir"],
            data_dir=data_dir,
            results_path=worker_roundup.get("results_path") or "",
            primary_outcome=primary_outcome,
            panel_state={"members": reduced_members},
        )
        action_reviews.append(
            {
                "action": "replace",
                "slot": idx,
                "replaced_feature_name": member.get("feature_name"),
                "evaluation": replacement_eval,
            }
        )

    review = _select_best_panel_action(accepted_panel=accepted_panel, action_reviews=action_reviews)
    review["action_reviews"] = [
        {
            "action": item.get("action"),
            "slot": item.get("slot"),
            "replaced_feature_name": item.get("replaced_feature_name"),
            "candidate_panel_score": _candidate_score(item.get("evaluation")),
            "baseline_panel_score": _safe_float(((item.get("evaluation") or {}).get("results") or {}).get("panel_baseline_score")),
            "delta_panel_score": _safe_float(((item.get("evaluation") or {}).get("results") or {}).get("delta_panel_score")),
        }
        for item in action_reviews
    ]
    return review


def _panel_member_record(
    *,
    round_id: int,
    plan: dict[str, Any],
    worker_roundup: dict[str, Any],
    slot: int,
) -> dict[str, Any]:
    results = worker_roundup.get("results") or {}
    feature_name = _feature_name(results, str(plan.get("candidate_id") or f"round_{round_id}"))
    return {
        "slot": slot,
        "feature_name": feature_name,
        "round_id": round_id,
        "panel_candidate_score": _safe_float(results.get("panel_candidate_score")),
        "delta_panel_score": _safe_float(results.get("delta_panel_score")),
        "status": "active",
        "worker_dir": worker_roundup.get("worker_dir", ""),
        "results_path": worker_roundup.get("results_path", ""),
        "result_path": worker_roundup.get("result_path", ""),
    }


def _apply_panel_review(
    *,
    accepted_panel: dict[str, Any],
    round_id: int,
    plan: dict[str, Any],
    worker_roundup: dict[str, Any],
    review: dict[str, Any],
) -> dict[str, Any]:
    results = worker_roundup.get("results") or {}
    members = [dict(entry) for entry in (accepted_panel.get("members") or []) if isinstance(entry, dict)]
    chosen_review = review.get("chosen_review") or {}
    action = str(chosen_review.get("action") or "add")
    slot = chosen_review.get("slot")
    if action == "replace" and isinstance(slot, int) and 1 <= slot <= len(members):
        members[slot - 1] = _panel_member_record(
            round_id=round_id,
            plan=plan,
            worker_roundup=worker_roundup,
            slot=slot,
        )
    else:
        members.append(
            _panel_member_record(
                round_id=round_id,
                plan=plan,
                worker_roundup=worker_roundup,
                slot=len(members) + 1,
            )
        )
    return {
        "best_panel_score": _safe_float(results.get("panel_candidate_score")),
        "members": members,
    }


def _round_summary(
    plan: dict[str, Any],
    worker_roundup: dict[str, Any],
    decision: str,
    reason: str,
    review: dict[str, Any],
) -> str:
    results = worker_roundup.get("results") or {}
    partial_r = _safe_float(results.get("partial_r"))
    accepted_score = _safe_float(review.get("accepted_panel_score"))
    baseline_score = _safe_float(results.get("panel_baseline_score"))
    candidate_score = _safe_float(results.get("panel_candidate_score"))
    accepted_delta = _safe_float(review.get("accepted_panel_delta"))
    chosen_review = review.get("chosen_review") or {}
    action = str(chosen_review.get("action") or "add")
    slot = chosen_review.get("slot")
    action_text = action if slot is None else f"{action}(slot={slot})"
    return (
        f"{plan.get('candidate_id', '')}: decision={decision} ({reason}), "
        f"action={action_text}, "
        f"partial_r={partial_r if partial_r is not None else 'NA'}, "
        f"accepted={accepted_score if accepted_score is not None else 'NA'}, "
        f"base={baseline_score if baseline_score is not None else 'NA'}, "
        f"full={candidate_score if candidate_score is not None else 'NA'}, "
        f"gain={accepted_delta if accepted_delta is not None else 'NA'}"
    )


def _write_round_summary(round_dir: Path, summary: dict[str, Any]) -> None:
    _write_json(round_dir / "round_summary.json", summary)


def _persist_round_state(
    *,
    run_root: Path,
    round_dir: Path,
    accepted_panel: dict[str, Any],
    state: dict[str, Any],
    next_round_id: int,
    round_summary: dict[str, Any],
    results_row: dict[str, Any],
) -> dict[str, Any]:
    _write_json(run_root / ACCEPTED_PANEL_NAME, accepted_panel)
    _append_results_row(run_root, results_row)
    _write_round_summary(round_dir, round_summary)
    persisted_state = {
        "next_round_id": next_round_id,
        "config": dict(state.get("config") or {}),
    }
    _write_json(run_root / "run_state.json", persisted_state)
    return persisted_state


async def run_autoresearch(
    *,
    program_text: str,
    data_dir: str | Path,
    run_root: str | Path,
    emit: Callable[[dict[str, Any]], Awaitable[None]],
    rounds: int = DEFAULT_ROUNDS,
    model: str = DEFAULT_MODEL,
    reasoning_effort: str = "high",
    worker_wall_clock_sec: int = DEFAULT_WORKER_WALL_CLOCK,
    final_synthesis_buffer_sec: int = DEFAULT_SYNTHESIS_BUFFER,
    command_timeout_sec: int = DEFAULT_COMMAND_TIMEOUT,
    sandbox_backend: str = "docker",
    sandbox_image: str = "tissuelab-autoresearch-worker",
    sandbox_auto_build: bool = True,
    dataset_scout_enabled: bool = True,
    primary_outcome: str = "slope_zmem0",
    worker_reasoning_effort: Optional[str] = None,
) -> dict[str, Any]:
    data_dir = Path(data_dir)
    run_root = Path(run_root)
    run_root.mkdir(parents=True, exist_ok=True)
    shared_dir = run_root / "shared"
    shared_dir.mkdir(parents=True, exist_ok=True)
    (run_root / "program.md").write_text(program_text, encoding="utf-8")

    await emit({"type": "start", "task": "autoresearch", "rounds": rounds})

    guide_path = shared_dir / "dataset_guide.md"
    if dataset_scout_enabled and not guide_path.exists():
        await emit({"type": "scouting", "message": "Exploring dataset..."})
        try:
            scout_loop = asyncio.get_event_loop()

            def _on_scout(event: dict[str, Any]) -> None:
                try:
                    asyncio.run_coroutine_threadsafe(emit(event), scout_loop)
                except Exception:
                    pass

            scout_result = await asyncio.to_thread(
                run_scout,
                data_dir=str(data_dir),
                shared_dir=str(shared_dir),
                program_text=program_text,
                log_dir=str(run_root),
                sandbox_backend=sandbox_backend,
                sandbox_image=sandbox_image,
                sandbox_auto_build=sandbox_auto_build,
                model=model,
                reasoning_effort="medium",
                on_event=_on_scout,
            )
            await emit({"type": "scout_done", "status": scout_result.get("status", ""), "turns": scout_result.get("turns", 0)})
        except Exception as exc:
            await emit({"type": "scout_done", "status": "error", "error": str(exc)})

    data_summary = guide_path.read_text(encoding="utf-8") if guide_path.exists() else ""
    shared_runtime = ensure_shared_runtime(
        shared_dir=shared_dir,
        data_dir=data_dir,
        dataset_guide_text=data_summary,
    )

    if worker_reasoning_effort is None:
        worker_reasoning_effort = {"high": "medium", "medium": "low", "low": "low"}.get(reasoning_effort, "medium")

    state = _load_or_init_state(
        run_root=run_root,
        rounds=rounds,
        model=model,
        reasoning_effort=reasoning_effort,
        worker_wall_clock_sec=worker_wall_clock_sec,
        primary_outcome=primary_outcome,
    )
    accepted_panel = _load_or_init_accepted_panel(run_root)

    next_round_id = int(state.get("next_round_id", 1) or 1)
    rounds_done = 0

    for round_id in range(next_round_id, next_round_id + rounds):
        round_dir = run_root / f"round_{round_id:04d}"
        round_dir.mkdir(parents=True, exist_ok=True)
        await emit({"type": "round_started", "round_id": round_id, "total_rounds": next_round_id + rounds - 1})

        plan = await asyncio.to_thread(
            _propose_candidate,
            program_text=program_text,
            data_summary=data_summary,
            accepted_panel=accepted_panel,
            results_log_text=_load_recent_results_text(run_root),
            round_id=round_id,
            model=model,
            reasoning_effort=reasoning_effort,
        )
        _write_json(round_dir / "plan.json", plan)
        await emit(
            {
                "type": "candidate_proposed",
                "round_id": round_id,
                "candidate_id": plan.get("candidate_id", ""),
                "scientific_question": plan.get("scientific_question", ""),
            }
        )

        worker_brief = _build_worker_brief(round_id=round_id, plan=plan, accepted_panel=accepted_panel)
        await emit(
            {
                "type": "worker_started",
                "worker_name": worker_brief["worker_name"],
                "scientific_question": worker_brief["scientific_question"],
            }
        )

        worker_loop = asyncio.get_event_loop()

        def _on_worker(event: dict[str, Any]) -> None:
            try:
                asyncio.run_coroutine_threadsafe(emit(event), worker_loop)
            except Exception:
                pass

        try:
            worker_result = await asyncio.to_thread(
                run_worker,
                worker_brief=worker_brief,
                round_dir=round_dir,
                program_text=program_text,
                data_dir=data_dir,
                shared_dir=shared_dir,
                model=model,
                reasoning_effort=worker_reasoning_effort,
                worker_wall_clock_sec=worker_wall_clock_sec,
                final_synthesis_buffer_sec=final_synthesis_buffer_sec,
                sandbox_backend=sandbox_backend,
                sandbox_image=sandbox_image,
                sandbox_auto_build=sandbox_auto_build,
                command_timeout_sec=command_timeout_sec,
                on_event=_on_worker,
            )
            worker_status = "completed"
        except Exception as exc:
            worker_dir = round_dir / worker_brief["worker_name"]
            worker_dir.mkdir(parents=True, exist_ok=True)
            _write_json(
                worker_dir / "worker_failure.json",
                {
                    "error_type": type(exc).__name__,
                    "error": str(exc),
                    "traceback": traceback.format_exc(),
                },
            )
            worker_result = {
                "worker_name": worker_brief["worker_name"],
                "worker_dir": str(worker_dir),
                "summary": f"FAILED: {type(exc).__name__}: {exc}",
                "report_text": "",
                "result_text": "",
                "results_path": "",
                "result_path": "",
                "report_path": "",
            }
            worker_status = "failed"

        await emit(
            {
                "type": f"worker_{worker_status}",
                "worker_name": worker_result.get("worker_name", ""),
                "summary": worker_result.get("summary", ""),
            }
        )

        evaluation: dict[str, Any] = {}
        if worker_status == "completed":
            try:
                evaluation = evaluate_worker_artifacts(
                    worker_name=worker_brief["worker_name"],
                    worker_dir=worker_result["worker_dir"],
                    data_dir=data_dir,
                    results_path=worker_result.get("results_path") or "",
                    primary_outcome=primary_outcome,
                    panel_state={"members": accepted_panel.get("members", [])},
                )
            except Exception as exc:
                evaluation = {"results": {}, "summary": f"Evaluator error: {exc}"}
            else:
                if worker_result.get("results_path") and evaluation.get("results"):
                    write_results_payload(worker_result["results_path"], evaluation["results"])

        worker_roundup = {
            **worker_result,
            "status": worker_status,
            "results": evaluation.get("results", {}),
            "evaluation": evaluation,
            "summary": evaluation.get("summary") or worker_result.get("summary", ""),
        }

        review = _review_candidate_against_panel(
            accepted_panel=accepted_panel,
            worker_brief=worker_brief,
            worker_roundup=worker_roundup,
            data_dir=data_dir,
            primary_outcome=primary_outcome,
        )
        chosen_review = review.get("chosen_review") or {}
        chosen_evaluation = chosen_review.get("evaluation") or {}
        if chosen_evaluation.get("results"):
            worker_roundup["results"] = chosen_evaluation.get("results", {})
            worker_roundup["evaluation"] = chosen_evaluation
            worker_roundup["summary"] = chosen_evaluation.get("summary") or worker_roundup.get("summary", "")
            if worker_result.get("results_path"):
                write_results_payload(worker_result["results_path"], worker_roundup["results"])

        decision = str(review.get("decision") or "discard")
        reason = str(review.get("reason") or "no_improvement")
        if review.get("keep"):
            accepted_panel = _apply_panel_review(
                accepted_panel=accepted_panel,
                round_id=round_id,
                plan=plan,
                worker_roundup=worker_roundup,
                review=review,
            )

        summary_text = _round_summary(plan, worker_roundup, decision, reason, review)
        round_summary = {
            "round_id": round_id,
            "candidate_id": plan.get("candidate_id"),
            "status": worker_status,
            "decision": decision,
            "reason": reason,
            "review_action": chosen_review.get("action"),
            "review_slot": chosen_review.get("slot"),
            "accepted_panel_score": review.get("accepted_panel_score"),
            "accepted_panel_delta": review.get("accepted_panel_delta"),
            "panel_review": {"actions": review.get("action_reviews", [])},
            "summary": summary_text,
            "results": worker_roundup.get("results", {}),
        }

        results = worker_roundup.get("results") or {}
        state = _persist_round_state(
            run_root=run_root,
            round_dir=round_dir,
            accepted_panel=accepted_panel,
            state=state,
            next_round_id=round_id + 1,
            round_summary=round_summary,
            results_row={
                "round_id": round_id,
                "candidate_type": plan.get("candidate_type", ""),
                "candidate_id": plan.get("candidate_id", ""),
                "feature_name": _feature_name(results, str(plan.get("candidate_id") or "")),
                "status": worker_status,
                "decision": decision,
                "review_action": chosen_review.get("action", ""),
                "review_slot": chosen_review.get("slot", ""),
                "accepted_panel_score": review.get("accepted_panel_score"),
                "baseline_panel_score": results.get("panel_baseline_score"),
                "candidate_panel_score": results.get("panel_candidate_score"),
                "accepted_panel_delta": review.get("accepted_panel_delta"),
                "delta_panel_score": results.get("delta_panel_score"),
                "partial_r": results.get("partial_r"),
                "selection_score": results.get("selection_score"),
                "description": plan.get("scientific_question", ""),
                "artifact_dir": worker_result.get("worker_dir", ""),
                "error": "" if worker_status == "completed" else worker_result.get("summary", ""),
            },
        )

        await emit({"type": "round_summary", "round_id": round_id, "summary": summary_text})
        await emit({"type": "round_completed", "round_id": round_id})
        rounds_done += 1

    best_panel_score = accepted_panel.get("best_panel_score")
    answer = (
        f"Accepted panel members: {len(accepted_panel.get('members', []))}\n"
        f"Best panel score: {best_panel_score}"
    )
    return {
        "answer": answer,
        "status": "completed",
        "iterations": rounds_done,
        "accepted_panel": accepted_panel,
        "best_panel_score": best_panel_score,
    }
