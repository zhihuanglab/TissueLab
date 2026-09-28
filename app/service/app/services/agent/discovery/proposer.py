"""The proposer: inspects the data (outcome-blind) and commits to one plan per round.

It gets an outcome-blind sandbox (the slides, the identifier-only cohort file,
the loaders, the data-intuition brief), two tools (`shell_exec`,
`inspect_image`), a small tool budget, and the structured feedback of prior
rounds, and must end by returning exactly one JSON plan. Every turn (request,
response, command, output, image) is saved under round_NNNN/proposer/.

Outcome values are never reachable from inside the sandbox; what the proposer
learns about outcomes comes only from the aggregated per-round feedback.
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from .client import (
    custom_tool_call_output,
    custom_tool_calls,
    input_image_message,
    output_text,
    response_id,
    responses_create,
)
from .problem import ProblemSpec, write_public_cohort
from .sandbox import SandboxSession
from .tools import IMAGE_TOOL_NAME, IMAGE_TOOL_SPEC, SHELL_TOOL_NAME, SHELL_TOOL_SPEC, bounded_tool_text, load_prompt

PROPOSER_TIMEOUT_SEC = 600
PROPOSER_MAX_ATTEMPTS = 3
PROPOSER_RETRY_BACKOFF_SEC = 10
MAX_JSON_NUDGES = 2
REQUIRED_VARIATION_COUNT = 3

TOOL_SECTION = """

# Data access before you propose (outcome-blind)

You have a sandbox with the same data the worker will use:
- `/data/` — the slides (`.zarr`) and the cohort file with only identifier / slide / mpp
  columns (no outcomes exist here).
- `/shared/lib` on PYTHONPATH — `from shared_analysis.slides import donor_ids, slide_path,
  load_slide_metadata, build_cell_table`; `build_cell_table(slide_path("/data", donor_id))`
  gives cell_index, x, y (level-0 px; microns = value * mpp_x when known), class_id,
  cell_type, region.
- `/shared/data_intuition.md` (classes, regions, densities, spacings).
- Write anything you need under `/scratch` (cleared each round). `/shared/proposer_cache/`
  persists across rounds: pilot tables you save there can be reused in later rounds.

Tools: `shell_exec` (one shell command batch; output truncated, full logs in /scratch/logs)
and `inspect_image` (view a PNG you rendered under /scratch, e.g. a centroid scatter of one
region coloured by class, or a histogram of a pilot measurement across a few donors).

Use the budget of at most {max_tool_turns} tool turns to (a) check that your regions/classes
have enough cells in most donors, (b) pilot the measurement on 3-5 donors and look at its
range and missingness, (c) sanity-check spacing so your support rule is satisfiable. Do not
try to evaluate against outcomes — there are none here; the controller judges every
variation after the worker implements it. When you are ready, reply with ONLY the JSON
plan object (no prose, no code fences).
"""


def parse_json(text: str) -> dict[str, Any]:
    match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)
    if match:
        text = match.group(1)
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end != -1:
            try:
                return json.loads(text[start: end + 1])
            except json.JSONDecodeError:
                pass
    return {}


def parse_expected_sign(value: Any) -> int | None:
    """Accept +1/-1 (int, float, or strings like '+1', '-1', 'negative', 'positive')."""
    if value is None:
        return None
    if isinstance(value, str):
        v = value.strip().lower()
        if v in {"+1", "1", "+", "positive", "pos"}:
            return 1
        if v in {"-1", "-", "negative", "neg"}:
            return -1
        try:
            value = float(v)
        except ValueError:
            return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return 1 if f > 0 else -1 if f < 0 else None


def normalize_plan(raw: dict[str, Any], *, round_id: int) -> dict[str, Any]:
    candidate_id = str(raw.get("candidate_id") or "").strip() or f"candidate_round_{round_id:04d}"
    scientific_question = str(raw.get("scientific_question") or candidate_id).strip()
    approach = str(raw.get("approach") or "").strip()
    plan_sign = parse_expected_sign(raw.get("expected_sign"))
    variations: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in raw.get("variations") or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        # a donor-table column: an identifier, and never the key column itself
        if not name.isidentifier() or name == "donor_id" or name in seen:
            continue
        seen.add(name)
        sign = parse_expected_sign(entry.get("expected_sign"))
        variations.append(
            {
                "name": name,
                "description": str(entry.get("description") or scientific_question).strip(),
                # pre-registered direction of the covariate-adjusted correlation with the
                # outcome; None = undeclared (the variation cannot be admitted)
                "expected_sign": sign if sign is not None else plan_sign,
            }
        )
        if len(variations) >= REQUIRED_VARIATION_COUNT:
            break
    if not variations:
        name = candidate_id if candidate_id.isidentifier() and candidate_id != "donor_id" else "primary"
        variations = [{"name": name, "description": scientific_question or approach or candidate_id,
                       "expected_sign": plan_sign}]
    baseline_variation = str(raw.get("baseline_variation") or "").strip()
    if baseline_variation not in {entry["name"] for entry in variations}:
        baseline_variation = variations[0]["name"]
    return {
        "candidate_id": candidate_id,
        "scientific_question": scientific_question,
        "rationale": str(raw.get("rationale") or "").strip(),
        "approach": approach,
        "variations": variations,
        "baseline_variation": baseline_variation,
        "notes": str(raw.get("notes") or "").strip(),
    }


def _variations_missing_sign(plan_json: dict[str, Any]) -> list[str]:
    if parse_expected_sign(plan_json.get("expected_sign")) is not None:
        return []
    return [
        str(entry.get("name") or "?")
        for entry in plan_json.get("variations") or []
        if isinstance(entry, dict) and parse_expected_sign(entry.get("expected_sign")) is None
    ]


def _sum_usage(total: dict[str, int], usage: dict[str, Any] | None) -> None:
    if not usage:
        return
    total["input_tokens"] += int(usage.get("input_tokens") or 0)
    total["output_tokens"] += int(usage.get("output_tokens") or 0)
    total["cached_tokens"] += int((usage.get("input_tokens_details") or {}).get("cached_tokens") or 0)
    total["reasoning_tokens"] += int((usage.get("output_tokens_details") or {}).get("reasoning_tokens") or 0)
    total["calls"] += 1


def _reasoning_summary(response: dict[str, Any]) -> list[str]:
    return [
        str(part.get("text", ""))
        for item in response.get("output", []) or []
        if isinstance(item, dict) and item.get("type") == "reasoning"
        for part in (item.get("summary") or [])
        if isinstance(part, dict) and part.get("text")
    ]


def _create_with_retry(payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    attempt = 0
    while True:
        attempt += 1
        try:
            return responses_create(payload, timeout=timeout)
        except Exception:
            if attempt >= PROPOSER_MAX_ATTEMPTS:
                raise
            time.sleep(PROPOSER_RETRY_BACKOFF_SEC * attempt)


def _resolve_scratch_image(scratch_dir: Path, raw_path: str) -> Path:
    raw = raw_path.strip().strip("'\"")
    rel = raw[len("/scratch/"):] if raw.startswith("/scratch/") else raw.lstrip("/")
    path = (scratch_dir / rel).resolve()
    if scratch_dir.resolve() not in path.parents and path != scratch_dir.resolve():
        raise ValueError(f"inspect_image path must be under /scratch: {raw_path}")
    if not path.is_file():
        raise FileNotFoundError(f"inspect_image: no such file {raw_path}")
    return path


def run_proposer(
    *,
    round_dir: str | Path,
    spec: ProblemSpec,
    data_intuition_text: str,
    accepted_panel_summary: dict[str, Any],
    results_log_text: str,
    round_id: int,
    model: str,
    reasoning_effort: str,
    data_dir: str | Path,
    shared_dir: str | Path,
    max_tool_turns: int = 8,
    wall_clock_sec: int = 600,
    command_timeout_sec: int = 120,
    on_event: Optional[Callable[[dict[str, Any]], None]] = None,
    cancel_event: Optional[threading.Event] = None,
) -> dict[str, Any]:
    """Return a normalized plan dict for this round."""
    round_dir = Path(round_dir)
    prop_dir = round_dir / "proposer"
    scratch_dir = prop_dir / "sandbox"
    (scratch_dir / "logs").mkdir(parents=True, exist_ok=True)

    def emit(event: dict[str, Any]) -> None:
        if on_event:
            try:
                on_event({"round_id": round_id, **event})
            except Exception:
                pass

    prompt = load_prompt("proposer.md", spec)
    # Static context (identical every round) lives in `instructions` so the API prompt
    # cache covers it across rounds; only the per-round state goes into `input`.
    instructions = (
        prompt
        + TOOL_SECTION.format(max_tool_turns=max_tool_turns)
        + "\n\n# Research question\n" + spec.question
        + "\n\n# Data-intuition brief (outcome-blind)\n" + (data_intuition_text or "(not available)")[:20000]
    )
    payload = {
        "accepted_panel": accepted_panel_summary,
        "recent_results": results_log_text or "(no prior rounds)",
        "round_id": round_id,
        "required_variation_count": REQUIRED_VARIATION_COUNT,
        "tool_budget": {"max_tool_turns": max_tool_turns, "wall_clock_sec": wall_clock_sec},
    }
    kickoff = (
        json.dumps(payload, indent=2)
        + "\n\nInspect the data as needed within your tool budget, then reply with ONLY the JSON plan."
    )

    public_cohort = write_public_cohort(spec, data_dir, prop_dir / "cohort_public.csv")
    (Path(shared_dir) / "proposer_cache").mkdir(parents=True, exist_ok=True)  # persists across rounds
    session = SandboxSession(
        scratch_dir, data_dir=data_dir, shared_dir=shared_dir, command_timeout_sec=command_timeout_sec,
        file_overlays={f"/data/{spec.cohort_file}": public_cohort},
    )

    usage_total = {"input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "reasoning_tokens": 0, "calls": 0}
    reasoning: list[str] = []
    tool_turns = 0
    json_nudges = 0
    previous_response: Optional[str] = None
    pending_input: Any = kickoff
    response: dict[str, Any] = {}
    raw_text = ""
    plan_json: dict[str, Any] = {}
    deadline = time.monotonic() + max(120, int(wall_clock_sec))
    tools_enabled = True
    stop_cancel_watch = session.watch_cancel(cancel_event)
    try:
        session.start()
        for turn_id in range(1, max_tool_turns + MAX_JSON_NUDGES + 3):
            if cancel_event is not None and cancel_event.is_set():
                raise RuntimeError("proposer cancelled")
            remaining = deadline - time.monotonic()
            if tools_enabled and (tool_turns >= max_tool_turns or remaining < 60):
                tools_enabled = False
                note = ("Tool budget exhausted." if tool_turns >= max_tool_turns else "Time budget exhausted.") + \
                    " Reply now with ONLY the JSON plan object."
                if isinstance(pending_input, list):
                    pending_input = pending_input + [
                        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": note}]}
                    ]
                else:
                    pending_input = note
            request: dict[str, Any] = {
                "model": model,
                "instructions": instructions,
                "input": pending_input,
                "store": True,
                "reasoning": {"effort": reasoning_effort, "summary": "auto"},
            }
            if tools_enabled:
                request["tools"] = [SHELL_TOOL_SPEC, IMAGE_TOOL_SPEC]
                request["parallel_tool_calls"] = False
            if previous_response:
                request["previous_response_id"] = previous_response
            prefix = prop_dir / f"turn_{turn_id:02d}"
            response = _create_with_retry(request, timeout=int(min(PROPOSER_TIMEOUT_SEC, max(120, remaining))))
            prefix.with_suffix(".response.json").write_text(json.dumps(response, indent=2, default=str), encoding="utf-8")
            previous_response = response_id(response)
            _sum_usage(usage_total, response.get("usage"))
            reasoning.extend(_reasoning_summary(response))
            text = output_text(response)
            calls = custom_tool_calls(response)
            if calls and tools_enabled:
                tool_turns += 1
                tool_outputs: list[Any] = []
                for call in calls:
                    name = call.get("name")
                    call_id = str(call.get("call_id", ""))
                    if name == SHELL_TOOL_NAME:
                        command = str(call.get("input") or "")
                        prefix.with_suffix(".command.sh").write_text(command + "\n", encoding="utf-8")
                        emit({"type": "proposer_tool_call", "turn_id": turn_id, "tool_name": name, "command_preview": command[:120]})
                        result = session.exec(command, timeout_sec=int(min(command_timeout_sec, max(30, deadline - time.monotonic()))))
                        (scratch_dir / "logs" / f"turn_{turn_id:02d}.stdout.txt").write_text(str(result.get("stdout") or ""), encoding="utf-8")
                        (scratch_dir / "logs" / f"turn_{turn_id:02d}.stderr.txt").write_text(str(result.get("stderr") or ""), encoding="utf-8")
                        tool_outputs.append(custom_tool_call_output(call_id, {
                            "exit_code": result.get("exit_code"),
                            "stdout": bounded_tool_text(result.get("stdout"), 6000),
                            "stderr": bounded_tool_text(result.get("stderr"), 3000),
                            "tool_turns_used": tool_turns, "tool_turns_max": max_tool_turns,
                        }))
                        emit({"type": "proposer_tool_result", "turn_id": turn_id, "tool_name": name, "exit_code": result.get("exit_code")})
                    elif name == IMAGE_TOOL_NAME:
                        raw_path = str(call.get("input") or "")
                        try:
                            image_path = _resolve_scratch_image(scratch_dir, raw_path)
                            record = {"path": raw_path, "bytes": image_path.stat().st_size,
                                      "sha256": hashlib.sha256(image_path.read_bytes()).hexdigest()}
                            prefix.with_suffix(".image.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
                            tool_outputs.append(custom_tool_call_output(call_id, record))
                            tool_outputs.append(input_image_message(image_path, text=f"Image {raw_path} attached."))
                            emit({"type": "proposer_tool_call", "turn_id": turn_id, "tool_name": name, "image_path": raw_path})
                            emit({"type": "proposer_tool_result", "turn_id": turn_id, "tool_name": name, "exit_code": 0})
                        except Exception as exc:
                            tool_outputs.append(custom_tool_call_output(call_id, {"error": str(exc)}))
                    else:
                        tool_outputs.append(custom_tool_call_output(call_id, {"error": f"unknown tool {name}"}))
                pending_input = tool_outputs
                continue
            # no tool call: expect the plan
            raw_text = text
            plan_json = parse_json(raw_text) if raw_text else {}
            if plan_json.get("variations") or plan_json.get("candidate_id"):
                missing_sign = _variations_missing_sign(plan_json)
                if not missing_sign or json_nudges >= MAX_JSON_NUDGES:
                    break
                json_nudges += 1
                pending_input = (
                    "Every variation needs an integer `expected_sign` (+1 or -1): the pre-registered sign of "
                    f"the covariate-adjusted correlation between that variation and {spec.outcome}. "
                    f"Missing for: {missing_sign}. Reply with the complete JSON object again."
                )
                continue
            json_nudges += 1
            if json_nudges > MAX_JSON_NUDGES:
                break
            pending_input = "Reply with exactly one JSON object following the schema (no prose, no code fences)."
    finally:
        stop_cancel_watch()
        session.stop()

    plan = normalize_plan(plan_json, round_id=round_id)
    plan["proposer_usage"] = usage_total
    plan["proposer_model"] = response.get("model") or model
    plan["proposer_tool_turns"] = tool_turns
    plan["proposer_reasoning_summary"] = reasoning
    plan["proposer_raw_text"] = raw_text
    return plan
