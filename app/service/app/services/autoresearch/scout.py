"""
Dataset scout for autoresearch.

Runs a single agent in a Docker sandbox to explore the data folder
and write a dataset_guide.md that future workers can reference.
"""

from __future__ import annotations

import json
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from .client import (
    custom_tool_call_output,
    custom_tool_calls,
    output_text,
    response_id,
    responses_create,
)
from .sandbox import SandboxSession


SHELL_TOOL_SPEC = {
    "type": "custom",
    "name": "shell_exec",
    "description": "Run one shell command in the sandbox to inspect the data.",
    "format": {"type": "text"},
}

SCOUT_PROMPT_TEMPLATE = """\
You are a dataset scout. Your job is to explore the data folder and write
a comprehensive dataset guide that other agents will use for analysis.

Your data is mounted read-only at /data. Write output to /shared.

{program_section}

Steps:
1. List the top-level contents of /data
2. Identify file types (CSV, zarr, images, etc.)
3. For CSV/JSON files: read headers, sample rows, describe columns
4. For zarr directories: inspect the group structure, list datasets with
   shapes and dtypes, read small arrays or attributes
5. Note any important patterns (coordinate systems, naming conventions,
   relationships between files)
6. Pay special attention to data structures and columns most relevant to
   the research program above
7. Write a clear, concise dataset_guide.md to /shared/dataset_guide.md

The guide should be structured with:
- Overview of the dataset
- File inventory
- Schema details for each data type
- Important rules or conventions discovered
- Which data structures are most relevant to the research objective and why
- Example code snippets for loading key data structures

Use the shell_exec tool to run commands. One command at a time.
When done writing /shared/dataset_guide.md, respond with exactly DONE.
"""

MINI_SCOUT_PROMPT_TEMPLATE = """\
You are a dataset scout running a focused exploration to answer a specific question.

Your data is mounted read-only at /data. Write any output to /shared.

## Exploration request

{exploration_request}

Answer the request by inspecting the relevant files directly. Be concise and
precise — report exact values, shapes, dtypes, and distributions rather than
general descriptions. Do not do a broad dataset survey; only answer the question
above.

Append your findings as a new section to /shared/dataset_guide.md using a
heredoc shell command. Format the section as:

## Mini-explore: {exploration_request_short}
<your findings here>

When done, respond with exactly DONE.
"""


def run_scout(
    *,
    data_dir: str | Path,
    shared_dir: str | Path,
    program_text: str = "",
    log_dir: str | Path | None = None,
    sandbox_backend: str = "docker",
    sandbox_image: str = "tissuelab-autoresearch-worker",
    sandbox_auto_build: bool = True,
    command_timeout_sec: int = 120,
    wall_clock_sec: int = 300,
    model: str = "gpt-5.4",
    reasoning_effort: str = "medium",
    on_event: Optional[Callable] = None,
    exploration_request: str = "",
    max_turns: int = 0,
) -> Dict[str, Any]:
    """
    Run the dataset scout to explore /data and write a guide.

    When exploration_request is set, runs a focused mini-explore instead of a
    full dataset survey and appends findings to the existing dataset_guide.md.
    max_turns caps the number of shell_exec turns (0 = unlimited).

    Returns dict with status, guide_path, turns, and guide_excerpt.
    """
    import tempfile

    if exploration_request.strip():
        short = exploration_request.strip()[:80]
        scout_prompt = MINI_SCOUT_PROMPT_TEMPLATE.format(
            exploration_request=exploration_request.strip(),
            exploration_request_short=short,
        )
    elif program_text.strip():
        program_section = (
            "## Research Program\n\n"
            "The following research program describes what the agents will be working on. "
            "Use this to prioritize your exploration — focus on the data structures, columns, "
            "and files most relevant to this objective.\n\n"
            f"{program_text.strip()}"
        )
        scout_prompt = SCOUT_PROMPT_TEMPLATE.format(program_section=program_section)
    else:
        scout_prompt = SCOUT_PROMPT_TEMPLATE.format(program_section="")

    log_file = None
    if log_dir:
        log_path = Path(log_dir) / "scout_log.jsonl"
        log_file = open(log_path, "a", encoding="utf-8")

    scratch_dir = Path(tempfile.mkdtemp(prefix="tl_scout_"))
    session = SandboxSession(
        scratch_dir,
        data_dir=str(data_dir),
        shared_dir=str(shared_dir),
        backend=sandbox_backend,
        image=sandbox_image,
        auto_build=sandbox_auto_build,
        command_timeout_sec=command_timeout_sec,
    )

    deadline = time.monotonic() + max(60, int(wall_clock_sec))
    if exploration_request.strip():
        pending_input: Any = (
            "Answer the exploration request by inspecting the relevant files. "
            "Then append your findings to /shared/dataset_guide.md and respond DONE."
        )
    else:
        pending_input: Any = "Start exploring /data and write /shared/dataset_guide.md."
    previous_response: Optional[str] = None
    turn_id = 0
    sent_wrapup = False

    session.start()
    try:
        while True:
            turn_id += 1
            remaining = max(1, int(deadline - time.monotonic()))

            if remaining <= 10:
                if not sent_wrapup:
                    # Give the model one final turn to write the guide
                    sent_wrapup = True
                    pending_input = (
                        "TIME IS UP. You must write /shared/dataset_guide.md RIGHT NOW "
                        "with whatever you have gathered so far. Use a single shell_exec "
                        "call with a heredoc to write the file, then respond DONE."
                    )
                    previous_response = None
                else:
                    break

            payload = {
                "model": model,
                "instructions": scout_prompt,
                "input": pending_input,
                "tools": [SHELL_TOOL_SPEC],
                "parallel_tool_calls": False,
                "store": True,
                "reasoning": {"effort": reasoning_effort, "summary": "auto"},
            }
            if previous_response:
                payload["previous_response_id"] = previous_response

            try:
                response = responses_create(payload, timeout=min(max(remaining, 30), 120))
            except Exception as exc:
                return {"status": "error", "error": str(exc), "turns": turn_id}

            text = output_text(response)
            tool_calls_list = custom_tool_calls(response, "shell_exec")
            previous_response = response_id(response)

            if tool_calls_list:
                tool_call = tool_calls_list[0]
                command = str(tool_call.get("input", "")).strip()
                if not command:
                    break

                if on_event:
                    thought = ""
                    for item in response.get("output", []):
                        if item.get("type") == "reasoning":
                            for s in item.get("summary") or []:
                                t = s.get("text", "").strip()
                                if t:
                                    lines = [l.strip() for l in t.splitlines() if l.strip()]
                                    if lines:
                                        thought = lines[0].replace("**", "")[:120]
                                    break
                    on_event({
                        "type": "scout_tool_call",
                        "turn_id": turn_id,
                        "thought": thought,
                        "command_preview": command.splitlines()[0][:100],
                    })

                exec_timeout = min(command_timeout_sec, max(30, int(deadline - time.monotonic())))
                result = session.exec(command, timeout_sec=exec_timeout)

                if log_file:
                    log_file.write(json.dumps({
                        "turn": turn_id,
                        "command": command,
                        "exit_code": result.get("exit_code"),
                        "stdout": result.get("stdout", ""),
                        "stderr": result.get("stderr", ""),
                    }) + "\n")
                    log_file.flush()

                if on_event:
                    on_event({
                        "type": "scout_tool_result",
                        "turn_id": turn_id,
                        "exit_code": result.get("exit_code", -1),
                    })

                pending_input = [
                    custom_tool_call_output(
                        str(tool_call.get("call_id", "")),
                        {
                            "exit_code": result.get("exit_code"),
                            "stdout": result.get("stdout", ""),
                            "stderr": result.get("stderr", ""),
                        },
                    )
                ]
                continue

            if text.strip().startswith("DONE"):
                break

            if sent_wrapup:
                break

            # Enforce max_turns if set
            if max_turns > 0 and turn_id >= max_turns:
                break

            continue

        guide_path = Path(shared_dir) / "dataset_guide.md"
        guide_excerpt = ""
        if guide_path.exists():
            full_text = guide_path.read_text(encoding="utf-8")
            guide_excerpt = full_text[-2000:]
            return {
                "status": "ok",
                "guide_path": str(guide_path),
                "turns": turn_id,
                "guide_size": guide_path.stat().st_size,
                "guide_excerpt": guide_excerpt,
            }
        return {
            "status": "no_guide",
            "error": "Scout finished without writing dataset_guide.md",
            "turns": turn_id,
            "guide_excerpt": "",
        }
    finally:
        if log_file:
            log_file.close()
        session.stop()
