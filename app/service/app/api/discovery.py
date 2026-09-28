"""Discovery routes (mounted under /api/agent): the problem, run folders, and a run's event stream.

A run is its folder, <workspace>/autoresearch_runs/<run_id>; the loop lives in
:mod:`app.services.agent.discovery`.
"""
import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

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
    ROUND_FEEDBACK_NAME,
    load_results_rows,
    read_run_state,
)
from app.services.agent.discovery.problem import EXAMPLE_HEADER
from app.services.agent.discovery.run_manager import PROBLEM_FILENAME
from app.services.agent.discovery.sandbox import RUNS_DIRNAME, docker_unavailable_reason
from app.services.file_manager.common import (
    assert_can_access_path,
    assert_can_access_path_async,
    assert_can_write_path_async,
)
from app.utils import resolve_path

discovery_router = APIRouter()


class StartRunRequest(BaseModel):
    task: str                       # the full problem.md text
    workspace_path: str
    rounds: int = Field(3, ge=1, le=50)
    reasoning_effort: str = "high"
    worker_wall_clock_sec: int = Field(1800, ge=120, le=7200)


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
        "next_round_id": next_round_id,
    }


def _load_run(run_root: Path) -> Dict[str, Any]:
    if not (run_root / "run_state.json").exists():
        raise FileNotFoundError(f"Not a discovery run: {run_root}")
    journal: List[Dict[str, Any]] = []
    for row in load_results_rows(run_root):
        round_id = int(row.get("round_id") or 0)
        feedback_path = run_root / f"round_{round_id:04d}" / ROUND_FEEDBACK_NAME
        summary = ""
        if feedback_path.exists():
            summary = json.loads(feedback_path.read_text(encoding="utf-8")).get("summary", "")
        journal.append({
            "roundId": round_id,
            "focus": row.get("description", ""),
            "summary": summary or f"{row.get('candidate_id', '')}: {row.get('decision', '')}",
        })
    problem_path = run_root / PROBLEM_FILENAME
    findings_path = run_root / FINDINGS_NAME
    return {
        **_run_summary(run_root),
        "problem_text": problem_path.read_text(encoding="utf-8") if problem_path.exists() else "",
        "journal": journal,
        "final_summary": findings_path.read_text(encoding="utf-8") if findings_path.exists() else None,
    }


@discovery_router.get("/v1/discovery/problem")
async def get_problem(data_dir: str, auth_user: AuthUser = Depends(get_auth_user)):
    """problem.md of a data folder; `template` seeds a new one."""
    try:
        await assert_can_access_path_async(auth_user, data_dir, "read research problem")
        problem_path = Path(resolve_path(data_dir)) / PROBLEM_FILENAME
        content = problem_path.read_text(encoding="utf-8") if problem_path.exists() else ""
        return success_response({"found": problem_path.exists(), "content": content, "template": EXAMPLE_HEADER})
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
        runs = [
            _run_summary(run_root)
            for run_root in (runs_dir.iterdir() if runs_dir.is_dir() else [])
            if (run_root / "run_state.json").exists()
        ]
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
        )
    except ProblemError as exc:
        raise AppErrors.PARAMS_ERROR(str(exc))
    return success_response({"run_id": run_id})


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
    return success_response({"run_id": run_id})


@discovery_router.get("/v1/discovery/runs/{run_id}/stream")
async def stream_run(run_id: str, auth_user: AuthUser = Depends(get_auth_user)):
    async def event_generator():
        queue = get_discovery_run_manager().get_event_queue(run_id)
        if queue is None:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Run not found'})}\n\n"
            return
        while True:
            event = await queue.get()
            if event is None:
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@discovery_router.post("/v1/discovery/runs/{run_id}/cancel")
async def cancel_run(run_id: str, auth_user: AuthUser = Depends(get_auth_user)):
    if not await get_discovery_run_manager().cancel_run(run_id):
        return error_response("Run is not active or already completed")
    return success_response({"cancelled": True})
