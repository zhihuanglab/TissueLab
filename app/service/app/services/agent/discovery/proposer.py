"""The proposer: one model call per candidate that commits to one plan.

It gets the research question, the dataset scout's guide (when there is one),
the accepted panel and the structured feedback of prior rounds, and returns
exactly one JSON plan. With several workers per round it is asked once per
worker, each time seeing what was already proposed this round, so the plans
differ. Requests and responses are saved under round_NNNN/proposer/.

It never touches the data: what it learns about outcomes comes only from the
aggregated per-round feedback.
"""
from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any, Optional

from .client import output_text, response_id, responses_create
from .problem import ProblemSpec
from .tools import load_prompt

PROPOSER_TIMEOUT_SEC = 600
PROPOSER_MAX_ATTEMPTS = 3
PROPOSER_RETRY_BACKOFF_SEC = 10
MAX_JSON_NUDGES = 2
REQUIRED_VARIATION_COUNT = 3


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


def run_proposer(
    *,
    round_dir: str | Path,
    spec: ProblemSpec,
    accepted_panel_summary: dict[str, Any],
    results_log_text: str,
    round_id: int,
    model: str,
    reasoning_effort: str,
    dataset_guide_text: str = "",
    proposed_this_round: list[dict[str, Any]] | None = None,
    slot: int = 1,
    cancel_event: Optional[threading.Event] = None,
) -> dict[str, Any]:
    """Return a normalized plan dict for worker `slot` of this round."""
    prop_dir = Path(round_dir) / "proposer" / f"slot_{slot}"
    prop_dir.mkdir(parents=True, exist_ok=True)

    prompt = load_prompt("proposer.md", spec)
    # Static context (identical every round) lives in `instructions` so the API prompt
    # cache covers it across rounds; only the per-round state goes into `input`.
    instructions = (
        prompt
        + "\n\n# Research question\n" + spec.question
        + ("\n\n# Dataset guide (written by the dataset scout, outcome-blind)\n" + dataset_guide_text[:12000]
           if dataset_guide_text else "")
    )
    payload: dict[str, Any] = {
        "accepted_panel": accepted_panel_summary,
        "recent_results": results_log_text or "(no prior rounds)",
        "round_id": round_id,
        "required_variation_count": REQUIRED_VARIATION_COUNT,
    }
    if proposed_this_round:
        # Parallel workers: each tests a different hypothesis.
        payload["already_proposed_this_round"] = [
            {"candidate_id": p.get("candidate_id"), "scientific_question": p.get("scientific_question"),
             "approach": p.get("approach")}
            for p in proposed_this_round
        ]
        payload["instruction"] = "Propose a hypothesis clearly different from those already proposed this round."
    pending: Any = json.dumps(payload, indent=2) + "\n\nReply with ONLY the JSON plan object."

    usage_total = {"input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "reasoning_tokens": 0, "calls": 0}
    reasoning: list[str] = []
    previous: Optional[str] = None
    response: dict[str, Any] = {}
    raw_text = ""
    plan_json: dict[str, Any] = {}
    for attempt in range(1, MAX_JSON_NUDGES + 2):
        if cancel_event is not None and cancel_event.is_set():
            raise RuntimeError("proposer cancelled")
        request: dict[str, Any] = {
            "model": model,
            "instructions": instructions,
            "input": pending,
            "store": True,
            "reasoning": {"effort": reasoning_effort, "summary": "auto"},
        }
        if previous:
            request["previous_response_id"] = previous
        response = _create_with_retry(request, timeout=PROPOSER_TIMEOUT_SEC)
        (prop_dir / f"turn_{attempt:02d}.response.json").write_text(json.dumps(response, indent=2, default=str), encoding="utf-8")
        previous = response_id(response)
        _sum_usage(usage_total, response.get("usage"))
        reasoning.extend(_reasoning_summary(response))
        raw_text = output_text(response)
        plan_json = parse_json(raw_text) if raw_text else {}
        if plan_json.get("variations") or plan_json.get("candidate_id"):
            missing_sign = _variations_missing_sign(plan_json)
            if not missing_sign:
                break
            pending = (
                "Every variation needs an integer `expected_sign` (+1 or -1): the pre-registered sign of "
                f"the covariate-adjusted correlation between that variation and {spec.outcome}. "
                f"Missing for: {missing_sign}. Reply with the complete JSON object again."
            )
            continue
        pending = "Reply with exactly one JSON object following the schema (no prose, no code fences)."

    plan = normalize_plan(plan_json, round_id=round_id)
    plan["proposer_usage"] = usage_total
    plan["proposer_model"] = response.get("model") or model
    plan["proposer_reasoning_summary"] = reasoning
    plan["proposer_raw_text"] = raw_text
    return plan
