"""The dataset scout: an optional agent that explores the data folder once,
before round 1, and writes shared/dataset_guide.md for the proposer and workers.

It runs in the same outcome-blind sandbox as the proposer (the cohort file is
overlaid with its id / slide / mpp columns only), writes only to its own
/scratch, and the controller copies the guide into /shared, where the later
sessions see it read-only.
"""

from __future__ import annotations

import json
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from .client import custom_tool_call_output, custom_tool_calls, output_text, response_id, responses_create
from .problem import ProblemSpec, write_public_cohort
from .sandbox import SandboxSession
from .tools import SHELL_TOOL_NAME, SHELL_TOOL_SPEC, bounded_tool_text, is_done, load_prompt

GUIDE_NAME = "dataset_guide.md"
GUIDE_MAX_CHARS = 12000
SCOUT_TOOL_TURNS = 12
SCOUT_WALL_CLOCK = 600
SCOUT_REQUEST_TIMEOUT = 180


def run_scout(
    *,
    spec: ProblemSpec,
    data_dir: str | Path,
    shared_dir: str | Path,
    run_root: str | Path,
    model: str,
    reasoning_effort: str = "medium",
    max_tool_turns: int = SCOUT_TOOL_TURNS,
    wall_clock_sec: int = SCOUT_WALL_CLOCK,
    command_timeout_sec: int = 120,
    on_event: Optional[Callable[[dict[str, Any]], None]] = None,
    cancel_event: Optional[threading.Event] = None,
) -> dict[str, Any]:
    """Explore, write the guide; returns {"status": "completed"|"no_guide", "turns"}."""
    scout_dir = Path(run_root) / "scout"
    scratch_dir = scout_dir / "sandbox"
    (scratch_dir / "logs").mkdir(parents=True, exist_ok=True)

    def emit(event: dict[str, Any]) -> None:
        if on_event:
            try:
                on_event(event)
            except Exception:
                pass

    instructions = load_prompt("scout.md", spec) + "\n\n# Research question\n" + spec.question
    public_cohort = write_public_cohort(spec, data_dir, scout_dir / "cohort_public.csv")
    session = SandboxSession(
        scratch_dir, data_dir=data_dir, shared_dir=shared_dir, command_timeout_sec=command_timeout_sec,
        file_overlays={f"/data/{spec.cohort_file}": public_cohort},
    )
    deadline = time.monotonic() + max(120, int(wall_clock_sec))
    pending: Any = f"Explore /data and write /scratch/{GUIDE_NAME}. You have {max_tool_turns} tool turns."
    previous: Optional[str] = None
    turns = 0
    stop_cancel_watch = session.watch_cancel(cancel_event)
    try:
        session.start()
        for turn_id in range(1, max_tool_turns + 3):
            if cancel_event is not None and cancel_event.is_set():
                raise RuntimeError("scout cancelled")
            remaining = deadline - time.monotonic()
            tools_open = turns < max_tool_turns and remaining > 60
            if not tools_open:
                if (scratch_dir / GUIDE_NAME).exists():
                    break
                pending = (pending if isinstance(pending, list) else []) + [{
                    "type": "message", "role": "user", "content": [{"type": "input_text", "text":
                        f"Budget exhausted. Write /scratch/{GUIDE_NAME} with one final command now, then reply DONE."}],
                }]
                if turns > max_tool_turns:  # the final command was spent too
                    break
            request: dict[str, Any] = {
                "model": model,
                "instructions": instructions,
                "input": pending,
                "store": True,
                "reasoning": {"effort": reasoning_effort},
                "tools": [SHELL_TOOL_SPEC],
                "parallel_tool_calls": False,
            }
            if previous:
                request["previous_response_id"] = previous
            response = responses_create(request, timeout=int(min(SCOUT_REQUEST_TIMEOUT, max(60, remaining))))
            (scout_dir / f"turn_{turn_id:02d}.response.json").write_text(
                json.dumps(response, indent=2, default=str), encoding="utf-8")
            previous = response_id(response)
            calls = custom_tool_calls(response, SHELL_TOOL_NAME)
            if not calls:
                if is_done(output_text(response)) or (scratch_dir / GUIDE_NAME).exists():
                    break
                pending = f"Write /scratch/{GUIDE_NAME}, then reply with exactly DONE."
                continue
            turns += 1
            outputs = []
            for call in calls:
                command = str(call.get("input") or "")
                emit({"type": "scout_tool_call", "turn_id": turn_id, "command_preview": command[:120]})
                result = session.exec(command, timeout_sec=int(min(command_timeout_sec, max(30, deadline - time.monotonic()))))
                (scratch_dir / "logs" / f"turn_{turn_id:02d}.stdout.txt").write_text(str(result.get("stdout") or ""), encoding="utf-8")
                (scratch_dir / "logs" / f"turn_{turn_id:02d}.stderr.txt").write_text(str(result.get("stderr") or ""), encoding="utf-8")
                outputs.append(custom_tool_call_output(str(call.get("call_id", "")), {
                    "exit_code": result.get("exit_code"),
                    "stdout": bounded_tool_text(result.get("stdout"), 6000),
                    "stderr": bounded_tool_text(result.get("stderr"), 3000),
                    "tool_turns_used": turns, "tool_turns_max": max_tool_turns,
                }))
                emit({"type": "scout_tool_result", "turn_id": turn_id, "exit_code": result.get("exit_code")})
            pending = outputs
    finally:
        stop_cancel_watch()
        session.stop()

    guide = scratch_dir / GUIDE_NAME
    if not guide.is_file():
        return {"status": "no_guide", "turns": turns}
    text = guide.read_text(encoding="utf-8", errors="replace")[:GUIDE_MAX_CHARS]
    target = Path(shared_dir) / GUIDE_NAME
    tmp = target.with_name(GUIDE_NAME + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    shutil.move(str(tmp), str(target))
    return {"status": "completed", "turns": turns}
