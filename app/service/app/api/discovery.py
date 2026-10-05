"""Discovery routes (mounted under /api/agent): the problem, run folders, and a run's event stream.

A run is its folder, <workspace>/autoresearch_runs/<run_id>; the loop lives in
:mod:`app.services.agent.discovery`.
"""
import asyncio
import contextlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core.auth import AuthUser, get_auth_user
from app.core.errors import AppError, AppErrors
from app.core.response import error_response, success_response
from app.services.agent.discovery import (
    ProblemError,
    get_discovery_run_manager,
    run_folder,
    workspace_data_dir,
)
from app.services.agent.discovery.client import unavailable_reason
from app.services.agent.discovery.loop import (
    FINDINGS_NAME,
    feedback_path,
    guide_recorded,
    load_results_rows,
    read_run_state,
    run_status_on_disk,
    _write_text_atomic,
)
from app.services.agent.discovery.problem import PROGRAM_FILENAME, read_run_config
from app.services.agent.discovery.scout import GUIDE_NAME
from app.services.agent.discovery.sandbox import RUNS_DIRNAME, docker_unavailable_reason
from app.services.file_manager.common import (
    assert_can_access_path,
    assert_can_access_path_async,
    assert_can_write_path,
    assert_can_write_path_async,
)

discovery_router = APIRouter()


class StartRunRequest(BaseModel):
    task: str                       # the program in plain words, or program.md with its header
    workspace_path: str
    rounds: int = Field(3, ge=1, le=50)
    reasoning_effort: Literal["low", "medium", "high"] = "high"   # the panel's choices
    worker_wall_clock_sec: int = Field(1800, ge=120, le=7200)
    dataset_scout: bool = True      # explore the folder first, write a dataset guide
    # instead of exploring: the guide of an earlier run in this workspace (its run id)
    reuse_guide_from: Optional[str] = None
    # plans (and parallel workers) per round; at most one candidate per round is admitted
    workers_per_round: int = Field(1, ge=1, le=5)


class ResumeRunRequest(BaseModel):
    run_root_path: str
    additional_rounds: Optional[int] = Field(None, ge=1, le=50)


async def _assert_run_prerequisites() -> None:
    """A run needs the Responses API and a working Docker; fail before spending on either."""
    reason = unavailable_reason() or await asyncio.to_thread(docker_unavailable_reason)
    if reason:
        raise AppErrors.NOT_IMPLEMENTED(reason)


def _run_summary(run_root: Path) -> Dict[str, Any]:
    """A run folder as the panel lists it."""
    state = read_run_state(run_root)
    rounds = int((state.get("config") or {}).get("rounds", 0) or 0)
    next_round_id = int(state.get("next_round_id", 1) or 1)
    if get_discovery_run_manager().is_active(run_root.name):
        status = "running"
    elif rounds and next_round_id > rounds:
        status = "completed"
    else:
        status = "incomplete"
    return {
        "run_id": run_root.name,
        "run_root_path": str(run_root),
        "updated_at": datetime.fromtimestamp(run_root.stat().st_mtime, tz=timezone.utc).isoformat(),
        "status": status,
        # the user pressed Stop (still resumable, so status stays "incomplete")
        "stopped": status == "incomplete" and state.get("stopped") == "cancelled",
        "rounds": rounds,
        "next_round_id": next_round_id,
        # its scout's guide, which a new run here may reuse
        "has_guide": guide_recorded(state) and (run_root / "shared" / GUIDE_NAME).is_file(),
        "question": _run_question(run_root),
        **_cohort_info(run_root),
    }


QUESTION_PREVIEW_CHARS = 120


def _run_question(run_root: Path) -> Optional[str]:
    """The first line of the run's research program (its saved configuration question), for the list."""
    try:
        question = read_run_config(run_root).question
    except (OSError, UnicodeDecodeError, ProblemError):
        return None
    line = next((line.strip() for line in question.splitlines() if line.strip()), "")
    if len(line) > QUESTION_PREVIEW_CHARS:
        line = line[:QUESTION_PREVIEW_CHARS - 1].rstrip() + "\u2026"
    return line or None


def _run_outcome(run_root: Optional[Path]) -> Optional[str]:
    """The column the run predicts (from its saved configuration), for the panel to show."""
    try:
        return read_run_config(run_root).outcome
    except (TypeError, OSError, UnicodeDecodeError, ProblemError):
        return None


def _cohort_info(run_root: Optional[Path]) -> Dict[str, Any]:
    try:
        spec = read_run_config(run_root)
        return {"cohort_file": spec.cohort_file, "cohort_selection_reason": spec.cohort_selection_reason}
    except (TypeError, OSError, UnicodeDecodeError, ProblemError):
        return {"cohort_file": None, "cohort_selection_reason": None}


def _load_worker_steps(worker_dir: Path, run_root: Path) -> List[Dict[str, Any]]:
    """Restore saved shell steps without following paths outside the authorized run."""
    steps = []
    def read(path: Path, limit: int | None = None) -> str:
        if not path.resolve().is_relative_to(run_root.resolve()) or not path.is_file():
            return ""
        with path.open(encoding="utf-8", errors="replace") as stream:
            return stream.read(limit) if limit else stream.read()
    for command_path in sorted(worker_dir.glob("turn_*.command.sh")):
        turn = command_path.name.split(".")[0]
        command = read(command_path)
        if not command:
            continue
        result_text = read(worker_dir / f"{turn}.exec.json")
        try:
            code = json.loads(result_text).get("exit_code") if result_text else None
        except (ValueError, AttributeError):
            code = None
        steps.append({"turnId": int(turn.split("_")[1]), "thought": "", "command": command,
                      "exitCode": code, "status": "stopped" if code is None else "done" if code == 0 else "error",
                      "stdout": read(worker_dir / "sandbox" / "logs" / f"{turn}.stdout.txt", 6000),
                      "stderr": read(worker_dir / "sandbox" / "logs" / f"{turn}.stderr.txt", 6000)})
    return steps


def _load_run(run_root: Path) -> Dict[str, Any]:
    if not (run_root / "run_state.json").exists():
        raise FileNotFoundError(f"Not a discovery run: {run_root}")
    journal: List[Dict[str, Any]] = []
    for row in load_results_rows(run_root):
        round_id = int(row.get("round_id") or 0)
        fb_path = feedback_path(run_root / f"round_{round_id:04d}", row.get("worker"))
        summary = ""
        if fb_path.exists():
            summary = json.loads(fb_path.read_text(encoding="utf-8")).get("summary", "")
        journal.append({
            "roundId": round_id,
            "focus": row.get("description", ""),
            "summary": summary or f"{row.get('candidate_id', '')}: {row.get('decision', '')}",
            "toolCalls": _load_worker_steps(
                run_root / f"round_{round_id:04d}" / (
                    f"round_{round_id:04d}_worker_{row['worker']}" if row.get("worker")
                    else f"round_{round_id:04d}_worker"), run_root),
        })
    program_path = run_root / PROGRAM_FILENAME
    findings_path = run_root / FINDINGS_NAME
    return {
        **_run_summary(run_root),
        "program_text": program_path.read_text(encoding="utf-8") if program_path.exists() else "",
        "outcome": _run_outcome(run_root),
        "journal": journal,
        "final_summary": findings_path.read_text(encoding="utf-8") if findings_path.exists() else None,
    }


@discovery_router.get("/v1/discovery/program")
def get_program(data_dir: str, auth_user: AuthUser = Depends(get_auth_user)):
    """The workspace's program.md, as written, for the panel to pre-fill."""
    try:
        assert_can_access_path(auth_user, data_dir, "read research program")
        program_path = workspace_data_dir(data_dir) / PROGRAM_FILENAME
        text = program_path.read_text(encoding="utf-8") if program_path.is_file() else ""
        return success_response({"text": text})
    except AppError:
        raise
    except Exception as exc:
        return error_response(str(exc))


class SaveProgramRequest(BaseModel):
    workspace_path: str
    text: str


@discovery_router.put("/v1/discovery/program")
def save_program(request: SaveProgramRequest, auth_user: AuthUser = Depends(get_auth_user)):
    """Save the editable draft independently of starting or validating a run."""
    try:
        program_path = workspace_data_dir(request.workspace_path) / PROGRAM_FILENAME
        assert_can_access_path(auth_user, str(program_path), "save research program")
        assert_can_write_path(auth_user, str(program_path), "save research program")
        _write_text_atomic(program_path, request.text)
        return success_response({"saved": True})
    except AppError:
        raise
    except Exception as exc:
        return error_response(str(exc))


# Sync handlers (FastAPI runs them in its threadpool): they read run folders from disk.
@discovery_router.get("/v1/discovery/runs")
def list_runs(workspace_path: str, auth_user: AuthUser = Depends(get_auth_user)):
    try:
        assert_can_access_path(auth_user, workspace_path, "list research runs")
        runs_dir = workspace_data_dir(workspace_path) / RUNS_DIRNAME
        runs = []
        for run_root in runs_dir.iterdir() if runs_dir.is_dir() else []:
            if not (run_root / "run_state.json").exists():
                continue
            try:
                runs.append(_run_summary(run_root))
            except Exception:
                continue   # one unreadable run_state.json must not hide the others
        return success_response({"runs": sorted(runs, key=lambda r: r["updated_at"], reverse=True)})
    except AppError:
        raise
    except Exception as e:
        return error_response(f"Failed to list runs: {str(e)}")


@discovery_router.get("/v1/discovery/runs/load")
def load_run(run_root_path: str, auth_user: AuthUser = Depends(get_auth_user)):
    try:
        assert_can_access_path(auth_user, run_root_path, "load research run")
        return success_response(_load_run(run_folder(run_root_path)))
    except AppError:
        raise
    except Exception as e:
        return error_response(f"Failed to load run: {str(e)}")


@discovery_router.post("/v1/discovery/runs")
async def start_run(request: StartRunRequest, auth_user: AuthUser = Depends(get_auth_user)):
    if not request.workspace_path.strip():
        raise AppErrors.PARAMS_ERROR("workspace_path is required")
    await assert_can_write_path_async(auth_user, request.workspace_path, "start research")
    await _assert_run_prerequisites()
    try:
        run_id = await get_discovery_run_manager().start_run(
            task=request.task,
            workspace_path=request.workspace_path,
            rounds=request.rounds,
            reasoning_effort=request.reasoning_effort,
            worker_wall_clock_sec=request.worker_wall_clock_sec,
            dataset_scout=request.dataset_scout,
            reuse_guide_from=request.reuse_guide_from,
            workers_per_round=request.workers_per_round,
        )
    except ProblemError as exc:
        raise AppErrors.PARAMS_ERROR(str(exc))
    return success_response({"run_id": run_id, "outcome": _run_outcome(get_discovery_run_manager().run_root(run_id)),
                             **_cohort_info(get_discovery_run_manager().run_root(run_id))})


@discovery_router.post("/v1/discovery/runs/resume")
async def resume_run(request: ResumeRunRequest, auth_user: AuthUser = Depends(get_auth_user)):
    await assert_can_write_path_async(auth_user, request.run_root_path, "resume research")
    await _assert_run_prerequisites()
    try:
        run_id = await get_discovery_run_manager().resume_run(
            run_root_path=request.run_root_path, additional_rounds=request.additional_rounds,
        )
    except ProblemError as exc:
        raise AppErrors.PARAMS_ERROR(str(exc))
    return success_response({"run_id": run_id, "outcome": _run_outcome(get_discovery_run_manager().run_root(run_id)),
                             **_cohort_info(get_discovery_run_manager().run_root(run_id))})


def _detached_run_root(run_id: str, run_root_path: Optional[str]) -> Optional[Path]:
    """The folder of a run this process no longer streams: one it ran earlier, or the
    run_root_path the panel passes (it lists runs by folder), when it names this run."""
    run_root = get_discovery_run_manager().past_run_root(run_id)
    if run_root is None and run_root_path:
        try:
            run_root = run_folder(run_root_path)
        except ProblemError:
            return None
    if run_root is None or run_root.name != run_id or not (run_root / "run_state.json").is_file():
        return None
    return run_root


@discovery_router.get("/v1/discovery/runs/{run_id}/stream")
async def stream_run(run_id: str, run_root_path: Optional[str] = None, auth_user: AuthUser = Depends(get_auth_user)):
    manager = get_discovery_run_manager()
    run_root = manager.run_root(run_id)
    if run_root is not None:
        await assert_can_access_path_async(auth_user, str(run_root), "stream research run")
    detached = None if run_root is not None else _detached_run_root(run_id, run_root_path)
    if detached is not None:
        await assert_can_access_path_async(auth_user, str(detached), "stream research run")

    async def event_generator():
        if detached is not None:
            # Not running here (finished, stopped, or from before a restart): its state on disk.
            status = await asyncio.to_thread(run_status_on_disk, detached)
            yield f"data: {json.dumps({'type': 'run_detached', 'run_id': run_id, 'status': status})}\n\n"
            return
        async with contextlib.aclosing(manager.read_stream(run_id)) as events:
            try:
                async for event in events:
                    # an SSE comment: the panel ignores it, a dropped connection fails on it
                    yield ": ping\n\n" if event is None else f"data: {json.dumps(event)}\n\n"
            except ProblemError as exc:
                yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@discovery_router.post("/v1/discovery/runs/{run_id}/cancel")
async def cancel_run(run_id: str, auth_user: AuthUser = Depends(get_auth_user)):
    manager = get_discovery_run_manager()
    run_root = manager.run_root(run_id)
    if run_root is not None:
        await assert_can_write_path_async(auth_user, str(run_root), "cancel research")
    if not await manager.cancel_run(run_id):
        # nothing to stop: already finished or stopped (a repeated Stop is not an error)
        return success_response({"cancelled": False, "reason": "not active"})
    return success_response({"cancelled": True})
