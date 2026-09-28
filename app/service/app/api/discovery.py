"""Discovery (autoresearch) routes: sessions, runs, and the run event stream.

Ported from the TissueLab control plane, which served them under
``/api/agent/v1/coscientist``; the paths are kept so the Research panel talks
to either backend unchanged. The loop itself lives in
:mod:`app.services.agent.discovery`.
"""
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core.auth import AuthUser, get_auth_user
from app.core.errors import AppError, AppErrors
from app.core.response import error_response, success_response
from app.services.agent.discovery import (
    get_discovery_run_manager,
    get_discovery_session_store,
    workspace_data_dir,
)
from app.services.agent.discovery.client import unavailable_reason
from app.services.file_manager.common import (
    assert_can_access_path_async,
    assert_can_write_path_async,
)
from app.utils import resolve_path

discovery_router = APIRouter()


class CreateDiscoverySessionRequest(BaseModel):
    dataset_id: Optional[str] = None
    context: Optional[Dict[str, Any]] = None
    template_type: Optional[str] = None


class RunDiscoveryRequest(BaseModel):
    task: str
    reasoning_effort: Optional[str] = None
    max_iterations: int = 30
    template_type: Optional[str] = None
    context: Optional[Dict[str, Any]] = None
    history: Optional[List[Dict[str, str]]] = None


class ResumeAutoresearchRequest(BaseModel):
    additional_rounds: Optional[int] = None


class ResumeFromPathRequest(BaseModel):
    run_root_path: str
    additional_rounds: Optional[int] = None


def _assert_llm_ready() -> None:
    reason = unavailable_reason()
    if reason:
        raise AppErrors.NOT_IMPLEMENTED(reason)


async def _assert_workspace_writable(auth_user: AuthUser, path: str, operation: str) -> None:
    if not (path or "").strip():
        raise AppErrors.PARAMS_ERROR("workspace_path is required")
    await assert_can_write_path_async(auth_user, path, operation)


def _load_results_tsv_rows(run_root: Path) -> List[Dict[str, Any]]:
    results_path = run_root / "results.tsv"
    if not results_path.exists():
        return []
    with results_path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle, delimiter="\t"))


def _load_autoresearch_run_from_disk(run_root: Path) -> Dict[str, Any]:
    if not run_root.is_dir():
        raise FileNotFoundError(f"Run folder not found: {run_root}")

    state_path = run_root / "run_state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    config = state.get("config", {}) or {}
    next_round_id = int(state.get("next_round_id", 1) or 1)

    program_text = (run_root / "program.md").read_text() if (run_root / "program.md").exists() else ""
    accepted_panel_path = run_root / "accepted_panel.json"
    accepted_panel = json.loads(accepted_panel_path.read_text()) if accepted_panel_path.exists() else {
        "best_panel_score": None,
        "members": [],
    }

    result_rows = _load_results_tsv_rows(run_root)
    total_rounds = int(config.get("rounds", len(result_rows) or 0) or 0)
    journal_entries = [
        {
            "roundId": int(row.get("round_id", 0) or 0),
            "candidateId": row.get("candidate_id", ""),
            "decision": row.get("decision", ""),
            "status": row.get("status", ""),
            "summary": (
                json.loads(summary_path.read_text()).get("summary", "")
                if (summary_path := run_root / f"round_{int(row.get('round_id', 0) or 0):04d}" / "round_summary.json").exists()
                else ""
            )
            or f"{row.get('candidate_id', '')}: {row.get('decision', '')}",
        }
        for row in result_rows
    ]

    final_summary = None
    findings_path = run_root / "research_findings.md"
    if findings_path.exists():
        final_summary = findings_path.read_text()
    elif total_rounds and len(result_rows) >= total_rounds:
        final_summary = (
            f"Accepted panel members: {len(accepted_panel.get('members', []))}\n"
            f"Best panel score: {accepted_panel.get('best_panel_score')}"
        )

    updated_ts = datetime.fromtimestamp(run_root.stat().st_mtime, tz=timezone.utc).isoformat()
    completed = bool(total_rounds and len(result_rows) >= total_rounds)

    return {
        "run_id": run_root.name,
        "run_root_path": str(run_root),
        "updated_at": updated_ts,
        "program_text": program_text,
        "journal": journal_entries,
        "current_round": None,
        "resume_info": {
            "next_round_id": next_round_id,
            "config": config,
        },
        "accepted_panel": accepted_panel,
        "final_summary": final_summary,
        "status": "completed" if completed else "incomplete",
    }


@discovery_router.post("/v1/coscientist/sessions")
async def create_discovery_session(
    request: CreateDiscoverySessionRequest,
    http_request: Request,
    auth_user: AuthUser = Depends(get_auth_user),
):
    try:
        store = get_discovery_session_store()
        dataset_id = request.dataset_id or "default"
        context = request.context or {}
        if request.template_type:
            context["template_type"] = request.template_type
        device_id = http_request.headers.get("X-Device-Id")
        session = store.create_session(
            user_id=auth_user.uid,
            device_id=device_id,
            dataset_id=dataset_id,
            context=context,
        )
        return success_response(session.to_dict())
    except Exception as e:
        return error_response(f"Failed to create session: {str(e)}")


@discovery_router.get("/v1/coscientist/program")
async def get_discovery_program(
    data_dir: str,
    auth_user: AuthUser = Depends(get_auth_user),
):
    """Read program.md from the given data directory, if it exists."""
    try:
        await assert_can_access_path_async(auth_user, data_dir, "read research program")
        program_path = Path(resolve_path(data_dir)) / "program.md"
        if not program_path.exists():
            return success_response({"found": False, "content": ""})
        content = program_path.read_text(encoding="utf-8")
        return success_response({"found": True, "content": content})
    except AppError:
        raise
    except Exception as exc:
        return error_response(str(exc))


@discovery_router.get("/v1/coscientist/sessions")
async def list_discovery_sessions(
    http_request: Request,
    limit: int = 20,
    auth_user: AuthUser = Depends(get_auth_user),
):
    try:
        store = get_discovery_session_store()
        device_id = http_request.headers.get("X-Device-Id")
        sessions = store.list_sessions(
            user_id=auth_user.uid,
            device_id=device_id,
            limit=limit,
        )
        summaries = []
        for session in sessions:
            last_run = session.runs[-1] if session.runs else None
            summaries.append({
                "session_id": session.session_id,
                "dataset_id": session.dataset_id,
                "status": session.status,
                "created_at": session.created_at,
                "updated_at": session.updated_at,
                "last_run_status": last_run.status if last_run else None,
            })
        return success_response(summaries)
    except Exception as e:
        return error_response(f"Failed to list sessions: {str(e)}")


@discovery_router.get("/v1/coscientist/sessions/{session_id}")
async def get_discovery_session(
    session_id: str,
    auth_user: AuthUser = Depends(get_auth_user),
):
    try:
        store = get_discovery_session_store()
        session = store.get_session(session_id)
        if not session:
            return error_response(f"Session {session_id} not found")
        return success_response(session.to_dict())
    except Exception as e:
        return error_response(f"Failed to get session: {str(e)}")


@discovery_router.get("/v1/coscientist/autoresearch_runs")
async def list_workspace_autoresearch_runs(
    workspace_path: str,
    auth_user: AuthUser = Depends(get_auth_user),
):
    try:
        await assert_can_access_path_async(auth_user, workspace_path, "list research runs")
        runs_dir = workspace_data_dir(workspace_path) / "autoresearch_runs"
        if not runs_dir.is_dir():
            return success_response({"runs": []})
        runs = []
        for run_root in sorted(
            (p for p in runs_dir.iterdir() if p.is_dir() and (p / "run_state.json").exists()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        ):
            try:
                payload = _load_autoresearch_run_from_disk(run_root)
                runs.append(
                    {
                        "run_id": payload["run_id"],
                        "run_root_path": payload["run_root_path"],
                        "updated_at": payload["updated_at"],
                        "status": payload["status"],
                        "resume_info": payload["resume_info"],
                    }
                )
            except Exception:
                continue
        return success_response({"runs": runs})
    except AppError:
        raise
    except Exception as e:
        return error_response(f"Failed to list autoresearch runs: {str(e)}")


@discovery_router.get("/v1/coscientist/autoresearch_runs/load")
async def load_workspace_autoresearch_run(
    run_root_path: str,
    auth_user: AuthUser = Depends(get_auth_user),
):
    try:
        await assert_can_access_path_async(auth_user, run_root_path, "load research run")
        payload = _load_autoresearch_run_from_disk(Path(resolve_path(run_root_path)).expanduser())
        return success_response(payload)
    except AppError:
        raise
    except Exception as e:
        return error_response(f"Failed to load autoresearch run: {str(e)}")


@discovery_router.post("/v1/coscientist/sessions/{session_id}/run")
async def start_discovery_run(
    session_id: str,
    request: RunDiscoveryRequest,
    auth_user: AuthUser = Depends(get_auth_user),
):
    try:
        store = get_discovery_session_store()
        session = store.get_session(session_id)
        if not session:
            return error_response(f"Session {session_id} not found")

        ctx = {**(session.context or {}), **(request.context or {})}
        await _assert_workspace_writable(
            auth_user,
            ctx.get("workspace_path") or "",
            "start research",
        )
        _assert_llm_ready()

        template_type = request.template_type or (session.context or {}).get("template_type")
        run_manager = get_discovery_run_manager()
        run = await run_manager.start_run(
            session_id=session_id,
            task=request.task,
            reasoning_effort=request.reasoning_effort,
            max_iterations=request.max_iterations,
            template_type=template_type,
            history=request.history,
            context=request.context,
            auth_user=auth_user,
        )
        return success_response({
            "session_id": session_id,
            "run_id": run.run_id,
            "status": run.status,
        })
    except AppError:
        raise
    except Exception as e:
        return error_response(f"Failed to start run: {str(e)}")


@discovery_router.get("/v1/coscientist/sessions/{session_id}/runs/{run_id}/stream")
async def stream_discovery_run(
    session_id: str,
    run_id: str,
    auth_user: AuthUser = Depends(get_auth_user),
):
    async def event_generator():
        run_manager = get_discovery_run_manager()
        queue = run_manager.get_event_queue(run_id)
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
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@discovery_router.post("/v1/coscientist/sessions/{session_id}/runs/{run_id}/cancel")
async def cancel_discovery_run(
    session_id: str,
    run_id: str,
    auth_user: AuthUser = Depends(get_auth_user),
):
    try:
        run_manager = get_discovery_run_manager()
        cancelled = await run_manager.cancel_run(session_id, run_id)
        if not cancelled:
            return error_response("Run is not active or already completed")
        return success_response({"cancelled": True})
    except Exception as e:
        return error_response(f"Failed to cancel run: {str(e)}")


@discovery_router.get("/v1/coscientist/sessions/{session_id}/runs/{run_id}/resume_info")
async def get_autoresearch_resume_info(
    session_id: str,
    run_id: str,
    auth_user: AuthUser = Depends(get_auth_user),
):
    try:
        store = get_discovery_session_store()
        session = store.get_session(session_id)
        if not session:
            return error_response(f"Session {session_id} not found")
        workspace_path = (session.context or {}).get("workspace_path", "")
        if not workspace_path:
            return error_response("workspace_path not found in session context")
        run_root = workspace_data_dir(workspace_path) / "autoresearch_runs" / run_id
        state_path = run_root / "run_state.json"
        if not state_path.exists():
            return error_response("run_state.json not found; not an autoresearch run")
        state = json.loads(state_path.read_text())
        return success_response({
            "next_round_id": state.get("next_round_id", 1),
            "config": state.get("config", {}),
        })
    except Exception as e:
        return error_response(f"Failed to get resume info: {str(e)}")


@discovery_router.post("/v1/coscientist/sessions/{session_id}/runs/{run_id}/resume")
async def resume_autoresearch_run(
    session_id: str,
    run_id: str,
    request: ResumeAutoresearchRequest,
    auth_user: AuthUser = Depends(get_auth_user),
):
    try:
        store = get_discovery_session_store()
        session = store.get_session(session_id)
        if not session:
            return error_response(f"Session {session_id} not found")
        await _assert_workspace_writable(
            auth_user,
            (session.context or {}).get("workspace_path") or "",
            "resume research",
        )
        _assert_llm_ready()
        run_manager = get_discovery_run_manager()
        new_run = await run_manager.resume_run(
            session_id=session_id,
            original_run_id=run_id,
            additional_rounds=request.additional_rounds,
            auth_user=auth_user,
        )
        return success_response({
            "session_id": session_id,
            "run_id": new_run.run_id,
            "resumed_from": run_id,
            "status": new_run.status,
        })
    except AppError:
        raise
    except Exception as e:
        return error_response(f"Failed to resume run: {str(e)}")


@discovery_router.post("/v1/coscientist/sessions/{session_id}/runs/resume_from_path")
async def resume_autoresearch_from_path(
    session_id: str,
    request: ResumeFromPathRequest,
    auth_user: AuthUser = Depends(get_auth_user),
):
    try:
        store = get_discovery_session_store()
        session = store.get_session(session_id)
        if not session:
            return error_response(f"Session {session_id} not found")
        await _assert_workspace_writable(
            auth_user,
            request.run_root_path,
            "resume research",
        )
        _assert_llm_ready()
        run_manager = get_discovery_run_manager()
        new_run = await run_manager.resume_run_from_path(
            session_id=session_id,
            run_root_path=request.run_root_path,
            additional_rounds=request.additional_rounds,
            auth_user=auth_user,
        )
        return success_response({
            "session_id": session_id,
            "run_id": new_run.run_id,
            "resumed_from_path": request.run_root_path,
            "status": new_run.status,
        })
    except AppError:
        raise
    except Exception as e:
        return error_response(f"Failed to resume run from path: {str(e)}")
