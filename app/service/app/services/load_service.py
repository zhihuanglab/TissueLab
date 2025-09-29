import os
import logging
import math
import numpy as np
from PIL import Image, ImageOps, ImageDraw
import tiffslide
from functools import lru_cache
from typing import Tuple, List, Dict, Optional
from io import BytesIO
import time
import threading
import traceback
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
import base64
import pyvips
import re
try:
    import tifffile as _tifffile
except Exception:
    _tifffile = None

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
from app.utils import resolve_path

# set logging level to WARNING
log = logging.getLogger('werkzeug')
log.setLevel(logging.WARNING)

# constants
TILE_SIZE = 1024
ALLOWED_EXTENSIONS = {'svs', 'tif', 'tiff', 'czi', 'qptiff', 'ndpi', 'jpeg', 'png', 'jpg', 'bmp', 'nii', 'btf', 'isyntax'}

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
                'last_isyntax_file_path': None
            }
        return sessions[session_id]

def clear_session(session_id: str):
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

def allowed_file(filename: str) -> bool:
    """Check if file is allowed format"""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def calculate_total_tiles(slide_obj) -> int:
    """Calculate total tiles of slide"""
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
            result.append(f"{indent}📂 {name}")
            result.append(tree_to_string(content, indent + '   '))
        else:
            result.append(f"{indent}📄 {name}")
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
        return {"error": "No slide loaded"}
    
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
    walker = 16/local_dict['greatest_downsample']
    adjust_ratios = [walker]
    for i in range(1, local_dict['max_level']):
        local_ratio = (local_dict['pyramid_info'][local_dict['max_level']-i]['downsample'] /
                             local_dict['pyramid_info'][local_dict['max_level']-i-1]['downsample'])/2
        walker *= local_ratio
        adjust_ratios.append(walker)
    adjust_ratios = adjust_ratios[::-1]
    local_dict['adjust_ratios'] = adjust_ratios
    return local_dict

@lru_cache(maxsize=2000)
def process_tile_with_colors(img_np_bytes: bytes, shape: Tuple, channel_indices: Tuple, colors: Tuple) -> np.ndarray:
    """Process tile with colors"""
    try:
        img_np = np.frombuffer(img_np_bytes, dtype=np.uint8).reshape(shape)
        height, width = img_np.shape[:2]
        combined_img = np.zeros((height, width, 3), dtype=np.float32)

        # channel prepare
        channel_data = {
            idx: img_np[..., idx]
            for idx in channel_indices
        }

        # batch process all channels
        with ThreadPoolExecutor(max_workers=4) as local_pool:
            futures = [
                local_pool.submit(
                    process_channel,
                    (channel_data[channel_idx], np.array(color), channel_idx)
                )
                for channel_idx, color in zip(channel_indices, colors)
            ]

            # wait all tasks done
            for future in as_completed(futures):
                result = future.result()
                combined_img += result

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
        file_ext = filename.rsplit('.', 1)[1].lower()
        
        # Store current file path in session
        session_data['current_file_path'] = filename
        
        if file_ext in ['tif', 'tiff', 'btf']:
            try:
                # First try tiffslide
                session_data['slide'] = TiffSlideWrapper(filename)
                session_data['current_file_format'] = 'svs'  # tiffslide format
                session_data['tiff_slide_wrapper'] = False
            except Exception as e:
                # If tiffslide fails, try our wrapper
                session_data['slide'] = TiffFileWrapper(filename)
                session_data['current_file_format'] = 'tif'
                session_data['tiff_slide_wrapper'] = True
        elif file_ext in ['svs']:
            session_data['slide'] = TiffSlideWrapper(filename)
            session_data['current_file_format'] = 'svs'
            session_data['tiff_slide_wrapper'] = False
        elif file_ext in ['qptiff']:
            session_data['slide'] = TiffSlideWrapper(filename)
            session_data['current_file_format'] = 'qptiff'
            session_data['tiff_slide_wrapper'] = False
        elif file_ext in ['ndpi']:
            session_data['slide'] = TiffSlideWrapper(filename)
            session_data['current_file_format'] = 'ndpi'
            session_data['tiff_slide_wrapper'] = False
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
        elif file_ext in ['nii']:
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

        return {
            "status": "success",
            "message": "Slide loaded successfully",
            "file_format": session_data['current_file_format'],
            "dimensions": session_data['slide'].dimensions,
            "level_count": len(session_data['slide'].level_dimensions),
            "total_tiles": total_tiles,
            "total_channels": total_channels,
            "image_type": image_type
        }
    except Exception as e:
        return {"status": "error", "message": f"Error loading slide: {str(e)}"}


def get_tile(level: int, col: int, row: int, scale_factor: float = 1.0,
             color_mode: str = None, channels: List[int] = None,
             colors: List[List[int]] = None, session_id: str = "default") -> Dict:
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
    
    try:
        print(f"Debug - get_tile called: level={level}, col={col}, row={row}, scale={scale_factor}, session={session_id}")
        if session_slide is None:
            return {"status": "error", "message": f"No slide is loaded for session {session_id}"}

        # Check cache first
        from app.services.tile_cache_service import get_tile_cache
        tile_cache = get_tile_cache()
        
        if session_current_file_path:
            cached_tile = tile_cache.get_cached_tile(
                session_current_file_path, level, col, row, 
                scale_factor, color_mode, channels, colors
            )
            if cached_tile:
                print(f"Debug - Cache hit for tile: level={level}, col={col}, row={row}")
                return {
                    "status": "success",
                    "image_data": cached_tile,
                    "format": "JPEG",
                    "width": TILE_SIZE,
                    "height": TILE_SIZE
                }

        # basic parameters
        size = TILE_SIZE
        max_svs_level = len(session_slide.level_dimensions)

        dzi_level = int(level)
        
        # file format detection
        file_format = session_current_file_format
        # Calculate the appropriate level to use
        if session_tiff_slide_wrapper:
            svs_level = int(session_slide.fit_page - dzi_level - 2*(max_svs_level-7))
        else:
            svs_level = max(0, max_svs_level-dzi_level-1)
            
        if svs_level <= 0:
            svs_level = 0
            adjust_ratio = session_slide_levels['adjust_ratios'][svs_level]
            adjust_ratio = adjust_ratio*(2**(max_svs_level-dzi_level-1))
        else:
            adjust_ratio = session_slide_levels['adjust_ratios'][svs_level]
            
        zoom_ratio = session_slide.level_dimensions[0][0] / session_slide.level_dimensions[svs_level][0]
        
        # Calculate coordinates
        x = int(col) * size * zoom_ratio * adjust_ratio
        y = int(row) * size * zoom_ratio * adjust_ratio
        x1, y1,  = x, y
        w = h = size * adjust_ratio

        svs_level = max(0,svs_level) # Ensure svs_level is not negative
        
        # Simple strategy to adjust to higher res layer: 05/20/2025, Yuxuan Liu
        # Tile with compensation should have larger size than standard tile
        # Only occurs when max_svs_level >= 8
        if max_svs_level >= 8:
            # To ensure tile is clear, keep adjusting adjusting layer size until largest level
            while w < size and svs_level > 0:
                w = w * 2
                h = h * 2
                svs_level = svs_level - 1
            if svs_level > 0:
            # If didn't pass assertion after adjusting, tile will be blurry
                assert w >= size, f"tile too small: {w}"

        # re-calc bounds
        x2, y2 = x + w, y + h

        print(f'Debug - Reading region: ({x1}, {y1}), ({int(w)}, {int(h)}), level={svs_level}')
        
        # Read the region - optimize for BTF files
        img = None
        if session_tiff_slide_wrapper:
            # For files using TiffSlideWrapper (BTF, some TIF), always use as_array
            try:
                img_np = session_slide.read_region((x1, y1), svs_level, (int(w), int(h)), as_array=True)         
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
            # Original code for non-wrapper files
            try:
                img = session_slide.read_region((x1, y1), svs_level, (int(w), int(h)))
            except Exception as e:
                print(f"Debug - Error with read_region, trying as_array: {str(e)}")
                img_np = session_slide.read_region((x1, y1), svs_level, (int(w), int(h)), as_array=True)
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
        
        # Resize to standard tile size
        resize_start = time.time()
        img = img.resize((size, size), Image.Resampling.LANCZOS)
        print(f"Debug - Resize took {time.time() - resize_start:.2f}s")
        
        # Skip post-processing for BTF files to save time
        is_btf_file = (session_current_file_format == 'btf')

        if not is_btf_file: # Apply if NOT BTF
            # Apply post-processing
            from app.utils.tile_post_process import PostProcess
            post_processor = PostProcess(img, svs_level, x1, y1, x2, y2, None)
            post_processor.run()
            img = post_processor.img
        
        # Skip dynamic script processing for BTF files
        if not is_btf_file: # Apply if NOT BTF
            # Apply dynamic script processing if available
            try:
                load_script()
                if 'process_tile' in script_locals:
                    img = script_locals['process_tile'](img)
            except Exception as e:
                print(f"Debug - Error in process_tile script: {str(e)}")
        
        # Convert to JPEG for response - use quality=75 for BTF files for faster encoding
        buffer = BytesIO()
        quality = 75 if is_btf_file else 85
        img.convert('RGB').save(buffer, format="JPEG", quality=quality, optimize=False)
        jpeg_data = buffer.getvalue()
        
        # Cache the tile if file path is available
        if session_current_file_path:
            tile_cache.cache_tile(
                session_current_file_path, level, col, row,
                scale_factor, color_mode, channels, colors, jpeg_data
            )
            print(f"Debug - Cached tile: level={level}, col={col}, row={row}")
        
        return {
            "status": "success",
            "image_data": jpeg_data,
            "format": "JPEG",
            "width": size,
            "height": size
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
        session_data['current_file_format'] = file_name.rsplit('.', 1)[1].lower()
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
            # Note: Only for info use below
            # ISyntaxImageWrapper is not supported for multi-threading (not thread safe)
            # Server will crash in using thread pool executor
            # Error message: access violation or segmentation fault
            # This slide obj can not import in other files (e.g. get_tile)
            # get_tile function for ISyntax is implemented in load.py
            # Please use with caution
            session_data['slide'] = ISyntaxImageWrapper(file_path)
            total_channels = 3  # RGB images always have 3 channels
            session_data['tiff_slide_wrapper'] = False
        elif session_data['current_file_format'] in ['nii']:
            session_data['slide'] = NiftiImageWrapper(file_path)
            total_channels = 3  # convert nii to rgb
            session_data['tiff_slide_wrapper'] = False
        elif session_data['current_file_format'] in ['ndpi']:
            session_data['slide'] = TiffFileWrapper(file_path)
            total_channels = int(session_data['slide'].properties.get('channels', 3))
            session_data['tiff_slide_wrapper'] = True
        elif session_data['current_file_format'] in ['btf']:
            # Handle BTF files explicitly to ensure they use the right loader
            print(f"Debug - Loading BTF file: {file_path}")
            try:
                # Try tiffslide first for BTF
                session_data['slide'] = TiffSlideWrapper(file_path)
                img_np = session_data['slide'].read_region((0, 0), 0, (1, 1), as_array=True)
                total_channels = img_np.shape[2] if len(img_np.shape) > 2 else 3
                session_data['tiff_slide_wrapper'] = False
                print(f"Debug - BTF loaded with tiffslide, channels: {total_channels}")
            except Exception as e:
                print(f"Debug - tiffslide failed for BTF, trying TiffFileWrapper: {e}")
                session_data['slide'] = TiffFileWrapper(file_path)
                total_channels = int(session_data['slide'].properties.get('channels', 3))
                session_data['tiff_slide_wrapper'] = True
                print(f"Debug - BTF loaded with TiffFileWrapper, channels: {total_channels}")
        else:
            # Original WSI handling code
            try:
                session_data['slide'] = TiffSlideWrapper(file_path)
                img_np = session_data['slide'].read_region((0, 0), 0, (1, 1), as_array=True)
                total_channels = img_np.shape[2] if len(img_np.shape) > 2 else 1
                session_data['tiff_slide_wrapper'] = False
            except Exception as e:
                session_data['slide'] = TiffFileWrapper(file_path)
                total_channels = int(session_data['slide'].properties.get('channels', 3))
                session_data['tiff_slide_wrapper'] = True
                print(f"read_region failed, use tifffile to read")

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
        slide_properties = session_data['slide'].properties
        print(f"All slide properties: {slide_properties}")

        # MPP
        try:
            if session_data['current_file_format'] == 'nii':
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

        dimensions = session_data['slide'].dimensions

        # Get file size in MB with 2 decimal places
        file_size = round(os.path.getsize(file_path) / (1024 * 1024), 2)

        # Determine image type based on channels and file format
        if session_data['current_file_format'] in ['qptiff'] and total_channels > 3:
            image_type = 'Multiplex Immunofluorescent'
        else:
            image_type = 'Brightfield H&E'

        # build the response
        result = {
            "status": "success",
            "message": "Slide loaded successfully",
            'filename': file_name,
            'dimensions': dimensions,
            'total_channels': total_channels,
            'mpp': mpp,
            'magnification': magnification,
            'file_size': file_size,
            'file_format': session_data['current_file_format'],
            'properties': slide_properties,
            'total_tiles': calculate_total_tiles(session_data['slide']),
            'image_type': image_type
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