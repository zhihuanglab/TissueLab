import os
from fastapi import APIRouter, Request, BackgroundTasks, HTTPException, Body
from fastapi.responses import StreamingResponse
from app.core import logger
from app.core.response import success_response, error_response
from typing import Optional
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
from app.services.model_store import model_store
from app.utils import resolve_path

import asyncio

tasks_router = APIRouter()

@tasks_router.get("/v1/activation/events")
def activation_events(model: str):
    """Server-Sent Events stream for a specific model's activation status."""
    from app.services.tasks_service import generate_activation_events
    try:
        return StreamingResponse(
            generate_activation_events(model),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    except Exception as e:
        return error_response(f"Failed to start activation stream: {e}")

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
    model_name: str = "ClassificationNode"  # Hardcoded default
    gcs_uri: str | None = None  # Made optional since we now use API
    filename: str | None = None
    entry_relative_path: str = "main"  # Default entry point
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
def get_log_tail(path: str, n: int = 200):
    """
    Return the last n lines of a log file. n defaults to 200.
    """
    try:
        # Security: only allow reading from storage/tasknode_logs
        import os
        base_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "storage", "tasknode_logs"))
        target = os.path.abspath(path)
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
    for key in ["h5_path", "file_path", "path", "classifier_path", "save_classifier_path"]:
        if key in req and isinstance(req[key], str):
            req[key] = resolve_path(req[key])
    return req

# function to patch paths recursively

def patch_paths_recursive(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ["h5_path", "file_path", "path", "classifier_path", "save_classifier_path"] and isinstance(v, str):
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
        
        result = service_create_node(
            service_name=req.service_name,
            file_path=resolve_path(req.file_path),
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
def get_answer():
    from app.services.tasks_service import is_generating, cur_answer
    
    if is_generating:
        return success_response({
            "message": "wait",
            "answer": ""
        })
    else:
        data = {
            "message": "done",
            "answer": cur_answer
        }
        # Reset cur_answer in the service layer
        from app.services.tasks_service import reset_answer
        reset_answer()
        return success_response(data)

@tasks_router.post("/v1/start_workflow")
async def start_workflow_from_frontend(frontend_data: dict, background_tasks: BackgroundTasks, request: Request):
    """
    Start workflow from frontend
    
    frontend_data format example:
    "h5_path": "/Users/xxx/Desktop/my_workflow_data.h5",
      "step1": {
        "model": "BiomedParseNode",
        "input": {
          "path": "/Users/xxx/Desktop/test.png",
          "other_param": 123
        }
      },
      "step2": {
        "model": "SegmentationNode",
        "input": {
          "path": "/Users/xxx/Desktop/example_WSI/CMU-1.svs",
          "read_image_method": "tiffslide",
          "stardist_pretrain": "2D_versatile_he",
          "calculate_features": true
        }
      }
    """
    frontend_data = patch_paths_recursive(frontend_data)
    # Call service layer's start_workflow_from_frontend function
    from app.services.tasks_service import start_workflow_from_frontend as service_start_workflow
    from app.services.tasks_service import run_workflow_in_background as service_run_workflow_in_background
    
    auth_header = request.headers.get("authorization")

    result = await service_start_workflow(frontend_data, auth_header)
    
    if not result.get("success", False):
        return error_response(result.get("error", "Unknown error occurred when starting workflow"))
    
    # Get task information and start background task
    task_info = result.get("task_info", {})
    wf_id = task_info.get("wf_id")
    node_inputs = task_info.get("node_inputs", {})
    script_prompt = task_info.get("script_prompt")
    h5_path = task_info.get("h5_path")
    
    # Create appropriate background task, calling service layer's run_workflow_in_background function
    logger.info(f"🎯 Creating background task for workflow {wf_id}")
    logger.info(f"📋 Node inputs: {list(node_inputs.keys())}")
    logger.info(f"📁 H5 path: {h5_path}")
    
    auth_token = task_info.get("auth_token", auth_header)

    background_task = asyncio.create_task(
        service_run_workflow_in_background(
            wf_id,
            node_inputs,
            script_prompt,
            h5_path,
            auth_token
        )
    )
    logger.info(f"Background task created: {background_task}")
    
    return success_response({
        "message": result.get("message", f"Workflow '{wf_id}' submitted to background"),
        "workflow_id": wf_id
    })

@tasks_router.get("/v1/workflow_status/{wf_id}")
def get_workflow_status(wf_id: int):
    """
    return background task status
    """
    if wf_id not in workflow_run_status:
        return error_response(f"No record of workflow {wf_id}")

    status_info = workflow_run_status[wf_id]
    return success_response({
        "status": status_info["status"],
        "result": status_info["result"]  # if done or error
    })

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


@tasks_router.post("/v1/register_custom_node_async")
async def register_custom_node_async(req: RegisterCustomNodeAsyncRequest):
    """
    Immediately create a log file and return its path, then run registration in background.
    """
    try:
        # Pre-create a log file name to stream logs immediately
        from datetime import datetime
        import os
        safe_model = "".join(c if c.isalnum() or c in ("-","_") else "_" for c in req.model_name)
        env_name = req.env_name or f"{req.model_name}_tissuelab_ai_service_tasknode"
        safe_env = "".join(c if c.isalnum() or c in ("-","_") else "_" for c in env_name)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        logs_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "storage", "tasknode_logs"))
        os.makedirs(logs_dir, exist_ok=True)
        log_path = os.path.join(logs_dir, f"{safe_model}__{safe_env}__{ts}.log")
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
        # Source categories from ModelStore to include custom/built-in uniformly
        return success_response(model_store.get_category_map())
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.get("/v1/get_status")
async def get_status():
    """
    Return the status of each node in the current workflow as Server-Sent Events (SSE).
    
    Status codes:
        0 - Not started
        1 - Running
        2 - Completed
    
    This endpoint uses SSE to continuously send status updates to the client.
    """
    # Import the event generator from the service layer
    from app.services.tasks_service import generate_node_status_events
    
    # Return a streaming response using the service layer's event generator
    return StreamingResponse(
        generate_node_status_events(),
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
    Receive annotation data and save to H5 file
    """
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
    find precise matching patches, and save classification to H5 file.
    """
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

@tasks_router.post("/v1/reset_classification", summary="Reset classification and annotation data in H5 file")
async def reset_classification_data_endpoint(request: Request):
    """
    Resets classification results and user annotations in the specified H5 file.
    This involves deleting the 'ClassificationNode' and 'user_annotation' groups.
    """
    from app.services.tasks_service import reset_h5_classification_data
    data = await request.json()
    h5_path = data.get("h5_path")
    if not h5_path:
        return error_response("h5_path is required")

    result = reset_h5_classification_data(resolve_path(h5_path))

    if result["status"] == "error":
        return error_response(result["message"])
        
    return success_response(result)

@tasks_router.post("/v1/reset_patch_classification", summary="Reset patch classification (tissue_*) and user annotations in H5 file, preserving MuskNode embeddings")
async def reset_patch_classification_endpoint(request: Request):
    from app.services.tasks_service import reset_patch_classification_data
    data = await request.json()
    h5_path = data.get("h5_path")
    if not h5_path:
        return error_response("h5_path is required")
    result = reset_patch_classification_data(resolve_path(h5_path))
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
def list_node_ports():
    """
    List all TaskNodes and their port numbers.
    
    This endpoint collects port information from:
    1. The services dictionary
    2. The TaskNodeManager nodes
    3. Custom nodes from the custom node registry
    
    Returns:
    - A dictionary with node names as keys and port numbers as values
    - Additional metadata about the nodes where available (e.g., running status, factory)
    """
    try:
        # Call service layer's list_node_ports function
        from app.services.tasks_service import list_node_ports as service_list_node_ports
        
        result = service_list_node_ports()
        
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
        nodes = model_store.get_nodes_extended()
        category_map = model_store.get_category_map()
        category_display_names = model_store.get_category_display_names()

        # Check which service paths actually exist for bundle detection
        for node_name, node_data in nodes.items():
            if isinstance(node_data, dict) and "runtime" in node_data:
                runtime = node_data.get("runtime", {})
                if isinstance(runtime, dict) and "service_path" in runtime:
                    service_path = runtime.get("service_path")
                    if isinstance(service_path, str):
                        # Check if the service path exists and is executable
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
    h5_path: str

@tasks_router.post("/v1/stop_workflow")
def stop_workflow(req: StopWorkflowRequest):
    """
    Stop the current workflow execution and rollback files if needed
    """
    try:
        # Call service layer's stop_workflow function
        from app.services.tasks_service import stop_workflow as service_stop_workflow
        
        result = service_stop_workflow(resolve_path(req.h5_path))
        
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