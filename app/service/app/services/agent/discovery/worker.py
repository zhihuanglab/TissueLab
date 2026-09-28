"""
Worker agent for autoresearch.

Each worker receives one candidate biomarker brief and runs in a sandboxed
environment with shell access to the user's data. It explores, analyzes,
and produces a runnable biomarker script, with any extra artifacts optional.
"""

from __future__ import annotations

import json
import re
import shutil
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .client import (
    custom_tool_call_output,
    custom_tool_calls,
    output_text,
    response_id,
    responses_create,
)
from .shared_lib_source.shared_analysis.artifacts import (
    coerce_results_payload,
    write_results_payload,
)
from .sandbox import SandboxSession


REPORT_NAME = "report.md"
RESULT_NAME = "result.py"
RESULTS_NAME = "results.json"
SHELL_TOOL_NAME = "shell_exec"
SHELL_TOOL_SPEC = {
    "type": "custom",
    "name": SHELL_TOOL_NAME,
    "description": (
        "Run one shell command batch inside the worker sandbox. "
        "Use it to inspect the data folder, run analysis scripts, and write files into /scratch. "
        "Input must be raw shell text, not JSON."
    ),
    "format": {"type": "text"},
}
TOOL_SPECS = [SHELL_TOOL_SPEC]

PROMPTS_DIR = Path(__file__).parent / "prompts"
TEMPLATES_DIR = Path(__file__).parent / "shared_lib_source" / "templates"


def _load_prompt(name: str) -> str:
    return (PROMPTS_DIR / name).read_text(encoding="utf-8")


def _is_done(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False
    if stripped == "DONE" or stripped.startswith("DONE\n"):
        return True
    lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    return bool(lines) and lines[-1] == "DONE"


def _parse_report(report_path: Path) -> dict:
    text = report_path.read_text() if report_path.exists() else ""
    sections: dict[str, list[str]] = {}
    current = "body"
    sections[current] = []
    for line in text.splitlines():
        match = re.match(r"^#+\s*(.+?)\s*$", line.strip())
        if match:
            current = match.group(1).strip().lower()
            sections.setdefault(current, [])
            continue
        sections.setdefault(current, []).append(line.rstrip())
    parsed = {k: "\n".join(v).strip() for k, v in sections.items()}
    summary = parsed.get("summary", "").splitlines()[0].strip() if parsed.get("summary") else ""
    return {
        "report_text": text,
        "summary": summary,
        "rationale": parsed.get("rationale", ""),
    }


def _fallback_worker_summary(worker_brief: dict) -> dict[str, str]:
    summary = str(
        worker_brief.get("candidate_id")
        or worker_brief.get("scientific_question")
        or worker_brief.get("worker_name")
        or ""
    ).strip()
    rationale = str(worker_brief.get("approach") or worker_brief.get("notes") or "").strip()
    return {"report_text": "", "summary": summary, "rationale": rationale}


def _persist_scratch_artifacts(
    *,
    worker_dir: Path,
    scratch_dir: Path,
    results: dict[str, Any],
) -> dict[str, Any]:
    persisted = dict(results or {})
    artifacts = dict(persisted.get("artifacts") or {})
    if not artifacts:
        return persisted

    sandbox_dir = worker_dir / "sandbox"
    sandbox_dir.mkdir(parents=True, exist_ok=True)

    for artifact_name, artifact_ref in list(artifacts.items()):
        if artifact_ref is None:
            continue
        ref_text = str(artifact_ref).strip()
        if not ref_text:
            continue
        ref_path = Path(ref_text)
        source: Path | None = None
        target: Path | None = None

        if ref_path.is_absolute():
            if str(ref_path).startswith("/scratch/"):
                relative = ref_path.relative_to("/scratch")
                source = scratch_dir / relative
                target = sandbox_dir / relative
            else:
                continue
        else:
            source = scratch_dir / ref_path
            target = sandbox_dir / ref_path

        if source is None or target is None or not source.exists() or not source.is_file():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            same_file = source.resolve() == target.resolve()
        except FileNotFoundError:
            same_file = False
        if not same_file:
            shutil.copy2(source, target)
        if not ref_path.is_absolute():
            artifacts[artifact_name] = f"/scratch/{ref_path.as_posix()}"

    persisted["artifacts"] = artifacts
    return persisted


def _extract_thought(response: dict) -> str:
    """Extract a chain-of-thought summary from the model's reasoning or text output."""
    # Try reasoning summary first (most informative)
    for item in response.get("output", []):
        if item.get("type") != "reasoning":
            continue
        for summary_item in item.get("summary") or []:
            text = summary_item.get("text", "").strip()
            if not text:
                continue
            lines = [l.strip() for l in text.splitlines() if l.strip()]
            if not lines:
                continue
            thought = lines[0].replace("**", "")
            if len(thought) > 120:
                thought = thought[:117] + "..."
            return thought

    # Fallback: try message text output
    for item in response.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content") or []:
            text = (content.get("text") or "").strip()
            if text:
                first_line = text.splitlines()[0].strip()
                if len(first_line) > 120:
                    first_line = first_line[:117] + "..."
                return first_line

    return ""


def _write_worker_context(
    scratch_dir: Path,
    *,
    worker_brief: dict,
    program_text: str,
    shared_dir: Path | None = None,
    shared_runtime_manifest: dict[str, Any] | None = None,
    preserve_existing_result: bool = False,
) -> None:
    """Write context files into the worker's scratch directory."""
    scratch_dir.mkdir(parents=True, exist_ok=True)
    (scratch_dir / "worker_brief.json").write_text(json.dumps(worker_brief, indent=2))
    (scratch_dir / "program.md").write_text(program_text)
    context_bundle: dict[str, Any] = {
        "worker_brief": worker_brief,
    }
    if shared_dir is not None:
        runtime_manifest_path = shared_dir / "cache" / "runtime_manifest.json"
        slide_manifest_path = shared_dir / "cache" / "slide_manifest.json"
        cohort_summary_path = shared_dir / "cache" / "cohort_summary.json"
        quickstart_path = shared_dir / "cache" / "runtime_quickstart.md"
        guide_path = shared_dir / "dataset_guide.md"
        slide_manifest = _load_json_file(slide_manifest_path) if slide_manifest_path.exists() else {}
        context_bundle.update(
            {
                "runtime_manifest": shared_runtime_manifest or (
                    _load_json_file(runtime_manifest_path) if runtime_manifest_path.exists() else {}
                ),
                "cohort_summary": _load_json_file(cohort_summary_path) if cohort_summary_path.exists() else {},
                "slide_manifest_head": {
                    "data_root": slide_manifest.get("data_root"),
                    "cohort_rows": slide_manifest.get("cohort_rows"),
                    "slide_count": slide_manifest.get("slide_count"),
                    "slides": slide_manifest.get("slides", [])[:5],
                },
                "runtime_quickstart_excerpt": _read_text_excerpt(quickstart_path, max_chars=2000),
                "dataset_guide_excerpt": _read_text_excerpt(guide_path, max_chars=4000),
            }
        )
    (scratch_dir / "context_bundle.json").write_text(json.dumps(context_bundle, indent=2))
    template_path = (
        (shared_dir / "templates" / "worker_analysis_template.py")
        if shared_dir is not None
        else TEMPLATES_DIR / "worker_analysis_template.py"
    )
    if not template_path.exists():
        template_path = TEMPLATES_DIR / "worker_analysis_template.py"
    if template_path.exists() and not (preserve_existing_result and (scratch_dir / RESULT_NAME).exists()):
        shutil.copy2(template_path, scratch_dir / RESULT_NAME)


def _load_shared_runtime_manifest(shared_dir: Optional[str | Path]) -> dict:
    if not shared_dir:
        return {}
    manifest_path = Path(shared_dir) / "cache" / "runtime_manifest.json"
    if not manifest_path.exists():
        return {}
    try:
        return json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _load_json_file(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _read_text_excerpt(path: Path, *, max_chars: int) -> str:
    if not path.exists() or max_chars <= 0:
        return ""
    return path.read_text(encoding="utf-8")[:max_chars]


def run_worker(
    *,
    worker_brief: dict,
    round_dir: str | Path,
    program_text: str,
    data_dir: str | Path,
    shared_dir: Optional[str | Path] = None,
    model: str = "gpt-5.4",
    reasoning_effort: str = "medium",
    worker_wall_clock_sec: int = 600,
    final_synthesis_buffer_sec: int = 120,
    sandbox_backend: str = "docker",
    sandbox_image: str = "tissuelab-autoresearch-worker",
    sandbox_auto_build: bool = True,
    command_timeout_sec: int = 300,
    on_event: Optional[Callable] = None,
) -> dict:
    """
    Run a single worker agent to completion.

    Returns a dict with worker_name, candidate/report paths, summary, etc.
    """
    round_dir = Path(round_dir)
    shared_dir_path = Path(shared_dir) if shared_dir else None
    worker_name = worker_brief["worker_name"]
    worker_dir = round_dir / worker_name
    worker_dir.mkdir(parents=True, exist_ok=True)

    scratch_dir = worker_dir / "sandbox"
    if scratch_dir.exists():
        shutil.rmtree(scratch_dir, ignore_errors=True)
    scratch_dir.mkdir(parents=True, exist_ok=True)
    shared_runtime_manifest = _load_shared_runtime_manifest(shared_dir)

    _write_worker_context(
        scratch_dir,
        worker_brief=worker_brief,
        program_text=program_text,
        shared_dir=shared_dir_path,
        shared_runtime_manifest=shared_runtime_manifest,
    )

    session = SandboxSession(
        scratch_dir,
        data_dir=data_dir,
        shared_dir=shared_dir,
        backend=sandbox_backend,
        image=sandbox_image,
        auto_build=sandbox_auto_build,
        command_timeout_sec=command_timeout_sec,
    )
    prompt = _load_prompt("worker_prompt.md")
    turn_summaries: list[dict] = []
    deadline = time.monotonic() + max(60, int(worker_wall_clock_sec))
    final_buffer = max(30, int(final_synthesis_buffer_sec))
    pending_input: Any = (
        "Start the worker task by reading /scratch/context_bundle.json. "
        "Use shell_exec freely to inspect the data and validate your biomarker logic. "
        "Start from the pre-seeded /scratch/result.py template instead of writing from an empty file. "
        "Do not re-discover basic dataset context if it is already in /scratch/context_bundle.json. "
        f"Return DONE only after writing /scratch/{RESULT_NAME}."
    )
    previous_response: Optional[str] = None

    session.start()
    try:
        turn_id = 1
        sent_wrapup = False
        while True:
            remaining = max(1, int(deadline - time.monotonic()))

            # Hard wrap-up: override pending_input with a forceful instruction and
            # reset the conversation chain so the model treats it as urgent.
            if remaining <= final_buffer and not sent_wrapup:
                sent_wrapup = True
                pending_input = (
                    f"TIME IS ALMOST UP — you have roughly {remaining} seconds left. "
                    f"STOP all new analysis immediately. "
                    f"Write /scratch/{RESULT_NAME} RIGHT NOW "
                    f"using whatever biomarker logic you have so far — a partial result is far better than none. "
                    f"Use a single shell_exec call if possible, then respond DONE."
                )
                previous_response = None

            # Escalating synthesis pressure (soft hints, complement to the hard wrap-up)
            hints: list[str] = []
            if len(turn_summaries) >= 4:
                hints.append("You have enough context. Prefer writing a first-pass result over more exploration.")
            if len(turn_summaries) >= 6:
                hints.append("Wrap up soon. Only run another command if it directly validates your result.")
                if len(turn_summaries) >= 8:
                    hints.append(
                    "Stop exploring. Write /scratch/result.py, then respond DONE."
                    )

            payload_context = {
                "context_bundle_path": "/scratch/context_bundle.json",
                "program_path": "/scratch/program.md",
                "result_template_path": f"/scratch/{RESULT_NAME}",
                "data_root": session.describe()["data_root"],
                "remaining_wall_clock_sec": remaining,
                "tool_calls_completed": len(turn_summaries),
                "completion_hint": " ".join(hints).strip(),
            }
            prompt_text = prompt + "\n\n" + json.dumps(payload_context, indent=2)

            # Save turn artifacts
            turn_prefix = worker_dir / f"turn_{turn_id:02d}"
            (turn_prefix.with_suffix(".prompt.txt")).write_text(prompt_text)

            try:
                api_payload = {
                    "model": model,
                    "instructions": prompt_text,
                    "input": pending_input,
                    "tools": TOOL_SPECS,
                    "parallel_tool_calls": True,
                    "store": True,
                    "reasoning": {"effort": reasoning_effort, "summary": "auto"},
                }
                if previous_response:
                    api_payload["previous_response_id"] = previous_response

                response = responses_create(api_payload, timeout=min(remaining, 300))
            except Exception as exc:
                (turn_prefix.with_suffix(".error.json")).write_text(
                    json.dumps({"error": str(exc), "traceback": traceback.format_exc()}, indent=2)
                )
                raise RuntimeError(
                    f"{worker_name} failed on turn {turn_id}: {exc}"
                ) from exc

            (turn_prefix.with_suffix(".response.json")).write_text(json.dumps(response, indent=2))
            output = output_text(response)
            (turn_prefix.with_suffix(".output.txt")).write_text(output)
            tool_calls_list = custom_tool_calls(response)
            previous_response = response_id(response)

            # Handle tool calls
            if tool_calls_list:
                shell_calls = [call for call in tool_calls_list if call.get("name") == SHELL_TOOL_NAME]
                unknown_calls = [
                    call for call in tool_calls_list
                    if call.get("name") != SHELL_TOOL_NAME
                ]
                if unknown_calls:
                    raise RuntimeError(
                        f"{worker_name} returned unknown tool calls on turn {turn_id}: "
                        + ", ".join(str(call.get("name")) for call in unknown_calls)
                    )
                if len(shell_calls) > 1:
                    raise RuntimeError(
                        f"{worker_name} returned {len(shell_calls)} shell_exec calls on turn {turn_id}"
                    )

                thought = _extract_thought(response)
                tool_outputs = []
                tool_trace: list[dict[str, Any]] = []

                if shell_calls:
                    tool_call = shell_calls[0]
                    command = str(tool_call.get("input", "")).strip()
                    if not command:
                        raise RuntimeError(f"{worker_name} returned empty shell_exec on turn {turn_id}")

                    (turn_prefix.with_suffix(".command.sh")).write_text(command + "\n")
                    exec_timeout = min(command_timeout_sec, max(1, int(deadline - time.monotonic())))

                    if on_event:
                        on_event({
                            "type": "worker_tool_call",
                            "worker_name": worker_name,
                            "turn_id": turn_id,
                            "tool_name": SHELL_TOOL_NAME,
                            "thought": thought,
                            "command_preview": command.splitlines()[0][:160] if command else "",
                        })

                    result = session.exec(command, timeout_sec=exec_timeout)
                    (turn_prefix.with_suffix(".exec.json")).write_text(json.dumps(result, indent=2))
                    tool_trace.append(
                        {
                            "tool_name": SHELL_TOOL_NAME,
                            "input": command,
                            "output_preview": json.dumps(
                                {
                                    "exit_code": result.get("exit_code"),
                                    "stdout": (result.get("stdout", "") or "")[:500],
                                    "stderr": (result.get("stderr", "") or "")[:500],
                                },
                                ensure_ascii=True,
                            ),
                        }
                    )

                    if on_event:
                        on_event({
                            "type": "worker_tool_result",
                            "worker_name": worker_name,
                            "turn_id": turn_id,
                            "tool_name": SHELL_TOOL_NAME,
                            "exit_code": result.get("exit_code"),
                        })

                    tool_outputs.append(
                        custom_tool_call_output(
                            str(tool_call.get("call_id", "")),
                            {
                                "exit_code": result.get("exit_code"),
                                "stdout": result.get("stdout", ""),
                                "stderr": result.get("stderr", ""),
                            },
                        )
                    )

                if tool_trace:
                    (turn_prefix.with_suffix(".tools.json")).write_text(json.dumps(tool_trace, indent=2))
                turn_summaries.append(
                    {
                        "turn_id": turn_id,
                        "tool_names": [SHELL_TOOL_NAME] if shell_calls else [],
                        "kind": "shell",
                    }
                )

                pending_input = tool_outputs
                turn_id += 1

                if time.monotonic() >= deadline:
                    if not sent_wrapup:
                        # Let the wrap-up logic fire on next iteration
                        continue
                    raise RuntimeError(f"{worker_name} exceeded wall-clock budget")
                continue

            # Check if worker is done
            if _is_done(output):
                result_src = scratch_dir / RESULT_NAME
                results_src = scratch_dir / RESULTS_NAME
                report_src = scratch_dir / REPORT_NAME
                if not result_src.exists():
                    raise RuntimeError(
                        f"{worker_name} responded DONE without writing {RESULT_NAME}"
                    )
                result_path = worker_dir / RESULT_NAME
                shutil.copy2(result_src, result_path)
                results_path = None
                if results_src.exists():
                    results_path = worker_dir / RESULTS_NAME
                    shutil.copy2(results_src, results_path)
                    raw_results = json.loads(results_path.read_text(encoding="utf-8"))
                    normalized_results = coerce_results_payload(raw_results)
                    normalized_results = _persist_scratch_artifacts(
                        worker_dir=worker_dir,
                        scratch_dir=scratch_dir,
                        results=normalized_results,
                    )
                    write_results_payload(results_path, normalized_results)
                report_path = None
                if report_src.exists():
                    report_path = worker_dir / REPORT_NAME
                    shutil.copy2(report_src, report_path)
                report = _parse_report(report_path) if report_path is not None else _fallback_worker_summary(worker_brief)
                return {
                    "worker_name": worker_name,
                    "worker_dir": str(worker_dir),
                    "results_path": str(results_path) if results_path is not None else "",
                    "result_path": str(result_path),
                    "report_path": str(report_path) if report_path is not None else "",
                    "summary": report["summary"],
                    "rationale": report["rationale"],
                    "results_text": results_path.read_text() if results_path is not None else "",
                    "report_text": report["report_text"],
                    "result_text": result_path.read_text(),
                    "turn_summaries": turn_summaries,
                }

            raise RuntimeError(
                f"{worker_name} response on turn {turn_id} was neither a tool call nor DONE"
            )
    finally:
        session.stop()
