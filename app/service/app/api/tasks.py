import os
from fastapi import APIRouter, Request, BackgroundTasks, HTTPException, Body, Depends, Query
from fastapi.responses import StreamingResponse
from app.core import logger
from app.core.response import success_response, error_response
from typing import Optional, Dict, Any
from pydantic import BaseModel, ConfigDict
from app.services.tasks_service import (
    workflow_run_status,
    node_execution_status,
    FACTORY_MODEL_DICT,
    manager,
    is_file_locked
)
from app.services.register_service import list_available_conda_envs, stop_custom_node_env, stop_custom_node_process
from app.services.bundles_service import load_catalog as service_load_catalog
from app.services.bundles_service import filter_catalog_for_current_platform as service_filter_catalog
from app.services.bundles_service import generate_signed_url as service_generate_signed_url
from app.services.bundles_service import start_bundle_install as service_start_bundle_install
from app.services.bundles_service import generate_install_events as service_generate_install_events
from app.core.auth import get_auth_user, get_optional_auth_user, AuthUser
from app.services.model_store import model_store
from app.utils import resolve_path
from app.config.path_config import is_public_read_only_path, resolve_virtual_path, STORAGE_ROOT
from app.utils.request import get_client_ip
from app.core.settings import settings
from app.services.tasks_service import (
    post_answer,
    recommend_viewport,
    begin_script_summary_wait,
    end_script_summary_wait,
)
from datetime import datetime
import aiohttp

import asyncio
import zarr
import json
import numpy as np
import base64
import traceback
import subprocess as sp
import platform
import signal
import sys
from concurrent.futures import ProcessPoolExecutor, TimeoutError as FuturesTimeoutError
import requests

try:
    import resource
except ImportError:
    resource = None
try:
    import psutil
except ImportError:
    psutil = None
try:
    import h5py
except ImportError:
    h5py = None

tasks_router = APIRouter()


# Global dict to keep references to running workflow tasks (prevents garbage collection)
_active_workflow_tasks = {}


def _is_electron_client(request: Request) -> bool:
    """Detect if the request is coming from the Electron desktop app vs web browser."""
    # Check for custom header that Electron app sends
    client_type = (request.headers.get("X-Client-Type", "") or request.headers.get("x-client-type", "")).lower()
    if client_type == "electron":
        return True
    
    # Check User-Agent for Electron signature
    user_agent = request.headers.get("User-Agent", "").lower()
    if "electron" in user_agent:
        return True
    
    # Check for local default token (fallback method)
    auth_header = request.headers.get("Authorization", "")
    if "local-default-token" in auth_header.lower():
        return True
    
    return False


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
            "children": {
                key: process_node(key, item)
                for key, item in obj.items()
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


def script_function(script):
    namespace = {}
    try:
        # Execute the code in the isolated namespace
        exec(script, namespace)
        # Return the function object
        return namespace['analyze_medical_image']
    except SyntaxError as e:
        print(f"Syntax error in code: {e}")
        raise ValueError(f"Invalid syntax: {e}")
    except Exception as e:
        print(f"Error executing code: {e}")
        raise ValueError(f"Error in script: {e}")


def _kill_process_tree(pid, timeout=5):
    """
    Kill a process and all its children recursively.
    Returns True if all processes were killed, False otherwise.
    """
    if psutil is None:
        # Fallback: use system commands if psutil is not available
        try:
            # Try to kill the process and its children using pkill
            sp.run(['pkill', '-P', str(pid)], check=False, timeout=timeout)
            sp.run(['kill', '-9', str(pid)], check=False, timeout=2)
            return True
        except Exception:
            return False
    
    try:
        parent = psutil.Process(pid)
        children = parent.children(recursive=True)
        
        # Kill children first
        for child in children:
            try:
                child.terminate()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        
        # Wait for children to die
        gone, still_alive = psutil.wait_procs(children, timeout=timeout)
        
        # Force kill any remaining children
        for child in still_alive:
            try:
                child.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        
        # Finally kill the parent
        try:
            parent.terminate()
            parent.wait(timeout=2)
        except psutil.TimeoutExpired:
            try:
                parent.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        
        return True
    except (psutil.NoSuchProcess, psutil.AccessDenied, Exception):
        return False


def _execute_with_limits(code_str, zarr_path, max_memory_mb=2048, max_cpu_seconds=60):
    """
    Execute the user script in a subprocess with resource limits.
    This function will be called in a separate process via ProcessPoolExecutor.
    
    Args:
        code_str: The Python code string containing analyze_medical_image function
        zarr_path: Path to the Zarr file
        max_memory_mb: Maximum memory in MB (default 2GB)
        max_cpu_seconds: Maximum CPU time in seconds (default 60s)
    
    Returns:
        The result from analyze_medical_image function
    """
    import signal
    import sys
    import traceback
    
    # Set resource limits (Unix-like systems only)
    if resource is not None:
        try:
            # Memory limit (virtual memory)
            max_memory_bytes = max_memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (max_memory_bytes, max_memory_bytes))
            
            # CPU time limit
            resource.setrlimit(resource.RLIMIT_CPU, (max_cpu_seconds, max_cpu_seconds))
            
            # File size limit (prevent huge file writes) - 500MB
            max_file_size = 500 * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_FSIZE, (max_file_size, max_file_size))
        except Exception as e:
            # Resource limits might not work on all platforms (e.g., Windows)
            print(f"Warning: Could not set resource limits: {e}", file=sys.stderr)
    else:
        # On Windows or systems without resource module, we can't set limits
        print(f"Warning: Resource limits not available on {platform.system()}", file=sys.stderr)
    
    # Parse and execute the script
    namespace = {}
    try:
        exec(code_str, namespace)
        func = namespace.get('analyze_medical_image')
        if not func:
            raise ValueError("Script must define 'analyze_medical_image' function")
        
        # Execute the function
        result = func(zarr_path)
        return result
        
    except MemoryError:
        return {"error": "Script exceeded memory limit (2GB)", "error_type": "MemoryError"}
    except Exception as e:
        # Return error as dict so it can be serialized across process boundary
        return {
            "error": str(e),
            "error_type": type(e).__name__,
            "traceback": traceback.format_exc()
        }


@tasks_router.get("/v1/activation/events")
def activation_events():
    """Server-Sent Events stream for all models' activation status."""
    from app.services.tasks_service import generate_all_activation_events
    try:
        return StreamingResponse(
            generate_all_activation_events(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    except Exception as e:
        return error_response(f"Failed to start activation stream: {e}")

@tasks_router.get("/v1/recommend_viewport")
async def recommend_viewport_endpoint(
    request: Request,
    target_class: int = Query(0, description="Target class index for ROI recommendation"),
    selection_mode: str = Query("high_confidence", description="high_confidence | low_confidence"),
):
    """
    Recommend next viewport (ROI) for filter/annotation. Uses tasks_service only (no seg dependency).
    Returns bbox in level0 pixels { x, y, width, height } for frontend fitBounds.
    """
    try:
        file_path = request.query_params.get("relative_path") or request.query_params.get("file_path")
        if file_path:
            file_path = resolve_virtual_path(file_path)
            if not file_path:
                return error_response("Invalid path alias", code=400)
            file_path = resolve_path(file_path)
        if file_path:
            if not os.path.isabs(file_path):
                file_path = os.path.normpath(os.path.join(STORAGE_ROOT, file_path.lstrip("/\\")))
            if not file_path.startswith(os.path.normpath(STORAGE_ROOT)) and (not os.path.isabs(file_path) or not os.path.exists(file_path)):
                return error_response("Path not allowed", code=400)
        if not file_path:
            try:
                from app.services.load_service import current_file_path
                file_path = current_file_path or ""
            except (ImportError, AttributeError):
                file_path = ""
        if not file_path:
            return error_response("No file path provided", code=400)
        zarr_path = file_path if file_path.endswith(".zarr") else f"{file_path}.zarr"
        if not os.path.exists(zarr_path):
            return error_response("Zarr file not found", code=400)
        data = recommend_viewport(zarr_path, target_class=target_class, selection_mode=selection_mode)
        return success_response(data)
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@tasks_router.get("/v1/bundles/catalog")
def get_bundles_catalog():
    try:
        catalog = service_load_catalog()
        filtered = service_filter_catalog(catalog)
        return success_response({"bundles": filtered})
    except Exception as e:
        return error_response(f"Failed to load bundles catalog: {e}")

@tasks_router.post("/v1/bundles/signed_url")
def get_bundle_signed_url(payload: dict = Body(...)):
    try:
        gcs_uri = payload.get("gcs_uri")
        filename = payload.get("filename")
        minutes = int(payload.get("ttl_minutes", 30))
        if not gcs_uri:
            raise HTTPException(status_code=400, detail="Missing gcs_uri")
        res = service_generate_signed_url(gcs_uri, minutes=minutes, filename=filename)
        if res.get("status") != "success":
            raise HTTPException(status_code=500, detail=res.get("message", "Failed to sign URL"))
        return success_response(res)
    except HTTPException:
        raise
    except Exception as e:
        return error_response(f"Failed to generate signed URL: {e}")


class InstallBundleRequest(BaseModel):
    model_config = ConfigDict(extra='ignore')
    model_name: str
    gcs_uri: str
    filename: str | None = None
    entry_relative_path: str
    size_bytes: int | None = None
    sha256: str | None = None

@tasks_router.post("/v1/bundles/install")
def install_bundle(payload: InstallBundleRequest):
    try:
        install_id = service_start_bundle_install(
            model_name=payload.model_name,
            gcs_uri=payload.gcs_uri,
            filename=payload.filename,
            entry_relative_path=payload.entry_relative_path,
            expected_size=payload.size_bytes,
            expected_sha256=payload.sha256,
        )
        return success_response({"install_id": install_id})
    except Exception as e:
        return error_response(f"Failed to start install: {e}")

@tasks_router.get("/v1/bundles/install/events")
def install_events(install_id: str):
    try:
        return StreamingResponse(
            service_generate_install_events(install_id),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    except Exception as e:
        return error_response(f"Failed to start install stream: {e}")

@tasks_router.get("/v1/logs/tail")
def get_log_tail(path: Optional[str] = None, model_name: Optional[str] = None, n: int = 200):
    """
    Return the last n lines of a log file. n defaults to 200.
    Either path (log file path under tasknode_logs) or model_name (e.g. InstanSegNode) must be provided.
    Frontend sends model_name; path is for direct use when log_path is known.
    For remote nodes, logs are fetched from the remote node's logs API.
    """
    try:
        # Check if model_name corresponds to a remote node
        if model_name:
            from app.services.register_service import CUSTOM_NODE_SERVICE_REGISTRY
            for registry_key, info in CUSTOM_NODE_SERVICE_REGISTRY.items():
                is_remote_flag = info.get("is_remote")
                remote_host = info.get("remote_host")
                if info.get("model_name") == model_name and (is_remote_flag is True and remote_host):
                    # Remote node: fetch logs from remote API
                    remote_host = info["remote_host"]
                    port = info["port"]
                    remote_url = f"http://{remote_host}:{port}/logs"
                    params = {"lines": n}
                    try:
                        response = requests.get(remote_url, params=params, timeout=10)
                        response.raise_for_status()
                        remote_data = response.json()
                        # Convert tasknode response format to our format
                        return success_response({
                            "path": remote_data.get("log_file", f"remote://{remote_host}:{port}"),
                            "tail": remote_data.get("content", "")
                        })
                    except requests.RequestException as e:
                        return error_response(f"Failed to fetch logs from remote node: {str(e)}")

        # Local node: read from local file system
        import os
        base_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "storage", "tasknode_logs"))
        target = None
        if path:
            target = os.path.abspath(path)
        elif model_name:
            # Resolve model_name to latest matching log file under tasknode_logs
            safe = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in model_name)
            if not safe:
                raise HTTPException(status_code=422, detail="model_name yields empty safe name")
            candidates = []
            for root, _dirs, files in os.walk(base_dir):
                for f in files:
                    if f.endswith(".log") and safe.lower() in f.lower():
                        candidates.append(os.path.join(root, f))
            if not candidates:
                raise HTTPException(status_code=404, detail="Log file not found for model_name")
            target = max(candidates, key=lambda p: os.path.getmtime(p))
        else:
            raise HTTPException(status_code=422, detail="Either path or model_name is required")
        if not target.startswith(base_dir):
            raise HTTPException(status_code=403, detail="Forbidden path")
        if not os.path.exists(target):
            raise HTTPException(status_code=404, detail="Log file not found")
        # Read last n lines efficiently for small and large files
        max_n = 1000
        n = max(1, min(int(n or 200), max_n))
        with open(target, 'rb') as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            if size <= 128 * 1024:
                f.seek(0)
                raw = f.read()
                text_full = raw.decode('utf-8', errors='ignore')
                parts = text_full.splitlines()
                text = "\n".join(parts[-n:])
            else:
                # Read blocks from end until we have enough newlines
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
                data = bytes(buffer)
                text_full = data.decode('utf-8', errors='ignore')
                parts = text_full.splitlines()
                text = "\n".join(parts[-n:])
        return success_response({"path": target, "tail": text})
    except HTTPException:
        raise
    except Exception as e:
        return error_response(f"Failed to read log: {str(e)}")

# Only keep the API model classes needed for request validation
class RegisterCustomNodeRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    
    model_name: str
    python_version: str
    service_path: str
    dependency_path: str
    factory: str
    description: str | None = None
    port: int | None = None
    env_name: str | None = None
    install_dependencies: bool = True
    # Optional I/O specifications for better chaining in Model Zoo/Agent (list or natural language string)
    inputs: str | None = None
    outputs: str | None = None
    # Remote deployment options (keep in sync with RegisterCustomNodeAsyncRequest)
    is_remote: bool = False
    remote_host: str | None = None
    mnt_path: str | None = None

class CreateNodeRequest(BaseModel):
    service_name: str
    file_path: str
    port: Optional[int] = 8001

class DependencyBody(BaseModel):
    from_node: str
    to_node: str

class ClearWorkflowRequest(BaseModel):
    workflow_id: Optional[int] = None

def _patch_dict_paths(req: dict):
    for key in ["zarr_path", "file_path", "path", "classifier_path", "save_classifier_path"]:
        if key in req and isinstance(req[key], str):
            req[key] = resolve_path(req[key])
    return req

# function to patch paths recursively

def patch_paths_recursive(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ["zarr_path", "file_path", "path", "classifier_path", "save_classifier_path"] and isinstance(v, str):
                obj[k] = resolve_path(v)
            else:
                patch_paths_recursive(v)
    elif isinstance(obj, list):
        for item in obj:
            patch_paths_recursive(item)
    return obj

@tasks_router.post("/v1/start_service/{service_name}")
def start_service(service_name: str):
    """
    Start single node service
    """
    try:
        # Call service layer's start_service function
        from app.services.tasks_service import start_service as service_start_service
        
        result = service_start_service(service_name)
        
        # Handle result
        if "error" in result:
            return error_response(result["error"])
        else:
            return success_response({"message": result.get("message", f"Service {service_name} started successfully")})
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.post("/v1/stop_service/{service_name}")
def stop_service(service_name: str):
    """
    Close node server
    """
    try:
        # Call service layer's stop_service function
        from app.services.tasks_service import stop_service as service_stop_service
        
        result = service_stop_service(service_name)
        
        # Handle result
        if "error" in result:
            return error_response(result["error"])
        else:
            return success_response({"message": result.get("message", f"Service {service_name} stopped successfully")})
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.post("/v1/start_all_services")
def start_all_services():
    """
    Start all nodes from nodeA to nodeE
    """
    try:
        # Call service layer's start_all_services function
        from app.services.tasks_service import start_all_services as service_start_all_services
        
        result = service_start_all_services()
        
        # Return results
        return success_response({"results": result.get("results", {})})
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.post("/v1/stop_all_services")
def stop_all_services():
    """
    Close all nodes from nodeA to nodeE
    """
    try:
        # Call service layer's stop_all_services function
        from app.services.tasks_service import stop_all_services as service_stop_all_services
        
        result = service_stop_all_services()
        
        # Return results
        return success_response({"results": result.get("results", {})})
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.post("/v1/create_node")
def create_node(req: CreateNodeRequest):
    """
    Example:
    {
      "service_name": "MyNodeA",
      "file_path": "app/core/tasks/current_tasks/node_A.py",
      "port": 9001
    }
    """
    try:
        # Call service layer's create_node function
        from app.services.tasks_service import create_node as service_create_node
        
        # Resolve virtual path aliases first (e.g., 'samples/Data' -> '/data/public')
        from app.config.path_config import resolve_virtual_path
        resolved_file_path = resolve_virtual_path(req.file_path)
        if not resolved_file_path:
            return error_response("Invalid path alias", code=400)
        result = service_create_node(
            service_name=req.service_name,
            file_path=resolve_path(resolved_file_path),
            port=req.port
        )
        
        # Handle result
        if "error" in result:
            return error_response(result["error"])
        else:
            return success_response({
                "message": result.get("message", f"Node '{req.service_name}' registered"),
                "service_info": result.get("service_info", {})
            })
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.post("/v1/add_dependency")
def add_dependency(data: DependencyBody):
    """
    data example:
    {
      "from_node": "nodeA",
      "to_node": "nodeB"
    }
    """
    try:
        # Call service layer's _add_dependency_internal function
        from app.services.tasks_service import _add_dependency_internal as service_add_dependency
        
        result = service_add_dependency(data.from_node, data.to_node)
        
        # Handle result
        if "error" in result:
            return error_response(result["error"])
        else:
            return success_response({"message": result.get("message", f"Dependency added: {data.from_node} -> {data.to_node}")})
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.get("/v1/list_workflows")
def list_current_workflows():
    wf_ids = manager.list_workflows()
    workflow_map = manager.workflows
    display_list = []
    for wf_id in wf_ids:
        # workflow_map[wf_id] example: ["nodeA","nodeC","nodeD"]
        nodes = workflow_map.get(wf_id, [])
        path_str = "->".join(nodes)
        display_list.append(f"{wf_id}: {path_str}")

    return success_response({"workflows": display_list})

@tasks_router.get("/v1/get_answer")
def get_answer(auth_user: AuthUser = Depends(get_auth_user)):
    """
    Get workflow answer for the authenticated user.
    Returns user-specific workflow results to prevent collision across concurrent sessions.
    """
    from app.services.tasks_service import user_workflow_status
    
    uid = auth_user.uid
    
    # Check if user has a workflow status entry
    if uid not in user_workflow_status:
        return success_response({
            "message": "no_workflow",
            "answer": ""
        })
    
    user_status = user_workflow_status[uid]
    is_generating = user_status.get('is_generating', False)
    script_error_code = user_status.get("script_error_code")
    script_error_message = user_status.get("script_error_message")
    
    if is_generating:
        partial = user_status.get("cur_answer")
        answer_wait = partial if isinstance(partial, str) else ""
        return success_response({
            "message": "wait",
            "answer": answer_wait,
            "state_code": 1000,
        })
    if isinstance(script_error_code, int) and script_error_code != 0:
        data = {
            "message": "error",
            "answer": "",
            "state_code": script_error_code,
            "error": script_error_message or "Script execution failed",
        }
        user_workflow_status[uid]["script_error_code"] = None
        user_workflow_status[uid]["script_error_message"] = None
        user_workflow_status[uid]["cur_answer"] = None
        return success_response(data)
    else:
        cur_answer = user_status.get('cur_answer', '')
        data = {
            "message": "done",
            "answer": cur_answer,
            "state_code": 0,
        }
        # Reset cur_answer for this user
        user_workflow_status[uid]['cur_answer'] = None
        return success_response(data)


@tasks_router.get("/v1/current_workflow_status")
def current_workflow_status(auth_user: AuthUser = Depends(get_auth_user)):
    """
    Return current user's workflow status snapshot (for frontend restore after page refresh).
    If user has a running or queued workflow, returns execution_id, status, node_status,
    node_progress, queue_position, queue_total. Otherwise returns active=False.
    """
    from app.services.tasks_service import get_current_workflow_status as service_get_current
    snapshot = service_get_current(auth_user.uid)
    return success_response(snapshot)


@tasks_router.post("/v1/start_workflow")
async def start_workflow_from_frontend(frontend_data: dict, background_tasks: BackgroundTasks, request: Request, auth_user: AuthUser = Depends(get_auth_user)):
    """
    Start workflow from frontend with user isolation
    
    frontend_data format example:
    "zarr_path": "/Users/xxx/Desktop/my_workflow_data.zarr",
      "step1": {
        "model": "SegmentationNode",
        "input": {
          "path": "/Users/xxx/Desktop/example_WSI/CMU-1.svs",
          "read_image_method": "tiffslide",
          "stardist_pretrain": "2D_versatile_he",
          "calculate_features": true
        }
      }
    """
    uid = auth_user.uid
    # Check public read-only directory restriction BEFORE path processing
    zarr_path = frontend_data.get("zarr_path", "")
    if is_public_read_only_path(zarr_path):
        return error_response("Cannot run workflow in sample or data directories. Please use your personal workspace instead.", code=403)
    
    frontend_data = patch_paths_recursive(frontend_data)
    
    # Call service layer's start_workflow_from_frontend function with uid
    from app.services.tasks_service import start_workflow_from_frontend as service_start_workflow
    
    auth_header = request.headers.get("Authorization")
    result = await service_start_workflow(frontend_data, uid, auth_header=auth_header)
    
    if not result.get("success", False):
        return error_response(result.get("error", "Unknown error occurred when starting workflow"))
    
    # Get task information
    task_info = result.get("task_info", {})
    wf_id = task_info.get("wf_id")
    execution_id = result.get("execution_id")  # Get execution_id from service layer
    queue_position = result.get("queue_position", 0)
    
    logger.info(f"  Workflow {wf_id} queued for user {uid} at position {queue_position}, execution_id: {execution_id}")

    return success_response({
        "message": result.get("message", f"Workflow '{wf_id}' queued for execution"),
        "workflow_id": wf_id,
        "execution_id": execution_id,  # Return execution_id to frontend
        "queue_position": queue_position,
        "user_id": uid
    })

@tasks_router.get("/v1/workflow_status/{wf_id}")
def get_workflow_status(wf_id: int):
    """
    return background task status
    """
    if wf_id not in workflow_run_status:
        return error_response(f"No record of workflow {wf_id}")

    status_info = workflow_run_status[wf_id]
    payload = {
        "status": status_info["status"],
        "result": status_info["result"]  # if done or error
    }
    node_status = status_info.get("node_status")
    if node_status is not None:
        payload["node_status"] = node_status
    return success_response(payload)

@tasks_router.post("/v1/register_custom_node")
def register_custom_node_endpoint(req: RegisterCustomNodeRequest):
    """
    When the frontend calls this interface, it needs to pass in:
    - model_name: The name of the custom node
    - python_version: The Python version used to create or reuse the conda environment (e.g., 3.9)
    - service_path: The entry point for starting the node service (e.g., 'custom_node:app')
    - dependency_path: The absolute path of the node dependency file requirements.txt
    - factory: The factory to which the node belongs (e.g., 'TissueClassify/NucleiSeg/Custom/...')

    Process:
      1. If a Node named req.model_name already exists in the system, stop and remove the old environment first
      2. Call register_custom_node(...) to start the new service
      3. If the startup is successful, use the returned port to create a CustomNodeWrapper and register it to TaskNodeManager
    """
    try:
        # Call service layer's register_custom_node_endpoint function
        from app.services.tasks_service import register_custom_node_endpoint as service_register_custom_node_endpoint
        
        result = service_register_custom_node_endpoint(
            model_name=req.model_name,
            python_version=req.python_version,
            service_path=req.service_path,
            dependency_path=resolve_path(req.dependency_path),
            factory=req.factory,
            description=req.description,
            port=req.port,
            env_name=req.env_name,
            install_dependencies=req.install_dependencies,
            io_specs={
                "inputs": req.inputs,
                "outputs": req.outputs,
            } if (req.inputs is not None or req.outputs is not None) else None,
            is_remote=req.is_remote,
            remote_host=req.remote_host,
            mnt_path=req.mnt_path,
        )
        
        # Check result format and return appropriate response
        if "code" in result:
            if result["code"] == 0:
                return {"code": 0, "data": result["data"]}
            else:
                # Include log_path if present to help frontend stream logs
                payload = {"code": 1, "message": result.get("message", "Registration failed")}
                try:
                    if isinstance(result.get("data"), dict) and result["data"].get("log_path"):
                        payload["data"] = {"log_path": result["data"]["log_path"]}
                except Exception:
                    pass
                return payload
        else:
            if "error" in result:
                return error_response(result["error"])
            else:
                return success_response(result)
    except Exception as e:
        return error_response(f"API Error: {str(e)}")


class RegisterCustomNodeAsyncRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    model_name: str
    python_version: str
    service_path: str
    dependency_path: str
    factory: str
    description: str | None = None
    port: int | None = None
    env_name: str | None = None
    install_dependencies: bool = True
    # Optional I/O specifications for better chaining in Model Zoo/Agent
    inputs: str | None = None
    outputs: str | None = None
    # Remote deployment options
    is_remote: bool = False
    remote_host: str | None = None
    mnt_path: str | None = None


class WorkflowStageStatusRequest(BaseModel):
    zarr_path: str
    steps: Optional[list[dict]] = None


@tasks_router.post("/v1/workflow_stage_status")
def workflow_stage_status(req: WorkflowStageStatusRequest, auth_user: AuthUser = Depends(get_auth_user)):
    """Return stage-level workflow status from zarr + runtime overrides."""
    from app.services.tasks_service import get_workflow_stage_status as service_get_workflow_stage_status

    result = service_get_workflow_stage_status(
        uid=auth_user.uid,
        zarr_path=req.zarr_path,
        steps=req.steps,
    )
    return success_response(result)


@tasks_router.post("/v1/register_custom_node_async")
async def register_custom_node_async(req: RegisterCustomNodeAsyncRequest):
    """
    Immediately create a log file and return its path, then run registration in background.
    """
    try:
        # Pre-create a log file name to stream logs immediately
        from datetime import datetime
        from app.services.register_service import _resolve_log_path  # type: ignore
        env_name = req.env_name or f"{req.model_name}_tissuelab_ai_service_tasknode"
        log_path = _resolve_log_path(req.model_name, env_name)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        with open(log_path, "a") as f:
            f.write(f"[Async Register] Allocated log for model={req.model_name} env={env_name} at {ts}\n")
            f.flush()

        # Run registration in background on a thread to avoid blocking the event loop/worker
        async def _run():
            try:
                from app.services.tasks_service import register_custom_node_endpoint as service_register_custom_node_endpoint
                res = await asyncio.to_thread(
                    service_register_custom_node_endpoint,
                    model_name=req.model_name,
                    python_version=req.python_version,
                    service_path=resolve_path(req.service_path),
                    dependency_path=resolve_path(req.dependency_path),
                    factory=req.factory,
                    description=req.description,
                    port=req.port,
                    env_name=req.env_name,
                    install_dependencies=req.install_dependencies,
                    io_specs={
                        "inputs": req.inputs,
                        "outputs": req.outputs,
                    } if (req.inputs is not None or req.outputs is not None) else None,
                    log_path=log_path,
                    is_remote=req.is_remote,
                    remote_host=req.remote_host,
                    mnt_path=req.mnt_path,
                )
                # Append result to log for visibility
                try:
                    with open(log_path, "a") as lf:
                        lf.write(f"\n[Async Register] Result: {res}\n")
                        lf.flush()
                except Exception:
                    pass
            except Exception as e:
                try:
                    with open(log_path, "a") as lf:
                        lf.write(f"\n[Async Register] Error: {e}\n")
                        lf.flush()
                except Exception:
                    pass

        asyncio.create_task(_run())

        return success_response({
            "status": "starting",
            "model_name": req.model_name,
            "env_name": env_name,
            "log_path": log_path,
        })
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.get("/v1/list_factory_models")
def list_factory_models():
    try:
        
        # data = model_store.get_registry_or_preset()
        category_map = model_store.get_category_map() or {}
        return success_response(category_map)

    except Exception as e:
        logger.exception("[list_factory_models] failed")
        return error_response(f"API Error: {str(e)}")

@tasks_router.get("/v1/get_status")
async def get_status(request: Request):
    """
    Return the status of each node in the current workflow as Server-Sent Events (SSE).
    
    Status codes:
        0 - Not started
        1 - Running
        2 - Completed
    
    This endpoint uses SSE to continuously send status updates to the client.
    User-specific status is determined by Firebase Auth token.
    """
    # Local-only build: no token verification; identify the caller via the
    # optional ``uid`` query param (defaults to the shared local user).
    uid = request.query_params.get('uid') or get_auth_user().uid
    
    # Import the event generator from the service layer
    from app.services.tasks_service import generate_node_status_events
    
    # Return a streaming response using the service layer's event generator
    return StreamingResponse(
        generate_node_status_events(uid),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"  # Needed for some Nginx setups
        }
    )

@tasks_router.post("/v1/save_annotation")
def save_annotation(req: dict, background_tasks: BackgroundTasks, request: Request):
    """
    Receive annotation data and save to Zarr file
    """
    # Check samples and data directory restriction BEFORE path processing
    path = req.get("path", "")
    if is_public_read_only_path(path):
        return error_response("Cannot annotate in sample or data directories. Please use your personal workspace instead.", code=403)
    
    # Get instanceId from header
    instance_id = request.headers.get('X-Instance-ID')
    if not instance_id:
        return error_response("X-Instance-ID header is required")
    
    req = _patch_dict_paths(req)
    # Add instanceId to request for service layer
    req['instance_id'] = instance_id
    
    # Call service layer's save_annotation function
    from app.services.tasks_service import save_annotation as service_save_annotation
    
    # Resolve device handler and pass it to service layer
    from app.utils.request import get_device_id
    from app.websocket.segmentation_consumer import device_annotation_handlers
    device_id = get_device_id(request)
    handler = device_annotation_handlers.get(device_id)
    if not handler:
        return error_response("No handler found for device")
    result = service_save_annotation(handler, req, background_tasks)
    
    # Construct API response based on service layer result
    if result.get("success", False):
        return success_response({"message": result.get("message", "Annotation saved")})
    else:
        return error_response(result.get("error", "Unknown error occurred while saving annotation"))

@tasks_router.post("/v1/save_tissue")
# Keep req: dict if frontend sends polygon_points inside the body
# Alternatively, define a Pydantic model for the body
# async def save_tissue(tissue_data: TissueSaveRequest, background_tasks: BackgroundTasks):
async def save_tissue(req: dict, background_tasks: BackgroundTasks, request: Request):
    """
    Receive tissue area coordinates (BBox) and optional polygon points in request body,
    find precise matching patches, and save classification to Zarr file.
    """
    # Check samples and data directory restriction BEFORE path processing
    path = req.get("path", "")
    if is_public_read_only_path(path):
        return error_response("Cannot annotate tissue in sample or data directories. Please use your personal workspace instead.", code=403)
    
    req = _patch_dict_paths(req)
    from app.services.tasks_service import save_tissue as service_save_tissue
    from app.utils.request import get_device_id
    from app.websocket.segmentation_consumer import device_annotation_handlers
    device_id = get_device_id(request)
    handler = device_annotation_handlers.get(device_id)
    if not handler:
        return error_response("No handler found for device")
    result = service_save_tissue(handler, req, background_tasks)

    # Construct API response based on service layer result
    if result.get("success", False):
        return success_response({
            "message": result.get("message", "Tissue annotation saved"),
            # Return the precise indices found
            "matching_indices": result.get("matching_indices", [])
        })
    else:
        # Consider returning appropriate HTTP status codes based on error type
        return error_response(result.get("error", "Unknown error occurred"), code=400 if "coordinate" in result.get("error", "").lower() else 500)

@tasks_router.post("/v1/classification")
def run_classification(req: dict):
    """ Run classification operation """
    req = _patch_dict_paths(req)
    # Call service layer's run_classification function
    from app.services.tasks_service import run_classification as service_run_classification
    
    result = service_run_classification(req)
    
    # Construct API response based on service layer result
    if result.get("success", False):
        return success_response({
            "message": result.get("message", "Classification operation completed successfully"),
            "result": result.get("result", {})
        })
    else:
        return error_response(result.get("error", "Unknown error occurred during classification"))

@tasks_router.post("/v1/nuclei_classification/cell_review_tile")
async def get_cell_review_tile(request: Request):
    """
    Get 40x magnification tile crop centered on a specific cell for review.
    Returns cropped image and optional contour data.
    """
    from app.services.tasks_service import get_cell_review_tile_data
    data = await request.json()
    
    # Validate required fields
    required_fields = ["slide_id", "cell_id", "centroid"]
    for field in required_fields:
        if field not in data:
            return error_response(f"Missing required field: {field}")
    
    # Set default values for optional parameters
    data.setdefault("window_size_px", 512)
    data.setdefault("padding_ratio", 0.2)
    data.setdefault("magnification", 40)
    data.setdefault("return_contour", True)
    data.setdefault("contour_type", None)  # None: no contour, 'polygon': precise contour, 'rect': bbox contour
    
    # Patch paths
    data = _patch_dict_paths(data)
    
    result = get_cell_review_tile_data(data)
    
    if result.get("success", False):
        return success_response(result.get("data", {}))
    else:
        return error_response(result.get("error", "Unknown error occurred during cell review tile generation"))

@tasks_router.post("/v1/reset_classification", summary="Reset classification and annotation data in Zarr file")
async def reset_classification_data_endpoint(request: Request):
    """
    Resets classification results and user annotations in the specified Zarr file.
    This involves deleting the 'ClassificationNode' and 'user_annotation' groups.
    """
    from app.services.tasks_service import reset_zarr_classification_data
    data = await request.json()
    zarr_path = data.get("zarr_path")
    if not zarr_path:
        return error_response("zarr_path is required")

    result = reset_zarr_classification_data(resolve_path(zarr_path))

    if result["status"] == "error":
        return error_response(result["message"])
        
    return success_response(result)

@tasks_router.post("/v1/reset_patch_classification", summary="Reset patch classification (tissue_*) and user annotations in Zarr file, preserving MuskNode embeddings")
async def reset_patch_classification_endpoint(request: Request):
    from app.services.tasks_service import reset_patch_classification_data
    data = await request.json()
    zarr_path = data.get("zarr_path")
    if not zarr_path:
        return error_response("zarr_path is required")
    result = reset_patch_classification_data(resolve_path(zarr_path))
    if result.get("status") != "success":
        return error_response(result.get("message", "Failed to reset patch classification"))
    return success_response(result)

@tasks_router.post("/v1/clear_workflow")
def clear_workflow(req: ClearWorkflowRequest):
    """
    Clear workflow
    
    Request body:
    - workflow_id (int, optional): the workflow id to clear
    
    Returns:
    - success: {"cleared": [...cleared workflow ids...], "reset_only": true/false}
    - error: {"error": "error message"}
    """
    try:
        # Call service layer's clear_workflow function
        from app.services.tasks_service import clear_workflow as service_clear_workflow
        
        workflow_id = req.workflow_id
        result = service_clear_workflow(workflow_id)
        
        # Get result fields
        success = result.get("success", False)
        cleared = result.get("cleared", [])
        reset_only = result.get("reset_only", False)
        error_msg = result.get("error", "Unknown error when clearing workflow")
        
        # Construct API response based on service layer result
        if success:
            return success_response({
                "cleared": cleared,
                "reset_only": reset_only
            })
        else:
            return error_response(error_msg)
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.get("/v1/list_node_ports")
def list_node_ports(skip_health_checks: bool = False):
    """
    List all TaskNodes and their port numbers.
    
    This endpoint collects port information from:
    1. The services dictionary
    2. The TaskNodeManager nodes
    3. Custom nodes from the custom node registry
    
    Args:
        skip_health_checks: Query parameter to skip health checks for remote nodes
    
    Returns:
    - A dictionary with node names as keys and port numbers as values
    - Additional metadata about the nodes where available (e.g., running status, factory)
    """
    try:
        # Call service layer's list_node_ports function
        from app.services.tasks_service import list_node_ports as service_list_node_ports
        
        result = service_list_node_ports(skip_health_checks=skip_health_checks)
        
        # Get result fields
        success = result.get("success", False)
        nodes = result.get("nodes", {})
        error_msg = result.get("error", "Unknown error listing node ports")
        
        # Construct API response based on service layer result
        if success:
            # Enrich with runtime config stored in ModelStore (env_name, service_path, dependency_path, python_version)
            try:
                store_nodes = model_store.get_nodes_extended()
                for name, info in nodes.items():
                    runtime = store_nodes.get(name, {}).get("runtime")
                    if isinstance(runtime, dict):
                        # only set fields if not already present
                        for k in ["env_name", "service_path", "dependency_path", "python_version", "port"]:
                            if k in runtime and runtime[k] is not None and not info.get(k):
                                info[k] = runtime[k]
            except Exception:
                pass
            return success_response({"nodes": nodes})
        else:
            return error_response(error_msg)
    except Exception as e:
        logger.error(f"Error listing node ports: {str(e)}")
        return error_response(f"Error listing node ports: {str(e)}")


@tasks_router.get("/v1/list_conda_envs")
def list_conda_envs():
    try:
        result = list_available_conda_envs()
        if result.get("status") == "success":
            return success_response({"envs": result.get("envs", [])})
        else:
            msg = result.get("message", "Failed to list conda envs")
            from app.core import logger
            logger.error(f"list_conda_envs error: {msg}")
            return error_response(msg)
    except Exception as e:
        from app.core import logger
        logger.exception(f"Unhandled error in list_conda_envs: {e}")
        return error_response(f"Error listing conda envs: {str(e)}")

@tasks_router.get("/v1/list_nodes_extended")
def list_nodes_extended():
    try:
        model_store.load()

        nodes = model_store.get_nodes_extended() or {}
        category_map = model_store.get_category_map() or {}
        category_display_names = model_store.get_category_display_names() or {}

        for node_name, node_data in nodes.items():
            if isinstance(node_data, dict) and "runtime" in node_data:
                runtime = node_data.get("runtime", {})
                if isinstance(runtime, dict) and "service_path" in runtime:
                    service_path = runtime.get("service_path")
                    if isinstance(service_path, str):
                        exists = os.path.exists(service_path)
                        is_executable = exists and os.access(service_path, os.X_OK)
                        runtime["bundle_exists"] = exists and is_executable

        return success_response({
            "nodes": nodes,
            "category_map": category_map,
            "category_display_names": category_display_names,
        })
    except Exception as e:
        return error_response(f"Error listing nodes: {str(e)}")

@tasks_router.post("/v1/reload_model_registry")
def reload_model_registry():
    """
    Force reload the model registry from disk.
    Use this after external processes (like Electron) modify the registry file.
    """
    try:
        model_store.load()
        return success_response({"message": "Model registry reloaded successfully"})
    except Exception as e:
        logger.error(f"Error reloading model registry: {str(e)}")
        return error_response(f"Error reloading model registry: {str(e)}")
    
class DeleteNodeRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    model_name: str


@tasks_router.post("/v1/delete_node")
def delete_node(req: DeleteNodeRequest):
    try:
        removed = model_store.delete_node(req.model_name)
        if removed:
            return success_response({"message": f"Node '{req.model_name}' deleted"})
        else:
            return error_response(f"Node '{req.model_name}' not found")
    except Exception as e:
        return error_response(f"Error deleting node: {str(e)}")


class StopNodeRequest(BaseModel):
    env_name: str


@tasks_router.post("/v1/stop_node")
def stop_node(req: StopNodeRequest):
    try:
        result = stop_custom_node_env(req.env_name)
        if result.get("status") == "success":
            return success_response({"message": result.get("message", "Stopped")})
        else:
            return error_response(result.get("message", "Failed to stop node"))
    except Exception as e:
        return error_response(f"Error stopping node: {str(e)}")


@tasks_router.post("/v1/stop_node_process")
def stop_node_process(req: StopNodeRequest):
    try:
        logger.debug(f"[stop_node_process] request env_name={req.env_name}")
        # Now env_name may be a composite key or an env; accept both
        result = stop_custom_node_process(req.env_name)
        logger.debug(f"[stop_node_process] result={result}")
        if result.get("status") == "success":
            return success_response({"message": result.get("message", "Stopped process")})
        else:
            return error_response(result.get("message", "Failed to stop process"))
    except Exception as e:
        logger.exception(f"[stop_node_process] error: {e}")
        return error_response(f"Error stopping node process: {str(e)}")

@tasks_router.get("/v1/get_node_classifier_counts")
def get_node_classifier_counts():
    """
    Get classifier counts for each node
    """
    try:
        # Return mock data or implement actual counting logic
        classifier_counts = {
            'MUSK': 0,
            'BiomedParse': 0, 
            'TotalSegmentator': 0,
            'CellViT': 0,
            'HoverNet': 0,
            'UNI': 0
        }
        return success_response(classifier_counts)
    except Exception as e:
        logger.error(f"Error getting node classifier counts: {str(e)}")
        return error_response(f"Error getting node classifier counts: {str(e)}")

class StopWorkflowRequest(BaseModel):
    zarr_path: str

@tasks_router.post("/v1/stop_workflow")
async def stop_workflow(req: StopWorkflowRequest):
    """
    Stop the current workflow execution and rollback files if needed
    """
    try:
        # Call service layer's stop_workflow function
        from app.services.tasks_service import stop_workflow_async

        result = await stop_workflow_async(resolve_path(req.zarr_path))

        # Handle result
        if result.get("success", False):
            return success_response({
                "message": result.get("message", "Workflow stopped successfully"),
                "data": result.get("data", {})
            })
        else:
            return error_response(result.get("error", "Failed to stop workflow"))
    except Exception as e:
        logger.exception(f"[stop_workflow] error: {e}")
        return error_response(f"Error stopping workflow: {str(e)}")

class UpdateProgressRequest(BaseModel):
    node_name: str
    progress: int

@tasks_router.post("/v1/update_progress")
def update_progress(req: UpdateProgressRequest):
    """
    Update the progress of a specific node
    """
    try:
        from app.services.tasks_service import update_node_progress
        
        # Validate progress value
        if not (0 <= req.progress <= 100):
            return error_response("Progress must be between 0 and 100")
        
        update_node_progress(req.node_name, req.progress)
        
        return success_response({
            "message": f"Progress updated for {req.node_name}: {req.progress}%"
        })
    except Exception as e:
        logger.exception(f"[update_progress] error: {e}")
        return error_response(f"Error updating progress: {str(e)}")

# Panel configuration management
@tasks_router.post("/v1/save_panel_config")
def save_panel_config(req: dict):
    """
    Save custom panel configuration for a model
    """
    try:
        model_name = req.get("model_name")
        panel_config = req.get("panel_config")
        
        if not model_name or not panel_config:
            return error_response("model_name and panel_config are required")
        
        # Save panel configuration using ModelStore
        success = model_store.save_panel_config(model_name, panel_config)
        
        if success:
            return success_response({
                "message": f"Panel configuration saved for {model_name}",
                "model_name": model_name
            })
        else:
            return error_response(f"Model {model_name} not found or failed to save")
            
    except Exception as e:
        logger.exception(f"[save_panel_config] error: {e}")
        return error_response(f"Error saving panel configuration: {str(e)}")

@tasks_router.get("/v1/get_panel_config/{model_name}")
def get_panel_config(model_name: str):
    """
    Get custom panel configuration for a model
    """
    try:
        panel_config = model_store.get_panel_config(model_name)
        
        if panel_config is not None:
            return success_response({
                "model_name": model_name,
                "panel_config": panel_config
            })
        else:
            return error_response(f"Panel configuration not found for {model_name}")
            
    except Exception as e:
        logger.exception(f"[get_panel_config] error: {e}")
        return error_response(f"Error getting panel configuration: {str(e)}")

@tasks_router.get("/v1/get_all_panel_configs")
def get_all_panel_configs():
    """
    Get all panel configurations
    """
    try:
        panel_configs = model_store.get_all_panel_configs()
        return success_response(panel_configs)
    except Exception as e:
        logger.exception(f"[get_all_panel_configs] error: {e}")
        return error_response(f"Error getting all panel configurations: {str(e)}")

@tasks_router.get("/v1/list_all_panel_configs")
def list_all_panel_configs():
    """
    Get all custom panel configurations
    """
    try:
        panel_configs = model_store.get_all_panel_configs()
        
        return success_response({
            "panel_configs": panel_configs
        })
        
    except Exception as e:
        logger.exception(f"[list_all_panel_configs] error: {e}")
        return error_response(f"Error listing panel configurations: {str(e)}")


class GetZarrStructureRequest(BaseModel):
    zarr_path: str


class GetH5StructureRequest(BaseModel):
    """Request for get_h5_structure. Accepts h5_path or prompt (legacy)."""
    h5_path: Optional[str] = None
    agent_id: Optional[str] = None
    prompt: Optional[str] = None  # legacy: used as h5_path when h5_path not set


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


@tasks_router.post("/v1/get_h5_structure")
async def get_h5_structure_api(request: GetH5StructureRequest):
    """
    Retrieve the structure of an HDF5 file (same role as former /agent/v1/get_h5_structure).
    Request body: { "h5_path": "path/to/file.h5" } or legacy { "agent_id": "...", "prompt": "path/to/file.h5" }.
    """
    if h5py is None:
        return error_response("h5py is not installed")
    h5_path = request.h5_path or request.prompt or ""
    if not h5_path:
        return error_response("h5_path or prompt is required")
    try:
        resolved_path = resolve_path(h5_path)
        if not os.path.exists(resolved_path):
            return error_response(f"H5 file not found: {h5_path}")
        with h5py.File(resolved_path, "r") as h5_file:
            logger.info(f"read h5 file {resolved_path} successfully")
            structure = _process_node_h5("/", h5_file)
            return success_response(structure)
    except Exception as e:
        logger.exception(f"[get_h5_structure] error: {e}")
        return error_response(f"Error getting H5 structure: {str(e)}")


@tasks_router.post("/v1/get_zarr_structure")
async def get_zarr_structure_api(request: GetZarrStructureRequest):
    """
    Retrieve the structure of a Zarr file and return it as a nested dictionary,
    including the names of groups and datasets.
    
    Request body:
    {
        "zarr_path": "path/to/workflow_data.zarr"
    }
    """
    try:
        # Resolve the path to absolute path
        resolved_zarr_path = resolve_path(request.zarr_path)
        
        # Verify file exists
        if not os.path.exists(resolved_zarr_path):
            return error_response(f"Zarr file not found: {request.zarr_path}")
        
        # Open the Zarr file and retrieve its structure
        try:
            with zarr.open(resolved_zarr_path, 'r') as zarr_file:
                logger.info(f"read zarr file {resolved_zarr_path} successfully")
                structure = process_node("/", zarr_file)
                return success_response(structure)
        except Exception as e:
            logger.error(f"failed to get zarr structure: {str(e)}")
            return error_response(f"failed to get zarr structure: {str(e)}")
    except Exception as e:
        logger.exception(f"[get_zarr_structure] error: {e}")
        return error_response(f"Error getting Zarr structure: {str(e)}")


class ExecuteScriptRequest(BaseModel):
    zarr_path: str
    code_str: str


class SummaryAnswerRequest(BaseModel):
    agent_id: str
    prompt: str
    parameters: Optional[Dict[str, Any]] = None


@tasks_router.post("/v1/execute_script")
async def execute_script(
    request: ExecuteScriptRequest,
    http_request: Request,
    auth_user: Optional[AuthUser] = Depends(get_optional_auth_user),
):
    """
    Execute a custom analysis script
    Sets TL_EXPORT_DIR for authenticated web users to route outputs to their personal folder.
    Request example:
    {
        "zarr_path": "path/to/data.zarr",
        "code_str": "def analyze_medical_image(path):\n    ..."
    }
    """
    script_answer_wait_active = False
    _exec_uid: Optional[str] = None
    try:
        # For authenticated web users (not Electron), prepend TL_EXPORT_DIR to route outputs to their personal folder
        code_to_execute = request.code_str
        
        # Only inject TL_EXPORT_DIR for authenticated web users (not Electron desktop app)
        user_export_dir = None  # Initialize to avoid NameError
        if auth_user and getattr(auth_user, 'uid', None) and not _is_electron_client(http_request):
            user_export_dir = f"users/{auth_user.uid}/outputs"
            absolute_export_path = resolve_path(user_export_dir)
            
            # Prepend environment variable setting at execution time
            env_injection = f'''import os
os.environ['TL_EXPORT_DIR'] = {repr(absolute_export_path)}

'''
            code_to_execute = env_injection + request.code_str
        
        # Convert relative path to absolute path using storage root
        resolved_zarr_path = resolve_path(request.zarr_path)
        
        # Verify file exists before attempting execution
        if not os.path.exists(resolved_zarr_path):
            return error_response(
                f"Zarr file not found. Original path: {request.zarr_path}, "
                f"Resolved path: {resolved_zarr_path}"
            )

        _exec_uid = auth_user.uid if auth_user and getattr(auth_user, "uid", None) else None
        
        # Prepare a timestamped log file under storage/tasknode_logs (same as task nodes)
        try:
            # logs_dir relative to this file: app/api/ -> go to project root and into storage/tasknode_logs
            logs_base_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "storage", "tasknode_logs"))
            os.makedirs(logs_base_dir, exist_ok=True)
            
            # Create date-based subdirectory (e.g., 2025-10-09) to match other task node logs
            today_stamp = datetime.now().strftime("%Y-%m-%d")
            day_dir = os.path.join(logs_base_dir, today_stamp)
            os.makedirs(day_dir, exist_ok=True)
            
            zarr_base = os.path.splitext(os.path.basename(resolved_zarr_path))[0]
            safe_zarr = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in zarr_base)
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            log_path = os.path.join(day_dir, f"CodeScript__{safe_zarr}__{ts}.log")
        except Exception:
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            log_path = os.path.abspath(f"CodeScript__{ts}.log")

        with open(log_path, "w", encoding="utf-8") as lf:
            # Write header and script snapshot
            try:
                lf.write(f"[Code Run] {datetime.now().isoformat()}\n")
                lf.write(f"Zarr Path (original): {request.zarr_path}\n")
                lf.write(f"Zarr Path (resolved): {resolved_zarr_path}\n")
                if auth_user and getattr(auth_user, 'uid', None):
                    lf.write(f"User: {auth_user.uid}\n")
                    if user_export_dir:
                        lf.write(f"Export Directory: {user_export_dir}\n")
                    else:
                        lf.write(f"Export Directory: N/A (Electron client or not configured)\n")
                lf.write("--- Begin Script ---\n")
                lf.write(code_to_execute)
                lf.write("\n--- End Script ---\n\n")
                lf.flush()
            except Exception:
                pass

            # Validate syntax quickly before spawning process
            try:
                lf.write("--- Validating Script ---\n")
                lf.flush()
                script_function(code_to_execute)
                lf.write("Syntax validation passed.\n\n")
                lf.flush()
            except ValueError as e:
                lf.write(f"Validation failed: {str(e)}\n")
                lf.flush()
                return error_response(str(e))

            begin_script_summary_wait(_exec_uid)
            script_answer_wait_active = True

            # Execute analysis in isolated process with resource limits and 60-second timeout
            lf.write("--- Execution Started ---\n")
            lf.write(f"Start time: {datetime.now().isoformat()}\n")
            lf.flush()
            
            execution_start = datetime.now()
            result = None
            process_executor = None
            subprocess_pid = None
            
            try:
                # Use ProcessPoolExecutor - processes can be killed on timeout
                loop = asyncio.get_event_loop()
                process_executor = ProcessPoolExecutor(max_workers=1)
                
                # Submit task to subprocess with resource limits
                future = loop.run_in_executor(
                    process_executor, 
                    _execute_with_limits,
                    code_to_execute,
                    resolved_zarr_path,
                    8192,  # 8GB memory limit
                    55     # 55s CPU time limit (slightly less than wall clock timeout)
                )
                
                # Wait for result with timeout
                result = await asyncio.wait_for(future, timeout=60.0)
                
                execution_end = datetime.now()
                duration = (execution_end - execution_start).total_seconds()
                
                # Log execution result
                lf.write(f"\nEnd time: {execution_end.isoformat()}\n")
                lf.write(f"Duration: {duration:.2f} seconds\n")
                lf.write("\n--- Execution Result ---\n")
                try:
                    result_str = json.dumps(result, indent=2) if isinstance(result, dict) else str(result)
                    lf.write(result_str)
                    lf.write("\n")
                except Exception:
                    lf.write(str(result))
                    lf.write("\n")
                lf.write("\n--- Execution Complete ---\n")
                lf.flush()
                    
            except asyncio.TimeoutError:
                execution_end = datetime.now()
                duration = (execution_end - execution_start).total_seconds()
                
                lf.write(f"\nEnd time: {execution_end.isoformat()}\n")
                lf.write(f"Duration: {duration:.2f} seconds\n")
                lf.write("\n--- Execution Timeout (60s limit exceeded) ---\n")
                lf.write("The script was terminated. Process has been killed.\n")
                lf.flush()
                
                # CRITICAL FIX: Properly terminate the subprocess and all its children
                try:
                    # Get the subprocess PID from the executor
                    if hasattr(process_executor, '_processes') and process_executor._processes:
                        for process in process_executor._processes.values():
                            if process and process.is_alive():
                                subprocess_pid = process.pid
                                lf.write(f"Terminating subprocess PID: {subprocess_pid}\n")
                                lf.flush()
                                
                                # Use the new process tree killing function
                                success = _kill_process_tree(subprocess_pid, timeout=5)
                                if success:
                                    lf.write(f"Successfully killed process tree for PID: {subprocess_pid}\n")
                                else:
                                    lf.write(f"Failed to kill process tree for PID: {subprocess_pid}\n")
                                    # Fallback: use system kill command
                                    try:
                                        sp.run(['kill', '-9', str(subprocess_pid)], check=False)
                                        lf.write(f"Used system kill -9 for PID: {subprocess_pid}\n")
                                    except Exception:
                                        pass
                                lf.flush()
                                break
                except Exception as cleanup_error:
                    lf.write(f"Error during subprocess cleanup: {cleanup_error}\n")
                    lf.flush()
                
                # Shutdown the executor properly
                if process_executor:
                    try:
                        process_executor.shutdown(wait=True, cancel_futures=True)
                        lf.write("ProcessPoolExecutor shutdown completed\n")
                        lf.flush()
                    except Exception as shutdown_error:
                        lf.write(f"Error during executor shutdown: {shutdown_error}\n")
                        lf.flush()
                
                end_script_summary_wait(
                    _exec_uid,
                    error_code=4608,
                    error_message="Script execution timed out after 60 seconds.",
                )
                script_answer_wait_active = False
                return error_response(
                    "Script execution timed out after 60 seconds. "
                    "Please optimize your code or reduce the data size."
                )
                
            except Exception as exec_error:
                execution_end = datetime.now()
                duration = (execution_end - execution_start).total_seconds()
                
                lf.write(f"\nEnd time: {execution_end.isoformat()}\n")
                lf.write(f"Duration: {duration:.2f} seconds\n")
                lf.write("\n--- Execution Error ---\n")
                lf.write(str(exec_error) + "\n")
                lf.write(traceback.format_exc() + "\n")
                lf.flush()
                raise
                
            finally:
                # Always cleanup the process executor properly
                if process_executor:
                    try:
                        # Ensure all processes are terminated using process tree killing
                        if hasattr(process_executor, '_processes') and process_executor._processes:
                            for process in process_executor._processes.values():
                                if process and process.is_alive():
                                    try:
                                        subprocess_pid = process.pid
                                        lf.write(f"Cleaning up subprocess PID: {subprocess_pid}\n")
                                        lf.flush()
                                        
                                        # Use process tree killing for thorough cleanup
                                        success = _kill_process_tree(subprocess_pid, timeout=3)
                                        if success:
                                            lf.write(f"Successfully cleaned up process tree for PID: {subprocess_pid}\n")
                                        else:
                                            lf.write(f"Failed to clean up process tree for PID: {subprocess_pid}\n")
                                        lf.flush()
                                    except Exception as kill_error:
                                        lf.write(f"Error during process cleanup: {kill_error}\n")
                                        lf.flush()
                        
                        # Shutdown with wait=True to ensure cleanup
                        process_executor.shutdown(wait=True, cancel_futures=True)
                        lf.write("ProcessPoolExecutor cleanup completed\n")
                        lf.flush()
                    except Exception as cleanup_error:
                        lf.write(f"Error during final cleanup: {cleanup_error}\n")
                        lf.flush()

        # JSON-safe result; include log path for frontend consumption
        result_json = convert_for_json(result)
        if isinstance(result_json, dict):
            execution_payload = {**result_json, "log_path": log_path}
        else:
            execution_payload = {"result": result_json, "log_path": log_path}

        # Do not post_answer here: frontend calls summary_answer next, which posts once (avoids Chatbox JSON/summary race).

        return success_response({
            "zarr_path": resolved_zarr_path,
            "execution_result": execution_payload
        })
    except Exception as e:
        if script_answer_wait_active:
            try:
                end_script_summary_wait(
                    _exec_uid,
                    error_code=4500,
                    error_message=f"Execution failed: {str(e)}",
                )
            except Exception:
                pass
            script_answer_wait_active = False
        # Append error/traceback to log file when possible
        try:
            fallback_logs_base_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "storage", "tasknode_logs"))
            os.makedirs(fallback_logs_base_dir, exist_ok=True)
            
            # Use date-based subdirectory for error logs too
            today_stamp = datetime.now().strftime("%Y-%m-%d")
            fallback_day_dir = os.path.join(fallback_logs_base_dir, today_stamp)
            os.makedirs(fallback_day_dir, exist_ok=True)
            
            fallback_error_log = os.path.join(fallback_day_dir, "CodeScript__error.log")
            with open(locals().get("log_path", fallback_error_log), "a", encoding="utf-8") as lf:
                lf.write("\n--- Error ---\n")
                lf.write(str(e) + "\n")
                lf.write(traceback.format_exc() + "\n")
        except Exception:
            pass
        return error_response(
            f"Execution failed: {str(e)}" + (f", see log: {locals().get('log_path')}" if 'log_path' in locals() else "")
        )


@tasks_router.post("/v1/summary_answer")
async def agent_summary(
    request: SummaryAnswerRequest,
    http_request: Request,
    auth_user: Optional[AuthUser] = Depends(get_optional_auth_user),
):
    """
    Return natural language summary of the answer.
    Delegates to Ctrl-Service for the summary.
    """
    try:
        question = request.prompt
        parameters = request.parameters or {}
        answer = parameters.get("answer")
        if answer is None:
            raise ValueError("Missing 'answer' in parameters")

        response_text: Optional[str] = None
        ctrl_error: Optional[str] = None

        # Delegate to Control Service for the summary
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

        # Fallback to local simple summary if Control Service failed
        if not response_text:
            try:
                # Simple local fallback: generate a basic summary from the answer
                response_text = _generate_simple_summary(question, answer)
                logger.warning(f"[summary_answer] Ctrl-Service failed ({ctrl_error}), using local fallback")
            except Exception as fallback_exc:
                # If fallback also fails, set response_text to empty string (matching original behavior)
                # Original implementation would set response_text = "" and still call post_answer
                fallback_error = str(fallback_exc)
                if not ctrl_error:
                    ctrl_error = fallback_error
                else:
                    # Include both errors in ctrl_error for logging
                    ctrl_error = f"{ctrl_error}. Local fallback also failed: {fallback_error}"
                response_text = ""  # Empty string, matching original behavior
                logger.warning(f"[summary_answer] Both Ctrl-Service and fallback failed: {ctrl_error}")

        # Ensure Chatbox poller receives the summary (with user-specific state)
        # Always call post_answer, even if response_text is empty (matching original behavior)
        # This ensures the Chatbox polling system receives an update and stops waiting
        try:
            uid = auth_user.uid if auth_user else None
            post_answer(response_text or "", uid=uid)
        except Exception:
            pass

        response = {
            "agent_id": request.agent_id,
            "response": response_text,
            "parameters": request.parameters,
            "control_error": ctrl_error,
        }

        # Always return success_response, matching original behavior
        # This ensures the frontend receives a response and can handle empty response_text appropriately
        return success_response(response)
    except Exception as e:
        return error_response(str(e))
