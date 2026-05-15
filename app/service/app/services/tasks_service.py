from collections import defaultdict
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
import shutil
from typing import Dict, Optional, List, Tuple, Any
from dataclasses import dataclass, field
from math import ceil, floor, log1p
import uuid
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
from app.config.zarr_config import ZarrGroups, ZarrDatasets, find_segmentation_group
import cv2
from scipy import ndimage

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
        with zarr.open(p, "r") as zf:
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
        from app.services.data import get_zarr_synchronizer

        sync = get_zarr_synchronizer(p)
        with zarr.open(p, "a", synchronizer=sync) as zf:
            grp = zf.require_group(_CODING_GEN_CACHE_GROUP)
            for key in (_CODING_GEN_CACHE_PROMPT_SHA, _CODING_GEN_CACHE_SCRIPT):
                if key in grp:
                    del grp[key]
            grp.create_dataset(_CODING_GEN_CACHE_PROMPT_SHA, data=prompt_sha256.encode("utf-8"))
            grp.create_dataset(_CODING_GEN_CACHE_SCRIPT, data=script.encode("utf-8"))
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


def write_node_userdata_to_zarr(zarr_path: str, node_name: str, param_dict: dict) -> None:
    """
    Write a single node's params to zarr {zarr_group}/userData. Call this right before
    the node executes so the node sees its own params and we avoid overwriting another
    node's userData (when they share the same zarr_group e.g. MuskNode).
    """
    if param_dict is None:
        param_dict = {}
    from app.services.data import get_zarr_synchronizer
    nodes_meta = model_store.get_nodes_extended()
    node_meta = nodes_meta.get(node_name, {}) if isinstance(nodes_meta, dict) else {}
    zarr_group = node_meta.get("zarr_group") or node_name
    if zarr_group in ("MuskClassification", "MuskEmbedding"):
        zarr_group = "MuskNode"
    runtime = node_meta.get("runtime", {}) if isinstance(node_meta, dict) else {}
    is_remote = runtime.get("is_remote") is True if isinstance(runtime, dict) else False
    remote_host = runtime.get("remote_host") if is_remote and isinstance(runtime, dict) else None
    mnt_path = runtime.get("mnt_path") if is_remote and isinstance(runtime, dict) else None
    if is_remote and remote_host and mnt_path:
        param_dict = manager._convert_paths_in_data(param_dict.copy(), node_name)
    user_data_path = f"{zarr_group}/userData"
    synchronizer = get_zarr_synchronizer(zarr_path)
    with zarr.open(zarr_path, "a", synchronizer=synchronizer) as zf:
        zf.require_group(zarr_group)
        node_group = zf.require_group(user_data_path)
        _overwrite_node_user_data(node_group)
        for k, v in param_dict.items():
            if isinstance(v, (str, int, float, bool)):
                node_group.create_dataset(k, data=str(v).encode("utf-8"))
            else:
                node_group.create_dataset(k, data=json.dumps(v, ensure_ascii=False).encode("utf-8"))
        if not param_dict:
            node_group.create_dataset("_params_written", data=b"1")
    logger.info(f"[userData written before run] zarr_path={zarr_path} node={node_name} group={user_data_path} keys={list(param_dict.keys())}")


# Global variables
workflow_run_status = {}
node_execution_status = {}
current_zarr_path = None
# DEPRECATED: is_generating and cur_answer are now stored per-user in user_workflow_status
# Kept for backward compatibility with legacy run_workflow_in_background function
is_generating = False
cur_answer = None
last_node_status_snapshot: Dict[str, int] = {}

# Queue management for multi-user support
# Queue system for workflow execution
workflow_queue = asyncio.Queue()
queue_processing = False
user_workflow_status: Dict[str, Dict] = defaultdict(dict)  # uid -> {status, position, wf_id, node_status, node_progress}
user_workflow_managers: Dict[str, TaskNodeManager] = {}  # uid -> TaskNodeManager instance


async def _consume_script_generation_stream(
    gen_payload: dict,
    session_headers: dict,
    base_agent_url: str,
    uid: str,
) -> dict:
    """POST Ctrl process_script_stream (SSE); mirror raw deltas into cur_answer for polling UI."""
    stream_url = f"{base_agent_url}/agent/v1/process_script_stream"
    accumulated: list[str] = []
    user_workflow_status[uid]["cur_answer"] = ""
    async with aiohttp.ClientSession() as session:
        async with session.post(
            stream_url,
            json=gen_payload,
            headers=session_headers,
            timeout=aiohttp.ClientTimeout(total=600),
        ) as gen_resp:
            gen_resp.raise_for_status()
            while True:
                line_b = await gen_resp.content.readline()
                if not line_b:
                    break
                line = line_b.decode("utf-8", errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                payload_str = line[5:].strip()
                try:
                    evt = json.loads(payload_str)
                except json.JSONDecodeError:
                    continue
                if isinstance(evt.get("delta"), str) and evt["delta"]:
                    accumulated.append(evt["delta"])
                    user_workflow_status[uid]["cur_answer"] = "".join(accumulated)
                if evt.get("error"):
                    return {"error": str(evt["error"])}
                if evt.get("done"):
                    code = evt.get("code")
                    if not isinstance(code, str):
                        code = ""
                    return {"generated_script": code}
    return {"error": "Script stream ended without completion"}


async def _generate_script_output(
    script_prompt: str,
    zarr_path: str,
    auth_header: str | None = None,
    uid: str | None = None,
) -> dict:
    """Generate script preview via Control Service (SSE stream when uid is set)."""
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

    headers = {'Content-Type': 'application/json'}
    session_headers = dict(headers)
    if auth_header:
        session_headers["Authorization"] = auth_header

    base_agent_url = settings.CTRL_SERVICE_API_ENDPOINT.rstrip("/")
    logger.info(f"[CodingAgent] Calling agent service at {base_agent_url}/agent/v1/process_script")

    structure = None
    structure_json = None
    try:
        # Get Zarr structure using the new tasks endpoint
        if os.path.exists(resolved_zarr_path):
            # Import the function from tasks API module
            from app.api.tasks import process_node
            with zarr.open(resolved_zarr_path, 'r') as zarr_file:
                structure = process_node("/", zarr_file)
                structure_json = json.dumps(structure, indent=2)
                logger.info(f"[CodingAgent] Successfully fetched Zarr structure")
        else:
            logger.warning(f"[CodingAgent] Zarr file not found: {resolved_zarr_path}")
    except Exception as struct_err:
        logger.warning(f"[CodingAgent] Failed to fetch local Zarr structure for script preview: {struct_err}")

    combined_prompt = (
        f"{prompt_text}\n\nZarr structure:\n{structure_json}"
        if structure_json else prompt_text
    )

    gen_payload = {
        "agent_id": "default_agent",
        "prompt": combined_prompt,
        "parameters": {},
    }
    if structure is not None:
        gen_payload["data_context"] = {
            "zarr_structure": structure,
            "zarr_path": zarr_path,
        }

    async def _post_process_script_sync() -> dict:
        async with aiohttp.ClientSession() as session:
            gen_url = f"{base_agent_url}/agent/v1/process_script"
            async with session.post(gen_url, json=gen_payload, headers=session_headers, timeout=300) as gen_resp:
                gen_resp.raise_for_status()
                gen_text = await gen_resp.text()
                try:
                    gen_data = json.loads(gen_text)
                    if gen_data.get("code") == 0:
                        logger.info(f"[CodingAgent] Successfully generated script")
                        return {"generated_script": gen_data.get("data", "")}
                    error_msg = gen_data.get("message", "Agent returned error")
                    logger.error(f"[CodingAgent] Agent returned error: {error_msg}")
                    return {"error": error_msg}
                except json.JSONDecodeError as json_err:
                    error_msg = f"Failed to parse generation response: {str(json_err)}"
                    logger.error(f"[CodingAgent] {error_msg}")
                    return {"error": error_msg}

    if uid:
        try:
            stream_result = await _consume_script_generation_stream(
                gen_payload, session_headers, base_agent_url, uid
            )
            if isinstance(stream_result, dict) and "generated_script" in stream_result:
                return stream_result
            if isinstance(stream_result, dict) and stream_result.get("error"):
                logger.warning(
                    f"[CodingAgent] Stream returned error, falling back to process_script: {stream_result.get('error')}"
                )
        except aiohttp.ClientResponseError as cre:
            logger.warning(f"[CodingAgent] Script stream HTTP {cre.status}, falling back: {cre}")
        except Exception as stream_exc:
            logger.warning(f"[CodingAgent] Script stream failed, falling back: {stream_exc}")

    try:
        return await _post_process_script_sync()
    except Exception as e:
        error_msg = str(e)
        logger.error(f"[CodingAgent] Exception during agent service call: {error_msg}")
        logger.error(traceback.format_exc())
        return {"error": error_msg}

async def process_workflow_queue():
    """Background task to process workflow queue"""
    global queue_processing
    queue_processing = True
    
    while True:
        try:
            # Get next workflow from queue
            workflow_item = await workflow_queue.get()
            uid = workflow_item['uid']
            wf_id = workflow_item['wf_id']
            node_inputs = workflow_item['node_inputs']
            script_prompt = workflow_item['script_prompt']
            zarr_path = workflow_item['zarr_path']
            auth_header = workflow_item.get('auth_header')
            
            logger.info(f"  Processing workflow {wf_id} for user {uid}")
            print(f"[DEBUG process_workflow_queue] Processing wf_id={wf_id} for user {uid}, nodes={list(node_inputs.keys())}")

            # Update status to running
            user_workflow_status[uid]['status'] = 'running'

            # Execute workflow using global manager (with queue serialization)
            print(f"[DEBUG process_workflow_queue] About to call run_workflow_for_user")
            await run_workflow_for_user(uid, wf_id, node_inputs, script_prompt, zarr_path, manager, auth_header=auth_header)
            print(f"[DEBUG process_workflow_queue] run_workflow_for_user completed")
            
            # Mark queue item as done
            workflow_queue.task_done()
            
        except Exception as e:
            logger.error(f"Error processing workflow queue: {e}")
            if 'uid' in locals():
                user_workflow_status[uid]['status'] = 'error'
                user_workflow_status[uid]['error'] = str(e)

async def run_workflow_for_user(uid: str, wf_id: int, node_inputs: dict, script_prompt: str, zarr_path: str, user_manager: TaskNodeManager, auth_header: str | None = None):
    """Execute workflow for a specific user"""
    logger.info(f"  run_workflow_for_user called for user {uid}, workflow {wf_id}")
    print(f"[DEBUG run_workflow_for_user] Starting workflow for user {uid}, wf_id={wf_id}, nodes={list(node_inputs.keys())}")
    try:
        # Update status to running
        user_workflow_status[uid]['status'] = 'running'
        user_workflow_status[uid]['is_generating'] = True
        user_workflow_status[uid]['cur_answer'] = None
        
        # Initialize user-specific status tracking
        user_workflow_status[uid]['node_status'] = {}
        user_workflow_status[uid]['node_progress'] = {}
        script_requested = bool(script_prompt)

        # Initialize node statuses
        for node_name in node_inputs.keys():
            user_workflow_status[uid]['node_status'][node_name] = 0  # Not started
            user_workflow_status[uid]['node_progress'][node_name] = 0

        if script_requested:
            user_workflow_status[uid]['node_status']['GPT-4o Agent'] = 0
            user_workflow_status[uid]['node_progress']['GPT-4o Agent'] = 0
        
        # Log the initialization for debugging
        logger.info(f"  Initialized user {uid} workflow status: node_progress={user_workflow_status[uid]['node_progress']}")
        
        # Start progress watchers for this user's nodes
        async def _update_user_node_progress(node_name: str, progress: int):
            """Update progress for a specific user's node"""
            if uid in user_workflow_status:
                user_workflow_status[uid]['node_progress'][node_name] = progress
                if progress > 0:
                    user_workflow_status[uid]['node_status'][node_name] = 1  # Running
        
        async def _get_node_port(node_name: str) -> Optional[int]:
            """Get port for a specific node"""
            try:
                nodes = list_node_ports(skip_health_checks=True)
                logger.info(f"  Getting port for node {node_name}")
                print(f"[DEBUG _get_node_port] Getting port for node {node_name}")
                print(f"[DEBUG _get_node_port] list_node_ports result: {nodes}")
                print(f"[DEBUG _get_node_port] services dict entry: {services.get(node_name)}")

                if nodes.get("success") and nodes.get("nodes"):
                    all_nodes = nodes["nodes"]
                    logger.info(f"  Available node names: {list(all_nodes.keys())}")
                    print(f"[DEBUG _get_node_port] Available nodes: {list(all_nodes.keys())}")

                    # Try exact match first
                    if node_name in all_nodes:
                        node_info = all_nodes[node_name]
                        port = node_info.get("port")
                        logger.info(f"  Found exact match for {node_name}: port {port}")
                        print(f"[DEBUG _get_node_port] Found exact match: {node_name} -> port {port}")
                        return port

                    # Try partial match for custom nodes
                    for available_name, node_info in all_nodes.items():
                        if node_name in available_name or available_name in node_name:
                            port = node_info.get("port")
                            logger.info(f"  Found partial match {available_name} for {node_name}: port {port}")
                            print(f"[DEBUG _get_node_port] Found partial match: {available_name} -> port {port}")
                            return port

                    logger.warning(f"[WARN] No matching node found for {node_name}")
                    print(f"[DEBUG _get_node_port] No match found for {node_name}")
                else:
                    logger.warning("[WARN] No nodes data found")
                    print(f"[DEBUG _get_node_port] No nodes data returned from list_node_ports")
            except Exception as e:
                logger.error(f"[ERROR] Error getting port for {node_name}: {e}")
                print(f"[DEBUG _get_node_port] Exception: {e}")
            return None

        async def _watch_node_progress(node_name: str, port: int, uid: str = None):
            """Subscribe to node's /progress and update user-specific progress"""
            # Decide remote vs local using is_remote.
            is_remote = False
            remote_host = None
            try:
                from app.services.register_service import CUSTOM_NODE_SERVICE_REGISTRY
                for registry_key, info in CUSTOM_NODE_SERVICE_REGISTRY.items():
                    if info.get("model_name") == node_name:
                        is_remote = info.get("is_remote", None)
                        remote_host = info.get("remote_host")
                        break
            except Exception as e:
                logger.warning(f"Could not check remote_host for {node_name}: {e}")
            
            # Build URL based on node type
            if is_remote is True and remote_host:
                url = f"http://{remote_host}:{port}/progress"
            else:
                url = f"http://127.0.0.1:{port}/progress"
            logger.info(f"  Connecting to progress endpoint: {url}")
            logger.debug(f"[_watch_node_progress] start node={node_name} port={port} uid={uid} remote={is_remote}")
            try:
                timeout = aiohttp.ClientTimeout(total=None, sock_connect=5, sock_read=None)
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.get(url, headers={"Accept": "text/event-stream"}) as resp:
                        logger.info(f"  Progress endpoint response status: {resp.status}")
                        if resp.status != 200:
                            logger.warning(f"[WARN] Progress endpoint returned status {resp.status}")
                            return
                        print(f"  Progress endpoint response content: {resp.content}")
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
                                # Handle progress values: -1 means reset, 0-100 means progress
                                if value == -1:
                                    # Reset progress
                                    await _update_user_node_progress(node_name, 0)
                                    if uid and uid in user_workflow_status:
                                        if 'node_progress' not in user_workflow_status[uid]:
                                            user_workflow_status[uid]['node_progress'] = {}
                                        user_workflow_status[uid]['node_progress'][node_name] = 0
                                        logger.info(f"Reset progress for user {uid}, node {node_name}")
                                elif 0 <= value <= 100:
                                    # Update user-specific progress
                                    print(f"  NODE PROGRESS RECEIVED: {node_name} -> {value}% (user: {uid})")
                                    await _update_user_node_progress(node_name, value)
                                    if uid and uid in user_workflow_status:
                                        if 'node_progress' not in user_workflow_status[uid]:
                                            user_workflow_status[uid]['node_progress'] = {}
                                        user_workflow_status[uid]['node_progress'][node_name] = value
                                        logger.info(f"Updated progress for user {uid}, node {node_name}: {value}%")
                                    
                                    # Don't break on 100% - keep connection alive for next run
                            except Exception:
                                continue
            except Exception:
                return

        async def _animate_scripts_progress(duration_seconds: float = 30.0):
            """Generate pseudo progress updates for CodingAgent while awaiting completion."""
            start = 0
            target = 100
            if duration_seconds <= 0:
                duration_seconds = 30.0
            steps = max(1, target - start)
            interval = duration_seconds / steps
            progress_value = start
            try:
                while progress_value < target:
                    await asyncio.sleep(interval)
                    if uid not in user_workflow_status:
                        break
                    scripts_status = user_workflow_status[uid].get('node_status', {}).get('GPT-4o Agent')
                    if scripts_status == 2:
                        break
                    progress_value = min(target, progress_value + 1)
                    await _update_user_node_progress('GPT-4o Agent', progress_value)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.debug(f"CodingAgent progress animation interrupted: {exc}")

        # Start progress watchers with user-specific updates
        async def _start_progress_watchers(names: List[str], uid: str = None):
            tasks = []
            seen = set()
            print(f"[DEBUG _start_progress_watchers] Called with names={names}, uid={uid}")
            for n in names:
                if n in seen:
                    print(f"[DEBUG _start_progress_watchers] Skipping duplicate: {n}")
                    continue
                seen.add(n)
                try:
                    print(f"[DEBUG _start_progress_watchers] Getting port for {n}...")
                    port = await _get_node_port(n)
                    if isinstance(port, int):
                        print(f"[DEBUG _start_progress_watchers] Creating watcher for {n} on port {port}")
                        tasks.append(asyncio.create_task(_watch_node_progress(n, port, uid)))
                    else:
                        logger.warning(f"[WARN] No port found for node {n}")
                        print(f"[DEBUG _start_progress_watchers] No port found for {n}")
                except Exception as e:
                    logger.error(f"[ERROR] Failed to get port for node {n}: {e}")
                    print(f"[DEBUG _start_progress_watchers] Exception getting port for {n}: {e}")
                    continue
            print(f"[DEBUG _start_progress_watchers] Created {len(tasks)} watcher tasks")
            return tasks

        # Force reset progress state before starting new workflow
        logger.info(f"  Force reset progress state before starting new workflow")
        for node_name in node_inputs.keys():
            # Reset user-specific progress to 0
            if uid and uid in user_workflow_status:
                if 'node_progress' not in user_workflow_status[uid]:
                    user_workflow_status[uid]['node_progress'] = {}
                user_workflow_status[uid]['node_progress'][node_name] = 0
                logger.info(f"  Reset progress for user {uid}, node {node_name} to 0%")
        
        # Force trigger an immediate SSE update with 0% progress
        logger.info(f"  Force triggering SSE update with 0% progress for user {uid}")
        # This will be picked up by the SSE generator and sent to frontend immediately
        
        # Kick off progress watchers concurrently (best-effort)
        try:
            logger.info(f"  Starting progress watchers for nodes: {list(node_inputs.keys())}")
            progress_tasks = await _start_progress_watchers(list(node_inputs.keys()), uid)
            logger.info(f"  Started {len(progress_tasks)} progress watchers")
        except Exception as e:
            logger.error(f"[ERROR] Failed to start progress watchers: {e}")
            progress_tasks = []
        
        # Execute workflow using user's manager
        from starlette.concurrency import run_in_threadpool
        result = await run_in_threadpool(
            _run_workflow_internal_for_user,
            user_manager,
        str(wf_id),
        node_inputs,
        zarr_path,
        uid
        )
        
        # Cancel progress watchers
        for task in progress_tasks:
            task.cancel()
        
        # Mark all TaskNodes from this run as completed before handling the script
        for node_name in node_inputs.keys():
            if uid in user_workflow_status:
                user_workflow_status[uid]['node_status'][node_name] = 2  # Completed
                user_workflow_status[uid]['node_progress'][node_name] = 100

        user_result = {
            "workflow_result": result.get("result") if isinstance(result, dict) else result,
            "zarr_file": result.get("zarr_file", zarr_path) if isinstance(result, dict) else zarr_path
        }

        # Reload zarr file if ClassificationNode completed successfully
        if "ClassificationNode" in node_inputs and (not isinstance(result, dict) or "error" not in result):
            # Use zarr_path from function parameter, fallback to result
            reload_zarr_path = zarr_path or (result.get("zarr_file") if isinstance(result, dict) else None)
            # Ensure zarr_path has .zarr extension
            if reload_zarr_path and not reload_zarr_path.endswith('.zarr'):
                reload_zarr_path = f"{reload_zarr_path}.zarr"
            
            if reload_zarr_path and os.path.exists(reload_zarr_path):
                try:
                    from app.websocket.segmentation_consumer import device_annotation_handlers
                    # Normalize paths for comparison
                    normalized_zarr_path = os.path.normpath(os.path.abspath(reload_zarr_path))
                    # Reload all handlers that are using this zarr file
                    reloaded_count = 0
                    for device_id, handler in device_annotation_handlers.items():
                        if handler is not None and hasattr(handler, 'zarr_file') and handler.zarr_file:
                            normalized_handler_path = os.path.normpath(os.path.abspath(handler.zarr_file))
                            if normalized_handler_path == normalized_zarr_path:
                                try:
                                    # Invalidate cache to ensure fresh data
                                    handler.invalidate_user_counts_cache()
                                    # Reload file to pick up new classification data
                                    handler.load_file(reload_zarr_path, force_reload=True, reload_segmentation_data=True)
                                    reloaded_count += 1
                                except Exception as e:
                                    logger.warning(f"Failed to reload handler for device {device_id}: {e}")
                    if reloaded_count > 0:
                        logger.info(f"Reloaded {reloaded_count} handler(s) after ClassificationNode completion")
                except Exception as e:
                    logger.warning(f"Could not reload handlers after ClassificationNode completion: {e}")

        agent_result = None
        if script_requested:
            z_for_script = resolve_path(user_result.get("zarr_file") or zarr_path or "")
            reused = _coding_script_cache_lookup(z_for_script, script_prompt)
            if reused is not None:
                logger.info("[CodingAgent] Prompt unchanged since last successful generation; skipping process_script.")
                user_workflow_status[uid]['node_status']['GPT-4o Agent'] = 2
                user_workflow_status[uid]['node_progress']['GPT-4o Agent'] = 100
                user_workflow_status[uid]["cur_answer"] = reused.get("generated_script", "")
                agent_result = reused
            else:
                user_workflow_status[uid]['node_status']['GPT-4o Agent'] = 1
                user_workflow_status[uid]['node_progress']['GPT-4o Agent'] = 0

                script_animation_task = asyncio.create_task(_animate_scripts_progress())
                user_workflow_status[uid]["cur_answer"] = ""
                try:
                    agent_result = await _generate_script_output(
                        script_prompt, user_result.get("zarr_file"), auth_header, uid=uid
                    )
                finally:
                    script_animation_task.cancel()
                    try:
                        await script_animation_task
                    except asyncio.CancelledError:
                        pass

                if agent_result and "error" in agent_result:
                    user_workflow_status[uid]['node_status']['GPT-4o Agent'] = -1
                    user_workflow_status[uid]['node_progress']['GPT-4o Agent'] = 0
                else:
                    user_workflow_status[uid]['node_status']['GPT-4o Agent'] = 2
                    user_workflow_status[uid]['node_progress']['GPT-4o Agent'] = 100
                    if (
                        isinstance(agent_result, dict)
                        and isinstance(agent_result.get("generated_script"), str)
                        and "def analyze_medical_image" in agent_result["generated_script"]
                    ):
                        fp = hashlib.sha256(script_prompt.encode("utf-8")).hexdigest()
                        _coding_script_cache_write(z_for_script, fp, agent_result["generated_script"])

            user_result["script_result"] = agent_result

        user_workflow_status[uid]['result'] = user_result
        user_workflow_status[uid]['status'] = 'completed'

        # Store answer in user-specific state instead of global variable
        if agent_result is not None:
            if isinstance(agent_result, dict) and "generated_script" in agent_result:
                user_workflow_status[uid]['cur_answer'] = agent_result["generated_script"]
            elif isinstance(agent_result, dict) and "error" in agent_result:
                error_msg = agent_result.get("error", "Unknown error")
                user_workflow_status[uid]['cur_answer'] = f"[ERROR] Script generation failed: {error_msg}\n\nPlease check the backend logs for more details."
            else:
                user_workflow_status[uid]['cur_answer'] = json.dumps(agent_result) if isinstance(agent_result, dict) else str(agent_result)
        else:
            user_workflow_status[uid]['cur_answer'] = ""
        user_workflow_status[uid]['is_generating'] = False

    except Exception as e:
        logger.error(f"Error running workflow for user {uid}: {e}")
        user_workflow_status[uid]['status'] = 'error'
        user_workflow_status[uid]['error'] = str(e)
        user_workflow_status[uid]['is_generating'] = False
        user_workflow_status[uid]['cur_answer'] = f"Error: {str(e)}"
        
        # Mark all nodes as failed
        for node_name in node_inputs.keys():
            user_workflow_status[uid]['node_status'][node_name] = -1  # Failed
            user_workflow_status[uid]['node_progress'][node_name] = 0

        if script_requested:
            user_workflow_status[uid]['node_status']['GPT-4o Agent'] = -1
            user_workflow_status[uid]['node_progress']['GPT-4o Agent'] = 0
    finally:
        # Register any .zarr outputs regardless of success/failure/cancellation
        _register_zarr_outputs(uid, zarr_path)

def _run_workflow_internal_for_user(user_manager: TaskNodeManager, workflow_id: str, node_inputs: dict, zarr_path: str, uid: str) -> dict:
    """Internal workflow execution for a specific user"""
    try:
        wf_id_int = int(workflow_id)
    except:
        return {"error": "workflow_id must be an integer."}

    time.sleep(1)
    
    # zarr files use cached synchronizer for coordination
    
    # 1) if zarr file not exists => create new file
    from app.services.data import get_zarr_synchronizer
    if not os.path.exists(zarr_path):
        # Create zarr file with cached synchronizer
        synchronizer = get_zarr_synchronizer(zarr_path)
        # Use append mode to create if missing without risking accidental truncation
        zarr.open(zarr_path, mode='a', synchronizer=synchronizer)
    else:
        # Zarr supports in-place updates, no need to copy files
        # zarr files use cached synchronizer for coordination
        pass
    
    # Use the original file directly for in-place updates
    active_zarr_path = zarr_path
    
    # 3) write node_inputs to zarr file
    try:
        synchronizer = get_zarr_synchronizer(active_zarr_path)
        with zarr.open(active_zarr_path, "a", synchronizer=synchronizer) as zf:
            for nodeName, paramDict in node_inputs.items():
                # Resolve zarr_group from ModelStore (fallback to nodeName)
                nodes_meta = model_store.get_nodes_extended()
                node_meta = nodes_meta.get(nodeName, {}) if isinstance(nodes_meta, dict) else {}
                zarr_group = node_meta.get("zarr_group") or nodeName
                if zarr_group == "MuskClassification" or zarr_group == "MuskEmbedding":
                    zarr_group = "MuskNode"
                user_data_path = f"{zarr_group}/userData"
                node_group = zf.require_group(user_data_path)
                
                # Convert paths in paramDict for remote nodes before writing
                # Check if this node is a remote node
                runtime = node_meta.get("runtime", {}) if isinstance(node_meta, dict) else {}
                is_remote = runtime.get("is_remote") is True if isinstance(runtime, dict) else False
                remote_host = runtime.get("remote_host") if is_remote and isinstance(runtime, dict) else None
                mnt_path = runtime.get("mnt_path") if is_remote and isinstance(runtime, dict) else None
                
                if is_remote and remote_host and mnt_path:
                    # Convert paths in paramDict for remote node
                    paramDict = user_manager._convert_paths_in_data(paramDict, nodeName)
                
                _overwrite_node_user_data(node_group)
                for k, v in paramDict.items():
                    if isinstance(v, (str, int, float, bool)):
                        node_group.create_dataset(k, data=str(v).encode("utf-8"))
                    else:
                        data_str = json.dumps(v, ensure_ascii=False)
                        node_group.create_dataset(k, data=data_str.encode("utf-8"))
    except Exception as e:
        return {"error": f"write node_inputs to zarr file failed: {str(e)}"}
    
    # 4) manager.execute_workflow
    try:
        logger.info(f"Starting workflow execution for workflow {wf_id_int} (user {uid})")
        result = user_manager.execute_workflow(wf_id_int, active_zarr_path)
        logger.info(f"Workflow execution completed for user {uid}. Result: {result}")
    except Exception as e:
        logger.error(f"Workflow execution failed for user {uid}: {str(e)}")
        return {"error": f"execute workflow failed: {str(e)}"}
    
    # zarr files are updated in-place, no temp file replacement needed

    return {
        "success": True,
        "workflow_id": workflow_id,
        "result": result,
        "zarr_file": active_zarr_path
    }

def get_queue_position(uid: str) -> int:
    """Get user's position in the queue"""
    # This is a simplified implementation
    # In a real scenario, you'd need to track queue positions more precisely
    queue_size = workflow_queue.qsize()
    if uid in user_workflow_status and user_workflow_status[uid]['status'] == 'queued':
        # For simplicity, return current queue size
        return queue_size
    return 0

async def create_node_for_workflow_with_manager(model_name: str, input_data: dict, user_manager: TaskNodeManager):
    """Create node for workflow using specific manager instance"""
    # For simplicity, we'll use the global manager but ensure serial execution through queue
    # In a real multi-user scenario, you'd want proper node isolation
    try:
        # Check if node exists in global manager
        if model_name not in manager.nodes:
            return {"error": f"Node '{model_name}' not found in manager. Make sure it's already created & running."}
        
        # Simply return success - we'll use global manager with queue serialization
        return {"node_name": model_name}
    except Exception as e:
        return {"error": str(e)}

async def _add_dependency_internal_with_manager(from_node: str, to_node: str, user_manager: TaskNodeManager):
    """Add dependency between nodes using specific manager instance"""
    try:
        user_manager.add_dependency(from_node, to_node)
        return {"message": f"Dependency added: {from_node} -> {to_node}"}
    except Exception as e:
        return {"error": str(e)}

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
    except Exception:
        pass

async def generate_all_activation_events():
    """Async generator for SSE activation status for ALL models."""
    # Track last timestamp per model
    last_timestamps: Dict[str, float] = {}
    
    # Send initial state for all existing models
    # Use list() to create a snapshot and avoid RuntimeError if dict is modified during iteration
    for model_name, state in list(activation_states.items()):
        last_timestamps[model_name] = state.get("ts", 0.0)
        payload = {"model": model_name, **state}
        yield f"data: {json.dumps(payload)}\n\n"
    
    # Stream updates for all models
    while True:
        await asyncio.sleep(0.5)
        
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
                continue
            
            last_ts = last_timestamps.get(model_name, 0.0)
            
            # If this model has an update
            if current_ts > last_ts:
                last_timestamps[model_name] = current_ts
                payload = {"model": model_name, **state}
                yield f"data: {json.dumps(payload)}\n\n"

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
        # If already exists in services, mark it as running since the service is calling this endpoint
        # CRITICAL: Also update the port in case it changed (e.g., after cancel/reactivation)
        services[service_name]["running"] = True
        services[service_name]["port"] = port
        services[service_name]["file"] = file_path
        logger.info(f"[create_node] Updated existing service '{service_name}' to port {port}")

        # Also update the port in TaskNodeManager if the node exists there
        if service_name in manager.nodes:
            manager_node = manager.nodes[service_name]
            if hasattr(manager_node, 'port'):
                manager_node.port = port
                logger.info(f"[create_node] Updated TaskNodeManager '{service_name}' to port {port}")

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
            logger.info(f"[create_node] Node '{service_name}' already exists in manager; skipping add (idempotent).")
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

def _run_workflow_internal(workflow_id: str, node_inputs: dict, zarr_path: str) -> dict:
    """Internal function to run a workflow"""
    try:
        wf_id_int = int(workflow_id)
    except:
        return {"error": "workflow_id must be an integer."}
    

    time.sleep(1)
    
    # zarr files use ThreadSynchronizer for coordination
    
    # 1) if zarr file not exists => create new file
    from app.services.data import get_zarr_synchronizer
    if not os.path.exists(zarr_path):
        # Create zarr file with cached synchronizer
        synchronizer = get_zarr_synchronizer(zarr_path)
        # Use append mode to create if missing without risking accidental truncation
        zarr.open(zarr_path, mode='a', synchronizer=synchronizer)
    else:
        # zarr files use cached synchronizer for coordination
        # No need to check for locks or create temp files
        # Directly use original file with cached synchronizer
        try:
            synchronizer = get_zarr_synchronizer(zarr_path)
            with zarr.open(zarr_path, mode='a', synchronizer=synchronizer) as zf:
                to_delete = []
                for key in zf.keys():
                    # Keep SegmentationNode, user_annotation, MuskNode, and ClassificationNode
                    # ClassificationNode should be updated by workflow, not deleted
                    if key not in ["SegmentationNode", "user_annotation", "MuskNode", "ClassificationNode"]:
                        to_delete.append(key)
                for grp_name in to_delete:
                    del zf[grp_name]
                    logger.info(f"[Workflow] Deleted Zarr group: {grp_name}")
                if "ClassificationNode" in zf:
                    logger.info(f"[Workflow] Preserving existing ClassificationNode")
        except Exception as e:
            return {"error": f"cannot visit this file: {str(e)}"}
    
    # Use the original file directly
    active_zarr_path = zarr_path
    
    # 3) write node_inputs to zarr file
    try:
        synchronizer = get_zarr_synchronizer(active_zarr_path)
        with zarr.open(active_zarr_path, "a", synchronizer=synchronizer) as zf:
            for nodeName, paramDict in node_inputs.items():
                # Resolve zarr_group from ModelStore (fallback to nodeName)
                nodes_meta = model_store.get_nodes_extended()
                node_meta = nodes_meta.get(nodeName, {}) if isinstance(nodes_meta, dict) else {}
                zarr_group = node_meta.get("zarr_group") or nodeName
                if zarr_group == "MuskClassification" or zarr_group == "MuskEmbedding":
                    zarr_group = "MuskNode"
                user_data_path = f"{zarr_group}/userData"
                node_group = zf.require_group(user_data_path)
                
                # Convert paths in paramDict for remote nodes before writing
                # Check if this node is a remote node
                runtime = node_meta.get("runtime", {}) if isinstance(node_meta, dict) else {}
                is_remote = runtime.get("is_remote") is True if isinstance(runtime, dict) else False
                remote_host = runtime.get("remote_host") if is_remote and isinstance(runtime, dict) else None
                mnt_path = runtime.get("mnt_path") if is_remote and isinstance(runtime, dict) else None
                
                if is_remote and remote_host and mnt_path:
                    # Convert paths in paramDict for remote node
                    paramDict = manager._convert_paths_in_data(paramDict, nodeName)
                
                _overwrite_node_user_data(node_group)
                for k, v in paramDict.items():
                    if isinstance(v, (str, int, float, bool)):
                        node_group.create_dataset(k, data=str(v).encode("utf-8"))
                    else:
                        data_str = json.dumps(v, ensure_ascii=False)
                        node_group.create_dataset(k, data=data_str.encode("utf-8"))
    except Exception as e:
        return {"error": f"write node_inputs to zarr file failed: {str(e)}"}
    
    # 4) manager.execute_workflow
    try:
        logger.info(f"Starting workflow execution for workflow {wf_id_int}")
        result = manager.execute_workflow(wf_id_int, active_zarr_path)
        logger.info(f"Workflow execution completed. Result: {result}")
    except Exception as e:
        logger.error(f"Workflow execution failed: {str(e)}")
        return {"error": f"execute workflow failed: {str(e)}"}
    
    # zarr files are updated in-place, no temp file replacement needed
    # Refresh cache after workflow execution
    
    # Use original file path
    active_zarr_path = zarr_path
    
    # zarr files use ThreadSynchronizer, no manual lock release needed
    
    return {
        "message": f"Workflow '{wf_id_int}' executed with node-level data.",
        "zarr_file": active_zarr_path,
        "result": result
    }

async def run_workflow_in_background(wf_id, node_inputs, script_prompt, zarr_path, auth_header: str | None = None):
    """
    execute workflow using background tasks with proper async handling
    """
    print(f"[DEBUG run_workflow_in_background] Starting workflow wf_id={wf_id}, nodes={list(node_inputs.keys())}")

    # Extract user ID from auth header if available
    uid = None
    if auth_header:
        try:
            # Extract uid from auth_header (assuming it's a JWT token or similar)
            # For now, use a simple extraction - adjust based on your auth system
            import base64
            if '.' in auth_header:
                parts = auth_header.split('.')
                if len(parts) >= 2:
                    payload = base64.urlsafe_b64decode(parts[1] + '=' * (4 - len(parts[1]) % 4))
                    payload_data = json.loads(payload.decode('utf-8'))
                    uid = payload_data.get('sub') or payload_data.get('user_id') or payload_data.get('uid')
        except Exception:
            pass

    logger.info(f"  Starting background workflow execution for workflow {wf_id}")
    logger.info(f"  Node inputs: {list(node_inputs.keys())}")
    logger.info(f"  Zarr path: {zarr_path}")

    try:
        # Reset node status tracking for this workflow
        try:
            node_execution_status.clear()
        except Exception:
            pass
        global last_node_status_snapshot
        last_node_status_snapshot = {}

        # Initialize status as not started (0) first, will be updated to running (1) after PID tracking
        for node_name in node_inputs.keys():
            node_execution_status[node_name] = 0
            logger.info(f"  Initialized status for {node_name}: 0 (not started)")

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

        async def _watch_node_progress(node_name: str, port: int, uid: str = None):
            """Subscribe to node's /progress (if available) and update both global and user-specific progress."""
            # Get remote_host if this is a remote node
            remote_host = None
            try:
                from app.services.register_service import CUSTOM_NODE_SERVICE_REGISTRY
                for registry_key, info in CUSTOM_NODE_SERVICE_REGISTRY.items():
                    if info.get("model_name") == node_name:
                        remote_host = info.get("remote_host")
                        break
            except Exception as e:
                logger.warning(f"Could not check remote_host for {node_name}: {e}")
            
            # Build URL based on node type
            if remote_host:
                url = f"http://{remote_host}:{port}/progress"
            else:
                url = f"http://127.0.0.1:{port}/progress"
            logger.info(f"  Connecting to progress endpoint: {url}")
            try:
                timeout = aiohttp.ClientTimeout(total=None, sock_connect=5, sock_read=None)
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.get(url, headers={"Accept": "text/event-stream"}) as resp:
                        logger.info(f"  Progress endpoint response status: {resp.status}")
                        if resp.status != 200:
                            logger.warning(f"[WARN] Progress endpoint returned status {resp.status}")
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
                                # Handle progress values: -1 means reset, 0-100 means progress
                                if value == -1:
                                    # Reset progress
                                    update_node_progress(node_name, 0)
                                    if uid and uid in user_workflow_status:
                                        if 'node_progress' not in user_workflow_status[uid]:
                                            user_workflow_status[uid]['node_progress'] = {}
                                        user_workflow_status[uid]['node_progress'][node_name] = 0
                                        print(f"Reset progress for user {uid}, node {node_name}")
                                elif 0 <= value <= 100:
                                    # Update global progress
                                    update_node_progress(node_name, value)
                                    
                                    # Update user-specific progress if uid is provided
                                    if uid and uid in user_workflow_status:
                                        if 'node_progress' not in user_workflow_status[uid]:
                                            user_workflow_status[uid]['node_progress'] = {}
                                        user_workflow_status[uid]['node_progress'][node_name] = value
                                        print(f"Updated progress for user {uid}, node {node_name}: {value}%")
                                    
                                    # Don't break on 100% - keep connection alive for next run
                            except Exception:
                                continue
            except Exception:
                return

        async def _start_progress_watchers(names: List[str], uid: str = None):
            tasks = []
            seen = set()
            for n in names:
                if n in seen:
                    continue
                seen.add(n)
                try:
                    port = await _get_node_port(n)
                    if isinstance(port, int):
                        logger.info(f"  Starting progress watcher for {n} on port {port}")
                        tasks.append(asyncio.create_task(_watch_node_progress(n, port, uid)))
                    else:
                        logger.warning(f"[WARN] No port found for node {n}")
                except Exception as e:
                    logger.error(f"[ERROR] Failed to get port for node {n}: {e}")
                    continue
            return tasks

        # Force reset progress state before starting background workflow
        logger.info(f"  Force reset progress state before starting background workflow")
        for node_name in node_inputs.keys():
            # Reset global progress
            update_node_progress(node_name, 0)
            # Reset user-specific progress if uid is provided
            if uid and uid in user_workflow_status:
                if 'node_progress' not in user_workflow_status[uid]:
                    user_workflow_status[uid]['node_progress'] = {}
                user_workflow_status[uid]['node_progress'][node_name] = 0
                logger.info(f"  Reset progress for user {uid}, node {node_name} to 0%")
        
        # Kick off progress watchers concurrently (best-effort)
        try:
            logger.info(f"  Starting progress watchers for nodes: {list(node_inputs.keys())}")
            watcher_tasks = await _start_progress_watchers(list(node_inputs.keys()), uid)
            logger.info(f"  Started {len(watcher_tasks)} progress watchers")
        except Exception as e:
            logger.error(f"[ERROR] Failed to start progress watchers: {e}")
            watcher_tasks = []

        # Special handling for CodingAgent-only workflow (wf_id -1)
        if wf_id == -1 and len(node_inputs) == 0:
            # CodingAgent-only: skip regular workflow execution, create dummy result
            logger.info(f"  CodingAgent-only workflow detected, skipping TaskNode execution")
            
            # Ensure Zarr file exists for CodingAgent to read from
            if not os.path.exists(zarr_path):
                logger.info(f"  Creating Zarr file for CodingAgent-only workflow: {zarr_path}")
                try:
                    from app.services.data import get_zarr_synchronizer
                    synchronizer = get_zarr_synchronizer(zarr_path)
                    # Use append mode to create if missing without risking accidental truncation
                    zarr.open(zarr_path, mode='a', synchronizer=synchronizer)  # Create empty Zarr file
                except Exception as e:
                    logger.error(f"Failed to create Zarr file: {e}")
                    run_res = {"error": f"Failed to create Zarr file: {str(e)}"}
                    workflow_run_status[wf_id] = {"status": "error", "result": str(e)}
                    try:
                        for t in watcher_tasks:
                            if not t.done():
                                t.cancel()
                    except Exception:
                        pass
                    return
            
            run_res = {
                "message": "CodingAgent-only workflow (no TaskNodes to execute)",
                "zarr_file": zarr_path,
                "result": {"status": "skipped", "info": "CodingAgent-only workflow"}
            }
        else:
            # Regular workflow: execute TaskNodes
            # Use run_in_threadpool for CPU-bound operations
            from starlette.concurrency import run_in_threadpool
            logger.info(f"  Calling run_in_threadpool for workflow {wf_id}")
            run_res = await run_in_threadpool(
                _run_workflow_internal,
                str(wf_id),
                node_inputs,
                zarr_path
            )
            logger.info(f"[SUCCESS] run_in_threadpool completed for workflow {wf_id}, result: {run_res}")

        # After success, cleanup watchers
        try:
            for t in watcher_tasks:
                if not t.done():
                    t.cancel()
        except Exception:
            pass

        # tag complete
        snapshot = last_node_status_snapshot.copy()
        workflow_run_status[wf_id] = {"status": "done", "result": run_res, "node_status": snapshot, "wf_id": wf_id}
        if "error" in run_res:
            workflow_run_status[wf_id] = {"status": "error", "result": run_res["error"], "node_status": snapshot, "wf_id": wf_id}
            # clear workflow
            manager.clear_workflows()
            logger.info(f"clear all workflows after workflow {wf_id} is done")
            return

        # tag complete
        for node_name in node_inputs.keys():
            print(f"node complete: {node_name}")
            node_execution_status[node_name] = 2

        # Register zarr store in metadata now that workflow succeeded and zarr is on disk
        effective_zarr = zarr_path if zarr_path.endswith('.zarr') else f"{zarr_path}.zarr"
        if uid and effective_zarr and os.path.exists(effective_zarr):
            from app.utils import register_zarr_store
            register_zarr_store(uid, effective_zarr)

        # Reload zarr file if ClassificationNode completed successfully
        if "ClassificationNode" in node_inputs and "error" not in run_res:
            # Use zarr_path from function parameter, fallback to run_res
            reload_zarr_path = zarr_path or run_res.get("zarr_file")
            # Ensure zarr_path has .zarr extension
            if reload_zarr_path and not reload_zarr_path.endswith('.zarr'):
                reload_zarr_path = f"{reload_zarr_path}.zarr"
            
            if reload_zarr_path and os.path.exists(reload_zarr_path):
                try:
                    from app.websocket.segmentation_consumer import device_annotation_handlers
                    # Normalize paths for comparison
                    normalized_zarr_path = os.path.normpath(os.path.abspath(reload_zarr_path))
                    # Reload all handlers that are using this zarr file
                    reloaded_count = 0
                    for device_id, handler in device_annotation_handlers.items():
                        if handler is not None and hasattr(handler, 'zarr_file') and handler.zarr_file:
                            normalized_handler_path = os.path.normpath(os.path.abspath(handler.zarr_file))
                            if normalized_handler_path == normalized_zarr_path:
                                try:
                                    # Invalidate cache to ensure fresh data
                                    handler.invalidate_user_counts_cache()
                                    # Reload file to pick up new classification data
                                    handler.load_file(reload_zarr_path, force_reload=True, reload_segmentation_data=True)
                                    reloaded_count += 1
                                except Exception as e:
                                    logger.warning(f"Failed to reload handler for device {device_id}: {e}")
                    if reloaded_count > 0:
                        logger.info(f"Reloaded {reloaded_count} handler(s) after ClassificationNode completion")
                except Exception as e:
                    logger.warning(f"Could not reload handlers after ClassificationNode completion: {e}")

        agent_result = None
        if script_prompt is not None:
            z_bg = resolve_path(run_res.get("zarr_file") or zarr_path or "")
            reused_bg = _coding_script_cache_lookup(z_bg, script_prompt)
            if reused_bg is not None:
                logger.info("[CodingAgent] Prompt unchanged since last successful generation; skipping process_script.")
                agent_result = reused_bg
                node_execution_status["GPT-4o Agent"] = 2
            else:
                agent_result = await _generate_script_output(
                    script_prompt, run_res.get("zarr_file"), auth_header, uid=uid
                )
                if agent_result and "error" in agent_result:
                    node_execution_status["GPT-4o Agent"] = -1
                    logger.error(f"[CodingAgent] Execution failed: {agent_result['error']}")
                else:
                    node_execution_status["GPT-4o Agent"] = 2
                    logger.info(f"[CodingAgent] Execution completed successfully")
                    if (
                        isinstance(agent_result, dict)
                        and isinstance(agent_result.get("generated_script"), str)
                        and "def analyze_medical_image" in agent_result["generated_script"]
                    ):
                        fp = hashlib.sha256(script_prompt.encode("utf-8")).hexdigest()
                        _coding_script_cache_write(z_bg, fp, agent_result["generated_script"])

        print("[tasks] run_res:", run_res)
        print("[tasks] agent_result:", agent_result)
        # (C) assemble final answer
        final_res = {
            "workflow_result": run_res.get("result"),
            "zarr_file": run_res.get("zarr_file")
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
        elif agent_result is not None and isinstance(agent_result, dict) and "error" in agent_result:
            # Format error message nicely for user display
            error_msg = agent_result["error"]
            cur_answer = f"[ERROR] Script generation failed: {error_msg}\n\nPlease check your network connection and try again. If the problem persists, check the backend logs for more details."
        else:
            cur_answer = json.dumps(agent_result) if isinstance(agent_result, dict) else ("" if agent_result is None else str(agent_result))
        is_generating = False
        workflow_run_status[wf_id] = {"status": "done", "result": final_res, "node_status": last_node_status_snapshot.copy(), "wf_id": wf_id}

        # Register zarr store in metadata now that workflow succeeded and zarr is on disk
        effective_zarr = zarr_path if zarr_path.endswith('.zarr') else f"{zarr_path}.zarr"
        if uid and effective_zarr and os.path.exists(effective_zarr):
            from app.utils import register_zarr_store
            register_zarr_store(uid, effective_zarr)

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
                                log_path: Optional[str] = None,
                                is_remote: bool = False,
                                remote_host: Optional[str] = None,
                                mnt_path: Optional[str] = None):
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
            from app.services.register_service import get_env_name_from_model
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
    
    logger.info(f"[register_custom_node_endpoint] Service reported up on port {port}; registering node in manager")
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
        ('cell_class', 'i4'),  # -1=unclassified, 0+=class index, -(2+k)=exclude class k ("No" type)
        ('cell_color', 'i4'),  # int32: RGB color value (0xRRGGBB format, -1 = not set, 0 = black)
        # Large integers (i8) - grouped together for better cache locality
        ('datetime', 'i8'),  # int64: Unix timestamp in milliseconds (0 = not set)
        ('region_x1', 'i8'),  # int64: region geometry x1 coordinate
        ('region_y1', 'i8'),  # int64: region geometry y1 coordinate
        ('region_x2', 'i8'),  # int64: region geometry x2 coordinate
        ('region_y2', 'i8'),  # int64: region geometry y2 coordinate
        # Strings (Unicode) - grouped together, ordered by size
        ('method', 'U32'),  # Reduced from U256: sufficient for method names
        ('annotator', 'U64'),  # Reduced from U256: sufficient for usernames
    ])

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
        new_dataset = group.create_dataset(temp_name, **create_kwargs)
        
        # Verify the dataset was created successfully
        if temp_name not in group:
            raise RuntimeError(f"Failed to create temporary dataset {temp_name}")
        
        # Only delete old dataset after new one is successfully created and verified
        if old_dataset_exists:
            del group[dataset_name]
            logger.info(f"[_safe_replace_dataset] Deleted old dataset: {dataset_name}")
        
        # Create final dataset by copying from temporary dataset
        # Extract parameters needed for dataset creation (excluding data, which we'll copy)
        create_params = {k: v for k, v in create_kwargs.items() if k != 'data'}
        
        # Determine shape and dtype from temporary dataset
        if 'shape' not in create_params:
            create_params['shape'] = new_dataset.shape
        if 'dtype' not in create_params:
            create_params['dtype'] = new_dataset.dtype
        
        # Create final dataset
        final_dataset = group.create_dataset(dataset_name, **create_params)
        
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
        logger.info(f"[_safe_replace_dataset] Successfully replaced dataset: {dataset_name}")
        
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
        logger.error(f"[_safe_replace_dataset] Failed to replace dataset {dataset_name}: {e}")
        raise

def save_annotation(handler, req: dict, _background_tasks=None) -> dict:
    """
    Save annotation data using efficient Zarr structured array format.
    The Zarr file structure for this:
    - /user_annotation/nuclei_annotations (structured array with fields: cell_class, cell_color, annotator, datetime, method, region_geometry)
    - /ClassificationNode/userData/ (to store params for the classification node like organ, nuclei_classes, nuclei_colors)
    
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
    from app.services.load_service import get_session_data
    session_data = get_session_data(instance_id)
    
    # Use session-specific file path if available, otherwise fall back to request path
    if session_data.get('current_file_path'):
        # Prefer '<wsi_path>.zarr' convention; if already .zarr, use as-is
        wsi_path = session_data['current_file_path']
        zarr_path = wsi_path if str(wsi_path).lower().endswith('.zarr') else f"{wsi_path}.zarr"
        logger.info(f"[save_annotation] Using session-specific Zarr path: {zarr_path}")
    else:
        zarr_path = resolve_path(req.get("path"))
        logger.warning(f"[save_annotation] No session file path found, using request path: {zarr_path}")
    
    ui_nuclei_classes = req.get("ui_nuclei_classes")
    ui_nuclei_colors = req.get("ui_nuclei_colors")
    ui_organ = req.get("ui_organ")
    
    logger.info(f"[save_annotation] Received request: instance_id='{instance_id}', path='{zarr_path}', classes='{ui_nuclei_classes}', colors='{ui_nuclei_colors}', organ='{ui_organ}'")

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
    # Update the SegmentationHandler's in-memory state with the latest from the UI (device-scoped handler)
    if ui_nuclei_classes and ui_nuclei_colors:
        handler.update_class_definitions(ui_nuclei_classes, ui_nuclei_colors)
    # --- END CACHE UPDATE ---
    
    region_geometry = req.get("region_geometry", {})
    method = req.get("method", "rectangle selection")
    annotator = req.get("annotator", "Unknown")
    auto_run = req.get("auto_run_classification", False)
    
    # Zarr supports in-place updates, no need for temporary files
    try:
        # Get cached synchronizer for this file to ensure all operations use the same instance
        from app.services.data import get_zarr_synchronizer
        synchronizer = get_zarr_synchronizer(zarr_path)
        
        # 1. Get centroids length - use cached handler data if available to avoid I/O
        # Optimization: Use handler's cached centroids if available
        if handler.centroids is not None:
            centroids_len = len(handler.centroids)
            logger.info(f"[save_annotation] Using cached centroids length: {centroids_len}")
        else:
            # Fallback: read from Zarr if handler doesn't have centroids
            # Use same synchronizer for read operations to ensure consistency
            with zarr.open(zarr_path, 'r', synchronizer=synchronizer) as readf:
                if "SegmentationNode/centroids" not in readf:
                    logger.error("[save_annotation] No SegmentationNode/centroids found in Zarr")
                    return {"success": False, "message": "No seg centroids found in Zarr"}
                centroids_dataset = readf["SegmentationNode/centroids"]
                if centroids_dataset.shape == ():  # scalar dataset
                    centroids = centroids_dataset[()]
                else:  # array dataset
                    centroids = centroids_dataset[:]
                centroids_len = len(centroids)
            logger.info(f"[save_annotation] Loaded centroids from Zarr. Count: {centroids_len}")

        # 2. Open Zarr file and write annotations using efficient array format
        # Use cached synchronizer to ensure thread-safe coordination with other operations
        with zarr.open(zarr_path, "a", synchronizer=synchronizer) as zf:
            ann_group_path = ZarrGroups.USER_ANNOTATION
            logger.info(f"[save_annotation] Opening Zarr file for writing: {zarr_path}")
            
            if ann_group_path not in zf:
                group_anno = zf.create_group(ann_group_path)
                logger.info(f"[save_annotation] Created group: {ann_group_path}")
            else:
                group_anno = zf[ann_group_path]
                logger.info(f"[save_annotation] Using existing group: {ann_group_path}")

            # Use structured array format only (no old format support)
            ds_name = ZarrDatasets.NUCLEI_ANNOTATIONS
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
                from numcodecs import LZ4
                
                # Calculate optimal chunk size
                element_size = annotation_dtype.itemsize
                target_chunk_size = 8 * 1024 * 1024  # 8MB target
                optimal_chunk_size = max(1000, min(centroids_len, target_chunk_size // element_size))
                # Use LZ4 compression - it's fast and reduces I/O time
                # Testing showed LZ4 is faster than no compression for writes
                compressor = LZ4()
                
                # Memory threshold: use chunked creation for arrays > 1M cells (~560MB)
                # This prevents OOM errors for very large datasets
                MEMORY_THRESHOLD = 1_000_000  # 1 million cells
                
                if needs_replacement:
                    # Use safe atomic replacement to preserve data integrity
                    logger.info(f"[save_annotation] Replacing dataset with incorrect format using atomic operation")
                    
                    if centroids_len > MEMORY_THRESHOLD:
                        # For large arrays: use chunked initialization to avoid OOM
                        logger.info(f"[save_annotation] Large array detected ({centroids_len:,} cells). Using chunked initialization for replacement.")
                        
                        # Create temporary dataset with chunked initialization
                        temp_name = f"{ds_name}_tmp_{int(time.time() * 1000000)}"
                        old_dataset_exists = ds_name in group_anno
                        
                        try:
                            # Create temporary dataset with shape (no data yet)
                            temp_dataset = group_anno.create_dataset(
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
                            for field in ['cell_class', 'cell_color', 'region_x1', 'region_y1', 'region_x2', 'region_y2']:
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
                                    for field in ['cell_class', 'cell_color', 'region_x1', 'region_y1', 'region_x2', 'region_y2']:
                                        partial_chunk[field] = -1
                                    temp_dataset[start_idx:end_idx] = partial_chunk
                                    # partial_chunk will be garbage collected after this iteration
                                
                                if (chunk_idx + 1) % 100 == 0:
                                    logger.info(f"[save_annotation] Initialized chunk {chunk_idx + 1}/{num_chunks} for replacement ({end_idx:,}/{centroids_len:,} cells)")
                            
                            # Verify temporary dataset was created successfully
                            if temp_name not in group_anno:
                                raise RuntimeError(f"Failed to create temporary dataset {temp_name}")
                            
                            # Only delete old dataset after new one is successfully created and verified
                            if old_dataset_exists:
                                del group_anno[ds_name]
                                logger.info(f"[save_annotation] Deleted old dataset: {ds_name}")
                            
                            # Create final dataset and copy data from temp in chunks
                            # Use smaller copy chunks to minimize memory usage during copy
                            # The copy operation will decompress from temp and recompress to final
                            # Using smaller chunks reduces peak memory usage
                            copy_chunk_size = min(optimal_chunk_size, 10000)  # Use smaller chunks for copying
                            final_dataset = group_anno.create_dataset(
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
                            logger.info(f"[save_annotation] Successfully replaced large dataset with structured array format (chunks={optimal_chunk_size})")
                            
                        except Exception as e:
                            # Clean up temporary dataset if it was created
                            if temp_name in group_anno:
                                try:
                                    del group_anno[temp_name]
                                    logger.warning(f"[save_annotation] Cleaned up temporary dataset after error: {temp_name}")
                                except:
                                    pass
                            logger.error(f"[save_annotation] Failed to replace dataset {ds_name}: {e}")
                            raise
                    else:
                        # For smaller arrays: create full array in memory (acceptable for < 1M cells)
                        annotations_arr = np.zeros(centroids_len, dtype=annotation_dtype)
                        for field in ['cell_class', 'cell_color', 'region_x1', 'region_y1', 'region_x2', 'region_y2']:
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
                        logger.info(f"[save_annotation] Successfully replaced dataset with structured array format (chunks={optimal_chunk_size})")
                elif centroids_len > MEMORY_THRESHOLD:
                    # For large arrays: create empty dataset first, then fill in chunks
                    # This avoids loading the entire array into memory at once
                    logger.info(f"[save_annotation] Large array detected ({centroids_len:,} cells). Using chunked initialization to avoid OOM.")
                    
                    # Create empty dataset with shape and dtype
                    annotations_dataset = group_anno.create_dataset(
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
                    for field in ['cell_class', 'cell_color', 'region_x1', 'region_y1', 'region_x2', 'region_y2']:
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
                            for field in ['cell_class', 'cell_color', 'region_x1', 'region_y1', 'region_x2', 'region_y2']:
                                partial_chunk[field] = -1
                            annotations_dataset[start_idx:end_idx] = partial_chunk
                        
                        if (chunk_idx + 1) % 100 == 0:
                            logger.info(f"[save_annotation] Initialized chunk {chunk_idx + 1}/{num_chunks} ({end_idx:,}/{centroids_len:,} cells)")
                    
                    logger.info(f"[save_annotation] Completed chunked initialization of {centroids_len:,} cells")
                    group_anno.attrs['annotation_format'] = 'structured'
                else:
                    # For smaller arrays: create with data directly (faster for small arrays)
                    # Create dataset with cell_class initialized to -1 (unclassified) for all cells
                    # Use np.zeros to initialize: numeric fields to 0, string fields to empty strings
                    annotations_arr = np.zeros(centroids_len, dtype=annotation_dtype)
                    # Set fields that need -1 (unclassified/not set) instead of 0
                    for field in ['cell_class', 'cell_color', 'region_x1', 'region_y1', 'region_x2', 'region_y2']:
                        annotations_arr[field] = -1
                    # Note: datetime=0 (not set) and string fields (empty) are already correct from np.zeros
                    
                    # Create dataset with pre-initialized data
                    annotations_dataset = group_anno.create_dataset(
                        ds_name,
                        data=annotations_arr,
                        dtype=annotation_dtype,
                        chunks=(optimal_chunk_size,),
                        compressor=compressor
                    )
                    logger.info(f"[save_annotation] Created dataset with pre-initialized data ({centroids_len:,} cells)")
                    group_anno.attrs['annotation_format'] = 'structured'
                
                if not needs_replacement:
                    logger.info(f"[save_annotation] Created new structured array dataset (chunks={optimal_chunk_size})")
            
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
                    new_data_neg['cell_class'] = exclude_cell_class
                    new_data_neg['cell_color'] = gray_int
                    new_data_neg['datetime'] = now_ts
                    new_data_neg['region_x1'] = region_x1
                    new_data_neg['region_y1'] = region_y1
                    new_data_neg['region_x2'] = region_x2
                    new_data_neg['region_y2'] = region_y2
                    new_data_neg['method'] = method_neg
                    new_data_neg['annotator'] = annotator_neg
                    annotations_dataset[valid_indices_neg] = new_data_neg
                    logger.info(f"[save_annotation] Saved nuclei negative selection: {len(valid_indices_neg)} cells, cell_class={exclude_cell_class} (exclude class {class_index_neg})")
                handler.invalidate_user_counts_cache()
                try:
                    if handler.zarr_file and os.path.exists(handler.zarr_file):
                        _sync = getattr(handler, '_zarr_synchronizer', None) or get_zarr_synchronizer(handler.zarr_file)
                        with zarr.open(handler.zarr_file, 'r', synchronizer=_sync) as zarr_file:
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
                            logger.info(f"[save_annotation] Class '{classification}' not found in class_names, added dynamically with index {class_id}")
                    
                    new_data['cell_class'] = class_id
                    new_data['cell_color'] = color_int
                    new_data['annotator'] = annotator
                    new_data['datetime'] = now_timestamp
                    new_data['method'] = method
                    new_data['region_x1'] = region_x1
                    new_data['region_y1'] = region_y1
                    new_data['region_x2'] = region_x2
                    new_data['region_y2'] = region_y2
                    
                    # Read OLD cell_class values BEFORE overwriting to track class count changes
                    # This ensures class_counts stays in sync when cells are re-annotated
                    try:
                        old_class_ids = annotations_dataset['cell_class'][valid_indices].copy()
                        logger.info(f"[save_annotation] Read {len(old_class_ids)} old cell_class values for count tracking")
                    except Exception as e:
                        logger.warning(f"[save_annotation] Could not read old cell_class values: {e}")
                        old_class_ids = None
                    
                    # Strategy selection based on update size and pattern
                    # Check if indices form a contiguous range (can use slice for faster access)
                    is_contiguous = (num_updates > 0 and 
                                   valid_indices[-1] - valid_indices[0] + 1 == num_updates and
                                   np.all(np.diff(valid_indices) == 1))
                    
                    if is_contiguous and num_updates > 1000:
                        # Contiguous range: use slice for maximum performance
                        start_idx = int(valid_indices[0])
                        end_idx = int(valid_indices[-1]) + 1
                        logger.info(f"[save_annotation] Contiguous range detected ({start_idx}:{end_idx}), using slice update")
                        
                        # Direct slice assignment - Zarr handles this efficiently
                        annotations_dataset[start_idx:end_idx] = new_data
                        valid_annotations_added = num_updates
                        logger.info(f"[save_annotation] Updated {valid_annotations_added} annotations using contiguous slice update")
                    else:
                        # For non-contiguous updates, use single structured write
                        # Indices are already sorted by np.unique, which helps with cache locality
                        logger.info(f"[save_annotation] Non-contiguous update ({num_updates}/{centroids_len}, {update_ratio:.1%}), using single structured write")
                        
                        # Single write operation - Zarr will handle chunk optimization internally
                        # Sorted indices help Zarr optimize chunk access patterns
                        annotations_dataset[valid_indices] = new_data
                        valid_annotations_added = num_updates
                        logger.info(f"[save_annotation] Updated {valid_annotations_added} annotations using single structured write (deduplicated from {len(matching_indices)} indices)")

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
                        
                        if decremented_classes:
                            logger.info(f"[save_annotation] Decremented counts for re-annotated cells: {decremented_classes}")
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
            logger.info(f"[save_annotation] Saving class_counts: {counts_dict}")
            
            # Optimization: Directly overwrite dataset if it exists (faster than delete+create)
            if counts_ds_name in group_anno:
                # Check if size matches - if so, we can overwrite in-place
                existing_ds = group_anno[counts_ds_name]
                if existing_ds.shape == () and len(counts_bytes) <= existing_ds.nbytes:
                    # Can overwrite in-place for scalar datasets
                    existing_ds[()] = counts_bytes
                else:
                    # Size mismatch or not scalar - use safe atomic replacement
                    logger.info(f"[save_annotation] Size mismatch detected for {counts_ds_name}, using atomic replacement")
                    _safe_replace_dataset(group_anno, counts_ds_name, data=counts_bytes)
            else:
                # Create new dataset
                group_anno.create_dataset(counts_ds_name, data=counts_bytes)
            # Zarr 3.x doesn't have flush(), data is automatically synced
            logger.info(f"[save_annotation] Saved updated class_counts to Zarr")
            logger.info(f"[save_annotation] Final user_annotation datasets: {list(group_anno.keys())}")

            # Store class colors in user_annotation metadata for fast access
            # This allows get_cell_classification_data to read colors without traversing the entire array
            if ui_nuclei_classes and ui_nuclei_colors:
                group_anno.attrs['class_names'] = ui_nuclei_classes
                group_anno.attrs['class_colors'] = ui_nuclei_colors
                logger.info(f"[save_annotation] Stored {len(ui_nuclei_classes)} class colors in user_annotation metadata")
            elif class_color_map:
                # If UI didn't provide colors but we extracted them, store them
                extracted_classes = list(class_color_map.keys())
                extracted_colors = list(class_color_map.values())
                group_anno.attrs['class_names'] = extracted_classes
                group_anno.attrs['class_colors'] = extracted_colors
                logger.info(f"[save_annotation] Stored {len(extracted_classes)} extracted class colors in user_annotation metadata")

            # Always create/update ClassificationNode when saving nuclei annotations
            # Extract class names and colors from nuclei annotations if not provided via UI
            # Skip expensive array reading if UI already provided classes/colors
            if not ui_nuclei_classes or not ui_nuclei_colors:
                logger.info("[save_annotation] Extracting class names and colors from nuclei annotations")
                
                # Extract unique classes and colors from nuclei annotations (structured array format)
                class_color_map = {}
                if ds_name in group_anno:
                    try:
                        # Optimize: only read cell_class and cell_color fields, not entire array
                        # For large arrays, sample a subset if possible to avoid reading everything
                        # New format: cell_class is integer ID, need to get class_names from metadata
                        class_names = None
                        if 'class_names' in group_anno.attrs:
                            class_names = group_anno.attrs.get('class_names', [])
                        
                        if not class_names:
                            # No metadata, can't build color map
                            logger.warning("[save_annotation] No class_names in metadata, skipping color map extraction")
                        else:
                            array_size = annotations_dataset.shape[0]
                            if array_size > 100000:
                                # For very large arrays, sample first 10K non-empty entries for speed
                                sample_size = min(10000, array_size)
                                cell_class_ids_sample = annotations_dataset['cell_class'][:sample_size]
                                cell_color_sample = annotations_dataset['cell_color'][:sample_size]
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
                                cell_class_ids = annotations_dataset['cell_class'][:]
                                cell_color_data = annotations_dataset['cell_color'][:]
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
                    logger.info(f"[save_annotation] Extracted class names: {ui_nuclei_classes}")
                if not ui_nuclei_colors and class_color_map:
                    ui_nuclei_colors = list(class_color_map.values())
                    logger.info(f"[save_annotation] Extracted class colors: {ui_nuclei_colors}")
                
                # Ensure 'Negative control' exists and is first
                if ui_nuclei_classes:
                    # Use set for O(1) membership check
                    classes_set = set(ui_nuclei_classes)
                    if 'Negative control' not in classes_set:
                        ui_nuclei_classes = ['Negative control'] + ui_nuclei_classes
                        ui_nuclei_colors = ['#aaaaaa'] + ui_nuclei_colors  # Default color for negative control
                        logger.info(f"[save_annotation] Added 'Negative control' to class names: {ui_nuclei_classes}")
                        logger.info(f"[save_annotation] Added 'Negative control' to class colors: {ui_nuclei_colors}")
                    elif ui_nuclei_classes[0] != 'Negative control':
                        # Move to front if not already - use set for fast lookup
                        nc_index = ui_nuclei_classes.index('Negative control')
                        nc_color = ui_nuclei_colors[nc_index] if nc_index < len(ui_nuclei_colors) else '#aaaaaa'
                        # Use list comprehension with set for efficient filtering
                        ui_nuclei_classes = ['Negative control'] + [n for n in ui_nuclei_classes if n != 'Negative control']
                        ui_nuclei_colors = [nc_color] + [c for i, c in enumerate(ui_nuclei_colors) if i != nc_index]
                        logger.info(f"[save_annotation] Moved 'Negative control' to front: {ui_nuclei_classes}")
                        logger.info(f"[save_annotation] Moved 'Negative control' color to front: {ui_nuclei_colors}")
            
            # Note: ClassificationNode is created/updated by task node (classification task), not by save_annotation
            # We only update user_annotation.attrs['class_colors'] here for fast access during get_cell_classification_data

        # 4. Zarr file has been updated in-place, no need for file replacement
        logger.info(f"[save_annotation] Successfully updated Zarr file in-place: {zarr_path}")
        
        # Invalidate user counts cache to ensure fresh data
        logger.info(f"[save_annotation] Invalidating user counts cache")
        handler.invalidate_user_counts_cache()
        
        # Always re-apply manual annotations after saving to ensure handler state is synchronized
        # This is critical to ensure frontend refresh gets the latest annotation state
        try:
            if handler.zarr_file and os.path.exists(handler.zarr_file):
                reload_start = time.time()
                if handler._zarr_synchronizer is None:
                    from app.services.data import get_zarr_synchronizer
                    handler._zarr_synchronizer = get_zarr_synchronizer(handler.zarr_file)
                
                with zarr.open(handler.zarr_file, 'r', synchronizer=handler._zarr_synchronizer) as zarr_file:
                    handler._apply_manual_nuclei_annotations(zarr_file)
                    logger.info(f"[save_annotation] Re-applied manual annotations after save")
                
                handler._zarr_file_obj = zarr.open(handler.zarr_file, 'r', synchronizer=handler._zarr_synchronizer)
                reload_time = time.time() - reload_start
                logger.info(f"[save_annotation] Annotation application completed in {reload_time:.3f}s")
                
                # IMPORTANT: Reset _needs_reload flag after successfully re-applying annotations
                # This prevents the WebSocket from triggering another load_file which could
                # cause race conditions and overwrite the class counts we just saved
                handler._needs_reload = False
                logger.info(f"[save_annotation] Reset _needs_reload flag to prevent redundant reloads")
        except Exception as apply_error:
            logger.error(f"[save_annotation] Failed to re-apply manual annotations: {apply_error}. Handler state may be out of sync with Zarr file.")
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


def save_tissue(handler, req: dict, background_tasks=None):
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
                 print(f"[save_tissue] Parsed {len(polygon_points)} polygon vertices.")
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
    # Use device-scoped handler

    try:
        # Ensure patch data is loaded for the correct file

        if not hasattr(handler, 'patch_coordinates') or handler.patch_coordinates is None:
            raise ValueError("Patch coordinates data could not be loaded from Zarr.")

        original_patch_coords_level0 = np.array(handler.patch_coordinates)
        total_patches = len(original_patch_coords_level0)

        if total_patches > 0:
            patch_x1 = original_patch_coords_level0[:, 0]
            patch_y1 = original_patch_coords_level0[:, 1]
            patch_x2 = original_patch_coords_level0[:, 2]
            patch_y2 = original_patch_coords_level0[:, 3]
            print(f"[DEBUG] save_tissue - Patch coords Min/Max X1: {np.min(patch_x1)} / {np.max(patch_x1)}")
            print(f"[DEBUG] save_tissue - Patch coords Min/Max Y1: {np.min(patch_y1)} / {np.max(patch_y1)}")

            # calculate patch centroids
            patch_centroids_x = np.mean(original_patch_coords_level0[:, [0, 2]], axis=1)
            patch_centroids_y = np.mean(original_patch_coords_level0[:, [1, 3]], axis=1)

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

    # ... (Rest of the Zarr saving logic using temp file - this part seems okay) ...
    # It correctly iterates through `matching_indices` and saves info to `tissue_annotations` dataset.
    try:
        # Work directly with the zarr file without copying
        # Use cached synchronizer for concurrent access safety
        from app.services.data import get_zarr_synchronizer
        synchronizer = get_zarr_synchronizer(zarr_path)
        print(f"[save_tissue] Working directly with Zarr file: {zarr_path}")
        with zarr.open(zarr_path, "a", synchronizer=synchronizer) as zf:
            # ... (get or create user_annotation group) ...
            ann_group_path = "user_annotation"
            group_anno = zf.require_group(ann_group_path)
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

                # If we are changing the classification, calculate the delta (negative selection does not increment any class)
                if previous_class != classification:
                    if previous_class is not None:
                        count_deltas[previous_class] -= 1 # Decrement old class count
                    if classification is not None:
                        count_deltas[classification] += 1 # Increment new class count (skip for negative selection)

                now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                new_item = {
                    "patch_ID": int(idx),
                    "tissue_class": classification,  # None for negative selection
                    "annotator": annotator,
                    "datetime": now_str,
                    "method": method,
                }
                if exclude_classes:
                    new_item["exclude_classes"] = list(exclude_classes)
                # For negative selection or when color is needed for display, store tissue_color
                if color and (classification is None or exclude_classes):
                    new_item["tissue_color"] = color
                existing_dict[key] = new_item # This overwrites any previous entry for the same patch

            print(f"[save_tissue] Added/Updated {len(matching_indices)} annotations based on matching_indices.")
            # ... (save updated existing_dict back to dataset) ...
            out_str = json.dumps(existing_dict, ensure_ascii=False)
            if ds_name in group_anno: del group_anno[ds_name]
            dset = group_anno.create_dataset(ds_name, data=out_str.encode("utf-8"))
            print(f"[save_tissue] Saved updated annotations to dataset '{ds_name}' in group '{ann_group_path}'.")
            print(f"[save_tissue] Dataset path: {ann_group_path}/{ds_name}")
            print(f"[save_tissue] Total annotations saved: {len(existing_dict)}")
            # Zarr 3.x doesn't have flush(), data is automatically synced
            pass

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
            # Zarr 3.x doesn't have flush(), data is automatically synced
            pass
            print(f"[save_tissue] Saved updated patch_class_counts to Zarr")
            
            # Update colormap (similar to nuclei): user_annotation.attrs['tissue_class_colors'] and ['tissue_class_names']
            # This ensures colors are stored in colormap format, not in each annotation
            # Strategy: Similar to save_annotation, prioritize handler data, then user_annotation, then patch group
            
            # First, try to get complete class list from handler (most reliable source)
            tissue_class_names = []
            tissue_class_colors = []
            
            if hasattr(handler, 'patch_class_name') and handler.patch_class_name is not None:
                # Convert handler data to lists
                handler_class_names = handler.patch_class_name
                handler_class_colors = handler.patch_class_hex_color if hasattr(handler, 'patch_class_hex_color') and handler.patch_class_hex_color is not None else None
                
                if isinstance(handler_class_names, np.ndarray):
                    handler_class_names = handler_class_names.tolist()
                if handler_class_colors is not None and isinstance(handler_class_colors, np.ndarray):
                    handler_class_colors = handler_class_colors.tolist()
                
                # Decode bytes if necessary
                handler_class_names = [
                    name.decode('utf-8') if isinstance(name, bytes) else str(name)
                    for name in handler_class_names
                ]
                if handler_class_colors:
                    handler_class_colors = [
                        color.decode('utf-8') if isinstance(color, bytes) else str(color)
                        for color in handler_class_colors
                    ]
                
                # Use handler data as base (contains all classes from model + manual annotations)
                tissue_class_names = list(handler_class_names)
                tissue_class_colors = list(handler_class_colors) if handler_class_colors else []
                print(f"[save_tissue] Using handler data: {len(tissue_class_names)} classes")
            
            # Then, load existing colormap from user_annotation and merge (preserve user-defined colors)
            user_class_names = list(group_anno.attrs.get('tissue_class_names', []))
            user_class_colors = list(group_anno.attrs.get('tissue_class_colors', []))
            
            if user_class_names:
                # Merge user_annotation colors into handler data (user colors take priority)
                for user_name, user_color in zip(user_class_names, user_class_colors):
                    if user_name in tissue_class_names:
                        # Update existing class color with user-defined color
                        class_index = tissue_class_names.index(user_name)
                        if class_index < len(tissue_class_colors):
                            tissue_class_colors[class_index] = user_color
                        else:
                            tissue_class_colors.append(user_color)
                        print(f"[save_tissue] Using user-defined color '{user_color}' for class '{user_name}'")
                    else:
                        # Add new class from user_annotation
                        tissue_class_names.append(user_name)
                        tissue_class_colors.append(user_color)
                        print(f"[save_tissue] Added class '{user_name}' from user_annotation")
            
            # Fallback: Also load original class information from patch group (if handler data not available)
            if not tissue_class_names:
                patch_group_path = None
                for possible_path in ['patch', 'patches', 'tissue_segmentation']:
                    if possible_path in zf:
                        patch_group_path = possible_path
                        break
                
                if patch_group_path:
                    patch_group = zf[patch_group_path]
                    if hasattr(patch_group, 'attrs'):
                        # Load original class names and colors from patch group
                        original_class_names = patch_group.attrs.get('tissue_class_name', [])
                        original_class_colors = patch_group.attrs.get('tissue_class_HEX_color', [])
                        
                        # Convert to lists and decode bytes if necessary
                        if isinstance(original_class_names, np.ndarray):
                            original_class_names = original_class_names.tolist()
                        if isinstance(original_class_colors, np.ndarray):
                            original_class_colors = original_class_colors.tolist()
                        
                        # Decode bytes to strings
                        original_class_names = [
                            name.decode('utf-8') if isinstance(name, bytes) else str(name)
                            for name in original_class_names
                        ]
                        original_class_colors = [
                            color.decode('utf-8') if isinstance(color, bytes) else str(color)
                            for color in original_class_colors
                        ]
                        
                        tissue_class_names = list(original_class_names)
                        tissue_class_colors = list(original_class_colors)
                        print(f"[save_tissue] Using patch group data: {len(tissue_class_names)} classes")
            
            # Ensure colors list length matches names list length
            while len(tissue_class_colors) < len(tissue_class_names):
                tissue_class_colors.append("#aaaaaa")  # Default gray for missing colors
            if len(tissue_class_colors) > len(tissue_class_names):
                tissue_class_colors = tissue_class_colors[:len(tissue_class_names)]
            
            # Now update/add the current classification (skip for negative selection, i.e. classification is None)
            if classification is not None and classification not in tissue_class_names:
                # Add new class to colormap
                tissue_class_names.append(classification)
                tissue_class_colors.append(color)
                print(f"[save_tissue] Added new class '{classification}' with color '{color}' to colormap")
            elif classification is not None and classification in tissue_class_names:
                # Update existing class color if provided
                class_index = tissue_class_names.index(classification)
                if color and class_index < len(tissue_class_colors) and color != tissue_class_colors[class_index]:
                    tissue_class_colors[class_index] = color
                    print(f"[save_tissue] Updated color for class '{classification}' to '{color}' in colormap")
            
            # Final safety check: ensure lists are same length
            min_len = min(len(tissue_class_names), len(tissue_class_colors))
            tissue_class_names = tissue_class_names[:min_len]
            tissue_class_colors = tissue_class_colors[:min_len]
            
            # Save updated colormap
            group_anno.attrs['tissue_class_names'] = tissue_class_names
            group_anno.attrs['tissue_class_colors'] = tissue_class_colors
            group_anno.attrs['last_updated'] = time.time()
            print(f"[save_tissue] Updated colormap with {len(tissue_class_names)} classes")

            # Re-apply manual patch annotations on handler so next get_patches returns correct colors (avoids flash to negative control)
            try:
                handler._apply_manual_patch_annotations(zf)
            except Exception as apply_err:
                print(f"[save_tissue] Warning: failed to re-apply manual patch annotations on handler: {apply_err}")

        # Work directly with zarr file - no need to replace
        print(f"[save_tissue] Successfully updated Zarr file directly.")

        # Invalidate the patch counts cache to ensure freshness on next query
        handler.invalidate_patch_counts_cache()

        return {"success": True, "message": f"Tissue annotation saved for {len(matching_indices)} patches", "matching_indices": matching_indices}

    except Exception as e:
        # Error handling for direct zarr operations
         logger.error(f"Error during save_tissue Zarr operation: {e}")
         traceback.print_exc()
         return {"success": False, "error": str(e)}
    
def run_classification(req: dict):
    """ Run classification after saving annotation """
    zarr_path = resolve_path(req.get("path", ""))
    if not zarr_path or not os.path.exists(zarr_path):
        return {"success": False, "error": "invalid zarr file path"}
    
    try:
        # record start operation
        logger.info(f"Starting classification on: {zarr_path}")
        logger.info(f"Classification parameters: {req}")
        # 1. write parameters to Zarr file's ClassificationNode/userData section
        try:
            with zarr.open(zarr_path, "a") as zf:
                user_data_path = "ClassificationNode/userData"
                node_group = zf.require_group(user_data_path)
                # add nuclei_classes parameter
                if "nuclei_classes" in req and req["nuclei_classes"]:
                    if "nuclei_classes" in node_group:
                        del node_group["nuclei_classes"]
                    classes_json = json.dumps(req["nuclei_classes"], ensure_ascii=False)
                    node_group.create_dataset("nuclei_classes", data=classes_json.encode("utf-8"))
                # add nuclei_colors parameter
                if "nuclei_colors" in req and req["nuclei_colors"]:
                    if "nuclei_colors" in node_group:
                        del node_group["nuclei_colors"]
                    colors_json = json.dumps(req["nuclei_colors"], ensure_ascii=False)
                    node_group.create_dataset("nuclei_colors", data=colors_json.encode("utf-8"))
                # add organ parameter
                if "organ" in req:
                    if "organ" in node_group:
                        del node_group["organ"]
                    node_group.create_dataset("organ", data=str(req["organ"]).encode("utf-8"))
                # Zarr 3.x doesn't have flush(), data is automatically synced
            pass
            logger.info("Successfully wrote user parameters to Zarr file")
        except Exception as e:
            logger.error(f"Error writing user parameters: {e}")
            return {"success": False, "error": f"Error writing user parameters: {e}"}
        # 2. Get ClassificationNode information (port and remote_host)
        node_name = "ClassificationNode"
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
                from app.services.register_service import CUSTOM_NODE_SERVICE_REGISTRY
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
        logger.info(f"Calling ClassificationNode /init at {base_url}")
        init_url = f"{base_url}/init"
        try:
            init_resp = requests.post(init_url, json={}, timeout=30)
            init_resp.raise_for_status()
            logger.info("ClassificationNode /init done")
        except Exception as e:
            logger.error(f"Error calling init: {e}")
            return {"success": False, "error": f"Error calling init: {e}"}
        # 3. call ClassificationNode's /read interface, pass zarr path
        logger.info(f"Calling ClassificationNode /read at {base_url}")
        read_url = f"{base_url}/read"
        read_data = {
            "node_name": "ClassificationNode",
            "dependencies": [],
            "zarr_path": zarr_path
        }
        try:
            read_resp = requests.post(read_url, json=read_data, timeout=30)
            read_resp.raise_for_status()
            logger.info("ClassificationNode /read done")
        except Exception as e:
            logger.error(f"Error calling read: {e}")
            return {"success": False, "error": f"Error calling read: {e}"}
        # 4. call ClassificationNode's /execute interface to perform classification
        logger.info(f"Calling ClassificationNode /execute at {base_url}")
        execute_url = f"{base_url}/execute"
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
        
        # Reload all handlers that use this zarr file to pick up the new classification data
        try:
            from app.websocket.segmentation_consumer import device_annotation_handlers
            # Ensure zarr_path has .zarr extension
            reload_zarr_path = zarr_path
            if reload_zarr_path and not reload_zarr_path.endswith('.zarr'):
                reload_zarr_path = f"{reload_zarr_path}.zarr"
            
            # Normalize paths for comparison
            normalized_zarr_path = os.path.normpath(os.path.abspath(reload_zarr_path))
            # Reload all handlers that are using this zarr file
            reloaded_count = 0
            for device_id, handler in device_annotation_handlers.items():
                if handler is not None and hasattr(handler, 'zarr_file') and handler.zarr_file:
                    normalized_handler_path = os.path.normpath(os.path.abspath(handler.zarr_file))
                    if normalized_handler_path == normalized_zarr_path:
                        try:
                            # Invalidate cache to ensure fresh data
                            handler.invalidate_user_counts_cache()
                            # Reload file to pick up new classification data
                            handler.load_file(reload_zarr_path, force_reload=True, reload_segmentation_data=True)
                            reloaded_count += 1
                        except Exception as e:
                            logger.warning(f"Failed to reload handler for device {device_id}: {e}")
            if reloaded_count > 0:
                logger.info(f"Reloaded {reloaded_count} handler(s) after classification completion")
        except Exception as e:
            logger.warning(f"Could not reload handlers after classification: {e}")
        
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

    from app.wrapper import PyvipsSlideWrapper

    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File {file_path} not found")

    # Import the file extension detection function
    from app.services.load_service import get_file_extension
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
        from app.services.load_service import smart_load_ndpi_wrapper
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

def get_cell_review_tile_data(req: dict) -> dict:
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
        slide_path = resolved_input_path
        if slide_path.endswith('.zarr'):
            slide_path = slide_path[:-5]  # strip trailing '.zarr'
        # Resolve Zarr path alongside the slide image path
        zarr_path = resolve_path(slide_id if slide_id.endswith('.zarr') else slide_id + '.zarr')

        if not os.path.exists(slide_path):
            return {"success": False, "error": f"Slide file not found: {slide_path}"}

        # Get contour data from Zarr file first
        contour = None
        if os.path.exists(zarr_path):
            contour_data = _get_cell_contour_from_zarr(zarr_path, cell_id)
            if contour_data:
                # Convert to numpy array format
                contour = np.array([[point["x"], point["y"]] for point in contour_data])
        
        if contour is None or len(contour) == 0:
            return {"success": False, "error": f"No contour data found for cell {cell_id}"}
        
        # Detect if this is a z-stack image using SDK wrapper
        is_zstack = False
        num_z_layers = 1
        tiff_wrapper = None
        try:
            tiff_wrapper = TiffFileWrapper(slide_path)
            is_zstack = tiff_wrapper.is_zstack
            num_z_layers = tiff_wrapper.z_layer_count
            if is_zstack and num_z_layers > 1:
                logger.info(f"[Review Tile] Detected z-stack with {num_z_layers} layers for cell {cell_id}")
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
                    logger.info(f"[Review Tile] Generated static image for z-layer {layer_idx} of cell {cell_id}")
                except Exception as e:
                    return {"success": False, "error": f"Failed to read z-layer {fixed_z_layer}: {e}"}
                
            else:
                # Single layer: original logic
                image = slide.read_region(
                    location=(new_coord[0], new_coord[1]), 
                    level=0, 
                    size=(region_width, region_height)
                )
                
                # remove alpha channel and convert to RGBA
                image = Image.fromarray(np.array(image)[..., :3])
                image = image.convert('RGBA')
                layer_images = None  # No multi-layer for single image
            
            # Draw contour on image(s)
            if contour_type is not None:
                # Calculate contour relative coordinates 
                contour_relative = np.copy(contour)
                contour_relative[:, 0] = contour[:, 0] - new_coord[0]
                contour_relative[:, 1] = contour[:, 1] - new_coord[1]
                
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
                logger.info(f"[Review Tile] Generated GIF with {len(processed_layers)} layers for cell {cell_id}")
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
        
        # Get classification data from Zarr file
        if os.path.exists(zarr_path):
            classification_data = _get_cell_classification_from_zarr(zarr_path, cell_id)
            if classification_data:
                response_data.update(classification_data)
        
        return {"success": True, "data": response_data}
        
    except Exception as e:
        logger.error(f"Error in get_cell_review_tile_data: {str(e)}")
        return {"success": False, "error": f"Error generating cell review tile: {str(e)}"}

def _get_cell_classification_from_zarr(zarr_path: str, cell_id: str) -> Optional[Dict]:
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
        with zarr.open(zarr_path, 'r') as zf:
            # Look for classification data in ClassificationNode
            if 'ClassificationNode' in zf:
                class_group = zf['ClassificationNode']
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
                if 'user_annotation' in zf:
                    try:
                        user_group = zf['user_annotation']
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
                
            logger.info(f"No classification data found for cell {cell_id} in Zarr file")
            return None
            
    except Exception as e:
        logger.warning(f"Error reading classification from Zarr file {zarr_path}: {str(e)}")
        return None

def _get_cell_contour_from_zarr(zarr_path: str, cell_id: str) -> Optional[List[Dict[str, float]]]:
    """
    Helper function to retrieve cell contour from Zarr file.
    Reads contour data from SegmentationNode/contours dataset.
    
    Args:
        zarr_path: Path to Zarr file
        cell_id: String representation of cell index
        
    Returns:
        List of contour points as [{"x": float, "y": float}] or None if not found
    """
    try:
        with zarr.open(zarr_path, 'r') as zf:
            # Look for segmentation data in SegmentationNode
            if 'SegmentationNode' in zf:
                seg_group = zf['SegmentationNode']
                
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
            elif 'NucleiSegmentationNode' in zf:
                # Legacy support for different naming
                nuclei_group = zf['NucleiSegmentationNode']
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
            
            logger.info(f"No contour data found for cell {cell_id} in Zarr file")
            return None
            
    except Exception as e:
        logger.warning(f"Error reading contour from Zarr file {zarr_path}: {str(e)}")
        return None

def reset_zarr_classification_data(zarr_path: str) -> dict:
    """
    Deletes classification and user annotation data from an Zarr file.
    Specifically removes 'ClassificationNode' and 'user_annotation' groups.
    """
    if not os.path.exists(zarr_path):
        return {"status": "error", "message": f"Zarr file not found at {zarr_path}"}
        
    try:
        with zarr.open(zarr_path, 'a') as zf:
            # Delete ClassificationNode if it exists
            classification_node_name = "ClassificationNode"
            if classification_node_name in zf:
                del zf[classification_node_name]
                print(f"Deleted group '{classification_node_name}' from {zarr_path}")

            # Delete user_annotation group if it exists
            user_annotation_group_name = "user_annotation"
            if user_annotation_group_name in zf:
                del zf[user_annotation_group_name]
                print(f"Deleted group '{user_annotation_group_name}' from {zarr_path}")

        # After deleting from Zarr, reload all handlers that use this file
        try:
            from app.websocket.segmentation_consumer import device_annotation_handlers
            # Normalize paths for comparison
            normalized_zarr_path = os.path.normpath(os.path.abspath(zarr_path))
            # Reload all handlers that are using this zarr file
            reloaded_count = 0
            for device_id, handler in device_annotation_handlers.items():
                if handler is not None and hasattr(handler, 'zarr_file') and handler.zarr_file:
                    normalized_handler_path = os.path.normpath(os.path.abspath(handler.zarr_file))
                    if normalized_handler_path == normalized_zarr_path:
                        try:
                            print(f"Reloading handler for device {device_id} after reset classification")
                            
                            # Clear handler state first to ensure clean reset
                            # This is important because reset deleted ClassificationNode and user_annotation,
                            # so handler should start fresh
                            handler.class_id = None
                            handler.class_name = None
                            handler.class_hex_color = None
                            # IMPORTANT: Clear all caches to ensure fresh data after reset
                            handler.invalidate_user_counts_cache()
                            # Also explicitly clear global label counts cache
                            if hasattr(handler, '_global_label_counts_cache'):
                                handler._global_label_counts_cache = None
                            # Clear viewport cache to ensure fresh annotation data
                            if hasattr(handler, '_viewport_cache'):
                                handler._viewport_cache.clear()
                            print(f"[reset] Cleared all caches for device {device_id} after reset")
                            
                            # Reload file (this will load from ClassificationNode if it exists, or initialize defaults)
                            handler.load_file(zarr_path, force_reload=True, reload_segmentation_data=True)
                            
                            # After reload, re-apply manual annotations to ensure handler state is correct
                            # This is important because reset may have deleted user_annotation, but we need to
                            # ensure handler's class_id, class_name, class_hex_color are properly reset
                            try:
                                if handler.zarr_file and os.path.exists(handler.zarr_file):
                                    from app.services.data import get_zarr_synchronizer
                                    if handler._zarr_synchronizer is None:
                                        handler._zarr_synchronizer = get_zarr_synchronizer(handler.zarr_file)
                                    
                                    with zarr.open(handler.zarr_file, 'r', synchronizer=handler._zarr_synchronizer) as zarr_file:
                                        handler._apply_manual_nuclei_annotations(zarr_file)
                                    
                                    # Update cached file object
                                    handler._zarr_file_obj = zarr.open(handler.zarr_file, 'r', synchronizer=handler._zarr_synchronizer)
                                    print(f"Re-applied manual annotations for device {device_id} after reset")
                            except Exception as e:
                                print(f"Warning: Failed to re-apply manual annotations for device {device_id}: {e}")
                            
                            reloaded_count += 1
                        except Exception as e:
                            print(f"Warning: Failed to reload handler for device {device_id}: {e}")
            print(f"Reloaded {reloaded_count} handler(s) after reset classification for {zarr_path}")
        except Exception as e:
            print(f"Warning: Could not reload handlers after reset: {e}")
            # Fallback to old method
            try:
                from app.services.seg_service import clear_all_caches_and_reset_handler
                clear_all_caches_and_reset_handler()
                print(f"Forcefully reset all caches in seg_service for {zarr_path}")
            except ImportError as import_e:
                print(f"Could not import or call clear_all_caches_and_reset_handler: {import_e}")
        
        # Clear all reclassifications from active learning memory
        # MULTI-USER: For reset operation, we need to clear ALL instances
        try:
            from app.services.review import _reclassified_cells, _temporary_cells
            # Extract slide_id from zarr_path (remove .zarr extension if present)
            slide_id = zarr_path.replace('.zarr', '') if zarr_path.endswith('.zarr') else zarr_path
            zarr_path_key = slide_id + '.zarr' if not slide_id.endswith('.zarr') else slide_id
            
            # Clear for ALL instances
            total_cleared = 0
            for instance_id in list(_reclassified_cells.keys()):
                if zarr_path_key in _reclassified_cells[instance_id]:
                    total_cleared += len(_reclassified_cells[instance_id][zarr_path_key])
                    del _reclassified_cells[instance_id][zarr_path_key]
            for instance_id in list(_temporary_cells.keys()):
                if zarr_path_key in _temporary_cells[instance_id]:
                    total_cleared += len(_temporary_cells[instance_id][zarr_path_key])
                    del _temporary_cells[instance_id][zarr_path_key]
            
            print(f"Cleared {total_cleared} reclassified cells from active learning memory (all instances)")
        except Exception as e:
            print(f"Warning: Could not clear active learning reclassifications: {e}")
            
        return {"status": "success", "message": "Successfully reset classification and user annotations in Zarr file."}
    except Exception as e:
        error_message = f"An error occurred while resetting Zarr file: {e}"
        print(f"{error_message}\n{traceback.format_exc()}")
        return {"status": "error", "message": error_message}

def reset_patch_classification_data(zarr_path: str) -> dict:
    """
    Remove patch classification datasets under MuskNode (keys starting with 'tissue_')
    and remove the 'user_annotation' group. Preserve MuskNode embedding datasets
    (embedding, coordinates, probability, output).
    """
    try:
        if not os.path.exists(zarr_path):
            return {"status": "error", "message": f"Zarr file not found at {zarr_path}"}

        removed = []
        with zarr.open(zarr_path, 'a') as zf:
            # Remove user annotations entirely
            if 'user_annotation' in zf:
                del zf['user_annotation']
                removed.append('user_annotation')

            # Remove tissue_* datasets under MuskNode only
            if 'MuskNode' in zf:
                grp = zf['MuskNode']
                to_delete = []
                for key in list(grp.keys()):
                    if str(key).startswith('tissue_'):
                        to_delete.append(key)
                for key in to_delete:
                    del grp[key]
                    removed.append(f"MuskNode/{key}")
            # Zarr 3.x doesn't have flush(), data is automatically synced
            pass

        # After deleting from Zarr, reload all handlers that use this file
        try:
            from app.websocket.segmentation_consumer import device_annotation_handlers
            # Normalize paths for comparison
            normalized_zarr_path = os.path.normpath(os.path.abspath(zarr_path))
            # Reload all handlers that are using this zarr file
            reloaded_count = 0
            for device_id, handler in device_annotation_handlers.items():
                if handler is not None and hasattr(handler, 'zarr_file') and handler.zarr_file:
                    normalized_handler_path = os.path.normpath(os.path.abspath(handler.zarr_file))
                    if normalized_handler_path == normalized_zarr_path:
                        try:
                            print(f"Reloading handler for device {device_id} after reset patch classification")
                            
                            # Clear handler state first to ensure clean reset
                            # Clear patch classification data (not nuclei classification)
                            handler.patch_class_id = None
                            handler.patch_class_name = None
                            handler.patch_class_hex_color = None
                            handler.invalidate_user_counts_cache()
                            
                            # Reload file
                            handler.load_file(zarr_path, force_reload=True, reload_segmentation_data=True)
                            
                            # After reload, re-apply manual annotations to ensure handler state is correct
                            try:
                                if handler.zarr_file and os.path.exists(handler.zarr_file):
                                    from app.services.data import get_zarr_synchronizer
                                    if handler._zarr_synchronizer is None:
                                        handler._zarr_synchronizer = get_zarr_synchronizer(handler.zarr_file)
                                    
                                    with zarr.open(handler.zarr_file, 'r', synchronizer=handler._zarr_synchronizer) as zarr_file:
                                        handler._apply_manual_nuclei_annotations(zarr_file)
                                    
                                    # Update cached file object
                                    handler._zarr_file_obj = zarr.open(handler.zarr_file, 'r', synchronizer=handler._zarr_synchronizer)
                                    print(f"Re-applied manual annotations for device {device_id} after reset patch classification")
                            except Exception as e:
                                print(f"Warning: Failed to re-apply manual annotations for device {device_id}: {e}")
                            
                            reloaded_count += 1
                        except Exception as e:
                            print(f"Warning: Failed to reload handler for device {device_id}: {e}")
            print(f"Reloaded {reloaded_count} handler(s) after reset patch classification for {zarr_path}")
        except Exception as e:
            print(f"Warning: Could not reload handlers after reset patch classification: {e}")
            # Fallback to old method
            try:
                from app.services.seg_service import clear_all_caches_and_reset_handler
                clear_all_caches_and_reset_handler()
            except Exception:
                pass

        return {"status": "success", "message": "Patch classification data cleared", "removed": removed}
    except Exception as e:
        return {"status": "error", "message": f"Failed to reset patch classification: {e}\n{traceback.format_exc()}"}

def is_file_locked(file_path: str) -> bool:
    """Check if zarr file is locked - zarr files don't use traditional file locking"""
    try:
        # For zarr files, we don't need to check for traditional file locks
        # zarr uses synchronizers for coordination, not file locks
        if file_path.endswith('.zarr') or os.path.isdir(file_path):
            # Just check if the file/directory is accessible
            if os.path.isdir(file_path):
                return not os.access(file_path, os.R_OK)
            else:
                return not os.path.exists(file_path) or not os.access(file_path, os.R_OK)
        else:
            # For non-zarr files, use traditional file locking check
            try:
                with zarr.open(file_path, 'r') as _:
                    return False
            except Exception:
                return True
    except Exception:
        return True

def reset_answer():
    """
    DEPRECATED: Reset the global cur_answer variable to None.
    For legacy compatibility only. New code should use user_workflow_status[uid]['cur_answer'].
    """
    global cur_answer
    cur_answer = None
    
def mark_generating():
    """
    DEPRECATED: Mark the server-side generation flag so /tasks/v1/get_answer returns 'wait'.
    For legacy compatibility only. New code should use user_workflow_status[uid]['is_generating'].
    """
    global is_generating
    is_generating = True

def post_answer(answer: str, uid: str = None):
    """
    Post an answer string and mark generation complete so Chatbox can consume it.
    Now supports both global (legacy) and per-user state.
    
    Args:
        answer: The answer text to post
        uid: Optional user ID. If provided, updates user-specific state.
    """
    global cur_answer, is_generating
    
    # Update global state for backward compatibility
    cur_answer = answer
    is_generating = False
    
    # Update user-specific state if uid is provided
    if uid:
        if uid not in user_workflow_status:
            user_workflow_status[uid] = {}
        user_workflow_status[uid]['cur_answer'] = answer
        user_workflow_status[uid]['is_generating'] = False


def begin_script_summary_wait(uid: Optional[str] = None) -> None:
    """
    Before execute_script runs: block /tasks/v1/get_answer with 'wait' and clear stale cur_answer
    until summary_answer calls post_answer. Avoids racing a JSON execute result against the summary.
    """
    global is_generating, cur_answer
    if uid:
        if uid not in user_workflow_status:
            user_workflow_status[uid] = {}
        user_workflow_status[uid]["is_generating"] = True
        user_workflow_status[uid]["cur_answer"] = None
        user_workflow_status[uid]["script_error_code"] = None
        user_workflow_status[uid]["script_error_message"] = None
    else:
        is_generating = True
        cur_answer = None


def end_script_summary_wait(
    uid: Optional[str] = None,
    error_code: Optional[int] = None,
    error_message: Optional[str] = None,
) -> None:
    """If execute_script aborts before summary_answer, unblock get_answer for this user."""
    global is_generating, cur_answer
    if uid:
        if uid in user_workflow_status:
            user_workflow_status[uid]["is_generating"] = False
            user_workflow_status[uid]["script_error_code"] = error_code
            user_workflow_status[uid]["script_error_message"] = error_message
    else:
        is_generating = False


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


async def start_workflow_from_frontend(frontend_data: dict, uid: str = None, auth_header: str | None = None):
    """
    Start a workflow from frontend data with user isolation
    
    Parameters:
    - frontend_data: Dictionary containing workflow configuration, including zarr_path and step information
    - uid: User ID for session isolation
    
    Returns:
    - On success: {"success": True, "message": "...", "workflow_id": id, "task_info": {...}}
    - On failure: {"success": False, "error": "error message"}
    """
    if not uid:
        return {"success": False, "error": "User ID (uid) is required for workflow execution"}
    
    if "zarr_path" not in frontend_data:
        return {"success": False, "error": "You must provide 'zarr_path'"}

    # Resolve zarr_path to absolute path using STORAGE_ROOT
    from app.utils import resolve_path
    zarr_path = resolve_path(frontend_data["zarr_path"])
    force_override = frontend_data.get("force_override") is True
    
    global current_zarr_path
    current_zarr_path = zarr_path

    # Import scheduler state before active-run checks so force_override can clear stale queue records.
    from app.services.task_scheduler import (
        Task, WorkflowExecution, task_scheduler,
        workflow_executions, user_active_executions, model_current_task
    )

    def _force_clear_active_workflow_for_user(reason: str) -> None:
        """Clear scheduler/UI records for this user's active workflow without killing TaskNode processes."""
        existing_exec_id = user_active_executions.get(uid)
        if existing_exec_id:
            existing_exec = workflow_executions.get(existing_exec_id)
            if existing_exec:
                logger.warning(
                    f"[FORCE_OVERRIDE] Clearing execution {existing_exec_id} for user {uid}: {reason}"
                )
                existing_exec.status = "cancelled"
                for existing_task in existing_exec.tasks.values():
                    if existing_task.status in ["pending", "ready", "running"]:
                        existing_task.status = "cancelled"
                        existing_task.error = "Force overridden by user"
                    if model_current_task.get(existing_task.node_name) == existing_task.task_id:
                        model_current_task[existing_task.node_name] = None
            user_active_executions.pop(uid, None)

        if uid in user_workflow_status:
            user_workflow_status[uid]["status"] = "cancelled"
            user_workflow_status[uid]["is_generating"] = False
            user_workflow_status[uid]["error"] = "Force overridden by user"

        try:
            _recalculate_all_queue_positions()
        except Exception as exc:
            logger.warning(f"[FORCE_OVERRIDE] Queue position recalculation failed: {exc}")
    
    # Check if user already has a workflow running
    if uid in user_workflow_status and user_workflow_status[uid]['status'] in ['running', 'queued', 'cancelling']:
        if not force_override:
            return {
                "success": False,
                "error": f"User {uid} already has a workflow running, queued, or cancelling",
            }
        _force_clear_active_workflow_for_user("user_workflow_status active")
    
    # For simplicity, we'll use the global manager but ensure serial execution through queue
    # Clear any existing workflows in global manager
    manager.clear_workflows()
    logger.info(f"Cleared existing workflows for user {uid}")

    explicit_task_deps_raw = frontend_data.get("task_dependencies")
    explicit_task_deps: Optional[Dict[str, List[str]]] = None

    if isinstance(explicit_task_deps_raw, dict):
        explicit_task_deps = {
            str(k).strip(): [str(x).strip() for x in (v or [])]
            for k, v in explicit_task_deps_raw.items()
        }

    steps_data = {
        k: v
        for k, v in frontend_data.items()
        if k not in ("zarr_path", "task_dependencies", "force_override")
    }
    steps = list(steps_data.items())
    steps.sort(key=lambda x: x[0])  # sort step1, step2...

    node_names = []
    node_inputs = {}

    script_prompt = None  # store script prompt
    script_seen = False

    for stepKey, stepVal in steps:
        panel_type = stepVal["nodeId"] # This is TaskNodeManager registry node id from frontend
        userInput = stepVal.get("input", None)
        if userInput is None:
            userInput = {}

        # find the script model
        if panel_type == "GPT-4o Agent":
            raw_prompt = userInput.get("prompt", None)
            normalized_prompt = None
            if isinstance(raw_prompt, str):
                stripped = raw_prompt.strip()
                normalized_prompt = stripped if stripped else None
            elif raw_prompt not in (None, ""):
                normalized_prompt = raw_prompt

            script_prompt = normalized_prompt
            userInput["prompt"] = script_prompt
            print(f"script_prompt: {script_prompt}")
            if script_prompt is not None:
                node_execution_status["GPT-4o Agent"] = 0  # Initialize to "not started"
                script_seen = True
            else:
                node_execution_status.pop("GPT-4o Agent", None)
                try:
                    if hasattr(update_node_progress, "node_progress"):
                        update_node_progress.node_progress.pop("GPT-4o Agent", None)
                except Exception:
                    pass
            continue

        actual_node_name_for_zarr = panel_type.strip()

        if actual_node_name_for_zarr not in manager.nodes:
            return {"success": False, "error": f"Node '{actual_node_name_for_zarr}' not found in manager. Make sure it's already created & running."}

        node_names.append(actual_node_name_for_zarr) # Use the actual name for dependency chain
        node_inputs[actual_node_name_for_zarr] = userInput # Use actual name as key for Zarr writing

    # Special handling for CodingAgent-only workflow
    if len(node_names) == 0 and script_prompt is not None:
        # CodingAgent-only workflow: create a special workflow ID and skip TaskNodeManager
        logger.info("Detected CodingAgent-only workflow, bypassing TaskNodeManager")
        wf_id = -1  # Special ID for CodingAgent-only workflows (negative to avoid collision)
        matching_wf_id = wf_id
    else:
        # Regular workflow with actual tasknodes
        if explicit_task_deps is not None:
            for target, deps in explicit_task_deps.items():
                if target not in node_names:
                    return {"success": False, "error": f"task_dependencies key '{target}' is not in workflow nodes {node_names}"}
                for d in deps:
                    if d not in node_names:
                        return {"success": False, "error": f"task_dependencies['{target}'] references unknown node '{d}'"}
                    dep_res = _add_dependency_internal(d, target)
                    if "error" in dep_res:
                        return {"success": False, "error": dep_res["error"]}
        else:
            # add_dependency: linear chain from step order
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

        if matching_wf_id is None and explicit_task_deps is not None and node_names:
            try:
                topo_order = _topological_sort_explicit_node_list(node_names, explicit_task_deps)
                synth = (max(manager.workflows.keys(), default=0) + 1) if manager.workflows else 1
                manager.workflows[synth] = topo_order
                matching_wf_id = synth
                logger.info(f"Synthetic workflow id={synth} for explicit deps: {topo_order}")
            except ValueError as e:
                return {"success": False, "error": str(e)}

        if matching_wf_id is None:
            return {"success": False, "error": f"cannot find the workflow that matches the requested nodes: {node_names}"}

    # use the found matching workflow ID
    wf_id = matching_wf_id
    logger.info(f"select the workflow to execute for user {uid}: ID={wf_id}, nodes={manager.workflows.get(wf_id, [])}")

    # Initialize user workflow status
    user_workflow_status[uid] = {
        "status": "queued",
        "position": workflow_queue.qsize() + 1,
        "wf_id": wf_id,
        "node_status": {},
        "node_progress": {},
        "zarr_path": zarr_path,
        "auth_header": auth_header
    }
    
    # Create backup of Zarr file before workflow execution
    backup_path = create_workflow_backup(zarr_path, wf_id)
    if backup_path:
        logger.info(f"Created backup for workflow {wf_id}: {backup_path}")
    else:
        logger.warning(f"Failed to create backup for workflow {wf_id}")
    
    # Also prepare execution-time zarr_group mapping for this run
    try:
        nodes_meta = model_store.get_nodes_extended()
        if isinstance(nodes_meta, dict) and hasattr(manager, 'zarr_group_by_node'):
            for n in node_names:
                meta = nodes_meta.get(n, {}) if isinstance(nodes_meta, dict) else {}
                if isinstance(meta, dict) and meta.get('zarr_group'):
                    manager.zarr_group_by_node[n] = meta.get('zarr_group')
    except Exception:
        pass

    # Prepare script prompt
    normalized_script_prompt = None
    if script_seen:
        trimmed_prompt = script_prompt.strip() if isinstance(script_prompt, str) else ""
        normalized_script_prompt = trimmed_prompt if trimmed_prompt != "" else " "

    script_requested = normalized_script_prompt is not None

    # Check if user already has an active workflow
    if uid in user_active_executions:
        existing_exec_id = user_active_executions[uid]
        existing_exec = workflow_executions.get(existing_exec_id)
        if existing_exec and existing_exec.status in ['running', 'queued', 'cancelling']:
            if not force_override:
                logger.warning(f"User {uid} already has an active workflow: {existing_exec_id}")
                return {
                    "success": False,
                    "error": "You already have a workflow running, queued, or cancelling. Please wait for it to finish stopping first."
                }
            _force_clear_active_workflow_for_user(f"active scheduler execution {existing_exec_id}")

    # Ensure scheduler is running
    if not task_scheduler.running:
        await task_scheduler.start()

    # Create execution ID
    timestamp = int(time.time() * 1000)
    execution_id = f"{uid}_{wf_id}_{timestamp}"

    # Get topological execution order for dependencies
    execution_order = manager.topological_sort_workflow(node_names) if node_names else []

    # Create Task objects for each node
    tasks = {}
    for node_name in node_names:
        node = manager.nodes[node_name]
        if explicit_task_deps is not None:
            raw_deps = explicit_task_deps.get(node_name) or []
            dep_list = [d for d in raw_deps if d in node_names]
        else:
            dep_list = node.dependencies.copy() if hasattr(node, 'dependencies') else []
        task = Task(
            task_id=f"{execution_id}_{node_name}",
            workflow_id=wf_id,
            node_name=node_name,
            uid=uid,
            zarr_path=zarr_path,
            node_inputs=node_inputs.get(node_name, {}),
            dependencies=dep_list,
            status='pending',
            created_at=time.time()
        )
        tasks[node_name] = task

    # Calculate queue position for this user BEFORE creating execution
    # Count how many tasks with the same model are already running or queued
    queue_positions_by_model = {}
    for node_name in node_names:
        queue_position = 0
        for other_exec in workflow_executions.values():
            if other_exec.status in ['running', 'queued', 'cancelling']:
                # Check if this execution has a task using the same model
                for other_task in other_exec.tasks.values():
                    if other_task.node_name == node_name and other_task.status in ['pending', 'ready', 'running']:
                        queue_position += 1
                        break  # Only count each execution once per model
        queue_positions_by_model[node_name] = queue_position

    # Determine overall workflow status: if any task is queued, status is 'queued'
    max_queue_position = max(queue_positions_by_model.values()) if queue_positions_by_model else 0
    workflow_status = 'queued' if max_queue_position > 0 else 'running'

    # Create WorkflowExecution instance with correct status
    execution = WorkflowExecution(
        execution_id=execution_id,
        workflow_id=wf_id,
        uid=uid,
        zarr_path=zarr_path,
        auth_header=auth_header,
        tasks=tasks,
        task_dependency_graph=dict(manager.graph),
        completed_tasks=set(),
        failed_tasks=set(),
        status=workflow_status,  # Use calculated status instead of hardcoded 'running'
        script_prompt=normalized_script_prompt,
        created_at=time.time()
    )

    # Register execution
    workflow_executions[execution_id] = execution
    user_active_executions[uid] = execution_id

    # Initialize user_workflow_status for UI compatibility
    user_workflow_status[uid] = {
        "status": workflow_status,
        "wf_id": wf_id,
        "execution_id": execution_id,
        "node_status": {node_name: 0 for node_name in node_names},
        "node_progress": {node_name: 0 for node_name in node_names},
        "queue_positions_by_model": queue_positions_by_model,  # Add per-model queue info
        "overall_queue_position": max_queue_position,
        "zarr_path": zarr_path,
        "auth_header": auth_header,
        "is_generating": script_requested,  # Set to True if CodingAgent is requested
        "cur_answer": None  # Will be populated by _handle_script_generation
    }

    if script_requested:
        user_workflow_status[uid]['node_status']['GPT-4o Agent'] = 0
        user_workflow_status[uid]['node_progress']['GPT-4o Agent'] = 0

    # Ensure zarr file exists (userData is written per-node right before each task runs to avoid overwriting)
    try:
        if not os.path.exists(zarr_path):
            from app.services.data import get_zarr_synchronizer
            synchronizer = get_zarr_synchronizer(zarr_path)
            zarr.open(zarr_path, mode='a', synchronizer=synchronizer)
    except Exception as e:
        logger.error(f"Failed to create zarr file: {e}")
        return {"success": False, "error": f"Failed to create zarr file: {str(e)}"}

    # Scheduler will automatically pick up tasks and execute them
    logger.info(f"Workflow execution {execution_id} submitted for user {uid} with {len(tasks)} tasks")

    return {
        "success": True,
        "message": f"Workflow '{wf_id}' submitted for execution",
        "workflow_id": wf_id,
        "execution_id": execution_id,
        "queue_position": max_queue_position,  # Add queue position info
        "task_info": {
            "wf_id": wf_id,
            "node_inputs": node_inputs,
            "script_prompt": normalized_script_prompt,
            "zarr_path": zarr_path
        }
    }


def get_current_workflow_status(uid: str) -> dict:
    """
    Return current user's workflow status snapshot for frontend restore after page refresh.
    If the user has an active (running or queued) execution, returns execution_id, status,
    node_status, node_progress, queue_position, queue_total. Otherwise returns active=False.
    """
    if uid not in user_workflow_status:
        return {"active": False}
    user_status = user_workflow_status[uid]
    status = user_status.get("status")
    if status not in ("running", "queued", "cancelling"):
        return {"active": False}

    from app.services.task_scheduler import user_active_executions, workflow_executions

    execution_id = user_active_executions.get(uid)
    if not execution_id:
        return {"active": False}

    execution = workflow_executions.get(execution_id)
    if not execution:
        return {"active": False}

    # Ordered step list for panel restore (dict preserves insertion order)
    steps = [{"model": node_name} for node_name in execution.tasks.keys()]
    if "GPT-4o Agent" in user_status.get("node_status", {}):
        steps.append({"model": "GPT-4o Agent"})

    node_status = dict(user_status.get("node_status", {}))
    node_status["_workflow_status"] = "running" if status == "cancelling" else status
    if status == "queued":
        node_status["_queue_position"] = user_status.get("overall_queue_position", 0)
        node_status["_queue_total"] = sum(
            1 for e in workflow_executions.values() if e.status in ("queued", "running", "cancelling")
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
        _dataset_exists_nonempty(zf, "SegmentationNode/centroids")
        or _dataset_exists_nonempty(zf, "nuclei_segmentation/centroids")
        or _dataset_exists_nonempty(zf, "morphology/centroids")
    )
    has_cell_embedding = (
        _dataset_exists_nonempty(zf, "SegmentationNode/probability")
        or _dataset_exists_nonempty(zf, "SegmentationNode/embedding")
        or _dataset_exists_nonempty(zf, "ClassificationNode/embedding")
    )
    has_cell_classification = (
        _dataset_exists_nonempty(zf, "ClassificationNode/nuclei_class_id")
        or _dataset_exists_nonempty(zf, "ClassificationNode/nuclei_class_name")
    )
    has_patch_embedding = (
        _dataset_exists_nonempty(zf, "MuskNode/embedding")
        or _dataset_exists_nonempty(zf, "MuskNode/coordinates")
        or _dataset_exists_nonempty(zf, "MuskNode/probability")
    )
    has_patch_classification = _group_has_prefixed_child(zf, "MuskNode", "tissue_")

    lower_name = (node_name or "").lower()
    if node_name in ("SegmentationNode", "InstanSegNode") or "seg" in lower_name:
        stage["segmentation"] = 100 if has_cell_seg else 0
        stage["embedding"] = 100 if has_cell_embedding else 0
    elif node_name in ("ClassificationNode", "NucleiClassify"):
        stage["segmentation"] = 100 if has_cell_seg else 0
        stage["embedding"] = 100 if has_cell_embedding else 0
        stage["classification"] = 100 if has_cell_classification else 0
    elif node_name == "MuskEmbedding":
        # Embedding-only node: do not tie completion to MuskNode tissue_* class outputs.
        stage["embedding"] = 100 if has_patch_embedding else 0
        stage["classification"] = 0
    elif node_name in ("MuskClassification", "PatchClassifier", "VISTA"):
        stage["embedding"] = 100 if has_patch_embedding else 0
        stage["classification"] = 100 if has_patch_classification else 0
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
    resolved = resolve_path(zarr_path or "")
    if resolved and not str(resolved).lower().endswith(".zarr"):
        resolved = f"{resolved}.zarr"
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
        with zarr.open(resolved, mode="r") as zf:
            nodes_to_eval = requested_nodes or [
                "SegmentationNode",
                "ClassificationNode",
                "MuskEmbedding",
                "MuskClassification",
                "PatchClassifier",
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
        logger.debug("[list_node_ports] begin")
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
            from app.services.register_service import list_custom_node_services
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
            from app.services.model_store import model_store
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

        # Add helpful logging snapshot (debug level)
        try:
            logger.debug(f"[list_node_ports] nodes snapshot: {json.dumps(all_nodes, default=str)[:500]}")
        except Exception:
            pass
        
        return {"success": True, "nodes": all_nodes}

    except Exception as e:
        logger.error(f"Error listing node ports: {str(e)}")
        import traceback
        logger.error(f"[list_node_ports] traceback: {traceback.format_exc()}")
        # CRITICAL: Still return whatever nodes we collected so far.
        # Returning {"success": false} with no nodes causes the frontend to wipe
        # all node state, making every node appear as "Inactive".
        return {"success": True, "nodes": all_nodes}

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
            # Special handling for CodingAgent-only workflow (ID -1)
            if workflow_id == -1:
                # CodingAgent-only workflows are not in manager.workflows, just clear status
                if workflow_id in workflow_run_status:
                    del workflow_run_status[workflow_id]
                cleared_ids.append(workflow_id)
            else:
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
            
            # Reset all user-specific workflow states
            for uid in list(user_workflow_status.keys()):
                user_workflow_status[uid]['is_generating'] = False
                user_workflow_status[uid]['cur_answer'] = None
                user_workflow_status[uid]['status'] = 'cleared'
            
            # Reset global zarr_path tracking
            global current_zarr_path
            current_zarr_path = None
            
            reset_only = True

        return {"success": True, "cleared": cleared_ids, "reset_only": reset_only}
    
    except Exception as e:
        logger.error(f"Error when clearing workflow: {str(e)}")
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

    should_continue = True
    while should_continue:
        try:
            current_statuses = {}
            current_progress = {}

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
                    from app.services.task_scheduler import workflow_executions
                    total_queued = sum(1 for e in workflow_executions.values() if e.status in ['queued', 'running'])
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
                elif user_status['status'] == 'running':
                    current_statuses['_workflow_status'] = 'running'
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
                    
            else:
                # Legacy global status (for backward compatibility)
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

                # Add GPT-4o Agent status if it exists in node_execution_status
                if "GPT-4o Agent" in node_execution_status:
                    status = node_execution_status["GPT-4o Agent"]
                    if status == -2:
                        status = 0
                    current_statuses["GPT-4o Agent"] = status

            # Check if we should send data
            should_send = False
            progress_data = {}
            
            if uid and uid in user_workflow_status:
                user_status = user_workflow_status[uid]['status']
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
                elif user_status == 'running':
                    # For running users, send if status changed OR progress changed
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
            else:
                # Legacy global status - send if statuses changed
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
                        # legacy stopped (-2) treated as not started here
                        else:  # Not started
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
                    logger.error(f"JSON serialization error in SSE: {e}")
                    logger.error(f"current_statuses: {current_statuses}")
                    logger.error(f"progress_data: {progress_data}")
                    # Try to send error message, but don't fail if send fails
                    try:
                        yield f"data: {json.dumps({'error': f'JSON serialization failed: {str(e)}'})}\n\n"
                    except Exception:
                        # If we can't send error, client probably disconnected
                        logger.info(f"SSE client disconnected while sending error for user {uid}")
                        should_continue = False
                        break
                last_status = current_statuses.copy()
                last_progress = progress_data.copy()

            # Check if workflow is completed or has error
            if uid and uid in user_workflow_status:
                user_status = user_workflow_status[uid]['status']
                if user_status in ['completed', 'error']:
                    # Send a final completion message
                    try:
                        payload = {
                            'node_status': current_statuses, 
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
                        logger.error(f"JSON serialization error in completion message: {e}")
                        try:
                            yield f"data: {json.dumps({'error': f'Completion message serialization failed: {str(e)}'})}\n\n"
                        except Exception:
                            # If we can't send error, client probably disconnected
                            logger.info(f"SSE client disconnected while sending completion error for user {uid}")
                    should_continue = False
                    break
            elif current_statuses:  # Legacy mode - only check if there are nodes to monitor
                all_completed = all(status == 2 for status in current_statuses.values())
                if all_completed:
                    # Send a final completion message
                    try:
                        yield f"data: {json.dumps({'node_status': current_statuses, 'workflow_complete': True})}\n\n"
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as conn_err:
                        # Client disconnected, stop sending
                        logger.info(f"SSE client disconnected while sending legacy completion: {conn_err}")
                        should_continue = False
                        break
                    except Exception as send_err:
                        # Other send errors - log and stop
                        logger.warning(f"SSE send error for legacy completion: {send_err}")
                        should_continue = False
                        break
                    should_continue = False
                    break

            # Wait before checking again: longer when nothing to send to avoid busy-loop and free the event loop
            await asyncio.sleep(2 if not should_send else 1)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as conn_err:
            # Client disconnected - this is normal, just log and exit
            logger.info(f"SSE client disconnected for user {uid}: {conn_err}")
            should_continue = False
            break
        except Exception as e:
            logger.error(f"Error in generate_node_status_events: {e}")
            try:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
            except Exception:
                # If we can't send error, client probably disconnected
                logger.info(f"SSE client disconnected while sending error for user {uid}")
            # Terminate on error
            should_continue = False
            break

# Global variables for workflow management
workflow_backups = {}  # Store backup file paths for each workflow
workflow_pids = {}     # Store PIDs of running tasknode processes
workflow_rollback_needed = {}  # Track which workflows need rollback

async def stop_workflow_by_scheduler(uid: str = None, zarr_path: str = None):
    """
    Stop a workflow execution using the new task scheduler.

    Args:
        uid: User ID
        zarr_path: Path to zarr file (optional, for backward compatibility)

    Returns:
        dict: Result with success status and message
    """
    from app.services.task_scheduler import workflow_executions, user_active_executions, model_current_task

    # Find execution_id
    execution_id = None
    if uid and uid in user_active_executions:
        execution_id = user_active_executions[uid]
    elif zarr_path:
        # Find by zarr_path (legacy support)
        for exec_id, execution in workflow_executions.items():
            if execution.zarr_path == zarr_path:
                execution_id = exec_id
                break

    if not execution_id or execution_id not in workflow_executions:
        return {"success": False, "error": "No running workflow found"}

    execution = workflow_executions[execution_id]

    has_running_tasks = any(task.status == 'running' for task in execution.tasks.values())

    # Prevent duplicate cancellation from reporting success before the running node exits.
    if execution.status == 'cancelled' and not has_running_tasks:
        logger.info(f"Workflow {execution_id} is already cancelled")
        return {"success": True, "message": "Workflow is already cancelled"}

    # Pure queue: nothing executing yet — cancel pending/ready and return (no process kill)
    if execution.status == 'queued' and not has_running_tasks:
        execution.status = 'cancelling'
        logger.info(f"Cancelling queued workflow execution {execution_id} for user {execution.uid}")
        for task in execution.tasks.values():
            if task.status in ['pending', 'ready']:
                task.status = 'cancelled'
                logger.info(f"Cancelled queued task {task.task_id} (model: {task.node_name})")
                if model_current_task.get(task.node_name) == task.task_id:
                    model_current_task[task.node_name] = None
        execution.status = 'cancelled'
        if execution.uid in user_workflow_status:
            user_workflow_status[execution.uid]['status'] = 'cancelled'
        if execution.uid in user_active_executions:
            del user_active_executions[execution.uid]
        logger.info(f"[CANCEL_WORKFLOW] Recalculating queue positions after cancelling queued workflow {execution_id}")
        _recalculate_all_queue_positions()
        logger.info(f"Queued workflow execution {execution_id} cancelled successfully")
        return {"success": True, "message": "Queued workflow cancelled"}

    # Already finished — idempotent stop
    if execution.status in ('completed', 'error', 'cancelled') and not has_running_tasks:
        return {"success": True, "message": "Workflow is not active"}

    # Running (or queued with at least one running task): cancel pending work and ask running nodes to stop cooperatively.
    prev_exec_status = execution.status
    execution.status = 'cancelling'
    if execution.uid in user_workflow_status:
        user_workflow_status[execution.uid]['status'] = 'cancelling'
    logger.info(
        f"[CANCEL_WORKFLOW] Cancelling workflow execution {execution_id} for user {execution.uid} "
        f"(execution.status was {prev_exec_status!r}, has_running_tasks={has_running_tasks})"
    )
    for task in execution.tasks.values():
        if task.status in ['pending', 'ready']:
            task.status = 'cancelled'
            logger.info(f"Cancelled task {task.task_id}")
            if model_current_task.get(task.node_name) == task.task_id:
                model_current_task[task.node_name] = None

    def _resolve_tasknode_cancel_host_port(node_name: str) -> tuple[str | None, int | None]:
        """Host + port for Model Zoo tasknode HTTP (POST /cancel). Local uses 127.0.0.1."""
        try:
            from app.services.register_service import CUSTOM_NODE_SERVICE_REGISTRY
            from app.services.model_store import model_store

            is_remote = False
            remote_host = None
            port = None
            for _registry_key, registry_data in CUSTOM_NODE_SERVICE_REGISTRY.items():
                if registry_data.get("model_name") == node_name:
                    is_remote = registry_data.get("is_remote") is True
                    remote_host = registry_data.get("remote_host")
                    port = registry_data.get("port")
                    break
            if port is None:
                nodes_extended = model_store.get_nodes_extended()
                if nodes_extended and node_name in nodes_extended:
                    node_data = nodes_extended[node_name]
                    runtime = node_data.get("runtime") or {}
                    is_remote = runtime.get("is_remote") is True
                    remote_host = remote_host or runtime.get("remote_host")
                    port = port or runtime.get("port")
            if port is None:
                return None, None
            if is_remote and remote_host:
                return str(remote_host), int(port)
            return "127.0.0.1", int(port)
        except Exception as e:
            logger.warning(f"[CANCEL_WORKFLOW] Could not resolve host/port for {node_name}: {e}")
            return None, None

    # Model Zoo tasknodes expose POST /cancel for cooperative interruption (no process kill).
    running_before = [t for t in execution.tasks.values() if t.status == "running"]
    for task in running_before:
        host, port = _resolve_tasknode_cancel_host_port(task.node_name)
        if not host or not port:
            logger.warning(
                f"[CANCEL_WORKFLOW] No HTTP endpoint for {task.node_name}; "
                f"scheduler will clear assignment but tasknode may keep running until idle"
            )
            continue
        cancel_url = f"http://{host}:{port}/cancel"
        try:
            logger.info(f"[CANCEL_WORKFLOW] POST {cancel_url} (task {task.task_id}, model={task.node_name})")
            response = requests.post(cancel_url, json={}, timeout=15)
            response.raise_for_status()
            logger.info(f"[CANCEL_WORKFLOW] /cancel accepted for {task.node_name}")
        except Exception as e:
            logger.error(f"[CANCEL_WORKFLOW] /cancel failed for {task.node_name}: {e}")

    # Allow cooperative shutdown inside the tasknode after /cancel. Do not kill the
    # TaskNode service process and do not release the model queue while /execute is still running.
    max_wait = 10 * 60.0
    start_time = time.time()
    while time.time() - start_time < max_wait:
        running_tasks = [t for t in execution.tasks.values() if t.status == "running"]
        if not running_tasks:
            break
        await asyncio.sleep(0.5)

    still_running = [t for t in execution.tasks.values() if t.status == "running"]
    if still_running:
        message = (
            "Cancellation request was sent, but the running TaskNode has not reached a "
            f"cancel checkpoint yet: {[t.node_name for t in still_running]}"
        )
        logger.warning(f"[CANCEL_WORKFLOW] {message}")
        return {"success": False, "error": message}

    nodes_to_release = {t.node_name for t in running_before}
    for task in execution.tasks.values():
        if task.status == "running":
            logger.warning(
                f"[CANCEL_WORKFLOW] Task {task.task_id} ({task.node_name}) still running after cooperative cancel wait; "
                f"marking cancelled in scheduler"
            )
            task.status = "cancelled"
            task.error = "Workflow was cancelled"
            task.completed_at = time.time()
            nodes_to_release.add(task.node_name)
        if task.status == "cancelled":
            try:
                node_execution_status[task.node_name] = 0
            except Exception:
                pass
    for node_name in nodes_to_release:
        if model_current_task.get(node_name) in {t.task_id for t in running_before if t.node_name == node_name}:
            logger.info(f"[CANCEL_WORKFLOW] Clearing model_current_task for {node_name}")
            model_current_task[node_name] = None

    # Update UI status
    if execution.uid in user_workflow_status:
        user_workflow_status[execution.uid]['status'] = 'cancelled'

    # Mark execution as fully cancelled
    execution.status = 'cancelled'

    # Cleanup
    if execution.uid in user_active_executions:
        del user_active_executions[execution.uid]

    # Recalculate queue positions for all other workflows after cancellation
    # (This helps update positions even if the cancelled workflow was partially running)
    logger.info(f"[CANCEL_WORKFLOW] Recalculating queue positions after cancelling {execution_id}")
    _recalculate_all_queue_positions()

    logger.info(f"Workflow execution {execution_id} cancelled successfully")

    return {"success": True, "message": "Workflow cancelled"}


def _recalculate_all_queue_positions():
    """
    Recalculate queue positions for all active workflows.
    This should be called after a workflow is cancelled to update positions of remaining workflows.
    """
    from app.services.task_scheduler import workflow_executions
    
    logger.info("[RECALCULATE_QUEUE] Starting queue position recalculation")
    
    # Get all active workflows (running or queued)
    active_executions = [
        exec for exec in workflow_executions.values() 
        if exec.status in ['running', 'queued', 'cancelling']
    ]
    
    # Sort by creation time to maintain FIFO order
    active_executions.sort(key=lambda e: e.created_at)
    
    # Recalculate queue positions for each workflow
    for execution in active_executions:
        uid = execution.uid
        if uid not in user_workflow_status:
            continue
            
        # Get all models used by this workflow
        models_used = set(task.node_name for task in execution.tasks.values())
        
        # Calculate queue position for each model
        queue_positions_by_model = {}
        for model_name in models_used:
            queue_position = 0
            # Count how many workflows before this one are using the same model
            for other_exec in active_executions:
                if other_exec.execution_id == execution.execution_id:
                    break  # Stop when we reach current execution (FIFO order)
                if other_exec.status in ['running', 'queued', 'cancelling']:
                    # Check if this execution has a task using the same model
                    for other_task in other_exec.tasks.values():
                        if other_task.node_name == model_name and other_task.status in ['pending', 'ready', 'running']:
                            queue_position += 1
                            break  # Only count each execution once per model
            
            queue_positions_by_model[model_name] = queue_position
        
        # Determine overall workflow status and queue position
        max_queue_position = max(queue_positions_by_model.values()) if queue_positions_by_model else 0
        workflow_status = 'queued' if max_queue_position > 0 else 'running'
        
        # Update user_workflow_status
        if uid in user_workflow_status:
            user_workflow_status[uid]['queue_positions_by_model'] = queue_positions_by_model
            user_workflow_status[uid]['overall_queue_position'] = max_queue_position
            # Only update status if it changed (don't override 'running' to 'queued' if already running)
            if user_workflow_status[uid]['status'] == 'queued' and workflow_status == 'running':
                user_workflow_status[uid]['status'] = 'running'
            elif user_workflow_status[uid]['status'] not in ['running', 'completed', 'error', 'cancelled']:
                user_workflow_status[uid]['status'] = workflow_status
            
            logger.info(f"[RECALCULATE_QUEUE] Updated queue position for user {uid}: position={max_queue_position}, status={workflow_status}")
    
    logger.info(f"[RECALCULATE_QUEUE] Completed queue position recalculation for {len(active_executions)} workflows")


async def stop_workflow_async(zarr_path: str):
    """
    Async version of stop_workflow for use with async API endpoints.

    Args:
        zarr_path: Path to the Zarr file being processed

    Returns:
        dict: Result with success status and message
    """
    from app.services.task_scheduler import workflow_executions

    # Find execution by zarr_path
    for execution_id, execution in workflow_executions.items():
        if execution.zarr_path == zarr_path:
            # Call async version directly
            return await stop_workflow_by_scheduler(uid=execution.uid, zarr_path=zarr_path)

    # If not found in new scheduler, return error (workflow not found or not using new scheduler)
    logger.warning(f"No running workflow found for Zarr file: {zarr_path}")
    return {"success": False, "error": "No running workflow found for this Zarr file"}


def stop_workflow(zarr_path: str):
    """
    Stop the current workflow execution and handle rollback if needed.
    This is the legacy version that works with both old and new queue systems.

    Args:
        zarr_path: Path to the Zarr file being processed

    Returns:
        dict: Result with success status and message
    """
    global current_zarr_path

    # Try new scheduler first
    from app.services.task_scheduler import workflow_executions

    # Find execution by zarr_path
    for execution_id, execution in workflow_executions.items():
        if execution.zarr_path == zarr_path:
            # Use async version
            import asyncio
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # Create task and return immediately
                asyncio.create_task(stop_workflow_by_scheduler(uid=execution.uid, zarr_path=zarr_path))
                return {"success": True, "message": "Workflow cancellation initiated"}
            else:
                return loop.run_until_complete(stop_workflow_by_scheduler(uid=execution.uid, zarr_path=zarr_path))

    # Fall back to legacy logic if not found in new scheduler
    try:
        logger.info(f"Stopping workflow for Zarr file: {zarr_path} (legacy mode)")

        # Find the workflow ID associated with this Zarr file
        workflow_id = None
        for wf_id, status_info in workflow_run_status.items():
            if status_info.get("zarr_path") == zarr_path:
                workflow_id = wf_id
                break

        if workflow_id is None:
            # Try to find by current_zarr_path
            if current_zarr_path == zarr_path:
                # Find any running workflow
                for wf_id, status_info in workflow_run_status.items():
                    if status_info.get("status") == "running":
                        workflow_id = wf_id
                        break

        if workflow_id is None:
            logger.warning(f"No running workflow found for Zarr file: {zarr_path}")
            return {"success": False, "error": "No running workflow found for this Zarr file"}

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

        # Reset user-specific state for all users using this workflow
        for uid, status_info in user_workflow_status.items():
            if status_info.get('wf_id') == workflow_id or status_info.get('zarr_path') == zarr_path:
                user_workflow_status[uid]['is_generating'] = False
                user_workflow_status[uid]['status'] = 'stopped'

        # Reset global zarr_path tracking
        if current_zarr_path == zarr_path:
            current_zarr_path = None
        
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

def create_workflow_backup(zarr_path: str, workflow_id: int):

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
        logger.info(f"[SUCCESS] Successfully tracking PID {pid} for node {node_name} in workflow {workflow_id}")
        logger.info(f"  Current tracked PIDs for workflow {workflow_id}: {workflow_pids[workflow_id]}")
        
    except Exception as e:
        logger.error(f"[ERROR] Error tracking PID: {e}")

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


_recommend_viewport_state_cache: Dict[str, Any] = {}


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
        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            (config.morphology_close_radius * 2 + 1, config.morphology_close_radius * 2 + 1),
        )
        comp_mask = cv2.morphologyEx(comp_mask, cv2.MORPH_CLOSE, kernel)
    if config.fill_holes:
        comp_mask = ndimage.binary_fill_holes(comp_mask).astype(np.uint8)
    if config.remove_small_islands_min_patches > 0:
        labeled, num = ndimage.label(comp_mask)
        for i in range(1, num + 1):
            if np.sum(labeled == i) < config.remove_small_islands_min_patches:
                comp_mask[labeled == i] = 0
    contours, _ = cv2.findContours(comp_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return [], [], {}, {}
    largest_contour = max(contours, key=cv2.contourArea)
    epsilon = config.polygon_simplify_tolerance_px / PATCH
    simplified = cv2.approxPolyDP(largest_contour, epsilon, True)
    polygon = [(float(point[0][0] * PATCH), float(point[0][1] * PATCH)) for point in simplified]
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
        with zarr.open(zarr_path, "r") as zf:
            seg_group = find_segmentation_group(zf)
            if seg_group is None or "centroids" not in seg_group:
                return {"bbox": None, "message": "No centroids in zarr", "round": 0}
            centroids = np.array(seg_group["centroids"][:], dtype=np.float64)
            classification_group = zf.get(ZarrGroups.CLASSIFICATION_NODE)
            if classification_group is None or ZarrDatasets.NUCLEI_CLASS_PROBABILITIES not in classification_group:
                return {"bbox": None, "message": "No nuclei classification probabilities in zarr", "round": 0}
            probs = np.array(classification_group[ZarrDatasets.NUCLEI_CLASS_PROBABILITIES][:], dtype=np.float64)
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
        if binding_value not in _recommend_viewport_state_cache:
            _recommend_viewport_state_cache[binding_value] = _WorkflowState(
                binding_value=binding_value,
                excluded_patch_mask=np.zeros((grid_h, grid_w), dtype=bool),
                skip_until_round={},
            )
        state = _recommend_viewport_state_cache[binding_value]
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
