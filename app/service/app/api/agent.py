"""
Local agent endpoints.

Migrated from ctrl-service. All routes are auth-free and do not touch
Firestore: training-data collection, per-user knowledge base, request
logging, and usage counting were stripped during the local migration.

Routes:
- POST /v1/chat
- POST /v1/entrance_agent
- POST /v1/get_steps
- POST /v1/process_script
- POST /v1/reflect/classification
- POST /v1/discovery/sessions (create)
- GET  /v1/discovery/program
- GET  /v1/discovery/sessions (list)
- GET  /v1/discovery/sessions/{session_id}
- GET  /v1/discovery/autoresearch_runs
- GET  /v1/discovery/autoresearch_runs/load
- POST /v1/discovery/sessions/{session_id}/run
- GET  /v1/discovery/sessions/{session_id}/runs/{run_id}/stream
- POST /v1/discovery/sessions/{session_id}/runs/{run_id}/resume
- POST /v1/discovery/sessions/{session_id}/runs/resume_from_path
"""

import ast
import csv
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core.response import error_response, success_response
from app.services.agent.discovery import (
    get_discovery_run_manager,
    get_discovery_session_store,
)
from app.services.agent.reflection_agent import ReflectionAgent, get_reflection_agent
from app.services.agent.workflow_agent import WorkflowAgent, get_workflow_agent
from app.services.feedback_service import get_feedback_service
from app.services.model_store import model_store
from app.utils import resolve_path


agent_router = APIRouter()


class AgentRequest(BaseModel):
    agent_id: str
    prompt: str
    parameters: Optional[Dict[str, Any]] = None
    history: Optional[Any] = None
    data_context: Optional[Dict[str, Any]] = None


class ReflectClassificationRequest(BaseModel):
    folder_path: str
    available_classes: List[str]
    current_class: Optional[str] = None


# Anonymous local user identifier shared across all endpoints (matches the
# pattern auth.py uses when DISABLE_AUTH is on).
_LOCAL_USER_ID = "local-dev"


_OPENAI_KEY_MISSING_MSG = (
    "OPENAI_API_KEY is not configured. Open app/service/.env and replace "
    "`your-open-ai-key` with a real key from https://platform.openai.com/account/api-keys, "
    "then restart the backend."
)


def _openai_key_error() -> Optional[str]:
    """Return a user-facing message if OPENAI_API_KEY is unset or still the placeholder."""
    key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if not key or key == "your-open-ai-key" or key.startswith("your-"):
        return _OPENAI_KEY_MISSING_MSG
    return None


@agent_router.post("/v1/chat")
async def agent_chat(
    request: AgentRequest,
    workflow_agent: WorkflowAgent = Depends(get_workflow_agent),
):
    err = _openai_key_error()
    if err:
        return error_response(err)
    try:
        response_text = await workflow_agent.chat(
            request.prompt,
            history=request.history,
            data_context=request.data_context,
            user_id=_LOCAL_USER_ID,
        )
        return success_response({
            "agent_id": request.agent_id,
            "response": response_text,
            "parameters": request.parameters,
        })
    except Exception as e:
        return error_response(str(e))


@agent_router.post("/v1/entrance_agent")
async def entrance_agent(
    request: AgentRequest,
    workflow_agent: WorkflowAgent = Depends(get_workflow_agent),
):
    """Classify the user query into 1=chat / 2=code / 3=workflow."""
    err = _openai_key_error()
    if err:
        return error_response(err)
    try:
        label = await workflow_agent.classify_intent(request.prompt, history=request.history)
        need_workflow = label.strip() == "3"
        return success_response({"need_workflow": need_workflow, "label": label})
    except Exception as e:
        return error_response(str(e))


@agent_router.post("/v1/get_steps")
async def get_steps(
    request: AgentRequest,
    http_request: Request,
    workflow_agent: WorkflowAgent = Depends(get_workflow_agent),
):
    """Plan a workflow as a list of steps with model/impl per step."""
    err = _openai_key_error()
    if err:
        return error_response(err)
    steps_str = "{}"
    try:
        user_id = _LOCAL_USER_ID

        try:
            fb = get_feedback_service()
            pref_text = fb.format_preferences_for_prompt(user_id=user_id)
        except Exception:
            pref_text = ""

        merged_dc = request.data_context or {}
        if isinstance(merged_dc, dict) and pref_text:
            merged_dc = {**merged_dc, "preference_hint": pref_text}

        steps_str = await workflow_agent.get_processing_steps(
            request.prompt,
            history=request.history,
            data_context=merged_dc,
            user_id=user_id,
        )
        steps_obj = json.loads(steps_str)

        steps_list: List[Dict[str, Any]] = []
        for idx, item in enumerate(steps_obj.get("steps", [])):
            impl_val = item.get("impl", "")
            candidates_val = item.get("impl_candidates") or ([] if not impl_val else [impl_val])
            if impl_val and impl_val not in candidates_val:
                candidates_val = [impl_val] + [c for c in candidates_val if c != impl_val]
            steps_list.append({
                "step": int(item.get("step", idx + 1)),
                "model": item.get("model", ""),
                "input": item.get("input", []),
                "impl": impl_val,
                "impl_candidates": candidates_val,
            })

        # Candidate evaluation driven by feedback + LLM ranking.
        try:
            nodes_meta = model_store.get_nodes_extended()
            category_map = model_store.get_category_map()
            ctx_key = None
            dc = request.data_context or {}
            if isinstance(dc, dict):
                zarr_path = dc.get("zarr_path")
                if zarr_path:
                    import os as _os
                    base = _os.path.basename(zarr_path)
                    ctx_key = base[:-5] if base.endswith(".zarr") else base

            fb = get_feedback_service()
            unique_categories = list({s.get("model") for s in steps_list if s.get("model")})
            pref_summary = (
                fb.get_preference_summary(
                    unique_categories,
                    context_key=ctx_key,
                    limit=0,
                    user_id=user_id,
                )
                if unique_categories
                else {}
            )
            pref_prompt_text = (
                fb.build_feedback_prompt(
                    unique_categories,
                    context_key=ctx_key,
                    user_id=user_id,
                )
                if unique_categories
                else ""
            )

            for s in steps_list:
                model_cat = s.get("model")
                candidate_names = [c for c in (s.get("impl_candidates") or []) if isinstance(c, str) and c]
                fallback = category_map.get(model_cat, []) if model_cat else []
                if fallback:
                    seen = set()
                    ordered = []
                    for name in candidate_names + fallback:
                        if not name or name in seen:
                            continue
                        seen.add(name)
                        ordered.append(name)
                    candidate_names = ordered
                if not candidate_names and s.get("impl"):
                    candidate_names = [s.get("impl")]

                candidate_details: List[Dict[str, Any]] = []
                for name in candidate_names:
                    name = str(name)
                    meta = nodes_meta.get(name, {}) if isinstance(nodes_meta, dict) else {}
                    stats = None
                    cat_summary = pref_summary.get(model_cat, {}) if model_cat else {}
                    for bucket in ("context_likes", "context_dislikes", "global_likes", "global_dislikes"):
                        for item in cat_summary.get(bucket, []):
                            if item.get("impl") == name:
                                stats = {
                                    "score": item.get("score", 0),
                                    "up": item.get("up", 0),
                                    "down": item.get("down", 0),
                                    "bucket": bucket,
                                }
                                break
                        if stats:
                            break
                    candidate_details.append({
                        "impl": name,
                        "display_name": meta.get("displayName", name) if isinstance(meta, dict) else name,
                        "description": meta.get("description", "") if isinstance(meta, dict) else "",
                        "source": meta.get("source") if isinstance(meta, dict) else None,
                        "stats": stats,
                    })

                selection = await workflow_agent.select_impl_from_candidates(
                    request.prompt,
                    s,
                    candidate_details,
                    feedback_text=pref_prompt_text,
                )
                if selection and isinstance(selection, dict):
                    chosen = selection.get("selected_impl")
                    if chosen and chosen in [c.get("impl") for c in candidate_details]:
                        s["impl_selected_via_feedback"] = True
                        s["impl"] = chosen
                        s["impl_candidates"] = [c.get("impl") for c in candidate_details]
                        s["impl_ranking"] = selection.get("ranking")
                        s["selection_reason"] = selection.get("reason")
        except Exception as _e:
            print(f"[api.get_steps] candidate selection skipped: {_e}")

        steps_list.sort(key=lambda x: x["step"])
        return success_response(steps_list)
    except Exception:
        # Legacy dict-format fallback (older WorkflowAgent versions).
        try:
            steps_dict = ast.literal_eval(steps_str)
            legacy_list = []
            for step_key, step_value in steps_dict.items():
                step_num = int(step_key.split()[1])
                legacy_list.append({
                    "step": step_num,
                    "model": step_value["model"],
                    "input": step_value["input"],
                })
            legacy_list.sort(key=lambda x: x["step"])
            return success_response(legacy_list)
        except Exception as e2:
            return error_response(str(e2))


@agent_router.post("/v1/process_script")
async def process_script(
    request: AgentRequest,
    workflow_agent: WorkflowAgent = Depends(get_workflow_agent),
):
    """Generate a Python script for the user's prompt, optionally given Zarr structure."""
    err = _openai_key_error()
    if err:
        return error_response(err)
    try:
        file_structure_str: Optional[str] = None
        if isinstance(request.data_context, dict):
            structure_source = request.data_context.get("zarr_structure")
            if structure_source:
                if isinstance(structure_source, str):
                    file_structure_str = structure_source
                else:
                    try:
                        file_structure_str = json.dumps(structure_source, indent=2)
                    except (TypeError, ValueError):
                        file_structure_str = json.dumps(structure_source)

        web_search_enabled = False
        if isinstance(request.data_context, dict):
            web_search_enabled = bool(request.data_context.get("web_search_enabled", False))

        script = await workflow_agent.get_script(
            script_task=request.prompt,
            zarr_structure=file_structure_str,
            original_question=request.prompt,
            web_search_enabled=web_search_enabled,
            use_scripts_library=True,
        )
        return success_response(script)
    except Exception as e:
        return error_response(str(e))


@agent_router.post("/v1/summary_answer")
async def summary_answer(
    request: AgentRequest,
    workflow_agent: WorkflowAgent = Depends(get_workflow_agent),
):
    """Generate a natural-language summary of a workflow's answer.

    Local replacement for the historical Ctrl-Service /agent/v1/summary_answer
    endpoint. The backend's /api/tasks/v1/summary_answer self-calls this when
    ``CTRL_SERVICE_API_ENDPOINT`` is pointed at this service, so the entire
    summary path stays local and only needs OPENAI_API_KEY.
    """
    err = _openai_key_error()
    if err:
        return error_response(err)
    try:
        parameters = request.parameters or {}
        answer = parameters.get("answer")
        if answer is None:
            return error_response("Missing 'answer' in parameters")
        response_text = await workflow_agent.summary_answer(
            question=request.prompt or "",
            answer=str(answer),
        )
        return success_response({"response": response_text, "summary": response_text})
    except Exception as e:
        return error_response(str(e))


@agent_router.post("/v1/reflect/classification")
async def reflect_classification(request: ReflectClassificationRequest):
    """Reflect cell-classification results against a folder of {id}_{class}.jpeg images."""
    err = _openai_key_error()
    if err:
        return error_response(err)
    try:
        agent = get_reflection_agent()
        result = agent.batch_reflection(
            folder_path=request.folder_path,
            available_classes=request.available_classes,
            current_class=request.current_class,
        )
        return success_response(result)
    except FileNotFoundError as e:
        return error_response(str(e))
    except Exception as e:
        return error_response(f"Error reflecting classification: {str(e)}")


# ----------------------------------------------------------------------------
# Discovery (TL Coscientist) endpoints.
# Renamed from ctrl-service /v1/coscientist/* to /v1/discovery/* for the
# local build to match the app/services/agent/discovery package layout.
# ----------------------------------------------------------------------------


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


def _workspace_data_dir(workspace_path: str) -> Path:
    data_dir = Path(workspace_path).expanduser()
    if not data_dir.is_dir():
        data_dir = data_dir.parent
    return data_dir


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


@agent_router.post("/v1/discovery/sessions")
async def create_discovery_session(
    request: CreateDiscoverySessionRequest,
    http_request: Request,
):
    try:
        store = get_discovery_session_store()
        dataset_id = request.dataset_id or "default"
        context = request.context or {}
        if request.template_type:
            context["template_type"] = request.template_type
        device_id = http_request.headers.get("X-Device-Id")
        session = store.create_session(
            user_id=_LOCAL_USER_ID,
            device_id=device_id,
            dataset_id=dataset_id,
            context=context,
        )
        return success_response(session.to_dict())
    except Exception as e:
        return error_response(f"Failed to create session: {str(e)}")


@agent_router.get("/v1/discovery/program")
async def get_discovery_program(data_dir: str):
    """Read program.md from the given data directory, if it exists."""
    try:
        resolved = resolve_path(data_dir)
        program_path = Path(resolved) / "program.md"
        if not program_path.exists():
            return success_response({"found": False, "content": ""})
        content = program_path.read_text(encoding="utf-8")
        return success_response({"found": True, "content": content})
    except Exception as exc:
        return error_response(str(exc))


@agent_router.get("/v1/discovery/sessions")
async def list_discovery_sessions(http_request: Request, limit: int = 20):
    try:
        store = get_discovery_session_store()
        device_id = http_request.headers.get("X-Device-Id") if http_request else None
        sessions = store.list_sessions(
            user_id=_LOCAL_USER_ID,
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


@agent_router.get("/v1/discovery/sessions/{session_id}")
async def get_discovery_session(session_id: str):
    try:
        store = get_discovery_session_store()
        session = store.get_session(session_id)
        if not session:
            return error_response(f"Session {session_id} not found")
        return success_response(session.to_dict())
    except Exception as e:
        return error_response(f"Failed to get session: {str(e)}")


@agent_router.get("/v1/discovery/autoresearch_runs")
async def list_workspace_autoresearch_runs(workspace_path: str):
    try:
        data_dir = _workspace_data_dir(workspace_path)
        runs_dir = data_dir / "autoresearch_runs"
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
                runs.append({
                    "run_id": payload["run_id"],
                    "run_root_path": payload["run_root_path"],
                    "updated_at": payload["updated_at"],
                    "status": payload["status"],
                    "resume_info": payload["resume_info"],
                })
            except Exception:
                continue
        return success_response({"runs": runs})
    except Exception as e:
        return error_response(f"Failed to list autoresearch runs: {str(e)}")


@agent_router.get("/v1/discovery/autoresearch_runs/load")
async def load_workspace_autoresearch_run(run_root_path: str):
    try:
        payload = _load_autoresearch_run_from_disk(Path(run_root_path).expanduser())
        return success_response(payload)
    except Exception as e:
        return error_response(f"Failed to load autoresearch run: {str(e)}")


@agent_router.post("/v1/discovery/sessions/{session_id}/run")
async def start_discovery_run(session_id: str, request: RunDiscoveryRequest):
    try:
        store = get_discovery_session_store()
        session = store.get_session(session_id)
        if not session:
            return error_response(f"Session {session_id} not found")

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
            auth_user=None,
        )
        return success_response({
            "session_id": session_id,
            "run_id": run.run_id,
            "status": run.status,
        })
    except Exception as e:
        return error_response(f"Failed to start run: {str(e)}")


@agent_router.get("/v1/discovery/sessions/{session_id}/runs/{run_id}/stream")
async def stream_discovery_run(session_id: str, run_id: str):
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


@agent_router.post("/v1/discovery/sessions/{session_id}/runs/{run_id}/resume")
async def resume_autoresearch_run(session_id: str, run_id: str, request: ResumeAutoresearchRequest):
    try:
        store = get_discovery_session_store()
        session = store.get_session(session_id)
        if not session:
            return error_response(f"Session {session_id} not found")
        run_manager = get_discovery_run_manager()
        new_run = await run_manager.resume_run(
            session_id=session_id,
            original_run_id=run_id,
            additional_rounds=request.additional_rounds,
            auth_user=None,
        )
        return success_response({
            "session_id": session_id,
            "run_id": new_run.run_id,
            "resumed_from": run_id,
            "status": new_run.status,
        })
    except Exception as e:
        return error_response(f"Failed to resume run: {str(e)}")


@agent_router.post("/v1/discovery/sessions/{session_id}/runs/resume_from_path")
async def resume_autoresearch_from_path(session_id: str, request: ResumeFromPathRequest):
    try:
        store = get_discovery_session_store()
        session = store.get_session(session_id)
        if not session:
            return error_response(f"Session {session_id} not found")
        run_manager = get_discovery_run_manager()
        new_run = await run_manager.resume_run_from_path(
            session_id=session_id,
            run_root_path=request.run_root_path,
            additional_rounds=request.additional_rounds,
            auth_user=None,
        )
        return success_response({
            "session_id": session_id,
            "run_id": new_run.run_id,
            "resumed_from_path": request.run_root_path,
            "status": new_run.status,
        })
    except Exception as e:
        return error_response(f"Failed to resume run from path: {str(e)}")
