"""LLM agent routes (planning, chat, code generation, verification).

Ported from the TissueLab control plane. The open edition runs the agent in
the same process as the viewer; every blocking LLM call is pushed off the
event loop inside :mod:`app.services.agent.workflow_agent`.
"""
import asyncio
import json
import os
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core.auth import AuthUser, get_auth_user
from app.core.errors import AppErrors
from app.core.logger import logger
from app.core.response import error_response, success_response
from app.api.discovery import discovery_router
from app.services.agent.workflow_agent import (
    AgentNotConfigured,
    WorkflowAgent,
    _extract_code_from_markdown,
    get_workflow_agent,
)
from app.services.agent.verification_agent import get_verification_agent
from app.services import llm_settings
from app.services.feedback import get_feedback_service
from app.utils.workflow.model_store import model_store

agent_router = APIRouter()
# Research panel (discovery / autoresearch): /v1/discovery/*
agent_router.include_router(discovery_router)


class AgentRequest(BaseModel):
    agent_id: str
    prompt: str
    parameters: Optional[Dict[str, Any]] = None
    history: Optional[Any] = None
    data_context: Optional[Dict[str, Any]] = None


class AgentRequestV2(BaseModel):
    agent_id: str
    prompt: str
    parameters: Optional[Dict[str, Any]] = None
    history: Optional[Any] = None
    data_context: Optional[Dict[str, Any]] = None
    rois_info: Optional[str] = None  # ROIs information text description (e.g., JSON string or text description)
    rois_images: Optional[List[str]] = None  # ROIs image array (base64-encoded string array)


class VerifyResultRequest(BaseModel):
    user_query: str  # Original user query/question
    workflow_steps: Optional[List[Dict[str, Any]]] = None  # List of workflow steps from planning stage
    generated_code: Optional[str] = None  # Code generated in coding stage
    code_execution_result: Optional[Any] = None  # Result from executing the generated code
    final_result: Optional[Any] = None  # Final result returned to user
    result_overlay_thumbnail_path: str  # Path to thumbnail with result overlay
    original_thumbnail_path: str  # Path to original image thumbnail
    error_message: Optional[str] = None  # Any error message encountered during execution


def get_agent_dependency() -> WorkflowAgent:
    """FastAPI dependency: the shared agent, or a 501 envelope when no key is set."""
    try:
        return get_workflow_agent()
    except AgentNotConfigured as e:
        raise AppErrors.NOT_IMPLEMENTED(str(e))


def _context_key_from(data_context: Optional[Dict[str, Any]]) -> Optional[str]:
    try:
        if isinstance(data_context, dict):
            zarr_path = data_context.get("zarr_path")
            if zarr_path:
                base = os.path.basename(zarr_path)
                return base[:-5] if base.endswith('.zarr') else base
    except Exception:
        pass
    return None


def _normalize_steps(steps_obj: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Expecting { "steps": [ { step, model, input: [..], impl, impl_candidates }, ... ] }"""
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
    return steps_list


async def _select_candidates(
    workflow_agent: WorkflowAgent,
    prompt: str,
    steps_list: List[Dict[str, Any]],
    data_context: Optional[Dict[str, Any]],
    user_id: str,
    tag: str,
) -> None:
    """Candidate evaluation driven by the LLM using preference feedback (in place)."""
    try:
        nodes_meta = model_store.get_nodes_extended()
        category_map = model_store.get_category_map()
        ctx_key = _context_key_from(data_context)

        fb = get_feedback_service()
        categories = [s.get("model") for s in steps_list if s.get("model")]
        unique_categories = list(set(categories))
        pref_summary = (
            fb.get_preference_summary(unique_categories, context_key=ctx_key, limit=0, user_id=user_id)
            if unique_categories else {}
        )
        pref_text = (
            fb.build_feedback_prompt(unique_categories, context_key=ctx_key, user_id=user_id)
            if unique_categories else ""
        )

        for s in steps_list:
            model_cat = s.get("model")
            candidate_names = [c for c in (s.get("impl_candidates") or []) if isinstance(c, str) and c]
            # Fallback: fill from category map if workflow agent omitted candidates
            fallback = category_map.get(model_cat, []) if model_cat else []
            if fallback:
                ordered = []
                seen = set()
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
                prompt, s, candidate_details, feedback_text=pref_text,
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
        logger.warning(f"[api.{tag}] candidate selection skipped: {_e}")


def _merged_data_context(request: AgentRequest, user_id: str) -> Dict[str, Any]:
    """Merge data_context with the preference hint from the feedback service."""
    try:
        pref_text = get_feedback_service().format_preferences_for_prompt(user_id=user_id)
    except Exception:
        pref_text = ""
    merged_dc = getattr(request, 'data_context', None) or {}
    if isinstance(merged_dc, dict) and pref_text:
        merged_dc = {**merged_dc, "preference_hint": pref_text}
    return merged_dc


@agent_router.post("/v1/entrance_agent")
async def entrance_agent(request: AgentRequest,
                         workflow_agent: WorkflowAgent = Depends(get_agent_dependency),
                         auth_user: AuthUser = Depends(get_auth_user)):
    """
    Determine if the user's query requires a workflow.
    Returns: { "need_workflow": bool, "label": "1|2|3" }
    Mapping: 1=general, 2=patch/code, 3=workflow
    """
    try:
        label = await workflow_agent.classify_intent(request.prompt, history=getattr(request, 'history', None))
        need_workflow = (label.strip() == "3")
        return success_response({
            "need_workflow": need_workflow,
            "label": label
        })
    except Exception as e:
        return error_response(str(e))


@agent_router.post("/v1/chat")
async def agent_chat(request: AgentRequest,
                     workflow_agent: WorkflowAgent = Depends(get_agent_dependency),
                     auth_user: AuthUser = Depends(get_auth_user)):
    """
    Agent chat endpoint that processes user prompts
    """
    try:
        response_text = await workflow_agent.chat(
            request.prompt,
            history=getattr(request, 'history', None),
            data_context=getattr(request, 'data_context', None),
            user_id=auth_user.uid
        )
        return success_response({
            "agent_id": request.agent_id,
            "response": response_text,
            "parameters": request.parameters
        })
    except Exception as e:
        return error_response(str(e))


@agent_router.post("/v1/summary_answer")
async def agent_summary(request: AgentRequest,
                        workflow_agent: WorkflowAgent = Depends(get_agent_dependency),
                        auth_user: AuthUser = Depends(get_auth_user)):
    """
    Return natural language summary of the answer
    """
    try:
        question = request.prompt
        answer = (request.parameters or {})["answer"]
        response_text = await workflow_agent.summary_answer(question, answer)
        return success_response({
            "agent_id": request.agent_id,
            "response": response_text,
            "parameters": request.parameters
        })
    except Exception as e:
        return error_response(str(e))


@agent_router.post("/v1/get_steps")
async def get_steps(
    request: AgentRequest,
    workflow_agent: WorkflowAgent = Depends(get_agent_dependency),
    auth_user: AuthUser = Depends(get_auth_user),
):
    """
    Get processing steps for a given query
    Returns a list of steps in format:
    [
        {"step": 1, "model": "TissueClassify", "input": "lymph_node"},
        {"step": 2, "model": "TissueClassify", "input": "tumor"},
        {"step": 3, "model": "CodingAgent", "input": "Calculate overlap..."}
    ]
    """
    try:
        user_id = auth_user.uid
        merged_dc = _merged_data_context(request, user_id)

        # Get structured steps (JSON string) from service
        steps_str = await workflow_agent.get_processing_steps(
            request.prompt,
            history=getattr(request, 'history', None),
            data_context=merged_dc,
            user_id=user_id
        )
        steps_obj = json.loads(steps_str)
        steps_list = _normalize_steps(steps_obj)

        await _select_candidates(
            workflow_agent, request.prompt, steps_list,
            getattr(request, 'data_context', None), user_id, "get_steps",
        )

        steps_list.sort(key=lambda x: x["step"])
        return success_response(steps_list)
    except Exception as e:
        logger.error(f"Error in v1/get_steps: {e}", exc_info=True)
        return error_response(f"Error in v1/get_steps: {e}")


@agent_router.post("/v2/get_steps")
async def get_steps_v2(
    request: AgentRequestV2,
    workflow_agent: WorkflowAgent = Depends(get_agent_dependency),
    auth_user: AuthUser = Depends(get_auth_user),
):
    """
    Get processing steps for a given query with ROI-aware workflow selection (v2)

    Compared to v1/get_steps, v2 adds:
    - rois_info: ROIs information text input (e.g., JSON string)
    - rois_images: ROIs image array (base64-encoded string array)

    The model determines which workflow to use for each ROI based on the question content, ROIs information, and ROIs images.
    """
    try:
        user_id = auth_user.uid
        merged_dc = _merged_data_context(request, user_id)

        # Step 1: Generate initial workflow draft (like v1/get_steps) without ROI info
        initial_dc = merged_dc.copy()
        initial_steps_str = await workflow_agent.get_processing_steps(
            request.prompt,
            history=getattr(request, 'history', None),
            data_context=initial_dc,
            user_id=user_id
        )
        initial_steps_obj = json.loads(initial_steps_str)
        initial_steps = initial_steps_obj.get("steps", [])

        # Determine initial workflow type
        initial_workflow_type = None
        has_tissue_seg = any(step.get("model") == "TissueSeg" for step in initial_steps)
        has_tissue_classify = any(step.get("model") == "TissueClassify" for step in initial_steps)
        has_nuclei_seg = any(step.get("model") == "NucleiSeg" for step in initial_steps)
        has_nuclei_classify = any(step.get("model") == "NucleiClassify" for step in initial_steps)

        if has_tissue_seg or has_tissue_classify:
            initial_workflow_type = "tissue-based"
        elif has_nuclei_seg or has_nuclei_classify:
            initial_workflow_type = "nuclei-based"

        # Step 2: If ROI info/images provided, analyze and potentially adjust workflow
        if (request.rois_info or request.rois_images) and initial_workflow_type:
            roi_adjusted_dc = merged_dc.copy()
            if request.rois_info:
                roi_adjusted_dc["rois_info"] = request.rois_info
            if request.rois_images:
                roi_adjusted_dc["rois_images"] = request.rois_images

            roi_adjusted_dc["initial_workflow"] = json.dumps(initial_steps_obj, ensure_ascii=False)
            roi_adjusted_dc["roi_workflow_hint"] = (
                f"WORKFLOW ADJUSTMENT ANALYSIS: An initial workflow has been generated ({initial_workflow_type}). "
                "You now have MULTIPLE ROI images and ROI information (including patch size calculations for EACH ROI). "
                ""
                "CRITICAL: Each ROI has DIFFERENT dimensions and scale factors. "
                "You MUST analyze EACH ROI image separately using its specific patch size calculation. "
                ""
                "IMPORTANT CONTEXT: "
                "- 224x224 refers to pixels at ORIGINAL WSI resolution (level 0), NOT the ROI thumbnail resolution. "
                "- The ROI information provides, for EACH ROI, the calculated pixel size of a 224x224 WSI patch when scaled to that ROI's thumbnail image. "
                "- Each ROI has a different calculated patch size in pixels (e.g., ROI 1 might be 145x145 pixels, ROI 2 might be 156x156 pixels, etc.). "
                "- You must examine EACH ROI image individually and assess if that ROI's specific patch size would be appropriate. "
                ""
                "ANALYSIS PROCESS - Analyze EACH ROI separately: "
                "1. If initial workflow is TISSUE-BASED: For EACH ROI image, check if 224x224 patches (at WSI resolution, which corresponds to "
                "that ROI's calculated pixel size in the thumbnail) would be too large for the target objects (e.g., tumor regions) visible "
                "in that specific ROI thumbnail image. Specifically, check if a patch of that ROI's calculated size would contain multiple "
                "SEPARATED target objects that should be distinguished. If ANY ROI shows this issue, ADJUST to nuclei-based workflow. "
                "2. If initial workflow is NUCLEI-BASED: For EACH ROI image, check if tissue-based workflow (224x224 patches at WSI resolution) "
                "would be sufficient for the target objects visible in that ROI's thumbnail image. Compare that ROI's calculated patch pixel size "
                "with the size and distribution of target objects in that ROI image. If ALL ROIs can use tissue-based without merging separated objects, "
                "ADJUST to tissue-based workflow to reduce annotation cost. "
                "3. If no adjustment is needed, keep the initial workflow. "
                ""
                "VISUALLY examine EACH ROI thumbnail image separately and compare each ROI's calculated patch pixel size with the actual target objects "
                "present in that specific ROI to make this decision. In your workflow_reason, mention which ROIs you analyzed and what you found."
            )

            steps_str = await workflow_agent.get_processing_steps(
                request.prompt,
                history=getattr(request, 'history', None),
                data_context=roi_adjusted_dc,
                user_id=user_id
            )
        else:
            steps_str = initial_steps_str

        steps_obj = json.loads(steps_str)
        workflow_reason = steps_obj.get("workflow_reason", "")
        steps_list = _normalize_steps(steps_obj)

        await _select_candidates(
            workflow_agent, request.prompt, steps_list,
            getattr(request, 'data_context', None), user_id, "get_steps_v2",
        )

        steps_list.sort(key=lambda x: x["step"])
        response_data: Any = steps_list
        if workflow_reason:
            response_data = {"steps": steps_list, "workflow_reason": workflow_reason}
        return success_response(response_data)
    except Exception as e:
        logger.error(f"Error in v2/get_steps: {e}", exc_info=True)
        return error_response(f"Error in v2/get_steps: {e}")


def _structure_text(request: AgentRequest) -> Optional[str]:
    """Best-effort: include the active Zarr file structure so code gen can target the right datasets."""
    if request.data_context and isinstance(request.data_context, dict):
        structure_source = request.data_context.get("zarr_structure")
        if structure_source:
            if isinstance(structure_source, str):
                return structure_source
            try:
                return json.dumps(structure_source, indent=2)
            except (TypeError, ValueError):
                return json.dumps(structure_source)
    return None


def _web_search_enabled(request: AgentRequest) -> bool:
    if request.data_context and isinstance(request.data_context, dict):
        return bool(request.data_context.get("web_search_enabled", False))
    return False


@agent_router.post("/v1/process_script")
async def process_script(
    request: AgentRequest,
    workflow_agent: WorkflowAgent = Depends(get_agent_dependency),
    auth_user: AuthUser = Depends(get_auth_user),
):
    """
    Generate Python script for a given query using Zarr file structure.
    """
    try:
        script = await workflow_agent.get_script(
            script_task=request.prompt,
            zarr_structure=_structure_text(request),
            original_question=request.prompt,
            web_search_enabled=_web_search_enabled(request),
        )
        return success_response(script)
    except Exception as e:
        return error_response(str(e))


@agent_router.post("/v1/process_script_stream")
async def process_script_stream(
    request: AgentRequest,
    workflow_agent: WorkflowAgent = Depends(get_agent_dependency),
    auth_user: AuthUser = Depends(get_auth_user),
):
    """
    Stream Coding Agent assistant output as SSE (`data: {"delta"|"done"|"error"}` JSON lines).
    Final event includes extracted Python code.
    """
    try:
        system_prompt, user_prompt = await workflow_agent.prepare_script_prompts(
            script_task=request.prompt,
            zarr_structure=_structure_text(request),
            original_question=request.prompt,
            web_search_enabled=_web_search_enabled(request),
        )
    except Exception as e:
        return error_response(str(e))

    def sync_sse():
        # Runs in Starlette's threadpool (sync generator), so the blocking
        # stream never touches the event loop.
        deltas = workflow_agent.iter_script_chat_stream(system_prompt, user_prompt)
        try:
            full_parts: List[str] = []
            for delta in deltas:
                full_parts.append(delta)
                yield f"data: {json.dumps({'delta': delta}, ensure_ascii=False)}\n\n"
            code = _extract_code_from_markdown("".join(full_parts))
            yield f"data: {json.dumps({'done': True, 'code': code}, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
        finally:
            deltas.close()  # client gone or done: close the upstream stream now

    return StreamingResponse(
        sync_sse(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@agent_router.post("/v1/verify/result")
async def verify_result(
    request: VerifyResultRequest,
    workflow_agent: WorkflowAgent = Depends(get_agent_dependency),
    auth_user: AuthUser = Depends(get_auth_user),
):
    """
    Diagnose issues in workflow execution pipeline.
    Analyzes workflow planning, model outputs, and generated code to identify problems.

    Returns:
        {
            "issue_stage": "workflow_planning" | "model_prediction" | "coding" | "none",
            "confidence": "high" | "medium" | "low",
            "reasoning": str,
            "suggestions": [str],
            "stage_details": {...}
        }
    """
    try:
        verification_agent = get_verification_agent()
        result = await asyncio.to_thread(
            verification_agent.diagnose_result,
            user_query=request.user_query,
            result_overlay_thumbnail_path=request.result_overlay_thumbnail_path,
            original_thumbnail_path=request.original_thumbnail_path,
            workflow_steps=request.workflow_steps,
            generated_code=request.generated_code,
            code_execution_result=request.code_execution_result,
            final_result=request.final_result,
            error_message=request.error_message,
        )
        return success_response(result)
    except ValueError as e:
        return error_response(str(e))


class ModelSettingsRequest(BaseModel):
    """Per field: omitted / null keeps the saved value, "" clears it, text sets it."""
    fields: Dict[str, Optional[str]]


_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
# Ports the renderer is served from: Electron starts Next.js on the first free
# port from 3000 (100 tries), `next dev` defaults to 3000. TL_RENDERER_PORTS
# ("3000-3099", "3000,4000", …) changes them for another setup.
_DEFAULT_RENDERER_PORTS = "3000-3099"


def _renderer_ports() -> set:
    ports = set()
    for part in (os.getenv("TL_RENDERER_PORTS") or _DEFAULT_RENDERER_PORTS).split(","):
        low, _, high = part.strip().partition("-")
        try:
            ports.update(range(int(low), int(high or low) + 1))
        except ValueError:
            continue
    return ports


def _require_local_origin(origin: Optional[str] = Header(None)) -> None:
    """CORS is open and every caller is the local user, so without this any web
    page the user opens - a dev server or Jupyter on localhost included - could
    point the agent at its own server and receive the key, or read the endpoints.
    Browsers always send Origin on a cross-origin request; allowed are the app's
    renderer (localhost on a renderer port, see TL_RENDERER_PORTS) and clients
    that send none (Electron's file://, non-browser). "null" (sandboxed iframes,
    opaque origins) is rejected on purpose, and so is any other host name, which
    also keeps DNS rebinding out."""
    if origin is None or origin.startswith("file://"):
        return
    try:
        parsed = urlparse(origin)
        host, port = parsed.hostname, parsed.port
    except ValueError:
        host = port = None
    if host not in _LOCAL_HOSTS or port not in _renderer_ports():
        raise AppErrors.USER_FORBIDDEN("Model settings can only be read or changed from the TissueLab app.")


@agent_router.get("/v1/model_settings", dependencies=[Depends(_require_local_origin)])
def get_model_settings(auth_user: AuthUser = Depends(get_auth_user)):
    """The LLM endpoints / keys / models set in Preferences (keys only as a hint)."""
    return success_response(llm_settings.public_settings())


@agent_router.put("/v1/model_settings", dependencies=[Depends(_require_local_origin)])
def put_model_settings(request: ModelSettingsRequest, auth_user: AuthUser = Depends(get_auth_user)):
    """Save and apply at once: the next agent / research request uses them.

    ``cleared_keys``: saved keys dropped because their endpoint moved to another host.
    """
    try:
        cleared = llm_settings.update_settings(request.fields)
    except llm_settings.SettingsError as e:
        raise AppErrors.PARAMS_ERROR(str(e))
    return success_response({**llm_settings.public_settings(), "cleared_keys": cleared})
