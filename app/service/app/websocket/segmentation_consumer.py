import json
import asyncio
import zstandard as zstd
import orjson
import time
import os
import traceback
import struct
import numpy as np
from fastapi import WebSocket, WebSocketDisconnect
from concurrent.futures import ThreadPoolExecutor
from app.services.seg_service import SegmentationHandler
from app.services.type_manage_service import TypeManageHandler
from app.utils import resolve_path, register_zarr_store
from app.config.path_config import resolve_virtual_path
from app.middlewares.websocket_auth_middleware import websocket_auth_required, get_device_id_from_websocket
from app.core.auth import AuthUser
from app.websocket.device_connection_manager import device_connection_manager
from app.core.logger import logger
from typing import Optional, Dict, List, Tuple

# Global variables for WebSocket state - now organized by device_id
device_annotation_handlers: Dict[str, SegmentationHandler] = {}
device_type_manage_handlers: Dict[str, TypeManageHandler] = {}
executor = ThreadPoolExecutor(max_workers=5)
receive_count = 0

def pack_segmentation_binary(points: List[List], class_names: Optional[List[str]] = None, class_colors: Optional[List[str]] = None, class_counts_by_id: Optional[Dict] = None) -> Tuple[bytes, Dict[str, float]]:
    """
    Pack segmentation data into binary format.
    Format: 
    - Header (little-endian):
      - uint32: count of points
      - uint32: count of class names (0 if None)
    - Points array: each point is [id(uint32), x(int32), y(int32), class_id(int32)]
    - Class names: each name is [length(uint32), utf-8 bytes]
    - Class colors: each color is [length(uint32), utf-8 bytes]
    - Class counts: JSON string [length(uint32), utf-8 bytes]
    
    Returns:
        Tuple of (binary_data, performance_metrics)
    """
    perf_start = time.time()
    num_points = len(points)
    
    # Pre-allocate bytearray with estimated size to reduce reallocations
    # Estimate: 4 (count) + num_points * 16 (points) + 1000 (metadata overhead)
    estimated_size = 4 + num_points * 16 + 1000
    binary_data = bytearray(estimated_size)
    current_offset = 0
    
    # Pack points count
    pack_start = time.time()
    struct.pack_into('<I', binary_data, current_offset, num_points)
    current_offset += 4
    
    # Pack points: id(uint32), x(int32), y(int32), class_id(int32)
    # Optimized: Use numpy structured array for ultra-fast batch processing
    points_pack_start = time.time()
    conversion_time = 0
    struct_time = 0
    if num_points > 0:
        conv_start = time.time()
        # Check if points is already a numpy array (much faster)
        if isinstance(points, np.ndarray):
            # Already a numpy array, just ensure correct dtype and shape (int32 for coordinates)
            points_array = points.astype(np.int32, copy=False)
        elif isinstance(points, list) and len(points) > 0 and isinstance(points[0], (list, tuple, np.ndarray)):
            # List of lists/arrays - convert more efficiently
            # Try to detect if it's a list of numpy arrays first
            if isinstance(points[0], np.ndarray):
                # List of numpy arrays - stack them
                points_array = np.vstack(points).astype(np.int32)
            else:
                # Regular list of lists - use np.array (slower but necessary)
                points_array = np.array(points, dtype=np.int32)
        else:
            # Fallback for other types
            points_array = np.array(points, dtype=np.int32)
        conversion_time = time.time() - conv_start
        
        # Ensure we have 4 columns (pad with -1 for class_id if needed)
        if points_array.ndim == 1:
            # Single point, reshape to 2D
            points_array = points_array.reshape(1, -1)
        
        if points_array.shape[1] < 4:
            # Pad with -1 for missing class_id
            padded = np.full((num_points, 4), -1, dtype=np.int32)
            padded[:, :points_array.shape[1]] = points_array
            points_array = padded
        
        # Create structured array with exact binary layout matching struct format
        # Format: '<Iiii' = little-endian, uint32, int32, int32, int32
        struct_start = time.time()
        dtype = np.dtype([
            ('id', '<u4'),      # uint32, little-endian
            ('x', '<i4'),       # int32, little-endian
            ('y', '<i4'),       # int32, little-endian
            ('class_id', '<i4') # int32, little-endian
        ])
        
        # Create structured array and convert to bytes
        # Use views to avoid copying data when possible
        structured_array = np.empty(num_points, dtype=dtype)
        structured_array['id'] = points_array[:, 0].astype(np.uint32, copy=False)
        structured_array['x'] = points_array[:, 1].astype(np.int32, copy=False)
        structured_array['y'] = points_array[:, 2].astype(np.int32, copy=False)
        structured_array['class_id'] = points_array[:, 3].astype(np.int32, copy=False)
        
        # Convert to bytes and write directly to bytearray at current offset
        # This avoids extend() overhead and memory reallocation
        points_bytes = structured_array.tobytes()
        if current_offset + len(points_bytes) > len(binary_data):
            # Resize if needed (should be rare with good estimation)
            binary_data.extend(bytearray(current_offset + len(points_bytes) - len(binary_data)))
        binary_data[current_offset:current_offset + len(points_bytes)] = points_bytes
        current_offset += len(points_bytes)
        struct_time = time.time() - struct_start
    points_pack_time = time.time() - points_pack_start
    
    # Pack class names count (optimized: use pack_into to avoid extend overhead)
    names_pack_start = time.time()
    num_class_names = len(class_names) if class_names else 0
    if current_offset + 4 > len(binary_data):
        binary_data.extend(bytearray(current_offset + 4 - len(binary_data)))
    struct.pack_into('<I', binary_data, current_offset, num_class_names)
    current_offset += 4
    
    # Pack class names (optimized: use pack_into and slice assignment)
    if class_names:
        for name in class_names:
            name_bytes = name.encode('utf-8')
            name_len = len(name_bytes)
            required_size = current_offset + 4 + name_len
            if required_size > len(binary_data):
                binary_data.extend(bytearray(required_size - len(binary_data)))
            struct.pack_into('<I', binary_data, current_offset, name_len)
            current_offset += 4
            binary_data[current_offset:current_offset + name_len] = name_bytes
            current_offset += name_len
    names_pack_time = time.time() - names_pack_start
    
    # Pack class colors count (optimized: use pack_into)
    colors_pack_start = time.time()
    num_class_colors = len(class_colors) if class_colors else 0
    if current_offset + 4 > len(binary_data):
        binary_data.extend(bytearray(current_offset + 4 - len(binary_data)))
    struct.pack_into('<I', binary_data, current_offset, num_class_colors)
    current_offset += 4
    
    # Pack class colors (optimized: use pack_into and slice assignment)
    if class_colors:
        for color in class_colors:
            color_bytes = color.encode('utf-8')
            color_len = len(color_bytes)
            required_size = current_offset + 4 + color_len
            if required_size > len(binary_data):
                binary_data.extend(bytearray(required_size - len(binary_data)))
            struct.pack_into('<I', binary_data, current_offset, color_len)
            current_offset += 4
            binary_data[current_offset:current_offset + color_len] = color_bytes
            current_offset += color_len
    colors_pack_time = time.time() - colors_pack_start
    
    # Pack class counts as JSON string (optimized: use pack_into)
    counts_pack_start = time.time()
    counts_json = json.dumps(class_counts_by_id) if class_counts_by_id else '{}'
    counts_bytes = counts_json.encode('utf-8')
    counts_len = len(counts_bytes)
    required_size = current_offset + 4 + counts_len
    if required_size > len(binary_data):
        binary_data.extend(bytearray(required_size - len(binary_data)))
    struct.pack_into('<I', binary_data, current_offset, counts_len)
    current_offset += 4
    binary_data[current_offset:current_offset + counts_len] = counts_bytes
    current_offset += counts_len
    counts_pack_time = time.time() - counts_pack_start
    
    # Trim to actual size to avoid sending extra bytes
    binary_data = binary_data[:current_offset]
    
    total_time = time.time() - perf_start
    binary_size = len(binary_data)
    
    performance_metrics = {
        'total_pack_time_ms': total_time * 1000,
        'points_pack_time_ms': points_pack_time * 1000,
        'points_conversion_time_ms': conversion_time * 1000,
        'points_struct_time_ms': struct_time * 1000,
        'names_pack_time_ms': names_pack_time * 1000,
        'colors_pack_time_ms': colors_pack_time * 1000,
        'counts_pack_time_ms': counts_pack_time * 1000,
        'binary_size_bytes': binary_size,
        'binary_size_mb': binary_size / (1024 * 1024),
        'points_count': num_points,
        'points_per_second': num_points / total_time if total_time > 0 else 0
    }
    
    return bytes(binary_data), performance_metrics

def pack_annotations_binary(annotations: List[Dict], class_names: Optional[List[str]] = None, class_colors: Optional[List[str]] = None, class_counts_by_id: Optional[Dict] = None) -> Tuple[bytes, Dict[str, float]]:
    """
    Pack annotation/contour data into binary format.
    Format:
    - Header (little-endian):
      - uint32: count of annotations
    - Annotations array: each annotation is:
      - uint32: id (nucleus index)
      - int32: class_id
      - uint32: point count
      - Points array: [x(int32), y(int32)] * point_count
    - Class names: each name is [length(uint32), utf-8 bytes]
    - Class colors: each color is [length(uint32), utf-8 bytes]
    - Class counts: JSON string [length(uint32), utf-8 bytes]
    
    Returns:
        Tuple of (binary_data, performance_metrics)
    """
    perf_start = time.time()
    binary_data = bytearray()
    
    # Pack annotations count
    num_annotations = len(annotations)
    binary_data.extend(struct.pack('<I', num_annotations))
    
    # Pack annotations
    annotations_pack_start = time.time()
    conversion_time = 0
    struct_time = 0
    
    if num_annotations > 0:
        conv_start = time.time()
        # Log progress for large datasets
        if num_annotations > 100:
            logger.info(f"Packing {num_annotations} annotations...")
        
        # Process each annotation
        processed_count = 0
        for i, ann in enumerate(annotations):
            try:
                ann_id = int(ann.get('id', 0)) if isinstance(ann.get('id'), (int, str)) else 0
                class_id = int(ann.get('class_id', -1))
                points = ann.get('points', [])
                
                # Convert points to numpy array if needed
                if isinstance(points, np.ndarray):
                    # Already numpy array, ensure correct dtype (int32 for coordinates)
                    points_array = points.astype(np.int32, copy=False)
                elif isinstance(points, list):
                    # Convert list to numpy array (int32 for coordinates)
                    points_array = np.array(points, dtype=np.int32)
                else:
                    points_array = np.array([], dtype=np.int32)
                
                # Get point count (handle both 1D and 2D arrays)
                if points_array.ndim == 0 or points_array.size == 0:
                    num_points = 0
                elif points_array.ndim == 1:
                    # 1D array: assume it's flattened [x1, y1, x2, y2, ...]
                    num_points = len(points_array) // 2
                    if num_points > 0:
                        points_array = points_array.reshape(-1, 2)
                else:
                    # 2D array: shape is (n_points, 2)
                    num_points = len(points_array)
                
                # Pack annotation header: id(uint32), class_id(int32), point_count(uint32)
                binary_data.extend(struct.pack('<IiI', ann_id, class_id, num_points))
                
                # Pack points if any
                if num_points > 0 and points_array.size > 0:
                    # Ensure 2D array (x, y coordinates)
                    if points_array.ndim == 1:
                        points_array = points_array.reshape(-1, 2)
                    
                    # Ensure we have at least 2 columns
                    if points_array.shape[1] < 2:
                        # Pad with zeros if needed
                        padded = np.zeros((num_points, 2), dtype=np.int32)
                        padded[:, :points_array.shape[1]] = points_array
                        points_array = padded
                    
                    # Create structured array for points: [x(int32), y(int32)]
                    point_dtype = np.dtype([('x', '<i4'), ('y', '<i4')])
                    structured_points = np.empty(num_points, dtype=point_dtype)
                    structured_points['x'] = points_array[:, 0].astype(np.int32, copy=False)
                    structured_points['y'] = points_array[:, 1].astype(np.int32, copy=False)
                    
                    # Convert to bytes
                    points_bytes = structured_points.tobytes()
                    binary_data.extend(points_bytes)
                
                processed_count += 1
                # Log progress every 100 annotations for large datasets
                if num_annotations > 100 and (i + 1) % 100 == 0:
                    logger.debug(f"Packed {i + 1}/{num_annotations} annotations...")
                    
            except Exception as e:
                logger.error(f"Error packing annotation {i}: {e}, ann_id={ann.get('id', 'unknown')}, points_type={type(points)}")
                import traceback
                logger.error(f"Traceback: {traceback.format_exc()}")
                # Skip this annotation by packing empty
                ann_id = int(ann.get('id', 0)) if isinstance(ann.get('id'), (int, str)) else 0
                class_id = int(ann.get('class_id', -1))
                binary_data.extend(struct.pack('<IiI', ann_id, class_id, 0))
                continue  # Continue processing other annotations
        
        conversion_time = time.time() - conv_start
        struct_time = time.time() - annotations_pack_start - conversion_time
        
        if num_annotations > 100:
            logger.info(f"Finished packing {processed_count}/{num_annotations} annotations in {conversion_time*1000:.2f}ms")
    
    annotations_pack_time = time.time() - annotations_pack_start
    
    # Pack class names count
    names_pack_start = time.time()
    num_class_names = len(class_names) if class_names else 0
    binary_data.extend(struct.pack('<I', num_class_names))
    
    # Pack class names
    if class_names:
        for name in class_names:
            name_bytes = name.encode('utf-8')
            binary_data.extend(struct.pack('<I', len(name_bytes)))
            binary_data.extend(name_bytes)
    names_pack_time = time.time() - names_pack_start
    
    # Pack class colors count
    colors_pack_start = time.time()
    num_class_colors = len(class_colors) if class_colors else 0
    binary_data.extend(struct.pack('<I', num_class_colors))
    
    # Pack class colors
    if class_colors:
        for color in class_colors:
            color_bytes = color.encode('utf-8')
            binary_data.extend(struct.pack('<I', len(color_bytes)))
            binary_data.extend(color_bytes)
    colors_pack_time = time.time() - colors_pack_start
    
    # Pack class counts as JSON string
    counts_pack_start = time.time()
    counts_json = json.dumps(class_counts_by_id) if class_counts_by_id else '{}'
    counts_bytes = counts_json.encode('utf-8')
    binary_data.extend(struct.pack('<I', len(counts_bytes)))
    binary_data.extend(counts_bytes)
    counts_pack_time = time.time() - counts_pack_start
    
    total_time = time.time() - perf_start
    binary_size = len(binary_data)
    
    # Calculate total points (handle both numpy arrays and lists)
    total_points = 0
    for ann in annotations:
        points = ann.get('points', [])
        if isinstance(points, np.ndarray):
            if points.ndim == 1:
                total_points += len(points) // 2  # Assuming x,y pairs
            else:
                total_points += len(points)
        else:
            total_points += len(points)
    
    performance_metrics = {
        'total_pack_time_ms': total_time * 1000,
        'annotations_pack_time_ms': annotations_pack_time * 1000,
        'points_conversion_time_ms': conversion_time * 1000,
        'points_struct_time_ms': struct_time * 1000,
        'names_pack_time_ms': names_pack_time * 1000,
        'colors_pack_time_ms': colors_pack_time * 1000,
        'counts_pack_time_ms': counts_pack_time * 1000,
        'binary_size_bytes': binary_size,
        'binary_size_mb': binary_size / (1024 * 1024),
        'annotations_count': num_annotations,
        'total_points_count': total_points,
        'points_per_second': total_points / total_time if total_time > 0 else 0
    }
    
    return bytes(binary_data), performance_metrics

def compress_data(data: dict) -> tuple[bytes, bool]:
    """Compress data using zstd if size is large enough"""
    start_time = time.time()
    # Try to use orjson for faster serialization, fallback to standard json
    try:
        json_bytes = orjson.dumps(data, default=str)
        json_str = json_bytes.decode('utf-8')
    except ImportError:
        json_str = json.dumps(data, default=str, separators=(',', ':'))
        json_bytes = json_str.encode('utf-8')
    json_time = time.time() - start_time

    # Only compress if data is larger than 1KB
    if len(json_bytes) > 1024:
        compression_start = time.time()
        # Use compression level 1 for fastest compression
        cctx = zstd.ZstdCompressor(level=1)
        compressed = cctx.compress(json_bytes)
        compression_time = time.time() - compression_start
        
        compression_ratio = len(compressed)/len(json_bytes)*100
        logger.info(f"Compression timing - JSON: {json_time*1000:.2f}ms, Compression: {compression_time*1000:.2f}ms, Total: {(json_time + compression_time)*1000:.2f}ms")
        logger.info(f"Compressed data from {len(json_bytes)/(1024*1024):.2f}MB to {len(compressed)/(1024*1024):.2f}MB ({compression_ratio:.1f}% reduction)")
        return compressed, True

    logger.info(f"JSON serialization time: {json_time*1000:.2f}ms (no compression needed)")
    return json_bytes, False

async def segmentation_endpoint(websocket: WebSocket):
    """
    FastAPI WebSocket endpoint for segmentation with device isolation
    """
    # Authenticate WebSocket connection
    try:
        user: Optional[AuthUser] = await websocket_auth_required(websocket)
        if user:
            logger.info(f"WebSocket connected for user: {user.uid} ({user.email})")
        else:
            logger.info(f"WebSocket connected (authentication skipped for excluded path)")
    except WebSocketDisconnect:
        return  # Connection closed due to auth failure
    
    # Get device ID from WebSocket
    device_id = get_device_id_from_websocket(websocket)
    if not device_id:
        logger.error("No device ID found in WebSocket connection")
        await websocket.close(code=1008, reason="No device ID provided")
        return
    
    # Connect to device connection manager
    connection_id = await device_connection_manager.connect(websocket, device_id)
    logger.info(f"WebSocket connected for device {device_id} with connection {connection_id}")
    
    try:
        # Keep connection alive and handle incoming messages
        while True:
            try:
                data = await websocket.receive_text()
                if data == "ping":
                    await websocket.send_text("pong")
                    await device_connection_manager.update_connection_health(device_id, connection_id)
                elif data == "get_status":
                    # Send connection status
                    status = {
                        "status": "connected",
                        "device_id": device_id,
                        "connection_id": connection_id,
                        "total_connections": device_connection_manager.get_total_connection_count()
                    }
                    await websocket.send_text(json.dumps(status))
                    await device_connection_manager.update_connection_health(device_id, connection_id)
                else:
                    # Handle segmentation messages
                    try:
                        parsed_data = json.loads(data)
                        
                        # token_refresh messages from older clients are ignored
                        # in the local-only build (no token verification here).
                        if parsed_data.get("type") == "token_refresh":
                            await websocket.send_text(json.dumps({
                                "type": "token_refresh_success",
                                "message": "Token refresh not required for local build"
                            }))
                            continue


                        await handle_segmentation_message(websocket, device_id, parsed_data, user=user)
                    except json.JSONDecodeError:
                        # If not JSON, treat as ping
                        await websocket.send_text("pong")
                    
                    # Update health for any other message
                    await device_connection_manager.update_connection_health(device_id, connection_id)
            except WebSocketDisconnect:
                break
            except Exception as e:
                logger.error(f"WebSocket error for device {device_id}: {str(e)}")
                break
                
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for device {device_id}")
    except Exception as e:
        logger.error(f"Error in WebSocket for device {device_id}: {str(e)}")
    finally:
        if connection_id:
            await device_connection_manager.disconnect(device_id, connection_id)


async def handle_segmentation_message(
    websocket: WebSocket,
    device_id: str,
    data: dict,
    user: Optional[AuthUser] = None,
):
    """Handle segmentation-specific WebSocket messages"""
    # Update device activity time
    current_time = asyncio.get_event_loop().time()
    device_connection_manager.device_last_activity[device_id] = current_time
    
    try:
        # handle path updates
        if "path" in data:
            svs_path = data["path"]
            
            if svs_path == '':
                logger.info("WebSocket: clearing path and resetting handler")
                # Clear the handler for this device
                device_annotation_handlers.pop(device_id, None)
                if device_id in device_type_manage_handlers:
                    device_type_manage_handlers[device_id] = TypeManageHandler()
                
                await websocket.send_text(json.dumps({
                    "status": "success",
                    "message": "Annotations cleared and handler reset"
                }))
                return
            
            # Handle relative path by constructing full path
            if svs_path:
                # Resolve virtual path aliases first (e.g., 'samples/Data' -> '/data/public')
                resolved_svs_path = resolve_virtual_path(svs_path)
                if not resolved_svs_path:
                    logger.error(f"WebSocket: Invalid path alias: {svs_path}")
                    await websocket.send_text(json.dumps({
                        "status": "error",
                        "message": f"Invalid path alias: {svs_path}",
                        "error_type": "InvalidPathError"
                    }))
                    return
                # Construct full path by joining storage root with relative path
                full_svs_path = resolve_path(resolved_svs_path)
                logger.info(f"WebSocket: Resolved virtual path '{svs_path}' -> '{resolved_svs_path}', full path: {full_svs_path}")
                if full_svs_path.endswith('.zarr'):
                    zarr_path = full_svs_path
                else:
                    # Try to find zarr file
                    zarr_path = f"{full_svs_path}.zarr"
            else:
                if svs_path and svs_path.endswith('.zarr'):
                    zarr_path = svs_path
                else:
                    zarr_path = f"{svs_path}.zarr"
            
            logger.info(f"WebSocket: Received new path: {svs_path}")
            logger.info(f"WebSocket: Looking for zarr file at: {zarr_path}")

            # Check for Zarr file
            file_path = None
            if os.path.exists(zarr_path):
                file_path = zarr_path
                logger.info(f"WebSocket: Found zarr file at: {zarr_path}")
                if user and user.uid:
                    asyncio.get_event_loop().run_in_executor(
                        executor, register_zarr_store, user.uid, zarr_path
                    )
            else:
                logger.warning(f"WebSocket: No zarr file found at: {zarr_path}")
                # Clear the handler for this device when no zarr file is found
                device_annotation_handlers.pop(device_id, None)
                await websocket.send_text(json.dumps({
                    "status": "error",
                    "message": f"No zarr file found. Please check the path or upload the file.",
                    "error_type": "FileNotFoundError"
                }))
                return

            if file_path:
                try:
                    logger.info(f"WebSocket: Loading file: {file_path} for device: {device_id}")

                    # Initialize device-specific handlers if they don't exist
                    if device_id not in device_type_manage_handlers:
                        device_type_manage_handlers[device_id] = TypeManageHandler()

                    # Check handler before creation
                    logger.info(f"WebSocket: Handler before creation: {device_annotation_handlers.get(device_id)}")

                    # Check if handler already exists for the same file
                    # Note: Even if path is the same, we should reload centroids if this is a file switch
                    # (e.g., user switched from file A to file B, then back to file A - file content may have changed)
                    existing_handler = device_annotation_handlers.get(device_id)
                    if existing_handler is not None and hasattr(existing_handler, 'zarr_file') and existing_handler.zarr_file == file_path:
                        # Force reload centroids/contours when switching files, even if path is the same
                        # This ensures data consistency when switching between files
                        logger.info(f"WebSocket: Handler exists for {file_path}, but forcing full reload (including centroids/contours) due to file switch")
                        # Set flag to force reload centroids/contours
                        existing_handler._needs_reload = True
                        existing_handler._force_reload_centroids = True
                        try:
                            # Force reload with segmentation data to ensure centroids are updated
                            existing_handler.load_file(file_path, force_reload=True, reload_segmentation_data=True)
                            stored_handler = existing_handler
                            # IMPORTANT: Reset _needs_reload flag after successful reload to prevent
                            # redundant reloads in get_patch_centroids_in_viewport and other methods
                            existing_handler._needs_reload = False
                            logger.info(f"WebSocket: Successfully reloaded handler with centroids for device {device_id}")
                        except Exception as e:
                            logger.error(f"WebSocket: Failed to reload handler: {e}")
                            # Fall through to create new handler
                            existing_handler = None

                    # Create and load the segmentation handler if needed
                    if existing_handler is None or (hasattr(existing_handler, 'zarr_file') and existing_handler.zarr_file != file_path):
                        try:
                            # First check if file exists and is accessible
                            if not os.path.exists(file_path):
                                raise FileNotFoundError(f"Zarr file not found: {file_path}")

                            # Check if it's a valid zarr directory
                            zarr_indicators = ['.zarray', '.zgroup', '.zattrs']
                            has_zarr_indicators = any(os.path.exists(os.path.join(file_path, indicator)) for indicator in zarr_indicators)
                            if not has_zarr_indicators:
                                # Try to check if it's a valid zarr file by attempting to open it
                                try:
                                    import zarr
                                    zarr.open(file_path, 'r')
                                except Exception:
                                    raise ValueError(f"File does not appear to be a valid Zarr file: {file_path}")

                            logger.info(f"WebSocket: Creating SegmentationHandler for {file_path}")
                            # Check file permissions before attempting to load
                            if not os.access(file_path, os.R_OK):
                                error_msg = f"Zarr file is not readable (permission denied): {file_path}"
                                logger.error(f"WebSocket: {error_msg}")
                                logger.error(f"WebSocket: File permissions: {oct(os.stat(file_path).st_mode)}")
                                await websocket.send_text(json.dumps({
                                    "status": "error",
                                    "message": error_msg,
                                    "error_type": "PermissionError",
                                    "suggestion": "Please check file permissions or contact administrator"
                                }))
                                return
                            
                            # Keep set_path lightweight: bind the zarr path immediately and let
                            # centroids/patch data load lazily on the first viewport request.
                            handler = SegmentationHandler()
                            handler.zarr_file = file_path
                            device_annotation_handlers[device_id] = handler
                            logger.info(f"WebSocket: Created lightweight SegmentationHandler for device {device_id}")
                            logger.info(f"WebSocket: Handler stored in device_annotation_handlers[{device_id}] = {type(device_annotation_handlers[device_id]).__name__}")
                            logger.info(f"WebSocket: All handlers: {list(device_annotation_handlers.keys())}")

                            # Verify handler was stored correctly
                            stored_handler = device_annotation_handlers.get(device_id)
                            logger.info(f"WebSocket: Handler verification - stored: {stored_handler is not None}, type: {type(stored_handler).__name__ if stored_handler else 'None'}")

                            # Check if the handler loaded data successfully
                            if stored_handler:
                                has_centroids = stored_handler.centroids is not None
                                has_contours = stored_handler.contours is not None
                                has_kd_tree = stored_handler.kd_tree is not None
                                logger.info(f"WebSocket: Handler data status - centroids: {has_centroids}, contours: {has_contours}, kd_tree: {has_kd_tree}")
                                if has_centroids:
                                    logger.info(f"WebSocket: Handler loaded {len(stored_handler.centroids)} centroids")
                                else:
                                    logger.warning(f"WebSocket: Handler created but no centroids loaded - this may indicate missing or invalid segmentation data")

                        except Exception as e:
                            logger.error(f"WebSocket: Failed to create SegmentationHandler for {file_path}: {e}")
                            logger.error(f"WebSocket: Exception type: {type(e).__name__}")
                            import traceback
                            logger.error(f"WebSocket: Full traceback: {traceback.format_exc()}")
                            device_annotation_handlers.pop(device_id, None)
                            await websocket.send_text(json.dumps({
                                "status": "error",
                                "message": f"Failed to load segmentation data: {str(e)}",
                                "error_type": type(e).__name__
                            }))
                            return

                    # Send success confirmation for set_path requests
                    stored_handler = device_annotation_handlers.get(device_id)
                    request_type = data.get("type")
                    if request_type == "set_path" and stored_handler:
                        status_message = "Path set successfully"
                        # set_path should confirm zarr availability quickly; actual overlay datasets
                        # will be loaded lazily on first centroids/annotations/patches request.
                        centroids_available = True

                        await websocket.send_text(json.dumps({
                            "type": "set_path",
                            "status": "success",
                            "message": status_message,
                            "path": data.get("path", ""),
                            "data_available": centroids_available
                        }))
                        logger.info(f"WebSocket: Sent set_path confirmation for device {device_id}")

                except Exception as e:
                    error_msg = f"Error loading file: {str(e)}"
                    logger.error(f"WebSocket: {error_msg}")
                    traceback.print_exc()
                    # Clear the handler for this device when loading fails
                    device_annotation_handlers.pop(device_id, None)
                    await websocket.send_text(json.dumps({
                        "status": "error",
                        "message": error_msg,
                        "error_type": type(e).__name__
                    }))

        # If this was a set_path request, don't process as viewport request
        request_type = data.get("type")
        if request_type == "set_path" and "path" in data:
            logger.info(f"WebSocket: set_path request processed successfully for device {device_id}")
            logger.info(f"WebSocket: set_path request completed, skipping viewport processing")
            return

        # handle viewport update requests
        annotation_handler = device_annotation_handlers.get(device_id)
        logger.info(f"WebSocket: Handler lookup for device {device_id}: found={annotation_handler is not None}")
        if annotation_handler:
            centroids_info = "None"
            if hasattr(annotation_handler, 'centroids') and annotation_handler.centroids is not None:
                try:
                    centroids_info = f"array with {len(annotation_handler.centroids)} points"
                except (TypeError, AttributeError):
                    centroids_info = "invalid array"
            logger.info(f"WebSocket: Handler details - zarr_file={getattr(annotation_handler, 'zarr_file', 'None')}, centroids={centroids_info}")
        if not annotation_handler:
            request_type = data.get("type", "unknown")
            logger.warning(f"WebSocket: No annotation handler available for device {device_id}, request type: {request_type}")

            # Check if this is a user-initiated request that should show error
            if request_type in ['space', 'x', 'centroids', 'patches', 'annotations', 'all_annotations', 'mark_region']:
                # Send error message for user-initiated requests with suggestion to reconnect
                error_response = {
                    "status": "error",
                    "message": "No Zarr file loaded or segmentation data not available. Please reconnect or reload the file.",
                    "error_type": "NoDataError",
                    "suggestion": "Please send a 'path' message to reload the Zarr file"
                }
                logger.info(f"WebSocket: *** SENDING NoDataError for {request_type}: {error_response} ***")
                await websocket.send_text(json.dumps(error_response))
                logger.info(f"WebSocket: *** NoDataError SENT for {request_type} ***")
                return
            else:
                # For set_path or other requests without handlers, just log and continue
                logger.info(f"WebSocket: No handler available for {request_type} request, but this may be normal during initialization")
                return
        
        # No cache system - direct file loading only

        # Process viewport requests
        x1, y1, x2, y2 = data.get("x1"), data.get("y1"), data.get("x2"), data.get("y2")
        request_type = data.get("type")
        
        # Log detailed viewport request
        logger.info(f"WebSocket: Processing {request_type} request for viewport ({x1}, {y1}, {x2}, {y2})")

        if request_type == "annotations":
            use_classification = data.get("use_classification", True)
            logger.info(f"WebSocket: Getting annotations with classification={use_classification}")

            annotations, class_counts_by_id = await asyncio.get_running_loop().run_in_executor(
                executor,
                annotation_handler.get_annotations_in_viewport,
                x1, y1, x2, y2, use_classification, True  # simplified=True for binary format
            )

            logger.info(f"WebSocket: Found {len(annotations)} annotations for viewport")
            if annotations:
                try:
                    # Extract class names and colors from class_counts_by_id
                    class_names = class_counts_by_id.get('class_names') if class_counts_by_id else None
                    class_colors = class_counts_by_id.get('class_colors') if class_counts_by_id else None
                    counts_dict = class_counts_by_id.get('class_counts_by_id', {}) if class_counts_by_id else {}
                    
                    # Pack as binary format
                    binary_start = time.time()
                    binary_data, pack_metrics = pack_annotations_binary(
                        annotations,
                        class_names=class_names,
                        class_colors=class_colors,
                        class_counts_by_id=counts_dict
                    )
                    binary_time = time.time() - binary_start
                    
                    # Add type header (1 byte: 'a' for annotations) + 3 bytes padding for 4-byte alignment
                    type_header = b'a' + b'\x00\x00\x00'  # 4 bytes total, aligned
                    final_data = type_header + binary_data
                    final_size = len(final_data)
                    
                    # Always compress binary data (even small messages) to simplify frontend handling
                    compression_start = time.time()
                    cctx = zstd.ZstdCompressor(level=1)
                    compressed = cctx.compress(final_data)
                    compression_time = time.time() - compression_start
                    compressed_size = len(compressed)
                    compression_ratio = (1 - compressed_size / final_size) * 100
                    
                    send_start = time.time()
                    await websocket.send_bytes(compressed)
                    send_time = time.time() - send_start
                    
                    total_time = binary_time + compression_time + send_time
                    
                    # Detailed performance logging
                    if final_size > 1024:
                        logger.info(f"[PERF] Annotations Binary Transmission:")
                        logger.info(f"  Annotations: {pack_metrics['annotations_count']}, Points: {pack_metrics['total_points_count']}, Binary size: {pack_metrics['binary_size_mb']:.3f}MB")
                        logger.info(f"  Pack times - Total: {pack_metrics['total_pack_time_ms']:.2f}ms")
                        logger.info(f"    Annotations: {pack_metrics['annotations_pack_time_ms']:.2f}ms "
                                   f"(conversion: {pack_metrics.get('points_conversion_time_ms', 0):.2f}ms, "
                                   f"struct: {pack_metrics.get('points_struct_time_ms', 0):.2f}ms)")
                        logger.info(f"    Names: {pack_metrics['names_pack_time_ms']:.2f}ms, "
                                   f"Colors: {pack_metrics['colors_pack_time_ms']:.2f}ms, "
                                   f"Counts: {pack_metrics['counts_pack_time_ms']:.2f}ms")
                        logger.info(f"  Compression: {compression_time*1000:.2f}ms ({compression_ratio:.1f}% reduction, "
                                   f"{final_size/(1024*1024):.3f}MB -> {compressed_size/(1024*1024):.3f}MB)")
                        logger.info(f"  Network send: {send_time*1000:.2f}ms")
                        logger.info(f"  Total time: {total_time*1000:.2f}ms")
                        logger.info(f"  Throughput: {pack_metrics.get('points_per_second', 0)/1000:.0f}K points/s")
                    else:
                        logger.debug(f"[PERF] Annotations Binary Transmission (small): {final_size} -> {compressed_size} bytes, {compression_ratio:.1f}% reduction")
                except Exception as e:
                    logger.error(f"WebSocket: Error sending annotations: {str(e)}")
                    traceback.print_exc()
        
        elif request_type == "centroids":
            logger.info(f"WebSocket: Getting centroids for device {device_id}")
            logger.debug(f"WebSocket: Handler available for centroids request: {annotation_handler is not None}")
            
            points, class_counts_by_id = await asyncio.get_running_loop().run_in_executor(
                executor,
                annotation_handler.get_centroids_in_viewport,
                x1, y1, x2, y2
            )
            
            logger.info(f"WebSocket: Found {len(points)} centroids")
            
            # Extract class names and colors from class_counts_by_id
            class_names = class_counts_by_id.get('class_names') if class_counts_by_id else None
            class_colors = class_counts_by_id.get('class_colors') if class_counts_by_id else None
            counts_dict = class_counts_by_id.get('class_counts_by_id', {}) if class_counts_by_id else {}
            
            # Debug: Print payload keys to check if color info is included
            if class_names:
                logger.info(f"WebSocket: Sending class_names: {class_names}")
            if class_colors:
                logger.info(f"WebSocket: Sending class_colors: {class_colors}")
            
            # Pack as binary format
            binary_start = time.time()
            binary_data, pack_metrics = pack_segmentation_binary(
                points, 
                class_names=class_names,
                class_colors=class_colors,
                class_counts_by_id=counts_dict
            )
            binary_time = time.time() - binary_start
            
            # Add type header (1 byte: 'c' for centroids) + 3 bytes padding for 4-byte alignment
            type_header = b'c' + b'\x00\x00\x00'  # 4 bytes total, aligned
            final_data = type_header + binary_data
            final_size = len(final_data)
            
            # Always compress binary data (even small messages) to simplify frontend handling
            compression_start = time.time()
            cctx = zstd.ZstdCompressor(level=1)
            compressed = cctx.compress(final_data)
            compression_time = time.time() - compression_start
            compressed_size = len(compressed)
            compression_ratio = (1 - compressed_size / final_size) * 100
            
            send_start = time.time()
            await websocket.send_bytes(compressed)
            send_time = time.time() - send_start
            
            total_time = binary_time + compression_time + send_time
            
            # Log compression info for small messages too
            if final_size <= 1024:
                logger.debug(f"WebSocket: Compressed small centroids message ({final_size} -> {compressed_size} bytes, {compression_ratio:.1f}% reduction)")
        
        elif request_type == "patches":
            logger.info(f"WebSocket: *** PATCHES REQUEST RECEIVED ***")
            logger.info(f"WebSocket: Getting patches in viewport: ({x1}, {y1}, {x2}, {y2})")
            logger.info(f"WebSocket: annotation_handler exists: {annotation_handler is not None}")
            patches, class_counts_by_id = await asyncio.get_running_loop().run_in_executor(
                executor,
                annotation_handler.get_patch_centroids_in_viewport,
                x1, y1, x2, y2
            )
            logger.info(f"WebSocket: Found {len(patches)} patches")
            if len(patches) > 0:
                try:
                    payload = {
                        "type": "patches",
                        "patches": patches,
                        **class_counts_by_id
                    }

                    # Check if we should compress
                    json_start = time.time()
                    json_str = json.dumps(payload, default=str)
                    json_bytes = json_str.encode('utf-8')
                    json_time = time.time() - json_start

                    if len(json_bytes) > 1024:
                        compression_start = time.time()
                        # Use compression level 1 for fastest compression
                        cctx = zstd.ZstdCompressor(level=1)
                        compressed = cctx.compress(json_bytes)
                        compression_time = time.time() - compression_start
                        
                        send_start = time.time()
                        await websocket.send_bytes(compressed)
                        send_time = time.time() - send_start
                        
                        logger.info(f"WebSocket: JSON: {json_time*1000:.2f}ms, Compression: {compression_time*1000:.2f}ms, Send: {send_time*1000:.2f}ms, Total: {(json_time + compression_time + send_time)*1000:.2f}ms")
                        logger.info(f"WebSocket: Sent {len(patches)} patches (compressed {len(json_bytes)/(1024*1024):.2f}MB -> {len(compressed)/(1024*1024):.2f}MB)")
                    else:
                        send_start = time.time()
                        await websocket.send_text(json_str)
                        send_time = time.time() - send_start
                        logger.info(f"WebSocket: JSON: {json_time*1000:.2f}ms, Send: {send_time*1000:.2f}ms, Total: {(json_time + send_time)*1000:.2f}ms")
                except Exception as e:
                    logger.error(f"WebSocket: Error sending patches: {str(e)}")
                    traceback.print_exc()
            else:
                # Send error response when no patches are found
                logger.info("WebSocket: No patches found, sending error response")
                await websocket.send_text(json.dumps({
                    "status": "error",
                    "message": "No patch data found in the Zarr file",
                    "error_type": "NoDataError"
                }))

        elif request_type == "mark_region":
            color = data.get("color")
            category = data.get("type")
            logger.info(f"WebSocket: Marking region with color={color}, category={category}")
            
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
            logger.info(f"WebSocket: Found {len(idx_list)} indices to mark")

            type_manage_handler = device_type_manage_handlers.get(device_id)
            if type_manage_handler:
                for idx in idx_list:
                    type_manage_handler.update_type(idx, color, category)

            try:
                payload = {
                    "type": "mark_region",
                    "indices": idx_list
                }

                # Check if we should compress
                # Try to use orjson for faster serialization, fallback to standard json
                try:
                    json_bytes = orjson.dumps(payload, default=str)
                    json_str = json_bytes.decode('utf-8')
                except ImportError:
                    json_str = json.dumps(payload, default=str, separators=(',', ':'))
                    json_bytes = json_str.encode('utf-8')

                if len(json_bytes) > 1024:
                    # Use compression level 1 for fastest compression
                    cctx = zstd.ZstdCompressor(level=1)
                    compressed = cctx.compress(json_bytes)
                    # Send compressed binary data
                    await websocket.send_bytes(compressed)
                    logger.info(f"WebSocket: Marked {len(idx_list)} regions (compressed {len(json_bytes)/(1024*1024):.2f}MB -> {len(compressed)/(1024*1024):.2f}MB)")
                else:
                    await websocket.send_text(json_str)
            except Exception as e:
                logger.error(f"WebSocket: Error sending mark_region response: {str(e)}")
                traceback.print_exc()

        elif request_type == "all_annotations":
            logger.info(f"WebSocket: Getting all annotations")
            use_classification = data.get("use_classification", True)
            logger.info(f"WebSocket: Getting annotations with classification={use_classification}")
            
            # Add timeout and progress logging
            get_start = time.time()
            try:
                annotations, class_counts_by_id = await asyncio.wait_for(
                    asyncio.get_running_loop().run_in_executor(
                        executor,
                        annotation_handler.get_annotations_in_viewport,
                        x1, y1, x2, y2, use_classification, True  # simplified=True for binary format
                    ),
                    timeout=30.0  # 30 second timeout
                )
                get_time = time.time() - get_start
                logger.info(f"WebSocket: get_annotations_in_viewport completed in {get_time*1000:.2f}ms")
            except asyncio.TimeoutError:
                logger.error(f"WebSocket: get_annotations_in_viewport timed out after 30 seconds")
                await websocket.send_text(json.dumps({
                    "status": "error",
                    "message": "Timeout getting annotations data",
                    "error_type": "TimeoutError"
                }))
                return
            except Exception as e:
                logger.error(f"WebSocket: Error in get_annotations_in_viewport: {e}")
                import traceback
                logger.error(f"Traceback: {traceback.format_exc()}")
                await websocket.send_text(json.dumps({
                    "status": "error",
                    "message": f"Error getting annotations: {str(e)}",
                    "error_type": type(e).__name__
                }))
                return

            logger.info(f"WebSocket: Found {len(annotations)} annotations")
            if annotations:
                # Log first annotation structure for debugging
                if len(annotations) > 0:
                    first_ann = annotations[0]
                    points_type = type(first_ann.get('points', []))
                    points_shape = None
                    if isinstance(first_ann.get('points', []), np.ndarray):
                        points_shape = first_ann.get('points', []).shape
                    logger.debug(f"WebSocket: First annotation - id={first_ann.get('id')}, class_id={first_ann.get('class_id')}, "
                               f"points_type={points_type}, points_shape={points_shape}")
                try:
                    # Extract class names and colors from class_counts_by_id
                    class_names = class_counts_by_id.get('class_names') if class_counts_by_id else None
                    class_colors = class_counts_by_id.get('class_colors') if class_counts_by_id else None
                    counts_dict = class_counts_by_id.get('class_counts_by_id', {}) if class_counts_by_id else {}
                    
                    # Pack as binary format
                    binary_start = time.time()
                    binary_data, pack_metrics = pack_annotations_binary(
                        annotations,
                        class_names=class_names,
                        class_colors=class_colors,
                        class_counts_by_id=counts_dict
                    )
                    binary_time = time.time() - binary_start
                    
                    # Add type header (1 byte: 'A' for all_annotations) + 3 bytes padding for 4-byte alignment
                    type_header = b'A' + b'\x00\x00\x00'  # 4 bytes total, aligned
                    final_data = type_header + binary_data
                    final_size = len(final_data)
                    
                    # Always compress binary data (even small messages) to simplify frontend handling
                    compression_start = time.time()
                    cctx = zstd.ZstdCompressor(level=1)
                    compressed = cctx.compress(final_data)
                    compression_time = time.time() - compression_start
                    compressed_size = len(compressed)
                    compression_ratio = (1 - compressed_size / final_size) * 100
                    
                    send_start = time.time()
                    await websocket.send_bytes(compressed)
                    send_time = time.time() - send_start
                    
                    total_time = binary_time + compression_time + send_time
                    
                    # Detailed performance logging
                    if final_size > 1024:
                        logger.info(f"[PERF] All Annotations Binary Transmission:")
                        logger.info(f"  Annotations: {pack_metrics['annotations_count']}, Points: {pack_metrics['total_points_count']}, Binary size: {pack_metrics['binary_size_mb']:.3f}MB")
                        logger.info(f"  Pack times - Total: {pack_metrics['total_pack_time_ms']:.2f}ms")
                        logger.info(f"    Annotations: {pack_metrics['annotations_pack_time_ms']:.2f}ms "
                                   f"(conversion: {pack_metrics.get('points_conversion_time_ms', 0):.2f}ms, "
                                   f"struct: {pack_metrics.get('points_struct_time_ms', 0):.2f}ms)")
                        logger.info(f"    Names: {pack_metrics['names_pack_time_ms']:.2f}ms, "
                                   f"Colors: {pack_metrics['colors_pack_time_ms']:.2f}ms, "
                                   f"Counts: {pack_metrics['counts_pack_time_ms']:.2f}ms")
                        logger.info(f"  Compression: {compression_time*1000:.2f}ms ({compression_ratio:.1f}% reduction, "
                                   f"{final_size/(1024*1024):.3f}MB -> {compressed_size/(1024*1024):.3f}MB)")
                        logger.info(f"  Network send: {send_time*1000:.2f}ms")
                        logger.info(f"  Total time: {total_time*1000:.2f}ms")
                        logger.info(f"  Throughput: {pack_metrics.get('points_per_second', 0)/1000:.0f}K points/s")
                    else:
                        logger.debug(f"[PERF] All Annotations Binary Transmission (small): {final_size} -> {compressed_size} bytes, {compression_ratio:.1f}% reduction")
                except Exception as e:
                    logger.error(f"WebSocket: Error sending all_annotations: {str(e)}")
                    traceback.print_exc()
        elif request_type == "set_path":
            # Handle set_path request - check if handler was created successfully
            annotation_handler = device_annotation_handlers.get(device_id)
            if annotation_handler:
                logger.info(f"WebSocket: set_path request - handler already created for device {device_id}")
                try:
                    await websocket.send_text(json.dumps({
                        "type": "set_path",
                        "status": "success",
                        "message": "Path already set",
                        "path": getattr(annotation_handler, 'zarr_file', data.get("path", ""))
                    }))
                except Exception as e:
                    logger.error(f"WebSocket: Error sending set_path confirmation: {str(e)}")
            else:
                logger.warning(f"WebSocket: set_path request - no handler available for device {device_id}")
                await websocket.send_text(json.dumps({
                    "type": "set_path",
                    "status": "error",
                    "message": "No segmentation data loaded",
                    "path": data.get("path", "")
                }))
        else:
            logger.warning(f"WebSocket: Unknown request type: {request_type}")

    except Exception as e:
        error_msg = f"Error processing segmentation message: {str(e)}"
        logger.error(f"WebSocket: {error_msg}")
        traceback.print_exc()
        try:
            await websocket.send_text(json.dumps({
                "status": "error",
                "error": error_msg,
                "message": error_msg,
                "error_type": type(e).__name__,
                "type": data.get("type"),
                "path": data.get("path"),
                "viewport": {"x1": data.get("x1"), "y1": data.get("y1"),
                             "x2": data.get("x2"), "y2": data.get("y2")}
            }))
        except Exception as send_error:
            logger.error(f"WebSocket: Failed to send error message: {str(send_error)}")


def cleanup_device_resources(device_id: str):
    """
    Clean up resources for a specific device when all connections are closed
    """
    global device_annotation_handlers, device_type_manage_handlers

    logger.warning(f"WebSocket: CLEANUP TRIGGERED for device {device_id}")
    logger.warning(f"WebSocket: Current handlers before cleanup: {list(device_annotation_handlers.keys())}")

    if device_id in device_annotation_handlers:
        logger.warning(f"WebSocket: Removing handler for device {device_id}")
        del device_annotation_handlers[device_id]

    if device_id in device_type_manage_handlers:
        del device_type_manage_handlers[device_id]
    
    # Clean up Active Learning data for this device
    try:
        from app.services.review import cleanup_instance_data
        cleanup_result = cleanup_instance_data(device_id)
        logger.info(f"WebSocket: Cleaned up AL data for device {device_id}: {cleanup_result}")
    except Exception as e:
        logger.warning(f"WebSocket: Failed to cleanup AL data for device {device_id}: {e}")

    logger.warning(f"WebSocket: Device {device_id} resources cleaned up")
