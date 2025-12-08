from collections import defaultdict
import requests
import sys
import subprocess
import socket
import h5py
import os
import time
import json
import logging
import numpy as np
import gc
import shutil
from typing import Dict, Optional, List, Tuple
from app.services.tasks import TaskNode, TaskNodeManager
from app.services.model_store import model_store
from app.services.register_service import register_custom_node as service_register_custom_node
import traceback
from datetime import datetime
import aiohttp
import asyncio
import threading
import base64
from io import BytesIO
from PIL import Image, ImageDraw
import signal
import psutil
from app.utils import resolve_path
from app.core.settings import settings

logger = logging.getLogger(__name__)

# Global variables
workflow_run_status = {}
node_execution_status = {}
current_h5_path = None
is_generating = False
cur_answer = None

try:
    from .seg_service import SegmentationHandler, is_file_locked, MATPLOTLIB_AVAILABLE
    if MATPLOTLIB_AVAILABLE:
        from matplotlib.path import Path
except ImportError:
    # Handle cases where seg_service might be in a different location or name
    print("[ERROR] Failed to import from .seg_service. Ensure seg_service.py is accessible.")
    # Define MATPLOTLIB_AVAILABLE as False if import fails
    MATPLOTLIB_AVAILABLE = False
    class SegmentationHandler: # Dummy class if import fails
        def __init__(self):
            self.patch_coordinates = None

# Deprecated in favor of ModelStore. Kept for backward compatibility during transition.
# FACTORY_MODEL_DICT will be read from model_store to keep API unchanged.
FACTORY_MODEL_DICT = model_store.get_category_map()

services = {}
running_processes: Dict[str, subprocess.Popen] = {}
manager = TaskNodeManager()

class CustomNodeWrapper:
    def __init__(self, name: str, port: int, factory: Optional[str] = None):
        self.name = name
        self.port = port
        self.dependencies = []
        self.factory = factory

    def init(self):
        url = f"http://localhost:{self.port}/init"
        try:
            response = requests.post(url, timeout=10)
            return response.json()
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def read(self, data: dict):
        url = f"http://localhost:{self.port}/read"
        try:
            response = requests.post(url, json=data, timeout=10)
            return response.json()
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def execute(self):
        url = f"http://localhost:{self.port}/execute"
        try:
            response = requests.post(url, json={}, timeout=30)
            return response.json()
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def add_dependency(self, from_node: str):
        self.dependencies.append(from_node)

class PlaceholderNode(TaskNode):
    def init(self):
        pass

    def read(self, data):
        pass

    def execute(self):
        return {"info": f"I'm just a placeholder for {self.name}"}

# --- Activation SSE state (per model) ---
# Stores latest activation status for each model: { status: 'starting'|'ready'|'failed'|'unknown', data: {...}, ts: float }
activation_states: Dict[str, Dict] = {}

def set_activation_state(model_name: str, status: str, data: Optional[Dict] = None):
    try:
        activation_states[model_name] = {
            "status": status,
            "data": data or {},
            "ts": datetime.now().timestamp(),
        }
    except Exception:
        pass

async def generate_activation_events(model_name: str):
    """Async generator for SSE activation status for a specific model."""
    last_ts = 0.0
    state = activation_states.get(model_name) or {"status": "unknown", "data": {}, "ts": 0.0}
    yield f"data: {json.dumps({'model': model_name, **state})}\n\n"
    # Stream updates until a terminal status is seen
    while True:
        await asyncio.sleep(0.5)
        state = activation_states.get(model_name)
        if not state:
            continue
        if state.get("ts", 0.0) > last_ts:
            last_ts = state["ts"]
            payload = {"model": model_name, **state}
            yield f"data: {json.dumps(payload)}\n\n"
            if state.get("status") in ("ready", "failed"):
                break

def find_available_port(start_port):
    """find available port"""
    port = start_port
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("localhost", port))
                return port
            except OSError:
                port += 1

def start_service(service_name: str) -> dict:
    """Start a single node service"""
    if service_name not in services:
        return {"error": f"Unknown service: {service_name}"}

    details = services[service_name]
    if details["running"]:
        return {"message": f"{service_name} is already running."}

    py_file = details["file"]
    port = details["port"]

    cmd = [
        sys.executable,
        py_file,
        "--port", str(port),
        "--name", service_name
    ]
    try:
        proc = subprocess.Popen(cmd)
        running_processes[service_name] = proc
        details["running"] = True
        details["pid"] = proc.pid  # Store PID for tracking
        return {"message": f"{service_name} started on port {port} with PID {proc.pid}."}
    except Exception as e:
        return {"error": f"Failed to start {service_name}: {str(e)}"}

def stop_service(service_name: str) -> dict:
    """Stop a single node service"""
    if service_name not in services:
        return {"error": f"Unknown service: {service_name}"}

    details = services[service_name]
    if not details["running"]:
        return {"message": f"{service_name} is not running."}

    if service_name in running_processes:
        try:
            running_processes[service_name].terminate()
            del running_processes[service_name]
            details["running"] = False
            return {"message": f"{service_name} stopped."}
        except Exception as e:
            return {"error": f"Failed to stop {service_name}: {str(e)}"}

def start_all_services() -> dict:
    """Start all services"""
    results = {}
    for sname, details in services.items():
        if not details["running"]:
            resp = start_service(sname)
            results[sname] = resp
        else:
            results[sname] = {"message": f"{sname} already running"}
    return {"results": results}

def stop_all_services() -> dict:
    """Stop all services"""
    results = {}
    for sname, details in services.items():
        if details["running"]:
            resp = stop_service(sname)
            results[sname] = resp
        else:
            results[sname] = {"message": f"{sname} not running"}
    return {"results": results}

def create_node(service_name: str, file_path: str, port: int) -> dict:
    """Create a new node"""
    if service_name in services:
        # If already exists in services, treat as idempotent registration
        return {
            "message": f"Service '{service_name}' already exists in services (idempotent).",
            "service_info": services[service_name]
        }

    services[service_name] = {
        "file": file_path,
        "port": port,
        "running": False
    }

    try:
        node = PlaceholderNode(name=service_name, port=port)
        # If node already exists in manager (e.g., added by custom node registration), skip adding
        if service_name in manager.nodes:
            logger.info(f"[create_node] Node '{service_name}' already exists in manager; skipping add (idempotent).")
        else:
            manager.add_node(node)
    except Exception as e:
        del services[service_name]
        return {"error": f"Failed to add node to manager: {str(e)}"}

    return {
        "message": f"Node '{service_name}' registered (not started)",
        "service_info": services[service_name]
    }

def _add_dependency_internal(from_node: str, to_node: str) -> dict:
    """
    Add dependency between nodes
    
    Parameters:
    - from_node: Source node name
    - to_node: Target node name
    
    Returns:
    - On success: {"message": "..."}
    - On failure: {"error": "error message"}
    """
    if from_node not in manager.nodes or to_node not in manager.nodes:
        return {"error": f"{from_node} and {to_node} must both be in manager.nodes."}
    try:
        manager.add_dependency(from_node, to_node)
        return {"message": f"Dependency added: {from_node} -> {to_node}"}
    except ValueError as e:
        return {"error": str(e)}

def _run_workflow_internal(workflow_id: str, node_inputs: dict, h5_path: str) -> dict:
    """Internal function to run a workflow"""
    try:
        wf_id_int = int(workflow_id)
    except:
        return {"error": "workflow_id must be an integer."}

    time.sleep(1)
    
    # sign for using temp file
    using_temp_file = False
    temp_h5_path = None
    
    # 1) if h5 file not exists => create new file
    if not os.path.exists(h5_path):
        with h5py.File(h5_path, "w") as hf:
            pass
    else:
        # check if file is locked using H5FileCache
        from app.services.seg_service import _h5_cache
        locked = False
        max_attempts = 4  # try 4 times, reduce unnecessary temp file creation
        for attempt in range(max_attempts):
            if not _h5_cache.is_file_locked(h5_path):
                locked = False
                break
            print(f"H5 file is locked, try {attempt+1}/{max_attempts}")
            time.sleep(1)
            locked = True
            
        if locked:
            print(f"H5 file is locked, create temp file")
            
            # create temp file
            temp_dir = os.path.dirname(h5_path)
            temp_h5_path = os.path.join(temp_dir, f"temp_workflow_{int(time.time())}.h5")
            
            try:
                # copy key data to temp file
                with h5py.File(h5_path, 'r') as src:
                    with h5py.File(temp_h5_path, 'w') as dst:
                        # copy key groups
                        if 'SegmentationNode' in src:
                            src.copy('SegmentationNode', dst)
                            
                print(f"success copy data to temp file: {temp_h5_path}")
                using_temp_file = True
                
            except Exception as e:
                print(f"create temp file failed: {e}, try to use original file")
                if os.path.exists(temp_h5_path):
                    try:
                        os.remove(temp_h5_path)
                    except:
                        pass
                temp_h5_path = None
                using_temp_file = False
        
        # 2) if file is not locked or create temp file failed, try to use original file
        if not using_temp_file:
            try:
                with h5py.File(h5_path, "a") as hf:
                    to_delete = []
                    for key in hf.keys():
                        if key not in ["SegmentationNode", "user_annotation", "MuskNode"]:
                            to_delete.append(key)
                    for grp_name in to_delete:
                        del hf[grp_name]
            except Exception as e:
                return {"error": f"cannot visit this file: {str(e)}. file may be locked."}
    
    # make sure to use the right file
    active_h5_path = temp_h5_path if using_temp_file else h5_path
    
    # 3) write node_inputs to h5 file
    try:
        with h5py.File(active_h5_path, "a") as hf:
            for nodeName, paramDict in node_inputs.items():
                # Resolve h5_group from ModelStore (fallback to nodeName)
                nodes_meta = model_store.get_nodes_extended()
                node_meta = nodes_meta.get(nodeName, {}) if isinstance(nodes_meta, dict) else {}
                h5_group = node_meta.get("h5_group") or nodeName
                user_data_path = f"{h5_group}/userData"
                if user_data_path in hf:
                    del hf[user_data_path]
                node_group = hf.create_group(user_data_path)
                
                #  param => dataset
                for k, v in paramDict.items():
                    if isinstance(v, (str, int, float, bool)):
                        node_group.create_dataset(k, data=str(v).encode("utf-8"))
                    else:
                        data_str = json.dumps(v, ensure_ascii=False)
                        node_group.create_dataset(k, data=data_str.encode("utf-8"))
    except Exception as e:
        return {"error": f"write node_inputs to h5 file failed: {str(e)}"}
    
    # 4) manager.execute_workflow
    try:
        logger.info(f"Starting workflow execution for workflow {wf_id_int}")
        result = manager.execute_workflow(wf_id_int, active_h5_path)
        logger.info(f"Workflow execution completed. Result: {result}")
    except Exception as e:
        logger.error(f"Workflow execution failed: {str(e)}")
        return {"error": f"execute workflow failed: {str(e)}"}
    
    # if using temp file and operation success, replace original file
    if using_temp_file and os.path.exists(temp_h5_path):
        try:
            print(f"workflow using temp file: {temp_h5_path}")
            
            # make sure temp file is available
            with h5py.File(temp_h5_path, 'r') as _:
                pass
                
            # use temp file replace original file
            os.replace(temp_h5_path, h5_path)
            # After repack/replace, proactively invalidate and refresh cache
            try:
                # Ensure mtime changes to satisfy any passive watchers
                try:
                    os.utime(h5_path, None)
                except Exception:
                    pass
                from app.services.seg_service import force_refresh_h5_cache, smart_preload_data
                force_refresh_h5_cache(h5_path)
                smart_preload_data(h5_path, force_reload=True)
            except Exception as cache_err:
                logger.warning(f"[save_task] Failed to refresh cache after repack replace: {cache_err}")
            print(f"temp file replace original file: {h5_path}")
            
            # update return path to original path
            active_h5_path = h5_path
            
        except Exception as e:
            print(f"replace file failed: {e}")
            # don't delete temp file, prevent manual recovery
            print(f"keep temp file: {temp_h5_path}")
    
    # Release any file locks after workflow completion
    try:
        from app.services.seg_service import _h5_cache
        _h5_cache.release_file_lock(h5_path)
        if temp_h5_path:
            _h5_cache.release_file_lock(temp_h5_path)
    except Exception as e:
        print(f"Warning: Failed to release file locks: {e}")
    
    return {
        "message": f"Workflow '{wf_id_int}' executed with node-level data.",
        "h5_file": active_h5_path,
        "result": result
    }

async def run_workflow_in_background(wf_id, node_inputs, script_prompt, h5_path, auth_header: str | None = None):
    """
    execute workflow using background tasks with proper async handling
    """
    
    logger.info(f"🚀 Starting background workflow execution for workflow {wf_id}")
    logger.info(f"📋 Node inputs: {list(node_inputs.keys())}")
    logger.info(f"📁 H5 path: {h5_path}")
    
    try:
        # Reset node status tracking for this workflow
        try:
            node_execution_status.clear()
        except Exception:
            pass

        # Initialize status as not started (0) first, will be updated to running (1) after PID tracking
        for node_name in node_inputs.keys():
            node_execution_status[node_name] = 0
            logger.info(f"📊 Initialized status for {node_name}: 0 (not started)")

        # Helper: discover node port
        async def _get_node_port(node_name: str) -> Optional[int]:
            try:
                node_obj = getattr(manager, 'nodes', {}).get(node_name)
                if node_obj is not None:
                    port = getattr(node_obj, 'port', None)
                    if isinstance(port, int):
                        return port
            except Exception:
                pass
            try:
                nodes_meta = model_store.get_nodes_extended()
                if isinstance(nodes_meta, dict):
                    runtime = (nodes_meta.get(node_name, {}) or {}).get('runtime')
                    if isinstance(runtime, dict):
                        port = runtime.get('port')
                        if isinstance(port, int):
                            return port
            except Exception:
                pass
            try:
                info = services.get(node_name)
                if isinstance(info, dict):
                    port = info.get('port')
                    if isinstance(port, int):
                        return port
            except Exception:
                pass
            return None

        async def _watch_node_progress(node_name: str, port: int):
            """Subscribe to node's /progress (if available) and mirror to update_node_progress."""
            url = f"http://127.0.0.1:{port}/progress"
            try:
                timeout = aiohttp.ClientTimeout(total=None, sock_connect=5, sock_read=None)
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.get(url, headers={"Accept": "text/event-stream"}) as resp:
                        if resp.status != 200:
                            return
                        async for raw in resp.content:
                            try:
                                if not raw:
                                    continue
                                line = raw.decode(errors='ignore').strip()
                                if not line.startswith('data:'):
                                    continue
                                payload = line.split('data:', 1)[1].strip()
                                try:
                                    value = int(payload)
                                except Exception:
                                    try:
                                        obj = json.loads(payload)
                                        if isinstance(obj, dict) and 'data' in obj:
                                            value = int(str(obj['data']).strip())
                                        else:
                                            continue
                                    except Exception:
                                        continue
                                if 0 <= value <= 100:
                                    update_node_progress(node_name, value)
                                if value >= 100:
                                    break
                            except Exception:
                                continue
            except Exception:
                return

        async def _start_progress_watchers(names: List[str]):
            tasks = []
            seen = set()
            for n in names:
                if n in seen:
                    continue
                seen.add(n)
                try:
                    port = await _get_node_port(n)
                    if isinstance(port, int):
                        tasks.append(asyncio.create_task(_watch_node_progress(n, port)))
                except Exception:
                    continue
            return tasks

        # Kick off progress watchers concurrently (best-effort)
        try:
            watcher_tasks = await _start_progress_watchers(list(node_inputs.keys()))
        except Exception:
            watcher_tasks = []

        # Use run_in_threadpool for CPU-bound operations
        from starlette.concurrency import run_in_threadpool
        logger.info(f"Calling run_in_threadpool for workflow {wf_id}")
        run_res = await run_in_threadpool(
            _run_workflow_internal,
            str(wf_id),
            node_inputs,
            h5_path
        )
        logger.info(f"run_in_threadpool completed for workflow {wf_id}, result: {run_res}")

        # After success, cleanup watchers
        try:
            for t in watcher_tasks:
                if not t.done():
                    t.cancel()
        except Exception:
            pass

        # tag complete
        workflow_run_status[wf_id] = {"status": "done", "result": run_res}
        if "error" in run_res:
            workflow_run_status[wf_id] = {"status": "error", "result": run_res["error"]}
            # clear workflow
            manager.clear_workflows()
            logger.info(f"clear all workflows after workflow {wf_id} is done")
            return

        # tag complete
        for node_name in node_inputs.keys():
            print(f"node complete: {node_name}")
            node_execution_status[node_name] = 2

        agent_result = None
        if script_prompt:
            # Update scripts status to running
            node_execution_status["Scripts"] = 1

            h5_file = run_res.get("h5_file", "")
            if not os.path.exists(h5_file):
                agent_result = {"error": f"H5 file not found at {h5_file}"}
            else:
                # Preview-only flow: get structure, generate script, do NOT execute
                import aiohttp
                # Normalize prompt to a plain string
                prompt_text = script_prompt
                if isinstance(prompt_text, list):
                    try:
                        prompt_text = " ".join([str(x) for x in prompt_text])
                    except Exception:
                        prompt_text = str(prompt_text)
                elif not isinstance(prompt_text, str):
                    prompt_text = str(prompt_text)

                headers = {'Content-Type': 'application/json'}
                try:
                    base_agent_url = settings.CTRL_SERVICE_API_ENDPOINT.rstrip("/")
                    session_headers = dict(headers)
                    if auth_header:
                        session_headers["Authorization"] = auth_header

                    # Fetch H5 structure locally; fall back gracefully if unavailable
                    structure = None
                    structure_json = None
                    try:
                        # Simple H5 structure reading without agent service
                        import h5py
                        with h5py.File(h5_file, 'r') as f:
                            def get_structure(name, obj):
                                if isinstance(obj, h5py.Group):
                                    return {key: get_structure(key, item) for key, item in obj.items()}
                                elif isinstance(obj, h5py.Dataset):
                                    return {"shape": obj.shape, "dtype": str(obj.dtype)}
                                return str(type(obj))
                            structure = get_structure("/", f["/"])
                        structure_json = json.dumps(structure, indent=2)
                    except Exception as struct_err:
                        logger.warning(f"Failed to fetch local H5 structure for script preview: {struct_err}")
                        structure = None
                        structure_json = None

                    combined_prompt = (
                        f"{prompt_text}\n\nH5 structure:\n{structure_json}"
                        if structure_json
                        else prompt_text
                    )

                    gen_payload = {
                        "agent_id": "default_agent",
                        "prompt": combined_prompt,
                        "parameters": {},
                    }
                    if structure is not None:
                        gen_payload["data_context"] = {
                            "h5_structure": structure,
                            "h5_path": h5_file,
                        }

                    async with aiohttp.ClientSession() as session:
                        gen_url = f"{base_agent_url}/agent/v1/process_script"
                        async with session.post(gen_url, json=gen_payload, headers=session_headers, timeout=300) as gen_resp:
                            gen_resp.raise_for_status()
                            gen_text = await gen_resp.text()
                            try:
                                gen_data = json.loads(gen_text)
                                if gen_data.get("code") == 0:
                                    agent_result = {"generated_script": gen_data.get("data", "")}
                                else:
                                    agent_result = {"error": gen_data.get("message", "Agent returned error")}
                            except json.JSONDecodeError as json_err:
                                agent_result = {"error": f"Failed to parse generation response: {str(json_err)}"}
                except Exception as e:
                    agent_result = {"error": str(e)}

            # Update scripts status to complete
            node_execution_status["Scripts"] = 2

        print("[tasks] run_res:", run_res)
        print("[tasks] agent_result:", agent_result)
        # (C) assemble final answer
        final_res = {
            "workflow_result": run_res.get("result"),
            "h5_file": run_res.get("h5_file")
        }
        if agent_result is not None:
            if isinstance(agent_result, dict) and "generated_script" in agent_result:
                final_res["generated_script"] = agent_result["generated_script"]
            else:
                final_res["script_result"] = agent_result

        # Prefer reporting saved output artifacts (images) when present
        def _gather_saved_paths(obj):
            paths = []
            try:
                if isinstance(obj, dict):
                    for k, v in obj.items():
                        if k in ("output_path", "save_path") and isinstance(v, str) and v:
                            paths.append(v)
                        elif k in ("output_dir", "save_dir") and isinstance(v, str) and v:
                            # If a directory is provided along with files list, join them
                            files = obj.get("files") or obj.get("output_files")
                            if isinstance(files, list) and files:
                                for f in files:
                                    if isinstance(f, str) and f:
                                        paths.append(os.path.join(v, f))
                            else:
                                paths.append(v)
                        else:
                            paths.extend(_gather_saved_paths(v))
                elif isinstance(obj, list):
                    for it in obj:
                        paths.extend(_gather_saved_paths(it))
            except Exception:
                pass
            # Deduplicate preserving order
            uniq = []
            for p in paths:
                if p not in uniq:
                    uniq.append(p)
            return uniq

        saved_paths = _gather_saved_paths(run_res.get("result"))

        global cur_answer, is_generating
        if saved_paths:
            if len(saved_paths) == 1:
                cur_answer = f"Image created at {saved_paths[0]}"
            else:
                # Render as bullets for frontend to format
                bullets = "\n".join([f"- {p}" for p in saved_paths])
                cur_answer = f"Images created at:\n{bullets}"
        elif agent_result is not None and isinstance(agent_result, dict) and "generated_script" in agent_result:
            cur_answer = agent_result["generated_script"]
        else:
            cur_answer = json.dumps(agent_result) if isinstance(agent_result, dict) else ("" if agent_result is None else str(agent_result))
        is_generating = False
        workflow_run_status[wf_id] = {"status": "done", "result": final_res}
        # print(final_res)

        manager.clear_workflows()
        logger.info(f"clear all workflows after workflow {wf_id} is done")

    except Exception as e:
        workflow_run_status[wf_id] = {"status": "error", "result": str(e)}
        manager.clear_workflows()
        logger.info(f"clear all workflows when an error occurs: {str(e)}")
    finally:
        # Ensure watcher tasks are cancelled on any exit path
        try:
            for t in locals().get('watcher_tasks', []) or []:
                if not t.done():
                    t.cancel()
        except Exception:
            pass

def register_custom_node_endpoint(model_name: str, python_version: str, 
                                service_path: str, dependency_path: str, factory: str,
                                description: Optional[str] = None, port: Optional[int] = None,
                                env_name: Optional[str] = None, install_dependencies: bool = True,
                                io_specs: Optional[dict] = None,
                                log_path: Optional[str] = None):
    """
    Register a custom node
    
    Parameters:
    - model_name: Name of the custom node
    - python_version: Python version for creating or reusing conda environment (e.g., 3.9)
    - service_path: Entry point to start the node service (e.g., 'custom_node:app')
    - dependency_path: Absolute path to the node's requirements.txt file
    - factory: The factory the node belongs to (e.g., 'TissueClassify/NucleiSeg/Custom/...')
    
    Process:
    1. If a Node named model_name already exists in the system, first stop and remove the old environment
    2. Call register_custom_node(...) to start the new service
    3. If the startup is successful, use the returned port to create a CustomNodeWrapper and register it to TaskNodeManager
    """
    old_node_name = model_name
    if old_node_name in manager.nodes:
        try:
            logger.info(f"[register_custom_node_endpoint] Removing existing node '{old_node_name}' from manager before re-registration")
            manager.remove_node(old_node_name)
            manager.detect_workflows()
        except Exception as rm_err:
            logger.warning(f"[register_custom_node_endpoint] Failed to remove existing node '{old_node_name}': {rm_err}")

        from app.services.register_service import CUSTOM_NODE_SERVICE_REGISTRY, stop_custom_node_process
        env_to_remove = None
        for registry_key, info in list(CUSTOM_NODE_SERVICE_REGISTRY.items()):
            if info.get("model_name") == old_node_name:
                env_to_remove = registry_key
                break

        if env_to_remove:
            logger.info(f"[register_custom_node_endpoint] Stopping old process for env: {env_to_remove}")
            stop_res = stop_custom_node_process(env_to_remove)
            if stop_res.get("status") == "success":
                logger.info(f"[register_custom_node_endpoint] Stopped old process for env: {env_to_remove}")
            else:
                logger.warning(f"[register_custom_node_endpoint] Warning: failed to stop old process: {stop_res}")
        logger.info(f"[update_node] Node '{old_node_name}' has been removed from manager for re-registration.")

    logger.info(f"[register_custom_node_endpoint] Starting custom node service for '{model_name}' on env '{env_name or 'auto'}'...")

    # Pre-register into ModelStore so the node appears in the Model Zoo immediately.
    # Port may not be known yet; it will be updated after startup if successful.
    try:
        # Determine canonical h5_group from defaults if any
        store_nodes = model_store.get_nodes_extended()
        default_h5_group = None
        if isinstance(store_nodes, dict):
            default_meta = store_nodes.get(model_name, {})
            if isinstance(default_meta, dict) and default_meta.get("h5_group"):
                default_h5_group = default_meta.get("h5_group")

        # Prefer provided env name, else derive one
        try:
            from app.services.register_service import get_env_name_from_model
            derived_env = env_name or get_env_name_from_model(model_name)
        except Exception:
            derived_env = env_name or f"{model_name}_tissuelab_ai_service_tasknode"

        prereg_meta = {
            **({"description": description.strip()} if isinstance(description, str) and description.strip() != "" else {}),
            **({"h5_group": default_h5_group} if default_h5_group else {}),
            **({"inputs": io_specs.get("inputs")} if (io_specs and io_specs.get("inputs") is not None) else {}),
            **({"outputs": io_specs.get("outputs")} if (io_specs and io_specs.get("outputs") is not None) else {}),
            "runtime": {
                "env_name": derived_env,
                "service_path": service_path,
                "dependency_path": dependency_path,
                "python_version": python_version,
                # tentative port if provided; will be updated after success
                **({"port": port} if port else {}),
                **({"log_path": log_path} if log_path else {}),
            }
        }
        model_store.register_node(model_name, factory, metadata=prereg_meta)
    except Exception as e:
        logger.warning(f"[register_custom_node_endpoint] Pre-register to ModelStore failed (non-fatal): {e}")
    # Announce starting
    try:
        set_activation_state(model_name, "starting", {"env_name": env_name})
    except Exception:
        pass

    result = service_register_custom_node(
        model_name=model_name,
        service_path=service_path,
        dependency_path=dependency_path,
        python_version=python_version,
        port=port,
        env_name=env_name,
        install_dependencies=install_dependencies,
        log_path=log_path,
    )

    if result.get("status") != "success":
        # Bubble up log_path when available for frontend to fetch logs
        resp = {"code": 1, "message": result.get("message", "Registration failed")}
        if result.get("log_path"):
            resp["data"] = {"log_path": result["log_path"]}
        try:
            set_activation_state(model_name, "failed", {"message": resp.get("message"), **(resp.get("data") or {})})
        except Exception:
            pass
        return resp

    port = result.get("port")
    logger.info(f"[register_custom_node_endpoint] Service reported up on port {port}; registering node in manager")
    # create CustomNodeWrapper package
    node_obj = CustomNodeWrapper(name=model_name, port=port, factory=factory)
    try:
        manager.add_node(node_obj)
    except Exception as e:
        return {"code": 1, "message": f"Failed to add node to manager: {str(e)}"}

    # Register into ModelStore so it appears as a plugin
    try:
        # Determine canonical h5_group from defaults if any
        store_nodes = model_store.get_nodes_extended()
        default_h5_group = None
        if isinstance(store_nodes, dict):
            default_meta = store_nodes.get(model_name, {})
            if isinstance(default_meta, dict) and default_meta.get("h5_group"):
                default_h5_group = default_meta.get("h5_group")

        # Store runtime config; do not overwrite description unless provided; preserve h5_group if known
        register_meta = {
            # Only pass description when defined and non-empty
            **({"description": description.strip()} if isinstance(description, str) and description.strip() != "" else {}),
            # Keep or set h5_group when known
            **({"h5_group": default_h5_group} if default_h5_group else {}),
            **({"inputs": io_specs.get("inputs")} if (io_specs and io_specs.get("inputs") is not None) else {}),
            **({"outputs": io_specs.get("outputs")} if (io_specs and io_specs.get("outputs") is not None) else {}),
            "runtime": {
                "env_name": result.get("env_name") or env_name,
                "service_path": service_path,
                "dependency_path": dependency_path,
                "python_version": python_version,
                "port": result.get("port") or port,
                **({"log_path": result.get("log_path")} if result.get("log_path") else {}),
            }
        }
        model_store.register_node(model_name, factory, metadata=register_meta)
    except Exception as e:
        logger.warning(f"Failed to register node into ModelStore: {e}")

    # Keep in-memory map in sync for running process
    FACTORY_MODEL_DICT = model_store.get_category_map()

    # Attach log_path to response for frontend consumption
    ok = {"code": 0, "data": result}
    try:
        if result.get("log_path"):
            ok["data"]["log_path"] = result["log_path"]
    except Exception:
        pass
    try:
        set_activation_state(model_name, "ready", {"port": result.get("port"), "env_name": result.get("env_name")})
    except Exception:
        pass
    return ok

def save_annotation(handler, req: dict, background_tasks=None) -> dict:
    """
    Save annotation data using the original sequential structure.
    The HDF5 file structure for this:
    - /user_annotation/nuclei_annotations (JSON string of sequential dict: {"0": {cell_ID, centroid_x, centroid_y, cell_class, cell_color, ...}, "1": {...}})
    - /ClassificationNode/userData/ (to store params for the classification node like organ, nuclei_classes, nuclei_colors)
    """
    # Get instanceId from request
    instance_id = req.get("instance_id")
    if not instance_id:
        logger.error("[save_annotation] No instance_id provided in the request.")
        return {"success": False, "message": "No instance_id provided"}
    
    # Get session data for this instance
    from app.services.load_service import get_session_data
    session_data = get_session_data(instance_id)
    
    # Use session-specific file path if available, otherwise fall back to request path
    if session_data.get('current_file_path'):
        # Prefer '<wsi_path>.h5' convention; if already .h5, use as-is
        wsi_path = session_data['current_file_path']
        h5_path = wsi_path if str(wsi_path).lower().endswith('.h5') else f"{wsi_path}.h5"
        logger.info(f"[save_annotation] Using session-specific H5 path: {h5_path}")
    else:
        h5_path = resolve_path(req.get("path"))
        logger.warning(f"[save_annotation] No session file path found, using request path: {h5_path}")
    
    ui_nuclei_classes = req.get("ui_nuclei_classes")
    ui_nuclei_colors = req.get("ui_nuclei_colors")
    ui_organ = req.get("ui_organ")
    
    logger.info(f"[save_annotation] Received request: instance_id='{instance_id}', path='{h5_path}', classes='{ui_nuclei_classes}', colors='{ui_nuclei_colors}', organ='{ui_organ}'")

    if not h5_path:
        logger.error("[save_annotation] No H5 path available.")
        return {"success": False, "message": "No H5 path available"}

    if not os.path.exists(h5_path):
        logger.error(f"[save_annotation] H5 file not found at {h5_path}")
        return {"success": False, "message": f"H5 file not found at {h5_path}"}

    # Get annotation data from request
    matching_indices = req.get("matching_indices", [])
    classification = req.get("classification")
    color = req.get("color")
    
    # --- BEGIN CACHE UPDATE ---
    # Update the SegmentationHandler's in-memory state with the latest from the UI (device-scoped handler)
    handler.ensure_file_loaded_in_cache(h5_path)
    if ui_nuclei_classes and ui_nuclei_colors:
        handler.update_class_definitions(ui_nuclei_classes, ui_nuclei_colors)
    # --- END CACHE UPDATE ---
    
    region_geometry = req.get("region_geometry", {})
    method = req.get("method", "rectangle selection")
    annotator = req.get("annotator", "Unknown")
    auto_run = req.get("auto_run_classification", False)
    
    # Create temporary file for repack
    temp_dir = os.path.dirname(h5_path)
    if not temp_dir:
        temp_dir = "."
    os.makedirs(temp_dir, exist_ok=True)
    temp_file_path = os.path.join(temp_dir, f"temp_annotation_{int(time.time())}_{os.getpid()}.h5")
    
    try:
        
        # 1. Check if file needs repacking based on modification count and create optimized temp file
        from app.services.h5_repack_service import should_repack_file, H5RepackService
        
        # Track modification count for this H5 file using a unified counter file
        counter_file = os.path.join(os.path.dirname(__file__), "h5_modification_counts.json")
        modification_count = 0
        
        # Load existing modification counts
        modification_counts = {}
        try:
            if os.path.exists(counter_file):
                with open(counter_file, 'r', encoding='utf-8') as f:
                    modification_counts = json.load(f)
                
                # Clean up entries for files that no longer exist
                cleaned_counts = {}
                for file_path, count in modification_counts.items():
                    if os.path.exists(file_path):
                        cleaned_counts[file_path] = count
                    else:
                        logger.info(f"[save_annotation] Removed count for non-existent file: {file_path}")
                
                # Save cleaned counts if any were removed
                if len(cleaned_counts) != len(modification_counts):
                    with open(counter_file, 'w', encoding='utf-8') as f:
                        json.dump(cleaned_counts, f, indent=2, ensure_ascii=False)
                    logger.info(f"[save_annotation] Cleaned up {len(modification_counts) - len(cleaned_counts)} non-existent file entries")
                
                modification_counts = cleaned_counts
        except Exception as e:
            logger.warning(f"[save_annotation] Failed to read modification counts: {e}")
        
        # Get current count for this H5 file
        modification_count = modification_counts.get(h5_path, 0)
        modification_count += 1
        modification_counts[h5_path] = modification_count
        
        # Save updated counts
        try:
            with open(counter_file, 'w', encoding='utf-8') as f:
                json.dump(modification_counts, f, indent=2, ensure_ascii=False)
        except Exception as e:
            logger.warning(f"[save_annotation] Failed to write modification counts: {e}")
        
        logger.info(f"[save_annotation] H5 file modification count: {modification_count}")
        logger.info(f"[save_annotation] Total tracked H5 files: {len(modification_counts)}")
        
        repack_needed = False
        # Configurable repack threshold - can be overridden by environment variable
        repack_threshold = int(os.environ.get('H5_REPACK_THRESHOLD', '10'))  # Default: 5 modifications
        logger.info(f"[save_annotation] Repack threshold: {repack_threshold} modifications")
        
        if modification_count >= repack_threshold:
            try:
                repack_check = should_repack_file(h5_path, size_threshold_mb=50.0, fragmentation_threshold=0.1)
                repack_needed = repack_check.get("should_repack", False)
                logger.info(f"[save_annotation] Repack check result (modification {modification_count}): {repack_check}")
            except Exception as e:
                logger.warning(f"[save_annotation] Repack check failed: {e}")
            
            # Reset modification count after repack
            if repack_needed:
                try:
                    # Reset count for this specific H5 file after successful repack
                    modification_counts[h5_path] = 0
                    with open(counter_file, 'w', encoding='utf-8') as f:
                        json.dump(modification_counts, f, indent=2, ensure_ascii=False)
                    logger.info(f"[save_annotation] Reset modification count for {h5_path} after repack")
                except Exception as e:
                    logger.warning(f"[save_annotation] Failed to reset modification count: {e}")
        else:
            logger.info(f"[save_annotation] Skipping repack check (modification {modification_count}/{repack_threshold})")
        
        if repack_needed:
            # Use repack service to create optimized temp file
            logger.info(f"[save_annotation] File needs repacking, creating optimized temp file...")
            repack_service = H5RepackService(
                compression=None,
                compression_opts=None,
                chunk_size=1000,
                shuffle=False
            )
            repack_result = repack_service.repack_file(
                h5_path,
                temp_file_path,
                preserve_metadata=True,
                optimize_datasets=False
            )
            if not repack_result.get("success", False):
                logger.warning(f"[save_annotation] Repack failed, falling back to simple copy: {repack_result.get('error', 'Unknown error')}")
                shutil.copy2(h5_path, temp_file_path)
            else:
                logger.info(f"[save_annotation] Successfully created optimized temp file")
        else:
            # Simple copy if no repack needed
            logger.info(f"[save_annotation] No repack needed, copying {h5_path} to temporary file {temp_file_path}")
            shutil.copy2(h5_path, temp_file_path)
            logger.info(f"[save_annotation] Successfully copied to temporary file")

        # 2. Read and check centroids
        with h5py.File(temp_file_path, 'r') as readf:
            if "SegmentationNode/centroids" not in readf:
                logger.error("[save_annotation] No SegmentationNode/centroids found in H5")
                return {"success": False, "message": "No seg centroids found in H5"}
            centroids_dataset = readf["SegmentationNode/centroids"]
            if centroids_dataset.shape == ():  # scalar dataset
                centroids = centroids_dataset[()]
            else:  # array dataset
                centroids = centroids_dataset[:]
            logger.info(f"[save_annotation] Loaded centroids from H5. Count: {len(centroids)}")

        # 3. Open temp H5 file and write annotations using sequential structure
        with h5py.File(temp_file_path, "a") as hf:
            ann_group_path = "user_annotation"
            if ann_group_path not in hf:
                group_anno = hf.create_group(ann_group_path)
                logger.info(f"[save_annotation] Created group: {ann_group_path}")
            else:
                group_anno = hf[ann_group_path]

            ds_name = "nuclei_annotations"
            existing_dict = {}
            if ds_name in group_anno:
                raw_bytes = group_anno[ds_name][()]
                if raw_bytes:
                    try:
                        existing_dict = json.loads(raw_bytes.decode("utf-8"))
                        logger.info(f"[save_annotation] Loaded existing annotations. Count: {len(existing_dict)}")
                    except Exception as e:
                        logger.warning(f"[save_annotation] Error loading existing annotations: {e}. Starting fresh.")
                        existing_dict = {}

            valid_annotations_added = 0
            if not matching_indices or classification is None or color is None:
                logger.warning("[save_annotation] Missing matching_indices, classification, or color in request")
            else:
                for idx in matching_indices:
                    if idx < 0 or idx >= len(centroids):
                        logger.warning(f"[save_annotation] Invalid cell index {idx} for centroids (count: {len(centroids)}). Skipping.")
                        continue

                    # Calculate centroid coordinates with 16x scaling (original structure)
                    cx16 = centroids[idx][0] * 16
                    cy16 = centroids[idx][1] * 16

                    from datetime import datetime
                    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]

                    # Create annotation item with original structure
                    new_item = {
                        "cell_ID": int(idx),
                        "centroid_x": int(cx16),
                        "centroid_y": int(cy16),
                        "cell_class": classification,
                        "cell_color": color,
                        "annotator": annotator,
                        "datetime": now_str,
                        "method": method,
                        "region_geometry": region_geometry
                    }

                    # Use sequential key (original structure)
                    next_key = str(len(existing_dict))
                    existing_dict[next_key] = new_item
                    valid_annotations_added += 1

                logger.info(f"[save_annotation] Added {valid_annotations_added} new annotations. Total now: {len(existing_dict)}")

            # Save updated annotations
            out_str = json.dumps(existing_dict, ensure_ascii=False)
            if ds_name in group_anno:
                del group_anno[ds_name]
            group_anno.create_dataset(ds_name, data=out_str.encode("utf-8"))
            hf.flush()
            logger.info(f"[save_annotation] Saved updated nuclei_annotations to H5")

            # New: Update class_counts dataset
            counts_ds_name = "class_counts"
            counts_dict = {}
            if counts_ds_name in group_anno:
                counts_raw = group_anno[counts_ds_name][()]
                if counts_raw:
                    try:
                        counts_dict = json.loads(counts_raw.decode("utf-8"))
                        logger.info(f"[save_annotation] Loaded existing class_counts: {counts_dict}")
                    except Exception as e:
                        logger.warning(f"[save_annotation] Error loading class_counts: {e}. Starting fresh.")
                        counts_dict = {}

            if classification and valid_annotations_added > 0:
                if classification not in counts_dict:
                    counts_dict[classification] = 0
                counts_dict[classification] += valid_annotations_added
                logger.info(f"[save_annotation] Updated count for '{classification}': {counts_dict[classification]}")

            counts_out_str = json.dumps(counts_dict, ensure_ascii=False)
            if counts_ds_name in group_anno:
                del group_anno[counts_ds_name]
            group_anno.create_dataset(counts_ds_name, data=counts_out_str.encode("utf-8"))
            hf.flush()
            logger.info(f"[save_annotation] Saved updated class_counts to H5")

            # If auto-run is enabled and UI class definitions are provided, update ClassificationNode/userData
            if auto_run and ui_nuclei_classes and ui_nuclei_colors:
                logger.info("[save_annotation] Auto-run enabled. Updating ClassificationNode/userData with UI class definitions")
                user_data_path = "ClassificationNode/userData"
                if user_data_path in hf:
                    del hf[user_data_path]  # Clear old user data for ClassificationNode
                node_group = hf.create_group(user_data_path)
                
                classes_json = json.dumps(ui_nuclei_classes, ensure_ascii=False)
                node_group.create_dataset("nuclei_classes", data=classes_json.encode("utf-8"))
                
                colors_json = json.dumps(ui_nuclei_colors, ensure_ascii=False)
                node_group.create_dataset("nuclei_colors", data=colors_json.encode("utf-8"))
                
                # Save path and organ if provided
                node_group.create_dataset("path", data=str(h5_path).encode("utf-8"))
                if ui_organ is not None:
                    node_group.create_dataset("organ", data=str(ui_organ).encode("utf-8"))
                
                hf.flush()
                logger.info("[save_annotation] ClassificationNode/userData updated")

        # 4. Use temp file to replace original H5 (already optimized if needed)
        logger.info(f"[save_annotation] Attempting to replace original file {h5_path} with {temp_file_path}")
        
        # Force release any file handles before replacement
        try:
            from app.services.seg_service import force_release_all_h5_files, force_release_all_file_locks, _h5_cache
            force_release_all_h5_files()
            force_release_all_file_locks()
            
            # Force refresh cache to release any cached file handles
            _h5_cache.force_refresh_cache(h5_path)
            
            logger.info(f"[save_annotation] Released all file handles and locks before replacement")
        except Exception as e:
            logger.warning(f"[save_annotation] Failed to release file handles: {e}")
        
        # Additional Windows-specific file handle release
        try:
            gc.collect()  # Force garbage collection to release Python file handles
            
            # Try to close any open h5py files that might be holding the file
            # This is a bit of a hack, but it helps release h5py file handles
            for obj in gc.get_objects():
                if isinstance(obj, h5py.File) and obj.filename == h5_path:
                    try:
                        obj.close()
                        logger.info(f"[save_annotation] Closed h5py file handle for {h5_path}")
                    except:
                        pass
        except Exception as e:
            logger.warning(f"[save_annotation] Failed to release h5py handles: {e}")
        
        # Wait for file to be released by other processes
        def wait_for_file_release(file_path, max_wait_time=10.0):
            """Wait for file to be released by other processes"""
            start_time = time.time()
            last_size = None
            last_mtime = None
            stable_count = 0
            
            while time.time() - start_time < max_wait_time:
                try:
                    # Check if file is being written to by monitoring file size and modification time
                    if os.path.exists(file_path):
                        current_size = os.path.getsize(file_path)
                        current_mtime = os.path.getmtime(file_path)
                        
                        # Check if file size and modification time are stable
                        size_stable = (last_size is not None and current_size == last_size)
                        mtime_stable = (last_mtime is not None and current_mtime == last_mtime)
                        
                        if size_stable and mtime_stable:
                            stable_count += 1
                            if stable_count >= 3:  # File stable for 3 checks
                                logger.info(f"[save_annotation] File stable (size: {current_size}, mtime: {current_mtime}), assuming write complete")
                                break
                        else:
                            stable_count = 0
                            if not size_stable:
                                logger.info(f"[save_annotation] File size changed from {last_size} to {current_size}, still writing...")
                            if not mtime_stable:
                                logger.info(f"[save_annotation] File mtime changed from {last_mtime} to {current_mtime}, still writing...")
                        
                        last_size = current_size
                        last_mtime = current_mtime
                    
                    # Try to open file in exclusive mode to check if it's available
                    with open(file_path, 'r+b') as f:
                        pass  # If we can open it, it's available
                    return True
                except (PermissionError, OSError) as e:
                    logger.debug(f"[save_annotation] File still locked: {e}")
                    time.sleep(0.1)
            return False
        
        gc.collect()
        logger.info(f"[save_annotation] Waiting for file to be released: {h5_path}")
        if not wait_for_file_release(h5_path, max_wait_time=10.0):
            logger.warning(f"[save_annotation] File still locked after 10s, proceeding with replacement attempts")
        
        # Try multiple replacement strategies for Windows compatibility
        replacement_successful = False
        max_attempts = 3
        
        for attempt in range(max_attempts):
            try:
                if attempt == 0:
                    # First try: direct replace
                    os.replace(temp_file_path, h5_path)
                    replacement_successful = True
                    logger.info(f"[save_annotation] Direct replace successful on attempt {attempt + 1}")
                    break
                elif attempt == 1:
                    # Second try: copy and delete (Windows fallback)
                    shutil.copy2(temp_file_path, h5_path)
                    os.remove(temp_file_path)
                    replacement_successful = True
                    logger.info(f"[save_annotation] Copy-and-delete successful on attempt {attempt + 1}")
                    break
                else:
                    # Third try: backup original and replace
                    backup_path = h5_path + ".backup"
                    if os.path.exists(backup_path):
                        os.remove(backup_path)
                    os.rename(h5_path, backup_path)
                    os.rename(temp_file_path, h5_path)
                    replacement_successful = True
                    logger.info(f"[save_annotation] Backup-and-replace successful on attempt {attempt + 1}")
                    # Clean up backup after successful replacement
                    try:
                        os.remove(backup_path)
                    except:
                        pass
                    break
            except (PermissionError, OSError) as e:
                logger.warning(f"[save_annotation] Replace attempt {attempt + 1} failed: {e}")
                if attempt < max_attempts - 1:
                    # Wait longer between attempts and try to release handles
                    wait_time = (attempt + 1) * 2.0  # Increasing wait time: 2s, 4s
                    logger.info(f"[save_annotation] Waiting {wait_time}s before next attempt...")
                    time.sleep(wait_time)
                    
                    # Try to release file handles again
                    try:
                        from app.services.seg_service import force_release_all_h5_files, force_release_all_file_locks
                        force_release_all_h5_files()
                        force_release_all_file_locks()
                        logger.info(f"[save_annotation] Released file handles before attempt {attempt + 2}")
                    except Exception as release_e:
                        logger.warning(f"[save_annotation] Failed to release handles: {release_e}")
                    
                    # Wait for file to be released again and check if writing is complete
                    logger.info(f"[save_annotation] Checking if file is still being written before attempt {attempt + 2}")
                    if not wait_for_file_release(h5_path, max_wait_time=5.0):
                        logger.warning(f"[save_annotation] File still locked before attempt {attempt + 2}")
                    else:
                        logger.info(f"[save_annotation] File appears to be available for attempt {attempt + 2}")
        
        if not replacement_successful:
            logger.error(f"[save_annotation] All replacement attempts failed")
            return {"success": False, "message": "Failed to replace H5 file after multiple attempts"}
        
        # After successful replacement, proactively invalidate and refresh cache
        try:
            try:
                os.utime(h5_path, None)
            except Exception:
                pass
            from app.services.seg_service import force_refresh_h5_cache, smart_preload_data, _h5_cache
            
            # Step 1: Force refresh cache to clear old data
            logger.info(f"[save_annotation] Step 1: Force refreshing cache for {h5_path}")
            force_refresh_h5_cache(h5_path)
            
            # Step 2: Wait a moment for file system to stabilize
            time.sleep(0.1)
            
            # Step 3: Synchronously reload cache with fresh data
            logger.info(f"[save_annotation] Step 2: Synchronously reloading cache for {h5_path}")
            smart_preload_data(h5_path, force_reload=True)
            
            # Step 4: Wait for cache to be fully populated
            time.sleep(0.1)
            
            # Step 5: Notify all handlers that the file has changed (after cache is ready)
            logger.info(f"[save_annotation] Step 3: Notifying handlers of file change for {h5_path}")
            _h5_cache.notify_handlers_file_changed(h5_path)
            
            # Step 6: Force invalidate user counts cache to ensure fresh data
            logger.info(f"[save_annotation] Step 4: Invalidating user counts cache")
            handler.invalidate_user_counts_cache()
            
            # Step 7: Verify cache was updated by checking if data is available
            try:
                cache_data = _h5_cache.get_cached_data(h5_path)
                if cache_data:
                    logger.info(f"[save_annotation] Step 5: Cache verification successful - {len(cache_data)} datasets cached")
                else:
                    logger.warning(f"[save_annotation] Step 5: Cache verification failed - no data in cache")
            except Exception as verify_err:
                logger.warning(f"[save_annotation] Step 5: Cache verification error: {verify_err}")
            
            logger.info(f"[save_annotation] Cache refresh sequence completed for {h5_path}")
        except Exception as cache_err:
            logger.warning(f"[save_annotation] Failed to refresh cache after replace: {cache_err}")
            # Even if cache refresh fails, we should still notify handlers
            try:
                _h5_cache.notify_handlers_file_changed(h5_path)
                handler.invalidate_user_counts_cache()
            except Exception:
                pass
        logger.info(f"[save_annotation] Successfully replaced original H5 file")
        temp_file_path = ""  # Reset so it won't be deleted in finally block

        # 6. Return success
        return {"success": True, "message": "Annotation saved"}

    except Exception as e:
        logger.error(f"[save_annotation] Error during H5 operation: {e}", exc_info=True)
        return {"success": False, "message": f"Error saving annotation: {str(e)}"}
    finally:
        # Clean up temp file if it still exists
        if temp_file_path and os.path.exists(temp_file_path):
            try:
                os.remove(temp_file_path)
                logger.info(f"[save_annotation] Cleaned up temporary file: {temp_file_path}")
            except Exception as rm_err:
                logger.error(f"[save_annotation] Error cleaning up temporary file {temp_file_path}: {rm_err}")

def save_tissue(handler, req: dict, background_tasks=None):
    """
    Receive tissue area coordinates (and optional polygon points),
    find precise matching patches, and save classification to H5 file.
    Coordinates in req (start_x etc., polygon_points) are expected in RAW OSD format.
    """
    h5_path = resolve_path(req.get("path", ""))

    # ... (Checks for h5_path and file existence) ...
    if not h5_path or not os.path.exists(h5_path):
         return {"success": False, "error": f"H5 file not found or path missing: {h5_path}"}


    # Get and validate BBox coordinates (raw OSD coordinates)
    if not all(k in req for k in ["start_x", "start_y", "end_x", "end_y"]):
        return {"success": False, "error": "Missing required BBox coordinate parameters: start_x, start_y, end_x, end_y"}
    try:
        x1 = float(req["start_x"])
        y1 = float(req["start_y"])
        x2 = float(req["end_x"])
        y2 = float(req["end_y"])
        if x1 >= x2 or y1 >= y2: raise ValueError("Invalid BBox: start >= end")
    except (ValueError, TypeError) as e:
        return {"success": False, "error": f"Invalid BBox coordinates: {e}"}

    # Get and parse optional polygon points (raw OSD coordinates)
    polygon_points_raw = req.get("polygon_points")
    polygon_points: Optional[List[Tuple[float, float]]] = None
    if polygon_points_raw and isinstance(polygon_points_raw, list):
         try: # Add validation
             if all(isinstance(p, (list, tuple)) and len(p) == 2 and all(isinstance(c, (int, float)) for c in p) for p in polygon_points_raw):
                 polygon_points = [(float(p[0]), float(p[1])) for p in polygon_points_raw]
                 print(f"[save_tissue] Parsed {len(polygon_points)} polygon vertices.")
             else: print(f"[WARN] Invalid format for polygon_points.")
         except Exception as e: print(f"[WARN] Error processing polygon_points: {e}")

    classification = req.get("classification", "Negative control")
    color = req.get("color", "#aaaaaa") # Default color maybe different for tissue?
    method = "polygon selection" if polygon_points else req.get("method", "rectangle selection")
    annotator = req.get("annotator", "Unknown")

    matching_indices = []
    # Use device-scoped handler

    try:
        # Ensure patch data is loaded for the correct file
        handler.ensure_file_loaded_in_cache(h5_path) # Use cached read

        if not hasattr(handler, 'patch_coordinates') or handler.patch_coordinates is None:
            raise ValueError("Patch coordinates data could not be loaded from HDF5.")

        original_patch_coords_level0 = np.array(handler.patch_coordinates)
        total_patches = len(original_patch_coords_level0)

        if total_patches > 0:
            # --- Scale HDF5 Patch Coords to Match Frontend OSD Coords ---
            scale_factor = 16
            scaled_patch_coords = original_patch_coords_level0 * scale_factor
            patch_x1_scaled = scaled_patch_coords[:, 0]
            patch_y1_scaled = scaled_patch_coords[:, 1]
            patch_x2_scaled = scaled_patch_coords[:, 2]
            patch_y2_scaled = scaled_patch_coords[:, 3]
            print(f"[DEBUG] save_tissue - Scaled backend patch coords Min/Max X1: {np.min(patch_x1_scaled)} / {np.max(patch_x1_scaled)}")
            print(f"[DEBUG] save_tissue - Scaled backend patch coords Min/Max Y1: {np.min(patch_y1_scaled)} / {np.max(patch_y1_scaled)}")
            # -----------------------------------------------------------

            # calculate patch centroids
            patch_centroids_x = np.mean(scaled_patch_coords[:, [0, 2]], axis=1)  # get x direction center point
            patch_centroids_y = np.mean(scaled_patch_coords[:, [1, 3]], axis=1)  # get y direction center point

            # use centroid to determine if it's inside the bbox
            bbox_mask = (
                (patch_centroids_x >= x1) & (patch_centroids_x <= x2) &
                (patch_centroids_y >= y1) & (patch_centroids_y <= y2)
            )
            indices_in_bbox = np.where(bbox_mask)[0]
            print(f"[DEBUG] save_tissue - Found {len(indices_in_bbox)} patches with centroids inside BBox.")

            # if there is a polygon, continue with PIP test
            if polygon_points and MATPLOTLIB_AVAILABLE:
                points_to_test = np.column_stack((
                    patch_centroids_x[indices_in_bbox], 
                    patch_centroids_y[indices_in_bbox]
                ))
                
                try:
                    polygon_path = Path(polygon_points)
                    tolerance_radius = -1e-9
                    is_inside = polygon_path.contains_points(points_to_test, radius=tolerance_radius)
                    final_indices_mask = np.where(is_inside)[0]
                    matching_indices = indices_in_bbox[final_indices_mask].tolist()
                    print(f"[DEBUG] save_tissue - PIP test completed, {len(matching_indices)} patch centroids inside polygon.")
                except Exception as pip_error:
                    print(f"[ERROR] save_tissue - Error during PIP test: {pip_error}")
                    traceback.print_exc()
                    matching_indices = indices_in_bbox.tolist()
                    print("[WARN] save_tissue - Falling back to BBox centroid results due to PIP error.")
            else:
                matching_indices = indices_in_bbox.tolist()

        # Now 'matching_indices' holds the precise list of patch indices

    except Exception as query_err:
         logger.error(f"Error during patch querying in save_tissue: {query_err}")
         traceback.print_exc()
         return {"success": False, "error": f"Error querying patches: {query_err}"}

    # --- Proceed with saving using the precise matching_indices ---
    if not matching_indices:
        print("[save_tissue] No matching patches found to save.")
        return {"success": True, "message": "No matching patches found in the specified region.", "matching_indices": []}

    # ... (Rest of the HDF5 saving logic using temp file - this part seems okay) ...
    # It correctly iterates through `matching_indices` and saves info to `tissue_annotations` dataset.
    temp_dir = os.path.dirname(h5_path)
    os.makedirs(temp_dir, exist_ok=True)
    temp_file = os.path.join(temp_dir, f"temp_tissue_{int(time.time())}.h5")
    try:
        shutil.copy2(h5_path, temp_file)
        print(f"[save_tissue] Copied H5 to temp file: {temp_file}")
        with h5py.File(temp_file, "a") as hf:
            # ... (get or create user_annotation group) ...
            ann_group_path = "user_annotation"
            group_anno = hf.require_group(ann_group_path)
            ds_name = "tissue_annotations"
            existing_dict = {}
            # ... (load existing_dict from dataset if exists) ...
            if ds_name in group_anno:
                 raw_bytes = group_anno[ds_name][()]
                 if raw_bytes:
                     try: existing_dict = json.loads(raw_bytes.decode("utf-8"))
                     except Exception as e: print(f"[WARN] Could not load '{ds_name}': {e}.")

            print(f"[save_tissue] Loaded {len(existing_dict)} existing annotations from '{ds_name}'.")
            
            count_deltas = defaultdict(int)

            for idx in matching_indices: # Use precise indices
                key = str(idx) # Use the patch_ID as the dictionary key
                
                previous_class = existing_dict.get(key, {}).get("tissue_class")

                # If we are changing the classification, calculate the delta
                if previous_class != classification:
                    if previous_class is not None:
                        count_deltas[previous_class] -= 1 # Decrement old class count
                    count_deltas[classification] += 1 # Increment new class count

                now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                new_item = { # Create item using the correct index 'idx'
                    "patch_ID": int(idx),
                    "tissue_class": classification, "tissue_color": color,
                    "annotator": annotator, "datetime": now_str, "method": method
                }
                existing_dict[key] = new_item # This overwrites any previous entry for the same patch

            print(f"[save_tissue] Added/Updated {len(matching_indices)} annotations based on matching_indices.")
            # ... (save updated existing_dict back to dataset) ...
            out_str = json.dumps(existing_dict, ensure_ascii=False)
            if ds_name in group_anno: del group_anno[ds_name]
            dset = group_anno.create_dataset(ds_name, data=out_str.encode("utf-8"))
            print(f"[save_tissue] Saved updated annotations to dataset '{ds_name}'.")
            hf.flush()

            # New: Update or create patch_class_counts dataset
            counts_ds_name = "patch_class_counts"
            counts_dict = {}
            if counts_ds_name in group_anno:
                counts_raw = group_anno[counts_ds_name][()]
                if counts_raw:
                    try:
                        counts_dict = json.loads(counts_raw.decode("utf-8"))
                    except Exception as e:
                        print(f"[WARN] Could not load '{counts_ds_name}': {e}.")
            
            # Apply the calculated deltas to the counts
            for cls, delta in count_deltas.items():
                counts_dict[cls] = counts_dict.get(cls, 0) + delta
                if counts_dict[cls] < 0: # Safety check
                    counts_dict[cls] = 0

            counts_out_str = json.dumps(counts_dict, ensure_ascii=False)
            if counts_ds_name in group_anno:
                del group_anno[counts_ds_name]
            group_anno.create_dataset(counts_ds_name, data=counts_out_str.encode("utf-8"))
            hf.flush()
            print(f"[save_tissue] Saved updated patch_class_counts to H5")

        # ... (Replace original file with temp file) ...
        print(f"[save_tissue] Attempting to replace original file.")
        gc.collect()
        time.sleep(0.2)
        os.replace(temp_file, h5_path)
        # After repack/replace, proactively invalidate and refresh cache
        try:
            try:
                os.utime(h5_path, None)
            except Exception:
                pass
            from app.services.seg_service import force_refresh_h5_cache, smart_preload_data
            force_refresh_h5_cache(h5_path)
            # Kick off cache rebuild in background to avoid blocking response
            try:
                threading.Thread(target=smart_preload_data, args=(h5_path, True), daemon=True).start()
            except Exception:
                # Fallback to synchronous if threading fails
                smart_preload_data(h5_path, force_reload=True)
            logger.info(f"[export_annotations] Cache invalidated and refreshed after replace: {h5_path}")
        except Exception as cache_err:
            logger.warning(f"[export_annotations] Failed to refresh cache after replace: {cache_err}")
        print(f"[save_tissue] Successfully replaced original H5 file.")
        if os.path.exists(temp_file):
            try: os.remove(temp_file)
            except Exception as rm_err: print(f"[WARN] Could not remove temp file: {rm_err}")

        # Invalidate the patch counts cache to ensure freshness on next query
        handler.invalidate_patch_counts_cache()

        return {"success": True, "message": f"Tissue annotation saved for {len(matching_indices)} patches", "matching_indices": matching_indices}

    except Exception as e:
        # ... (Error handling, remove temp file) ...
         logger.error(f"Error during save_tissue HDF5 operation: {e}")
         traceback.print_exc()
         if os.path.exists(temp_file):
             try: os.remove(temp_file)
             except Exception as rm_err_on_error: print(f"[WARN] Could not remove temp file after error: {rm_err_on_error}")
         return {"success": False, "error": str(e)}
    
def run_classification(req: dict):
    """ Run classification after saving annotation """
    h5_path = resolve_path(req.get("path", ""))
    if not h5_path or not os.path.exists(h5_path):
        return {"success": False, "error": "invalid h5 file path"}
    try:
        # record start operation
        logger.info(f"Starting classification on: {h5_path}")
        logger.info(f"Classification parameters: {req}")
        # 1. write parameters to H5 file's ClassificationNode/userData section
        try:
            from app.services.seg_service import safe_h5_context_manager
            with safe_h5_context_manager(h5_path, "a", max_retries=10, retry_delay=2.0, timeout=60.0) as hf:
                user_data_path = "ClassificationNode/userData"
                if user_data_path in hf:
                    del hf[user_data_path]
                node_group = hf.create_group(user_data_path)
                # add nuclei_classes parameter
                if "nuclei_classes" in req and req["nuclei_classes"]:
                    classes_json = json.dumps(req["nuclei_classes"], ensure_ascii=False)
                    node_group.create_dataset("nuclei_classes", data=classes_json.encode("utf-8"))
                # add nuclei_colors parameter
                if "nuclei_colors" in req and req["nuclei_colors"]:
                    colors_json = json.dumps(req["nuclei_colors"], ensure_ascii=False)
                    node_group.create_dataset("nuclei_colors", data=colors_json.encode("utf-8"))
                # add organ parameter
                if "organ" in req:
                    node_group.create_dataset("organ", data=str(req["organ"]).encode("utf-8"))
                hf.flush()
            logger.info("Successfully wrote user parameters to H5 file")
        except Exception as e:
            logger.error(f"Error writing user parameters: {e}")
            return {"success": False, "error": f"Error writing user parameters: {e}"}
        # 2. call ClassificationNode's /init interface
        logger.info("Calling ClassificationNode /init")
        init_url = "http://localhost:8006/init"
        try:
            init_resp = requests.post(init_url, json={}, timeout=30)
            init_resp.raise_for_status()
            logger.info("ClassificationNode /init done")
        except Exception as e:
            logger.error(f"Error calling init: {e}")
            return {"success": False, "error": f"Error calling init: {e}"}
        # 3. call ClassificationNode's /read interface, pass h5 path
        logger.info("Calling ClassificationNode /read")
        read_url = "http://localhost:8006/read"
        read_data = {
            "node_name": "ClassificationNode",
            "dependencies": [],
            "h5_path": h5_path
        }
        try:
            read_resp = requests.post(read_url, json=read_data, timeout=30)
            read_resp.raise_for_status()
            logger.info("ClassificationNode /read done")
        except Exception as e:
            logger.error(f"Error calling read: {e}")
            return {"success": False, "error": f"Error calling read: {e}"}
        # 4. call ClassificationNode's /execute interface to perform classification
        logger.info("Calling ClassificationNode /execute")
        execute_url = "http://localhost:8006/execute"
        try:
            exec_resp = requests.post(execute_url, json={}, timeout=120)
            exec_resp.raise_for_status()
            result = exec_resp.json()
            logger.info("ClassificationNode /execute done")
        except Exception as e:
            logger.error(f"Error calling execute: {e}")
            return {"success": False, "error": f"Error calling execute: {e}"}
        # wait for 1 second
        time.sleep(1)
        logger.info("Classification completed successfully")
        return {"success": True, "message": "classification completed successfully", "result": result.get("output", {})}
    except Exception as e:
        logger.error(f"Classification error: {e}")
        gc.collect()
        return {"success": False, "error": f"Error during classification: {str(e)}"}

# Constants for objective-based physical field of view
OBJECTIVE_FOV_DEFAULTS = {
    40: 320.0,   # 40x equivalent field of view width in microns (default)
    80: 160.0,   # 80x equivalent field of view width in microns
    100: 128.0   # 100x equivalent field of view width in microns
}
DEFAULT_MAGNIFICATION = 40

def _create_isolated_slide_object(file_path: str):
    """Create an isolated slide object for a specific task using TiffSlide/wrapper"""
    from tissuelab_sdk.wrapper import (TiffSlideWrapper, TiffFileWrapper, 
                    SimpleImageWrapper, DicomImageWrapper, 
                    NiftiImageWrapper)
    try:
        from tissuelab_sdk.wrapper import ISyntaxImageWrapper
    except:
        ISyntaxImageWrapper = None
    try:
        from tissuelab_sdk.wrapper import CziImageWrapper
    except:
        CziImageWrapper = None

    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File {file_path} not found")

    file_ext = file_path.rsplit('.', 1)[1].lower()

    if file_ext in ['tif', 'tiff', 'btf']:
        try:
            # First try tiffslide
            slide_obj = TiffSlideWrapper(file_path)
        except Exception as e:
            # If tiffslide fails, try our wrapper
            slide_obj = TiffFileWrapper(file_path)
    elif file_ext in ['svs', 'qptiff']:
        slide_obj = TiffSlideWrapper(file_path)
    elif file_ext in ['ndpi']:
        # For NDPI files, use TiffSlideWrapper (tiffslide compatible)
        slide_obj = TiffSlideWrapper(file_path)
    elif file_ext in ['jpeg', 'jpg', 'png', 'bmp']:
        slide_obj = SimpleImageWrapper(file_path)
    elif file_ext in ['isyntax']:
        slide_obj = ISyntaxImageWrapper(file_path)
    elif file_ext in ['czi']:
        slide_obj = CziImageWrapper(file_path)
    elif file_ext in ['dcm']:
        slide_obj = DicomImageWrapper(file_path)
    elif file_ext in ['nii']:
        slide_obj = NiftiImageWrapper(file_path)
    else:
        raise ValueError(f"Unsupported file format: {file_ext}")

    return slide_obj

def get_cell_review_tile_data(req: dict) -> dict:
    """
    Generate a cropped tile image centered on a specific cell for review.
    
    Args:
        req: Dictionary containing:
            - slide_id: Identifier for the slide (path to SVS/H5 file)
            - cell_id: Identifier for the cell
            - centroid: {"x": float, "y": float} in original image coordinates
            - window_size_px: Size of the patch window in pixels
            - contour_type: None (no contour), 'polygon' (precise contour), 'rect' (bbox contour)
    """
    try:
        from tissuelab_sdk.wrapper import TiffSlideWrapper, TiffFileWrapper
        
        # Extract parameters 
        slide_id = req.get("slide_id", "")
        cell_id = req.get("cell_id", "")
        centroid = req.get("centroid", {})
        patchsize = req.get("window_size_px", 512)  
        contour_type = req.get("contour_type", None)  
        windowsize = 512  
        
        # Validate input
        if not all([slide_id, cell_id, "x" in centroid, "y" in centroid]):
            return {"success": False, "error": "Invalid input parameters"}
        
        center_x = float(centroid["x"])
        center_y = float(centroid["y"])
        
        # Determine and resolve the slide and H5 paths
        # Web clients pass relative paths (e.g., "cmu-1/CMU-1.svs"); resolve to STORAGE_ROOT
        resolved_input_path = resolve_path(slide_id)
        # If a resolved .h5 is given, prefer the image path by stripping extension
        slide_path = resolved_input_path
        if slide_path.endswith('.h5'):
            slide_path = slide_path[:-3]  # strip trailing '.h5'
        # Resolve H5 path alongside the slide image path
        h5_path = resolve_path(slide_id if slide_id.endswith('.h5') else slide_id + '.h5')

        if not os.path.exists(slide_path):
            return {"success": False, "error": f"Slide file not found: {slide_path}"}

        # Get contour data from H5 file first
        contour = None
        if os.path.exists(h5_path):
            contour_data = _get_cell_contour_from_h5(h5_path, cell_id)
            if contour_data:
                # Convert to numpy array format
                contour = np.array([[point["x"], point["y"]] for point in contour_data])
        
        if contour is None or len(contour) == 0:
            return {"success": False, "error": f"No contour data found for cell {cell_id}"}
        
        # calculate bounds from contour (not centroid!)
        coord = [
            float(np.min(contour[:, 0])), 
            float(np.min(contour[:, 1])), 
            float(np.max(contour[:, 0])), 
            float(np.max(contour[:, 1]))
        ]
        w = coord[2] - coord[0]
        h = coord[3] - coord[1]
        
        # center the patch around contour bounds
        offset_x = int(np.round((patchsize - w) / 2))
        offset_y = int(np.round((patchsize - h) / 2))
        new_coord = [
            int(coord[0] - offset_x), 
            int(coord[1] - offset_y), 
            int(coord[2] + offset_x), 
            int(coord[3] + offset_y)
        ]
        
        # Open slide and read region using isolated slide object
        try:
            # Create isolated slide object using TiffSlide/wrapper
            slide = _create_isolated_slide_object(slide_path)

            # Read pixel spacing if available
            pixel_spacing_um = None
            try:
                # Try tiffslide properties first
                if 'tiffslide.mpp-x' in slide.properties:
                    pixel_spacing_um = float(slide.properties['tiffslide.mpp-x'])
                # Fallback to legacy property names for compatibility
                elif 'openslide.mpp-x' in slide.properties:
                    pixel_spacing_um = float(slide.properties['openslide.mpp-x'])
            except:
                pass
            
            region_width = int(new_coord[2] - new_coord[0])
            region_height = int(new_coord[3] - new_coord[1])
            
            # Validate bounds
            slide_dims = slide.dimensions
            if (new_coord[0] < 0 or new_coord[1] < 0 or 
                new_coord[0] + region_width > slide_dims[0] or 
                new_coord[1] + region_height > slide_dims[1]):
                # Adjust bounds to fit within slide
                new_coord[0] = int(max(0, new_coord[0]))
                new_coord[1] = int(max(0, new_coord[1]))
                region_width = int(min(region_width, slide_dims[0] - new_coord[0]))
                region_height = int(min(region_height, slide_dims[1] - new_coord[1]))
            
            image = slide.read_region(
                location=(new_coord[0], new_coord[1]), 
                level=0, 
                size=(region_width, region_height)
            )
            
            # remove alpha channel and convert to RGBA
            image = Image.fromarray(np.array(image)[..., :3])
            image = image.convert('RGBA')
            
            if contour_type is not None:
                # Calculate contour relative coordinates 
                contour_relative = np.copy(contour)
                contour_relative[:, 0] = contour[:, 0] - coord[0] + offset_x
                contour_relative[:, 1] = contour[:, 1] - coord[1] + offset_y
                
                # contour drawing logic with auto type selection
                current_contour_type = contour_type
                rectwidth = 1
                offset_on_screen = 5
                
                # Auto-select contour type based on patch size 
                if patchsize > 500:
                    current_contour_type = 'rect'
                    rectwidth = 5
                    offset_on_screen = 10
                if patchsize > 1000:
                    rectwidth = 10
                    offset_on_screen = 15
                if patchsize > 2000:
                    rectwidth = 20
                    offset_on_screen = 20
                
                # Create transparent overlay for contour
                transp = Image.new('RGBA', image.size, (0, 0, 0, 0))
                draw = ImageDraw.Draw(transp, 'RGBA')
                
                if current_contour_type == 'rect':
                    # Rectangle contour
                    bbox = np.zeros((2, 2))
                    bbox[0, 0] = np.min(contour_relative[:, 0]) - offset_on_screen
                    bbox[1, 0] = np.max(contour_relative[:, 0]) + offset_on_screen
                    bbox[0, 1] = np.min(contour_relative[:, 1]) - offset_on_screen
                    bbox[1, 1] = np.max(contour_relative[:, 1]) + offset_on_screen
                    draw.rectangle(
                        [bbox[0, 0], bbox[0, 1], bbox[1, 0], bbox[1, 1]],
                        fill=None, 
                        outline=(255, 255, 0, 255), 
                        width=rectwidth
                    )
                elif current_contour_type == 'polygon':
                    # Polygon contour
                    contour_tuples = [(contour_relative[ci, 0], contour_relative[ci, 1]) 
                                    for ci in range(len(contour_relative))]
                    draw.polygon(
                        contour_tuples,
                        outline=(255, 255, 0, 255),  
                    )
                
                # Apply contour overlay
                image.paste(Image.alpha_composite(image, transp))
            
            # Convert to RGB for JPEG encoding
            final_image = image.convert('RGB')
            
            # Resize to display size
            if final_image.size != (windowsize, windowsize):
                final_image = final_image.resize((windowsize, windowsize), Image.Resampling.LANCZOS)
            
            # Convert to base64
            buffered = BytesIO()
            final_image.save(buffered, format="JPEG", quality=95, optimize=True)
            img_base64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
            image_data_url = f"data:image/jpeg;base64,{img_base64}"
            
            slide.close()
            
        except Exception as e:
            return {"success": False, "error": f"Error processing slide: {str(e)}"}
        
        # Prepare response data
        response_data = {
            "image": image_data_url,
            "bounds": {
                "x": new_coord[0],
                "y": new_coord[1], 
                "w": region_width,
                "h": region_height
            },
            "centroid": {
                "x": center_x,
                "y": center_y
            },
            "pixel_spacing_um": pixel_spacing_um,
            "fov_um": float(patchsize * pixel_spacing_um) if pixel_spacing_um else None,
            "contour": [{"x": float(point[0]), "y": float(point[1])} for point in contour] if contour is not None else None
        }
        
        # Get classification data from H5 file
        if os.path.exists(h5_path):
            classification_data = _get_cell_classification_from_h5(h5_path, cell_id)
            if classification_data:
                response_data.update(classification_data)
        
        return {"success": True, "data": response_data}
        
    except Exception as e:
        logger.error(f"Error in get_cell_review_tile_data: {str(e)}")
        return {"success": False, "error": f"Error generating cell review tile: {str(e)}"}

def _get_cell_classification_from_h5(h5_path: str, cell_id: str) -> Optional[Dict]:
    """
    Helper function to retrieve cell classification data from H5 file.
    Reads classification data from ClassificationNode group.
    
    Args:
        h5_path: Path to H5 file
        cell_id: String representation of cell index
        
    Returns:
        Dictionary containing classification data: {"predicted_class": str, "probs": dict, "label": str} or None
    """
    try:
        from app.services.seg_service import safe_h5_context_manager
        with safe_h5_context_manager(h5_path, 'r', max_retries=5, retry_delay=1.0, timeout=30.0) as hf:
            # Look for classification data in ClassificationNode
            if 'ClassificationNode' in hf:
                class_group = hf['ClassificationNode']
                cell_idx = int(cell_id)
                
                result = {}
                
                # Get predicted class
                if 'nuclei_class' in class_group:
                    nuclei_class_dataset = class_group['nuclei_class']
                    if cell_idx < len(nuclei_class_dataset):
                        # Decode if it's bytes
                        predicted_class = nuclei_class_dataset[cell_idx]
                        if isinstance(predicted_class, bytes):
                            predicted_class = predicted_class.decode('utf-8')
                        result["predicted_class"] = str(predicted_class)
                
                # Get probabilities - look for probability datasets
                probs_dict = {}
                for dataset_name in class_group.keys():
                    if dataset_name.startswith('nuclei_probs_') or 'prob' in dataset_name.lower():
                        try:
                            prob_dataset = class_group[dataset_name] 
                            if cell_idx < len(prob_dataset):
                                class_name = dataset_name.replace('nuclei_probs_', '').replace('_prob', '')
                                probs_dict[class_name] = float(prob_dataset[cell_idx])
                        except Exception as e:
                            logger.warning(f"Could not read probability dataset {dataset_name}: {e}")
                            continue
                
                # Alternative: look for a single probs dataset with multiple columns
                if not probs_dict and 'nuclei_probs' in class_group:
                    try:
                        probs_dataset = class_group['nuclei_probs']
                        if cell_idx < len(probs_dataset) and len(probs_dataset[cell_idx]) > 0:
                            # Assume first column is prob for first class, etc.
                            # You may need to adjust this based on your actual data structure
                            prob_values = probs_dataset[cell_idx]
                            # Try to get class names from userData or other metadata
                            class_names = ['Negative control', 'Macrophages']  # Default fallback
                            if 'userData' in class_group:
                                user_data = class_group['userData']
                                if 'nuclei_classes' in user_data:
                                    try:
                                        classes_data = user_data['nuclei_classes'][()]
                                        if isinstance(classes_data, bytes):
                                            classes_data = classes_data.decode('utf-8')
                                        class_names = json.loads(classes_data)
                                    except:
                                        pass
                            
                            for i, class_name in enumerate(class_names):
                                if i < len(prob_values):
                                    probs_dict[class_name] = float(prob_values[i])
                    except Exception as e:
                        logger.warning(f"Could not read nuclei_probs dataset: {e}")
                
                if probs_dict:
                    result["probs"] = probs_dict
                
                # Look for user labels/annotations
                if 'user_annotation' in hf:
                    try:
                        user_group = hf['user_annotation']
                        if 'nuclei_annotation' in user_group:
                            user_dataset = user_group['nuclei_annotation']
                            if cell_idx < len(user_dataset):
                                user_label = user_dataset[cell_idx]
                                if isinstance(user_label, bytes):
                                    user_label = user_label.decode('utf-8')
                                if user_label and str(user_label) != 'nan' and str(user_label) != '':
                                    result["label"] = str(user_label)
                    except Exception as e:
                        logger.warning(f"Could not read user annotation: {e}")
                
                if result:
                    logger.info(f"Retrieved classification data for cell {cell_id}: {result}")
                    return result
                
            logger.info(f"No classification data found for cell {cell_id} in H5 file")
            return None
            
    except Exception as e:
        logger.warning(f"Error reading classification from H5 file {h5_path}: {str(e)}")
        return None

def _get_cell_contour_from_h5(h5_path: str, cell_id: str) -> Optional[List[Dict[str, float]]]:
    """
    Helper function to retrieve cell contour from H5 file.
    Reads contour data from SegmentationNode/contours dataset.
    
    Args:
        h5_path: Path to H5 file
        cell_id: String representation of cell index
        
    Returns:
        List of contour points as [{"x": float, "y": float}] or None if not found
    """
    try:
        from app.services.seg_service import safe_h5_context_manager
        with safe_h5_context_manager(h5_path, 'r', max_retries=5, retry_delay=1.0, timeout=30.0) as hf:
            # Look for segmentation data in SegmentationNode
            if 'SegmentationNode' in hf:
                seg_group = hf['SegmentationNode']
                
                # Check if contours are stored
                if 'contours' in seg_group:
                    contours_dataset = seg_group['contours']
                    cell_idx = int(cell_id)
                    
                    # Validate cell index
                    if cell_idx < 0 or cell_idx >= len(contours_dataset):
                        logger.warning(f"Cell ID {cell_id} is out of range (0-{len(contours_dataset)-1})")
                        return None
                    
                    # Get contour for specific cell
                    # Shape is (max_points, 2) where max_points is typically 32
                    cell_contour = contours_dataset[cell_idx]
                    
                    # Filter out zero points (padding) and convert to list of dicts
                    valid_points = []
                    for point in cell_contour:
                        x, y = float(point[0]), float(point[1])
                        # Skip zero-padded points (assuming real coordinates are > 0)
                        if x > 0 and y > 0:
                            valid_points.append({"x": x, "y": y})
                    
                    if len(valid_points) >= 3:  # Need at least 3 points for a valid contour
                        logger.info(f"Retrieved {len(valid_points)} contour points for cell {cell_id}")
                        return valid_points
                    else:
                        logger.warning(f"Cell {cell_id} has insufficient valid contour points: {len(valid_points)}")
                        return None
                        
            # Check alternative group names
            elif 'NucleiSegmentationNode' in hf:
                # Legacy support for different naming
                nuclei_group = hf['NucleiSegmentationNode']
                if 'contours' in nuclei_group:
                    contours_dataset = nuclei_group['contours']
                    cell_idx = int(cell_id)
                    
                    if cell_idx >= 0 and cell_idx < len(contours_dataset):
                        cell_contour = contours_dataset[cell_idx]
                        valid_points = []
                        for point in cell_contour:
                            x, y = float(point[0]), float(point[1])
                            if x > 0 and y > 0:
                                valid_points.append({"x": x, "y": y})
                        
                        if len(valid_points) >= 3:
                            return valid_points
            
            logger.info(f"No contour data found for cell {cell_id} in H5 file")
            return None
            
    except Exception as e:
        logger.warning(f"Error reading contour from H5 file {h5_path}: {str(e)}")
        return None

def reset_h5_classification_data(h5_path: str) -> dict:
    """
    Deletes classification and user annotation data from an H5 file.
    Specifically removes 'ClassificationNode' and 'user_annotation' groups.
    """
    if not os.path.exists(h5_path):
        return {"status": "error", "message": f"H5 file not found at {h5_path}"}
        
    try:
        from app.services.seg_service import safe_h5_context_manager
        with safe_h5_context_manager(h5_path, 'a', max_retries=10, retry_delay=2.0, timeout=60.0) as hf:
            # Delete ClassificationNode if it exists
            classification_node_name = "ClassificationNode"
            if classification_node_name in hf:
                del hf[classification_node_name]
                print(f"Deleted group '{classification_node_name}' from {h5_path}")

            # Delete user_annotation group if it exists
            user_annotation_group_name = "user_annotation"
            if user_annotation_group_name in hf:
                del hf[user_annotation_group_name]
                print(f"Deleted group '{user_annotation_group_name}' from {h5_path}")

        # After deleting from H5, forcefully reset the segmentation service's caches.
        try:
            from app.services.seg_service import clear_all_caches_and_reset_handler
            clear_all_caches_and_reset_handler()
            print(f"Forcefully reset all caches in seg_service for {h5_path}")
        except ImportError as e:
            print(f"Could not import or call clear_all_caches_and_reset_handler: {e}")
            
        return {"status": "success", "message": "Successfully reset classification and user annotations in H5 file."}
    except Exception as e:
        error_message = f"An error occurred while resetting H5 file: {e}"
        print(f"{error_message}\n{traceback.format_exc()}")
        return {"status": "error", "message": error_message}

def reset_patch_classification_data(h5_path: str) -> dict:
    """
    Remove patch classification datasets under MuskNode (keys starting with 'tissue_')
    and remove the 'user_annotation' group. Preserve MuskNode embedding datasets
    (embedding, coordinates, probability, output).
    """
    try:
        if not os.path.exists(h5_path):
            return {"status": "error", "message": f"H5 file not found at {h5_path}"}

        removed = []
        from app.services.seg_service import safe_h5_context_manager
        with safe_h5_context_manager(h5_path, 'a', max_retries=10, retry_delay=2.0, timeout=60.0) as hf:
            # Remove user annotations entirely
            if 'user_annotation' in hf:
                del hf['user_annotation']
                removed.append('user_annotation')

            # Remove tissue_* datasets under MuskNode only
            if 'MuskNode' in hf:
                grp = hf['MuskNode']
                to_delete = []
                for key in list(grp.keys()):
                    if str(key).startswith('tissue_'):
                        to_delete.append(key)
                for key in to_delete:
                    del grp[key]
                    removed.append(f"MuskNode/{key}")
            hf.flush()

        # Reset service-side caches to avoid stale data
        try:
            from app.services.seg_service import clear_all_caches_and_reset_handler
            clear_all_caches_and_reset_handler()
        except Exception:
            pass

        return {"status": "success", "message": "Patch classification data cleared", "removed": removed}
    except Exception as e:
        return {"status": "error", "message": f"Failed to reset patch classification: {e}\n{traceback.format_exc()}"}

def is_file_locked(file_path: str) -> bool:
    """Check if h5 file is locked"""
    try:
        with h5py.File(file_path, 'r+') as _:
            return False
    except Exception:
        return True

def reset_answer():
    """Reset the global cur_answer variable to None"""
    global cur_answer
    cur_answer = None
    
def mark_generating():
    """Mark the server-side generation flag so /tasks/v1/get_answer returns 'wait'."""
    global is_generating
    is_generating = True

def post_answer(answer: str):
    """Post an answer string and mark generation complete so Chatbox can consume it."""
    global cur_answer, is_generating
    cur_answer = answer
    is_generating = False
    
async def start_workflow_from_frontend(frontend_data: dict, auth_header: str | None = None):
    """
    Start a workflow from frontend data
    
    Parameters:
    - frontend_data: Dictionary containing workflow configuration, including h5_path and step information
    
    Returns:
    - On success: {"success": True, "message": "...", "workflow_id": id, "task_info": {...}}
    - On failure: {"success": False, "error": "error message"}
    """
    # Clear any existing workflows and dependencies
    manager.clear_workflows()
    logger.info("at the beginning of the workflow, clear all workflows and dependencies")

    if "h5_path" not in frontend_data:
        return {"success": False, "error": "You must provide 'h5_path'"}

    h5_path = frontend_data["h5_path"]
    global current_h5_path
    current_h5_path = h5_path
    global is_generating
    is_generating = True

    steps_data = {k: v for k, v in frontend_data.items() if k != "h5_path"}
    steps = list(steps_data.items())
    steps.sort(key=lambda x: x[0])  # sort step1, step2...

    node_names = []
    node_inputs = {}

    script_prompt = None  # store script prompt

    for stepKey, stepVal in steps:
        panel_type = stepVal["model"] # This is panel.type from frontend
        userInput = stepVal.get("input", None)

        # find the script model
        if panel_type.lower() == "scripts":
            script_prompt = userInput.get("prompt", None)
            print(f"script_prompt: {script_prompt}")
            node_execution_status["Scripts"] = 0  # Initialize to "not started"
            continue

        # Determine the actual node name service will register as
        # For NucleiSeg panel, panel_type is "SegmentationNode", but actual service is "NucSegNode"
        if panel_type == "NucSegNode" or panel_type == "SegmentationNode": # panel_type comes from frontend factory model selection
            actual_node_name_for_h5 = "SegmentationNode"
            print(f"Ensuring H5 node name is 'SegmentationNode' for panel type '{panel_type}'.")
        else:
            actual_node_name_for_h5 = panel_type # For other models like TissueClassify etc.

        if actual_node_name_for_h5 not in manager.nodes:
            # Check if the original panel_type is in manager.nodes if mapping occurred, for error message clarity
            check_name_for_error = panel_type if panel_type != actual_node_name_for_h5 else actual_node_name_for_h5
            return {"success": False, "error": f"Node '{check_name_for_error}' (resolved to '{actual_node_name_for_h5}') not found in manager. Make sure it's already created & running."}

        node_names.append(actual_node_name_for_h5) # Use the actual name for dependency chain
        node_inputs[actual_node_name_for_h5] = userInput # Use actual name as key for HDF5 writing

    # add_dependency
    for i in range(len(node_names) - 1):
        fromN = node_names[i]
        toN = node_names[i + 1]
        dep_res = _add_dependency_internal(fromN, toN)
        if "error" in dep_res:
            return {"success": False, "error": dep_res["error"]}

    manager.detect_workflows()

    # print all workflows for debugging
    logger.info(f"detected workflows: {manager.workflows}")

    # find the workflow that matches the requested nodes exactly
    requested_nodes_set = set(node_names)
    matching_wf_id = None

    for wf_id, wf_nodes in manager.workflows.items():
        # check if the workflow contains all requested nodes and only the requested nodes
        if set(wf_nodes) == requested_nodes_set:
            matching_wf_id = wf_id
            logger.info(f"found the workflow that matches the requested nodes exactly: ID={wf_id}, nodes={wf_nodes}")
            break

    # if no exact match is found, but we only have one node, find the workflow that contains that node
    if matching_wf_id is None and len(node_names) == 1:
        for wf_id, wf_nodes in manager.workflows.items():
            if node_names[0] in wf_nodes and len(wf_nodes) == 1:
                matching_wf_id = wf_id
                logger.info(f"found the workflow that contains the requested node: ID={wf_id}, nodes={wf_nodes}")
                break

    if matching_wf_id is None:
        return {"success": False, "error": f"cannot find the workflow that matches the requested nodes: {node_names}"}

    # use the found matching workflow ID
    wf_id = matching_wf_id
    logger.info(f"select the workflow to execute: ID={wf_id}, nodes={manager.workflows.get(wf_id, [])}")

    workflow_run_status[wf_id] = {"status": "running", "result": None, "h5_path": h5_path}
    
    # Create backup of H5 file before workflow execution
    backup_path = create_workflow_backup(h5_path, wf_id)
    if backup_path:
        logger.info(f"Created backup for workflow {wf_id}: {backup_path}")
    else:
        logger.warning(f"Failed to create backup for workflow {wf_id}")
    
    # Also prepare execution-time h5_group mapping for this run
    try:
        nodes_meta = model_store.get_nodes_extended()
        if isinstance(nodes_meta, dict) and hasattr(manager, 'h5_group_by_node'):
            for n in node_names:
                meta = nodes_meta.get(n, {}) if isinstance(nodes_meta, dict) else {}
                if isinstance(meta, dict) and meta.get('h5_group'):
                    manager.h5_group_by_node[n] = meta.get('h5_group')
    except Exception:
        pass

    return {
        "success": True,
        "message": f"Workflow '{wf_id}' submitted to background",
        "workflow_id": wf_id,
        "task_info": {
            "wf_id": wf_id,
            "node_inputs": node_inputs,
            "script_prompt": script_prompt,
            "h5_path": h5_path,
            "auth_token": auth_header
        }
    }

def list_node_ports():
    """
    List all TaskNodes and their port numbers.
    
    This function collects port information from:
    1. The services dictionary
    2. The TaskNodeManager nodes
    3. Custom nodes from the custom node registry
    
    Returns:
    - A dictionary with node information, success status, and error message if any
    """
    try:
        logger.debug("[list_node_ports] begin")
        # Get ports from services dictionary (ONLY include running services)
        service_ports = {}
        for service_name, details in services.items():
            if details.get("running", False):
                service_ports[service_name] = {
                    "port": details.get("port"),
                    "running": True,
                    "file_path": details.get("file")
                }

        # Get ports from TaskNodeManager nodes
        # IMPORTANT: Do not include manager-only nodes in list_node_ports output to avoid UI showing 'Active'
        manager_nodes = {}

        # Get ports from custom node registry (ONLY include running processes)
        custom_nodes = {}
        try:
            from app.services.register_service import list_custom_node_services
            custom_services = list_custom_node_services()
            # NOTE: keys of custom_services are composite: f"{env_name}::{model_name}"
            for registry_key, info in custom_services.items():
                model_name = info.get("model_name")
                is_running = info.get("running", False)
                if model_name and is_running:
                    custom_nodes[model_name] = {
                        "port": info.get("port"),
                        "pid": info.get("pid"),
                        # Expose composite key under env_name so stop requests target a single process
                        "env_name": registry_key,
                        "running": True,
                        "log_path": info.get("log_path"),
                    }
        except ImportError:
            logger.warning("Could not import list_custom_node_services")
        except Exception as e:
            logger.warning(f"Error getting custom node services: {str(e)}")

        # Merge all port information
        all_nodes = {}

        # Add service ports
        for name, info in service_ports.items():
            if name not in all_nodes:
                all_nodes[name] = info
            else:
                all_nodes[name].update(info)

        # Add manager nodes
        for name, info in manager_nodes.items():
            if name not in all_nodes:
                all_nodes[name] = info
            else:
                all_nodes[name].update(info)

        # Add custom nodes
        for name, info in custom_nodes.items():
            if name not in all_nodes:
                all_nodes[name] = info
            else:
                all_nodes[name].update(info)

        # Enrich missing factory information using manager and model store
        try:
            from app.services.model_store import model_store
            nodes_meta = model_store.get_nodes_extended()
        except Exception:
            nodes_meta = {}
        for name, info in all_nodes.items():
            if info.get("factory") is None:
                # try manager.node_factory
                factory = manager.node_factory.get(name) if hasattr(manager, 'node_factory') else None
                if not factory:
                    # try model store metadata
                    factory = nodes_meta.get(name, {}).get("factory")
                if factory:
                    info["factory"] = factory
            # If runtime exists in model store, expose it in listing for UI
            try:
                runtime = nodes_meta.get(name, {}).get("runtime")
                if isinstance(runtime, dict):
                    for k in ["service_path", "env_name", "dependency_path", "python_version", "port", "log_path"]:
                        if k in runtime and runtime[k] is not None and not info.get(k):
                            info[k] = runtime[k]
            except Exception:
                pass

        # Add activation state from activation_states dictionary
        # This allows frontend to show "Activating" state when a node is being activated
        for name in all_nodes:
            act_state = activation_states.get(name)
            if act_state and act_state.get("status") == "starting":
                all_nodes[name]["activating"] = True
            else:
                all_nodes[name]["activating"] = False

        # Also check nodes that are activating but not yet in all_nodes (not running yet)
        for name, act_state in activation_states.items():
            if name not in all_nodes and act_state.get("status") == "starting":
                all_nodes[name] = {
                    "running": False,
                    "activating": True,
                    "port": None,
                }

        # Add helpful logging snapshot (debug level)
        try:
            logger.debug(f"[list_node_ports] nodes snapshot: {json.dumps(all_nodes, default=str)[:500]}")
        except Exception:
            pass

        return {"success": True, "nodes": all_nodes}

    except Exception as e:
        logger.error(f"Error listing node ports: {str(e)}")
        return {"success": False, "error": f"Error listing node ports: {str(e)}"}

def clear_workflow(workflow_id=None):
    """
    Clear workflow(s) and their running status
    
    Parameters:
    - workflow_id (int, optional): The workflow ID to clear. If None, all workflows are cleared.
    
    Returns:
    - A dictionary with cleared workflow IDs, reset status, success status, and error message if any
    """
    try:
        cleared_ids = []
        reset_only = False

        if workflow_id is not None:
            # Check if workflow exists
            if workflow_id not in manager.workflows:
                return {"success": False, "error": f"Workflow {workflow_id} not found"}
            
            # Clear the specified workflow
            manager.remove_workflow(workflow_id)
            
            # Clear its running status
            if workflow_id in workflow_run_status:
                del workflow_run_status[workflow_id]
            
            cleared_ids.append(workflow_id)
        else:
            # If workflow_id is not provided, clear all workflows and dependencies
            current_wf_ids = manager.list_workflows()
            cleared_ids = current_wf_ids
            
            # Clear all workflows and dependencies
            manager.clear_workflows()
            
            # Clear all running status
            workflow_run_status.clear()
            
            # Reset global status
            global is_generating, cur_answer, current_h5_path
            is_generating = False
            cur_answer = None
            current_h5_path = None
            
            reset_only = True

        return {"success": True, "cleared": cleared_ids, "reset_only": reset_only}
    
    except Exception as e:
        logger.error(f"Error when clearing workflow: {str(e)}")
        return {"success": False, "error": f"Error when clearing workflow: {str(e)}"}

async def generate_node_status_events():
    """
    Generator function for node status events used in Server-Sent Events (SSE)
    
    Status codes:
        0 - Not started
        1 - Running
        2 - Completed
    
    This endpoint uses SSE to continuously send status updates to the client.
    """
    # Initial status
    last_status = {}

    should_continue = True
    while should_continue:
        try:
            print("get status")
            current_statuses = {}

            # Determine which nodes to report based on active workflow nodes
            try:
                nodes_to_report = set()
                if manager.workflows:
                    for wf_nodes in manager.workflows.values():
                        for node_name in wf_nodes:
                            if node_name in node_execution_status:
                                nodes_to_report.add(node_name)
                if not nodes_to_report:
                    nodes_to_report = set(node_execution_status.keys())
            except Exception:
                nodes_to_report = set(node_execution_status.keys())

            for node_name in nodes_to_report:
                status = node_execution_status.get(node_name, 0)
                if status == -2:
                    status = 0
                current_statuses[node_name] = status

            # Add Scripts status if it exists in node_execution_status
            if "Scripts" in node_execution_status:
                status = node_execution_status["Scripts"]
                if status == -2:
                    status = 0
                current_statuses["Scripts"] = status

            # Only send data if statuses have changed
            print(f"current_statuses: {current_statuses}")
            if current_statuses != last_status:
                # Get progress information from the progress tracking system
                progress_data = get_node_progress()
                
                # Ensure all nodes have progress data
                for node_name in current_statuses.keys():
                    if node_name not in progress_data:
                        status = current_statuses[node_name]
                        if status == 1:  # Running
                            progress_data[node_name] = 50  # Default progress for running nodes
                        elif status == 2:  # Completed
                            progress_data[node_name] = 100
                        elif status == -1:  # Failed
                            progress_data[node_name] = 0
                        # legacy stopped (-2) treated as not started here
                        else:  # Not started
                            progress_data[node_name] = 0
                
                # Format for SSE: data: {json}\n\n
                yield f"data: {json.dumps({'node_status': current_statuses, 'node_progress': progress_data})}\n\n"
                last_status = current_statuses.copy()

            # Check if all nodes have completed (status 2) or if there's an error
            if current_statuses:  # Only check if there are nodes to monitor
                all_completed = all(status == 2 for status in current_statuses.values())
                if all_completed:
                    # Send a final completion message
                    yield f"data: {json.dumps({'node_status': current_statuses, 'workflow_complete': True})}\n\n"
                    should_continue = False
                    print("All nodes completed, terminating event stream")
                    break

            # Wait before checking again
            await asyncio.sleep(1)
        except Exception as e:
            logger.error(f"Error in SSE event generator: {str(e)}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
            # Terminate on error
            should_continue = False
            break

# Global variables for workflow management
workflow_backups = {}  # Store backup file paths for each workflow
workflow_pids = {}     # Store PIDs of running tasknode processes
workflow_rollback_needed = {}  # Track which workflows need rollback

def stop_workflow(h5_path: str):
    """
    Stop the current workflow execution and handle rollback if needed
    
    Args:
        h5_path: Path to the H5 file being processed
        
    Returns:
        dict: Result with success status and message
    """
    global is_generating, current_h5_path
    try:
        logger.info(f"Stopping workflow for H5 file: {h5_path}")
        
        # Find the workflow ID associated with this H5 file
        workflow_id = None
        for wf_id, status_info in workflow_run_status.items():
            if status_info.get("h5_path") == h5_path:
                workflow_id = wf_id
                break
        
        if workflow_id is None:
            # Try to find by current_h5_path
            if current_h5_path == h5_path:
                # Find any running workflow
                for wf_id, status_info in workflow_run_status.items():
                    if status_info.get("status") == "running":
                        workflow_id = wf_id
                        break
        
        if workflow_id is None:
            logger.warning(f"No running workflow found for H5 file: {h5_path}")
            return {"success": False, "error": "No running workflow found for this H5 file"}
        
        # Snapshot nodes that are currently running BEFORE we change any status
        previously_running_nodes = [name for name, status in node_execution_status.items() if status == 1]
        logger.info(f"Previously running nodes (snapshot): {previously_running_nodes}")
        
        # Stop all running tasknode processes for this workflow
        stopped_processes = []
        if workflow_id in workflow_pids:
            logger.info(f"Found {len(workflow_pids[workflow_id])} tracked PIDs for workflow {workflow_id}: {workflow_pids[workflow_id]}")
            for node_name, pid in workflow_pids[workflow_id].items():
                try:
                    if pid and pid > 0:
                        logger.info(f"Attempting to stop process {pid} for node {node_name}")
                        # Kill the process
                        
                        try:
                            process = psutil.Process(pid)
                            process.terminate()
                            # Wait a bit for graceful termination
                            process.wait(timeout=5)
                            logger.info(f"Gracefully terminated process {pid} for node {node_name}")
                        except psutil.TimeoutExpired:
                            # Force kill if graceful termination fails
                            process.kill()
                            logger.info(f"Force killed process {pid} for node {node_name}")
                        except psutil.NoSuchProcess:
                            logger.info(f"Process {pid} for node {node_name} already terminated")
                        
                        stopped_processes.append(node_name)
                    else:
                        logger.warning(f"Invalid PID {pid} for node {node_name}")
                except Exception as e:
                    logger.error(f"Error stopping process {pid} for node {node_name}: {e}")
        else:
            logger.warning(f"No tracked PIDs found for workflow {workflow_id}")
        
        # Update node execution status to not started (0) for any running nodes
        for node_name in manager.nodes.keys():
            if node_execution_status.get(node_name) == 1:  # If running
                node_execution_status[node_name] = 0
        
        # Rollback disabled: do not restore from backup files
        rollback_message = ""
        
        # Clean up workflow tracking data
        if workflow_id in workflow_backups:
            del workflow_backups[workflow_id]
        if workflow_id in workflow_pids:
            del workflow_pids[workflow_id]
        if workflow_id in workflow_rollback_needed:
            del workflow_rollback_needed[workflow_id]
        
        # Update workflow status
        if workflow_id in workflow_run_status:
            workflow_run_status[workflow_id]["status"] = "stopped"
            workflow_run_status[workflow_id]["result"] = "Workflow stopped by user"
        
        # Reset global state
        
        is_generating = False
        if current_h5_path == h5_path:
            current_h5_path = None
        
        # Auto-activate tasknodes after stop (simulate clicking activate button)
        restarted_nodes = []
        try:
            logger.info(f"Auto-activating tasknodes after stop... Stopped processes: {stopped_processes}")
            
            # Save node configurations BEFORE they get cleared by the stop process
            from app.services.register_service import CUSTOM_NODE_SERVICE_REGISTRY
            
            logger.info(f"CUSTOM_NODE_SERVICE_REGISTRY has {len(CUSTOM_NODE_SERVICE_REGISTRY)} entries")
            for env_name, info in CUSTOM_NODE_SERVICE_REGISTRY.items():
                logger.info(f"Registry entry: {env_name} -> model: {info.get('model_name')}")
            
            # Save configurations for ALL running custom nodes (not just stopped ones)
            # Because stopped_processes might not include all nodes that need reactivation
            saved_node_configs = {}
            running_node_names = previously_running_nodes[:]
            
            logger.info(f"Running nodes before stop (snapshot): {running_node_names}")
            
            # Pull runtime from ModelStore to enrich configs
            try:
                store_nodes = model_store.get_nodes_extended()
            except Exception:
                store_nodes = {}
            
            # Save configurations for all running nodes
            for env_name, info in CUSTOM_NODE_SERVICE_REGISTRY.items():
                model_name = info.get("model_name")
                if model_name in running_node_names or model_name in stopped_processes:
                    runtime = {}
                    try:
                        runtime = (store_nodes.get(model_name, {}) or {}).get("runtime", {}) if isinstance(store_nodes, dict) else {}
                    except Exception:
                        runtime = {}
                    saved_node_configs[model_name] = {
                        "model_name": model_name,
                        "service_path": info.get("service_path") or runtime.get("service_path"),
                        "dependency_path": info.get("dependency_path") or runtime.get("dependency_path"),
                        "python_version": info.get("python_version") or runtime.get("python_version") or "3.9",
                        "port": info.get("port") or runtime.get("port"),
                        "env_name": info.get("env_name") or runtime.get("env_name"),
                        "factory": info.get("factory", "Custom")
                    }
                    logger.info(f"Saved configuration for node: {model_name} -> {saved_node_configs[model_name]}")
            
            # Also include nodes that exist only in ModelStore runtime but not in registry (best-effort)
            try:
                for model_name, meta in (store_nodes.items() if isinstance(store_nodes, dict) else []):
                    if (model_name in running_node_names or model_name in stopped_processes) and model_name not in saved_node_configs:
                        runtime = (meta or {}).get("runtime", {})
                        if runtime.get("service_path") and (runtime.get("env_name") or runtime.get("dependency_path")):
                            saved_node_configs[model_name] = {
                                "model_name": model_name,
                                "service_path": runtime.get("service_path"),
                                "dependency_path": runtime.get("dependency_path"),
                                "python_version": runtime.get("python_version") or "3.9",
                                "port": runtime.get("port"),
                                "env_name": runtime.get("env_name"),
                                "factory": (meta or {}).get("factory", "Custom")
                            }
                            logger.info(f"Saved configuration from ModelStore for node: {model_name} -> {saved_node_configs[model_name]}")
            except Exception:
                pass
            
            logger.info(f"Saved {len(saved_node_configs)} node configurations")
            
            # Auto-activate all nodes that were running (not just the ones in stopped_processes)
            nodes_to_reactivate = list(set(running_node_names + stopped_processes))
            logger.info(f"Nodes to reactivate: {nodes_to_reactivate}")
            
            for node_name in nodes_to_reactivate:
                try:
                    logger.info(f"Processing node for reactivation: {node_name}")
                    # Use saved configuration
                    node_config = saved_node_configs.get(node_name)
                    
                    if node_config:
                        logger.info(f"Auto-activating node: {node_name} with config: {node_config}")
                        # Call register_custom_node_endpoint to activate the node
                        activate_result = register_custom_node_endpoint(
                            model_name=node_config.get("model_name"),
                            python_version=node_config.get("python_version"),
                            service_path=node_config.get("service_path"),
                            dependency_path=node_config.get("dependency_path"),
                            factory=node_config.get("factory", "Custom"),
                            description=None,
                            port=node_config.get("port"),
                            env_name=node_config.get("env_name"),
                            install_dependencies=False,
                            io_specs=None,
                            log_path=None
                        )
                        
                        logger.info(f"Activation result for {node_name}: {activate_result}")
                        
                        if activate_result.get("code") == 0:
                            restarted_nodes.append(node_name)
                            logger.info(f"Successfully auto-activated node: {node_name}")
                        else:
                            logger.warning(f"Failed to auto-activate node {node_name}: {activate_result.get('message', 'Unknown error')}")
                    else:
                        logger.warning(f"Could not find saved configuration for node {node_name}")
                        
                except Exception as e:
                    logger.error(f"Error auto-activating node {node_name}: {e}")
                    logger.error(traceback.format_exc())
                    
        except Exception as e:
            logger.error(f"Error during auto-activation process: {e}")
            logger.error(traceback.format_exc())
        
        # Prepare message with restart info
        restart_info = f" Restarted {len(restarted_nodes)} nodes." if restarted_nodes else ""
        message = f"Workflow stopped successfully. Stopped {len(stopped_processes)} processes.{rollback_message}{restart_info}"
        logger.info(message)
        
        return {
            "success": True,
            "message": message,
            "data": {
                "stopped_processes": stopped_processes,
                "workflow_id": workflow_id,
                "rollback_performed": workflow_id in workflow_rollback_needed and workflow_rollback_needed[workflow_id],
                "restarted_nodes": restarted_nodes
            }
        }
        
    except Exception as e:
        logger.error(f"Error stopping workflow: {e}")
        traceback.print_exc()
        return {"success": False, "error": f"Error stopping workflow: {str(e)}"}

def create_workflow_backup(h5_path: str, workflow_id: int):

        return None



def track_tasknode_pid(workflow_id: int, node_name: str, pid: int):
    """
    Track the PID of a tasknode process
    
    Args:
        workflow_id: ID of the workflow
        node_name: Name of the node
        pid: Process ID
    """
    try:
        if workflow_id not in workflow_pids:
            workflow_pids[workflow_id] = {}
        
        workflow_pids[workflow_id][node_name] = pid
        logger.info(f"Successfully tracking PID {pid} for node {node_name} in workflow {workflow_id}")
        logger.info(f"Current tracked PIDs for workflow {workflow_id}: {workflow_pids[workflow_id]}")
        
    except Exception as e:
        logger.error(f"Error tracking PID: {e}")

def update_node_progress(node_name: str, progress: int):
    """
    Update the progress of a specific node
    
    Args:
        node_name: Name of the node
        progress: Progress percentage (0-100)
    """
    try:
        # Store progress in a global variable for SSE updates
        if not hasattr(update_node_progress, 'node_progress'):
            update_node_progress.node_progress = {}
        
        update_node_progress.node_progress[node_name] = progress
        logger.debug(f"Updated progress for {node_name}: {progress}%")
        
    except Exception as e:
        logger.error(f"Error updating node progress: {e}")

def get_node_progress():
    """
    Get current node progress data
    
    Returns:
        dict: Node progress data
    """
    if not hasattr(update_node_progress, 'node_progress'):
        update_node_progress.node_progress = {}
    return update_node_progress.node_progress.copy()
