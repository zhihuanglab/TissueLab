from fastapi import APIRouter, Depends, Request
from app.core.response import success_response, error_response
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
from app.services.agent_service import get_agent_service, AgentService
from app.utils.request import get_device_id
from app.websocket.segmentation_consumer import device_annotation_handlers
from app.services.model_store import model_store
from app.services.feedback_service import get_feedback_service
from app.services.tasks_service import post_answer
# Auth removed for open source
from app.core.settings import settings
import ast, json
import numpy as np
import base64
import os
import contextlib
import traceback
from datetime import datetime
import aiohttp

agent_router = APIRouter()

def convert_for_json(obj):
    """
     Recursively convert NumPy types to native Python types for JSON serialization.
     
     :param obj: Any object potentially containing NumPy types
     :return: The same object with NumPy types converted to Python native types
     """
    if isinstance(obj, dict):
        return {k: convert_for_json(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_for_json(item) for item in obj]
    elif isinstance(obj, tuple):
        return tuple(convert_for_json(item) for item in obj)
    elif isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return convert_for_json(obj.tolist())
    elif isinstance(obj, np.bool_):
        return bool(obj)
    elif isinstance(obj, (bytes, bytearray)):
        try:
            return base64.b64encode(obj).decode('ascii')
        except Exception:
            return str(obj)
    else:
        return obj

def script_function(script):
    namespace = {}
    try:
        # Execute the code in the isolated namespace
        exec(script, namespace)
        # Return the function object
        return namespace['analyze_medical_image']
    except Exception as e:
        print(f"Error executing code: {e}")
        return None

class AgentRequest(BaseModel):
    agent_id: str
    prompt: str
    parameters: Optional[Dict[str, Any]] = None
    history: Optional[Any] = None
    data_context: Optional[Dict[str, Any]] = None

class ExecuteRequest(BaseModel):
    h5_path: str
    code_str: str

class GenerateExecuteRequest(BaseModel):
    h5_path: str
    prompt: str

@agent_router.post("/v1/entrance_agent")
async def entrance_agent(request: AgentRequest,
                        agent_service: AgentService = Depends(get_agent_service)):
    """
    Determine if the user's query requires a workflow.
    Returns: { "need_workflow": bool, "label": "1|2|3" }
    Mapping: 1=general, 2=patch/code, 3=workflow
    """
    try:
        label = await agent_service.need_patch(request.prompt, history=getattr(request, 'history', None))
        need_workflow = (label.strip() == "3")
        return success_response({
            "need_workflow": need_workflow,
            "label": label
        })
    except Exception as e:
        return error_response(str(e))

@agent_router.post("/v1/need_patch")
async def need_patch(request: AgentRequest,
                     agent_service: AgentService = Depends(get_agent_service)):
    """
    Check if the prompt is a patch request
    """
    try:
        response_text = await agent_service.need_patch(request.prompt, history=getattr(request, 'history', None))
        return success_response(response_text)
    except Exception as e:
        return error_response(str(e))

@agent_router.post("/v1/chat")
async def agent_chat(request: AgentRequest,
                     agent_service: AgentService = Depends(get_agent_service)):
    """
    Agent chat endpoint that processes user prompts
    """
    try:
        response_text = await agent_service.chat(
            request.prompt,
            history=getattr(request, 'history', None),
            data_context=getattr(request, 'data_context', None)
        )
        response = {
            "agent_id": request.agent_id,
            "response": response_text,
            "parameters": request.parameters
        }
        return success_response(response)
    except Exception as e:
        return error_response(str(e))


@agent_router.post("/v1/summary_answer")
async def agent_summary(
    request: AgentRequest,
    http_request: Request,
    agent_service: AgentService = Depends(get_agent_service),
):
    """
    Return natural language summary of the answer
    """
    try:
        question = request.prompt
        parameters = request.parameters or {}
        answer = parameters.get("answer")
        if answer is None:
            raise ValueError("Missing 'answer' in parameters")

        response_text: Optional[str] = None
        ctrl_error: Optional[str] = None

        # First, try to delegate to Control Service for the summary
        try:
            base_agent_url = settings.CTRL_SERVICE_API_ENDPOINT.rstrip("/")
            payload = {
                "agent_id": request.agent_id,
                "prompt": question,
                "parameters": parameters,
            }
            headers = {"Content-Type": "application/json"}
            auth_header = http_request.headers.get("Authorization")
            if auth_header:
                headers["Authorization"] = auth_header

            async with aiohttp.ClientSession() as session:
                summary_url = f"{base_agent_url}/agent/v1/summary_answer"
                async with session.post(summary_url, json=payload, headers=headers, timeout=120) as resp:
                    resp.raise_for_status()
                    text = await resp.text()
                    ctrl_payload = json.loads(text)
                    if ctrl_payload.get("code") == 0:
                        response_data = ctrl_payload.get("data") or {}
                        response_text = response_data.get("response") or response_data.get("summary")
                    else:
                        ctrl_error = ctrl_payload.get("message")
        except Exception as exc:
            ctrl_error = str(exc)

        # Fallback to local summary if Control Service did not provide one
        if not response_text:
            try:
                response_text = await agent_service.summary_answer(question, answer)
            except Exception as fallback_exc:
                if not ctrl_error:
                    ctrl_error = str(fallback_exc)
                response_text = ""

        # Ensure Chatbox poller receives the summary
        try:
            post_answer(response_text or "")
        except Exception:
            pass

        response = {
            "agent_id": request.agent_id,
            "response": response_text,
            "parameters": request.parameters,
            "control_error": ctrl_error,
        }

        return success_response(response)
    except Exception as e:
        return error_response(str(e))


@agent_router.post("/v1/get_steps")
async def get_steps(
    request: AgentRequest,
    http_request: Request,
    agent_service: AgentService = Depends(get_agent_service),
    # Auth removed for open source
):
    """
    Get processing steps for a given query
    Returns a list of steps in format:
    [
        {"step": 1, "model": "TissueClassify", "input": "lymph_node"},
        {"step": 2, "model": "TissueClassify", "input": "tumor"},
        {"step": 3, "model": "Scripts", "input": "Calculate overlap..."}
    ]
    """
    try:
        # Merge data_context with preference hint from feedback service
        # Auth removed for open source - using default user ID
        user_id = "anonymous_user"

        try:
            fb = get_feedback_service()
            pref_text = fb.format_preferences_for_prompt(user_id=user_id)
        except Exception:
            pref_text = ""

        merged_dc = getattr(request, 'data_context', None) or {}
        if isinstance(merged_dc, dict) and pref_text:
            merged_dc = {**merged_dc, "preference_hint": pref_text}

        # Get structured steps (JSON string) from service
        steps_str = await agent_service.get_processing_steps(
            request.prompt,
            history=getattr(request, 'history', None),
            data_context=merged_dc
        )
        steps_obj = json.loads(steps_str)
        steps_raw = steps_obj.get("steps", [])

        # Expecting { "steps": [ { step, model, input: [..] }, ... ] }
        steps_list = []
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

        # Candidate evaluation driven by LLM using preference feedback
        try:
            nodes_meta = model_store.get_nodes_extended()
            category_map = model_store.get_category_map()
            dc = getattr(request, 'data_context', None) or {}
            ctx_key = None
            try:
                if isinstance(dc, dict) and dc.get("h5_path"):
                    import os as _os
                    base = _os.path.basename(dc.get("h5_path"))
                    ctx_key = base[:-3] if base.endswith('.h5') else base
            except Exception:
                ctx_key = None

            fb = get_feedback_service()
            categories = [s.get("model") for s in steps_list if s.get("model")]
            unique_categories = list(set(categories))
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
            pref_text = (
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

                selection = await agent_service.select_impl_from_candidates(
                    request.prompt,
                    s,
                    candidate_details,
                    feedback_text=pref_text,
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
            try:
                print(f"[api.get_steps] candidate selection skipped: {_e}")
            except Exception:
                pass

        steps_list.sort(key=lambda x: x["step"])
        try:
            print(f"[api.get_steps] steps_list={steps_list}")
        except Exception:
            pass
        return success_response(steps_list)
    except Exception:
        # Backward-compatibility fallback to legacy dict-like output
        try:
            steps_dict = ast.literal_eval(steps_str)
            steps_list = []
            for step_key, step_value in steps_dict.items():
                step_num = int(step_key.split()[1])
                steps_list.append({
                    "step": step_num,
                    "model": step_value["model"],
                    "input": step_value["input"]
                })
            steps_list.sort(key=lambda x: x["step"])
            return success_response(steps_list)
        except Exception as e2:
            return error_response(str(e2))

@agent_router.post("/v1/process_script")
async def process_script(request: AgentRequest, http_request: Request,
                    agent_service: AgentService = Depends(get_agent_service)):
    """
    Get processing steps for a given query
    """
    try:
        # Include active H5 structure via device-scoped context or provided data_context
        h5_structure_str = None
        try:
            device_id = get_device_id(http_request)
            handler = device_annotation_handlers.get(device_id)
            if handler:
                h5_path = handler.get_current_file_path()
            if h5_path:
                structure = await agent_service.get_h5_structure(h5_path)
                h5_structure_str = json.dumps(structure, indent=2)
        except Exception:
            h5_structure_str = None

        script = await agent_service.get_script(
            script_task=request.prompt,
            h5_structure=h5_structure_str,
            original_question=request.prompt
        )
        return success_response(script)
    except Exception as e:
        return error_response(str(e))


@agent_router.post("/v1/get_h5_structure")
async def get_h5_structure_api(
    request: AgentRequest,
    agent_service: AgentService = Depends(get_agent_service)):
    """
    {
        "agent_id": "agent1",
        "prompt": "path/to/workflow_data.h5"
    }
    """
    try:
        structure = await agent_service.get_h5_structure(request.prompt)
        return success_response(structure)
    except Exception as e:
        return error_response(f"failed to get h5 structure: {str(e)}")


@agent_router.post("/v1/execute_script")
async def execute_script(
    request: ExecuteRequest,
    agent_service: AgentService = Depends(get_agent_service)):
    """
    Execute a custom analysis script
    Request example:
    {
        "h5_path": "path/to/data.h5",
        "code_str": "def analyze_medical_image(path):\n    ..."
    }
    """
    try:
        # Prepare a timestamped log file under storage/tasknode_logs (same as task nodes)
        try:
            # logs_dir relative to this file: app/api/ -> go to project root and into storage/tasknode_logs
            logs_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "storage", "tasknode_logs"))
            os.makedirs(logs_dir, exist_ok=True)
            h5_base = os.path.splitext(os.path.basename(request.h5_path))[0]
            safe_h5 = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in h5_base)
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            log_path = os.path.join(logs_dir, f"CodeScript__{safe_h5}__{ts}.log")
        except Exception:
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            log_path = os.path.abspath(f"CodeScript__{ts}.log")

        with open(log_path, "w", encoding="utf-8") as lf:
            # Write header and script snapshot
            try:
                lf.write(f"[Code Run] {datetime.now().isoformat()}\n")
                lf.write(f"H5 Path: {request.h5_path}\n")
                lf.write("--- Begin Script ---\n")
                lf.write(request.code_str)
                lf.write("\n--- End Script ---\n\n")
                lf.flush()
            except Exception:
                pass

            # Validate/load function under redirected stdout/stderr
            with contextlib.redirect_stdout(lf), contextlib.redirect_stderr(lf):
                func = script_function(request.code_str)
            if not func:
                raise ValueError(
                    "Invalid script format - must define analyze_medical_image function"
                )

            # Execute analysis while capturing output
            with contextlib.redirect_stdout(lf), contextlib.redirect_stderr(lf):
                result = func(request.h5_path)

            # Footer
            try:
                lf.write("\n--- Execution Complete ---\n")
                lf.flush()
            except Exception:
                pass

        # JSON-safe result; include log path for frontend consumption
        result_json = convert_for_json(result)
        if isinstance(result_json, dict):
            execution_payload = {**result_json, "log_path": log_path}
        else:
            execution_payload = {"result": result_json, "log_path": log_path}

        return success_response({
            "h5_path": request.h5_path,
            "execution_result": execution_payload
        })
    except Exception as e:
        # Append error/traceback to log file when possible
        try:
            fallback_logs_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "storage", "tasknode_logs"))
            os.makedirs(fallback_logs_dir, exist_ok=True)
            with open(locals().get("log_path", os.path.join(fallback_logs_dir, "CodeScript__error.log")), "a", encoding="utf-8") as lf:
                lf.write("\n--- Error ---\n")
                lf.write(str(e) + "\n")
                lf.write(traceback.format_exc() + "\n")
        except Exception:
            pass
        return error_response(
            f"Execution failed: {str(e)}" + (f", see log: {locals().get('log_path')}" if 'log_path' in locals() else "")
        )


@agent_router.post("/v1/generate_and_execute")
async def generate_and_execute(
    request: GenerateExecuteRequest,
    agent_service: AgentService = Depends(get_agent_service)):
    """
    Three-in-one workflow interface
    Request example:
    {
        "h5_path": "path/to/data.h5",
        "prompt": "Count the number of cells in the glomeruli"
    }
    """
    try:
        # Prepare a timestamped log file under storage/tasknode_logs (same as task nodes)
        try:
            logs_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "storage", "tasknode_logs"))
            os.makedirs(logs_dir, exist_ok=True)
            h5_base = os.path.splitext(os.path.basename(request.h5_path))[0]
            safe_h5 = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in h5_base)
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            log_path = os.path.join(logs_dir, f"CodeScript__{safe_h5}__{ts}.log")
        except Exception:
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            log_path = os.path.abspath(f"CodeScript__{ts}.log")

        with open(log_path, "w", encoding="utf-8") as lf:
            with contextlib.redirect_stdout(lf), contextlib.redirect_stderr(lf):
                # Get HDF5 structure
                structure = await agent_service.get_h5_structure(request.h5_path)
                print("H5 structure:", structure)

                # Generate script
                combined_prompt = f"{request.prompt}\n\nH5 structure:\n{json.dumps(structure, indent=2)}"
                print("Combined prompt:", combined_prompt)

                script = await agent_service.get_script(
                    script_task=combined_prompt,
                    h5_structure=json.dumps(structure, indent=2),
                    original_question=request.prompt
                )
                print("Generated script:", script)

                # Execute script
                func = script_function(script)
                if not func:
                    raise ValueError("Invalid generated script")

                result = func(request.h5_path)

            # Footer
            try:
                lf.write("\n--- Execution Complete ---\n")
                lf.flush()
            except Exception:
                pass

        # Convert result to JSON-serializable format and include log path
        result_json = convert_for_json(result)
        if isinstance(result_json, dict):
            execution_payload = {**result_json, "log_path": log_path}
        else:
            execution_payload = {"result": result_json, "log_path": log_path}

        print("[agent] Execution result:", execution_payload)

        return success_response({
            "generated_script": script,
            "execution_result": execution_payload
        })

    except Exception as e:
        try:
            fallback_logs_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "storage", "tasknode_logs"))
            os.makedirs(fallback_logs_dir, exist_ok=True)
            with open(locals().get("log_path", os.path.join(fallback_logs_dir, "CodeScript__error.log")), "a", encoding="utf-8") as lf:
                lf.write("\n--- Error ---\n")
                lf.write(str(e) + "\n")
                lf.write(traceback.format_exc() + "\n")
        except Exception:
            pass
        return error_response(
            f"End-to-end execution failed: {str(e)}, generated_script: {locals().get('script', 'N/A')}" +
            (f", see log: {locals().get('log_path')}" if 'log_path' in locals() else "")
        )
