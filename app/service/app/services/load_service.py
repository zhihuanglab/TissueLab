import os
import asyncio
import logging
import math
import numpy as np
from PIL import Image, ImageOps, ImageDraw
from functools import lru_cache
from typing import Tuple, List, Dict, Optional
from io import BytesIO
import time
import threading
import traceback
from datetime import datetime, timezone
import base64
import pyvips
import re
import uuid
import tempfile

from tissuelab_sdk.wrapper import (TiffSlideWrapper, TiffFileWrapper,
                    SimpleImageWrapper, DicomImageWrapper,
                    NiftiImageWrapper)

from app.wrapper import PyvipsSlideWrapper

import tiffslide
try:
    import tifffile as _tifffile
except Exception:
    _tifffile = None
try:
    from tissuelab_sdk.wrapper import ISyntaxImageWrapper
except:
    ISyntaxImageWrapper = None
from isyntax import ISyntax

try:
    from tissuelab_sdk.wrapper import CziImageWrapper
except:
    CziImageWrapper = None
from app.utils import resolve_path
from app.config.path_config import resolve_virtual_path, STORAGE_ROOT

# set logging level to WARNING
log = logging.getLogger('werkzeug')
log.setLevel(logging.WARNING)

# Logger for z-stack specific logging
logger = logging.getLogger(__name__)

# constants
TILE_SIZE = 512
ALLOWED_EXTENSIONS = {'svs', 'tif', 'tiff', 'czi', 'qptiff', 'ndpi', 'jpeg', 'png', 'jpg', 'bmp', 'nii', 'nii.gz', 'btf', 'isyntax', 'dcm'}

# Configuration for skipping NII parsing
SKIP_NII_PARSING = True  # Set to True to skip NII file parsing and use direct loading

# global variables for multi-session support
sessions = {}  # key: session_id, value: session_data dict
script_globals = {'ImageOps': ImageOps}
script_locals = {}
thread_pool = None
session_lock = threading.Lock()

def get_session_data(session_id: str) -> Dict:
    """Get or create session data for a given session ID"""
    with session_lock:
        if session_id not in sessions:
            sessions[session_id] = {
                'slide': None,
                'slide_levels': None,
                'current_file_format': 'svs',
                'current_file_path': None,
                'tiff_slide_wrapper': False,
                'isyntax_slide': None,
                'last_isyntax_file_path': None,
                'isyntax_lock': threading.Lock(),
                'zstack_info': {
                    'has_zstack': False,
                    'layer_count': 1,
                    'layer_indices': [0]
                },
                'current_z_layer': 0
            }
        return sessions[session_id]

def _cleanup_instance_data(instance_id: str):
    """Clean up review/AL data associated with an instance."""
    try:
        from app.services.review import cleanup_instance_data
        return cleanup_instance_data(instance_id)
    except Exception as e:
        logger.warning(f"Failed to cleanup AL data for session {instance_id}: {e}")
        return None


def clear_session(session_id: str, cleanup_review: bool = True):
    """Clear session data for a given session ID"""
    with session_lock:
        if session_id in sessions:
            session_data = sessions[session_id]
            # Close any open slides
            if session_data.get('slide'):
                try:
                    if hasattr(session_data['slide'], 'close'):
                        session_data['slide'].close()
                except:
                    pass
            if session_data.get('isyntax_slide'):
                try:
                    session_data['isyntax_slide'].close()
                except:
                    pass
            del sessions[session_id]

    if cleanup_review:
        return _cleanup_instance_data(session_id)

    return None


def create_instance_from_path(file_path: str) -> Dict:
    """Create a new instance/session from a file path."""
    if not file_path:
        return {"status": "error", "message": "file_path is required"}

    resolved_file_path = resolve_virtual_path(file_path)
    if not resolved_file_path:
        return {"status": "error", "message": "Unrecognized or invalid path"}

    absolute_file_path = resolve_path(resolved_file_path)
    instance_id = str(uuid.uuid4())

    logger.info(
        "Creating instance %s for file path %s -> %s",
        instance_id,
        resolved_file_path,
        absolute_file_path,
    )

    result = load_slide_from_file_with_session(absolute_file_path, instance_id)
    if result["status"] == "error":
        return result

    return {
        "status": "success",
        "instanceId": instance_id,
        "message": "Instance created successfully",
        "file_format": result["file_format"],
        "dimensions": result["dimensions"],
        "level_count": result["level_count"],
        "total_tiles": result["total_tiles"],
        "total_channels": result.get("total_channels", 3),
        "image_type": result.get("image_type", "Brightfield H&E"),
    }


def delete_instance_and_cleanup(instance_id: str) -> Dict:
    """Delete an instance/session and clean up related state."""
    if not instance_id:
        return {"status": "error", "message": "instance_id is required"}

    cleanup_result = clear_session(instance_id)
    return {
        "status": "success",
        "message": f"Instance {instance_id} deleted successfully",
        "al_cleanup": cleanup_result,
    }


def _normalize_dimensions(dimensions) -> List[int]:
    """Normalize dimensions into a JSON-friendly two-item list."""
    if isinstance(dimensions, (tuple, list)):
        return list(dimensions)
    return [0, 0]


def _normalize_mpp(file_format: str, skip_parsing: bool, mpp_value):
    """Normalize MPP for API responses."""
    if file_format in ["nii", "nii.gz"] and skip_parsing:
        return None
    if mpp_value == 0.0:
        return None
    return mpp_value if mpp_value is not None else None


def _normalize_magnification(file_format: str, skip_parsing: bool, magnification_value):
    """Normalize magnification for API responses."""
    if file_format in ["nii", "nii.gz"] and skip_parsing:
        return None
    if magnification_value is None:
        return None
    if isinstance(magnification_value, dict) and not magnification_value:
        return None
    return magnification_value


def _clean_response_data(obj):
    """Recursively preserve JSON-null while normalizing nested containers."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return {key: _clean_response_data(value) for key, value in obj.items()}
    if isinstance(obj, list):
        return [_clean_response_data(item) for item in obj]
    return obj


def build_upload_path_response(response_file_path: str, full_file_path: str, load_result: Dict) -> Dict:
    """Build the upload_path API payload from a service-layer load result."""
    file_name = os.path.basename(full_file_path)
    file_size = os.path.getsize(full_file_path) if os.path.exists(full_file_path) else 0

    slide_pyramid_info = load_result.get("pyramid_info", [])
    if slide_pyramid_info:
        slide_dimensions = slide_pyramid_info[0].get(
            "dimensions",
            load_result.get("dimensions", [0, 0]),
        )
    else:
        slide_dimensions = load_result.get("dimensions", [0, 0])

    slide_file_format = load_result.get("file_format", "")
    response = {
        "message": "Slide loaded successfully from path",
        "status": "success",
        "success": True,
        "filePath": response_file_path,
        "fileName": file_name,
        "fileFormat": slide_file_format,
        "fileSize": load_result.get("file_size", file_size),
        "directory": os.path.dirname(response_file_path),
        "slideInfo": {
            "fileFormat": slide_file_format,
            "dimensions": _normalize_dimensions(slide_dimensions),
            "levelCount": load_result.get("level_count", 0),
            "totalTiles": load_result.get("total_tiles", 0),
            "totalChannels": load_result.get("total_channels", 3),
            "mpp": _normalize_mpp(
                slide_file_format,
                load_result.get("skip_parsing", False),
                load_result.get("mpp"),
            ),
            "magnification": _normalize_magnification(
                slide_file_format,
                load_result.get("skip_parsing", False),
                load_result.get("magnification"),
            ),
            "imageType": load_result.get("image_type", "Brightfield H&E"),
            "processingStatus": load_result.get("processing_status", "Pending"),
            "pyramidInfo": slide_pyramid_info,
            "properties": load_result.get("properties", {}),
        },
    }
    return _clean_response_data(response)


def build_upload_file_response(load_result: Dict) -> Dict:
    """Build the upload API payload from a slide load result."""
    return {
        "message": "File uploaded and slide loaded successfully",
        "file_format": load_result["file_format"],
        "dimensions": load_result["dimensions"],
        "level_count": load_result["level_count"],
        "total_tiles": load_result["total_tiles"],
    }


def load_uploaded_file_for_api(filename: str, file_bytes: bytes, session_id: str = "default") -> Dict:
    """Persist an uploaded file temporarily, load it into a session, and clean up."""
    if not allowed_file(filename):
        return {"status": "error", "message": "File format not supported"}

    suffix = os.path.splitext(filename)[1]
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix, prefix="load_upload_") as tmp:
            tmp.write(file_bytes)
            temp_path = tmp.name

        result = load_slide_from_file_with_session(temp_path, session_id)
        if result["status"] == "error":
            return result

        response = build_upload_file_response(result)
        response["status"] = "success"
        return response
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception as e:
                logger.warning("Failed to delete temporary upload file %s: %s", temp_path, e)


def load_slide_from_path_for_api(file_path: str, session_id: str = "default") -> Dict:
    """Resolve a request path, load the slide, and build the upload_path API payload."""
    if not file_path:
        return {"status": "error", "message": "No file path provided (tried all extraction methods)"}

    requested_file_path = file_path
    resolved_file_path = resolve_virtual_path(file_path)
    if not resolved_file_path:
        return {"status": "error", "message": "Unrecognized or invalid path"}

    full_file_path = resolve_path(resolved_file_path)
    result = upload_file_path(full_file_path, session_id)
    if result["status"] == "error":
        return result

    return build_upload_path_response(requested_file_path, full_file_path, result)


def build_upload_folder_response(relative_folder_path: str, result: Dict) -> Dict:
    """Build the upload_folder API payload from folder scan results."""
    relative_wsi_files = []
    for wsi_file in result.get("wsi_files", []):
        if wsi_file.startswith(STORAGE_ROOT):
            relative_wsi_file = os.path.relpath(wsi_file, STORAGE_ROOT).replace("\\", "/")
            relative_wsi_files.append(relative_wsi_file)
        else:
            relative_wsi_files.append(wsi_file)

    relative_wsi_file = ""
    if result.get("wsi_file", ""):
        wsi_file = result.get("wsi_file", "")
        if wsi_file.startswith(STORAGE_ROOT):
            relative_wsi_file = os.path.relpath(wsi_file, STORAGE_ROOT).replace("\\", "/")
        else:
            relative_wsi_file = wsi_file

    response_data = {
        "status": "success",
        "message": "Folder structure retrieved successfully",
        "folder_path": relative_folder_path,
        "folderPath": relative_folder_path,
        "wsi_file": relative_wsi_file,
        "wsi_files": relative_wsi_files,
        "file_tree_dict": result.get("file_tree_dict", {}),
        "file_tree": result.get("file_tree_dict", {}),
        "tree_structure": result.get("tree_structure", {}),
        "fileTree": result.get("file_tree_dict", {}),
        "files": relative_wsi_files,
        "tlproj_dict": result.get("tlproj_dict", {}),
    }

    def replace_none_with_default(obj, default_dict=None, default_list=None):
        if default_dict is None:
            default_dict = {}
        if default_list is None:
            default_list = []
        if obj is None:
            return default_dict
        if isinstance(obj, dict):
            return {k: replace_none_with_default(v) for k, v in obj.items()}
        if isinstance(obj, list):
            if not obj:
                return default_list
            return [replace_none_with_default(item) for item in obj]
        return obj if obj is not None else ""

    return replace_none_with_default(response_data)


def get_folder_structure_for_api(folder_path: Optional[str]) -> Dict:
    """Resolve a folder path, scan it, and build the upload_folder API payload."""
    folder_path = folder_path or ""
    full_folder_path = resolve_path(folder_path)
    result = generate_tlproj_from_folder(full_folder_path)
    if result["status"] == "error":
        return result
    return build_upload_folder_response(folder_path, result)


def get_loaded_slide_info(session_id: str = "default") -> Dict:
    """Return the currently loaded slide metadata for a session."""
    session_data = get_session_data(session_id)
    session_slide = session_data["slide"]
    session_current_file_format = session_data["current_file_format"]

    if session_slide is None:
        if session_data.get("skip_parsing", False) and session_current_file_format in ["nii", "nii.gz"]:
            dimensions = _normalize_dimensions(session_data.get("dimensions", [512, 512]))
            return {
                "status": "success",
                "message": "Slide loaded successfully",
                "slideInfo": {
                    "fileFormat": session_current_file_format,
                    "dimensions": dimensions,
                    "levelCount": session_data.get("level_count", 1),
                    "totalTiles": session_data.get("total_tiles", 1),
                    "mpp": None,
                    "magnification": None,
                    "pyramidInfo": [{
                        "level": 0,
                        "dimensions": dimensions,
                        "downsample": 1.0,
                    }],
                },
            }
        return {"status": "error", "message": f"No slide loaded for session {session_id}"}

    return {
        "status": "success",
        "message": "Slide loaded successfully",
        "slideInfo": {
            "fileFormat": session_current_file_format,
            "dimensions": session_slide.dimensions,
            "levelCount": len(session_slide.level_dimensions) if hasattr(session_slide, "level_dimensions") else 0,
            "totalTiles": calculate_total_tiles(session_slide),
            "pyramidInfo": get_pyramid_info(session_slide),
        },
    }


def get_session_pyramid_info(session_id: str = "default") -> Dict:
    """Return pyramid metadata for the current session slide."""
    session_data = get_session_data(session_id)
    session_slide = session_data["slide"]

    if session_slide is None:
        return {"status": "error", "message": f"No slide loaded for session {session_id}"}

    result = {
        "level_count": len(session_slide.level_dimensions),
        "dimensions": session_slide.dimensions,
    }

    pyramid_levels = []
    for level in range(len(session_slide.level_dimensions)):
        width, height = session_slide.level_dimensions[level]
        downsample = session_slide.dimensions[0] / width
        pyramid_levels.append({
            "level": level,
            "dimensions": [width, height],
            "size": {"width": width, "height": height},
            "downsample": downsample,
            "cols": math.ceil(width / TILE_SIZE),
            "rows": math.ceil(height / TILE_SIZE),
        })

    result["levels"] = pyramid_levels

    if pyramid_levels:
        thumbnail_level = len(pyramid_levels) - 1
        result["thumbnail_level"] = thumbnail_level
        result["thumbnail_dimensions"] = pyramid_levels[thumbnail_level]["dimensions"]

        best_level = 0
        best_size_diff = float("inf")
        target_width = 1000

        for level_info in pyramid_levels:
            width = level_info["dimensions"][0]
            diff = abs(width - target_width)
            if diff < best_size_diff:
                best_size_diff = diff
                best_level = level_info["level"]

        result["best_level"] = best_level

    return {"status": "success", "data": result}


def get_session_properties_response(session_id: str = "default") -> Dict:
    """Return frontend-friendly slide properties for the current session."""
    session_data = get_session_data(session_id)
    session_slide = session_data["slide"]

    if session_slide is None:
        return {"status": "error", "message": f"No slide loaded for session {session_id}"}

    result = get_slide_properties(session_slide)
    if "error" in result:
        return {"status": "error", "message": result["error"]}

    if "dimensions" not in result:
        result["dimensions"] = session_slide.dimensions

    result["level_count"] = len(session_slide.level_dimensions)
    result["mpp"] = result.get("mpp", 0.25)
    result["magnification"] = result.get("magnification", "20x")

    if "pyramid_info" in result:
        for level_info in result["pyramid_info"]:
            level = level_info["level"]
            width, height = session_slide.level_dimensions[level]
            level_info["cols"] = math.ceil(width / TILE_SIZE)
            level_info["rows"] = math.ceil(height / TILE_SIZE)

    if result["level_count"] > 0:
        result["best_level"] = 0
        result["thumbnail_level"] = result["level_count"] - 1

    result["status"] = "success"
    return {"status": "success", "data": result}


def _parse_tile_request_inputs(col_row: str, query_params) -> Dict:
    """Parse tile request inputs into service-friendly values."""
    channels_list = []
    colors_list = []

    for param_name in query_params:
        if param_name.startswith("channels["):
            for value in query_params.getlist(param_name):
                try:
                    channels_list.append(int(value))
                except ValueError:
                    logger.warning("Unable to convert channel value '%s' to integer", value)
        elif param_name.startswith("colors["):
            for value in query_params.getlist(param_name):
                colors_list.append(value)

    col_row_clean = col_row.replace(".jpeg", "")
    parts = col_row_clean.split("_")
    if len(parts) != 2:
        return {
            "status": "error",
            "message": f"Invalid tile format: {col_row_clean}. Expected format: col_row",
        }

    try:
        col = int(parts[0])
        row = int(parts[1])
    except ValueError:
        return {
            "status": "error",
            "message": f"Invalid tile values: {col_row_clean}. Col and row must be integers",
        }

    return {
        "status": "success",
        "col": col,
        "row": row,
        "channels": channels_list,
        "colors": colors_list,
    }


def _get_isyntax_tile(
    session_data: Dict,
    session_id: str,
    level: int,
    col: int,
    row: int,
    scale_factor: float,
    color_mode: Optional[str],
    channels_list: List[int],
    colors_list: List[str],
) -> Dict:
    """Serve an ISyntax tile with session-level locking and cache support."""
    session_current_file_path = session_data["current_file_path"]

    from app.services.tile_cache_service import get_tile_cache
    tile_cache = get_tile_cache()

    if session_current_file_path:
        cached_tile = tile_cache.get_cached_tile(
            session_current_file_path,
            level,
            col,
            row,
            scale_factor,
            color_mode,
            channels_list,
            colors_list,
        )
        if cached_tile:
            logger.debug(
                "Cache hit for ISyntax tile: level=%s col=%s row=%s",
                level,
                col,
                row,
            )
            return {
                "status": "success",
                "image_data": cached_tile,
                "format": "JPEG",
                "width": TILE_SIZE,
                "height": TILE_SIZE,
            }

    isyntax_lock = session_data["isyntax_lock"]
    with isyntax_lock:
        if session_data["last_isyntax_file_path"] != session_current_file_path:
            session_data["last_isyntax_file_path"] = session_current_file_path
            if session_data["isyntax_slide"] is not None:
                session_data["isyntax_slide"].close()
            session_data["isyntax_slide"] = ISyntax.open(session_current_file_path)

        if session_data["isyntax_slide"] is None:
            return {
                "status": "error",
                "message": f"No ISyntax slide loaded for session {session_id}",
            }

        size = TILE_SIZE
        isyntax_slide = session_data["isyntax_slide"]
        dzi_level = int(level)
        W = (
            isyntax_slide.level_dimensions[0][0]
            if hasattr(isyntax_slide, "level_dimensions")
            else isyntax_slide.dimensions[0]
        )
        H = (
            isyntax_slide.level_dimensions[0][1]
            if hasattr(isyntax_slide, "level_dimensions")
            else isyntax_slide.dimensions[1]
        )
        max_dzi_level = max(0, math.ceil(math.log2(max(W, H) / size)))
        tile_span = size * (2 ** (max_dzi_level - dzi_level))
        x = int(col) * tile_span
        y = int(row) * tile_span
        x = min(x, W)
        y = min(y, H)
        w = min(tile_span, W - x)
        h = min(tile_span, H - y)
        out_w = max(1, math.ceil(w * size / tile_span))
        out_h = max(1, math.ceil(h * size / tile_span))
        w, h = max(1, math.ceil(w)), max(1, math.ceil(h))

        target_downsample = max(1.0, tile_span / size)
        if hasattr(isyntax_slide, "get_best_level_for_downsample"):
            svs_level = isyntax_slide.get_best_level_for_downsample(target_downsample)
        else:
            svs_level = 0
            n_levels = isyntax_slide.level_count if hasattr(isyntax_slide, "level_count") else 1
            for lvl in range(n_levels):
                try:
                    lvl_w = isyntax_slide.level_dimensions[lvl][0]
                    if (W / lvl_w) <= target_downsample:
                        svs_level = lvl
                except Exception:
                    break
        svs_level = max(0, svs_level)

        actual_svs_ds = isyntax_slide.level_dimensions[0][0] / isyntax_slide.level_dimensions[svs_level][0]
        sx = max(0, int(round(x / actual_svs_ds)))
        sy = max(0, int(round(y / actual_svs_ds)))
        sw = max(1, int(round(w / actual_svs_ds)))
        sh = max(1, int(round(h / actual_svs_ds)))
        img_arr = session_data["isyntax_slide"].read_region(sx, sy, sw, sh, svs_level)

    img = Image.fromarray(img_arr)
    img = img.resize((out_w, out_h), Image.Resampling.LANCZOS)
    buffer = BytesIO()
    img.convert("RGB").save(buffer, format="JPEG", quality=75, optimize=False)
    jpeg_data = buffer.getvalue()

    if session_current_file_path:
        tile_cache.cache_tile(
            session_current_file_path,
            level,
            col,
            row,
            scale_factor,
            color_mode,
            channels_list,
            colors_list,
            jpeg_data,
        )

    return {
        "status": "success",
        "image_data": jpeg_data,
        "format": "JPEG",
        "width": out_w,
        "height": out_h,
    }


async def get_tile_for_api(
    level: int,
    col_row: str,
    scale_factor: float = 1.0,
    color_mode: Optional[str] = None,
    query_params=None,
    session_id: str = "default",
) -> Dict:
    """Resolve a tile request into JPEG bytes and metadata."""
    parse_result = _parse_tile_request_inputs(col_row, query_params)
    if parse_result["status"] == "error":
        return parse_result

    col = parse_result["col"]
    row = parse_result["row"]
    channels_list = parse_result["channels"]
    colors_list = parse_result["colors"]

    session_data = get_session_data(session_id)
    session_current_file_format = session_data["current_file_format"]

    if session_current_file_format == "isyntax":
        return _get_isyntax_tile(
            session_data=session_data,
            session_id=session_id,
            level=level,
            col=col,
            row=row,
            scale_factor=scale_factor,
            color_mode=color_mode,
            channels_list=channels_list,
            colors_list=colors_list,
        )

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None,
        lambda: get_tile(
            level=level,
            col=col,
            row=row,
            scale_factor=scale_factor,
            color_mode=color_mode,
            channels=channels_list,
            colors=colors_list,
            session_id=session_id,
        ),
    )


def get_preprocess_result_for_api() -> Dict:
    """Normalize preprocess result payload for the API."""
    result = get_process_result()
    if result["status"] == "processing":
        return {
            "status": "success",
            "data": {
                "message": result["message"],
                "progress": result["progress"],
            },
        }
    return {"status": "success", "data": result}


def get_cache_stats_response() -> Dict:
    """Return tile cache stats for API responses."""
    from app.services.tile_cache_service import get_tile_cache

    tile_cache = get_tile_cache()
    return {
        "status": "success",
        "cache_stats": tile_cache.get_cache_stats(),
    }


def clear_tile_cache_response() -> Dict:
    """Clear the tile cache and return API response data."""
    from app.services.tile_cache_service import get_tile_cache

    tile_cache = get_tile_cache()
    tile_cache.clear_cache()
    return {
        "status": "success",
        "message": "All cache cleared",
    }


def get_zstack_info_response(session_id: str) -> Dict:
    """Return z-stack info in API payload shape."""
    result = get_z_layer_info(session_id)
    if result["status"] == "error":
        return result
    return {
        "status": "success",
        "data": {
            "zstack_info": result["zstack_info"],
            "current_layer": result["current_layer"],
        },
    }


def set_z_layer_for_api(session_id: str, z_layer: int) -> Dict:
    """Set z-layer and return API payload shape."""
    result = set_z_layer(session_id, int(z_layer))
    if result["status"] == "error":
        return result
    return {
        "status": "success",
        "data": {
            "message": result["message"],
            "current_layer": result["current_layer"],
            "layer_count": result["layer_count"],
        },
    }


# ============================================================================
# Z-Stack Related Functions
# ============================================================================

def detect_zstack_layers(file_path: str) -> Dict:
    """
    Detect z-stack layers in NDPI file
    Returns: dict with z_stack info (layer_count, layer_indices, has_zstack)
    """
    try:
        if not file_path.lower().endswith('.ndpi'):
            return {"has_zstack": False, "layer_count": 1, "layer_indices": [0]}
        
        # Try to detect z-stack using tifffile
        if _tifffile is None:
            logger.warning("[Z-Stack] tifffile not available, cannot detect z-stack layers")
            return {"has_zstack": False, "layer_count": 1, "layer_indices": [0]}
        
        try:
            with _tifffile.TiffFile(file_path) as tif:
                num_series = len(tif.series)
                logger.info(f"[Z-Stack] File has {num_series} series")
                
                # Check if first series has ZYXS or ZCYX axes (direct z-stack indicator)
                if num_series > 0:
                    first_series = tif.series[0]
                    if hasattr(first_series, 'axes'):
                        axes = first_series.axes
                        logger.info(f"[Z-Stack] First series axes: {axes}, shape: {first_series.shape}")
                        
                        if axes and axes[0] == 'Z':
                            z_count = first_series.shape[0]  # First dimension is z
                            logger.info(f"[Z-Stack] Detected Z-axis in series, z_count={z_count}")
                            return {
                                "has_zstack": True,
                                "layer_count": z_count,
                                "layer_indices": list(range(z_count)),
                                "current_layer": 0
                            }
                
                # Fallback: Check for z-stack metadata in NDPI tags
                z_layers = []
                for series_idx, series in enumerate(tif.series):
                    # Look for z-position metadata
                    if len(series.pages) > 0:
                        page = series.pages[0]
                        
                        # Check NDPI-specific tags for z-stack info
                        # NDPI stores z-position in custom tags
                        if hasattr(page, 'tags'):
                            # Look for focal plane or z-position tags
                            for tag in page.tags.values():
                                if 'focal' in str(tag.name).lower() or 'z' in str(tag.name).lower():
                                    z_layers.append(series_idx)
                                    break
                
                # If we found z-stack layers
                if len(z_layers) > 1:
                    logger.info(f"[Z-Stack] Detected {len(z_layers)} z-stack layers in NDPI file")
                    return {
                        "has_zstack": True,
                        "layer_count": len(z_layers),
                        "layer_indices": z_layers,
                        "current_layer": 0
                    }
                
                # Fallback: check if multiple pages at same resolution (common z-stack pattern)
                if num_series == 1 and len(tif.series[0].pages) > 1:
                    pages = tif.series[0].pages
                    # Check if pages have same dimensions (indicates z-stack)
                    if all(p.shape == pages[0].shape for p in pages[:10]):  # Check first 10
                        layer_count = len(pages)
                        logger.info(f"[Z-Stack] Detected {layer_count} z-stack layers (page-based)")
                        return {
                            "has_zstack": True,
                            "layer_count": layer_count,
                            "layer_indices": list(range(layer_count)),
                            "current_layer": 0
                        }
                
                # No z-stack detected
                logger.info("[Z-Stack] No z-stack detected")
                return {"has_zstack": False, "layer_count": 1, "layer_indices": [0]}
                
        except Exception as e:
            logger.warning(f"[Z-Stack] Error detecting z-stack layers: {e}")
            return {"has_zstack": False, "layer_count": 1, "layer_indices": [0]}
            
    except Exception as e:
        logger.error(f"[Z-Stack] Unexpected error in detect_zstack_layers: {e}")
        return {"has_zstack": False, "layer_count": 1, "layer_indices": [0]}


def set_z_layer(session_id: str, z_layer: int) -> Dict:
    """
    Set the current z-layer for viewing
    Args:
        session_id: Session identifier
        z_layer: Z-layer index to switch to
    Returns:
        Dict with status and current layer info
    """
    try:
        logger.info(f"[Z-Stack] Setting z-layer to {z_layer} for session {session_id}")
        session_data = get_session_data(session_id)
        zstack_info = session_data.get('zstack_info', {})
        
        if not zstack_info.get('has_zstack', False):
            return {
                "status": "error",
                "message": "Current file does not have z-stack layers"
            }
        
        layer_indices = zstack_info.get('layer_indices', [0])
        if z_layer not in layer_indices:
            return {
                "status": "error",
                "message": f"Invalid z-layer {z_layer}. Available layers: {layer_indices}"
            }
        
        # Update current z-layer in session
        session_data['current_z_layer'] = z_layer
        zstack_info['current_layer'] = z_layer
        
        logger.info(f"[Z-Stack] Successfully switched to z-layer {z_layer} for session {session_id}")
        
        return {
            "status": "success",
            "message": f"Switched to z-layer {z_layer}",
            "current_layer": z_layer,
            "layer_count": zstack_info.get('layer_count', 1)
        }
        
    except Exception as e:
        logger.error(f"[Z-Stack] Error setting z-layer: {e}")
        return {
            "status": "error",
            "message": f"Error setting z-layer: {str(e)}"
        }


def get_z_layer_info(session_id: str) -> Dict:
    """
    Get current z-layer information for a session
    Args:
        session_id: Session identifier
    Returns:
        Dict with z-stack info
    """
    try:
        logger.info(f"[Z-Stack] Getting z-layer info for session: {session_id}")
        session_data = get_session_data(session_id)
        zstack_info = session_data.get('zstack_info', {
            'has_zstack': False,
            'layer_count': 1,
            'layer_indices': [0]
        })
        
        # If no z-stack info in this session and session_id is not "default",
        # try to get from "default" session as fallback
        if not zstack_info.get('has_zstack', False) and session_id != "default":
            logger.info(f"[Z-Stack] No z-stack in session {session_id}, trying default session")
            try:
                default_session = get_session_data("default")
                default_zstack = default_session.get('zstack_info', {})
                if default_zstack.get('has_zstack', False):
                    logger.info(f"[Z-Stack] Found z-stack in default session, using that")
                    zstack_info = default_zstack
                    session_data['zstack_info'] = zstack_info  # Copy to current session
                    session_data['current_z_layer'] = default_session.get('current_z_layer', 0)
            except Exception as fallback_error:
                logger.warning(f"[Z-Stack] Failed to get from default session: {fallback_error}")
        
        logger.info(f"[Z-Stack] Returning info for session {session_id}: {zstack_info}")
        
        return {
            "status": "success",
            "zstack_info": zstack_info,
            "current_layer": session_data.get('current_z_layer', 0)
        }
        
    except Exception as e:
        logger.error(f"[Z-Stack] Error getting z-layer info: {e}")
        return {
            "status": "error",
            "message": f"Error getting z-layer info: {str(e)}"
        }


# Legacy global variables for backward compatibility
slide = None
slide_levels = None  
current_file_format = 'svs'
current_file_path = None
tiff_slide_wrapper = False

# preprocessing related global variables
progress = 0
is_processing = False
process_result = None
progress_lock = threading.Lock()

def start_preprocess(model: str, magnification: str) -> Dict:
    """Start preprocessing task"""
    global progress, is_processing, process_result
    
    # reset progress and status
    with progress_lock:
        progress = 0
        is_processing = True
        process_result = None
    
    # start background thread to simulate processing
    thread = threading.Thread(target=run_processing_task, args=(model, magnification))
    thread.daemon = True
    thread.start()
    
    return {
        "message": f"Preprocess started with model: {model}, magnification: {magnification}",
        "status": "running"
    }

def run_processing_task(model: str, magnification: str):
    """Simulate processing task"""
    global progress, is_processing, process_result
    
    try:
        # simulate processing process
        for i in range(10):
            time.sleep(0.5)  # simulate time-consuming operation
            with progress_lock:
                progress += 10
                
        # set completed status and result
        with progress_lock:
            is_processing = False
            process_result = {
                "status": "completed",
                "result": {
                    "number_of_nuclei": "50000",
                    "cell_count": 50000,
                    "processing_time": 5.0,
                    "model": model,
                    "magnification": magnification
                }
            }
    except Exception as e:
        # error in processing
        with progress_lock:
            is_processing = False
            process_result = {
                "status": "error",
                "error": str(e)
            }

def get_current_progress() -> Dict:
    """Get current processing progress"""
    global progress, is_processing
    
    with progress_lock:
        current_progress = progress
        status = is_processing
    
    if status:
        return {
            "progress": current_progress,
            "message": "Processing ongoing"
        }
    else:
        return {
            "progress": 100,
            "message": "Processing complete"
        }

def get_process_result() -> Dict:
    """Get processing result"""
    global progress, is_processing, process_result
    
    with progress_lock:
        current_progress = progress
        status = is_processing
        result = process_result
    
    if status or current_progress < 100:
        return {
            "status": "processing",
            "message": "Processing not complete yet",
            "progress": current_progress
        }
    
    if result:
        return result
    
    return {
        "status": "unknown",
        "message": "No result available"
    }

def get_file_extension(filename: str) -> str:
    """Get file extension, handling special cases like .nii.gz"""
    if filename.endswith('.nii.gz'):
        return 'nii.gz'
    elif '.' in filename:
        return filename.rsplit('.', 1)[1].lower()
    else:
        return ''

def smart_load_ndpi_wrapper(file_path: str):
    """
    Smart wrapper selection for NDPI files based on metadata
    
    Uses tifffile to read metadata first:
    - If file has z-stack (multi-layer): use TiffFileWrapper (supports z_layer)
    - If file is single-layer: use TiffSlideWrapper (faster performance)
    
    Args:
        file_path: Path to NDPI file
        
    Returns:
        Tuple of (wrapper_object, is_tiff_file_wrapper: bool)
    """
    is_zstack = False
    try:
        if _tifffile is not None:
            with _tifffile.TiffFile(file_path) as tf:
                if hasattr(tf, 'series') and len(tf.series) > 0:
                    series = tf.series[0]
                    if hasattr(series, 'shape') and len(series.shape) == 4:
                        is_zstack = True
                        logger.info(f"[NDPI Smart Load] Detected z-stack (4D shape), using TiffFileWrapper")
    except Exception as e:
        logger.warning(f"[NDPI Smart Load] Failed to check metadata: {e}, defaulting to TiffSlideWrapper")
    
    # Choose wrapper based on file structure
    if is_zstack:
        # Z-stack file: use TiffFileWrapper with zarr optimization
        wrapper = TiffFileWrapper(file_path)
        logger.info(f"[NDPI Smart Load] Using TiffFileWrapper for z-stack file: {file_path}")
        return wrapper, True
    else:
        # Standard NDPI: use TiffSlideWrapper
        wrapper = TiffSlideWrapper(file_path)
        logger.info(f"[NDPI Smart Load] Using TiffSlideWrapper for standard file: {file_path}")
        return wrapper, False

def allowed_file(filename: str) -> bool:
    """Check if file is allowed format"""
    return get_file_extension(filename) in ALLOWED_EXTENSIONS

def calculate_total_tiles(slide_obj) -> int:
    """Calculate total tiles of slide"""
    if slide_obj is None:
        # For NII files with parsing skipped, return a default value
        return 1
    
    tile_size = TILE_SIZE  # standard tile size
    min_tiles = float('inf')

    # iterate through all levels to find the one with minimum tiles
    for level in range(len(slide_obj.level_dimensions)):
        width, height = slide_obj.level_dimensions[level]
        cols = math.ceil(width / tile_size)
        rows = math.ceil(height / tile_size)
        total = cols * rows

        if total < min_tiles:
            min_tiles = total
            min_level_dims = (width, height)
            min_level = level

    return min_tiles

def get_file_tree_structure(path: str) -> Dict:
    """Get file tree structure"""
    if not path:
        path = resolve_path("")
    else:
        path = resolve_path(path)
    
    if not os.path.exists(path):
        return {}

    if os.path.isfile(path):
        return os.path.basename(path)

    structure = {}
    for item in os.listdir(path):
        item_path = os.path.join(path, item)
        structure[item] = get_file_tree_structure(item_path)

    return structure

def tree_to_string(tree_structure: Dict, indent: str = '') -> str:
    """Convert tree structure to string representation"""
    result = []
    for name, content in tree_structure.items():
        if isinstance(content, dict):
            result.append(f"{indent}  {name}")
            result.append(tree_to_string(content, indent + '   '))
        else:
            result.append(f"{indent}  {name}")
    return '\n'.join(result)

def find_wsi_file(folder_path: str) -> Optional[str]:
    """Find the first WSI file in folder"""
    for root, dirs, files in os.walk(folder_path):
        for file in files:
            if allowed_file(file):
                return os.path.abspath(os.path.join(root, file))
    return None

def find_all_wsi_files(folder_path: str) -> List[str]:
    """Find all WSI files in folder"""
    if not folder_path:
        folder_path = resolve_path("")
    else:
        folder_path = resolve_path(folder_path)
    
    wsi_files = []
    for root, dirs, files in os.walk(folder_path):
        for file in files:
            if allowed_file(file):
                wsi_files.append(os.path.abspath(os.path.join(root, file)))
    return wsi_files

def generate_tlproj_from_folder(folder_path: str) -> Dict:
    """Generate project structure from folder"""
    # Match the Django implementation by returning more complete info
    wsi_files = find_all_wsi_files(folder_path)
    
    # Get first file as default (can be None if no WSI files found)
    wsi_file = wsi_files[0] if wsi_files else None
    
    # Get file tree structure
    tree_structure = get_file_tree_structure(folder_path)
    
    # Match Django implementation with project name and timestamps
    project_name = os.path.basename(folder_path) if folder_path else "Root"
    current_time = datetime.now(timezone.utc).isoformat() + "Z"
    current_time_minute = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M')
    
    tlproj_dict = {
        "projectName": f"{project_name}-Project-{current_time_minute}",
        "wsiFiles": wsi_files,
        "createdAt": current_time,
        "lastModified": current_time
    }
    
    return {
        "status": "success",
        "wsi_file": wsi_file,
        "wsi_files": wsi_files,
        "tree_structure": tree_structure,
        "file_tree_dict": tree_structure,
        "tlproj_dict": tlproj_dict
    }

def process_channel(args: Tuple[np.ndarray, np.ndarray, int]) -> np.ndarray:
    """Process channel"""
    channel, color, _ = args
    #(height, width, 3)
    result = np.zeros((*channel.shape, 3), dtype=np.float32)
    for i in range(3):
        result[..., i] = channel * (color[i] / 255.0)
    return result

def get_pyramid_info(slide_obj) -> Dict:
    """Get pyramid information"""
    if slide_obj is None:
        # For NII files with parsing skipped, return minimal pyramid info
        return [{
            "level": 0,
            "dimensions": (512, 512),  # Default dimensions
            "downsample": 1.0
        }]
    
    result = []
    for level in range(len(slide_obj.level_dimensions)):
        width, height = slide_obj.level_dimensions[level]
        # Calculate downsample factor relative to level 0
        downsample = slide_obj.dimensions[0] / width
        level_info = {
            "level": level,
            "dimensions": (width, height),
            "downsample": downsample
        }
        result.append(level_info)
    return result

def get_slide_properties(slide_obj) -> Dict:
    """Get slide properties"""
    if slide_obj is None:
        # For NII files with parsing skipped, return minimal properties
        return {
            'pyramid_info': [{'downsample': 1.0}],
            'max_level': 1,
            'greatest_downsample': 1.0,
            'zoom_ratios': [1.0]
        }
    
    local_dict = {}
    local_dict['pyramid_info'] = get_pyramid_info(slide_obj)
    print(f"pyramid_info: {local_dict['pyramid_info']}", '!'*50)
    local_dict['max_level'] = len(slide_obj.level_dimensions)
    print(f"max_level: {local_dict['max_level']}", '!'*50)
    local_dict['greatest_downsample'] = local_dict['pyramid_info'][-1]['downsample']

    zoom_ratios = []
    for i in range(local_dict['max_level']):
        zoom_ratios.append(slide_obj.level_dimensions[0][0] / slide_obj.level_dimensions[i][0])
    local_dict['zoom_ratios'] = zoom_ratios
    print(f"zoom_ratios: {local_dict['zoom_ratios']}", '!'*50)
    return local_dict

@lru_cache(maxsize=2000)
def process_tile_with_colors(img_np_bytes: bytes, shape: Tuple, channel_indices: Tuple, colors: Tuple) -> np.ndarray:
    """Process tile with colors using vectorised numpy (no thread pool overhead)."""
    try:
        img_np = np.frombuffer(img_np_bytes, dtype=np.uint8).reshape(shape)
        height, width = img_np.shape[:2]
        combined_img = np.zeros((height, width, 3), dtype=np.float32)

        for channel_idx, color in zip(channel_indices, colors):
            # color is a 3-tuple of uint8 values
            channel = img_np[..., channel_idx].astype(np.float32)          # (H, W)
            color_arr = np.array(color, dtype=np.float32) / 255.0          # (3,)
            combined_img += channel[..., np.newaxis] * color_arr           # broadcast (H,W,3)

        return np.clip(combined_img, 0, 255).astype(np.uint8)

    except Exception as e:
        print(f"Error in process_tile_with_colors: {str(e)}")
        traceback.print_exc()
        raise

def load_script() -> None:
    """Load dynamic script"""
    global script_globals, script_locals
    script_locals.clear()
    current_directory = os.path.dirname(os.path.abspath(__file__))
    script_path = os.path.join(current_directory, 'scripts', 'dynamic_scripts.py')
    if os.path.exists(script_path):
        with open(script_path, 'r') as script_file:
            script_content = script_file.read()
            try:
                print(f"Executing script:\n{script_content}")
                exec(script_content, script_globals, script_locals)
                print("Script executed successfully")
            except Exception as e:
                print(f"Error executing script: {str(e)}")
                raise
    else:
        # print(f"Script file {script_path} does not exist")
        pass

def update_script(script_content: str) -> Dict:
    """Update dynamic script"""
    try:
        # Get the directory where this script is located
        current_directory = os.path.dirname(os.path.abspath(__file__))
        scripts_dir = os.path.join(current_directory, 'scripts')
        
        # Create the scripts directory if it doesn't exist
        os.makedirs(scripts_dir, exist_ok=True)
        
        # Write the script content to the file
        script_path = os.path.join(scripts_dir, 'dynamic_scripts.py')
        with open(script_path, 'w') as script_file:
            script_file.write(script_content)
        
        # Try to execute the script to see if it works
        try:
            global script_globals, script_locals
            script_locals.clear()
            exec(script_content, script_globals, script_locals)
            
            # If we got here, the script is valid
            return {
                "status": "success",
                "message": "Script updated successfully"
            }
        except Exception as e:
            # If there's an error with the script, return it
            return {
                "status": "error",
                "message": f"Error in script syntax: {str(e)}"
            }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error updating script: {str(e)}"
        }

def load_slide_from_file(filename: str) -> Dict:
    """Load slide from file (legacy version)"""
    return load_slide_from_file_with_session(filename, session_id="default")

def load_slide_from_file_with_session(filename: str, session_id: str = "default") -> Dict:
    """Load slide from file with session support"""
    # Get session data
    session_data = get_session_data(session_id)
    
    if not os.path.exists(filename):
        return {"status": "error", "message": f"File {filename} not found"}
    
    try:
        file_ext = get_file_extension(filename)
        
        # Store current file path in session
        session_data['current_file_path'] = filename
        print(f"Debug - load_slide_from_file_with_session: file_ext={file_ext}, session_id={session_id}")
        
        if file_ext in ['tif', 'tiff', 'btf', 'svs']:
            # pyvips-native path for all TIFF/SVS variants.
            # PyvipsSlideWrapper uses tifffile series[0].levels to correctly identify
            # pyramid pages, filtering out SVS associated images (thumbnail/label/macro).
            print(f"Debug - Using PyvipsSlideWrapper for {file_ext}")
            session_data['slide'] = PyvipsSlideWrapper(filename)
            session_data['current_file_format'] = file_ext
            session_data['tiff_slide_wrapper'] = True
        elif file_ext in ['qptiff']:
            try:
                session_data['slide'] = TiffSlideWrapper(filename)
                session_data['current_file_format'] = 'qptiff'
                session_data['tiff_slide_wrapper'] = False
            except Exception as e:
                print(f"Debug - TiffSlideWrapper failed for QPTIFF: {e}, falling back to PyvipsSlideWrapper")
                session_data['slide'] = PyvipsSlideWrapper(filename)
                session_data['current_file_format'] = 'qptiff'
                session_data['tiff_slide_wrapper'] = True
        elif file_ext in ['ndpi']:
            # Smart wrapper selection for NDPI files using centralized logic
            session_data['slide'], session_data['tiff_slide_wrapper'] = smart_load_ndpi_wrapper(filename)
            session_data['current_file_format'] = 'ndpi'
        elif file_ext in ['jpeg', 'jpg', 'png', 'bmp']:
            session_data['slide'] = SimpleImageWrapper(filename)
            session_data['current_file_format'] = 'image'
            session_data['tiff_slide_wrapper'] = False
        elif file_ext in ['isyntax']:
            session_data['slide'] = ISyntaxImageWrapper(filename)
            session_data['current_file_format'] = 'isyntax'
            session_data['tiff_slide_wrapper'] = False
        elif file_ext in ['czi']:
            session_data['slide'] = CziImageWrapper(filename)
            session_data['current_file_format'] = 'czi'
            session_data['tiff_slide_wrapper'] = False
        elif file_ext in ['dcm']:
            session_data['slide'] = DicomImageWrapper(filename)
            session_data['current_file_format'] = 'dcm'
            session_data['tiff_slide_wrapper'] = False
        elif file_ext in ['nii', 'nii.gz']:
            if SKIP_NII_PARSING:
                # Skip NII parsing - create a minimal wrapper for compatibility
                session_data['slide'] = None
                session_data['current_file_format'] = 'nii'
                session_data['tiff_slide_wrapper'] = False
                session_data['skip_parsing'] = True
            else:
                session_data['slide'] = NiftiImageWrapper(filename)
                session_data['current_file_format'] = 'nii'
                session_data['tiff_slide_wrapper'] = False
        else:
            return {"status": "error", "message": f"Unsupported file format: {file_ext}"}
        
        total_tiles = calculate_total_tiles(session_data['slide'])
        
        # Initialize slide_levels for the session
        session_data['slide_levels'] = get_slide_properties(session_data['slide'])
        
        # Update legacy global variables for backward compatibility
        global slide, slide_levels, current_file_format, tiff_slide_wrapper, current_file_path
        if session_id == "default":
            slide = session_data['slide']
            slide_levels = session_data['slide_levels']
            current_file_format = session_data['current_file_format']
            tiff_slide_wrapper = session_data['tiff_slide_wrapper']
            current_file_path = session_data['current_file_path']
        
        # Calculate total_channels and image_type
        total_channels = 3  # default
        try:
            if hasattr(session_data['slide'], 'properties'):
                total_channels = session_data['slide'].properties.get('channels', 3)
            elif hasattr(session_data['slide'], 'level_dimensions'):
                # Try to estimate from image data
                try:
                    probe_np = session_data['slide'].read_region((0, 0), 0, (1, 1))
                    if len(probe_np.shape) == 3 and probe_np.shape[2] > 3:
                        total_channels = probe_np.shape[2]
                except:
                    pass
            
            # Special handling for qptiff files
            if session_data['current_file_format'] == 'qptiff':
                total_channels = _estimate_qptiff_channels(session_data['current_file_path'])
        except:
            total_channels = 3

        # Determine image type based on channels and file format
        if session_data['current_file_format'] == 'qptiff' and total_channels > 3:
            image_type = 'Multiplex Immunofluorescent'
        else:
            image_type = 'Brightfield H&E'

        # Check for z-stack support
        is_zstack = False
        z_layer_count = 1
        if hasattr(session_data['slide'], 'is_zstack'):
            is_zstack = session_data['slide'].is_zstack
            if is_zstack and hasattr(session_data['slide'], 'z_layer_count'):
                z_layer_count = session_data['slide'].z_layer_count
                # Initialize z-stack info in session (use 'has_zstack' key for frontend compatibility)
                session_data['zstack_info'] = {
                    'has_zstack': True,
                    'layer_count': z_layer_count,
                    'layer_indices': list(range(z_layer_count)),
                    'current_layer': 0
                }
                session_data['current_z_layer'] = 0
                logger.info(f"[Z-Stack] Initialized {z_layer_count} layers for session {session_id}")
            else:
                # No z-stack, use default info
                session_data['zstack_info'] = {
                    'has_zstack': False,
                    'layer_count': 1,
                    'layer_indices': [0],
                    'current_layer': 0
                }
        else:
            # Slide doesn't have is_zstack attribute, use default info
            session_data['zstack_info'] = {
                'has_zstack': False,
                'layer_count': 1,
                'layer_indices': [0],
                'current_layer': 0
            }

        # Handle NII files with parsing skipped
        if session_data.get('skip_parsing', False):
            # Store dimensions and other info in session_data for later retrieval
            dimensions = (512, 512)  # Default dimensions for NII
            session_data['dimensions'] = dimensions
            session_data['level_count'] = 1
            session_data['total_tiles'] = total_tiles
            session_data['total_channels'] = total_channels
            
            return {
                "status": "success",
                "message": "Slide loaded successfully (parsing skipped)",
                "file_format": session_data['current_file_format'],
                "dimensions": dimensions,
                "level_count": 1,
                "total_tiles": total_tiles,
                "total_channels": total_channels,
                "image_type": image_type,
                "skip_parsing": True,
                "zstack_info": session_data['zstack_info']
            }
        else:
            return {
                "status": "success",
                "message": "Slide loaded successfully",
                "file_format": session_data['current_file_format'],
                "dimensions": session_data['slide'].dimensions,
                "level_count": len(session_data['slide'].level_dimensions),
                "total_tiles": total_tiles,
                "total_channels": total_channels,
                "image_type": image_type,
                "zstack_info": session_data['zstack_info']
            }
    except Exception as e:
        return {"status": "error", "message": f"Error loading slide: {str(e)}"}


def _resize_vips_tile_to_exact(img: pyvips.Image, out_w: int, out_h: int) -> pyvips.Image:
    """Scale to exact (out_w, out_h) so JPEG size matches OSD-reported tile geometry.

    Uses independent horizontal/vertical scale so read_region rounding cannot leave a
    height/width mismatch vs independently ceiled out_w/out_h (edge tiles).
    """
    if img.width == out_w and img.height == out_h:
        return img
    sx = out_w / img.width
    sy = out_h / img.height
    out = img.resize(sx, vscale=sy)
    if out.width > out_w:
        out = out.crop(0, 0, out_w, out.height)
    if out.height > out_h:
        out = out.crop(0, 0, out.width, out_h)
    if out.width < out_w or out.height < out_h:
        out = out.embed(0, 0, out_w, out_h, extend="background", background=[255, 255, 255])
    return out


def _encode_tile_vips(img: pyvips.Image, quality: int = 85) -> bytes:
    """Encode a pyvips image to JPEG bytes for tile serving."""
    if img.bands == 4:
        img = img.extract_band(0, n=3)
    elif img.bands == 1:
        img = img.colourspace("srgb")
    return img.jpegsave_buffer(Q=quality, keep="none")


def get_tile(level: int, col: int, row: int, scale_factor: float = 1.0,
             color_mode: str = None, channels: List[int] = None,
             colors: List[List[int]] = None, session_id: str = "default",
             z_layer: Optional[int] = None) -> Dict:
    """
    Get tile from slide
    """
    global slide, slide_levels, current_file_format, tiff_slide_wrapper
    
    # Get session data
    session_data = get_session_data(session_id)
    session_slide = session_data['slide']
    session_slide_levels = session_data['slide_levels']
    session_current_file_format = session_data['current_file_format']
    session_tiff_slide_wrapper = session_data['tiff_slide_wrapper']
    session_current_file_path = session_data['current_file_path']
    
    # Get z-layer: use provided value or current session z-layer
    if z_layer is None:
        z_layer = session_data.get('current_z_layer', 0)

    # Match get_cached_tile: only non-zero z layers need a distinct cache namespace
    cache_key_suffix = f"_z{z_layer}" if z_layer > 0 else ""

    logger.debug(f"[Tile] Using z-layer: {z_layer} for session {session_id}")
    
    try:
        print(f"Debug - get_tile called: level={level}, col={col}, row={row}, scale={scale_factor}, z_layer={z_layer}, session={session_id}")
        if session_slide is None:
            # Check if this is a NII file with parsing skipped
            if session_data.get('skip_parsing', False):
                return {"status": "error", "message": "NII file parsing is skipped - use direct loading instead"}
            return {"status": "error", "message": f"No slide is loaded for session {session_id}"}

        # Check cache first
        from app.services.tile_cache_service import get_tile_cache
        tile_cache = get_tile_cache()
        
        if session_current_file_path:
            cached_tile = tile_cache.get_cached_tile(
                session_current_file_path + cache_key_suffix, level, col, row, 
                scale_factor, color_mode, channels, colors
            )
            if cached_tile:
                print(f"Debug - Cache hit for tile: level={level}, col={col}, row={row}, z_layer={z_layer}")
                return {
                    "status": "success",
                    "image_data": cached_tile,
                    "format": "JPEG",
                    "width": TILE_SIZE,
                    "height": TILE_SIZE
                }

        # basic parameters
        size = TILE_SIZE
        dzi_level = int(level)
        file_format = session_current_file_format

        # PathView-style tile coordinate computation (matches frontend maxLevel; clamp >= 0 for OSD)
        W, H = session_slide.level_dimensions[0]
        max_dzi_level = max(0, math.ceil(math.log2(max(W, H) / size)))
        tile_span = size * (2 ** (max_dzi_level - dzi_level))

        x1 = int(col) * tile_span
        y1 = int(row) * tile_span

        # Clamp to image bounds
        x1 = min(x1, W)
        y1 = min(y1, H)
        w = min(tile_span, W - x1)
        h = min(tile_span, H - y1)

        # Output tile dimensions: proportional to coverage (edge tiles are smaller).
        # Use ceil to match OSD's own edge-tile size computation: ceil(image_dim / scale).
        out_w = max(1, math.ceil(w * size / tile_span))
        out_h = max(1, math.ceil(h * size / tile_span))

        if w <= 0 or h <= 0:
            buf = BytesIO()
            Image.new('RGB', (size, size), (255, 255, 255)).save(buf, format="JPEG", quality=85)
            return {"status": "success", "image_data": buf.getvalue(), "format": "JPEG", "width": size, "height": size}

        # Find best SVS pyramid level for the requested downsample
        target_downsample = max(1.0, tile_span / size)
        if hasattr(session_slide, 'get_best_level_for_downsample'):
            svs_level = session_slide.get_best_level_for_downsample(target_downsample)
        else:
            svs_level = 0
            for lvl in range(len(session_slide.level_dimensions)):
                lvl_ds = session_slide.level_dimensions[0][0] / session_slide.level_dimensions[lvl][0]
                if lvl_ds <= target_downsample:
                    svs_level = lvl
        svs_level = max(0, svs_level)

        x2, y2 = x1 + w, y1 + h

        # Compute read size in svs_level pixel coordinates
        # read_region(location, level, size) expects size at the given level, not at level-0
        actual_svs_downsample = session_slide.level_dimensions[0][0] / session_slide.level_dimensions[svs_level][0]
        read_w = max(1, int(round(w / actual_svs_downsample)))
        read_h = max(1, int(round(h / actual_svs_downsample)))

        print(f'Debug - Reading region: ({x1}, {y1}), read=({read_w}, {read_h}) at svs_level={svs_level} (ds={actual_svs_downsample:.1f}), tile_span={tile_span}')

        # --- Fast path: pure pyvips pipeline (no PIL/numpy) ---
        if isinstance(session_slide, PyvipsSlideWrapper):
            sx = int(x1 / actual_svs_downsample)
            sy = int(y1 / actual_svs_downsample)
            region = session_slide.read_region_vips(svs_level, sx, sy, read_w, read_h)

            if region.width > 0 and (region.width != out_w or region.height != out_h):
                region = _resize_vips_tile_to_exact(region, out_w, out_h)

            vips_quality = 75 if session_current_file_format == 'btf' else 85
            jpeg_data = _encode_tile_vips(region, vips_quality)

            if session_current_file_path:
                tile_cache.cache_tile(
                    session_current_file_path + cache_key_suffix, level, col, row,
                    scale_factor, color_mode, channels, colors, jpeg_data
                )
            return {
                "status": "success",
                "image_data": jpeg_data,
                "format": "JPEG",
                "width": out_w,
                "height": out_h,
            }

        # Read the region - optimize for BTF files
        img = None
        if session_tiff_slide_wrapper:
            # For files using TiffFileWrapper (BTF, some TIF, NDPI), always use as_array
            # Check if read_region supports z_layer parameter
            try:
                import inspect
                sig = inspect.signature(session_slide.read_region)
                supports_z_layer = 'z_layer' in sig.parameters

                if supports_z_layer:
                    img_np = session_slide.read_region((x1, y1), svs_level, (read_w, read_h), as_array=True, z_layer=z_layer)
                else:
                    logger.warning(f"[Z-Stack] TiffFileWrapper does not support z_layer parameter, using default layer")
                    img_np = session_slide.read_region((x1, y1), svs_level, (read_w, read_h), as_array=True)
                    
                total_channels = img_np.shape[2] if len(img_np.shape) > 2 else 1
                
                # Convert to PIL Image
                if total_channels >= 3:
                    img = Image.fromarray(img_np[..., :3])
                elif total_channels == 1:
                    img = Image.fromarray(img_np[..., 0], mode='L').convert('RGB')
                else:
                    padded = np.zeros((img_np.shape[0], img_np.shape[1], 3), dtype=np.uint8)
                    padded[..., :total_channels] = img_np
                    img = Image.fromarray(padded)
                    
            except Exception as e:
                print(f"Debug - Error reading region: {str(e)}")
                traceback.print_exc()
                raise
        else:
            # Original code for non-wrapper files (TiffSlideWrapper)
            # Check if read_region supports z_layer parameter
            try:
                import inspect
                sig = inspect.signature(session_slide.read_region)
                supports_z_layer = 'z_layer' in sig.parameters
                
                if supports_z_layer:
                    img = session_slide.read_region((x1, y1), svs_level, (read_w, read_h), z_layer=z_layer)
                else:
                    logger.warning(f"[Z-Stack] TiffSlideWrapper does not support z_layer parameter, using default layer")
                    img = session_slide.read_region((x1, y1), svs_level, (read_w, read_h))
            except Exception as e:
                print(f"Debug - Error with read_region, trying as_array: {str(e)}")
                try:
                    import inspect
                    sig = inspect.signature(session_slide.read_region)
                    supports_z_layer = 'z_layer' in sig.parameters

                    if supports_z_layer:
                        img_np = session_slide.read_region((x1, y1), svs_level, (read_w, read_h), as_array=True, z_layer=z_layer)
                    else:
                        img_np = session_slide.read_region((x1, y1), svs_level, (read_w, read_h), as_array=True)
                except Exception as e2:
                    # Fallback without z_layer if it causes issues
                    print(f"Debug - Error with z_layer, trying without: {str(e2)}")
                    img_np = session_slide.read_region((x1, y1), svs_level, (read_w, read_h), as_array=True)
                total_channels = img_np.shape[2] if len(img_np.shape) > 2 else 1
                print(f"Debug - Total available channels: {total_channels}")
                print(f"Debug - Array dtype: {img_np.dtype}, shape: {img_np.shape}")
                
                # Handle different data types
                if img_np.dtype == np.uint16:
                    # Convert 16-bit to 8-bit by scaling
                    print("Debug - Converting 16-bit to 8-bit")
                    img_np = (img_np / 256).astype(np.uint8)
                elif img_np.dtype != np.uint8:
                    # Handle other non-8-bit types
                    print(f"Debug - Converting {img_np.dtype} to 8-bit")
                    img_np = ((img_np - img_np.min()) / (img_np.max() - img_np.min()) * 255).astype(np.uint8)
                
                # Handle different file formats
                if file_format == 'qptiff':
                    visible_channels = channels
                    channel_colors = colors
                    print(f"Received channels request: {visible_channels} with colors: {channel_colors}")

                    if visible_channels:
                        visible_channels = [int(c) for c in visible_channels]
                        colors = [tuple(int(color[i:i+2], 16) for i in (0, 2, 4)) for color in channel_colors]

                        # hash
                        img_np_bytes = img_np.tobytes()
                        img_shape = img_np.shape

                        # use cache
                        combined_img = process_tile_with_colors(
                            img_np_bytes,
                            img_shape,
                            tuple(visible_channels),
                            tuple(tuple(c) for c in colors)
                        )
                        img = Image.fromarray(combined_img)
                    else:
                        print(f"No channels specified, using default first 3 channels: [0,1,2]")
                        img = Image.fromarray(img_np[..., :3])
                else:
                    print(f"Non-qptiff format: {file_format}")
                    # For regular images, use all available channels or convert to RGB
                    if total_channels >= 3:
                        # Use first 3 channels for RGB
                        img = Image.fromarray(img_np[..., :3])
                    elif total_channels == 1:
                        # Convert grayscale to RGB
                        img = Image.fromarray(img_np[..., 0])
                        img = img.convert('RGB')
                    else:
                        # Handle 2 channels by padding with zeros
                        padded = np.zeros((img_np.shape[0], img_np.shape[1], 3), dtype=np.uint8)
                        padded[..., :total_channels] = img_np
                        img = Image.fromarray(padded)
        
        # Exact (out_w, out_h) before pyvips encode so JPEG dimensions match OSD placement
        resize_start = time.time()
        if img.size != (out_w, out_h):
            img = img.resize((out_w, out_h), Image.Resampling.LANCZOS)
        img_np_out = np.array(img.convert('RGB'))
        bands = img_np_out.shape[2] if img_np_out.ndim == 3 else 1
        vips_img = pyvips.Image.new_from_memory(
            img_np_out.tobytes(), img_np_out.shape[1], img_np_out.shape[0], bands, "uchar"
        )
        print(f"Debug - Resize to ({out_w},{out_h}) took {time.time() - resize_start:.2f}s")

        is_btf_file = (session_current_file_format == 'btf')
        quality = 75 if is_btf_file else 85
        jpeg_data = _encode_tile_vips(vips_img, quality)
        
        # Cache the tile if file path is available
        if session_current_file_path:
            tile_cache.cache_tile(
                session_current_file_path + cache_key_suffix, level, col, row,
                scale_factor, color_mode, channels, colors, jpeg_data
            )
            print(f"Debug - Cached tile: level={level}, col={col}, row={row}")
        
        return {
            "status": "success",
            "image_data": jpeg_data,
            "format": "JPEG",
            "width": out_w,
            "height": out_h
        }
    except Exception as e:
        print(f"Debug - get_tile exception: {str(e)}")
        traceback.print_exc()
        
        # create a debug tile
        try:
            tile = generate_debug_tile(TILE_SIZE, TILE_SIZE, level, col, row, str(e))
            img = Image.fromarray(tile)
            buffer = BytesIO()
            img.save(buffer, format="JPEG", quality=70)
            return {"status": "success", "image_data": buffer.getvalue(), "format": "JPEG", 
                   "width": TILE_SIZE, "height": TILE_SIZE}
        except:
            return {"status": "error", "message": f"Error processing tile: {str(e)}"}

def upload_file_path(file_path: str, session_id: str = "default") -> Dict:
    """Upload file from file path"""
    global slide, slide_levels, current_file_format, tiff_slide_wrapper, current_file_path
    
    # Get session data
    session_data = get_session_data(session_id)
    
    print(f"Debug - upload_file_path called with: {file_path}")
    
    file_path = resolve_path(file_path)
    
    # check for potential escape characters in the path and handle them
    if '\\\\' in file_path:
        print(f"Debug - Double backslashes found in path, normalizing")
        file_path = file_path.replace('\\\\', '\\')
    
    if not os.path.exists(file_path):
        corrected_path = None
        # try to fix common path problems
        if '\\' in file_path:
            possible_path = file_path.replace('\\', '/')
            if os.path.exists(possible_path):
                corrected_path = possible_path
                print(f"Debug - Corrected path found: {corrected_path}")
        
        if not corrected_path:
            print(f"Debug - File not found at path: {file_path}")
            print(f"Debug - Working directory: {os.getcwd()}")
            print(f"Debug - Checking if path is relative...")
            
            # try the path relative to the current directory
            current_dir = os.getcwd()
            possible_path = os.path.join(current_dir, file_path)
            if os.path.exists(possible_path):
                corrected_path = possible_path
                print(f"Debug - Found file at: {corrected_path}")
        
        if corrected_path:
            file_path = corrected_path
        else:
            return {"status": "error", "message": f"File not found: {file_path}"}
    
    if not allowed_file(file_path):
        print(f"Debug - File format not supported: {file_path}")
        return {"status": "error", "message": "File format not supported"}
    
    try:
        # set current_file_format (similar to Django version)
        file_name = os.path.basename(file_path)
        session_data['current_file_format'] = get_file_extension(file_name)
        print(f"Debug - Current file format: {session_data['current_file_format']}")
        
        # Handle simple image formats
        if session_data['current_file_format'] in ['jpg', 'jpeg', 'png', 'bmp']:
            session_data['slide'] = SimpleImageWrapper(file_path)
            total_channels = 3  # RGB images always have 3 channels
            session_data['tiff_slide_wrapper'] = False
        elif session_data['current_file_format'] in ['dcm']:
            session_data['slide'] = DicomImageWrapper(file_path)
            total_channels = 3  # RGB images always have 3 channels
            session_data['tiff_slide_wrapper'] = False
        elif session_data['current_file_format'] in ['czi']:
            session_data['slide'] = CziImageWrapper(file_path)
            total_channels = 3  # RGB images always have 3 channels
            session_data['tiff_slide_wrapper'] = False
        elif session_data['current_file_format'] in ['isyntax']:
            # Note: Only for info use (dimensions, level info).
            # Tile serving for ISyntax is handled in api/load.py via ISyntax.open()
            session_data['slide'] = ISyntaxImageWrapper(file_path)
            total_channels = 3  # RGB images always have 3 channels
            session_data['tiff_slide_wrapper'] = False
        elif session_data['current_file_format'] in ['nii', 'nii.gz']:
            if SKIP_NII_PARSING:
                # Skip NII parsing - create a minimal wrapper for compatibility
                session_data['slide'] = None
                total_channels = 3  # convert nii to rgb
                session_data['tiff_slide_wrapper'] = False
                session_data['skip_parsing'] = True
            else:
                session_data['slide'] = NiftiImageWrapper(file_path)
                total_channels = 3  # convert nii to rgb
                session_data['tiff_slide_wrapper'] = False
        elif session_data['current_file_format'] in ['ndpi']:
            # Smart wrapper selection for NDPI files using centralized logic
            session_data['slide'], session_data['tiff_slide_wrapper'] = smart_load_ndpi_wrapper(file_path)
            
            # Get total channels
            try:
                img_np = session_data['slide'].read_region((0, 0), 0, (1, 1), as_array=True)
                total_channels = img_np.shape[-1] if len(img_np.shape) > 2 else 3
            except:
                total_channels = 3
        elif session_data['current_file_format'] in ['tif', 'tiff', 'btf', 'svs']:
            # pyvips-native path for all TIFF/SVS/BTF variants
            print(f"Debug - Using PyvipsSlideWrapper for {session_data['current_file_format']}")
            session_data['slide'] = PyvipsSlideWrapper(file_path)
            total_channels = int(session_data['slide'].properties.get('channels', 3))
            session_data['tiff_slide_wrapper'] = True
            print(f"Debug - PyvipsSlideWrapper loaded, channels: {total_channels}")
        else:
            print(f"Debug - Unknown format falling through: {session_data['current_file_format']}")
            session_data['slide'] = PyvipsSlideWrapper(file_path)
            total_channels = int(session_data['slide'].properties.get('channels', 3))
            session_data['tiff_slide_wrapper'] = True

        if session_data['current_file_format'] == 'qptiff' and total_channels <= 3:
            try:
                extra_channels = _estimate_qptiff_channels(file_path)
                if extra_channels and extra_channels > total_channels:
                    total_channels = extra_channels
            except Exception:
                pass
        
        # calculate the total number of tiles
        total_tiles = calculate_total_tiles(session_data['slide'])
        
        # initialize slide_levels (similar to Django version)
        print(f"Debug - Initializing slide_levels")
        session_data['slide_levels'] = get_slide_properties(session_data['slide'])
        print(f"Debug - Got slide_levels keys: {list(session_data['slide_levels'].keys() if session_data['slide_levels'] else {})}")
        
        # Get additional slide properties with safe fallbacks
        if session_data.get('skip_parsing', False):
            slide_properties = {}  # Empty properties for NII with parsing skipped
        else:
            slide_properties = session_data['slide'].properties
        print(f"All slide properties: {slide_properties}")

        # MPP
        try:
            if session_data['current_file_format'] == 'nii':
                if session_data.get('skip_parsing', False):
                    mpp = None  # No MPP for skipped NII parsing
                else:
                    print(f"Debug - NiftiImageWrapper: {session_data['slide'].zooms}")
                    try:
                        mpp = float(session_data['slide'].zooms[0])
                    except:
                        mpp = None
            else:
                # TiffSlide (compatible properties)
                mpp_x = float(slide_properties.get('openslide.mpp-x', 0))
                mpp_y = float(slide_properties.get('openslide.mpp-y', 0))

                # Tiffslide
                if mpp_x == 0 and mpp_y == 0:
                    for key in [
                        'tiffslide.mpp-x', 'tiffslide.mpp-y',  # Tiffslide
                        'aperio.MPP', 'hamamatsu.mpp',
                        'philips.DICOM_PIXEL_SPACING',
                        'leica.MPP',
                        'DICOM.PixelSpacing'
                    ]:
                        if key in slide_properties:
                            mpp_value = float(slide_properties[key])
                            if mpp_value > 0:
                                mpp_x = mpp_y = mpp_value
                                break
                #calculate mpp from resolution
                if mpp_x == 0 and mpp_y == 0:
                    resolution_unit = slide_properties.get('tiff.ResolutionUnit', '')
                    x_resolution = float(slide_properties.get('tiff.XResolution', 0))
                    if x_resolution > 0:
                        if resolution_unit == 'CENTIMETER':
                            mpp_x = mpp_y = (10000 / x_resolution)
                        elif resolution_unit == 'INCH':
                            mpp_x = mpp_y = (25400 / x_resolution)

                mpp = mpp_x if mpp_x > 0 else mpp_y
                # If mpp is still 0, it means it wasn't found - set to None
                if mpp == 0:
                    mpp = None

        except (ValueError, TypeError):
            mpp = None

        try:
            magnification = None
            mag_properties = [
                'openslide.objective-power',
                'tiffslide.objective-power',
                'aperio.AppMag',
                'hamamatsu.SourceLens',
                'philips.DICOM_MAGNIFICATION',
                'leica.Objective',
                'DICOM.OpticalMagnification',
                'codex.magnification',
                'tiff.Magnification'
            ]

            for prop in mag_properties:
                if prop in slide_properties:
                    mag_value = slide_properties[prop]
                    try:
                        magnification = float(mag_value)
                        if magnification > 0:
                            break
                    except (ValueError, TypeError):
                        continue

            if not magnification and mpp:
                print(f"fail to get magnification, use mpp to estimate: {mpp}")
                estimated_mag = 10 / mpp
                magnification = round(estimated_mag, 1)
            else:
                print(f"magnification from slide properties: {magnification}")

        except (ValueError, TypeError):
            magnification = None

        # Handle NII files with parsing skipped
        if session_data.get('skip_parsing', False):
            dimensions = (512, 512)  # Default dimensions for NII
            slide_properties = {}  # Empty properties for NII
        else:
            dimensions = session_data['slide'].dimensions
            slide_properties = session_data['slide'].properties

        # Get file size in MB with 2 decimal places
        file_size = round(os.path.getsize(file_path) / (1024 * 1024), 2)

        # Determine image type based on channels and file format
        if session_data['current_file_format'] in ['qptiff'] and total_channels > 3:
            image_type = 'Multiplex Immunofluorescent'
        else:
            image_type = 'Brightfield H&E'

        # Read z-stack info from slide object (avoid redundant file reading)
        is_zstack = False
        z_layer_count = 1
        if hasattr(session_data['slide'], 'is_zstack'):
            is_zstack = session_data['slide'].is_zstack
            if is_zstack and hasattr(session_data['slide'], 'z_layer_count'):
                z_layer_count = session_data['slide'].z_layer_count
                session_data['zstack_info'] = {
                    'has_zstack': True,
                    'layer_count': z_layer_count,
                    'layer_indices': list(range(z_layer_count)),
                    'current_layer': 0
                }
                session_data['current_z_layer'] = 0
                logger.info(f"[Z-Stack] Initialized {z_layer_count} layers for file: {file_path}")
            else:
                session_data['zstack_info'] = {
                    'has_zstack': False,
                    'layer_count': 1,
                    'layer_indices': [0],
                    'current_layer': 0
                }
        else:
            session_data['zstack_info'] = {
                'has_zstack': False,
                'layer_count': 1,
                'layer_indices': [0],
                'current_layer': 0
            }
        zstack_info = session_data['zstack_info']

        # build the response
        result = {
            "status": "success",
            "message": "Slide loaded successfully",
            'filename': file_name,
            'dimensions': dimensions,
            'level_count': len(session_data['slide'].level_dimensions if hasattr(session_data['slide'], 'level_dimensions') else []),
            'pyramid_info': session_data['slide_levels'].get('pyramid_info', []),
            'total_channels': total_channels,
            'mpp': mpp,
            'magnification': magnification,
            'file_size': file_size,
            'file_format': session_data['current_file_format'],
            'properties': slide_properties,
            'total_tiles': calculate_total_tiles(session_data['slide']),
            'image_type': image_type,
            'zstack_info': zstack_info
        }
        
        session_data['current_file_path'] = file_path
        
        # Update global variables for backward compatibility
        global slide, slide_levels, current_file_format, current_file_path, tiff_slide_wrapper
        slide = session_data['slide']
        slide_levels = session_data['slide_levels']
        current_file_format = session_data['current_file_format']
        current_file_path = session_data['current_file_path']
        tiff_slide_wrapper = session_data['tiff_slide_wrapper']
        
        return result
    except Exception as e:
        print(f"Debug - Error loading slide: {str(e)}")
        traceback.print_exc()
        return {"status": "error", "message": f"Error loading slide: {str(e)}"}

def generate_debug_tile(width: int, height: int, level: int, col: int, row: int, error_message: str = None) -> np.ndarray:
    """Generate a debug tile with grid and debug information"""
    # create a tile with a white background
    tile = np.ones((height, width, 3), dtype=np.uint8) * 240
    
    # add grid lines
    for i in range(0, height, 32):
        tile[i:i+1, :, :] = [200, 200, 200]
    for i in range(0, width, 32):
        tile[:, i:i+1, :] = [200, 200, 200]
    
    # draw the border
    border_width = 2
    tile[0:border_width, :, :] = [100, 100, 100]
    tile[-border_width:, :, :] = [100, 100, 100]
    tile[:, 0:border_width, :] = [100, 100, 100]
    tile[:, -border_width:, :] = [100, 100, 100]
    
    # add color blocks in the center of the tile
    center_w, center_h = width // 3, height // 3
    start_x, start_y = width // 3, height // 3
    
    # red block
    tile[start_y:start_y+center_h//2, start_x:start_x+center_w//2, 0] = 200
    tile[start_y:start_y+center_h//2, start_x:start_x+center_w//2, 1:3] = 50
    
    # green block
    tile[start_y:start_y+center_h//2, start_x+center_w//2:start_x+center_w, 1] = 200
    tile[start_y:start_y+center_h//2, start_x+center_w//2:start_x+center_w, [0,2]] = 50
    
    # blue block
    tile[start_y+center_h//2:start_y+center_h, start_x:start_x+center_w//2, 2] = 200
    tile[start_y+center_h//2:start_y+center_h, start_x:start_x+center_w//2, 0:2] = 50
    
    # yellow block
    tile[start_y+center_h//2:start_y+center_h, start_x+center_w//2:start_x+center_w, 0:2] = 200
    tile[start_y+center_h//2:start_y+center_h, start_x+center_w//2:start_x+center_w, 2] = 50
    
    # try to add text using PIL
    try:
        img = Image.fromarray(tile)
        draw = ImageDraw.Draw(img)
        
        # add debug information
        text_color = (0, 0, 0)
        info_text = f"Level: {level}, Col: {col}, Row: {row}"
        draw.text((10, 10), info_text, fill=text_color)
        
        if error_message:
            error_text = f"Error: {error_message[:40]}..."
            draw.text((10, 30), error_text, fill=(200, 30, 30))
        
        # convert back to numpy array
        tile = np.array(img)
    except Exception as e:
        print(f"Debug - Error adding text to debug tile: {str(e)}")
    
    return tile

# Thumbnail Service
def _resize_image_if_needed(img, max_size):
    """
    Helper method to resize image if it exceeds max_size
    """
    if img.mode != 'RGB':
        img = img.convert('RGB')
    
    original_width, original_height = img.size
    scale = min(max_size / original_width, max_size / original_height)
    
    if scale < 1:
        target_width = int(original_width * scale)
        target_height = int(original_height * scale)
        img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
    
    return img

def _image_to_base64(img, quality=85):
    """
    Helper method to convert PIL Image to base64 string
    """
    buffer = BytesIO()
    img.save(buffer, format='JPEG', quality=quality)
    return f"data:image/jpeg;base64,{base64.b64encode(buffer.getvalue()).decode()}"

def _image_to_bytes(img, quality=85):
    """
    Helper method to convert PIL Image to bytes
    """
    buffer = BytesIO()
    img.save(buffer, format='JPEG', quality=quality)
    return buffer.getvalue()

def get_slide_thumbnail(slide_obj, size=200):
    """
    Generate thumbnail image from slide
    """
    try:
        thumbnail_level = len(slide_obj.level_dimensions) - 1
        level_width, level_height = slide_obj.level_dimensions[thumbnail_level]
        
        # Check if the level is valid
        if level_width == 0 or level_height == 0:
            return None
            
        scale = min(size / level_width, size / level_height)
        target_width = int(level_width * scale)
        target_height = int(level_height * scale)
        
        thumbnail_img = slide_obj.read_region((0, 0), thumbnail_level, (level_width, level_height))
        if thumbnail_img.mode != 'RGB':
            thumbnail_img = thumbnail_img.convert('RGB')
        thumbnail_img = thumbnail_img.resize((target_width, target_height), Image.Resampling.LANCZOS)
        
        return thumbnail_img
    except Exception as e:
        print(f"Could not generate thumbnail: {str(e)}")
        return None

def get_slide_macro(slide_obj, size=200):
    """
    Get macro/overview image from slide
    """
    try:
        macro_img = None
        if hasattr(slide_obj, 'associated_images') and 'macro' in slide_obj.associated_images:
            macro_img = slide_obj.associated_images['macro']
        elif hasattr(slide_obj, 'associated_images') and 'overview' in slide_obj.associated_images:
            macro_img = slide_obj.associated_images['overview']
        else:
            # use lower resolution level as macro image
            macro_level = min(len(slide_obj.level_dimensions) - 1, 2)
            level_width, level_height = slide_obj.level_dimensions[macro_level]
            macro_img = slide_obj.read_region((0, 0), macro_level, (level_width, level_height))
        
        if macro_img:
            return _resize_image_if_needed(macro_img, size)
        return None
    except Exception as e:
        print(f"Could not get macro image: {str(e)}")
        return None

def get_slide_label(slide_obj, size=200):
    """
    Get label image from slide
    """
    try:
        if hasattr(slide_obj, 'associated_images') and 'label' in slide_obj.associated_images:
            label_img = slide_obj.associated_images['label']
            return _resize_image_if_needed(label_img, size)
        return None
    except Exception as e:
        print(f"Could not get label image: {str(e)}")
        return None

def get_slide_preview_data(slide_obj, file_path, size=200):
    """
    Get all preview images data (thumbnail, macro, label) as base64 strings
    """
    result = {
        "thumbnail": None,
        "macro": None, 
        "label": None,
        "filename": os.path.basename(file_path) if file_path else "",
        "available": []
    }
    
    # Generate thumbnail
    thumbnail_img = get_slide_thumbnail(slide_obj, size)
    if thumbnail_img:
        result["thumbnail"] = _image_to_base64(thumbnail_img)
        result["available"].append("thumbnail")
    
    # Get macro image
    macro_img = get_slide_macro(slide_obj, size)
    if macro_img:
        result["macro"] = _image_to_base64(macro_img)
        result["available"].append("macro")
    
    # Get label image
    label_img = get_slide_label(slide_obj, size)
    if label_img:
        result["label"] = _image_to_base64(label_img)
        result["available"].append("label")
    
    return result

def get_slide_preview_image(slide_obj, preview_type, size=200):
    """
    Get specific preview image as bytes
    """
    try:
        img = None
        
        if preview_type == "thumbnail":
            img = get_slide_thumbnail(slide_obj, size)
        elif preview_type == "macro":
            img = get_slide_macro(slide_obj, size)
        elif preview_type == "label":
            img = get_slide_label(slide_obj, size)
        
        if img is None:
            return None, f"{preview_type} image not available"
        
        return _image_to_bytes(img), None
        
    except Exception as e:
        return None, f"Error getting {preview_type} image: {str(e)}"

def convert_to_pyramidal_tiff(input_path: str, output_path: str) -> dict:
    """Converts a TIFF image to a pyramidal TIFF using pyvips."""
    if not os.path.exists(input_path):
        return {"status": "error", "message": f"Input file not found: {input_path}"}

    output_dir = os.path.dirname(output_path)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir)

    try:
        print(f"Converting {input_path} to pyramidal TIFF at {output_path} using pyvips.")
        image = pyvips.Image.new_from_file(input_path, access="sequential")
        image.tiffsave(
            output_path,
            pyramid=True,
            tile=True,
            compression="jpeg",
            tile_width=256,
            tile_height=256
        )
        print(f"Successfully converted {input_path} to {output_path}")
        return {
            "status": "success",
            "message": f"Successfully converted {input_path} to {output_path}",
            "output_path": output_path
        }
    except pyvips.Error as e:
        error_message = f"pyvips error: {e.message}"
        print(f"[ERROR] {error_message}")
        traceback.print_exc()
        return {"status": "error", "message": error_message}
    except Exception as e:
        error_msg = f"An unexpected error occurred: {e}"
        print(f"[ERROR] {error_msg}")
        traceback.print_exc()
        return {"status": "error", "message": error_msg}

def _estimate_qptiff_channels(path: str) -> int:
    if _tifffile is None:
        return 3
    unique_names = set()
    try:
        with _tifffile.TiffFile(path) as tf:
            for pg in tf.pages[:500]:
                try:
                    desc = ''
                    if 'ImageDescription' in pg.tags:
                        desc = str(pg.tags['ImageDescription'].value)
                    elif hasattr(pg, 'description'):
                        desc = str(pg.description)
                except Exception:
                    desc = ''
                if not desc:
                    continue
                for m in re.finditer(r'(Channel(?:Name)?|Stain|Dye|Marker|Biomarker)[\s:=]+([^;\n\r\t,]+)', desc, re.IGNORECASE):
                    name = m.group(2).strip()
                    if name:
                        unique_names.add(name)
    except Exception:
        return 3
    return max(3, len(unique_names))


def get_slide_preview_by_path_service(file_path: str, preview_type: str = "all", size: int = 200, request_id: str = None) -> Dict:
    """
    Get slide preview images by file path without affecting currently loaded slide
    Exact functionality match to original API implementation
    """
    try:
        # Store original state
        original_file_path = current_file_path
        
        try:
            # Load the specified file temporarily
            result = upload_file_path(file_path)
            if result["status"] == "error":
                return {
                    "status": "error", 
                    "message": f"Failed to load file {file_path}: {result['message']}",
                    "response_type": "error"
                }
            
            # Get the slide that was just loaded 
            if slide is None:
                return {
                    "status": "error",
                    "message": f"Failed to load slide from {file_path}",
                    "response_type": "error"
                }
            
            # Get preview data 
            if preview_type == "all":
                preview_result = get_slide_preview_data(slide, file_path, size)
                # Add file path info to the result
                preview_result["source_file"] = file_path
                preview_result["filename"] = os.path.basename(file_path)
                if request_id:
                    preview_result["request_id"] = request_id
                return {
                    "status": "success",
                    "data": preview_result,
                    "response_type": "json"
                }
            else:
                image_bytes, error_msg = get_slide_preview_image(slide, preview_type, size)
                
                if image_bytes is None:
                    return {
                        "status": "error",
                        "message": error_msg,
                        "response_type": "error"
                    }
                
                result = {
                    "status": "success",
                    "image_bytes": image_bytes,
                    "file_path": file_path,
                    "response_type": "binary"
                }
                if request_id:
                    result["request_id"] = request_id
                return result
                
        finally:
            # Always try to restore original slide if it was different
            if original_file_path and original_file_path != file_path:
                try:
                    upload_file_path(original_file_path)
                except Exception as restore_error:
                    print(f"Warning: Failed to restore original slide {original_file_path}: {restore_error}")
        
    except Exception as e:
        traceback.print_exc()
        return {
            "status": "error",
            "message": f"Error getting preview for {file_path}: {str(e)}",
            "response_type": "error"
        }
