from collections import defaultdict, OrderedDict
import contextlib
import hashlib
import requests
import sys
import subprocess
import socket
import zarr
import os
import time
import json
import logging
import numpy as np
import gc
from typing import Dict, Optional, List, Tuple, Any
from dataclasses import dataclass, field
from math import ceil, floor, log1p
import uuid
from app.utils.workflow import TaskNode, TaskNodeManager
from app.utils.workflow.model_store import model_store
from app.utils.workflow.register import register_custom_node as service_register_custom_node
import threading
import traceback
from datetime import datetime
import aiohttp
import asyncio
import base64
from io import BytesIO
from PIL import Image, ImageDraw
import psutil
from app.utils import resolve_path
from app.core.settings import settings
from app.services.workflow.status import is_active_status
from app.config.zarr_config import (
    ZarrGroups,
    ZarrDatasets,
    find_segmentation_group,
    read_user_anno_class_palette,
    write_user_anno_class_palette,
)
from app.config.zarr_compat import (
    open_zarr,
    open_zarr_cm,
    create_array,
    create_bytes_array,
    prepare_zarr_for_workflow,
    lz4,
    as_zarr_path,
)
from scipy import ndimage

from app.utils.geometry import binary_close, cell_outline, largest_component

logger = logging.getLogger(__name__)


# Code Calculation (GPT-4o Agent): skip process_script when the workflow prompt matches last successful run.
_CODING_GEN_CACHE_GROUP = "tl_workflow_coding_gen_cache"
_CODING_GEN_CACHE_PROMPT_SHA = "cached_prompt_sha256"
_CODING_GEN_CACHE_SCRIPT = "cached_generated_script"


def _coding_script_cache_read(zarr_path: str) -> Tuple[Optional[str], Optional[str]]:
    try:
        p = resolve_path(zarr_path)
        if not p or not os.path.exists(p):
            return None, None
        with open_zarr_cm(p, "r") as zf:
            if _CODING_GEN_CACHE_GROUP not in zf:
                return None, None
            grp = zf[_CODING_GEN_CACHE_GROUP]
            if _CODING_GEN_CACHE_PROMPT_SHA not in grp or _CODING_GEN_CACHE_SCRIPT not in grp:
                return None, None
            sha_b = grp[_CODING_GEN_CACHE_PROMPT_SHA][()]
            scr_b = grp[_CODING_GEN_CACHE_SCRIPT][()]
            sha = sha_b.decode("utf-8") if isinstance(sha_b, (bytes, bytearray)) else str(sha_b)
            scr = scr_b.decode("utf-8") if isinstance(scr_b, (bytes, bytearray)) else str(scr_b)
            return sha.strip(), scr
    except Exception as exc:
        logger.debug(f"[CodingAgent] script cache read skipped: {exc}")
        return None, None


def _coding_script_cache_write(zarr_path: str, prompt_sha256: str, script: str) -> None:
    try:
        p = resolve_path(zarr_path)
        if not p or not os.path.isdir(p):
            return
        with open_zarr_cm(p, "a") as zf:
            grp = zf.require_group(_CODING_GEN_CACHE_GROUP)
            for key in (_CODING_GEN_CACHE_PROMPT_SHA, _CODING_GEN_CACHE_SCRIPT):
                if key in grp:
                    del grp[key]
            create_bytes_array(grp, _CODING_GEN_CACHE_PROMPT_SHA, prompt_sha256.encode("utf-8"))
            create_bytes_array(grp, _CODING_GEN_CACHE_SCRIPT, script.encode("utf-8"))
    except Exception as exc:
        logger.warning(f"[CodingAgent] script cache write failed: {exc}")


def _coding_script_cache_lookup(zarr_file: Optional[str], script_prompt: str) -> Optional[dict]:
    if not zarr_file or not isinstance(script_prompt, str):
        return None
    z = resolve_path(zarr_file)
    if not z or not os.path.exists(z):
        return None
    fp = hashlib.sha256(script_prompt.encode("utf-8")).hexdigest()
    cached_sha, cached_script = _coding_script_cache_read(z)
    if (
        cached_sha == fp
        and cached_script
        and isinstance(cached_script, str)
        and "def analyze_medical_image" in cached_script
    ):
        return {"generated_script": cached_script}
    return None


def _overwrite_node_user_data(node_group) -> None:
    """Clear existing userData for this node so the new paramDict fully overwrites it (no stale keys)."""
    for key in list(node_group.keys()):
        del node_group[key]


def write_node_userdata(zarr_path: str, node_name: str, param_dict: dict) -> None:
    """
    Write a single node's params to zarr {zarr_group}/userData. Call this right before
    the node executes so the node sees its own params and we avoid overwriting another
    node's userData (when they share the same zarr_group e.g. MuskNode).
    """
    if param_dict is None:
        param_dict = {}
    nodes_meta = model_store.get_nodes_extended()
    node_meta = nodes_meta.get(node_name, {}) if isinstance(nodes_meta, dict) else {}
    # zarr_group is FACTORY-bound, not model-bound: a NucleiClassify model
    # (NuClass, etc.) writes to Cell-Classification regardless of its name.
    # Priority: explicit zarr_group in node_meta -> factory mapping -> node_name.
    _FACTORY_TO_ZARR_GROUP = {
        "NucleiSeg": "Cell-Segmentation",
        "NucleiClassify": "Cell-Classification",
        "TissueSeg": "Patch-Segmentation",
        "TissueClassify": "Patch-Classification",
    }
    factory = node_meta.get("factory") if isinstance(node_meta, dict) else None
    zarr_group = (
        node_meta.get("zarr_group")
        or _FACTORY_TO_ZARR_GROUP.get(factory)
        or node_name
    )
    runtime = node_meta.get("runtime", {}) if isinstance(node_meta, dict) else {}
    is_remote = runtime.get("is_remote") is True if isinstance(runtime, dict) else False
    remote_host = runtime.get("remote_host") if is_remote and isinstance(runtime, dict) else None
    mnt_path = runtime.get("mnt_path") if is_remote and isinstance(runtime, dict) else None
    if is_remote and remote_host and mnt_path:
        param_dict = manager._convert_paths_in_data(param_dict.copy(), node_name)
    user_data_path = f"{zarr_group}/userData"
    with open_zarr_cm(zarr_path, "a") as zf:
        zf.require_group(zarr_group)
        node_group = zf.require_group(user_data_path)
        _overwrite_node_user_data(node_group)
        for k, v in param_dict.items():
            if isinstance(v, (str, int, float, bool)):
                create_bytes_array(node_group, k, str(v).encode("utf-8"))
            else:
                create_bytes_array(node_group, k, json.dumps(v, ensure_ascii=False).encode("utf-8"))
        if not param_dict:
            create_bytes_array(node_group, "_params_written", b"1")


# Per-user UI / SSE source of truth (uid -> status, wf_id, node_status, ...)
from app.services.workflow.ui_state import user_workflow_status  # noqa: E402 — shared with cancel/queue/scheduler



async def _stream_script_generation(system_prompt: str, user_prompt: str, uid: str) -> dict:
    """Stream coding-agent deltas in-process; mirror raw text into cur_answer for the polling UI.

    The blocking OpenAI stream runs in a worker thread; the coroutine only
    watches for a Stop from the panel and, when it sees one, tells the worker
    to drop the stream.
    """
    from app.services.agent.workflow_agent import get_workflow_agent, _extract_code_from_markdown

    agent = get_workflow_agent()
    user_workflow_status[uid]["cur_answer"] = ""
    stop = threading.Event()

    def _stop_requested() -> bool:
        st = user_workflow_status.get(uid, {}).get("status")
        return st in ("cancelling", "cancelled")

    def _consume() -> str:
        parts: list[str] = []
        for delta in agent.iter_script_chat_stream(system_prompt, user_prompt):
            if stop.is_set():
                break
            if isinstance(delta, str) and delta:
                parts.append(delta)
                user_workflow_status[uid]["cur_answer"] = "".join(parts)
        return "".join(parts)

    future = asyncio.get_running_loop().run_in_executor(None, _consume)
    while not future.done():
        if _stop_requested():
            stop.set()
            raise asyncio.CancelledError()
        await asyncio.sleep(0.2)
    try:
        text = future.result()
    except Exception as exc:
        return {"error": str(exc)}
    return {"generated_script": _extract_code_from_markdown(text)}


async def _generate_script_output(
    script_prompt: str,
    zarr_path: str,
    auth_header: str | None = None,
    uid: str | None = None,
) -> dict:
    """Generate the analysis script with the in-process coding agent (streamed when uid is set)."""
    if not zarr_path:
        error_msg = "Zarr file path is required"
        logger.error(f"[CodingAgent] {error_msg}")
        return {"error": error_msg}

    # Resolve path first to handle both absolute and relative paths correctly
    resolved_zarr_path = resolve_path(zarr_path)
    if not os.path.exists(resolved_zarr_path):
        error_msg = f"Zarr file not found at {zarr_path} (resolved to {resolved_zarr_path})"
        logger.error(f"[CodingAgent] {error_msg}")
        return {"error": error_msg}

    prompt_text = script_prompt if isinstance(script_prompt, str) else str(script_prompt)
    if prompt_text.strip() == "":
        prompt_text = " "

    from app.services.agent.workflow_agent import AgentNotConfigured, get_workflow_agent

    try:
        agent = get_workflow_agent()
    except AgentNotConfigured as e:
        logger.error(f"[CodingAgent] {e}")
        return {"error": str(e)}

    structure = None
    structure_json = None
    try:
        # Get Zarr structure using the tasks module walker
        from app.api.tasks import process_node

        def _read_structure():
            with open_zarr_cm(resolved_zarr_path, 'r') as zarr_file:
                return process_node("/", zarr_file)

        # Off the loop: opening the store and walking every group is one
        # zarr round trip per node, and this is a coroutine — inline it
        # stalls every other request for the length of the walk.
        structure = await asyncio.to_thread(_read_structure)
        structure_json = json.dumps(structure, indent=2)
    except Exception as struct_err:
        logger.warning(f"[CodingAgent] Failed to fetch local Zarr structure for script preview: {struct_err}")

    combined_prompt = (
        f"{prompt_text}\n\nZarr structure:\n{structure_json}"
        if structure_json else prompt_text
    )

    if uid and agent.code_provider_name == "openai":
        try:
            system_prompt, user_prompt, _ = await agent.prepare_script_prompts(
                script_task=combined_prompt,
                zarr_structure=structure_json,
                original_question=combined_prompt,
                web_search_enabled=False,
                use_scripts_library=True,
            )
            stream_result = await _stream_script_generation(system_prompt, user_prompt, uid)
            if isinstance(stream_result, dict) and "generated_script" in stream_result:
                return stream_result
            if isinstance(stream_result, dict) and stream_result.get("error"):
                logger.warning(
                    f"[CodingAgent] Stream returned error, falling back to get_script: {stream_result.get('error')}"
                )
        except asyncio.CancelledError:
            raise
        except Exception as stream_exc:
            logger.warning(f"[CodingAgent] Script stream failed, falling back: {stream_exc}")

    try:
        script = await agent.get_script(
            script_task=combined_prompt,
            zarr_structure=structure_json,
            original_question=combined_prompt,
            web_search_enabled=False,
            use_scripts_library=True,
        )
        return {"generated_script": script or ""}
    except asyncio.CancelledError:
        raise
    except Exception as e:
        error_msg = str(e)
        logger.error(f"[CodingAgent] Exception during script generation: {error_msg}", exc_info=e)
        return {"error": error_msg}


try:
    from .seg import SegmentationHandler, MATPLOTLIB_AVAILABLE
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
    def __init__(self, name: str, port: int, factory: Optional[str] = None, remote_host: Optional[str] = None):
        self.name = name
        self.port = port
        self.dependencies = []
        self.factory = factory
        self.remote_host = remote_host

    def _get_base_url(self) -> str:
        """Get the base URL for this node (localhost for local nodes, remote_host for remote nodes)."""
        if self.remote_host:
            return f"http://{self.remote_host}:{self.port}"
        else:
            return f"http://localhost:{self.port}"

    def init(self):
        url = f"{self._get_base_url()}/init"
        try:
            response = requests.post(url, timeout=10)
            return response.json()
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def read(self, data: dict):
        url = f"{self._get_base_url()}/read"
        try:
            response = requests.post(url, json=data, timeout=10)
            return response.json()
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def execute(self):
        url = f"{self._get_base_url()}/execute"
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
    except Exception as e:
        pass
        try:
            logger.error(f"activation state write failed: {e}", exc_info=True)
        except Exception:
            pass

async def generate_all_activation_events():
    """Async generator for SSE activation status for ALL models."""
    # Track last timestamp per model
    last_timestamps: Dict[str, float] = {}
    last_send_monotonic = 0.0
    HEARTBEAT_INTERVAL_SEC = 15.0
    
    # Send initial state for all existing models
    # Use list() to create a snapshot and avoid RuntimeError if dict is modified during iteration
    for model_name, state in list(activation_states.items()):
        last_timestamps[model_name] = state.get("ts", 0.0)
        payload = {"model": model_name, **state}
        yield f"data: {json.dumps(payload)}\n\n"
        last_send_monotonic = time.monotonic()
    
    # Stream updates for all models
    while True:
        await asyncio.sleep(0.5)
        now = time.monotonic()
        sent = False
        
        # Create snapshot to avoid RuntimeError if dict is modified during iteration
        # This prevents crashes if new models are added while we're iterating
        # Use list() for memory efficiency since we only iterate once
        current_states = list(activation_states.items())
        
        # Check all models for updates
        for model_name, state in current_states:
            current_ts = state.get("ts", 0.0)
            
            # Initialize tracking for new models that appear after initial send
            if model_name not in last_timestamps:
                last_timestamps[model_name] = current_ts
                # Send initial state for new model (even if ts is 0.0 for consistency)
                payload = {"model": model_name, **state}
                yield f"data: {json.dumps(payload)}\n\n"
                sent = True
                continue
            
            last_ts = last_timestamps.get(model_name, 0.0)
            
            # If this model has an update
            if current_ts > last_ts:
                last_timestamps[model_name] = current_ts
                payload = {"model": model_name, **state}
                yield f"data: {json.dumps(payload)}\n\n"
                sent = True

        if sent:
            last_send_monotonic = now
        elif (now - last_send_monotonic) >= HEARTBEAT_INTERVAL_SEC:
            # Long-lived activation stream stays open while idle — keep proxies warm.
            # Use wall-clock ts for client-side debugging (monotonic is process-local).
            yield f"data: {json.dumps({'heartbeat': True, 'ts': int(time.time())})}\n\n"
            last_send_monotonic = now

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

    # Runs the node script on this service's own interpreter. The desktop build
    # has none - sys.executable is the frozen service itself - so nodes there
    # go through register_custom_node, which starts them in their conda env.
    if getattr(sys, "frozen", False):
        return {"error": f"{service_name} cannot be started from the desktop build; "
                         "register it as a custom node so it runs in its own environment."}
    from app.utils.workflow.register import _isolated_child_env
    cmd = [
        sys.executable,
        py_file,
        "--port", str(port),
        "--name", service_name
    ]
    try:
        proc = subprocess.Popen(cmd, env=_isolated_child_env())
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
        # If already exists in services, mark it as running since the service is calling this endpoint
        # CRITICAL: Also update the port in case it changed (e.g., after cancel/reactivation)
        services[service_name]["running"] = True
        services[service_name]["port"] = port
        services[service_name]["file"] = file_path

        # Also update the port in TaskNodeManager if the node exists there
        if service_name in manager.nodes:
            manager_node = manager.nodes[service_name]
            if hasattr(manager_node, 'port'):
                manager_node.port = port

        return {
            "message": f"Service '{service_name}' already exists in services (idempotent).",
            "service_info": services[service_name]
        }

    # When a service calls create_node, it means the service is already running
    # So we set running=True to make it visible in list_node_ports
    services[service_name] = {
        "file": file_path,
        "port": port,
        "running": True  # Changed from False to True
    }

    try:
        node = PlaceholderNode(name=service_name, port=port)
        # If node already exists in manager (e.g., added by custom node registration), skip adding
        if service_name in manager.nodes:
            pass
        else:
            manager.add_node(node)
    except Exception as e:
        del services[service_name]
        return {"error": f"Failed to add node to manager: {str(e)}"}

    return {
        "message": f"Node '{service_name}' registered and marked as running",
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



def register_custom_node_endpoint(model_name: str, python_version: str,
                                service_path: str, dependency_path: str, factory: str,
                                description: Optional[str] = None, port: Optional[int] = None,
                                env_name: Optional[str] = None, install_dependencies: bool = True,
                                io_specs: Optional[dict] = None,
                                log_path: Optional[str] = None,
                                is_remote: bool = False,
                                remote_host: Optional[str] = None,
                                mnt_path: Optional[str] = None):
    """
    Register a custom node
    
    Parameters:
    - model_name: Name of the custom node
    - python_version: Python version for creating or reusing conda environment (e.g., 3.11)
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
            manager.remove_node(old_node_name)
            manager.detect_workflows()
        except Exception as rm_err:
            logger.warning(f"[register_custom_node_endpoint] Failed to remove existing node '{old_node_name}': {rm_err}")

        from app.utils.workflow.register import CUSTOM_NODE_SERVICE_REGISTRY, stop_custom_node_process
        env_to_remove = None
        for registry_key, info in list(CUSTOM_NODE_SERVICE_REGISTRY.items()):
            if info.get("model_name") == old_node_name:
                env_to_remove = registry_key
                break

        if env_to_remove:
            stop_res = stop_custom_node_process(env_to_remove)
            if stop_res.get("status") == "success":
                pass
            else:
                logger.warning(f"[register_custom_node_endpoint] Warning: failed to stop old process: {stop_res}")

    # Local activation must have a valid service executable/script path.
    # For remote activation, service_path is not used for local process launch.
    if not is_remote:
        try:
            if not isinstance(service_path, str) or not service_path.strip():
                msg = "service_path is required for local activation"
                try:
                    set_activation_state(model_name, "failed", {"message": msg})
                except Exception:
                    pass
                return {"code": 1, "message": msg}
            if not os.path.isfile(service_path):
                msg = f"service_path does not exist or is not a file: {service_path}"
                try:
                    set_activation_state(model_name, "failed", {"message": msg})
                except Exception:
                    pass
                return {"code": 1, "message": msg}
        except Exception as e:
            msg = f"Invalid service_path: {e}"
            try:
                set_activation_state(model_name, "failed", {"message": msg})
            except Exception:
                pass
            return {"code": 1, "message": msg}

    # Pre-register into ModelStore so the node appears in the Model Zoo immediately.
    # Port may not be known yet; it will be updated after startup if successful.
    try:
        # Determine canonical zarr_group from defaults if any
        store_nodes = model_store.get_nodes_extended()
        default_zarr_group = None
        existing_runtime = {}
        try:
            if isinstance(store_nodes, dict):
                existing_runtime = store_nodes.get(model_name, {}).get("runtime", {}) or {}
        except Exception:
            existing_runtime = {}

        if isinstance(store_nodes, dict):
            default_meta = store_nodes.get(model_name, {})
            if isinstance(default_meta, dict) and default_meta.get("zarr_group"):
                default_zarr_group = default_meta.get("zarr_group")

        # Prefer provided env name, else derive one
        try:
            from app.utils.workflow.register import get_env_name_from_model
            derived_env = env_name or get_env_name_from_model(model_name)
        except Exception:
            derived_env = env_name or f"{model_name}_tissuelab_ai_service_tasknode"

        prereg_meta = {
            **({"description": description.strip()} if isinstance(description, str) and description.strip() != "" else {}),
            **({"zarr_group": default_zarr_group} if default_zarr_group else {}),
            **({"inputs": io_specs.get("inputs")} if (io_specs and io_specs.get("inputs") is not None) else {}),
            **({"outputs": io_specs.get("outputs")} if (io_specs and io_specs.get("outputs") is not None) else {}),
            "runtime": {
                "env_name": derived_env,
                "service_path": service_path,
                "dependency_path": dependency_path,
                "python_version": python_version,
                # tentative port if provided; will be updated after success
                **({"port": port} if port else {}),
                # is_remote flag from frontend
                "is_remote": is_remote,
                # Preserve previously configured remote_host/mnt_path when switching
                # to local mode (is_remote=false). Execution routing uses is_remote only.
                "remote_host": remote_host if is_remote else existing_runtime.get("remote_host"),
                "mnt_path": mnt_path if is_remote else existing_runtime.get("mnt_path"),
            }
        }
        model_store.register_node(model_name, factory, metadata=prereg_meta)
    except Exception as e:
        logger.warning(f"[register_custom_node_endpoint] Pre-register to ModelStore failed (non-fatal): {e}")
    
    # For remote nodes, don't send "starting" state - they are ready immediately after health check
    # For local nodes, send "starting" state
    if not is_remote:
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
        # Important: the lower-level registration logic decides "remote vs local"
        # based on whether remote_host is provided. Ensure we only forward
        # remote_host/mnt_path when is_remote=True to avoid stale remote config.
        is_remote=is_remote,
        remote_host=remote_host if is_remote else None,
        mnt_path=mnt_path if is_remote else None,
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
    remote_host = result.get("remote_host")
    
    # For remote nodes, set ready state immediately since health check already passed
    # No "starting" state was sent, so this is the first and only state update
    if is_remote:
        try:
            set_activation_state(model_name, "ready", {
                "port": port,
                "env_name": result.get("env_name"),
                "remote_host": remote_host
            })
        except Exception:
            pass
    
    # create CustomNodeWrapper package
    node_obj = CustomNodeWrapper(name=model_name, port=port, factory=factory, remote_host=remote_host)
    try:
        manager.add_node(node_obj)
    except Exception as e:
        return {"code": 1, "message": f"Failed to add node to manager: {str(e)}"}

    # Register into ModelStore so it appears as a plugin
    try:
        # Determine canonical zarr_group from defaults if any
        store_nodes = model_store.get_nodes_extended()
        default_zarr_group = None
        if isinstance(store_nodes, dict):
            default_meta = store_nodes.get(model_name, {})
            if isinstance(default_meta, dict) and default_meta.get("zarr_group"):
                default_zarr_group = default_meta.get("zarr_group")

        # Store runtime config; do not overwrite description unless provided; preserve zarr_group if known
        register_meta = {
            # Only pass description when defined and non-empty
            **({"description": description.strip()} if isinstance(description, str) and description.strip() != "" else {}),
            # Keep or set zarr_group when known
            **({"zarr_group": default_zarr_group} if default_zarr_group else {}),
            **({"inputs": io_specs.get("inputs")} if (io_specs and io_specs.get("inputs") is not None) else {}),
            **({"outputs": io_specs.get("outputs")} if (io_specs and io_specs.get("outputs") is not None) else {}),
            "runtime": {
                "env_name": result.get("env_name") or env_name,
                "service_path": service_path,
                "dependency_path": dependency_path,
                "python_version": python_version,
                "port": result.get("port") or port,
                # is_remote flag from frontend
                "is_remote": is_remote,
                # Preserve remote config when switching to local mode.
                "remote_host": remote_host if is_remote else existing_runtime.get("remote_host"),
                "mnt_path": mnt_path if is_remote else existing_runtime.get("mnt_path"),
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
    # Set ready state (for local nodes, this is set here; for remote nodes, already set earlier)
    if not is_remote:
        try:
            set_activation_state(model_name, "ready", {"port": result.get("port"), "env_name": result.get("env_name")})
        except Exception:
            pass
    return ok

def _get_annotation_dtype():
    """Get the structured array dtype for annotations.
    
    Uses integer IDs and optimized field sizes to reduce storage by ~95% compared
    to string-based formats. Key optimizations:
    - cell_class: i4 (-1 = unclassified, 0+ = class index, -2 = exclude class 0, -3 = exclude class 1, ...)
    - cell_color: i4 (RGB value in 0xRRGGBB format, -1 = not set)
    - annotator: U64 (username string)
    - datetime: i8 (Unix timestamp in milliseconds, 0 = not set)
    - method: U32 (method name string)
    - region_geometry: stored as 4 integers (x1, y1, x2, y2) instead of JSON string
    
    Total size: ~560 bytes per element (vs 11.6KB before).
    """
    return np.dtype([
        # Small integers (i4) - grouped together for better cache locality
        ('class', 'i4'),  # -1=unclassified, 0+=class index, -(2+k)=exclude class k ("No" type)
        ('color', 'i4'),  # int32: RGB color value (0xRRGGBB format, -1 = not set, 0 = black)
        # Large integers (i8) - grouped together for better cache locality
        ('datetime', 'i8'),  # int64: Unix timestamp in milliseconds (0 = not set)
        # NOTE: the selection bbox (region_x1..y2) used to live here, but the
        # full drawn shape is now kept as vertices on the User-Annotations
        # group attr `{cell,patch}_selection_geometry` (keyed by datetime), so
        # the per-row bbox was pure redundancy and has been removed.
        # Strings (Unicode) - grouped together, ordered by size
        ('method', 'U32'),  # Reduced from U256: sufficient for method names
        ('annotator', 'U64'),  # Reduced from U256: sufficient for usernames
    ])

def _persist_selection_geometry(group_anno, subname, key, method, annotator, vertices):
    """Record one drawn selection's geometry on the User-Annotations GROUP attrs.

    The shape may be a rectangle or a polygon — `method` records which; this
    just stores its vertices. The annotation structured array has a fixed
    dtype with no room for variable-length geometry, so the vertices a user
    actually drew are kept under the group attr `{subname}_selection_geometry`.

    IMPORTANT: this lives on the GROUP (`User-Annotations`), not on the
    `cell`/`patch` array's attrs — the array gets recreated on resize /
    _safe_replace_dataset (which does NOT carry attrs over), so array-level
    attrs are silently dropped on the next save. The group persists.

    Keyed by the save's `datetime` (ms); every row from the same selection
    shares that timestamp, so readers (export, the model-zoo tasknode that
    embeds annotations into the .tlcls) can join the shape back to its rows.
    Shape: { "<datetime>": {"method", "annotator", "vertices": [[x, y], ...]} }
    Best-effort: a provenance write must never fail the annotation save."""
    try:
        if not vertices:
            return
        attr_key = f"{subname}_selection_geometry"
        existing = dict(group_anno.attrs.get(attr_key, {}) or {})
        existing[str(key)] = {
            "method": method,
            "annotator": annotator,
            "vertices": vertices,
        }
        group_anno.attrs[attr_key] = existing
    except Exception as e:
        logger.warning(f"[selection-geometry] Failed to persist {subname}[{key}]: {e}")


def prune_orphan_selection_geometry(group_anno, subname):
    """Drop `{subname}_selection_geometry` entries whose datetime no longer
    matches any remaining annotated row (after a delete / clear / reclassify),
    so the group attr doesn't accumulate orphans. Call after a delete writes
    back. Best-effort — a prune failure must never break the delete."""
    try:
        attr_key = f"{subname}_selection_geometry"
        geom = dict(group_anno.attrs.get(attr_key, {}) or {})
        if not geom or subname not in group_anno:
            return
        arr = group_anno[subname]
        names = arr.dtype.names or ()
        if 'class' not in names or 'datetime' not in names:
            return
        records = arr[:]
        classes = records['class']
        dts = records['datetime']
        # A row is a live annotation if it's a positive (class>=0) or a
        # negative/exclude (class<=-2) mark; class==-1 is an empty placeholder.
        meaningful = (classes >= 0) | (classes <= -2)
        used = {str(int(d)) for d in dts[meaningful]}
        pruned = {k: v for k, v in geom.items() if k in used}
        if len(pruned) != len(geom):
            group_anno.attrs[attr_key] = pruned
    except Exception as e:
        logger.warning(f"[selection-geometry] prune failed for {subname}: {e}")

def load_patch_annotations(zarr_path: str, zarr_file=None) -> Dict[int, Dict[str, Any]]:
    """Load patch annotations from User-Annotations/patch.

    Returns a sparse ``{patch_id_int: ann_dict}`` so the rest of the codebase
    (which has historically held the JSON dict in memory) keeps working — the
    on-disk representation is a dense structured array, this helper translates.
    Unannotated rows (``class == -1``) are skipped.

    Pass an already-open ``zarr_file`` to reuse it. load_file calls this while
    holding the store open, and reopening it there costs a fresh zarr open plus
    open_zarr_cm's auto-convert directory probe, on the slide-open path.
    """
    try:
        store = (
            contextlib.nullcontext(zarr_file)
            if zarr_file is not None
            else open_zarr_cm(zarr_path, "r")
        )
        with store as zf:
            if 'User-Annotations' not in zf or 'patch' not in zf['User-Annotations']:
                return {}
            arr = zf['User-Annotations/patch'][:]
    except Exception:
        return {}
    if arr.dtype.names is None or 'class' not in arr.dtype.names:
        return {}
    result: Dict[int, Dict[str, Any]] = {}
    for i in range(len(arr)):
        cls = int(arr['class'][i])
        if cls == -1:
            continue
        result[i] = {
            'class': cls,
            'color': int(arr['color'][i]) if 'color' in arr.dtype.names else -1,
            'datetime': int(arr['datetime'][i]) if 'datetime' in arr.dtype.names else 0,
            'method': str(arr['method'][i]) if 'method' in arr.dtype.names else '',
            'annotator': str(arr['annotator'][i]) if 'annotator' in arr.dtype.names else '',
        }
    return result


def save_patch_annotations(zarr_path: str, annotations: Dict[Any, Dict[str, Any]], n_patches: int = None, class_names: List[str] = None) -> None:
    """Persist patch annotations as a dense structured array under User-Annotations/patch.

    ``annotations`` is a sparse ``{patch_id: ann_dict}`` (the in-memory form).
    ``ann_dict['class']`` may be either an int class index (≥0) or a class
    name string — pass ``class_names`` to enable name→index resolution; if not
    provided, falls back to ``User-Annotations/patch.attrs.class_names`` then
    ``Patch-Classification/classes/name``.
    """
    dtype = _get_annotation_dtype()
    if n_patches is None:
        try:
            with open_zarr_cm(zarr_path, "r") as zf_r:
                n_patches = int(zf_r['Patch-Segmentation/coordinates'].shape[0])
        except Exception:
            # Fall back to "max patch_id + 1" if we can't read the coordinates.
            n_patches = (max((int(k) for k in annotations.keys()), default=-1) + 1) if annotations else 0
    # Resolve class names lookup if not provided.
    if class_names is None:
        try:
            with open_zarr_cm(zarr_path, "r") as zf_r:
                if 'User-Annotations' in zf_r:
                    class_names, _ = read_user_anno_class_palette(zf_r['User-Annotations'], 'patch')
                if not class_names and 'Patch-Classification/classes/name' in zf_r:
                    raw = zf_r['Patch-Classification/classes/name'][:]
                    class_names = [n.decode('utf-8') if isinstance(n, bytes) else str(n) for n in raw]
        except Exception:
            class_names = []
    name_to_idx = {n: i for i, n in enumerate(class_names or [])}

    arr = np.zeros(n_patches, dtype=dtype)
    if n_patches > 0:
        arr['class'][:] = -1
        arr['color'][:] = -1
        for region in ('region_x1', 'region_y1', 'region_x2', 'region_y2'):
            if region in arr.dtype.names:
                arr[region][:] = -1

    for patch_id, ann in annotations.items():
        try:
            i = int(patch_id)
        except (TypeError, ValueError):
            continue
        if i < 0 or i >= n_patches:
            continue
        cls_val = ann.get('class', -1)
        if isinstance(cls_val, str):
            cls_int = name_to_idx.get(cls_val, -1)
        else:
            try:
                cls_int = int(cls_val)
            except (TypeError, ValueError):
                cls_int = -1
        arr['class'][i] = cls_int
        color_val = ann.get('color', -1)
        if isinstance(color_val, str):
            color_val = _hex_color_to_int(color_val)
        try:
            arr['color'][i] = int(color_val)
        except (TypeError, ValueError):
            arr['color'][i] = -1
        try:
            arr['datetime'][i] = int(ann.get('datetime', 0))
        except (TypeError, ValueError):
            arr['datetime'][i] = 0
        arr['method'][i] = _truncate_field(str(ann.get('method', '')), 32, 'method')
        arr['annotator'][i] = _truncate_field(str(ann.get('annotator', '')), 64, 'annotator')

    with open_zarr_cm(zarr_path, "a") as zf:
        ua = zf.require_group('User-Annotations')
        if 'patch' in ua:
            del ua['patch']
        create_array(ua, 'patch', data=arr, dtype=dtype, overwrite=True)


def _truncate_field(value: str, max_len: int, field_name: str) -> str:
    """Truncate string field to fit dtype constraints.
    
    Args:
        value: String value to truncate
        max_len: Maximum length allowed
        field_name: Field name for logging
        
    Returns:
        Truncated string value
    """
    if value and len(value) > max_len:
        logger.warning(f"[save_annotation] {field_name} exceeds {max_len} chars ({len(value)}), truncating")
        return value[:max_len-3] + "..."
    return value or ""

def _hex_color_to_int(color: str) -> int:
    """Convert hex color string to integer RGB value.
    
    Args:
        color: Hex color string like "#ff0000" or "ff0000"
        
    Returns:
        Integer RGB value (0xRRGGBB format), -1 if invalid or empty (not set)
        Valid RGB range: 0x000000 (black) to 0xFFFFFF (white)
    """
    if not color or color == '':
        return -1  # -1 means not set (not a valid RGB color)
    
    # Remove '#' if present
    color = color.lstrip('#')
    
    # Validate length (should be 6 hex digits)
    if len(color) != 6:
        try:
            # Try to parse as integer if it's already a number string
            color_val = int(color)
            # Validate RGB range (0 to 16777215)
            if 0 <= color_val <= 0xFFFFFF:
                return color_val
            else:
                logger.warning(f"[save_annotation] Color value out of range: {color_val}, using -1 (not set)")
                return -1
        except (ValueError, TypeError):
            logger.warning(f"[save_annotation] Invalid color format: {color}, using -1 (not set)")
            return -1
    
    try:
        # Parse hex string to integer (0xRRGGBB format)
        color_val = int(color, 16)
        # Validate RGB range (0 to 16777215)
        if 0 <= color_val <= 0xFFFFFF:
            return color_val
        else:
            logger.warning(f"[save_annotation] Color value out of range: {color_val}, using -1 (not set)")
            return -1
    except ValueError:
        logger.warning(f"[save_annotation] Invalid hex color: {color}, using -1 (not set)")
        return -1

def _int_color_to_hex(color_int: int) -> str:
    """Convert integer RGB value to hex color string.
    
    Args:
        color_int: Integer RGB value (0xRRGGBB format), -1 means not set
        
    Returns:
        Hex color string like "#ff0000", "#000000" for 0 (black), "" for -1 (not set)
    """
    if color_int < 0:
        # -1 or negative values mean not set, return empty string
        return ""
    
    # Ensure value is within valid RGB range (0 to 16777215)
    if color_int > 0xFFFFFF:
        logger.warning(f"[_int_color_to_hex] Color value out of range: {color_int}, clamping to 0xFFFFFF")
        color_int = 0xFFFFFF
    
    # Convert to hex string and pad to 6 digits
    hex_str = f"{color_int:06x}"
    return f"#{hex_str}"

def _safe_replace_dataset(group, dataset_name: str, **create_kwargs):
    """
    Safely replace a zarr dataset with atomic operation.
    
    This function ensures that if dataset creation fails, the original dataset
    is preserved. It uses a temporary dataset name and only deletes the old
    dataset after the new one is successfully created and verified.
    
    Args:
        group: Zarr group containing the dataset
        dataset_name: Name of the dataset to replace
        **create_kwargs: Keyword arguments to pass to group.create_dataset()
                         (e.g., data, dtype, chunks, compressor, etc.)
    
    Returns:
        The newly created dataset
    
    Raises:
        Any exception raised by group.create_dataset(), but ensures old dataset is preserved
    """
    temp_name = f"{dataset_name}_tmp_{int(time.time() * 1000000)}"  # Use microsecond timestamp for uniqueness
    old_dataset_exists = dataset_name in group
    
    try:
        # Create new dataset with temporary name first
        new_dataset = create_array(group, temp_name, **create_kwargs)
        
        # Verify the dataset was created successfully
        if temp_name not in group:
            raise RuntimeError(f"Failed to create temporary dataset {temp_name}")
        
        # Only delete old dataset after new one is successfully created and verified
        if old_dataset_exists:
            del group[dataset_name]

        # Create final dataset by copying from temporary dataset
        # Extract parameters needed for dataset creation (excluding data, which we'll copy)
        create_params = {k: v for k, v in create_kwargs.items() if k != 'data'}
        
        # Determine shape and dtype from temporary dataset
        if 'shape' not in create_params:
            create_params['shape'] = new_dataset.shape
        if 'dtype' not in create_params:
            create_params['dtype'] = new_dataset.dtype
        
        # Create final dataset
        final_dataset = create_array(group, dataset_name, **create_params)
        
        # Copy data from temp to final
        if hasattr(new_dataset, 'shape') and new_dataset.shape != ():
            # Array dataset - copy all data
            final_dataset[:] = new_dataset[:]
        else:
            # Scalar dataset - copy value
            final_dataset[()] = new_dataset[()]
        
        # Copy attributes if any
        if hasattr(new_dataset, 'attrs'):
            for key, value in new_dataset.attrs.items():
                final_dataset.attrs[key] = value
        
        # Delete temporary dataset
        del group[temp_name]

        return final_dataset
        
    except Exception as e:
        # Clean up temporary dataset if it was created
        if temp_name in group:
            try:
                del group[temp_name]
                logger.warning(f"[_safe_replace_dataset] Cleaned up temporary dataset after error: {temp_name}")
            except:
                pass
        
        # Re-raise the exception - old dataset is still intact if it existed
        logger.error(f"[_safe_replace_dataset] Failed to replace dataset {dataset_name}: {e}", exc_info=e)
        raise

def save_annotation(handler, req: dict, _background_tasks=None) -> dict:
    """
    Save annotation data using efficient Zarr structured array format.
    The Zarr file structure for this:
    - /User-Annotations/cell (structured array with fields: cell_class, cell_color, annotator, datetime, method, region_geometry)
    - /Cell-Classification/userData/ (to store params for the classification node like organ, nuclei_classes, nuclei_colors)
    
    This format allows O(1) updates by index without loading/serializing the entire dataset.
    All annotation fields are stored in a single structured array.
    
    Note: _background_tasks parameter is kept for API compatibility but is no longer used.
    Annotation reloading is now always done synchronously to ensure state consistency.
    """
    # Get instanceId from request
    instance_id = req.get("instance_id")
    if not instance_id:
        logger.error("[save_annotation] No instance_id provided in the request.")
        return {"success": False, "message": "No instance_id provided"}
    
    
    # Get session data for this instance
    from app.services.load import get_session_data
    session_data = get_session_data(instance_id)
    
    # Prefer the handler's bound zarr path (instance source of truth).
    handler_path = None
    try:
        handler_path = handler.get_current_file_path()
    except Exception:
        handler_path = getattr(handler, "zarr_file", None)

    if handler_path:
        zarr_path = resolve_path(as_zarr_path(str(handler_path)))
    elif session_data.get("current_file_path"):
        zarr_path = resolve_path(as_zarr_path(session_data["current_file_path"]))
    else:
        zarr_path = resolve_path(req.get("path"))
        logger.warning(f"[save_annotation] No handler/session file path found, using request path: {zarr_path}")

    request_path_raw = req.get("path")
    if zarr_path and request_path_raw:
        request_zarr = resolve_path(as_zarr_path(request_path_raw))
        try:
            if os.path.realpath(zarr_path) != os.path.realpath(request_zarr):
                logger.error(
                    "[save_annotation] Handler/session path and request path mismatch: "
                    f"{zarr_path} vs {request_zarr}"
                )
                return {
                    "success": False,
                    "message": "Session file path and request path must point to the same Zarr file",
                }
        except Exception:
            pass
    
    ui_nuclei_classes = req.get("ui_nuclei_classes")
    ui_nuclei_colors = req.get("ui_nuclei_colors")
    ui_organ = req.get("ui_organ")

    if not zarr_path:
        logger.error("[save_annotation] No Zarr path available.")
        return {"success": False, "message": "No Zarr path available"}

    if not os.path.exists(zarr_path):
        logger.error(f"[save_annotation] Zarr file not found at {zarr_path}")
        return {"success": False, "message": f"Zarr file not found at {zarr_path}"}

    # Get annotation data from request
    matching_indices = req.get("matching_indices", [])
    classification = req.get("classification")
    if classification == "":
        classification = None
    color = req.get("color")
    exclude_classes = req.get("exclude_classes")
    if exclude_classes is not None and not isinstance(exclude_classes, list):
        exclude_classes = [exclude_classes] if exclude_classes else []
    if exclude_classes is None:
        exclude_classes = []

    # --- BEGIN CACHE UPDATE ---
    # Update the SegmentationHandler's in-memory state with the latest from the UI (instance-scoped handler)
    if ui_nuclei_classes and ui_nuclei_colors:
        handler.update_class_definitions(ui_nuclei_classes, ui_nuclei_colors)
    # --- END CACHE UPDATE ---
    
    region_geometry = req.get("region_geometry", {})
    method = req.get("method", "rectangle selection")
    annotator = req.get("annotator", "Unknown")
    auto_run = req.get("auto_run_classification", False)
    # Vertices of the polygon/rectangle the user actually drew (optional).
    # The structured array only keeps the bbox; these go to a sidecar dataset.
    # The cell selection UI sends them as `polygon_vertices`; patch/batch use
    # `polygon_points` — accept either.
    polygon_points = req.get("polygon_points") or req.get("polygon_vertices")

    # Region-only saves: resolve matching cells on the server (avoids huge matching_indices payloads).
    if (not matching_indices) and isinstance(region_geometry, dict):
        try:
            rx1 = region_geometry.get("x1")
            ry1 = region_geometry.get("y1")
            rx2 = region_geometry.get("x2")
            ry2 = region_geometry.get("y2")
            if None not in (rx1, ry1, rx2, ry2):
                from app.services.seg import query_viewport
                handler.ensure_file(zarr_path, need_centroids=True)
                poly_tuples = None
                if polygon_points and isinstance(polygon_points, (list, tuple)) and len(polygon_points) >= 3:
                    poly_tuples = [
                        (float(p[0]), float(p[1])) for p in polygon_points
                        if isinstance(p, (list, tuple)) and len(p) >= 2
                    ]
                q = query_viewport(
                    handler,
                    float(rx1), float(ry1), float(rx2), float(ry2),
                    poly_tuples,
                )
                matching_indices = q.get("matching_indices") or []
        except Exception as requery_err:
            logger.warning(f"[save_annotation] ROI re-query failed: {requery_err}")
    
    # Zarr supports in-place updates, no need for temporary files
    try:
        # 1. Get centroids length - use cached handler data if available to avoid I/O
        # Optimization: Use handler's cached centroids if available
        if handler.centroids is not None:
            centroids_len = len(handler.centroids)
        else:
            # Fallback: read from Zarr if handler doesn't have centroids
            with open_zarr_cm(zarr_path, 'r') as readf:
                if "Cell-Segmentation/centroids" not in readf:
                    logger.error("[save_annotation] No Cell-Segmentation/centroids found in Zarr")
                    return {"success": False, "message": "No seg centroids found in Zarr"}
                centroids_dataset = readf["Cell-Segmentation/centroids"]
                if centroids_dataset.shape == ():  # scalar dataset
                    centroids = centroids_dataset[()]
                else:  # array dataset
                    centroids = centroids_dataset[:]
                centroids_len = len(centroids)

        # 2. Open Zarr file and write annotations using efficient array format
        with open_zarr_cm(zarr_path, "a") as zf:
            ann_group_path = ZarrGroups.USER_ANNOTATIONS

            if ann_group_path not in zf:
                group_anno = zf.create_group(ann_group_path)
            else:
                group_anno = zf[ann_group_path]

            # Use structured array format only (no old format support)
            ds_name = ZarrDatasets.CELL
            annotation_dtype = _get_annotation_dtype()
            
            # Check if dataset exists and is in correct format
            needs_replacement = False
            if ds_name in group_anno:
                # Verify it's a structured array with correct format
                if group_anno.attrs.get('annotation_format') != 'structured':
                    logger.warning(f"[save_annotation] Dataset exists but format is not 'structured'. Expected structured array format.")
                    # Mark for safe replacement (atomic operation)
                    needs_replacement = True
            
            # Create structured array if it doesn't exist or needs replacement
            if ds_name not in group_anno or needs_replacement:
                # Calculate optimal chunk size
                element_size = annotation_dtype.itemsize
                target_chunk_size = 8 * 1024 * 1024  # 8MB target
                optimal_chunk_size = max(1000, min(centroids_len, target_chunk_size // element_size))
                # Use LZ4 compression - it's fast and reduces I/O time
                # Testing showed LZ4 is faster than no compression for writes
                compressor = lz4()
                
                # Memory threshold: use chunked creation for arrays > 1M cells (~560MB)
                # This prevents OOM errors for very large datasets
                MEMORY_THRESHOLD = 1_000_000  # 1 million cells
                
                if needs_replacement:
                    # Use safe atomic replacement to preserve data integrity

                    if centroids_len > MEMORY_THRESHOLD:
                        # For large arrays: use chunked initialization to avoid OOM

                        # Create temporary dataset with chunked initialization
                        temp_name = f"{ds_name}_tmp_{int(time.time() * 1000000)}"
                        old_dataset_exists = ds_name in group_anno
                        
                        try:
                            # Create temporary dataset with shape (no data yet)
                            temp_dataset = create_array(group_anno, 
                                temp_name,
                                shape=(centroids_len,),
                                dtype=annotation_dtype,
                                chunks=(optimal_chunk_size,),
                                compressor=compressor,
                                fill_value=None
                            )
                            
                            # Initialize in chunks to avoid memory issues
                            # Memory usage: Only one chunk_template (optimal_chunk_size elements) in memory at a time
                            # For 1M cells with optimal_chunk_size ~1000-10000, this is ~8MB-80MB numpy array
                            chunk_template = np.zeros(optimal_chunk_size, dtype=annotation_dtype)
                            for field in ['class', 'color']:
                                chunk_template[field] = -1
                            
                            # Write chunks sequentially
                            # Each write: numpy array -> zarr (compressed) -> disk
                            # Peak memory: chunk_template size (numpy) + zarr compression buffer
                            num_chunks = (centroids_len + optimal_chunk_size - 1) // optimal_chunk_size
                            for chunk_idx in range(num_chunks):
                                start_idx = chunk_idx * optimal_chunk_size
                                end_idx = min(start_idx + optimal_chunk_size, centroids_len)
                                chunk_size = end_idx - start_idx
                                
                                if chunk_size == optimal_chunk_size:
                                    temp_dataset[start_idx:end_idx] = chunk_template
                                else:
                                    # Last partial chunk - create smaller array
                                    # Memory: Only this partial chunk in memory
                                    partial_chunk = np.zeros(chunk_size, dtype=annotation_dtype)
                                    for field in ['class', 'color']:
                                        partial_chunk[field] = -1
                                    temp_dataset[start_idx:end_idx] = partial_chunk
                                    # partial_chunk will be garbage collected after this iteration
                                
                            # Verify temporary dataset was created successfully
                            if temp_name not in group_anno:
                                raise RuntimeError(f"Failed to create temporary dataset {temp_name}")
                            
                            # Only delete old dataset after new one is successfully created and verified
                            if old_dataset_exists:
                                del group_anno[ds_name]

                            # Create final dataset and copy data from temp in chunks
                            # Use smaller copy chunks to minimize memory usage during copy
                            # The copy operation will decompress from temp and recompress to final
                            # Using smaller chunks reduces peak memory usage
                            copy_chunk_size = min(optimal_chunk_size, 10000)  # Use smaller chunks for copying
                            final_dataset = create_array(group_anno, 
                                ds_name,
                                shape=(centroids_len,),
                                dtype=annotation_dtype,
                                chunks=(optimal_chunk_size,),
                                compressor=compressor,
                                fill_value=None
                            )
                            
                            # Copy data from temp to final in smaller chunks to minimize memory
                            # Memory analysis:
                            # - Reading from temp_dataset: zarr decompresses chunk -> numpy array (copy_chunk_size elements)
                            # - Writing to final_dataset: numpy array -> zarr compresses -> disk
                            # - Peak memory during copy: ~2x copy_chunk_size (read buffer + write buffer)
                            # - Using smaller copy_chunk_size (10K) instead of optimal_chunk_size reduces peak memory
                            # - For 1M cells: copy_chunk_size=10K means ~80MB peak (vs ~800MB with full chunk)
                            copy_num_chunks = (centroids_len + copy_chunk_size - 1) // copy_chunk_size
                            for copy_idx in range(copy_num_chunks):
                                copy_start = copy_idx * copy_chunk_size
                                copy_end = min(copy_start + copy_chunk_size, centroids_len)
                                # Direct assignment: zarr handles decompression/compression
                                # This creates a temporary numpy array slice that is immediately written and freed
                                final_dataset[copy_start:copy_end] = temp_dataset[copy_start:copy_end]
                                # The numpy array slice is automatically garbage collected after assignment
                            
                            # Copy attributes if any
                            if hasattr(temp_dataset, 'attrs'):
                                for key, value in temp_dataset.attrs.items():
                                    final_dataset.attrs[key] = value
                            
                            # Explicitly close/delete references before deleting the dataset
                            del temp_dataset
                            del group_anno[temp_name]
                            
                            annotations_dataset = final_dataset
                            annotations_dataset.attrs['annotation_format'] = 'structured'

                        except Exception as e:
                            # Clean up temporary dataset if it was created
                            if temp_name in group_anno:
                                try:
                                    del group_anno[temp_name]
                                    logger.warning(f"[save_annotation] Cleaned up temporary dataset after error: {temp_name}")
                                except:
                                    pass
                            logger.error(f"[save_annotation] Failed to replace dataset {ds_name}: {e}", exc_info=e)
                            raise
                    else:
                        # For smaller arrays: create full array in memory (acceptable for < 1M cells)
                        annotations_arr = np.zeros(centroids_len, dtype=annotation_dtype)
                        for field in ['class', 'color']:
                            annotations_arr[field] = -1
                        
                        annotations_dataset = _safe_replace_dataset(
                            group_anno,
                            ds_name,
                            data=annotations_arr,
                            dtype=annotation_dtype,
                            chunks=(optimal_chunk_size,),
                            compressor=compressor
                        )
                        annotations_dataset.attrs['annotation_format'] = 'structured'
                elif centroids_len > MEMORY_THRESHOLD:
                    # For large arrays: create empty dataset first, then fill in chunks
                    # This avoids loading the entire array into memory at once

                    # Create empty dataset with shape and dtype
                    annotations_dataset = create_array(group_anno, 
                        ds_name,
                        shape=(centroids_len,),
                        dtype=annotation_dtype,
                        chunks=(optimal_chunk_size,),
                        compressor=compressor,
                        fill_value=None  # No fill value, we'll write explicitly
                    )
                    
                    # Initialize in chunks to avoid memory issues
                    # Create a template chunk with correct initial values
                    chunk_template = np.zeros(optimal_chunk_size, dtype=annotation_dtype)
                    # Set fields that need -1 (unclassified/not set) instead of 0
                    for field in ['class', 'color']:
                        chunk_template[field] = -1
                    
                    # Write chunks sequentially
                    num_chunks = (centroids_len + optimal_chunk_size - 1) // optimal_chunk_size
                    for chunk_idx in range(num_chunks):
                        start_idx = chunk_idx * optimal_chunk_size
                        end_idx = min(start_idx + optimal_chunk_size, centroids_len)
                        chunk_size = end_idx - start_idx
                        
                        if chunk_size == optimal_chunk_size:
                            # Full chunk - reuse template
                            annotations_dataset[start_idx:end_idx] = chunk_template
                        else:
                            # Last partial chunk - create smaller array
                            partial_chunk = np.zeros(chunk_size, dtype=annotation_dtype)
                            for field in ['class', 'color']:
                                partial_chunk[field] = -1
                            annotations_dataset[start_idx:end_idx] = partial_chunk
                        
                    group_anno.attrs['annotation_format'] = 'structured'
                else:
                    # For smaller arrays: create with data directly (faster for small arrays)
                    # Create dataset with cell_class initialized to -1 (unclassified) for all cells
                    # Use np.zeros to initialize: numeric fields to 0, string fields to empty strings
                    annotations_arr = np.zeros(centroids_len, dtype=annotation_dtype)
                    # Set fields that need -1 (unclassified/not set) instead of 0
                    for field in ['class', 'color']:
                        annotations_arr[field] = -1
                    # Note: datetime=0 (not set) and string fields (empty) are already correct from np.zeros
                    
                    # Create dataset with pre-initialized data
                    annotations_dataset = create_array(group_anno, 
                        ds_name,
                        data=annotations_arr,
                        dtype=annotation_dtype,
                        chunks=(optimal_chunk_size,),
                        compressor=compressor
                    )
                    group_anno.attrs['annotation_format'] = 'structured'


            # Get structured array dataset
            annotations_dataset = group_anno[ds_name]

            # Negative selection ("No" type): store in same array, cell_class = -(2 + class_index) so -2 = exclude class 0, -3 = exclude class 1, ...
            if (classification is None or (isinstance(classification, str) and (classification or "").strip() == "")) and exclude_classes and ui_nuclei_classes:
                class_name_neg = exclude_classes[0]
                class_index_neg = ui_nuclei_classes.index(class_name_neg) if class_name_neg in ui_nuclei_classes else 0
                exclude_cell_class = -(2 + class_index_neg)
                valid_indices_neg = np.array([int(i) for i in matching_indices if isinstance(i, (int, float)) and 0 <= int(i) < centroids_len], dtype=np.int64)
                valid_indices_neg = np.unique(valid_indices_neg)
                if len(valid_indices_neg) == 0:
                    logger.warning("[save_annotation] No valid matching_indices for exclude_classes")
                else:
                    now_ts = int(datetime.now().timestamp() * 1000)
                    region_x1 = int(region_geometry.get('x1', -1)) if region_geometry and isinstance(region_geometry, dict) else -1
                    region_y1 = int(region_geometry.get('y1', -1)) if region_geometry and isinstance(region_geometry, dict) else -1
                    region_x2 = int(region_geometry.get('x2', -1)) if region_geometry and isinstance(region_geometry, dict) else -1
                    region_y2 = int(region_geometry.get('y2', -1)) if region_geometry and isinstance(region_geometry, dict) else -1
                    gray_int = _hex_color_to_int("#aaaaaa")
                    method_neg = _truncate_field(req.get("method") or "negative selection", 32, "method")
                    annotator_neg = _truncate_field(req.get("annotator", "Unknown"), 64, "annotator")
                    new_data_neg = np.empty(len(valid_indices_neg), dtype=annotation_dtype)
                    new_data_neg['class'] = exclude_cell_class
                    new_data_neg['color'] = gray_int
                    new_data_neg['datetime'] = now_ts
                    new_data_neg['method'] = method_neg
                    new_data_neg['annotator'] = annotator_neg
                    annotations_dataset[valid_indices_neg] = new_data_neg
                    # A negative/exclude selection is a drawn region too — record
                    # its shape (polygon, rectangle corners, or for a single
                    # excluded cell its own contour), same as a positive save.
                    neg_geom = polygon_points
                    if not neg_geom and region_x2 > region_x1 and region_y2 > region_y1:
                        neg_geom = [[region_x1, region_y1], [region_x2, region_y1],
                                    [region_x2, region_y2], [region_x1, region_y2]]
                    if (not neg_geom and len(valid_indices_neg) >= 1
                            and 'Cell-Segmentation/contours' in zf):
                        try:
                            a = np.asarray(zf['Cell-Segmentation/contours'][int(valid_indices_neg[0])])
                            if a.ndim == 2 and a.shape[0] == 2 and a.shape[1] != 2:
                                a = a.T
                            if a.ndim == 2 and a.shape[1] == 2 and a.shape[0] >= 3:
                                neg_geom = a.tolist()
                        except Exception as e:
                            pass
                            try:
                                logger.error(f"negative-selection geometry not recorded: {e}", exc_info=True)
                            except Exception:
                                pass
                    if neg_geom:
                        _persist_selection_geometry(
                            group_anno, "cell", now_ts, method_neg, annotator_neg, neg_geom)
                handler.invalidate_user_counts_cache()
                try:
                    if handler.zarr_file and os.path.exists(handler.zarr_file):
                        with open_zarr_cm(handler.zarr_file, 'r') as zarr_file:
                            handler._apply_manual_nuclei_annotations(zarr_file)
                except Exception as e:
                    logger.warning(f"[save_annotation] Re-apply after exclude: {e}")
                return {"success": True, "message": "Negative selection saved.", "matching_indices": valid_indices_neg.tolist() if len(valid_indices_neg) else []}

            # Update annotations using efficient partial updates (only update changed indices)
            valid_annotations_added = 0
            valid_indices = None  # Initialize for use in incremental update later
            old_class_ids = None  # Track old class IDs to properly update class_counts when re-annotating
            if not matching_indices or classification is None or color is None:
                logger.warning("[save_annotation] Missing matching_indices, classification, or color in request")
            else:
                # Use Unix timestamp in milliseconds instead of string for better storage efficiency
                # 0 means not set, >0 means valid timestamp
                now_timestamp = int(datetime.now().timestamp() * 1000)  # milliseconds since epoch
                
                # Parse region_geometry: expect {x1, y1, x2, y2} dict or empty dict
                # Store as 4 integers instead of JSON string for better performance and storage
                region_x1 = region_x2 = region_y1 = region_y2 = -1  # -1 means no geometry
                if region_geometry and isinstance(region_geometry, dict):
                    region_x1 = int(region_geometry.get('x1', -1))
                    region_y1 = int(region_geometry.get('y1', -1))
                    region_x2 = int(region_geometry.get('x2', -1))
                    region_y2 = int(region_geometry.get('y2', -1))
                
                # Convert color string to integer RGB value (0xRRGGBB format)
                # -1 means not set, 0 means black (#000000)
                color_int = _hex_color_to_int(color) if color else -1
                
                # Validate and truncate string fields if necessary to fit optimized dtype constraints
                annotator = _truncate_field(annotator, 64, 'annotator')
                method = _truncate_field(method, 32, 'method')
                
                # Use set for fast deduplication and validation, then numpy for efficient operations
                # Convert to set first to remove duplicates O(n), then filter valid indices
                matching_array = np.array(matching_indices, dtype=np.int64)
                # Filter valid indices using vectorized operations
                valid_mask = (matching_array >= 0) & (matching_array < centroids_len)
                valid_indices_unsorted = matching_array[valid_mask]
                
                if len(valid_indices_unsorted) == 0:
                    logger.warning(f"[save_annotation] No valid indices in matching_indices")
                else:
                    # Use numpy unique for fast deduplication and sorting (sorted indices improve cache locality)
                    valid_indices = np.unique(valid_indices_unsorted)
                    num_updates = len(valid_indices)
                    update_ratio = num_updates / centroids_len if centroids_len > 0 else 1.0
                    
                    # Pre-create the structured array data once (reused for all strategies)
                    new_data = np.empty(num_updates, dtype=annotation_dtype)
                    
                    # Convert class name string to ID using class_names mapping
                    # -1 = unclassified (not annotated)
                    # 0+ = class index in class_names array (index 0 is the first class, which by convention may be "Negative control" if that's the first entry, but this is determined by the array order)
                    class_id = -1  # Default to unclassified
                    if ui_nuclei_classes and classification:
                        if classification in ui_nuclei_classes:
                            class_id = ui_nuclei_classes.index(classification)
                            # class_id will be 0 for "Negative control" if it's first in the list
                        else:
                            # Class not found in list, add it dynamically
                            ui_nuclei_classes.append(classification)
                            class_id = len(ui_nuclei_classes) - 1

                    new_data['class'] = class_id
                    # -1 in the colour column marks a row as "not a real annotation"
                    # (_apply_manual_nuclei_annotations reads it that way), so it must
                    # not sit next to a real class: the panel would count the cell
                    # while the overlay and the classifier skipped it. Only an
                    # unclassified row keeps -1.
                    new_data['color'] = color_int if (class_id < 0 or color_int >= 0) else _hex_color_to_int("#808080")
                    new_data['annotator'] = annotator
                    new_data['datetime'] = now_timestamp
                    new_data['method'] = method

                    # Read OLD cell_class values BEFORE overwriting to track class count changes
                    # This ensures class_counts stays in sync when cells are re-annotated.
                    # NOTE: zarr v3 mis-allocates the read buffer (as the first field's
                    # i4 dtype) when COORDINATE-indexing a structured array, so
                    # `annotations_dataset[valid_indices]['class']` raises a cast error.
                    # Read a contiguous slice (basic indexing is unaffected) spanning the
                    # needed rows, then pick the offsets in numpy. valid_indices is sorted
                    # (np.unique above), so lo..hi bounds the range.
                    try:
                        _lo = int(valid_indices[0])
                        _hi = int(valid_indices[-1]) + 1
                        old_class_ids = annotations_dataset[_lo:_hi]['class'][valid_indices - _lo].copy()
                    except Exception as e:
                        logger.warning(f"[save_annotation] Could not read old cell_class values: {e}")
                        old_class_ids = None
                        try:
                            logger.error(f"class_counts update failed: {e}", exc_info=True)
                        except Exception:
                            pass
                    
                    # Strategy selection based on update size and pattern
                    # Check if indices form a contiguous range (can use slice for faster access)
                    is_contiguous = (num_updates > 0 and 
                                   valid_indices[-1] - valid_indices[0] + 1 == num_updates and
                                   np.all(np.diff(valid_indices) == 1))
                    
                    if is_contiguous and num_updates > 1000:
                        # Contiguous range: use slice for maximum performance
                        start_idx = int(valid_indices[0])
                        end_idx = int(valid_indices[-1]) + 1

                        # Direct slice assignment - Zarr handles this efficiently
                        annotations_dataset[start_idx:end_idx] = new_data
                        valid_annotations_added = num_updates
                    else:
                        # For non-contiguous updates, use single structured write
                        # Indices are already sorted by np.unique, which helps with cache locality

                        # Single write operation - Zarr will handle chunk optimization internally
                        # Sorted indices help Zarr optimize chunk access patterns
                        annotations_dataset[valid_indices] = new_data
                        valid_annotations_added = num_updates

            # New: Update class_counts dataset
            counts_ds_name = "cell_class_counts"
            counts_dict = {}
            if counts_ds_name in group_anno:
                counts_raw = group_anno[counts_ds_name][()]
                if counts_raw:
                    try:
                        counts_dict = json.loads(counts_raw.decode("utf-8"))
                    except Exception as e:
                        logger.warning(f"[save_annotation] Error loading class_counts: {e}. Starting fresh.")
                        counts_dict = {}

            if classification and valid_annotations_added > 0:
                # Properly track class count changes when cells are re-annotated:
                # 1. Decrement counts for OLD classes (cells that had previous annotations)
                # 2. Increment count for NEW class (only for cells that actually changed)
                actually_added = 0  # Track cells that actually changed class
                
                if old_class_ids is not None and ui_nuclei_classes:
                    try:
                        new_class_id = ui_nuclei_classes.index(classification) if classification in ui_nuclei_classes else -1
                        decremented_classes = {}
                        
                        for old_id in old_class_ids:
                            old_id_int = int(old_id)
                            # Skip if already has the same class (no change needed - data already saved)
                            if old_id_int >= 0 and old_id_int == new_class_id:
                                continue
                            
                            # Decrement old class count if cell was previously manually annotated
                            if old_id_int >= 0 and old_id_int < len(ui_nuclei_classes):
                                old_class_name = ui_nuclei_classes[old_id_int]
                                if old_class_name in counts_dict and counts_dict[old_class_name] > 0:
                                    counts_dict[old_class_name] -= 1
                                    decremented_classes[old_class_name] = decremented_classes.get(old_class_name, 0) + 1
                            
                            # Count this cell as actually added (either new or changed class)
                            actually_added += 1
                        
                    except Exception as e:
                        logger.warning(f"[save_annotation] Could not process old class counts: {e}")
                        actually_added = valid_annotations_added  # Fallback to original count
                else:
                    # No old_class_ids available, use valid_annotations_added (first-time save)
                    actually_added = valid_annotations_added
                
                # Increment count for the new class (only for cells that actually changed)
                if actually_added > 0:
                    if classification not in counts_dict:
                        counts_dict[classification] = 0
                    counts_dict[classification] += actually_added

            counts_out_str = json.dumps(counts_dict, ensure_ascii=False)
            counts_bytes = counts_out_str.encode("utf-8")

            # Optimization: Directly overwrite dataset if it exists (faster than delete+create)
            if counts_ds_name in group_anno:
                # Check if size matches - if so, we can overwrite in-place
                existing_ds = group_anno[counts_ds_name]
                if existing_ds.shape == () and len(counts_bytes) <= existing_ds.nbytes:
                    # Can overwrite in-place for scalar datasets
                    existing_ds[()] = counts_bytes
                else:
                    # Size mismatch or not scalar - use safe atomic replacement
                    _safe_replace_dataset(group_anno, counts_ds_name, data=counts_bytes)
            else:
                # Create new dataset
                create_bytes_array(group_anno, counts_ds_name, counts_bytes)
            # Zarr 3.x doesn't have flush(), data is automatically synced

            # Persist the geometry of THIS save — all three modes land in
            # selection_geometry so the record is complete and symmetric:
            #   polygon   → its drawn vertices,
            #   rectangle → 4 corners derived from the bbox,
            #   single    → the clicked cell's own nucleus contour
            #               (Cell-Segmentation/contours[idx]).
            if valid_annotations_added > 0:
                geom = polygon_points
                if not geom and region_x2 > region_x1 and region_y2 > region_y1:
                    geom = [
                        [region_x1, region_y1], [region_x2, region_y1],
                        [region_x2, region_y2], [region_x1, region_y2],
                    ]
                if (not geom and valid_indices is not None and len(valid_indices) >= 1
                        and 'Cell-Segmentation/contours' in zf):
                    try:
                        a = np.asarray(zf['Cell-Segmentation/contours'][int(valid_indices[0])])
                        # Legacy contours are (2, K); normalize to (K, 2).
                        if a.ndim == 2 and a.shape[0] == 2 and a.shape[1] != 2:
                            a = a.T
                        if a.ndim == 2 and a.shape[1] == 2 and a.shape[0] >= 3:
                            geom = a.tolist()
                    except Exception:
                        pass
                if geom:
                    _persist_selection_geometry(
                        group_anno, "cell",
                        now_timestamp, method, annotator, geom,
                    )

            # Store cell class palette under v3 prefixed keys so
            # get_cell_classification_data can read colors without traversing
            # the full annotation array.
            if ui_nuclei_classes and ui_nuclei_colors:
                write_user_anno_class_palette(group_anno, 'cell', ui_nuclei_classes, ui_nuclei_colors)
            # The "we derived the palette ourselves" case is stored after the
            # extraction below, which is the only thing that fills
            # class_color_map. It used to be an `elif` here, reading that name
            # before any assignment to it — an UnboundLocalError that the
            # enclosing `except Exception` swallowed, taking the rest of the
            # save with it: the extraction, the Negative-control ordering, the
            # counts-cache invalidation and the manual-annotation re-apply.

            # Always create/update ClassificationNode when saving nuclei annotations
            # Extract class names and colors from nuclei annotations if not provided via UI
            # Skip expensive array reading if UI already provided classes/colors
            if not ui_nuclei_classes or not ui_nuclei_colors:
                # Extract unique classes and colors from nuclei annotations (structured array format)
                class_color_map = {}
                if ds_name in group_anno:
                    try:
                        # Optimize: only read cell_class and cell_color fields, not entire array
                        # For large arrays, sample a subset if possible to avoid reading everything
                        # New format: cell_class is integer ID, need to get class_names from metadata.
                        # Tries v3 `cell_class_names` first, falls back to legacy bare key.
                        class_names, _ = read_user_anno_class_palette(group_anno, 'cell')

                        if not class_names:
                            # No metadata, can't build color map
                            logger.warning("[save_annotation] No class_names in metadata, skipping color map extraction")
                        else:
                            array_size = annotations_dataset.shape[0]
                            if array_size > 100000:
                                # For very large arrays, sample first 10K non-empty entries for speed
                                sample_size = min(10000, array_size)
                                _sample_records = annotations_dataset[:sample_size]
                                cell_class_ids_sample = _sample_records['class']
                                cell_color_sample = _sample_records['color']
                                # New format: -1 = unclassified, 0+ = class index
                                # cell_color is now int32 (-1 = not set, 0 = black is valid)
                                non_empty_mask = (cell_class_ids_sample >= 0) & (cell_color_sample >= 0)
                                if np.any(non_empty_mask):
                                    valid_class_ids = cell_class_ids_sample[non_empty_mask]
                                    valid_colors = cell_color_sample[non_empty_mask]
                                    # Convert IDs to class names and colors to hex strings
                                    for class_id, color_int in zip(valid_class_ids, valid_colors):
                                        if 0 <= class_id < len(class_names) and color_int >= 0:
                                            color = _int_color_to_hex(color_int)
                                            class_name = class_names[class_id]
                                            if class_name not in class_color_map:
                                                class_color_map[class_name] = color
                            else:
                                # For smaller arrays, read all data
                                _all_records = annotations_dataset[:]
                                cell_class_ids = _all_records['class']
                                cell_color_data = _all_records['color']
                                # New format: -1 = unclassified, 0+ = class index
                                # cell_color is now int32 (-1 = not set, 0 = black is valid)
                                non_empty_mask = (cell_class_ids >= 0) & (cell_color_data >= 0)
                                if np.any(non_empty_mask):
                                    valid_class_ids = cell_class_ids[non_empty_mask]
                                    valid_colors = cell_color_data[non_empty_mask]
                                    # Convert IDs to class names and colors to hex strings
                                    for class_id, color_int in zip(valid_class_ids, valid_colors):
                                        if 0 <= class_id < len(class_names) and color_int >= 0:
                                            color = _int_color_to_hex(color_int)
                                            class_name = class_names[class_id]
                                            if class_name not in class_color_map:
                                                class_color_map[class_name] = color
                    except Exception as e:
                        logger.warning(f"[save_annotation] Failed to extract classes from annotations: {e}")
                
                # Use extracted data if UI data not available
                if not ui_nuclei_classes and class_color_map:
                    ui_nuclei_classes = list(class_color_map.keys())
                if not ui_nuclei_colors and class_color_map:
                    ui_nuclei_colors = list(class_color_map.values())

                # Store what we derived, the same way the UI-supplied branch
                # above stores what it was given.
                if class_color_map:
                    write_user_anno_class_palette(
                        group_anno, 'cell',
                        list(class_color_map.keys()), list(class_color_map.values()),
                    )

                # Ensure 'Negative control' exists and is first
                if ui_nuclei_classes:
                    # Use set for O(1) membership check
                    classes_set = set(ui_nuclei_classes)
                    if 'Negative control' not in classes_set:
                        ui_nuclei_classes = ['Negative control'] + ui_nuclei_classes
                        ui_nuclei_colors = ['#aaaaaa'] + ui_nuclei_colors  # Default color for negative control
                    elif ui_nuclei_classes[0] != 'Negative control':
                        # Move to front if not already - use set for fast lookup
                        nc_index = ui_nuclei_classes.index('Negative control')
                        nc_color = ui_nuclei_colors[nc_index] if nc_index < len(ui_nuclei_colors) else '#aaaaaa'
                        # Use list comprehension with set for efficient filtering
                        ui_nuclei_classes = ['Negative control'] + [n for n in ui_nuclei_classes if n != 'Negative control']
                        ui_nuclei_colors = [nc_color] + [c for i, c in enumerate(ui_nuclei_colors) if i != nc_index]

            # Note: ClassificationNode is created/updated by task node (classification task), not by save_annotation
            # We only update user_annotation.attrs['class_colors'] here for fast access during get_cell_classification_data

        # 4. Zarr file has been updated in-place, no need for file replacement

        # Invalidate user counts cache to ensure fresh data
        handler.invalidate_user_counts_cache()
        
        # Always re-apply manual annotations after saving to ensure handler state is synchronized
        # This is critical to ensure frontend refresh gets the latest annotation state
        try:
            if handler.zarr_file and os.path.exists(handler.zarr_file):
                reload_start = time.time()
                with open_zarr_cm(handler.zarr_file, 'r') as zarr_file:
                    handler._apply_manual_nuclei_annotations(zarr_file)

                handler._zarr_file_obj = open_zarr(handler.zarr_file, 'r')
                reload_time = time.time() - reload_start

                # IMPORTANT: Reset _needs_reload flag after successfully re-applying annotations
                # This prevents the WebSocket from triggering another load_file which could
                # cause race conditions and overwrite the class counts we just saved
                handler._needs_reload = False
        except Exception as apply_error:
            logger.error(f"[save_annotation] Failed to re-apply manual annotations: {apply_error}. Handler state may be out of sync with Zarr file.", exc_info=apply_error)
            return {
                "success": False,
                "message": f"Annotation saved, but failed to re-apply manual annotations; handler state may be out of sync: {str(apply_error)}"
            }

        # 5. Return success
        return {"success": True, "message": "Annotation saved"}

    except Exception as e:
        logger.error(f"[save_annotation] Error during Zarr operation: {e}", exc_info=True)
        return {"success": False, "message": f"Error saving annotation: {str(e)}"}
    finally:
        # No cleanup needed for in-place updates
        pass


def save_patch(handler, req: dict, background_tasks=None):
    """
    Receive tissue area coordinates (and optional polygon points),
    find precise matching patches, and save classification to Zarr file.
    Coordinates in req (start_x etc., polygon_points) are expected in RAW OSD format.
    """
    zarr_path = resolve_path(req.get("path", ""))


    # ... (Checks for zarr_path and file existence) ...
    if not zarr_path or not os.path.exists(zarr_path):
         return {"success": False, "error": f"Zarr file not found or path missing: {zarr_path}"}


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
             else: print(f"[WARN] Invalid format for polygon_points.")
         except Exception as e: print(f"[WARN] Error processing polygon_points: {e}")

    # Positive: classification = "Tumor"; Negative: classification = None, exclude_classes = ["Tumor"]
    classification = req.get("classification")
    if classification == "":
        classification = None
    exclude_classes = req.get("exclude_classes")
    if exclude_classes is not None and not isinstance(exclude_classes, list):
        exclude_classes = [exclude_classes] if exclude_classes else []
    if exclude_classes is None:
        exclude_classes = []
    if classification is None and not exclude_classes:
        classification = "Negative control"  # backward compatibility when no classification sent
    color = req.get("color", "#aaaaaa")
    method = req.get("method")
    if method is None or method == "":
        method = "polygon selection" if polygon_points else "rectangle selection"
    if exclude_classes and classification is None:
        method = "negative selection"
    annotator = req.get("annotator", "Unknown")

    matching_indices = []

    try:
        # Ensure patch data is loaded for the correct file
        handler.ensure_file(zarr_path, need_patches=True)

        if not hasattr(handler, 'patch_coordinates') or handler.patch_coordinates is None:
            raise ValueError("Patch coordinates data could not be loaded from Zarr.")

        original_patch_coords_level0 = np.array(handler.patch_coordinates)
        total_patches = len(original_patch_coords_level0)

        if total_patches > 0:
            patch_x1 = original_patch_coords_level0[:, 0]
            patch_y1 = original_patch_coords_level0[:, 1]
            patch_x2 = original_patch_coords_level0[:, 2]
            patch_y2 = original_patch_coords_level0[:, 3]

            # calculate patch centroids
            patch_centroids_x = np.mean(original_patch_coords_level0[:, [0, 2]], axis=1)
            patch_centroids_y = np.mean(original_patch_coords_level0[:, [1, 3]], axis=1)

            # use centroid to determine if it's inside the bbox
            bbox_mask = (
                (patch_centroids_x >= x1) & (patch_centroids_x <= x2) &
                (patch_centroids_y >= y1) & (patch_centroids_y <= y2)
            )
            indices_in_bbox = np.where(bbox_mask)[0]

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
                except Exception as pip_error:
                    print(f"[ERROR] save_patch - Error during PIP test: {pip_error}")
                    traceback.print_exc()
                    matching_indices = indices_in_bbox.tolist()
                    print("[WARN] save_patch - Falling back to BBox centroid results due to PIP error.")
            else:
                matching_indices = indices_in_bbox.tolist()

        # Now 'matching_indices' holds the precise list of patch indices

    except Exception as query_err:
         logger.error(f"Error during patch querying in save_patch: {query_err}", exc_info=query_err)
         traceback.print_exc()
         return {"success": False, "error": f"Error querying patches: {query_err}"}

    # --- Proceed with saving using the precise matching_indices ---
    if not matching_indices:
        return {"success": True, "message": "No matching patches found in the specified region.", "matching_indices": []}

    # ... (Rest of the Zarr saving logic using temp file - this part seems okay) ...
    # It correctly iterates through `matching_indices` and saves info to `tissue_annotations` dataset.
    try:
        # Work directly with the zarr file without copying
        with open_zarr_cm(zarr_path, "a") as zf:
            # ... (get or create user_annotation group) ...
            ann_group_path = "User-Annotations"
            group_anno = zf.require_group(ann_group_path)

            # Load existing patch annotations as a sparse dict (helper handles
            # the dense-structured-array unpacking under the hood).
            existing_dict = load_patch_annotations(zarr_path)
            existing_dict = {str(k): v for k, v in existing_dict.items()}

            # One ms-int timestamp for the whole save (shared by all patches in
            # this region), matching cell's save_annotation. Written to each
            # patch row's datetime AND used as the selection_geometry key, so
            # the export can join the drawn shape back to its patch rows.
            save_ts = int(datetime.now().timestamp() * 1000)
            # Negative/weak patch selection: store the EXCLUDED class as
            # -(2 + k) (k = its class index), mirroring cell's save_annotation,
            # so it's recorded as a weak label instead of just removing the
            # patch. Only when the excluded class resolves to an index.
            neg_class_int = None
            if exclude_classes and classification is None:
                patch_names = [
                    n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n)
                    for n in (handler.patch_class_name
                              if getattr(handler, 'patch_class_name', None) is not None else [])
                ]
                excl_name = str(exclude_classes[0])
                if excl_name in patch_names:
                    neg_class_int = -(2 + patch_names.index(excl_name))
            for idx in matching_indices:
                key = str(idx)
                new_item = {
                    "patch_ID": int(idx),
                    # NAME string (resolved to index on save) for positives;
                    # a pre-computed negative int for weak/exclude selections.
                    "class": (neg_class_int if neg_class_int is not None else classification),
                    "annotator": annotator,
                    "datetime": save_ts,
                    "method": method,
                }
                if exclude_classes:
                    new_item["exclude_classes"] = list(exclude_classes)
                if color and (classification is None or exclude_classes):
                    new_item["color"] = color
                if classification is None and neg_class_int is None:
                    # No resolvable exclude target — treat as a removal.
                    existing_dict.pop(key, None)
                else:
                    existing_dict[key] = new_item

            # Resolve the class list + colors. Source priority:
            #   1. Payload `tissue_classes` / `tissue_colors` from the frontend
            #      panel — authoritative global ordering. The only source that
            #      knows the user's intent before any zarr group exists.
            #   2. handler.patch_class_name / patch_class_hex_color (canonical
            #      mirror of Patch-Classification/classes after load_file).
            #   3. The patch dataset's own attrs (`class_names`/`class_colors`).
            tissue_class_names = []
            tissue_class_colors = []

            ui_tissue_classes = req.get('tissue_classes')
            ui_tissue_colors = req.get('tissue_colors')
            if isinstance(ui_tissue_classes, list) and ui_tissue_classes:
                tissue_class_names = [str(n) for n in ui_tissue_classes]
                if isinstance(ui_tissue_colors, list) and ui_tissue_colors:
                    tissue_class_colors = [str(c) for c in ui_tissue_colors]

            if not tissue_class_names and getattr(handler, 'patch_class_name', None) is not None:
                tissue_class_names = [
                    n.decode('utf-8') if isinstance(n, bytes) else str(n)
                    for n in (handler.patch_class_name.tolist() if hasattr(handler.patch_class_name, 'tolist') else handler.patch_class_name)
                ]
                if getattr(handler, 'patch_class_hex_color', None) is not None:
                    tissue_class_colors = [
                        c.decode('utf-8') if isinstance(c, bytes) else str(c)
                        for c in (handler.patch_class_hex_color.tolist() if hasattr(handler.patch_class_hex_color, 'tolist') else handler.patch_class_hex_color)
                    ]

            if not tissue_class_names:
                tissue_class_names, tissue_class_colors = read_user_anno_class_palette(group_anno, 'patch')

            # Pad / truncate colors to match names.
            while len(tissue_class_colors) < len(tissue_class_names):
                tissue_class_colors.append('#aaaaaa')
            tissue_class_colors = tissue_class_colors[:len(tissue_class_names)]

            if classification is not None:
                if classification not in tissue_class_names:
                    tissue_class_names.append(classification)
                    tissue_class_colors.append(color or '#aaaaaa')
                else:
                    idx = tissue_class_names.index(classification)
                    if color and idx < len(tissue_class_colors) and color != tissue_class_colors[idx]:
                        tissue_class_colors[idx] = color

        # Now persist the updated dict as a dense structured array. We exit the
        # 'with zarr.open' block first so save_patch_annotations can open the
        # store on its own (it manages its own context).
        save_patch_annotations(zarr_path, existing_dict, class_names=tissue_class_names)
        # Pin patch palette on the PARENT User-Annotations group attrs under
        # `patch_class_names` / `patch_class_colors` (v3). cell and patch
        # palettes now sit side-by-side on one group's .zattrs instead of
        # patch hiding on the subarray attrs.
        try:
            with open_zarr_cm(zarr_path, "a") as zf2:
                write_user_anno_class_palette(
                    zf2['User-Annotations'], 'patch', tissue_class_names, tissue_class_colors,
                )
        except Exception as attrs_err:
            print(f"[save_patch] Warning: could not pin patch class attrs: {attrs_err}")

        # Persist the drawn selection geometry — rectangle AND polygon both
        # land in patch.attrs['selection_geometry'], symmetric with cell. A
        # polygon carries explicit vertices; a rectangle's 4 corners are
        # derived from the BBox (x1,y1,x2,y2). Keyed by one save-level
        # timestamp (patch rows lack a reliable per-row datetime) — fine for
        # embedding into the .tlcls (no per-row join needed).
        geom_vertices = (
            [list(p) for p in polygon_points] if polygon_points
            else ([[x1, y1], [x2, y1], [x2, y2], [x1, y2]] if (x2 > x1 and y2 > y1) else None)
        )
        if geom_vertices:
            try:
                with open_zarr_cm(zarr_path, "a") as zf_geom:
                    _persist_selection_geometry(
                        zf_geom['User-Annotations'], "patch",
                        save_ts, method, annotator,
                        geom_vertices,
                    )
            except Exception as geom_err:
                print(f"[save_patch] Warning: could not persist selection geometry: {geom_err}")

        # Re-apply manual patch annotations on handler so next get_patches returns correct colors.
        with open_zarr_cm(zarr_path, "a") as zf3:
            try:
                handler._apply_manual_patch_annotations(zf3)
            except Exception as apply_err:
                print(f"[save_patch] Warning: failed to re-apply manual patch annotations on handler: {apply_err}")

        # Work directly with zarr file - no need to replace

        # Invalidate the patch counts cache to ensure freshness on next query
        handler.invalidate_patch_counts_cache()

        return {"success": True, "message": f"Tissue annotation saved for {len(matching_indices)} patches", "matching_indices": matching_indices}

    except Exception as e:
        # Error handling for direct zarr operations
         logger.error(f"Error during save_patch Zarr operation: {e}", exc_info=e)
         traceback.print_exc()
         return {"success": False, "error": str(e)}
    
def run_classification(req: dict):
    """ Run classification after saving annotation """
    zarr_path = resolve_path(req.get("path", ""))
    if not zarr_path or not os.path.exists(zarr_path):
        return {"success": False, "error": "invalid zarr file path"}
    
    try:
        # 1. write parameters to Zarr file's Cell-Classification/userData section
        try:
            with open_zarr_cm(zarr_path, "a") as zf:
                user_data_path = "Cell-Classification/userData"
                node_group = zf.require_group(user_data_path)
                # add nuclei_classes parameter
                if "nuclei_classes" in req and req["nuclei_classes"]:
                    if "nuclei_classes" in node_group:
                        del node_group["nuclei_classes"]
                    classes_json = json.dumps(req["nuclei_classes"], ensure_ascii=False)
                    create_bytes_array(node_group, "nuclei_classes", classes_json.encode("utf-8"))
                # add nuclei_colors parameter
                if "nuclei_colors" in req and req["nuclei_colors"]:
                    if "nuclei_colors" in node_group:
                        del node_group["nuclei_colors"]
                    colors_json = json.dumps(req["nuclei_colors"], ensure_ascii=False)
                    create_bytes_array(node_group, "nuclei_colors", colors_json.encode("utf-8"))
                # add organ parameter
                if "organ" in req:
                    if "organ" in node_group:
                        del node_group["organ"]
                    create_bytes_array(node_group, "organ", str(req["organ"]).encode("utf-8"))
                # Zarr 3.x doesn't have flush(), data is automatically synced
            pass
        except Exception as e:
            logger.error(f"Error writing user parameters: {e}", exc_info=e)
            return {"success": False, "error": f"Error writing user parameters: {e}"}
        # 2. Get NuClass information (port and remote_host)
        node_name = "NuClass"
        node_port = None
        node_remote_host = None
        node_mnt_path = None
        
        # Try to get node info from manager first
        try:
            if node_name in manager.nodes:
                node = manager.nodes[node_name]
                node_port = node.port
                # Check if it's a remote node
                is_remote, remote_host, mnt_path = manager._is_remote_node(node_name)
                if is_remote:
                    node_remote_host = remote_host
                    node_mnt_path = mnt_path
        except Exception as e:
            logger.warning(f"Could not get node info from manager: {e}")
        
        # Fallback: try to get from registry or use default port
        if node_port is None:
            try:
                from app.utils.workflow.register import CUSTOM_NODE_SERVICE_REGISTRY
                for registry_key, info in CUSTOM_NODE_SERVICE_REGISTRY.items():
                    if info.get("model_name") == node_name:
                        node_port = info.get("port")
                        node_remote_host = info.get("remote_host")
                        node_mnt_path = info.get("mnt_path")
                        break
            except Exception as e:
                logger.warning(f"Could not get node info from registry: {e}")
        
        # Final fallback: use default port 8006
        if node_port is None:
            node_port = 8006
            logger.warning(f"Using default port 8006 for ClassificationNode")
        
        # Build base URL
        if node_remote_host:
            base_url = f"http://{node_remote_host}:{node_port}"
        else:
            base_url = f"http://localhost:{node_port}"
        
        # Convert path for remote node if needed
        if node_remote_host and node_mnt_path:
            zarr_path = manager._convert_path_for_remote_node(zarr_path, node_mnt_path)
        
        # 2. call ClassificationNode's /init interface
        init_url = f"{base_url}/init"
        try:
            init_resp = requests.post(init_url, json={}, timeout=30)
            init_resp.raise_for_status()
        except Exception as e:
            logger.error(f"Error calling init: {e}", exc_info=e)
            return {"success": False, "error": f"Error calling init: {e}"}
        # 3. call NuClass's /read interface, pass zarr path
        read_url = f"{base_url}/read"
        read_data = {
            "node_name": "NuClass",
            "dependencies": [],
            "zarr_path": zarr_path
        }
        try:
            read_resp = requests.post(read_url, json=read_data, timeout=30)
            read_resp.raise_for_status()
        except Exception as e:
            logger.error(f"Error calling read: {e}", exc_info=e)
            return {"success": False, "error": f"Error calling read: {e}"}
        # 4. call ClassificationNode's /execute interface to perform classification
        execute_url = f"{base_url}/execute"
        try:
            exec_resp = requests.post(execute_url, json={}, timeout=120)
            exec_resp.raise_for_status()
            result = exec_resp.json()
        except Exception as e:
            logger.error(f"Error calling execute: {e}", exc_info=e)
            return {"success": False, "error": f"Error calling execute: {e}"}
        # wait for 1 second
        time.sleep(1)

        # Reload all handlers that use this zarr file to pick up the new classification data
        try:
            from app.services.seg_registry import reload_handlers_for_zarr_path
            reload_zarr_path = as_zarr_path(zarr_path)
            reloaded_count = reload_handlers_for_zarr_path(reload_zarr_path)
        except Exception as e:
            logger.warning(f"Could not reload handlers after classification: {e}")
        
        return {"success": True, "message": "classification completed successfully", "result": result.get("output", {})}
    except Exception as e:
        logger.error(f"Classification error: {e}", exc_info=e)
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

    from app.wrapper import PyvipsSlideWrapper

    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File {file_path} not found")

    # Import the file extension detection function
    from app.services.load import get_file_extension
    file_ext = get_file_extension(file_path)

    if file_ext in ['tif', 'tiff', 'btf']:
        try:
            slide_obj = TiffSlideWrapper(file_path)
        except Exception as e:
            print(f"Debug - TiffSlideWrapper failed for {file_ext}: {e}")
            try:
                slide_obj = TiffFileWrapper(file_path)
            except Exception as e:
                print(f"Debug - TiffFileWrapper failed: {e}, falling back to PyvipsSlideWrapper")
                slide_obj = PyvipsSlideWrapper(file_path)
    elif file_ext in ['svs', 'qptiff']:
        try:
            slide_obj = TiffSlideWrapper(file_path)
        except Exception as e:
            print(f"Debug - TiffSlideWrapper failed for {file_ext}: {e}, falling back to PyvipsSlideWrapper")
            slide_obj = PyvipsSlideWrapper(file_path)
    elif file_ext in ['ndpi']:
        # Smart wrapper selection for NDPI files using centralized logic
        from app.services.load import smart_load_ndpi_wrapper
        slide_obj, _ = smart_load_ndpi_wrapper(file_path)
    elif file_ext in ['jpeg', 'jpg', 'png', 'bmp']:
        slide_obj = SimpleImageWrapper(file_path)
    elif file_ext in ['isyntax']:
        slide_obj = ISyntaxImageWrapper(file_path)
    elif file_ext in ['czi']:
        slide_obj = CziImageWrapper(file_path)
    elif file_ext in ['dcm']:
        slide_obj = DicomImageWrapper(file_path)
    elif file_ext in ['nii', 'nii.gz']:
        slide_obj = NiftiImageWrapper(file_path)
    else:
        raise ValueError(f"Unsupported file format: {file_ext}")

    return slide_obj

def _render_review_tile(req: dict) -> dict:
    """
    Generate a cropped tile image centered on a specific cell for review.
    For z-stack images, generates an animated GIF cycling through all layers.
    For single layer images, returns a single JPEG (original behavior).
    
    Args:
        req: Dictionary containing:
            - slide_id: Identifier for the slide (path to SVS/Zarr file)
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
        fixed_z_layer = req.get("fixed_z_layer", None)  
        
        # Validate input
        if not all([slide_id, cell_id, "x" in centroid, "y" in centroid]):
            return {"success": False, "error": "Invalid input parameters"}
        
        center_x = float(centroid["x"])
        center_y = float(centroid["y"])
        
        # Determine and resolve the slide and Zarr paths
        # Web clients pass relative paths (e.g., "cmu-1/CMU-1.svs"); resolve to STORAGE_ROOT
        resolved_input_path = resolve_path(slide_id)
        # If a resolved .zarr is given, prefer the image path by stripping extension
        slide_path = resolved_input_path.rstrip("/\\")
        if slide_path.lower().endswith(".zarr"):
            slide_path = slide_path[:-5]  # strip trailing '.zarr'
        # Resolve Zarr path alongside the slide image path
        zarr_path = resolve_path(as_zarr_path(slide_id))

        if not os.path.exists(slide_path):
            return {"success": False, "error": f"Slide file not found: {slide_path}"}

        # Contour: prefer one passed in the request (patch review supplies a
        # rectangle synthesised from its bbox); otherwise read the cell's
        # contour from the Zarr file.
        contour = None
        req_contour = req.get("contour")
        if req_contour:
            try:
                contour = np.array([[float(p["x"]), float(p["y"])] for p in req_contour])
            except (TypeError, KeyError, ValueError, IndexError):
                contour = None
        if contour is None and os.path.exists(zarr_path):
            contour_data = _get_cell_contour(zarr_path, cell_id)
            if contour_data:
                # Convert to numpy array format
                contour = np.array([[point["x"], point["y"]] for point in contour_data])

        if contour is None or len(contour) == 0:
            return {"success": False, "error": f"No contour data found for {cell_id}"}
        
        # Detect z-stack. Callers that know the source is single-layer (e.g.
        # patch tiles) pass skip_zstack to avoid the extra per-tile slide open.
        is_zstack = False
        num_z_layers = 1
        tiff_wrapper = None
        if not req.get("skip_zstack"):
            try:
                tiff_wrapper = TiffFileWrapper(slide_path)
                is_zstack = tiff_wrapper.is_zstack
                num_z_layers = tiff_wrapper.z_layer_count
            except Exception as e:
                logger.debug(f"[Review Tile] Z-stack detection failed (assuming single layer): {e}")
                is_zstack = False
                num_z_layers = 1
        
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
            
            # Downsample factor of the single-layer pyramid read; stays 1.0
            # for z-stack reads (which are always at level 0).
            read_ds = 1.0

            # For z-stack: read all layers or specific layer; for single layer: read one image
            if is_zstack and fixed_z_layer is None:
                # Read all z-layers for GIF using SDK wrapper
                layer_images = []
                
                # Ensure we have tiff_wrapper (should be created during z-stack detection)
                if tiff_wrapper is None:
                    tiff_wrapper = TiffFileWrapper(slide_path)
                
                for z in range(num_z_layers):
                    try:
                        # Use SDK's read_region with z_layer parameter
                        region_array = tiff_wrapper.read_region(
                            location=(new_coord[0], new_coord[1]),
                            level=0,
                            size=(region_width, region_height),
                            as_array=True,
                            z_layer=z
                        )
                        
                        # Convert to PIL Image
                        if region_array.ndim == 2:
                            layer_img = Image.fromarray(region_array).convert('RGB')
                        elif len(region_array.shape) >= 3 and region_array.shape[2] >= 3:
                            layer_img = Image.fromarray(region_array[:, :, :3].astype(np.uint8))
                        else:
                            continue
                        
                        layer_images.append(layer_img)
                    except Exception as e:
                        logger.warning(f"[Review Tile] Failed to read z-layer {z}: {e}")
                        continue
                
                if len(layer_images) == 0:
                    return {"success": False, "error": "Failed to read any z-layers"}
                
                # Will process contours on each layer later
                image = None  # Placeholder, will create GIF
            elif is_zstack and fixed_z_layer is not None:
                # Read specific z-layer only (fixed view) using SDK wrapper
                try:
                    # Validate layer index
                    layer_idx = int(fixed_z_layer)
                    if layer_idx < 0 or layer_idx >= num_z_layers:
                        layer_idx = num_z_layers // 2  # Default to middle layer
                    
                    # Ensure we have tiff_wrapper
                    if tiff_wrapper is None:
                        tiff_wrapper = TiffFileWrapper(slide_path)
                    
                    # Use SDK's read_region with z_layer parameter
                    region_array = tiff_wrapper.read_region(
                        location=(new_coord[0], new_coord[1]),
                        level=0,
                        size=(region_width, region_height),
                        as_array=True,
                        z_layer=layer_idx
                    )
                    
                    # Convert to PIL Image
                    if region_array.ndim == 2:
                        image = Image.fromarray(region_array).convert('RGB')
                    elif len(region_array.shape) >= 3 and region_array.shape[2] >= 3:
                        image = Image.fromarray(region_array[:, :, :3].astype(np.uint8))
                    else:
                        return {"success": False, "error": f"Invalid image data for z-layer {layer_idx}"}
                    
                    image = image.convert('RGBA')
                    layer_images = None
                except Exception as e:
                    return {"success": False, "error": f"Failed to read z-layer {fixed_z_layer}: {e}"}
                
            else:
                # Single layer. Read from a downsampled pyramid level when the
                # region is large — patch tiles are 512px+, zoomed views much
                # larger, and decoding megapixels at level 0 is the dominant
                # cost. The downsampled image is kept at that smaller size
                # (NOT resized back to the level-0 region): the final tile is
                # only ~512 px, so upscaling a multi-megapixel region just to
                # shrink it again is wasted work. The contour is mapped into
                # this downsampled space instead (see read_ds use below).
                read_level = 0
                try:
                    target = max(region_width, region_height)
                    # Largest pyramid level that still reads >= ~96 px — keeps
                    # the read near display resolution. A 512 px patch on a 4x
                    # pyramid drops to level 1 (128 px), ~16x less to decode.
                    for lvl, ds in enumerate(slide.level_downsamples):
                        if target / ds >= 96:
                            read_level, read_ds = lvl, float(ds)
                        else:
                            break
                except Exception:
                    read_level, read_ds = 0, 1.0
                rw = max(1, int(round(region_width / read_ds)))
                rh = max(1, int(round(region_height / read_ds)))
                image = slide.read_region(
                    location=(new_coord[0], new_coord[1]),
                    level=read_level,
                    size=(rw, rh)
                )

                # remove alpha channel; keep the downsampled size as-is
                image = Image.fromarray(np.array(image)[..., :3])
                image = image.convert('RGBA')
                layer_images = None  # No multi-layer for single image
            
            # Draw contour on image(s)
            if contour_type is not None:
                # Calculate contour relative coordinates
                contour_relative = np.copy(contour).astype(np.float64)
                contour_relative[:, 0] = contour[:, 0] - new_coord[0]
                contour_relative[:, 1] = contour[:, 1] - new_coord[1]
                # The single-layer image is kept at its downsampled size, so
                # map the contour (level-0 coords) into that same space.
                if read_ds != 1.0:
                    contour_relative = contour_relative / read_ds
                
                # contour drawing logic with auto type selection
                current_contour_type = contour_type
                rectwidth = 1
                polygonwidth = 1  # Width for polygon contour lines
                offset_on_screen = 5
                
                # Auto-select contour type based on patch size (only if contour_type is None)
                # If user explicitly specified 'polygon', respect that choice
                if contour_type is None:
                    if patchsize > 500:
                        current_contour_type = 'rect'
                        rectwidth = 5
                        polygonwidth = 3
                        offset_on_screen = 10
                    if patchsize > 1000:
                        rectwidth = 10
                        polygonwidth = 5
                        offset_on_screen = 15
                    if patchsize > 2000:
                        rectwidth = 20
                        polygonwidth = 10
                        offset_on_screen = 20
                else:
                    # User specified contour_type, adjust width based on patch size but keep the type
                    if patchsize >= 512:
                        # For 512px and above, use thicker lines
                        rectwidth = 5
                        polygonwidth = 3
                        offset_on_screen = 10
                    elif patchsize >= 256:
                        # For 256px, use medium lines
                        rectwidth = 3
                        polygonwidth = 2
                        offset_on_screen = 8
                    if patchsize > 1000:
                        rectwidth = 10
                        polygonwidth = 5
                        offset_on_screen = 15
                    if patchsize > 2000:
                        rectwidth = 20
                        polygonwidth = 10
                        offset_on_screen = 20

                # Line geometry is in level-0 pixels; the image is in the
                # downsampled space, so scale widths/offsets to match.
                if read_ds != 1.0:
                    rectwidth = max(1, int(round(rectwidth / read_ds)))
                    polygonwidth = max(1, int(round(polygonwidth / read_ds)))
                    offset_on_screen = offset_on_screen / read_ds

                def draw_contour_on_image(img):
                    """Helper function to draw contour on an image"""
                    img_rgba = img.convert('RGBA') if img.mode != 'RGBA' else img
                    transp = Image.new('RGBA', img_rgba.size, (0, 0, 0, 0))
                    draw = ImageDraw.Draw(transp, 'RGBA')
                    
                    if current_contour_type == 'rect':
                        bbox = np.zeros((2, 2))
                        bbox[0, 0] = np.min(contour_relative[:, 0]) - offset_on_screen
                        bbox[1, 0] = np.max(contour_relative[:, 0]) + offset_on_screen
                        bbox[0, 1] = np.min(contour_relative[:, 1]) - offset_on_screen
                        bbox[1, 1] = np.max(contour_relative[:, 1]) + offset_on_screen
                        draw.rectangle(
                            [bbox[0, 0], bbox[0, 1], bbox[1, 0], bbox[1, 1]],
                            fill=None, 
                            outline=(255, 255, 0, 128), 
                            width=rectwidth
                        )
                    elif current_contour_type == 'polygon':
                        contour_tuples = [(contour_relative[ci, 0], contour_relative[ci, 1]) 
                                        for ci in range(len(contour_relative))]
                        # Use polygonwidth for line thickness
                        # Draw polygon outline using lines to support width parameter
                        if polygonwidth > 1:
                            # Draw closed polygon using lines with width
                            for i in range(len(contour_tuples)):
                                start_point = contour_tuples[i]
                                end_point = contour_tuples[(i + 1) % len(contour_tuples)]
                                draw.line([start_point, end_point], fill=(255, 255, 0, 128), width=polygonwidth)
                        else:
                            # Default thin line
                            draw.polygon(contour_tuples, outline=(255, 255, 0, 128))
                    
                    img_rgba.paste(Image.alpha_composite(img_rgba, transp))
                    return img_rgba
                
                # Apply contour to all layers or single image
                if is_zstack and layer_images is not None:
                    layer_images = [draw_contour_on_image(img) for img in layer_images]
                elif image is not None:
                    image = draw_contour_on_image(image)
            
            # Generate final output: GIF for z-stack (all layers), JPEG for single layer or fixed layer
            if is_zstack and fixed_z_layer is None and layer_images is not None:
                # Z-stack with all layers: create animated GIF
                processed_layers = []
                for layer_img in layer_images:
                    rgb_img = layer_img.convert('RGB')
                    if rgb_img.size != (windowsize, windowsize):
                        rgb_img = rgb_img.resize((windowsize, windowsize), Image.Resampling.LANCZOS)
                    processed_layers.append(rgb_img)
                
                # Create animated GIF
                buffered = BytesIO()
                processed_layers[0].save(
                    buffered,
                    format="GIF",
                    save_all=True,
                    append_images=processed_layers[1:],
                    duration=300,  # 300ms per frame
                    loop=0,  # Infinite loop
                    optimize=False
                )
                img_base64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
                image_data_url = f"data:image/gif;base64,{img_base64}"
            else:
                # Single layer OR fixed z-layer: convert to RGB and encode as JPEG
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
            
            # Clean up tiff_wrapper if it was created
            if tiff_wrapper is not None:
                try:
                    tiff_wrapper.close()
                except Exception:
                    pass  # Ignore errors during cleanup
            
        except Exception as e:
            # Clean up tiff_wrapper on error
            if tiff_wrapper is not None:
                try:
                    tiff_wrapper.close()
                except Exception:
                    pass
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
            "contour": [{"x": float(point[0]), "y": float(point[1])} for point in contour] if contour is not None else None,
            "is_zstack": is_zstack,
            "num_z_layers": num_z_layers if is_zstack else None,
            "image_format": "gif" if (is_zstack and fixed_z_layer is None) else "jpeg",
            "current_z_layer": int(fixed_z_layer) if fixed_z_layer is not None else None
        }
        
        # Cell classification is attached by get_cell_review_tile_data — the
        # core renders the tile only.
        return {"success": True, "data": response_data}

    except Exception as e:
        logger.error(f"Error in _render_review_tile: {str(e)}", exc_info=e)
        return {"success": False, "error": f"Error generating review tile: {str(e)}"}


def get_cell_review_tile_data(req: dict) -> dict:
    """Review tile for a nuclei cell — the cell entry point.

    Renders the tile via the shared _render_review_tile core (which reads the
    cell contour from the Zarr file and handles z-stacks), then attaches the
    cell's classification from Zarr.
    """
    result = _render_review_tile(req)
    if result.get("success"):
        try:
            slide_id = req.get("slide_id", "")
            cell_id = req.get("cell_id", "")
            zarr_path = resolve_path(as_zarr_path(slide_id))
            if os.path.exists(zarr_path):
                classification_data = _get_cell_classification(zarr_path, cell_id)
                if classification_data:
                    result.setdefault("data", {}).update(classification_data)
        except Exception as e:
            logger.debug(f"[Review Tile] classification lookup failed: {e}")
    return result


def get_patch_review_tile_data(req: dict) -> dict:
    """Review tile for a patch — the patch counterpart of the cell tile.

    A patch has no contour, but its bounding box trivially forms a rectangular
    one. This synthesises that rectangle and delegates to _render_review_tile,
    so patches reuse the exact cell pipeline (region, contour, and the
    window_size_px zoom).

    req needs: slide_id, patch_id, bbox [x1, y1, x2, y2].
    Optional: window_size_px (FOV — larger = more surrounding context),
    contour_type.
    """
    bbox = req.get("bbox")
    if not bbox or len(bbox) < 4:
        return {"success": False, "error": "Patch bbox is required"}
    try:
        x1, y1, x2, y2 = [float(v) for v in bbox[:4]]
    except (TypeError, ValueError):
        return {"success": False, "error": "Invalid patch bbox"}

    patch_req = dict(req)
    patch_req["skip_zstack"] = True  # patches are never z-stacks
    patch_req["cell_id"] = str(req.get("patch_id", req.get("cell_id", "patch")))
    patch_req["centroid"] = {"x": (x1 + x2) / 2.0, "y": (y1 + y2) / 2.0}
    # The patch bbox expressed as a rectangular contour
    patch_req["contour"] = [
        {"x": x1, "y": y1}, {"x": x2, "y": y1},
        {"x": x2, "y": y2}, {"x": x1, "y": y2},
    ]
    # Draw that rectangle on the tile — otherwise, once window_size_px zooms
    # out to surrounding context, the patch itself is no longer findable.
    patch_req.setdefault("contour_type", "rect")
    # Default the FOV to the patch size (the patch shown exactly); a larger
    # window_size_px zooms out to surrounding context.
    if not patch_req.get("window_size_px"):
        patch_req["window_size_px"] = int(max(x2 - x1, y2 - y1, 1))
    return _render_review_tile(patch_req)


def _get_cell_classification(zarr_path: str, cell_id: str) -> Optional[Dict]:
    """
    Helper function to retrieve cell classification data from Zarr file.
    Reads classification data from ClassificationNode group.
    
    Args:
        zarr_path: Path to Zarr file
        cell_id: String representation of cell index
        
    Returns:
        Dictionary containing classification data: {"predicted_class": str, "probs": dict, "label": str} or None
    """
    try:
        with open_zarr_cm(zarr_path, 'r') as zf:
            # Look for classification data in ClassificationNode
            if 'Cell-Classification' in zf:
                class_group = zf['Cell-Classification']
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
                            if cell_idx < len(prob_dataset) and len(prob_dataset[cell_idx]) == 1:
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
                if 'User-Annotations' in zf:
                    try:
                        user_group = zf['User-Annotations']
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
                    return result
                
            logger.debug(f"No classification data found for cell {cell_id} in Zarr file")
            return None
            
    except Exception as e:
        logger.warning(f"Error reading classification from Zarr file {zarr_path}: {str(e)}")
        return None

def _get_cell_contour(zarr_path: str, cell_id: str) -> Optional[List[Dict[str, float]]]:
    """
    Helper function to retrieve cell contour from Zarr file.
    Reads contour data from Cell-Segmentation/contours dataset.
    
    Args:
        zarr_path: Path to Zarr file
        cell_id: String representation of cell index
        
    Returns:
        List of contour points as [{"x": float, "y": float}] or None if not found
    """
    try:
        with open_zarr_cm(zarr_path, 'r') as zf:
            # Look for segmentation data in Cell-Segmentation
            if 'Cell-Segmentation' in zf:
                seg_group = zf['Cell-Segmentation']
                
                # Check if contours are stored
                if 'contours' in seg_group:
                    contours_dataset = seg_group['contours']
                    cell_idx = int(cell_id)

                    # Validate cell index. NOTE: len(zarr_array) raises
                    # "object of type 'Array' has no len()" on zarr v3 — use
                    # .shape[0]. This failure previously bubbled to the outer
                    # except → "No contour data found" → placeholder crops.
                    n_contours = contours_dataset.shape[0]
                    if cell_idx < 0 or cell_idx >= n_contours:
                        logger.warning(f"Cell ID {cell_id} is out of range (0-{n_contours-1})")
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
                        return valid_points
                    else:
                        logger.warning(f"Cell {cell_id} has insufficient valid contour points: {len(valid_points)}")
                        return None
                        
            logger.info(f"No contour data found for cell {cell_id} in Zarr file")
            return None
            
    except Exception as e:
        logger.warning(f"Error reading contour from Zarr file {zarr_path}: {str(e)}")
        return None

def _clear_user_annotation_kind(zf, kind: str) -> bool:
    """
    Delete ONLY one annotation type ('cell' | 'patch') from the shared User-Annotations
    group, leaving the other type intact. Cell and patch annotations live in separate
    sub-arrays (User-Annotations/cell, User-Annotations/patch) with per-type palette attrs
    ({kind}_class_names / {kind}_class_colors), so a cell reset must not wipe patch
    annotations and vice versa. Returns True if anything was removed.
    """
    if 'User-Annotations' not in zf:
        return False
    ua = zf['User-Annotations']
    removed = False
    if kind in ua:
        del ua[kind]
        removed = True
    # Also drop the SEPARATELY-persisted per-class counts array ({kind}_class_counts).
    # get_all_nuclei_counts() treats this array as the source of truth and reads it
    # directly, so if we delete the annotations but leave the counts behind, stale
    # counts (notably "Negative control") survive a reset and keep showing in the panel.
    counts_key = f'{kind}_class_counts'
    if counts_key in ua:
        del ua[counts_key]
        removed = True
    for attr in (f'{kind}_class_names', f'{kind}_class_colors'):
        if attr in ua.attrs:
            del ua.attrs[attr]
            removed = True
    return removed


def reset_zarr_classification_data(zarr_path: str) -> dict:
    """
    Deletes classification and user annotation data from an Zarr file.
    Removes 'Cell-Classification' and the CELL annotations (User-Annotations/cell),
    preserving any patch annotations in the same User-Annotations group.
    """
    if not os.path.exists(zarr_path):
        return {"status": "error", "message": f"Zarr file not found at {zarr_path}"}
        
    try:
        with open_zarr_cm(zarr_path, 'a') as zf:
            # Delete ClassificationNode if it exists
            classification_node_name = "Cell-Classification"
            if classification_node_name in zf:
                del zf[classification_node_name]

            # Delete ONLY the cell annotations (not the whole group) so patch
            # annotations in the same User-Annotations group survive a cell reset.
            _clear_user_annotation_kind(zf, 'cell')

        # After deleting from Zarr, reload all handlers that use this file
        try:
            from app.services.seg import SegmentationHandler
            from app.services.seg_registry import iter_annotation_handlers
            reloaded_count = 0
            for instance_id, handler in iter_annotation_handlers():
                if handler is None or not getattr(handler, 'zarr_file', None):
                    continue
                if not SegmentationHandler._same_zarr_path(handler.zarr_file, zarr_path):
                    continue
                try:
                    handler.class_id = None
                    handler.class_name = None
                    handler.class_hex_color = None
                    handler.invalidate_user_counts_cache()
                    if hasattr(handler, '_global_label_counts_cache'):
                        handler._global_label_counts_cache = None
                    if hasattr(handler, '_viewport_cache'):
                        handler._viewport_cache.clear()
                    handler.load_file(zarr_path, force_reload=True, reload_segmentation_data=True)
                    try:
                        if handler.zarr_file and os.path.exists(handler.zarr_file):
                            with open_zarr_cm(handler.zarr_file, 'r') as zarr_file:
                                handler._apply_manual_nuclei_annotations(zarr_file)
                    except Exception as e:
                        logger.warning(f"Failed to re-apply manual annotations for instance {instance_id}: {e}")
                    reloaded_count += 1
                except Exception as e:
                    logger.warning(f"Failed to reload handler for instance {instance_id}: {e}")
        except Exception as e:
            logger.warning(f"Could not reload handlers after reset: {e}")

        return {"status": "success", "message": "Successfully reset classification and user annotations in Zarr file."}
    except Exception as e:
        error_message = f"An error occurred while resetting Zarr file: {e}"
        print(f"{error_message}\n{traceback.format_exc()}")
        return {"status": "error", "message": error_message}

def reset_tissue_segmentation_data(zarr_path: str) -> dict:
    """
    Remove VISTA's tissue segmentation output (Tissue-Segmentation group). Called by the
    VISTA node's reset in addition to reset_patch_classification_data, because the tissue
    masks are downstream of the patch classification and become stale on reset.
    """
    try:
        if not os.path.exists(zarr_path):
            return {"status": "error", "message": f"Zarr file not found at {zarr_path}"}
        removed = []
        # open_zarr_cm, like the two sibling reset functions: zarr v3 takes mode
        # as a keyword and its Group is not a context manager, so
        # `with zarr.open(path, 'a')` raised TypeError on every call and the
        # group was never removed. Going through the wrapper also takes
        # zarr_lock, which a write to a shared store needs.
        with open_zarr_cm(zarr_path, 'a') as zf:
            if 'Tissue-Segmentation' in zf:
                del zf['Tissue-Segmentation']
                removed.append('Tissue-Segmentation')
        return {"status": "ok", "removed": removed}
    except Exception as e:
        logger.error(f"[reset_tissue_segmentation_data] failed: {e}", exc_info=e)
        return {"status": "error", "message": str(e)}


def reset_patch_classification_data(zarr_path: str) -> dict:
    """
    Remove patch classification (Patch-Classification group) and the PATCH user
    annotations (User-Annotations/patch), preserving the patch embeddings/coordinates in
    Patch-Segmentation AND any cell annotations (User-Annotations/cell) in the shared group.
    """
    try:
        if not os.path.exists(zarr_path):
            return {"status": "error", "message": f"Zarr file not found at {zarr_path}"}

        removed = []
        with open_zarr_cm(zarr_path, 'a') as zf:
            # Remove ONLY the patch annotations (not the whole group) so cell
            # annotations in the same User-Annotations group survive a patch reset.
            if _clear_user_annotation_kind(zf, 'patch'):
                removed.append('User-Annotations/patch')

            # Drop the entire Patch-Classification group.
            if 'Patch-Classification' in zf:
                del zf['Patch-Classification']
                removed.append('Patch-Classification')

        # After deleting from Zarr, reload all handlers that use this file
        try:
            from app.services.seg import SegmentationHandler
            from app.services.seg_registry import iter_annotation_handlers
            reloaded_count = 0
            for instance_id, handler in iter_annotation_handlers():
                if handler is None or not getattr(handler, 'zarr_file', None):
                    continue
                if not SegmentationHandler._same_zarr_path(handler.zarr_file, zarr_path):
                    continue
                try:
                    handler.patch_class_id = None
                    handler.patch_class_name = None
                    handler.patch_class_hex_color = None
                    handler.invalidate_user_counts_cache()
                    handler.load_file(zarr_path, force_reload=True, reload_segmentation_data=True)
                    try:
                        if handler.zarr_file and os.path.exists(handler.zarr_file):
                            with open_zarr_cm(handler.zarr_file, 'r') as zarr_file:
                                handler._apply_manual_nuclei_annotations(zarr_file)
                    except Exception as e:
                        logger.warning(f"Failed to re-apply manual annotations for instance {instance_id}: {e}")
                    reloaded_count += 1
                except Exception as e:
                    logger.warning(f"Failed to reload handler for instance {instance_id}: {e}")
        except Exception as e:
            logger.warning(f"Could not reload handlers after reset patch classification: {e}")

        return {"status": "success", "message": "Patch classification data cleared", "removed": removed}
    except Exception as e:
        return {"status": "error", "message": f"Failed to reset patch classification: {e}\n{traceback.format_exc()}"}

def is_file_locked(file_path: str) -> bool:
    """Check if zarr file is locked - zarr files don't use traditional file locking"""
    try:
        # For zarr files, we don't need to check for traditional file locks
        # zarr uses filelock-based write locks for coordination, not file locks
        if file_path.endswith('.zarr') or os.path.isdir(file_path):
            # Just check if the file/directory is accessible
            if os.path.isdir(file_path):
                return not os.access(file_path, os.R_OK)
            else:
                return not os.path.exists(file_path) or not os.access(file_path, os.R_OK)
        else:
            # For non-zarr files, use traditional file locking check
            try:
                with open_zarr_cm(file_path, 'r') as _:
                    return False
            except Exception:
                return True
    except Exception:
        return True

def post_answer(answer: str, uid: str | None = None):
    """
    Post an answer string and mark generation complete so Chatbox can consume it.
    Requires uid (per-user state in user_workflow_status).
    """
    if not uid:
        return
    if uid not in user_workflow_status:
        user_workflow_status[uid] = {}
    user_workflow_status[uid]["cur_answer"] = answer
    user_workflow_status[uid]["is_generating"] = False


def begin_script_summary_wait(uid: Optional[str] = None) -> None:
    """
    Before execute_script runs: block /tasks/v1/get_answer with 'wait' and clear stale cur_answer
    until summary_answer calls post_answer. Avoids racing a JSON execute result against the summary.
    """
    if not uid:
        return
    if uid not in user_workflow_status:
        user_workflow_status[uid] = {}
    user_workflow_status[uid]["is_generating"] = True
    user_workflow_status[uid]["cur_answer"] = None
    user_workflow_status[uid]["script_error_code"] = None
    user_workflow_status[uid]["script_error_message"] = None


def end_script_summary_wait(
    uid: Optional[str] = None,
    error_code: Optional[int] = None,
    error_message: Optional[str] = None,
) -> None:
    """If execute_script aborts before summary_answer, unblock get_answer for this user."""
    if not uid or uid not in user_workflow_status:
        return
    user_workflow_status[uid]["is_generating"] = False
    user_workflow_status[uid]["script_error_code"] = error_code
    user_workflow_status[uid]["script_error_message"] = error_message


def _topological_sort_explicit_node_list(node_names: List[str], dep_map: Dict[str, List[str]]) -> List[str]:
    """
    Topological order of node_names using dep_map where dep_map[n] = nodes that n depends on (parents).
    Stable tie-break: preserve first occurrence index in node_names.
    """
    node_set = set(node_names)
    indeg: Dict[str, int] = {n: 0 for n in node_names}
    adj: Dict[str, List[str]] = defaultdict(list)
    for n in node_names:
        for p in dep_map.get(n) or []:
            if p not in node_set:
                continue
            adj[p].append(n)
            indeg[n] += 1
    order_idx = {n: i for i, n in enumerate(node_names)}
    out: List[str] = []
    ready = sorted([n for n in node_names if indeg[n] == 0], key=lambda x: order_idx[x])
    while ready:
        u = ready.pop(0)
        out.append(u)
        for v in sorted(adj.get(u, []), key=lambda x: order_idx[x]):
            indeg[v] -= 1
            if indeg[v] == 0:
                ready.append(v)
        ready.sort(key=lambda x: order_idx[x])
    if len(out) != len(node_names):
        raise ValueError("task_dependencies contain a cycle or reference unknown nodes")
    return out


# start_workflow_from_frontend lives in app.services.workflow.start
# (re-exported at bottom of this module for API compatibility).


def _node_participated(status_val, progress_val) -> bool:
    """True when a node actually ran (status 1/2) or reported progress > 0."""
    return status_val in (1, 2) or (
        isinstance(progress_val, (int, float)) and progress_val > 0
    )


def promote_participating_nodes_done(node_status: dict, node_progress) -> tuple:
    """
    On successful completion, snap participating nodes to status=2 / progress=100.
    Never-started (0) and failed (-1) nodes are left alone. Mirror of frontend
    completionSideEffects.markParticipatingNodesDone.
    """
    progress_src = node_progress if isinstance(node_progress, dict) else {}
    out_status = {}
    out_progress = {}
    for k, v in node_status.items():
        if str(k).startswith("_"):
            out_status[k] = v
            continue
        prog = progress_src.get(k, 0)
        if _node_participated(v, prog):
            out_status[k] = 2
            out_progress[k] = 100
        else:
            out_status[k] = v
            if isinstance(prog, (int, float)):
                out_progress[k] = int(prog)
    return out_status, out_progress


def build_workflow_complete_progress(
    current_statuses: dict, current_progress, *, user_status: str
) -> dict:
    """Final SSE node_progress: 100 for participants on success, else live values."""
    progress_src = current_progress if isinstance(current_progress, dict) else {}
    terminal = {}
    for k, st in current_statuses.items():
        if str(k).startswith("_"):
            continue
        prev = progress_src.get(k, 0)
        if user_status == "completed" and _node_participated(st, prev):
            terminal[k] = 100
        else:
            terminal[k] = prev if isinstance(prev, (int, float)) else 0
    return terminal


def get_current_workflow_status(uid: str) -> dict:
    """
    Return current user's workflow status snapshot for frontend restore after page refresh.
    If the user has an active (running or queued) execution, returns execution_id, status,
    node_status, node_progress, queue_position, queue_total.
    When idle/terminal, returns active=False and still includes status/error/zarr_path so
    batch polling and reconcile can distinguish completed vs error (not only {active: false}).
    """
    if uid not in user_workflow_status:
        return {"active": False}
    user_status = user_workflow_status[uid]
    status = user_status.get("status")
    if not is_active_status(status):
        out = {"active": False}
        if status in ("completed", "error", "cancelled"):
            out["status"] = status
            zarr_path = user_status.get("zarr_path")
            if isinstance(zarr_path, str) and zarr_path:
                out["zarr_path"] = zarr_path
            err = user_status.get("error")
            if isinstance(err, str) and err.strip():
                out["error"] = err.strip()
            node_status = user_status.get("node_status")
            node_progress = user_status.get("node_progress")
            if isinstance(node_status, dict) and node_status:
                # Promote participants to 2/100 on success so reconcile clients that
                # missed the final SSE frame do not freeze mid-progress.
                if status == "completed":
                    out_status, out_progress = promote_participating_nodes_done(
                        node_status, node_progress
                    )
                    out["node_status"] = out_status
                    if out_progress:
                        out["node_progress"] = out_progress
                else:
                    out["node_status"] = dict(node_status)
                    if isinstance(node_progress, dict) and node_progress:
                        out["node_progress"] = dict(node_progress)
            elif isinstance(node_progress, dict) and node_progress:
                out["node_progress"] = dict(node_progress)
        return out

    from app.services.workflow.runtime import user_active_executions, workflow_executions

    execution_id = user_active_executions.get(uid)
    if not execution_id:
        return {"active": False, "status": status}

    execution = workflow_executions.get(execution_id)
    if not execution:
        return {"active": False, "status": status}

    # Ordered step list for panel restore (dict preserves insertion order)
    steps = [{"model": node_name} for node_name in execution.tasks.keys()]
    if "GPT-4o Agent" in user_status.get("node_status", {}):
        steps.append({"model": "GPT-4o Agent"})

    node_status = dict(user_status.get("node_status", {}))
    node_status["_workflow_status"] = status
    if status == "queued":
        node_status["_queue_position"] = user_status.get("overall_queue_position", 0)
        node_status["_queue_total"] = sum(
            1 for e in workflow_executions.values() if is_active_status(e.status)
        )
    else:
        node_status["_queue_position"] = 0
        node_status["_queue_total"] = 0

    return {
        "active": True,
        "execution_id": execution_id,
        "status": status,
        "steps": steps,
        "zarr_path": user_status.get("zarr_path", ""),
        "node_status": node_status,
        "node_progress": user_status.get("node_progress", {}),
        "queue_position": node_status.get("_queue_position", 0),
        "queue_total": node_status.get("_queue_total", 0),
    }


def _embedding_width(zf: zarr.Group, dataset_path: str) -> Optional[int]:
    """Feature width of a 2-D embedding dataset, or None when absent/empty/1-D.

    Cell-Segmentation/embeddings and Patch-Segmentation/embeddings are each shared
    by several models, so the width is what identifies the producer (PLIP 768,
    Cytoformer 1536; MUSK 1024, H-optimus-0 1536, Virchow 2560).
    """
    try:
        if dataset_path not in zf:
            return None
        shape = getattr(zf[dataset_path], "shape", None)
        if not shape or len(shape) != 2 or shape[0] <= 0:
            return None
        return int(shape[1])
    except Exception:
        return None


# Feature width each patch model writes to the shared Patch-Segmentation/embeddings.
_PATCH_EMBEDDING_DIMS = {
    "MuskEmbedding": 1024,
    "MuskClassification": 1024,
    "HOptimusEmbedding": 1536,
    "HOptimusClassification": 1536,
    "VirchowEmbedding": 2560,
    "VirchowClassification": 2560,
}


def _dataset_exists_nonempty(zf: zarr.Group, dataset_path: str) -> bool:
    """Return True when dataset/group exists and is non-empty."""
    try:
        if dataset_path not in zf:
            return False
        node = zf[dataset_path]
        shape = getattr(node, "shape", None)
        if shape is None:
            # Group-like node
            return True
        if shape == ():
            return True
        return int(np.prod(shape)) > 0
    except Exception:
        return False


def _group_has_prefixed_child(zf: zarr.Group, group_name: str, prefix: str) -> bool:
    try:
        if group_name not in zf:
            return False
        group = zf[group_name]
        for key in list(group.keys()):
            if str(key).startswith(prefix):
                return True
    except Exception:
        return False
    return False


def _compute_stage_progress_for_node(node_name: str, zf: zarr.Group) -> Dict[str, int]:
    """
    Best-effort stage completion from zarr content.
    Stages are reported as 0/100 to keep API stable and simple for frontend mapping.
    """
    stage = {"segmentation": 0, "embedding": 0, "classification": 0, "code_running": 0}

    has_cell_seg = (
        _dataset_exists_nonempty(zf, "Cell-Segmentation/centroids")
        or _dataset_exists_nonempty(zf, "nuclei_segmentation/centroids")
        or _dataset_exists_nonempty(zf, "morphology/centroids")
    )
    # PLIP-flavoured cell embeddings (StarDist/CellPose/InstanSeg -> NuClass). The
    # slot is shared with Cytoformer's 1536-d features, so match on the width
    # rather than mere existence; Cell-Segmentation/probabilities is segmentation
    # output and says nothing about embeddings.
    has_cell_embedding = (
        _embedding_width(zf, "Cell-Segmentation/embeddings") == 768
        or _dataset_exists_nonempty(zf, "ClassificationNode/embedding")
    )
    has_cell_classification = _dataset_exists_nonempty(zf, "Cell-Classification/class_indices")
    classification_model = ""
    try:
        classification_model = str(
            zf["Cell-Classification/metadata"].attrs.get("model") or ""
        ).casefold()
    except (KeyError, TypeError):
        classification_model = ""
    has_cytoformer_classification = (
        has_cell_classification and classification_model == "cytoformer"
    )
    has_nuclass_classification = (
        has_cell_classification and classification_model in ("", "nuclass")
    )
    has_cytoformer_embedding = False
    try:
        cyto_embeddings = zf["Cell-Segmentation/embeddings"]
        centroids = zf["Cell-Segmentation/centroids"]
        embedding_shape = tuple(cyto_embeddings.shape)
        centroid_shape = tuple(centroids.shape)
        embedding_model = str(cyto_embeddings.attrs.get("embedding_model") or "").casefold()
        embedding_backbone = str(
            cyto_embeddings.attrs.get("embedding_backbone") or ""
        ).casefold()
        embedding_dim = int(cyto_embeddings.attrs.get("embedding_dim") or 0)
        embedding_norm = str(cyto_embeddings.attrs.get("embedding_norm") or "").casefold()
        has_cytoformer_embedding = (
            len(embedding_shape) == 2
            and embedding_shape[0] > 0
            and embedding_shape[1] == 1536
            and len(centroid_shape) >= 1
            and centroid_shape[0] == embedding_shape[0]
            and embedding_model == "cytoformer"
            and embedding_backbone == "h-optimus-0"
            and embedding_dim == 1536
            and embedding_norm == "feat_norm"
        )
    except (KeyError, TypeError, ValueError):
        has_cytoformer_embedding = False
    has_patch_embedding = (
        _dataset_exists_nonempty(zf, "Patch-Segmentation/embeddings")
        or _dataset_exists_nonempty(zf, "Patch-Segmentation/coordinates")
        or _dataset_exists_nonempty(zf, "Patch-Segmentation/probabilities")
    )
    # Patch-Segmentation/embeddings is shared by MUSK/H-optimus-0/Virchow, so a
    # node's own stage is only complete when the stored width is its own.
    patch_embedding_width = _embedding_width(zf, "Patch-Segmentation/embeddings")
    expected_patch_width = _PATCH_EMBEDDING_DIMS.get(node_name)
    if expected_patch_width is not None:
        has_patch_embedding = patch_embedding_width == expected_patch_width
    has_patch_classification = _dataset_exists_nonempty(zf, "Patch-Classification/class_indices")

    lower_name = (node_name or "").lower()
    if node_name == "Cytoformer":
        stage["segmentation"] = 100 if has_cell_seg else 0
        stage["embedding"] = 100 if has_cytoformer_embedding else 0
    elif node_name == "CytoformerClassification":
        stage["segmentation"] = 100 if has_cell_seg else 0
        stage["embedding"] = 100 if has_cytoformer_embedding else 0
        stage["classification"] = 100 if has_cytoformer_classification else 0
    elif node_name in ("StarDist", "InstanSegNode", "CellCast") or "seg" in lower_name:
        stage["segmentation"] = 100 if has_cell_seg else 0
        stage["embedding"] = 100 if has_cell_embedding else 0
    elif node_name in ("NuClass", "NucleiClassify"):
        stage["segmentation"] = 100 if has_cell_seg else 0
        stage["embedding"] = 100 if has_cell_embedding else 0
        stage["classification"] = 100 if has_nuclass_classification else 0
    elif node_name == "MuskEmbedding":
        # Embedding-only node: do not tie completion to MuskNode tissue_* class outputs.
        stage["embedding"] = 100 if has_patch_embedding else 0
        stage["classification"] = 0
    elif node_name in (
        "MuskClassification",
        "HOptimusClassification",
        "VirchowClassification",
        "VISTA",
    ):
        stage["embedding"] = 100 if has_patch_embedding else 0
        stage["classification"] = 100 if has_patch_classification else 0
    elif node_name in ("HOptimusEmbedding", "VirchowEmbedding"):
        stage["embedding"] = 100 if has_patch_embedding else 0
        stage["classification"] = 0
    elif node_name == "GPT-4o Agent":
        # Script output is runtime-derived. Keep zarr-derived baseline at pending.
        stage["code_running"] = 0

    return stage


def get_workflow_stage_status(uid: str, zarr_path: str, steps: Optional[List[Dict[str, Any]]] = None) -> dict:
    """
    Return merged workflow stage status:
    1) baseline derived from zarr persisted outputs
    2) running status override from user_workflow_status (SSE source-of-truth while executing)
    """
    resolved = as_zarr_path(resolve_path(zarr_path or ""))
    if not resolved or not os.path.exists(resolved):
        return {
            "zarr_path": resolved,
            "node_status": {},
            "node_progress": {},
            "stage_progress": {},
        }

    requested_nodes: List[str] = []
    if isinstance(steps, list):
        for step in steps:
            if not isinstance(step, dict):
                continue
            model = step.get("model")
            if isinstance(model, str) and model.strip():
                requested_nodes.append(model.strip())
    requested_nodes = list(dict.fromkeys(requested_nodes))

    stage_progress: Dict[str, Dict[str, int]] = {}
    node_progress: Dict[str, int] = {}
    node_status: Dict[str, int] = {}

    try:
        with open_zarr_cm(resolved, mode="r") as zf:
            nodes_to_eval = requested_nodes or [
                "StarDist",
                "InstanSegNode",
                "CellCast",
                "Cytoformer",
                "NuClass",
                "CytoformerClassification",
                "MuskEmbedding",
                "MuskClassification",
                "HOptimusEmbedding",
                "HOptimusClassification",
                "VirchowEmbedding",
                "VirchowClassification",
                "VISTA",
                "GPT-4o Agent",
            ]
            for node_name in nodes_to_eval:
                stage = _compute_stage_progress_for_node(node_name, zf)
                stage_progress[node_name] = stage
                active_values = [
                    v for k, v in stage.items()
                    if not (node_name != "GPT-4o Agent" and k == "code_running")
                ]
                progress = max(active_values) if active_values else 0
                node_progress[node_name] = progress
                node_status[node_name] = 2 if progress >= 100 else 0
    except Exception as e:
        logger.warning(f"[get_workflow_stage_status] failed reading zarr={resolved}: {e}")

    # Merge runtime status for the current user (running/queued workflow overrides baseline)
    user_state = user_workflow_status.get(uid, {})
    runtime_status = user_state.get("node_status", {}) if isinstance(user_state.get("node_status"), dict) else {}
    runtime_progress = user_state.get("node_progress", {}) if isinstance(user_state.get("node_progress"), dict) else {}
    for node_name, status in runtime_status.items():
        if not isinstance(node_name, str):
            continue
        try:
            node_status[node_name] = int(status)
        except Exception:
            continue
    for node_name, progress in runtime_progress.items():
        if not isinstance(node_name, str):
            continue
        try:
            node_progress[node_name] = max(0, min(100, int(progress)))
        except Exception:
            continue

    # Keep response stable for frontend display logic.
    return {
        "zarr_path": resolved,
        "node_status": node_status,
        "node_progress": node_progress,
        "stage_progress": stage_progress,
    }


def list_node_ports(skip_health_checks: bool = False):
    """
    List all TaskNodes and their port numbers.
    
    This function collects port information from:
    1. The services dictionary
    2. The TaskNodeManager nodes
    3. Custom nodes from the custom node registry
    
    Returns:
    - A dictionary with node information, success status, and error message if any.
      IMPORTANT: Always returns {"success": True, "nodes": ...} even on partial failure,
      to prevent frontend from wiping all node state on transient errors.
    """
    all_nodes = {}
    try:
        # Get ports from services dictionary (ONLY include running services)
        service_ports = {}
        for service_name, details in services.items():
            try:
                if details.get("running", False):
                    service_ports[service_name] = {
                        "port": details.get("port"),
                        "running": True,
                        "file_path": details.get("file")
                    }
            except Exception:
                pass

        # Get ports from TaskNodeManager nodes
        # IMPORTANT: Do not include manager-only nodes in list_node_ports output to avoid UI showing 'Active'
        manager_nodes = {}

        # Get ports from custom node registry (includes both running and stopped processes)
        # This allows UI to show nodes that were running but went offline
        custom_nodes = {}
        try:
            from app.utils.workflow.register import list_custom_node_services
            custom_services = list_custom_node_services(skip_health_checks=skip_health_checks)
            # NOTE: keys of custom_services are composite: f"{env_name}::{model_name}"
            for registry_key, info in custom_services.items():
                model_name = info.get("model_name")
                is_running = info.get("running", False)
                # Include node even if not running, so UI can show offline status
                # Only exclude if model_name is missing (invalid entry)
                if model_name:
                    custom_nodes[model_name] = {
                        "port": info.get("port"),
                        "pid": info.get("pid"),
                        # Expose composite key under env_name so stop requests target a single process
                        "env_name": registry_key,
                        "running": is_running,  # Include actual running status
                        "log_path": info.get("log_path"),
                        "remote_host": info.get("remote_host"),  # Include remote_host for UI
                    }
        except ImportError:
            logger.warning("Could not import list_custom_node_services")
        except Exception as e:
            logger.warning(f"Error getting custom node services: {str(e)}")

        # Merge all port information
        
        # Get set of custom node model names for filtering
        custom_node_names = set(custom_nodes.keys())

        # Add service ports - but filter out custom nodes that are not in registry
        # This ensures that if a custom node was stopped, it won't appear in the list
        # even if services dict still has it (services dict cleanup might lag)
        for name, info in service_ports.items():
            # Skip custom nodes that are not in the registry (they were stopped)
            if name in custom_node_names:
                # This is a custom node - skip it here, we'll add it from custom_nodes below
                continue
            # Built-in service (not a custom node) - include it
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
                # Log if running status is being overwritten (potential source of disconnect bugs)
                prev_running = all_nodes[name].get("running")
                new_running = info.get("running")
                if prev_running != new_running:
                    logger.info(f"[list_node_ports] Node '{name}' running status overwritten: {prev_running} → {new_running} (by custom_nodes merge)")
                all_nodes[name].update(info)

        # Enrich missing factory information using manager and model store
        try:
            nodes_meta = model_store.get_nodes_extended()
        except Exception:
            nodes_meta = {}
        for name, info in list(all_nodes.items()):
            try:
                if info.get("factory") is None:
                    # try manager.node_factory
                    factory = manager.node_factory.get(name) if hasattr(manager, 'node_factory') else None
                    if not factory:
                        # try model store metadata
                        factory = nodes_meta.get(name, {}).get("factory")
                    if factory:
                        info["factory"] = factory
                # If runtime exists in model store, expose it in listing for UI
                runtime = nodes_meta.get(name, {}).get("runtime")
                if isinstance(runtime, dict):
                    for k in ["service_path", "env_name", "dependency_path", "python_version", "port", "log_path", "is_remote", "remote_host"]:
                        if (
                            k in runtime
                            and runtime[k] is not None
                            and (k not in info or info.get(k) is None)
                        ):
                            info[k] = runtime[k]
                    # For remote nodes, ensure log_path is set to model_name if not already set
                    # This ensures log button shows even after disconnect (when node is removed from registry)
                    if runtime.get("is_remote") is True and not info.get("log_path"):
                        info["log_path"] = name  # Use model_name as log_path for remote nodes
            except Exception:
                pass

        return {"success": True, "nodes": all_nodes}

    except Exception as e:
        logger.error(f"Error listing node ports: {str(e)}", exc_info=e)
        logger.error(f"[list_node_ports] traceback: {traceback.format_exc()}")
        # CRITICAL: Still return whatever nodes we collected so far.
        # Returning {"success": false} with no nodes causes the frontend to wipe
        # all node state, making every node appear as "Inactive".
        return {"success": True, "nodes": all_nodes}

def clear_workflow(workflow_id=None, uid: str | None = None):
    """
    Clear workflow(s) from the TaskNodeManager.

    Parameters:
    - workflow_id (int, optional): The workflow ID to clear. If None, all workflows are cleared.
    - uid (str, optional): When clearing all, only reset this user's script flags (never all users).

    Returns:
    - A dictionary with cleared workflow IDs, reset status, success status, and error message if any
    """
    try:
        cleared_ids = []
        reset_only = False

        if workflow_id is not None:
            # Special handling for CodingAgent-only workflow (ID -1)
            if workflow_id == -1:
                # CodingAgent-only workflows are not in manager.workflows
                cleared_ids.append(workflow_id)
            else:
                # Check if workflow exists
                if workflow_id not in manager.workflows:
                    return {"success": False, "error": f"Workflow {workflow_id} not found"}

                # Clear the specified workflow
                manager.remove_workflow(workflow_id)
                cleared_ids.append(workflow_id)
        else:
            # Clear TaskNodeManager graph only — do not invent a fake workflow status
            # or wipe every user's UI state.
            current_wf_ids = manager.list_workflows()
            cleared_ids = current_wf_ids
            manager.clear_workflows()

            if uid and uid in user_workflow_status:
                user_workflow_status[uid]["is_generating"] = False
                user_workflow_status[uid]["cur_answer"] = None

            reset_only = True

        return {"success": True, "cleared": cleared_ids, "reset_only": reset_only}

    except Exception as e:
        logger.error(f"Error when clearing workflow: {str(e)}", exc_info=e)
        return {"success": False, "error": f"Error when clearing workflow: {str(e)}"}

async def generate_node_status_events(uid: str = None):
    """
    Generator function for node status events used in Server-Sent Events (SSE)
    
    Status codes:
        0 - Not started
        1 - Running
        2 - Completed
    
    This endpoint uses SSE to continuously send status updates to the client.
    If uid is provided, returns status for that specific user.
    """
    # Initial status
    last_status = {}
    last_progress = {}
    last_send_monotonic = 0.0
    # Proxies (Cloudflare / nginx / ALB) often idle-kill SSE after ~60–100s with no bytes.
    # Long NuClass steps can plateaus with unchanged progress — keep the pipe warm.
    HEARTBEAT_INTERVAL_SEC = 15.0
    # The poll interval below sets how often progress frames go out. It must NOT
    # also set how long a *finished* run stays unreported: the viewer blocks its
    # whole post-run refresh on the completion frame, and sleeping the interval
    # out before noticing the terminal status cost a measured 1.4 s median
    # (2.0 s worst) of dead time on every run — more than the reload, the
    # viewport refetch, the packing and the decode put together. Wake in slices
    # and re-check; each slice is one dict lookup.
    TERMINAL_POLL_SEC = 0.1

    should_continue = True
    while should_continue:
        try:
            current_statuses = {}
            current_progress = {}
            now = time.monotonic()

            if uid and uid in user_workflow_status:
                # User-specific status
                user_status = user_workflow_status[uid]
                node_status = user_status.get('node_status', {})
                node_progress = user_status.get('node_progress', {})

                if user_status['status'] == 'queued':
                    # Queue meta (global model contention) — still stream per-node rows so UIs
                    # (Workflow Graph) receive updates when tasks leave pending / progress advances.
                    queue_pos = user_status.get('overall_queue_position', 0)
                    current_statuses['_queue_position'] = queue_pos
                    current_statuses['_workflow_status'] = 'queued'
                    from app.services.workflow.runtime import workflow_executions
                    total_queued = sum(1 for e in workflow_executions.values() if is_active_status(e.status))
                    current_statuses['_queue_total'] = total_queued
                    for node_name, status in node_status.items():
                        if str(node_name).startswith('_'):
                            continue
                        current_statuses[node_name] = status
                        current_progress[node_name] = node_progress.get(node_name, 0)
                    for node_name, progress in node_progress.items():
                        if str(node_name).startswith('_'):
                            continue
                        if node_name not in current_statuses:
                            current_statuses[node_name] = 0
                            current_progress[node_name] = progress
                elif user_status['status'] in ('running', 'cancelling'):
                    current_statuses['_workflow_status'] = user_status['status']
                    for node_name, status in node_status.items():
                        if str(node_name).startswith('_'):
                            continue
                        current_statuses[node_name] = status
                        current_progress[node_name] = node_progress.get(node_name, 0)
                    for node_name, progress in node_progress.items():
                        if str(node_name).startswith('_'):
                            continue
                        if node_name not in current_statuses:
                            current_statuses[node_name] = 0
                            current_progress[node_name] = progress
                elif user_status['status'] == 'completed':
                    current_statuses['_workflow_status'] = 'completed'
                    # Mark all nodes as completed
                    node_status = user_status.get('node_status', {})
                    for node_name in node_status.keys():
                        current_statuses[node_name] = 2
                        current_progress[node_name] = 100
                        
                elif user_status['status'] == 'cancelled':
                    # Even when cancelled, still send node status updates so frontend can detect execute completion
                    current_statuses['_workflow_status'] = 'cancelled'
                    # Include node statuses so frontend can detect when execute completes
                    node_status = user_status.get('node_status', {})
                    node_progress = user_status.get('node_progress', {})
                    for node_name, status in node_status.items():
                        current_statuses[node_name] = status
                        current_progress[node_name] = node_progress.get(node_name, 0)
                        
                elif user_status['status'] == 'error':
                    current_statuses['_workflow_status'] = 'error'
                    current_statuses['_error'] = user_status.get('error', 'Unknown error')

            elif uid:
                # Authenticated but no per-user entry yet — idle.
                pass

            # Check if we should send data
            should_send = False
            progress_data = {}
            
            if uid and uid in user_workflow_status:
                user_status = user_workflow_status[uid].get('status')
                if user_status == 'queued':
                    should_send = current_statuses != last_status
                    progress_data = current_progress
                    if not should_send and 'node_progress' in user_workflow_status[uid]:
                        user_progress = user_workflow_status[uid]['node_progress']
                        if user_progress != last_progress:
                            should_send = True
                            progress_data = user_progress
                    if not should_send and last_status == {}:
                        should_send = True
                elif user_status in ('running', 'cancelling'):
                    # Include cancelling so multi-tab / non-optimistic clients see Stopping.
                    should_send = current_statuses != last_status
                    progress_data = current_progress

                    # Also check if progress has changed for running users
                    if not should_send and 'node_progress' in user_workflow_status[uid]:
                        user_progress = user_workflow_status[uid]['node_progress']
                        if user_progress != last_progress:
                            should_send = True
                            progress_data = user_progress

                    # Force send if this is the first iteration (last_status is empty)
                    if not should_send and last_status == {}:
                        should_send = True
                            
                elif user_status == 'cancelled':
                    # For cancelled users, still send node status updates so frontend can detect execute completion
                    should_send = current_statuses != last_status
                    progress_data = current_progress
                    # Also check if progress has changed
                    if not should_send and 'node_progress' in user_workflow_status[uid]:
                        user_progress = user_workflow_status[uid]['node_progress']
                        if user_progress != last_progress:
                            should_send = True
                            progress_data = user_progress
                elif user_status in ['completed', 'error']:
                    # For completed/error users, only send once
                    should_send = current_statuses != last_status
                    progress_data = current_progress
            elif uid:
                # Authenticated idle — wait for a per-user entry; heartbeat not needed until active.
                should_send = False
            else:
                # Legacy unauthenticated path — send if statuses changed
                should_send = current_statuses != last_status
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
                        else:  # Not started (0) or unknown
                            progress_data[node_name] = 0
            
            if should_send:

                # Format for SSE: data: {json}\n\n
                try:
                    payload = {
                        'node_status': current_statuses,
                        'node_progress': progress_data
                    }

                    # Zarr-derived sub-stage progress (same as POST /workflow_stage_status) so clients
                    # can update the Workflow Graph without polling that endpoint.
                    if uid and uid in user_workflow_status:
                        zp = user_workflow_status[uid].get("zarr_path")
                        if isinstance(zp, str) and zp.strip():
                            try:
                                ns = user_workflow_status[uid].get("node_status") or {}
                                step_keys = [
                                    k
                                    for k in ns
                                    if isinstance(k, str) and not str(k).startswith("_")
                                ]
                                steps_arg = [{"model": k} for k in step_keys] if step_keys else None
                                st = get_workflow_stage_status(uid, zp, steps_arg)
                                if isinstance(st, dict):
                                    sp = st.get("stage_progress")
                                    if isinstance(sp, dict) and sp:
                                        payload["stage_progress"] = sp
                            except Exception:
                                logger.debug(
                                    "[SSE] attach stage_progress skipped uid=%s",
                                    uid,
                                    exc_info=True,
                                )

                    # Add queue information if available
                    if uid and uid in user_workflow_status:
                        user_status = user_workflow_status[uid]
                        if 'queue_positions_by_model' in user_status:
                            payload['queue_positions_by_model'] = user_status['queue_positions_by_model']
                        if 'overall_queue_position' in user_status:
                            payload['overall_queue_position'] = user_status['overall_queue_position']
                        # Include workflow status to help frontend distinguish between queued/running
                        payload['workflow_status'] = user_status.get('status', 'unknown')

                    # Ensure all values are JSON serializable
                    json_str = json.dumps(payload, ensure_ascii=False, default=str)
                    try:
                        yield f"data: {json_str}\n\n"
                        last_send_monotonic = now
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as conn_err:
                        # Client disconnected, stop sending
                        logger.info(f"SSE client disconnected for user {uid}: {conn_err}")
                        should_continue = False
                        break
                    except Exception as send_err:
                        # Other send errors - log and stop
                        logger.warning(f"SSE send error for user {uid}: {send_err}")
                        should_continue = False
                        break
                except Exception as e:
                    logger.error(f"JSON serialization error in SSE: {e}", exc_info=e)
                    logger.error(f"current_statuses: {current_statuses}", exc_info=e)
                    logger.error(f"progress_data: {progress_data}", exc_info=e)
                    # Try to send error message, but don't fail if send fails
                    try:
                        yield f"data: {json.dumps({'error': f'JSON serialization failed: {str(e)}'})}\n\n"
                        last_send_monotonic = now
                    except Exception:
                        # If we can't send error, client probably disconnected
                        logger.info(f"SSE client disconnected while sending error for user {uid}")
                        should_continue = False
                        break
                last_status = current_statuses.copy()
                last_progress = progress_data.copy()
            elif (
                uid
                and uid in user_workflow_status
                and is_active_status(user_workflow_status[uid].get('status'))
                and (now - last_send_monotonic) >= HEARTBEAT_INTERVAL_SEC
            ):
                # Keep-alive so idle proxies do not silently drop the stream mid-run.
                try:
                    yield f"data: {json.dumps({'heartbeat': True, 'ts': int(time.time())})}\n\n"
                    last_send_monotonic = now
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as conn_err:
                    logger.info(f"SSE client disconnected during heartbeat for user {uid}: {conn_err}")
                    should_continue = False
                    break
                except Exception as send_err:
                    logger.warning(f"SSE heartbeat send error for user {uid}: {send_err}")
                    should_continue = False
                    break

            # Check if workflow reached a terminal status
            if uid and uid in user_workflow_status:
                user_status = user_workflow_status[uid].get('status')
                if user_status in ['completed', 'error', 'cancelled']:
                    # Include node_progress so a dropped prior frame still snaps bars.
                    try:
                        if user_status == 'completed':
                            out_status, terminal_progress = promote_participating_nodes_done(
                                current_statuses, current_progress
                            )
                        else:
                            out_status = current_statuses
                            terminal_progress = build_workflow_complete_progress(
                                current_statuses, current_progress, user_status=user_status
                            )
                        payload = {
                            'node_status': out_status,
                            'node_progress': terminal_progress,
                            'workflow_complete': True,
                            'final_status': user_status
                        }
                        try:
                            yield f"data: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"
                        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as conn_err:
                            # Client disconnected, stop sending
                            logger.info(f"SSE client disconnected while sending completion for user {uid}: {conn_err}")
                            should_continue = False
                            break
                        except Exception as send_err:
                            # Other send errors - log and stop
                            logger.warning(f"SSE send error for completion message (user {uid}): {send_err}")
                            should_continue = False
                            break
                    except Exception as e:
                        logger.error(f"JSON serialization error in completion message: {e}", exc_info=e)
                        try:
                            yield f"data: {json.dumps({'error': f'Completion message serialization failed: {str(e)}'})}\n\n"
                        except Exception:
                            # If we can't send error, client probably disconnected
                            logger.info(f"SSE client disconnected while sending completion error for user {uid}")
                    should_continue = False
                    break

            # Wait before checking again: longer when nothing to send to avoid busy-loop and free the event loop.
            # Cut the wait short as soon as the run reaches a terminal status so the
            # completion frame is not held behind the progress cadence (see
            # TERMINAL_POLL_SEC).
            poll_deadline = time.monotonic() + (2 if not should_send else 1)
            while True:
                remaining = poll_deadline - time.monotonic()
                if remaining <= 0:
                    break
                await asyncio.sleep(min(TERMINAL_POLL_SEC, remaining))
                if uid and user_workflow_status.get(uid, {}).get('status') in (
                    'completed', 'error', 'cancelled'
                ):
                    break
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as conn_err:
            # Client disconnected - this is normal, just log and exit
            logger.info(f"SSE client disconnected for user {uid}: {conn_err}")
            should_continue = False
            break
        except Exception as e:
            logger.error(f"Error in generate_node_status_events: {e}", exc_info=e)
            try:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
            except Exception:
                # If we can't send error, client probably disconnected
                logger.info(f"SSE client disconnected while sending error for user {uid}")
            # Terminate on error
            should_continue = False
            break

# Workflow start/cancel/queue (imported late to avoid circular imports with this module)
from app.services.workflow.cancel import (  # noqa: E402
    stop_workflow_async,
)
from app.services.workflow.queue import (  # noqa: E402
    recalculate_all_queue_positions as _recalculate_all_queue_positions,
)
from app.services.workflow.start import start_workflow_from_frontend  # noqa: E402


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

    except Exception as e:
        logger.error(f"Error updating node progress: {e}", exc_info=e)

def get_node_progress():
    """
    Get current node progress data

    Returns:
        dict: Node progress data
    """
    if not hasattr(update_node_progress, 'node_progress'):
        update_node_progress.node_progress = {}
    return update_node_progress.node_progress.copy()


# --------------- ROI recommend viewport (from scripts/cell1b, no separate service) ---------------


@dataclass
class _PatchStats:
    px: int
    py: int
    N: int = 0
    sum_pt: float = 0.0
    sum_entropy: float = 0.0
    E: float = 0.0
    C: float = 0.0
    U: float = 0.0
    density: float = 0.0
    score: float = 0.0


@dataclass
class _PatchInfo:
    patch_id: int
    px: int
    py: int
    x: int
    y: int
    width: int
    height: int
    cell_count: int = 0
    target_prob_sum: float = 0.0
    score: float = 0.0


@dataclass
class _ROI:
    roi_id: str
    round: int
    polygon_level0_xy: List[Tuple[float, float]]
    covered_patches_py_px: List[Tuple[int, int]]
    patches: List[_PatchInfo] = field(default_factory=list)
    bbox: Dict[str, int] = field(default_factory=dict)
    score_summary: Dict[str, Any] = field(default_factory=dict)
    status: str = "RECOMMENDED"


@dataclass
class _WorkflowState:
    binding_value: str
    current_round: int = 0
    excluded_patch_mask: np.ndarray = None
    skip_until_round: Dict[Tuple[int, int], int] = field(default_factory=dict)
    history: List[Dict] = field(default_factory=list)


@dataclass
class _ROIConfig:
    slide_id: str = ""
    level: int = 0
    width_px: int = 0
    height_px: int = 0
    patch_size_px: int = 56
    connectivity: int = 8
    budget_max_patches_in_roi: int = 10
    selection_mode: str = "high_confidence"
    density_top_frac: float = 0.5
    selection_frac: float = 0.1
    use_score_ranking: bool = True
    use_u_in_score: bool = True
    u_p_low: int = 1
    u_p_high: int = 99
    cooldown_enabled: bool = True
    skip_rounds_M: int = 5
    polygon_simplify_tolerance_px: float = 28
    morphology_close_radius: int = 1
    fill_holes: bool = True
    remove_small_islands_min_patches: int = 3


# ROI-recommendation state, keyed by "<slide>|<level>|<patch_size>".
#
# Each entry holds excluded_patch_mask — a bool array the size of the slide's
# patch grid, so 0.15 MB at 256px patches on a 100k slide and 2.4 MB at 64px —
# plus a per-round history. Neither was ever evicted, so every slide the user
# ever asked for a recommendation on stayed resident for the life of the
# process. Bounded to the handful of slides anyone interleaves in practice;
# evicting a state only resets that slide's recommendation rounds.
_MAX_RECOMMEND_VIEWPORT_STATES = 8
_MAX_RECOMMEND_HISTORY = 200
_recommend_viewport_state_cache: "OrderedDict[str, Any]" = OrderedDict()


def _get_recommend_viewport_state(binding_value: str, factory):
    """Fetch or create the ROI state for a binding, keeping the cache bounded."""
    state = _recommend_viewport_state_cache.pop(binding_value, None)
    if state is None:
        state = factory()
    _recommend_viewport_state_cache[binding_value] = state
    while len(_recommend_viewport_state_cache) > _MAX_RECOMMEND_VIEWPORT_STATES:
        _recommend_viewport_state_cache.popitem(last=False)
    return state


def _roi_aggregate_patch_stats_from_arrays(
    centroids: np.ndarray,
    probs: np.ndarray,
    target_class: int,
    config: _ROIConfig,
    excluded_mask: np.ndarray,
    skip_until_round: Dict[Tuple[int, int], int],
    current_round: int,
    eps: float = 1e-12,
) -> Dict[Tuple[int, int], _PatchStats]:
    PATCH = config.patch_size_px
    grid_w = ceil(config.width_px / PATCH)
    grid_h = ceil(config.height_px / PATCH)
    n_cells = centroids.shape[0]
    px = np.floor(centroids[:, 0] / PATCH).astype(np.int32)
    py = np.floor(centroids[:, 1] / PATCH).astype(np.int32)
    valid_bounds = (px >= 0) & (px < grid_w) & (py >= 0) & (py < grid_h)
    valid_excluded = np.ones(n_cells, dtype=bool)
    valid_excluded[valid_bounds] = ~excluded_mask[py[valid_bounds], px[valid_bounds]]
    skip_mask = np.zeros((grid_h, grid_w), dtype=bool)
    if config.cooldown_enabled:
        for (py_key, px_key), until_round in skip_until_round.items():
            if 0 <= py_key < grid_h and 0 <= px_key < grid_w and current_round < until_round:
                skip_mask[py_key, px_key] = True
    valid_skip = np.ones(n_cells, dtype=bool)
    valid_skip[valid_bounds] = ~skip_mask[py[valid_bounds], px[valid_bounds]]
    valid = valid_bounds & valid_excluded & valid_skip
    H = -np.sum(probs * np.log(probs + eps), axis=1)
    patch_id = py * grid_w + px
    num_patches = grid_h * grid_w
    sum_pt = np.zeros(num_patches, dtype=np.float64)
    sum_entropy = np.zeros(num_patches, dtype=np.float64)
    count = np.zeros(num_patches, dtype=np.float64)
    np.add.at(sum_pt, patch_id[valid], probs[valid, target_class])
    np.add.at(sum_entropy, patch_id[valid], H[valid])
    np.add.at(count, patch_id[valid], 1.0)
    patch_stats: Dict[Tuple[int, int], _PatchStats] = {}
    for pid in np.where(count > 0)[0]:
        py_idx = int(pid // grid_w)
        px_idx = int(pid % grid_w)
        patch_stats[(px_idx, py_idx)] = _PatchStats(
            px=px_idx, py=py_idx,
            N=int(count[pid]), sum_pt=float(sum_pt[pid]), sum_entropy=float(sum_entropy[pid]),
        )
    return patch_stats


def _roi_compute_metrics_per_patch(
    patch_stats: Dict[Tuple[int, int], _PatchStats],
    config: _ROIConfig,
) -> List[_PatchStats]:
    PATCH = config.patch_size_px
    patch_area = PATCH * PATCH
    patch_list = []
    for (px, py), st in patch_stats.items():
        st.E = st.sum_pt
        st.C = st.E / max(st.N, 1)
        st.U = st.sum_entropy / max(st.N, 1)
        st.density = st.E / patch_area
        patch_list.append(st)
    return patch_list


def _roi_normalize_u_and_score(patch_list: List[_PatchStats], config: _ROIConfig) -> List[_PatchStats]:
    if not patch_list:
        return patch_list
    if config.use_u_in_score:
        U_values = [p.U for p in patch_list]
        u_min = np.percentile(U_values, config.u_p_low)
        u_max = np.percentile(U_values, config.u_p_high)
        eps = 1e-12
        def _norm_u(U):
            return np.clip((U - u_min) / (u_max - u_min + eps), 0, 1)
        for p in patch_list:
            norm_u = _norm_u(p.U)
            if config.selection_mode == "low_confidence":
                p.score = (p.E * 0.5 + p.N * 0.5) * log1p(p.N) * (0.2 + norm_u)
            else:
                p.score = (p.E * p.C) * log1p(p.N) * (1 - norm_u)
    else:
        for p in patch_list:
            if config.selection_mode == "low_confidence":
                p.score = (p.E * 0.5 + p.N * 0.5) * log1p(p.N) * (0.2 + p.U)
            else:
                p.score = (p.E * p.C) * log1p(p.N)
    return patch_list


def _roi_density_constraint_filter(patch_list: List[_PatchStats], config: _ROIConfig) -> List[_PatchStats]:
    if not patch_list:
        return []
    sorted_by_density = sorted(patch_list, key=lambda p: p.density, reverse=True)
    K = max(1, floor(len(sorted_by_density) * config.density_top_frac))
    return sorted_by_density[:K]


def _roi_confidence_filter(
    density_candidates: List[_PatchStats],
    config: _ROIConfig,
) -> List[_PatchStats]:
    if not density_candidates:
        return []
    if config.use_score_ranking:
        sorted_list = sorted(density_candidates, key=lambda p: p.score, reverse=True)
    else:
        sorted_list = sorted(density_candidates, key=lambda p: p.U, reverse=(config.selection_mode == "low_confidence"))
    K = max(1, floor(len(sorted_list) * config.selection_frac))
    return sorted_list[:K]


def _roi_build_connected_components(
    chosen: List[_PatchStats],
    config: _ROIConfig,
) -> Tuple[np.ndarray, np.ndarray, int]:
    PATCH = config.patch_size_px
    grid_w = ceil(config.width_px / PATCH)
    grid_h = ceil(config.height_px / PATCH)
    mask = np.zeros((grid_h, grid_w), dtype=np.uint8)
    for p in chosen:
        if 0 <= p.py < grid_h and 0 <= p.px < grid_w:
            mask[p.py, p.px] = 1
    structure = np.ones((3, 3), dtype=np.uint8) if config.connectivity == 8 else np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=np.uint8)
    labeled, num_features = ndimage.label(mask, structure=structure)
    return mask, labeled, num_features


def _roi_choose_best_component(
    labeled: np.ndarray,
    num_features: int,
    patch_stats: Dict[Tuple[int, int], _PatchStats],
    config: _ROIConfig,
) -> List[Tuple[int, int]]:
    if num_features == 0:
        return []
    metric_map = {(p.px, p.py): p for p in patch_stats.values()}
    best_comp = []
    best_value = float("-inf")
    for comp_id in range(1, num_features + 1):
        comp_coords = np.argwhere(labeled == comp_id)
        comp_patches = [(int(py), int(px)) for py, px in comp_coords]
        if len(comp_patches) > config.budget_max_patches_in_roi:
            scored = [((py, px), metric_map.get((px, py), _PatchStats(px=px, py=py)).score) for (py, px) in comp_patches]
            scored.sort(key=lambda x: x[1], reverse=True)
            comp_patches = [x[0] for x in scored[: config.budget_max_patches_in_roi]]
        total_score = sum(metric_map.get((px, py), _PatchStats(px=px, py=py)).score for (py, px) in comp_patches)
        if total_score > best_value:
            best_value = total_score
            best_comp = comp_patches
    return best_comp


def _roi_component_to_polygon(
    best_comp: List[Tuple[int, int]],
    config: _ROIConfig,
    patch_stats: Dict[Tuple[int, int], _PatchStats],
) -> Tuple[List[Tuple[float, float]], List[_PatchInfo], Dict[str, int], Dict[str, Any]]:
    if not best_comp:
        return [], [], {}, {}
    PATCH = config.patch_size_px
    grid_w = ceil(config.width_px / PATCH)
    grid_h = ceil(config.height_px / PATCH)
    comp_mask = np.zeros((grid_h, grid_w), dtype=np.uint8)
    for (py, px) in best_comp:
        if 0 <= py < grid_h and 0 <= px < grid_w:
            comp_mask[py, px] = 1
    if config.morphology_close_radius > 0:
        comp_mask = binary_close(comp_mask, config.morphology_close_radius).astype(np.uint8)
    if config.fill_holes:
        comp_mask = ndimage.binary_fill_holes(comp_mask).astype(np.uint8)
    if config.remove_small_islands_min_patches > 0:
        labeled, num = ndimage.label(comp_mask)
        for i in range(1, num + 1):
            if np.sum(labeled == i) < config.remove_small_islands_min_patches:
                comp_mask[labeled == i] = 0
    # The region is a union of whole patches, so its outline is exact: walk the
    # patch boundaries instead of rasterising, tracing the raster and then
    # smoothing the staircase back. Nothing here needs a simplify tolerance —
    # the configured one is half a patch, which only ever merged collinear
    # points, and that is now done exactly.
    component = largest_component(comp_mask)
    if component is None:
        return [], [], {}, {}
    polygon = [(float(x * PATCH), float(y * PATCH)) for x, y in cell_outline(component)]
    metric_map = {(p.px, p.py): p for p in patch_stats.values()}
    patches_info = []
    total_score = 0.0
    total_E = 0.0
    total_cells = 0
    all_x, all_y = [], []
    for idx, (py, px) in enumerate(best_comp):
        x_level0 = px * PATCH
        y_level0 = py * PATCH
        all_x.append(x_level0)
        all_y.append(y_level0)
        st = metric_map.get((px, py), None)
        cell_count = st.N if st else 0
        target_prob_sum = st.E if st else 0.0
        score = st.score if st else 0.0
        patches_info.append(
            _PatchInfo(patch_id=idx, px=px, py=py, x=x_level0, y=y_level0, width=PATCH, height=PATCH,
                       cell_count=cell_count, target_prob_sum=target_prob_sum, score=score)
        )
        total_score += score
        total_E += target_prob_sum
        total_cells += cell_count
    patches_info.sort(key=lambda p: p.score, reverse=True)
    for idx, p in enumerate(patches_info):
        p.patch_id = idx
    bbox = {}
    if all_x and all_y:
        bbox = {"x": int(min(all_x)), "y": int(min(all_y)), "width": int(max(all_x) + PATCH - min(all_x)), "height": int(max(all_y) + PATCH - min(all_y))}
    score_summary = {"total_score": total_score, "num_patches": len(best_comp), "total_cells": total_cells,
                     "expected_target_cells_E_sum": total_E, "avg_score_per_patch": total_score / len(best_comp) if best_comp else 0}
    return polygon, patches_info, bbox, score_summary


def _roi_recommend_next(
    centroids: np.ndarray,
    probs: np.ndarray,
    target_class: int,
    config: _ROIConfig,
    state: _WorkflowState,
) -> Optional[_ROI]:
    patch_stats = _roi_aggregate_patch_stats_from_arrays(
        centroids, probs, target_class, config,
        state.excluded_patch_mask, state.skip_until_round, state.current_round,
    )
    if not patch_stats:
        return None
    patch_list = _roi_compute_metrics_per_patch(patch_stats, config)
    patch_list = _roi_normalize_u_and_score(patch_list, config)
    density_candidates = _roi_density_constraint_filter(patch_list, config)
    chosen = _roi_confidence_filter(density_candidates, config)
    if not chosen:
        return None
    mask, labeled, num_features = _roi_build_connected_components(chosen, config)
    if num_features == 0:
        return None
    best_comp = _roi_choose_best_component(labeled, num_features, patch_stats, config)
    polygon, patches_info, bbox, score_summary = _roi_component_to_polygon(best_comp, config, patch_stats)
    if not polygon:
        return None
    return _ROI(
        roi_id=str(uuid.uuid4()),
        round=state.current_round,
        polygon_level0_xy=polygon,
        covered_patches_py_px=best_comp,
        patches=patches_info,
        bbox=bbox,
        score_summary=score_summary,
        status="RECOMMENDED",
    )


def _roi_apply_feedback(state: _WorkflowState, roi: _ROI, feedback: str, config: _ROIConfig) -> None:
    roi.status = feedback
    state.history.append({"round": roi.round, "roi_id": roi.roi_id, "polygon_level0_xy": roi.polygon_level0_xy, "status": feedback, "score_summary": roi.score_summary})
    # One entry per round, each carrying a polygon — keep only the recent tail.
    if len(state.history) > _MAX_RECOMMEND_HISTORY:
        del state.history[: len(state.history) - _MAX_RECOMMEND_HISTORY]
    covered = roi.covered_patches_py_px
    if feedback == "ANNOTATED":
        for (py, px) in covered:
            if 0 <= py < state.excluded_patch_mask.shape[0] and 0 <= px < state.excluded_patch_mask.shape[1]:
                state.excluded_patch_mask[py, px] = True
            if (py, px) in state.skip_until_round:
                del state.skip_until_round[(py, px)]
    elif feedback == "SKIPPED" and config.cooldown_enabled:
        for (py, px) in covered:
            current_skip = state.skip_until_round.get((py, px), 0)
            new_skip = state.current_round + config.skip_rounds_M
            state.skip_until_round[(py, px)] = max(current_skip, new_skip)


def recommend_viewport(
    zarr_path: str,
    target_class: int = 0,
    selection_mode: str = "high_confidence",
) -> Dict[str, Any]:
    """
    Recommend next ROI viewport from zarr (centroids + ClassificationNode nuclei_class_probabilities).
    No dependency on seg_service; used by tasks router only.
    Returns bbox in level0 pixels { x, y, width, height } for frontend fitBounds.
    """
    if not zarr_path or not os.path.exists(zarr_path):
        return {"bbox": None, "message": "Zarr file not found or path empty", "round": 0}
    try:
        with open_zarr_cm(zarr_path, "r") as zf:
            seg_group = find_segmentation_group(zf)
            if seg_group is None or "centroids" not in seg_group:
                return {"bbox": None, "message": "No centroids in zarr", "round": 0}
            centroids = np.array(seg_group["centroids"][:], dtype=np.float64)
            classification_group = zf.get(ZarrGroups.CELL_CLASSIFICATION)
            if classification_group is None or ZarrDatasets.PROBABILITIES not in classification_group:
                return {"bbox": None, "message": "No nuclei classification probabilities in zarr", "round": 0}
            probs = np.array(classification_group[ZarrDatasets.PROBABILITIES][:], dtype=np.float64)
        n_cells = len(centroids)
        n_probs = probs.shape[0] if probs.ndim >= 1 else 0
        if n_probs < n_cells:
            return {"bbox": None, "message": "Probability array shorter than centroids", "round": 0}
        if probs.ndim == 1:
            probs = probs.reshape(-1, 1)
        probs = np.clip(probs, 1e-12, 1.0)
        n_classes = probs.shape[1]
        if target_class < 0 or target_class >= n_classes:
            target_class = 0
        margin = 2 * 56
        width_px = int(float(np.max(centroids[:, 0])) + margin) if n_cells > 0 else 10000
        height_px = int(float(np.max(centroids[:, 1])) + margin) if n_cells > 0 else 10000
        slide_id = zarr_path.replace("|", "_")
        config = _ROIConfig(
            slide_id=slide_id, level=0, width_px=width_px, height_px=height_px,
            patch_size_px=56, connectivity=8, budget_max_patches_in_roi=50,
            selection_mode=selection_mode, density_top_frac=0.5, selection_frac=0.1,
            use_score_ranking=True, use_u_in_score=True, u_p_low=1, u_p_high=99,
            cooldown_enabled=True, skip_rounds_M=5, polygon_simplify_tolerance_px=28,
            morphology_close_radius=1, fill_holes=True, remove_small_islands_min_patches=3,
        )
        binding_value = f"{config.slide_id}|{config.level}|{config.patch_size_px}"
        grid_w = ceil(config.width_px / config.patch_size_px)
        grid_h = ceil(config.height_px / config.patch_size_px)
        state = _get_recommend_viewport_state(
            binding_value,
            lambda: _WorkflowState(
                binding_value=binding_value,
                excluded_patch_mask=np.zeros((grid_h, grid_w), dtype=bool),
                skip_until_round={},
            ),
        )
        roi = _roi_recommend_next(centroids, probs, target_class, config, state)
        if roi is None:
            return {"bbox": None, "message": "No ROI recommended", "round": state.current_round}
        bbox = roi.bbox
        _roi_apply_feedback(state, roi, "SKIPPED", config)
        state.current_round += 1
        return {"bbox": bbox, "polygon_level0_xy": getattr(roi, "polygon_level0_xy", None), "round": roi.round, "message": "ok"}
    except Exception as e:
        logger.warning("[recommend_viewport] %s", e)
        return {"bbox": None, "message": str(e), "round": 0}


# ==================== API support helpers (moved from app.api.tasks) ====================
try:
    import h5py
except ImportError:
    h5py = None


def _generate_simple_summary(question: str, answer: str) -> str:
    """
    Generate a simple local summary when Control Service is unavailable.
    This is a fallback mechanism to ensure the feature works even when Ctrl-Service fails.
    
    Args:
        question: The original question
        answer: The raw answer data (can be string or JSON string)
    
    Returns:
        A simple summary string
    """
    try:
        # Try to parse answer as JSON
        try:
            answer_data = json.loads(answer) if isinstance(answer, str) else answer
            if isinstance(answer_data, dict):
                # Extract key information from JSON
                summary_parts = []
                
                # Check for common result fields
                if "result" in answer_data:
                    summary_parts.append(f"Result: {answer_data['result']}")
                if "output_path" in answer_data:
                    summary_parts.append(f"Output saved to: {answer_data['output_path']}")
                if "count" in answer_data:
                    summary_parts.append(f"Count: {answer_data['count']}")
                if "percentage" in answer_data:
                    summary_parts.append(f"Percentage: {answer_data['percentage']}%")
                
                # If we have specific fields, use them
                if summary_parts:
                    return ". ".join(summary_parts) + "."
                
                # Otherwise, summarize the keys
                keys = list(answer_data.keys())[:3]  # First 3 keys
                return f"Analysis completed. Key results: {', '.join(keys)}."
            elif isinstance(answer_data, (list, tuple)):
                return f"Analysis completed. Found {len(answer_data)} items."
            elif isinstance(answer_data, (int, float)):
                return f"Analysis result: {answer_data}."
            elif isinstance(answer_data, str):
                # Already a string, use it directly if short
                if len(answer_data) < 200:
                    return answer_data
                return answer_data[:200] + "..."
        except (json.JSONDecodeError, TypeError):
            # Not JSON, treat as plain string
            pass
        
        # Fallback: use answer directly if it's a reasonable string
        if isinstance(answer, str):
            if len(answer) == 0:
                # Empty string - return generic message
                return f"Analysis completed. {question}"
            if len(answer) < 300:
                return answer
            # For long strings, try to extract first sentence or first 200 chars
            first_sentence = answer.split('.')[0] if '.' in answer else answer[:200]
            return first_sentence + ("..." if len(answer) > 200 else "")
        
        # Last resort: generic message
        return f"Analysis completed. {question}"
    except Exception as e:
        # If all else fails, return a generic message
        logger.warning(f"[_generate_simple_summary] Error generating summary: {e}")
        return f"Analysis completed. (Summary generation failed: {str(e)})"


def process_node(name, obj):
    """
    Recursively process groups and datasets in the Zarr file.
    
    :param name: The name of the current group or dataset.
    :param obj: The current Zarr object (Group or Array).
    :return: A dictionary representing the structure of the current group or dataset.
    """
    if isinstance(obj, zarr.Group):
        return {
            "type": "Group",
            "name": name,
            # members(), not items(): a zarr v3 Group has no items(), so this
            # walk raised AttributeError for every store. The one caller that
            # matters catches and logs it, so script generation had been going
            # out with no zarr structure at all rather than failing loudly.
            "children": {
                key: process_node(key, item)
                for key, item in obj.members()
            }
        }
    elif isinstance(obj, zarr.Array):
        # Convert shape tuple to list for JSON serialization
        shape_list = list(obj.shape) if obj.shape else []
        dataset_info = {
            "type": "Dataset",
            "name": name,
            "shape": shape_list,
            "dtype": str(obj.dtype)
        }

        # Add attributes if available (without reading data)
        if hasattr(obj, 'attrs') and obj.attrs:
            try:
                dataset_info["attributes"] = dict(obj.attrs)
            except Exception:
                pass

        # Calculate array size in bytes to determine if we should read it
        # Only read small arrays (< 1MB estimated) to avoid memory issues
        MAX_ARRAY_SIZE_BYTES = 1024 * 1024  # 1MB threshold
        
        try:
            # Try to get nbytes directly (available in zarr 2.10+), else calculate from shape and dtype
            array_size_bytes = getattr(obj, "nbytes", None)
            if array_size_bytes is None:
                dtype_obj = np.dtype(obj.dtype)
                array_size_bytes = int(np.prod(obj.shape)) * dtype_obj.itemsize
            
            # Only read array data if it's small enough
            if array_size_bytes == 0:
                # Explicitly handle empty arrays
                dataset_info["content_type"] = "Empty array (0 bytes)"
                dataset_info["note"] = "Array is empty; no data to load"
                return dataset_info
            elif array_size_bytes <= MAX_ARRAY_SIZE_BYTES:
                try:
                    raw_data = obj[()]
                except Exception as e:
                    # Even small arrays might fail to read (e.g., corrupted chunks)
                    dataset_info["content_type"] = f"Array metadata only (read failed: {str(e)})"
                    dataset_info["note"] = "Could not read array data, showing metadata only"
                    return dataset_info
            else:
                # Large array - only include metadata without reading data
                dataset_info["content_type"] = f"Large array ({array_size_bytes / (1024*1024):.2f} MB) - data not loaded"
                dataset_info["note"] = "Array too large to load into memory for structure inspection"
                return dataset_info
            
            # Process small arrays that were loaded
            if isinstance(raw_data, bytes):
                try:
                    decoded_str = raw_data.decode('utf-8')
                    json_data = json.loads(decoded_str)
                except UnicodeDecodeError:
                    dataset_info["content_type"] = "Binary data (not UTF-8)"
                    return dataset_info
                except json.JSONDecodeError:
                    dataset_info["content_type"] = "UTF-8 encoded string (not JSON)"
                    return dataset_info
                except Exception as e:
                    dataset_info["content_type"] = f"Error decoding/parsing bytes: {str(e)}"
                    return dataset_info

                # If we got here, JSON parsing succeeded - now extract structure
                def get_structure(data, max_depth=3, current_depth=0):
                    """
                    Recursively extract structure from JSON data with depth limiting.
                    
                    Args:
                        data: The JSON data to analyze
                        max_depth: Maximum recursion depth (default allows initial call without specifying)
                        current_depth: Current recursion depth (tracked internally)
                    """
                    if current_depth >= max_depth:
                        return f"Type: {type(data).__name__} (max depth reached)"
                    
                    if isinstance(data, dict):
                        total_length = len(data)
                        if total_length > 20:
                            # Take only first item as sample
                            first_key, first_value = next(iter(data.items()))
                            return {
                                "sample": {
                                    first_key: get_structure(first_value, max_depth, current_depth + 1)
                                },
                                "total_length": total_length,
                                "value_type": type(first_value).__name__
                            }
                        return {
                            k: get_structure(v, max_depth, current_depth + 1)
                            for k, v in data.items()
                        }
                    elif isinstance(data, list):
                        def get_array_shape(arr):
                            shape = [len(arr)]
                            if shape[0] > 0 and isinstance(arr[0], list):
                                shape.extend(get_array_shape(arr[0]))
                            return shape

                        if len(data) > 0:
                            shape = get_array_shape(data)
                            def get_deepest_type(arr):
                                if isinstance(arr, list) and len(arr) > 0:
                                    return get_deepest_type(arr[0])
                                return type(arr).__name__
                            element_type = get_deepest_type(data)
                            return f"Array{shape} of {element_type}"
                        return "Empty Array"
                    else:
                        return f"Type: {type(data).__name__}"

                try:
                    dataset_info["structure"] = get_structure(json_data)
                except Exception as e:
                    dataset_info["content_type"] = f"JSON structure extraction failed: {str(e)}"
                    dataset_info["note"] = "Data is valid JSON but structure extraction encountered an error"
            elif isinstance(raw_data, (int, float)):
                dataset_info["content_type"] = f"Scalar {type(raw_data).__name__}"
            elif isinstance(raw_data, np.ndarray):
                dataset_info["content_type"] = f"Array of {raw_data.dtype}"

                if raw_data.ndim == 1 and len(raw_data) < 10:
                    # For short 1D arrays, include the actual values
                    # Handle special data types to ensure JSON serializability
                    try:
                        if np.issubdtype(raw_data.dtype, np.integer):
                            dataset_info["values"] = [int(x) for x in raw_data]
                        elif np.issubdtype(raw_data.dtype, np.floating):
                            dataset_info["values"] = [float(x) for x in raw_data]
                        elif np.issubdtype(raw_data.dtype, np.bool_):
                            dataset_info["values"] = [bool(x) for x in raw_data]
                        elif np.issubdtype(raw_data.dtype, np.character):
                            dataset_info["values"] = [str(x) for x in raw_data]
                        else:
                            # For complex types, convert to string representation
                            dataset_info["values"] = [str(x) for x in raw_data]
                    except Exception as e:
                        dataset_info["values_error"] = f"Could not serialize values: {str(e)}"
            else:
                dataset_info["content_type"] = str(type(raw_data).__name__)
        except Exception as e:
            dataset_info["content_type"] = f"Unknown (error: {str(e)})"

        return dataset_info


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


def _process_node_h5(name: str, obj) -> Dict[str, Any]:
    """
    Recursively process groups and datasets in an HDF5 file.
    Returns a structure compatible with the Zarr process_node format for downstream use.
    """
    if h5py is None:
        raise RuntimeError("h5py is not installed")
    if isinstance(obj, h5py.Group):
        return {
            "type": "Group",
            "name": name,
            "children": {
                key: _process_node_h5(key, item)
                for key, item in obj.items()
            }
        }
    elif isinstance(obj, h5py.Dataset):
        shape_list = list(obj.shape) if obj.shape else []
        dataset_info = {
            "type": "Dataset",
            "name": name,
            "shape": shape_list,
            "dtype": str(obj.dtype)
        }
        if hasattr(obj, "attrs") and obj.attrs:
            try:
                dataset_info["attributes"] = dict(obj.attrs)
            except Exception:
                pass
        return dataset_info
    return {"type": "unknown", "name": name}



def get_log_tail_service(path, model_name, n: int = 200) -> Dict[str, Any]:
    """Return {'path', 'tail'} for a tasknode log file (last n lines).

    For remote nodes, fetches from the remote node's logs API. Raises ValueError (422),
    FileNotFoundError (404) or PermissionError (403) on bad input; RuntimeError on remote
    fetch failure.
    """
    # Check if model_name corresponds to a remote node
    if model_name:
        from app.utils.workflow.register import CUSTOM_NODE_SERVICE_REGISTRY
        for registry_key, info in CUSTOM_NODE_SERVICE_REGISTRY.items():
            is_remote_flag = info.get("is_remote")
            remote_host = info.get("remote_host")
            if info.get("model_name") == model_name and (is_remote_flag is True and remote_host):
                remote_host = info["remote_host"]
                port = info["port"]
                remote_url = f"http://{remote_host}:{port}/logs"
                try:
                    response = requests.get(remote_url, params={"lines": n}, timeout=10)
                    response.raise_for_status()
                    remote_data = response.json()
                    return {
                        "path": remote_data.get("log_file", f"remote://{remote_host}:{port}"),
                        "tail": remote_data.get("content", ""),
                    }
                except requests.RequestException as e:
                    raise RuntimeError(f"Failed to fetch logs from remote node: {str(e)}")

    # Local node: read from local file system
    from app.config.path_config import SERVICE_STORAGE_DIR
    base_dir = os.path.join(SERVICE_STORAGE_DIR, "tasknode_logs")
    target = None
    if path:
        target = os.path.abspath(path)
    elif model_name:
        # Resolve model_name to latest matching log file under tasknode_logs
        safe = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in model_name)
        if not safe:
            raise ValueError("model_name yields empty safe name")
        candidates = []
        for root, _dirs, files in os.walk(base_dir):
            for f in files:
                if f.endswith(".log") and safe.lower() in f.lower():
                    candidates.append(os.path.join(root, f))
        if not candidates:
            raise FileNotFoundError("Log file not found for model_name")
        target = max(candidates, key=lambda p: os.path.getmtime(p))
    else:
        raise ValueError("Either path or model_name is required")
    if not target.startswith(base_dir):
        raise PermissionError("Forbidden path")
    if not os.path.exists(target):
        raise FileNotFoundError("Log file not found")

    # Read last n lines efficiently for small and large files
    max_n = 1000
    n = max(1, min(int(n or 200), max_n))
    with open(target, 'rb') as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        if size <= 128 * 1024:
            f.seek(0)
            raw = f.read()
            parts = raw.decode('utf-8', errors='ignore').splitlines()
            text = "\n".join(parts[-n:])
        else:
            # Read blocks from the end until we have enough newlines
            block_size = 4096
            buffer = bytearray()
            lines_found = 0
            pos = size
            while pos > 0 and lines_found <= n:
                read_size = block_size if pos >= block_size else pos
                pos -= read_size
                f.seek(pos)
                chunk = f.read(read_size)
                buffer[:0] = chunk
                lines_found += chunk.count(b"\n")
            parts = bytes(buffer).decode('utf-8', errors='ignore').splitlines()
            text = "\n".join(parts[-n:])
    return {"path": target, "tail": text}
