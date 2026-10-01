"""Discovery routes (mounted under /api/agent): the problem, run folders, and a run's event stream.

A run is its folder, <workspace>/autoresearch_runs/<run_id>; the loop lives in
:mod:`app.services.agent.discovery`.
"""
import asyncio
import contextlib
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
    feedback_path,
    guide_recorded,
    load_results_rows,
    read_run_state,
)
from app.services.agent.discovery.problem import parse_problem
from app.services.agent.discovery.workspace_scan import (
    problem_fields,
    resolve_program,
    scan_workspace,
)
from app.services.agent.discovery.run_manager import PROBLEM_FILENAME
from app.services.agent.discovery.scout import GUIDE_NAME
from app.services.agent.discovery.sandbox import RUNS_DIRNAME, docker_unavailable_reason
from app.services.file_manager.common import (
    assert_can_access_path,
    assert_can_access_path_async,
    assert_can_write_path_async,
)

discovery_router = APIRouter()


class StartRunRequest(BaseModel):
    task: str                       # the full problem.md text
    workspace_path: str
    rounds: int = Field(3, ge=1, le=50)
    reasoning_effort: str = "high"
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
        "rounds": rounds,
        "next_round_id": next_round_id,
        # its scout's guide, which a new run here may reuse
        "has_guide": guide_recorded(state, run_root) and (run_root / "shared" / GUIDE_NAME).is_file(),
    }


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
        })
    problem_path = run_root / PROBLEM_FILENAME
    findings_path = run_root / FINDINGS_NAME
    return {
        **_run_summary(run_root),
        "problem_text": problem_path.read_text(encoding="utf-8") if problem_path.exists() else "",
        "journal": journal,
        "final_summary": findings_path.read_text(encoding="utf-8") if findings_path.exists() else None,
    }


class ResolveProgramRequest(BaseModel):
    data_dir: str
    text: str
    cohort_file: Optional[str] = None   # the user's pick; default: the best match
    use_model: bool = True


def _parsed(text: str) -> Dict[str, Any]:
    """problem.md text as the form's fields, or why it does not parse."""
    try:
        return {"fields": problem_fields(parse_problem(text)), "error": None}
    except ProblemError as exc:
        return {"fields": None, "error": str(exc)}


@discovery_router.get("/v1/discovery/setup")
def get_setup(data_dir: str, auth_user: AuthUser = Depends(get_auth_user)):
    """What the panel needs to set up a run in a data folder (or a slide's folder):
    its problem.md, and the cohort files with their columns sorted into the likely
    id / slide / outcome / covariate roles."""
    try:
        assert_can_access_path(auth_user, data_dir, "read research setup")
        folder = workspace_data_dir(data_dir)
        problem_path = folder / PROBLEM_FILENAME
        content = problem_path.read_text(encoding="utf-8") if problem_path.exists() else ""
        problem = {"found": problem_path.exists(), "content": content, **_parsed(content)}
        return success_response({"data_dir": str(folder), "problem": problem, **scan_workspace(folder)})
    except AppError:
        raise
    except Exception as exc:
        return error_response(str(exc))


@discovery_router.post("/v1/discovery/problem/resolve")
def resolve_problem(request: ResolveProgramRequest, auth_user: AuthUser = Depends(get_auth_user)):
    """A free-text program read against the folder's cohort table: the outcome and
    covariates it names (by column name, or via the model with column names only).
    A text starting with a YAML header is problem.md and is parsed as is."""
    try:
        assert_can_access_path(auth_user, request.data_dir, "read research setup")
        folder = workspace_data_dir(request.data_dir)
        return success_response(resolve_program(request.text, folder, request.cohort_file, request.use_model))
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
    manager = get_discovery_run_manager()
    run_root = manager.run_root(run_id)
    if run_root is not None:
        await assert_can_access_path_async(auth_user, str(run_root), "stream research run")

    async def event_generator():
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
        return error_response("Run is not active or already completed")
    return success_response({"cancelled": True})
