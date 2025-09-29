from fastapi import APIRouter, File, UploadFile, Form, Query, Response, Body, Request, Depends
from fastapi.responses import JSONResponse, StreamingResponse
from typing import Optional, List, Dict, Any
import os
import traceback
from io import BytesIO
import json
import time
from PIL import Image
import numpy as np
import urllib.parse
import math
import asyncio
import uuid
import base64

from isyntax import ISyntax

from app.core.response import success_response, error_response
from app.services.load_service import (
    load_slide_from_file,
    load_slide_from_file_with_session,
    get_tile,
    allowed_file,
    generate_tlproj_from_folder,
    get_pyramid_info,
    get_slide_properties,
    update_script,
    upload_file_path,
    start_preprocess,
    get_current_progress,
    get_process_result,
    slide,
    current_file_format,
    calculate_total_tiles,
    convert_to_pyramidal_tiff
)
from app.services.thumbnail_service import thumbnail_service
from app.api.schema.load import TiffToPyramidRequest
from app.utils import resolve_path
# Auth removed for open source

# Create router
load_router = APIRouter()
isyntax_slide = None
last_isyntax_file_path = None

# Instance management endpoints
@load_router.post("/v1/create_instance")
async def create_instance(request: Request):
    """
    Create a new WSI instance and return instanceId
    """
    try:
        # Get request body
        body = await request.body()
        body_text = body.decode('utf-8', errors='replace')
        
        # Parse JSON request
        try:
            data = json.loads(body_text)
            file_path = data.get('file_path', '') or data.get('relative_path', '')
        except json.JSONDecodeError:
            return error_response("Invalid JSON format")
        
        if not file_path:
            return error_response("file_path is required")
        
        # Generate unique instance ID
        instance_id = str(uuid.uuid4())
        
        # Convert relative path to absolute path using resolve_path
        from app.utils import resolve_path
        absolute_file_path = resolve_path(file_path)
        print(f"Debug - create_instance: relative_path={file_path}, absolute_path={absolute_file_path}")
        
        # Load slide with session support using the new instance ID
        result = load_slide_from_file_with_session(absolute_file_path, instance_id)
        
        if result["status"] == "error":
            return error_response(result["message"])
        
        return success_response({
            "instanceId": instance_id,
            "message": "Instance created successfully",
            "file_format": result["file_format"],
            "dimensions": result["dimensions"],
            "level_count": result["level_count"],
            "total_tiles": result["total_tiles"],
            "total_channels": result.get("total_channels", 3),
            "image_type": result.get("image_type", "Brightfield H&E")
        })
        
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error creating instance: {str(e)}")

@load_router.delete("/v1/delete_instance")
async def delete_instance(request: Request):
    """
    Delete a WSI instance and clean up resources
    """
    try:
        # Get request body
        body = await request.body()
        body_text = body.decode('utf-8', errors='replace')
        
        # Parse JSON request
        try:
            data = json.loads(body_text)
            instance_id = data.get('instance_id', '')
        except json.JSONDecodeError:
            return error_response("Invalid JSON format")
        
        if not instance_id:
            return error_response("instance_id is required")
        
        from app.services.load_service import clear_session
        clear_session(instance_id)
        return success_response({
            "message": f"Instance {instance_id} deleted successfully"
        })
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error deleting instance: {str(e)}")

# File upload and processing endpoints
@load_router.post("/v1/upload")
async def upload_file(file: UploadFile = File(...)):
    """
    Upload file to server and load as slide (legacy endpoint)
    """
    return await upload_file_with_session(file, session_id="default")

@load_router.post("/v1/s{session_id}/upload")
async def upload_file_with_session(file: UploadFile = File(...), session_id: str = "default"):
    """
    Upload file to server and load as slide with session support
    """
    try:
        # Check if file format is supported
        if not allowed_file(file.filename):
            return error_response("File format not supported")

        # Create temporary file
        temp_path = f"temp_{time.time()}_{file.filename}"
        with open(temp_path, "wb") as buffer:
            buffer.write(await file.read())

        # Load slide with session support
        result = load_slide_from_file_with_session(temp_path, session_id)

        # Always delete temporary file after processing
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
                print(f"Debug - Cleaned up temporary file: {temp_path}")
        except Exception as e:
            print(f"Warning - Failed to delete temporary file {temp_path}: {str(e)}")

        if result["status"] == "error":
            return error_response(result["message"])

        return success_response({
            "message": "File uploaded and slide loaded successfully",
            "file_format": result["file_format"],
            "dimensions": result["dimensions"],
            "level_count": result["level_count"],
            "total_tiles": result["total_tiles"]
        })

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error uploading file: {str(e)}")

@load_router.post("/v1/upload_path")
async def upload_file_path_api(request: Request):
    """
    Load slide from file path (legacy endpoint)
    """
    return await upload_file_path_api_with_session(request, session_id="default")

@load_router.post("/v1/s{session_id}/upload_path")
async def upload_file_path_api_with_session(request: Request, session_id: str = "default"):
    """
    Load slide from file path
    """
    try:
        # Record request header information for debugging
        headers = dict(request.headers)
        content_type = headers.get('content-type', '')
        print(f"Debug - Request Headers: {headers}")
        print(f"Debug - Content-Type: {content_type}")

        # Get raw request content
        body = await request.body()
        body_text = body.decode('utf-8', errors='replace')
        print(f"Debug - Raw Request Body: {body_text}")

        file_path = ""

        # Process based on content type
        if "application/json" in content_type:
            # JSON format
            try:
                data = json.loads(body_text)
                # Compatible with different parameter names - now using relative_path
                file_path = data.get('relative_path', '') or data.get('file_path', '') or data.get('filePath', '')
                print(f"Debug - JSON parsed data: {data}")
            except json.JSONDecodeError as e:
                print(f"Debug - JSON parse error: {str(e)}")

        elif "application/x-www-form-urlencoded" in content_type:
            # Standard form format
            form_data = {}
            for part in body_text.split('&'):
                if '=' in part:
                    key, value = part.split('=', 1)
                    form_data[key] = urllib.parse.unquote_plus(value)
            # Compatible with different parameter names - now using relative_path
            file_path = form_data.get('relative_path', '') or form_data.get('file_path', '') or form_data.get('filePath', '')
            print(f"Debug - Form data parsed: {form_data}")

        elif "multipart/form-data" in content_type:
            # Multipart form format
            form = await request.form()
            form_dict = dict(form)
            print(f"Debug - Multipart form data: {form_dict}")
            # Compatible with different parameter names - now using relative_path
            file_path = form.get('relative_path', '') or form.get('file_path', '') or form.get('filePath', '')

            # If still not found, try to find any key ending with path
            if not file_path:
                for key, value in form_dict.items():
                    if key.lower().endswith('path'):
                        print(f"Debug - Found path-like key: {key} = {value}")
                        file_path = value
                        break

        else:
            # Try all possible formats
            try:
                # Try to parse as JSON
                data = json.loads(body_text)
                # Compatible with different parameter names - now using relative_path
                file_path = data.get('relative_path', '') or data.get('file_path', '') or data.get('filePath', '')
                print(f"Debug - Tried JSON parse: {data}")
            except:
                # Try to parse as form
                try:
                    form_data = {}
                    for part in body_text.split('&'):
                        if '=' in part:
                            key, value = part.split('=', 1)
                            form_data[key] = urllib.parse.unquote_plus(value)
                    # Compatible with different parameter names - now using relative_path
                    file_path = form_data.get('relative_path', '') or form_data.get('file_path', '') or form_data.get('filePath', '')
                    print(f"Debug - Tried form parse: {form_data}")
                except:
                    # Try to get directly from request
                    try:
                        form = await request.form()
                        form_dict = dict(form)
                        print(f"Debug - Tried direct form access: {form_dict}")
                        # Compatible with different parameter names - now using relative_path
                        file_path = form.get('relative_path', '') or form.get('file_path', '') or form.get('filePath', '')

                        # If still not found, try to find any key ending with path
                        if not file_path:
                            for key, value in form_dict.items():
                                if key.lower().endswith('path'):
                                    print(f"Debug - Found path-like key: {key} = {value}")
                                    file_path = value
                                    break
                    except Exception as e:
                        print(f"Debug - Form access error: {str(e)}")

        # If no file_path from request, try to get from URL parameters
        if not file_path:
            query_params = dict(request.query_params)
            file_path = query_params.get('relative_path', '') or query_params.get('file_path', '') or query_params.get('filePath', '')
            print(f"Debug - Query params: {query_params}")

        # Still no file_path, return error
        if not file_path:
            return error_response("No file path provided (tried all extraction methods)")

        print(f"Debug - Final relative file path: {file_path}")

        # Construct full path by joining storage root with relative path
        full_file_path = resolve_path(file_path)
        
        
        print(f"Debug - Full file path: {full_file_path}")

        result = upload_file_path(full_file_path, session_id)

        if result["status"] == "error":
            return error_response(result["message"])

        # Get file information, create multiple formats of file information
        file_name = os.path.basename(full_file_path)
        file_ext = os.path.splitext(file_name)[1][1:] if "." in file_name else ""
        file_size = os.path.getsize(full_file_path) if os.path.exists(full_file_path) else 0
        file_dir = os.path.dirname(full_file_path)
        file_dir = os.path.normpath(file_dir)
        
        # Convert absolute paths back to relative paths for frontend
        relative_file_path = file_path  # This is already the relative path from request
        relative_file_dir = os.path.dirname(relative_file_path)  # Get the relative directory path

        # Build a complete response object containing all possible frontend expected formats
        print(f"Debug - Relative file path: {relative_file_path}")
        base_response = {
            "message": "Slide loaded successfully from path",
            "status": "success",
            "success": True,
            "error": None,

            # Multiple naming for file path - use relative paths
            "filePath": relative_file_path,
            "file_path": relative_file_path,
            "path": relative_file_path,
            "file": relative_file_path,
            "current_file": relative_file_path,
            "currentFile": relative_file_path,
            "slidePath": relative_file_path,
            "slide_path": relative_file_path,
            "filename": file_name,  # Field possibly needed by frontend

            # File information
            "fileName": file_name,
            "file_name": file_name,
            "name": file_name,
            "extension": file_ext,
            "ext": file_ext,
            "type": file_ext,
            "size": file_size,
            "directory": relative_file_dir,
            "dir": relative_file_dir,
            "folder": relative_file_dir,

            # File object
            "fileInfo": {
                "name": file_name,
                "path": file_path,
                "type": file_ext,
                "size": file_size,
                "directory": file_dir
            },

            # Additional fields expected by frontend
            "file_name": result.get("file_name", ""),
            "dimensions": result.get("dimensions", [0, 0]),
            "total_channels": result.get("total_channels", 3),
            "mpp": result.get("mpp", 0.25),
            "file_size": result.get("file_size", file_size),
            "magnification": result.get("magnification", 20),
            "image_type": result.get("image_type", "Brightfield H&E"),
            "total_annotations": result.get("total_annotations", 0),
            "total_cells": result.get("total_cells", 0),
            "processing_status": result.get("processing_status", "Pending"),
            "total_tiles": result.get("total_tiles", 0),
            "file_format": result.get("file_format", ""),
            "properties": result.get("properties", {}),

            # Snake case slide information
            "slide_info": {
                "file_format": result.get("file_format", ""),
                "dimensions": result.get("dimensions", [0, 0]),
                "level_count": result.get("level_count", 0),
                "total_tiles": result.get("total_tiles", 0),
                "pyramid_info": result.get("pyramid_info", [])
            },

            # Camel case slide information
            "slideInfo": {
                "fileFormat": result.get("file_format", ""),
                "dimensions": result.get("dimensions", [0, 0]),
                "levelCount": result.get("level_count", 0),
                "totalTiles": result.get("total_tiles", 0),
                "totalAnnotations": 0,
                "totalCells": 0,
                "mpp": 0.25,
                "magnification": "20x",
                "imageType": "Brightfield H&E",
                "processingStatus": "Not Started",
                "pyramidInfo": result.get("pyramid_info", [])
            },

            # Keep original data format
            "file_format": result.get("file_format", ""),
            "dimensions": result.get("dimensions", [0, 0]),
            "level_count": result.get("level_count", 0),
            "total_tiles": result.get("total_tiles", 0),
            "pyramid_info": result.get("pyramid_info", []),

            # Possible nested structure
            "data": {
                "file": file_path,
                "slideInfo": {
                    "fileFormat": result.get("file_format", ""),
                    "dimensions": result.get("dimensions", [0, 0]),
                    "levelCount": result.get("level_count", 0),
                    "totalTiles": result.get("total_tiles", 0),
                    "pyramidInfo": result.get("pyramid_info", [])
                }
            }
        }

        print(f"Debug - Base response keys: {base_response.keys()}")
        print(f"Debug - Base response: {base_response.values()}")
        # Ensure no None values
        def replace_none_with_default(obj, default_dict={}, default_list=[]):
            if obj is None:
                return default_dict
            elif isinstance(obj, dict):
                return {k: replace_none_with_default(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                if not obj:  # Empty list
                    return default_list
                return [replace_none_with_default(item) for item in obj]
            else:
                return obj if obj is not None else ""

        response_data = replace_none_with_default(base_response)
        return success_response(response_data)

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error loading file from path: {str(e)}")

@load_router.post("/v1/upload_folder")
async def upload_folder(request: Request):
    """
    Upload folder and generate project structure
    """
    try:
        # Record request header information for debugging
        headers = dict(request.headers)
        content_type = headers.get('content-type', '')
        print(f"Debug - Request Headers: {headers}")
        print(f"Debug - Content-Type: {content_type}")

        # Get raw request content
        body = await request.body()
        body_text = body.decode('utf-8', errors='replace')
        print(f"Debug - Raw Request Body: {body_text}")

        folder_path = ""

        # Process based on content type
        if "application/json" in content_type:
            # JSON format
            try:
                data = json.loads(body_text)
                # Compatible with different parameter names - now using relative_folder_path
                folder_path = data.get('relative_folder_path', '') or data.get('folder_path', '') or data.get('folderPath', '')
                print(f"Debug - JSON parsed data: {data}")
            except json.JSONDecodeError as e:
                print(f"Debug - JSON parse error: {str(e)}")

        elif "application/x-www-form-urlencoded" in content_type:
            # Standard form format
            form_data = {}
            for part in body_text.split('&'):
                if '=' in part:
                    key, value = part.split('=', 1)
                    form_data[key] = urllib.parse.unquote_plus(value)
            # Compatible with different parameter names - now using relative_folder_path
            folder_path = form_data.get('relative_folder_path', '') or form_data.get('folder_path', '') or form_data.get('folderPath', '')
            print(f"Debug - Form data parsed: {form_data}")

        elif "multipart/form-data" in content_type:
            # Multipart form format
            form = await request.form()
            form_dict = dict(form)
            print(f"Debug - Multipart form data: {form_dict}")
            # Compatible with different parameter names - now using relative_folder_path
            folder_path = form.get('relative_folder_path', '') or form.get('folder_path', '') or form.get('folderPath', '')

            # If still not found, try to find any key ending with path
            if not folder_path:
                for key, value in form_dict.items():
                    if key.lower().endswith('path'):
                        print(f"Debug - Found path-like key: {key} = {value}")
                        folder_path = value
                        break

        else:
            # Try all possible formats
            try:
                # Try to parse as JSON
                data = json.loads(body_text)
                # Compatible with different parameter names - now using relative_folder_path
                folder_path = data.get('relative_folder_path', '') or data.get('folder_path', '') or data.get('folderPath', '')
                print(f"Debug - Tried JSON parse: {data}")
            except:
                # Try to parse as form
                try:
                    form_data = {}
                    for part in body_text.split('&'):
                        if '=' in part:
                            key, value = part.split('=', 1)
                            form_data[key] = urllib.parse.unquote_plus(value)
                    # Compatible with different parameter names - now using relative_folder_path
                    folder_path = form_data.get('relative_folder_path', '') or form_data.get('folder_path', '') or form_data.get('folderPath', '')
                    print(f"Debug - Tried form parse: {form_data}")
                except:
                    # Try to get directly from request
                    try:
                        form = await request.form()
                        form_dict = dict(form)
                        print(f"Debug - Tried direct form access: {form_dict}")
                        # Compatible with different parameter names - now using relative_folder_path
                        folder_path = form.get('relative_folder_path', '') or form.get('folder_path', '') or form.get('folderPath', '')

                        # If still not found, try to find any key ending with path
                        if not folder_path:
                            for key, value in form_dict.items():
                                if key.lower().endswith('path'):
                                    print(f"Debug - Found path-like key: {key} = {value}")
                                    folder_path = value
                                    break
                    except Exception as e:
                        print(f"Debug - Form access error: {str(e)}")

        # If no folder_path in request, try to get from URL parameters
        if not folder_path:
            query_params = dict(request.query_params)
            folder_path = query_params.get('relative_folder_path', '') or query_params.get('folder_path', '') or query_params.get('folderPath', '')
            print(f"Debug - Query params: {query_params}")

        # If no folder_path provided, use empty string for root directory
        if folder_path is None:
            folder_path = ""

        print(f"Debug - Final relative folder path: {folder_path}")

        # Get storage root from file_manager configuration
        from app.api.file_manager import STORAGE_ROOT
        
        # Construct full path by joining storage root with relative path
        full_folder_path = resolve_path(folder_path)
        
        
        print(f"Debug - Full folder path: {full_folder_path}")

        # Call service layer function to get folder structure
        result = generate_tlproj_from_folder(full_folder_path)

        if result["status"] == "error":
            return error_response(result["message"])

        # Convert absolute paths back to relative paths for frontend
        relative_folder_path = folder_path  # This is already the relative path from request
        
        # Convert WSI files to relative paths
        relative_wsi_files = []
        for wsi_file in result.get("wsi_files", []):
            if wsi_file.startswith(STORAGE_ROOT):
                relative_wsi_file = os.path.relpath(wsi_file, STORAGE_ROOT)
                relative_wsi_file = relative_wsi_file.replace('\\', '/')  # Convert to forward slashes
                relative_wsi_files.append(relative_wsi_file)
            else:
                relative_wsi_files.append(wsi_file)
        
        # Convert WSI file to relative path
        relative_wsi_file = ""
        if result.get("wsi_file", ""):
            wsi_file = result.get("wsi_file", "")
            if wsi_file.startswith(STORAGE_ROOT):
                relative_wsi_file = os.path.relpath(wsi_file, STORAGE_ROOT)
                relative_wsi_file = relative_wsi_file.replace('\\', '/')  # Convert to forward slashes
            else:
                relative_wsi_file = wsi_file

        # Build response with just the folder structure info, without loading any file
        response_data = {
            "status": "success",
            "message": "Folder structure retrieved successfully",

            # Key fields, ensure they always exist and are not null - use relative paths
            "folder_path": relative_folder_path,
            "folderPath": relative_folder_path,
            "wsi_file": relative_wsi_file,
            "wsi_files": relative_wsi_files,
            "file_tree_dict": result.get("file_tree_dict", {}),
            "file_tree": result.get("file_tree_dict", {}),
            "tree_structure": result.get("tree_structure", {}),
            "fileTree": result.get("file_tree_dict", {}),

            # File list - use relative paths
            "files": relative_wsi_files,

            # Project info
            "tlproj_dict": result.get("tlproj_dict", {})
        }

        # Ensure no None values
        def replace_none_with_default(obj, default_dict={}, default_list=[]):
            if obj is None:
                return default_dict
            elif isinstance(obj, dict):
                return {k: replace_none_with_default(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                if not obj:  # Empty list
                    return default_list
                return [replace_none_with_default(item) for item in obj]
            else:
                return obj if obj is not None else ""

        clean_response = replace_none_with_default(response_data)

        return success_response(clean_response)

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error uploading folder: {str(e)}")

@load_router.get("/v1/load/{filename:path}")
def load_slide(filename: str):
    """
    Load slide by filename (legacy endpoint)
    """
    return load_slide_with_session(filename, session_id="default")

@load_router.get("/v1/s{session_id}/load/{filename:path}")
def load_slide_with_session(filename: str, session_id: str = "default"):
    """
    Load slide by filename - returns currently loaded slide info without reloading
    """
    try:
        # Import needed globals and get session data
        from app.services.load_service import slide, current_file_format, get_session_data

        session_data = get_session_data(session_id)
        session_slide = session_data['slide']
        session_current_file_format = session_data['current_file_format']

        # Simply check if a slide is loaded and return its info
        if session_slide is None:
            return error_response(f"No slide loaded for session {session_id}")

        # Get the pyramid info
        pyramid_info = []
        if hasattr(session_slide, 'level_dimensions'):
            for level, dims in enumerate(session_slide.level_dimensions):
                pyramid_info.append({
                    'level': level,
                    'dimensions': dims,
                    'downsample': session_slide.dimensions[0] / dims[0]
                })

        # Return the current slide info
        return success_response({
            "message": "Slide loaded successfully",
            "file_format": session_current_file_format,
            "dimensions": session_slide.dimensions,
            "level_count": len(session_slide.level_dimensions) if hasattr(session_slide, 'level_dimensions') else 0,
            "total_tiles": calculate_total_tiles(session_slide),
            "pyramid_info": pyramid_info,
            "level_dimensions": [list(dims) for dims in session_slide.level_dimensions] if hasattr(session_slide, 'level_dimensions') else []
        })

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error accessing slide information: {str(e)}")

@load_router.get("/v1/slide/{level}/{col_row}")
async def get_tile_api(
    level: int,
    col_row: str,
    scale_factor: float = Query(1.0),
    color_mode: Optional[str] = Query(None),
    request: Request = None
):
    """
    Get specific tile from slide (legacy endpoint)
    """
    return await get_tile_api_with_session(level, col_row, scale_factor, color_mode, request, session_id="default")

@load_router.get("/v1/tile/{level}/{col_row}")
async def get_tile_api_with_header(
    level: int,
    col_row: str,
    scale_factor: float = Query(1.0),
    color_mode: Optional[str] = Query(None),
    instance_id: Optional[str] = Query(None, description="Instance ID for session management"),
    request: Request = None
):
    """
    Get specific tile from slide with instanceId from header or query parameter
    Format: /v1/tile/0/3_1.jpeg where 3 is column and 1 is row
    """
    # Get instanceId from header or query parameter
    instance_id_from_header = request.headers.get('X-Instance-ID')
    instance_id_final = instance_id or instance_id_from_header
    
    if not instance_id_final:
        return error_response("X-Instance-ID header or instance_id query parameter is required")
    
    return await get_tile_api_with_session(level, col_row, scale_factor, color_mode, request, session_id=instance_id_final)

@load_router.get("/v1/s{session_id}/slide/{level}/{col_row}")
async def get_tile_api_with_session(
    level: int,
    col_row: str,
    scale_factor: float = Query(1.0),
    color_mode: Optional[str] = Query(None),
    request: Request = None,
    session_id: str = "default"
):
    """
    Get specific tile from slide
    Format: /v1/slide/0/3_1.jpeg where 3 is column and 1 is row
    """
    global isyntax_slide, last_isyntax_file_path
    try:
        uid = str(uuid.uuid4())
        timestamp = time.time()
        print(f"Debug - Tile request received: uid={uid}")
        # Parse channels[] and colors[] parameters directly from URL
        query_params = request.query_params
        channels_list = []
        colors_list = []

        # Iterate through original query parameters
        for param_name in query_params:
            if param_name.startswith('channels['):
                # Get all values for this parameter name
                for value in query_params.getlist(param_name):
                    try:
                        channels_list.append(int(value))
                    except ValueError:
                        print(f"Warning: Unable to convert channel value '{value}' to integer")
            elif param_name.startswith('colors['):
                # Get all values for this parameter name
                for value in query_params.getlist(param_name):
                    colors_list.append(value)

        # Parse col_row to extract column and row
        col_row_clean = col_row.replace(".jpeg", "")  # Remove .jpeg extension if present

        parts = col_row_clean.split('_')
        if len(parts) != 2:
            print(f"Debug - Invalid format: {col_row_clean}, parts={parts}")
            return error_response(f"Invalid tile format: {col_row_clean}. Expected format: col_row")

        try:
            col = int(parts[0])
            row = int(parts[1])
        except ValueError:
            print(f"Debug - Invalid values: {parts}")
            return error_response(f"Invalid tile values: {col_row_clean}. Col and row must be integers")

        print(
            f"Debug - uid={uid} get_tile start, time spent: {time.time() - timestamp} seconds")
        # Import needed globals and get session data
        from app.services.load_service import current_file_format, current_file_path, get_session_data

        session_data = get_session_data(session_id)
        session_current_file_format = session_data['current_file_format']
        session_current_file_path = session_data['current_file_path']

        # For ISyntax files, use direct processing with cache support
        if session_current_file_format == 'isyntax':
            # Check cache first for ISyntax files
            from app.services.tile_cache_service import get_tile_cache
            tile_cache = get_tile_cache()
            
            if session_current_file_path:
                cached_tile = tile_cache.get_cached_tile(
                    session_current_file_path, level, col, row, 
                    scale_factor, color_mode, channels_list, colors_list
                )
                if cached_tile:
                    print(f"Debug - Cache hit for ISyntax tile: level={level}, col={col}, row={row}")
                    return Response(
                        content=cached_tile,
                        media_type="image/jpeg",
                        headers={
                            "X-Frame-Options": "DENY",
                            "X-Content-Type-Options": "nosniff",
                            "Referrer-Policy": "same-origin",
                            "Cross-Origin-Opener-Policy": "same-origin"
                        }
                    )
            
            if session_data['last_isyntax_file_path'] != session_current_file_path:
                session_data['last_isyntax_file_path'] = session_current_file_path
                if session_data['isyntax_slide'] is not None:
                    session_data['isyntax_slide'].close()
                session_data['isyntax_slide'] = ISyntax.open(session_current_file_path)
            if session_data['isyntax_slide'] is None:
                print(f"Debug - No ISyntax slide loaded for session {session_id}")
                return error_response(f"No ISyntax slide loaded for session {session_id}")
            size = 1024
            slide_levels = get_slide_properties(session_data['isyntax_slide'])
            max_svs_level = session_data['isyntax_slide'].level_count
            dzi_level = int(level)
            svs_level = max(0, max_svs_level-dzi_level-1)
            if svs_level <= 0:
                svs_level = 0
                adjust_ratio = slide_levels['adjust_ratios'][svs_level]
                adjust_ratio = adjust_ratio*(2**(max_svs_level-dzi_level-1))
            else:
                adjust_ratio = slide_levels['adjust_ratios'][svs_level]
            # Determine the size of the tile
            w = h = size * adjust_ratio
            if max_svs_level >= 8:
                # To ensure tile is clear, keep adjusting adjusting layer size until largest level
                while w < (size-20) and svs_level > 0:
                    w = w * 2
                    h = h * 2
                    svs_level = svs_level - 1
                if svs_level > 0:
                    # If didn't pass assertion after adjusting, tile will be blurry
                    assert w >= (size-20), f"tile too small: {w}"
            # Determine the coordinates of the tile
            w, h = math.ceil(w), math.ceil(h)
            x = col * w
            y = row * h
            # Read the tile
            img = Image.fromarray(
                session_data['isyntax_slide'].read_region(x, y, w, h, svs_level))
            img = img.resize((size, size), Image.Resampling.LANCZOS)
            # Convert to JPEG
            buffer = BytesIO()
            quality = 75
            img.convert('RGB').save(buffer, format="JPEG",
                                    quality=quality, optimize=False)
            jpeg_data = buffer.getvalue()
            
            # Cache the ISyntax tile
            if session_current_file_path:
                tile_cache.cache_tile(
                    session_current_file_path, level, col, row,
                    scale_factor, color_mode, channels_list, colors_list, jpeg_data
                )
                print(f"Debug - Cached ISyntax tile: level={level}, col={col}, row={row}")
            
            result = {
                "status": "success",
                "image_data": jpeg_data,
                "format": "JPEG",
                "width": size,
                "height": size
            }
        else:
            # For other formats, use the original get_tile function
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                lambda: get_tile(level, col, row, scale_factor, color_mode,
                                 channels_list, colors_list, session_id))
        print(
            f"Debug - uid={uid} get_tile finished, time spent: {time.time() - timestamp} seconds"
        )

        if result["status"] == "error":
            print(f"Debug - get_tile returned error: {result['message']}")
            return error_response(result["message"])

        # Check if image data is valid
        if "image_data" not in result or not result["image_data"]:
            print("Debug - Empty image data returned from get_tile")
            return error_response("Empty image data returned")

        print(
            f"Debug - uid={uid} end, time spent: {time.time() - timestamp} seconds"
        )

        return Response(
            content=result["image_data"],
            media_type="image/jpeg",
            headers={
                "X-Frame-Options": "DENY",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "same-origin",
                "Cross-Origin-Opener-Policy": "same-origin"
            }
        )

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting tile: {str(e)}")

@load_router.get("/v1/pyramid")
async def get_pyramid():
    """
    Get slide pyramid information (legacy endpoint)
    """
    return await get_pyramid_with_session(session_id="default")

@load_router.get("/v1/s{session_id}/pyramid")
async def get_pyramid_with_session(session_id: str = "default"):
    """
    Get slide pyramid information
    """
    from app.services.load_service import slide, TILE_SIZE, get_session_data

    try:
        session_data = get_session_data(session_id)
        session_slide = session_data['slide']

        if session_slide is None:
            return error_response(f"No slide loaded for session {session_id}")

        # get the basic pyramid information
        pyramid_info = get_pyramid_info(session_slide)

        if isinstance(pyramid_info, dict) and "error" in pyramid_info:
            return error_response(pyramid_info["error"])

        # create result dictionary
        result = {
            "level_count": len(session_slide.level_dimensions),
            "dimensions": session_slide.dimensions
        }

        # add pyramid levels sorted by level
        pyramid_levels = []
        for level in range(len(session_slide.level_dimensions)):
            width, height = session_slide.level_dimensions[level]
            # calculate the downsample factor
            downsample = session_slide.dimensions[0] / width
            level_info = {
                "level": level,
                "dimensions": [width, height],
                "size": {"width": width, "height": height},
                "downsample": downsample,
                "cols": math.ceil(width / TILE_SIZE),
                "rows": math.ceil(height / TILE_SIZE)
            }
            pyramid_levels.append(level_info)

            # add to the result
        result["levels"] = pyramid_levels

        # calculate the level that is suitable for the thumbnail
        if len(pyramid_levels) > 0:
            # usually use the minimum level as the thumbnail
            thumbnail_level = len(pyramid_levels) - 1
            result["thumbnail_level"] = thumbnail_level
            result["thumbnail_dimensions"] = pyramid_levels[thumbnail_level]["dimensions"]

            # find the level that is suitable for the initial view
            best_level = 0
            best_size_diff = float('inf')
            target_width = 1000  # assume the target width is 1000 pixels

            for level in range(len(pyramid_levels)):
                width = pyramid_levels[level]["dimensions"][0]
                diff = abs(width - target_width)
                if diff < best_size_diff:
                    best_size_diff = diff
                    best_level = level

            result["best_level"] = best_level

        return success_response(result)

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting pyramid info: {str(e)}")

@load_router.get("/v1/properties")
async def get_properties():
    """
    Get slide properties (legacy endpoint)
    """
    return await get_properties_with_session(session_id="default")

@load_router.get("/v1/s{session_id}/properties")
async def get_properties_with_session(session_id: str = "default"):
    """
    Get slide properties
    """
    from app.services.load_service import slide, get_session_data, TILE_SIZE

    try:
        session_data = get_session_data(session_id)
        session_slide = session_data['slide']

        if session_slide is None:
            return error_response(f"No slide loaded for session {session_id}")

        result = get_slide_properties(session_slide)

        if "error" in result:
            return error_response(result["error"])

        # make sure the result contains additional information to help the frontend display the image correctly

        # add pyramid levels so the frontend can understand
        if "dimensions" not in result:
            result["dimensions"] = session_slide.dimensions

        # ensure the level_count is correct
        result["level_count"] = len(session_slide.level_dimensions)

        # add standard field names to satisfy the frontend's needs
        result["mpp"] = result.get("mpp", 0.25)
        result["magnification"] = result.get("magnification", "20x")

        # add the number of tiles in each level
        if "pyramid_info" in result:
            for level_info in result["pyramid_info"]:
                level = level_info["level"]
                width, height = session_slide.level_dimensions[level]
                level_info["cols"] = math.ceil(width / TILE_SIZE)
                level_info["rows"] = math.ceil(height / TILE_SIZE)

        # analyze the levels, recommend the best level for the frontend
        if result["level_count"] > 0:
            # usually level 0 is the highest resolution, and the last level is the lowest resolution
            result["best_level"] = 0
            result["thumbnail_level"] = result["level_count"] - 1

        # add success status so the frontend can easily check
        result["status"] = "success"

        return success_response(result)

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting slide properties: {str(e)}")

@load_router.post("/v1/update-script")
async def update_script_api(request: Request):
    """
    Update dynamic script
    """
    try:
        # Get request data, compatible with different frontend sending methods
        script = ""
        try:
            body = await request.body()
            text = body.decode('utf-8')
            # Try to parse as JSON
            try:
                data = json.loads(text)
                script = data.get('script', '')
            except json.JSONDecodeError:
                # Try to parse as form data
                form_data = {}
                for part in text.split('&'):
                    if '=' in part:
                        key, value = part.split('=', 1)
                        form_data[key] = urllib.parse.unquote_plus(value)
                script = form_data.get('script', '')
        except Exception:
            # Directly try to get form data
            form = await request.form()
            script = form.get('script', '')

        if not script:
            return error_response("No script content provided")

        result = update_script(script)

        if result["status"] == "error":
            return error_response(result["message"])

        return success_response({"message": result["message"]})

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error updating script: {str(e)}")

@load_router.post("/v1/run-preprocess")
async def run_preprocess(
    model: str = Query(..., description="Model type to be used in the process"),
    magnification: str = Query(..., description="Magnification setting")
):
    """
    Start preprocessing task
    
    Calls start_preprocess function in service layer to start background processing thread
    """
    try:
        result = start_preprocess(model, magnification)
        return success_response(result)
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error starting preprocess: {str(e)}")

@load_router.get("/v1/get-progress")
async def get_progress():
    """
    Get preprocessing progress
    
    Calls get_current_progress function in service layer to get real-time progress
    """
    try:
        result = get_current_progress()
        return success_response(result)
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting progress: {str(e)}")

@load_router.get("/v1/get-result")
async def get_result():
    """
    Get preprocessing result
    
    Calls get_process_result function in service layer to get processing result
    """
    try:
        result = get_process_result()

        if result["status"] == "processing":
            return success_response({
                "message": result["message"],
                "progress": result["progress"]
            })

        return success_response(result)
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting result: {str(e)}")

@load_router.post("/convert-to-pyramidal-tiff", summary="Convert TIFF to pyramidal format")
async def convert_to_pyramidal_tiff_api(request: TiffToPyramidRequest):
    """
    Converts a standard TIFF file to a multi-level pyramidal TIFF using libvips.
    This is a preprocessing step to optimize large images for fast tiled access.
    """
    try:
        input_path = request.input_path
        output_path = request.output_path
        result = convert_to_pyramidal_tiff(input_path, output_path)
        if result["status"] == "success":
            return success_response(result)
        else:
            return error_response(message=result["message"], code=500)
    except Exception as e:
        traceback.print_exc()
        return error_response(message=f"Error processing request: {e}", code=500)

@load_router.get("/v1/slide/preview_by_path")
async def get_slide_preview_by_path(
    file_path: str = Query(..., description="File path to get preview from"),
    preview_type: str = Query("all", description="Preview type: thumbnail, macro, label, or all"),
    size: int = Query(200, description="Maximum image size"),
    request_id: str = Query(..., description="Unique request ID for tracking")
):
    """
    Get slide preview images by file path without affecting currently loaded slide
    """
    try:
        from app.services.load_service import get_slide_preview_by_path_service
        
        result = get_slide_preview_by_path_service(file_path, preview_type, size, request_id)
        
        if result["status"] == "error":
            return error_response(result["message"])
        
        if result["response_type"] == "json":
            return success_response(result["data"])
        else:  # binary response
            headers = {
                "Cache-Control": "public, max-age=3600",
                "X-Source-File": result["file_path"]
            }
            if request_id:
                headers["X-Request-ID"] = request_id
            return Response(
                content=result["image_bytes"],
                media_type="image/jpeg",
                headers=headers
            )
            
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting preview for {file_path}: {str(e)}")

@load_router.get("/v1/cache/stats")
async def get_cache_stats():
    """
    Get tile cache statistics
    """
    try:
        from app.services.tile_cache_service import get_tile_cache
        tile_cache = get_tile_cache()
        stats = tile_cache.get_cache_stats()
        
        return {
            "status": "success",
            "cache_stats": stats
        }
    except Exception as e:
        return error_response(f"Error getting cache stats: {str(e)}")

@load_router.post("/v1/cache/clear")
async def clear_cache():
    """
    Clear all tile cache
    """
    try:
        from app.services.tile_cache_service import get_tile_cache
        tile_cache = get_tile_cache()
        tile_cache.clear_cache()
        
        return {
            "status": "success",
            "message": "All cache cleared"
        }
    except Exception as e:
        return error_response(f"Error clearing cache: {str(e)}")
