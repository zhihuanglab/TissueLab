import json
import os
import asyncio
import time
from fastapi import WebSocket, WebSocketDisconnect
from concurrent.futures import ThreadPoolExecutor
import traceback
from app.services.seg_service import SegmentationHandler, _h5_cache, preload_data_async
from app.services.type_manage_service import TypeManageHandler
from app.utils import resolve_path
# Auth removed for open source
# AuthUser removed for open source
from typing import Optional, Dict

# Global variables for WebSocket state - now organized by device_id
device_annotation_handlers: Dict[str, SegmentationHandler] = {}
device_type_manage_handlers: Dict[str, TypeManageHandler] = {}
executor = ThreadPoolExecutor(max_workers=5)
receive_count = 0

async def segmentation_endpoint(websocket: WebSocket):
    """
    FastAPI WebSocket endpoint for segmentation with device isolation
    """
    global device_annotation_handlers, device_type_manage_handlers, receive_count
    
    # Get device ID for connection isolation (auth removed for open source)
    # Try to get device_id from query params or use default
    device_id = websocket.query_params.get("device_id", "default_device")
    if not device_id:
        print("WebSocket: No device ID provided, using default")
        device_id = "default_device"
    
    # Auth removed for open source - direct connection without authentication
    try:
        print(f"WebSocket connected on device: {device_id}")
    except WebSocketDisconnect:
        return  # Connection closed due to auth failure
    
    await websocket.accept()
    print(f"WebSocket authenticated and connected for device: {device_id}")
    
    # Initialize device-specific handlers if they don't exist
    if device_id not in device_annotation_handlers:
        device_annotation_handlers[device_id] = None
    if device_id not in device_type_manage_handlers:
        device_type_manage_handlers[device_id] = TypeManageHandler()
    
    try:
        while True:
            data = await websocket.receive_text()
            receive_count += 1
            print(f"WebSocket: Received message #{receive_count}")
            
            try:
                data = json.loads(data)
                
                # handle path updates
                if "path" in data:
                    svs_path = data["path"]
                    
                    if svs_path == '':
                        print("WebSocket: clearing path and resetting handler")
                        # Clear the handler for this device
                        if device_id in device_annotation_handlers:
                            device_annotation_handlers[device_id] = None
                        if device_id in device_type_manage_handlers:
                            device_type_manage_handlers[device_id] = TypeManageHandler()
                        
                        await websocket.send_text(json.dumps({
                            "status": "success",
                            "message": "Annotations cleared and handler reset"
                        }))
                        continue
                    
                    # Handle relative path by constructing full path
                    if svs_path:
                        # Construct full path by joining storage root with relative path
                        full_svs_path = resolve_path(svs_path)
                        print(f"WebSocket: Full SVS path: {full_svs_path}")
                        if full_svs_path.endswith('.h5'):
                            h5_path = full_svs_path
                        else:
                            h5_path = f"{full_svs_path}.h5"  # assume the h5 file is in the same directory as the svs file
                    else:
                        if svs_path and svs_path.endswith('.h5'):
                            h5_path = svs_path
                        else:
                            h5_path = f"{svs_path}.h5"
                    
                    print(f"WebSocket: Received new path: {svs_path}")
                    print(f"WebSocket: Looking for h5 file at: {h5_path}")

                    if os.path.exists(h5_path):
                        try:
                            print(f"WebSocket: Loading h5 file: {h5_path} for device: {device_id}")
                            
                            # Minimal fix: always invalidate cache on set_path to reflect latest H5
                            try:
                                print(f"WebSocket: Clearing cache for {h5_path} on set_path")
                                _h5_cache.force_refresh_cache(h5_path)
                                _h5_cache.notify_handlers_file_changed(h5_path)
                            except Exception as e:
                                print(f"WebSocket: Failed to clear cache on set_path: {e}")

                            cached_data = _h5_cache.get_cached_data(h5_path)
                            if cached_data:
                                print(f"WebSocket: Using cached data for {h5_path}")
                                device_annotation_handlers[device_id] = SegmentationHandler(h5_path)
                                await websocket.send_text(json.dumps({
                                    "status": "success",
                                    "message": "H5 file loaded from cache"
                                }))
                            else:
                                # Check if currently loading
                                if _h5_cache.is_loading(h5_path):
                                    print(f"WebSocket: File {h5_path} is currently being loaded, waiting for completion...")
                                    await websocket.send_text(json.dumps({
                                        "status": "info",
                                        "message": "H5 file is currently being loaded"
                                    }))
                                    
                                    # Wait for loading to complete
                                    while _h5_cache.is_loading(h5_path):
                                        await asyncio.sleep(0.5)  # Wait 500ms before checking again
                                    
                                    # After loading is complete, check if cache is available
                                    cached_data = _h5_cache.get_cached_data(h5_path)
                                    if cached_data:
                                        print(f"WebSocket: File {h5_path} loading completed, using cached data")
                                        device_annotation_handlers[device_id] = SegmentationHandler(h5_path)
                                        await websocket.send_text(json.dumps({
                                            "status": "success",
                                            "message": "H5 file loaded successfully from cache"
                                        }))
                                    else:
                                        # If still no cache after waiting, there might be an error
                                        await websocket.send_text(json.dumps({
                                            "status": "error",
                                            "message": "Failed to load H5 file"
                                        }))
                                else:
                                    # Start async loading
                                    print(f"WebSocket: Starting async load for {h5_path}")
                                    await websocket.send_text(json.dumps({
                                        "status": "info",
                                        "message": "H5 file loading started"
                                    }))
                                    
                                    # Load data asynchronously
                                    await preload_data_async(h5_path)
                                    
                                    # Create handler after loading
                                    # Get the singleton instance without triggering a hard reload
                                    device_annotation_handlers[device_id] = SegmentationHandler()
                                    # Use the safe cache-aware function
                                    device_annotation_handlers[device_id].load_file(h5_path, force_reload=True)
                                    
                                    await websocket.send_text(json.dumps({
                                        "status": "success",
                                        "message": "H5 file loaded successfully"
                                    }))
                                    
                        except Exception as e:
                            error_msg = f"Error loading h5 file: {str(e)}"
                            print(f"WebSocket: {error_msg}")
                            traceback.print_exc()
                            await websocket.send_text(json.dumps({
                                "status": "error",
                                "message": error_msg,
                                "error_type": type(e).__name__
                            }))
                    else:
                        print(f"WebSocket: No h5 file found at: {h5_path}")
                        await websocket.send_text(json.dumps({
                            "status": "error",
                            "message": f"No h5 file found at: {h5_path}. Please check the path or upload the file.",
                            "error_type": "FileNotFoundError"
                        }))
                       
                        continue

                # handle viewport update requests
                annotation_handler = device_annotation_handlers.get(device_id)
                if not annotation_handler:
                    request_type = data.get("type", "unknown")
                    print(f"WebSocket: No annotation handler available for device {device_id}, request type: {request_type}")
                    
                    # Check if this is a user-initiated request that should show error
                    if request_type in ['space', 'x', 'centroids', 'patches']:
                        # Send error message for user-initiated requests
                        error_response = {
                            "status": "error",
                            "message": "No H5 file loaded or segmentation data not available",
                            "error_type": "NoDataError"
                        }
                        print(f"WebSocket: *** SENDING NoDataError for {request_type}: {error_response} ***")
                        await websocket.send_text(json.dumps(error_response))
                        print(f"WebSocket: *** NoDataError SENT for {request_type} ***")
                    else:
                        # For automatic requests (like set_path), just log and continue
                        print(f"WebSocket: Ignoring {request_type} request - no handler available yet")
                    continue
                
                # Check for pending cache updates for previously locked files
                _h5_cache.check_and_update_pending_caches()
                
                # Check if the file has changed and reload handler if necessary
                current_file_path = annotation_handler.get_current_file_path()
                if current_file_path and _h5_cache.is_file_changed(current_file_path):
                    print(f"WebSocket: File {current_file_path} has changed, reloading handler for device {device_id}")
                    
                    # Check if file is locked before attempting reload
                    if _h5_cache.is_file_locked(current_file_path):
                        print(f"WebSocket: File {current_file_path} is locked, attempting to use cached data...")
                        
                        # Try to get cached data first with maximum priority
                        cached_data = _h5_cache.get_cached_data_priority(current_file_path)
                        if cached_data:
                            print(f"WebSocket: Using cached data for locked file {current_file_path}")
                            # Apply cached data to handler without forcing file reload
                            annotation_handler.load_file(current_file_path, force_reload=False)
                            print(f"WebSocket: Handler updated with cached data for device {device_id}")
                            continue
                        else:
                            print(f"WebSocket: No cached data available for locked file {current_file_path}, waiting briefly...")
                            max_wait_time = 5.0  # Reduced wait time since we prioritize cache
                            wait_start = time.time()
                            while _h5_cache.is_file_locked(current_file_path) and (time.time() - wait_start) < max_wait_time:
                                await asyncio.sleep(0.5)
                            
                            if _h5_cache.is_file_locked(current_file_path):
                                print(f"WebSocket: File {current_file_path} is still locked after {max_wait_time}s, using any available cached data")
                                # Try to use any available cached data even if stale
                                annotation_handler.load_file(current_file_path, force_reload=False)
                                continue
                    
                    # Force refresh cache and reload handler
                    _h5_cache.force_refresh_cache(current_file_path)
                    await preload_data_async(current_file_path)
                    annotation_handler.load_file(current_file_path, force_reload=True)
                    print(f"WebSocket: Handler reloaded for device {device_id}")

                try:
                    x1, y1, x2, y2 = data.get("x1"), data.get("y1"), data.get("x2"), data.get("y2")
                    request_type = data.get("type")
                    
                    # Log detailed viewport request
                    print(f"WebSocket: Processing {request_type} request for viewport ({x1}, {y1}, {x2}, {y2})")

                    if request_type == "annotations":
                        use_classification = data.get("use_classification", True)
                        print(f"WebSocket: Getting annotations with classification={use_classification}")
                        
                        annotations, class_counts_by_id = await asyncio.get_running_loop().run_in_executor(
                            executor,
                            annotation_handler.get_annotations_in_viewport,
                            x1, y1, x2, y2, use_classification
                        )

                        receive_count += 1
                        print(f"WebSocket: Found {len(annotations)} annotations for viewport")
                        if annotations:
                            try:
                                payload = {
                                    "type": "annotations",
                                    "annotations": annotations,
                                    **class_counts_by_id
                                }
                                await websocket.send_text(json.dumps(payload, default=str))
                                print(f"WebSocket: Sent {len(annotations)} annotations to client")
                            except Exception as e:
                                print(f"WebSocket: Error sending annotations: {str(e)}")
                                traceback.print_exc()
                    
                    elif request_type == "centroids":
                        print(f"WebSocket: Getting centroids")
                        
                        points, class_counts_by_id = await asyncio.get_running_loop().run_in_executor(
                            executor,
                            annotation_handler.get_centroids_in_viewport,
                            x1, y1, x2, y2
                        )
                        
                        print(f"WebSocket: Found {len(points)} centroids")
                        payload = {
                            "type": "centroids",
                            "centroids": points,
                            **class_counts_by_id
                        }
                        
                        # Debug: Print payload keys to check if color info is included
                        print(f"WebSocket: Payload keys: {list(payload.keys())}")
                        if 'class_names' in payload:
                            print(f"WebSocket: Sending class_names: {payload['class_names']}")
                        if 'class_colors' in payload:
                            print(f"WebSocket: Sending class_colors: {payload['class_colors']}")
                        
                        await websocket.send_text(json.dumps(payload, default=str))
                        print(f"WebSocket: Sent {len(points)} centroids to client")
                    
                    elif request_type == "patches":
                        print(f"WebSocket: *** PATCHES REQUEST RECEIVED ***")
                        print(f"WebSocket: Getting patches in viewport: ({x1}, {y1}, {x2}, {y2})")
                        print(f"WebSocket: annotation_handler exists: {annotation_handler is not None}")
                        patches, class_counts_by_id = await asyncio.get_running_loop().run_in_executor(
                            executor,
                            annotation_handler.get_patch_centroids_in_viewport,
                            x1, y1, x2, y2
                        )
                        print(f"WebSocket: Found {len(patches)} patches")
                        if len(patches) > 0:
                            try:
                                payload = {
                                    "type": "patches",
                                    "patches": patches,
                                    **class_counts_by_id
                                }
                                await websocket.send_text(json.dumps(payload, default=str))
                                print(f"WebSocket: Sent {len(patches)} patches to client")
                            except Exception as e:
                                print(f"WebSocket: Error sending patches: {str(e)}")
                                traceback.print_exc()
                        else:
                            # Send error response when no patches are found
                            print("WebSocket: No patches found, sending error response")
                            await websocket.send_text(json.dumps({
                                "status": "error",
                                "message": "No patch data found in the H5 file",
                                "error_type": "NoDataError"
                            }))

                    elif request_type == "mark_region":
                        color = data.get("color")
                        category = data.get("type")
                        print(f"WebSocket: Marking region with color={color}, category={category}")
                        
                        centroids_result = await asyncio.get_running_loop().run_in_executor(
                            executor,
                            annotation_handler.get_centroids_in_viewport,
                            x1, y1, x2, y2
                        )
                        
                        # Handle the return value properly
                        if isinstance(centroids_result, tuple) and len(centroids_result) == 2:
                            centroids, _ = centroids_result
                        else:
                            centroids = centroids_result if isinstance(centroids_result, list) else []

                        idx_list = [centroid[0] for centroid in centroids]
                        print(f"WebSocket: Found {len(idx_list)} indices to mark")

                        type_manage_handler = device_type_manage_handlers.get(device_id)
                        if type_manage_handler:
                            for idx in idx_list:
                                type_manage_handler.update_type(idx, color, category)

                        try:
                            await websocket.send_text(json.dumps({
                                "type": "mark_region",
                                "indices": idx_list
                            }, default=str))
                            print(f"WebSocket: Marked {len(idx_list)} regions successfully")
                        except Exception as e:
                            print(f"WebSocket: Error sending mark_region response: {str(e)}")
                            traceback.print_exc()

                    elif request_type == "all_annotations":
                        print(f"WebSocket: Getting all annotations")
                        use_classification = data.get(
                            "use_classification", True)
                        print(
                            f"WebSocket: Getting annotations with classification={use_classification}")

                        annotations, class_counts_by_id = await asyncio.get_running_loop().run_in_executor(
                            executor,
                            annotation_handler.get_annotations_in_viewport,
                            x1, y1, x2, y2, use_classification
                        )

                        print(
                            f"WebSocket: Found {len(annotations)} annotations")
                        if annotations:
                            try:
                                payload = {
                                    "type": "all_annotations",
                                    "all_annotations": annotations,
                                    **class_counts_by_id
                                }
                                await websocket.send_text(json.dumps(payload, default=str))
                                print(f"WebSocket: Sent {len(annotations)} annotations to client")
                            except Exception as e:
                                print(f"WebSocket: Error sending all_annotations: {str(e)}")
                                traceback.print_exc()
                    else:
                        print(f"WebSocket: Unknown request type: {request_type}")

                except Exception as e:
                    error_msg = f"Error processing viewport request: {str(e)}"
                    print(f"WebSocket: {error_msg}")
                    traceback.print_exc()
                    try:
                        await websocket.send_text(json.dumps({
                            "error": error_msg,
                            "error_type": type(e).__name__,
                            "viewport": {"x1": data.get("x1"), "y1": data.get("y1"), 
                                         "x2": data.get("x2"), "y2": data.get("y2")}
                        }))
                    except Exception as send_error:
                        print(f"WebSocket: Failed to send error message: {str(send_error)}")
            
            except json.JSONDecodeError as e:
                print(f"WebSocket: JSON decode error: {str(e)}")
                try:
                    await websocket.send_text(json.dumps({
                        "error": f"Invalid JSON format: {str(e)}",
                        "error_type": "JSONDecodeError"
                    }))
                except Exception:
                    pass  # If we can't even send the error, just continue
    
    except WebSocketDisconnect:
        print(f"WebSocket disconnected for device: {device_id}")
    except Exception as e:
        print(f"WebSocket error for device {device_id}: {str(e)}")
        traceback.print_exc()
    finally:
        # Clean up device-specific resources
        if device_id in device_annotation_handlers:
            print(f"Cleaning up annotation handler for device: {device_id}")
            # Note: We don't delete the handler immediately as other connections
            # from the same device might still be using it
        print(f"WebSocket connection closed for device: {device_id}")


def cleanup_device_resources(device_id: str):
    """
    Clean up resources for a specific device when all connections are closed
    """
    global device_annotation_handlers, device_type_manage_handlers
    
    if device_id in device_annotation_handlers:
        print(f"Cleaning up all resources for device: {device_id}")
        del device_annotation_handlers[device_id]
    
    if device_id in device_type_manage_handlers:
        del device_type_manage_handlers[device_id]
    
    print(f"Device {device_id} resources cleaned up")
