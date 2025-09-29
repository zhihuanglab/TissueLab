import os
import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List, Optional, Tuple
from io import BytesIO
import base64
from PIL import Image
import traceback

from app.services.load_service import get_session_data
from app.services.thumbnail_cache_service import thumbnail_cache_service
from app.core import logger
THUMBNAIL_MAX_WORKERS = 4

class ThumbnailService:
    """Service for generating thumbnails with multi-session support"""
    
    def __init__(self, max_workers: int = None):
        self.max_workers = max_workers or THUMBNAIL_MAX_WORKERS
        self.executor = ThreadPoolExecutor(max_workers=self.max_workers)
        self.thumbnail_cache = {}  # Cache for generated thumbnails
        self.cache_lock = threading.Lock()
        self.session_locks = {}  # Locks for each session to prevent concurrent access to same session
        self.session_locks_lock = threading.Lock()
        self.loading_sessions = set()  # Track sessions that are currently loading files
        self.loading_lock = threading.Lock()
        
    def mark_session_loading(self, session_id: str):
        """Mark a session as loading a file"""
        with self.loading_lock:
            self.loading_sessions.add(session_id)
    
    def mark_session_loaded(self, session_id: str):
        """Mark a session as finished loading"""
        with self.loading_lock:
            self.loading_sessions.discard(session_id)
    
    def is_session_loading(self, session_id: str) -> bool:
        """Check if a session is currently loading a file"""
        with self.loading_lock:
            return session_id in self.loading_sessions
    
    def get_session_lock(self, session_id: str) -> threading.Lock:
        """Get or create a lock for a specific session"""
        with self.session_locks_lock:
            if session_id not in self.session_locks:
                self.session_locks[session_id] = threading.Lock()
            return self.session_locks[session_id]
    
    def _generate_thumbnail_for_session(self, session_id: str, size: int = 200) -> Dict:
        """Generate thumbnail for a specific session (thread-safe)"""
        # check if file is loading, if so, delay processing
        if self.is_session_loading(session_id):
            logger.info(f"Session {session_id} is currently loading, delaying thumbnail generation")
            time.sleep(0.5)  # delay 500ms
            # check again, if still loading, return error
            if self.is_session_loading(session_id):
                return {
                    "status": "error",
                    "message": f"File is still loading for session {session_id}, please try again later",
                    "thumbnail": None,
                    "macro": None,
                    "label": None,
                    "filename": "",
                    "available": []
                }
        
        session_lock = self.get_session_lock(session_id)
        
        with session_lock:
            try:
                session_data = get_session_data(session_id)
                session_slide = session_data['slide']
                session_current_file_path = session_data['current_file_path']
                
                if session_slide is None:
                    return {
                        "status": "error",
                        "message": f"No slide loaded for session {session_id}",
                        "thumbnail": None,
                        "macro": None,
                        "label": None,
                        "filename": "",
                        "available": []
                    }
                
                result = {
                    "thumbnail": None,
                    "macro": None,
                    "label": None,
                    "filename": os.path.basename(session_current_file_path) if session_current_file_path else "",
                    "available": []
                }
                
                # Check cache first for all preview types
                if session_current_file_path:
                    # Try to get cached thumbnails
                    cached_thumbnail = thumbnail_cache_service.get_cached_thumbnail_base64(
                        session_current_file_path, size, "thumbnail"
                    )
                    cached_macro = thumbnail_cache_service.get_cached_thumbnail_base64(
                        session_current_file_path, size, "macro"
                    )
                    cached_label = thumbnail_cache_service.get_cached_thumbnail_base64(
                        session_current_file_path, size, "label"
                    )
                    
                    if cached_thumbnail:
                        result["thumbnail"] = cached_thumbnail
                        result["available"].append("thumbnail")
                    if cached_macro:
                        result["macro"] = cached_macro
                        result["available"].append("macro")
                    if cached_label:
                        result["label"] = cached_label
                        result["available"].append("label")
                    
                    # If all previews are cached, return early
                    if cached_thumbnail and cached_macro and cached_label:
                        return {
                            "status": "success",
                            **result
                        }
                
                # Generate thumbnail
                if not result["thumbnail"]:  # Only generate if not cached
                    try:
                        # Special handling for CZI files - use Thumbnail attachment if available
                        if hasattr(session_slide, 'associated_images') and 'macro' in session_slide.associated_images:
                            # Use the thumbnail attachment (stored as 'macro' in CziImageWrapper)
                            thumbnail_img = session_slide.associated_images['macro']
                            if thumbnail_img.mode != 'RGB':
                                thumbnail_img = thumbnail_img.convert('RGB')
                            
                            # resize thumbnail image
                            original_width, original_height = thumbnail_img.size
                            scale = min(size / original_width, size / original_height)
                            if scale < 1:
                                target_width = int(original_width * scale)
                                target_height = int(original_height * scale)
                                thumbnail_img = thumbnail_img.resize((target_width, target_height), Image.Resampling.LANCZOS)
                            
                            buffer = BytesIO()
                            thumbnail_img.save(buffer, format='JPEG', quality=85)
                            thumbnail_base64 = f"data:image/jpeg;base64,{base64.b64encode(buffer.getvalue()).decode()}"
                            result["thumbnail"] = thumbnail_base64
                            result["available"].append("thumbnail")
                            
                            # Cache the thumbnail
                            if session_current_file_path:
                                thumbnail_cache_service.cache_thumbnail_from_base64(
                                    session_current_file_path, size, "thumbnail", thumbnail_base64
                                )
                        else:
                            # Fallback to original method for non-CZI files or when no thumbnail attachment
                            thumbnail_level = len(session_slide.level_dimensions) - 1
                            level_width, level_height = session_slide.level_dimensions[thumbnail_level]
                            
                            if level_width == 0 or level_height == 0:
                                return {
                                    "status": "error",
                                    "message": "Slide dimension is zero; cannot generate thumbnail.",
                                    **result
                                }
                            
                            scale = min(size / level_width, size / level_height)
                            target_width = int(level_width * scale)
                            target_height = int(level_height * scale)
                            
                            thumbnail_img = session_slide.read_region((0, 0), thumbnail_level, (level_width, level_height))
                            if thumbnail_img.mode != 'RGB':
                                thumbnail_img = thumbnail_img.convert('RGB')
                            thumbnail_img = thumbnail_img.resize((target_width, target_height), Image.Resampling.LANCZOS)
                            
                            buffer = BytesIO()
                            thumbnail_img.save(buffer, format='JPEG', quality=85)
                            thumbnail_base64 = f"data:image/jpeg;base64,{base64.b64encode(buffer.getvalue()).decode()}"
                            result["thumbnail"] = thumbnail_base64
                            result["available"].append("thumbnail")
                            
                            # Cache the thumbnail
                            if session_current_file_path:
                                thumbnail_cache_service.cache_thumbnail_from_base64(
                                    session_current_file_path, size, "thumbnail", thumbnail_base64
                                )
                    except Exception as e:
                        logger.error(f"Could not generate thumbnail for session {session_id}: {str(e)}")
                
                # Generate macro image
                if not result["macro"]:  # Only generate if not cached
                    try:
                        macro_img = None
                        if hasattr(session_slide, 'associated_images') and 'macro' in session_slide.associated_images:
                            macro_img = session_slide.associated_images['macro']
                        elif hasattr(session_slide, 'associated_images') and 'overview' in session_slide.associated_images:
                            macro_img = session_slide.associated_images['overview']
                        else:
                            # use lower resolution level as macro image
                            macro_level = min(len(session_slide.level_dimensions) - 1, 2)
                            level_width, level_height = session_slide.level_dimensions[macro_level]
                            macro_img = session_slide.read_region((0, 0), macro_level, (level_width, level_height))
                        
                        if macro_img:
                            if macro_img.mode != 'RGB':
                                macro_img = macro_img.convert('RGB')
                            
                            # resize macro image
                            original_width, original_height = macro_img.size
                            scale = min(size / original_width, size / original_height)
                            if scale < 1:
                                target_width = int(original_width * scale)
                                target_height = int(original_height * scale)
                                macro_img = macro_img.resize((target_width, target_height), Image.Resampling.LANCZOS)
                            
                            buffer = BytesIO()
                            macro_img.save(buffer, format='JPEG', quality=85)
                            macro_base64 = f"data:image/jpeg;base64,{base64.b64encode(buffer.getvalue()).decode()}"
                            result["macro"] = macro_base64
                            result["available"].append("macro")
                            
                            # Cache the macro image
                            if session_current_file_path:
                                thumbnail_cache_service.cache_thumbnail_from_base64(
                                    session_current_file_path, size, "macro", macro_base64
                                )
                    except Exception as e:
                        logger.error(f"Could not get macro image for session {session_id}: {str(e)}")
                
                # Generate label image
                if not result["label"]:  # Only generate if not cached
                    try:
                        if hasattr(session_slide, 'associated_images') and 'label' in session_slide.associated_images:
                            label_img = session_slide.associated_images['label']
                            
                            if label_img.mode != 'RGB':
                                label_img = label_img.convert('RGB')
                            
                            # adjust label image size
                            original_width, original_height = label_img.size
                            scale = min(size / original_width, size / original_height)
                            if scale < 1:
                                target_width = int(original_width * scale)
                                target_height = int(original_height * scale)
                                label_img = label_img.resize((target_width, target_height), Image.Resampling.LANCZOS)
                            
                            buffer = BytesIO()
                            label_img.save(buffer, format='JPEG', quality=85)
                            label_base64 = f"data:image/jpeg;base64,{base64.b64encode(buffer.getvalue()).decode()}"
                            result["label"] = label_base64
                            result["available"].append("label")
                            
                            # Cache the label image
                            if session_current_file_path:
                                thumbnail_cache_service.cache_thumbnail_from_base64(
                                    session_current_file_path, size, "label", label_base64
                                )
                    except Exception as e:
                        logger.error(f"Could not get label image for session {session_id}: {str(e)}")
                
                return {
                    "status": "success",
                    **result
                }
                
            except Exception as e:
                logger.error(f"Error generating thumbnails for session {session_id}: {str(e)}")
                traceback.print_exc()
                return {
                    "status": "error",
                    "message": f"Error generating thumbnails: {str(e)}",
                    "thumbnail": None,
                    "macro": None,
                    "label": None,
                    "filename": "",
                    "available": []
                }
    
    def _generate_specific_preview_for_session(self, session_id: str, preview_type: str, size: int = 200) -> Tuple[Optional[bytes], Optional[str]]:
        """Generate specific preview image for a session (thread-safe)"""
        session_lock = self.get_session_lock(session_id)
        
        with session_lock:
            try:
                session_data = get_session_data(session_id)
                session_slide = session_data['slide']
                session_current_file_path = session_data['current_file_path']
                
                if session_slide is None:
                    return None, f"No slide loaded for session {session_id}"
                
                # Check cache first
                if session_current_file_path:
                    cached_bytes = thumbnail_cache_service.get_cached_thumbnail(
                        session_current_file_path, size, preview_type
                    )
                    if cached_bytes:
                        return cached_bytes, None
                
                img = None
                
                if preview_type == "thumbnail":
                    # Special handling for CZI files - use Thumbnail attachment if available
                    if hasattr(session_slide, 'associated_images') and 'macro' in session_slide.associated_images:
                        # Use the thumbnail attachment (stored as 'macro' in CziImageWrapper)
                        img = session_slide.associated_images['macro']
                    else:
                        # Fallback to original method for non-CZI files or when no thumbnail attachment
                        thumbnail_level = len(session_slide.level_dimensions) - 1
                        level_width, level_height = session_slide.level_dimensions[thumbnail_level]
                        scale = min(size / level_width, size / level_height)
                        target_width = int(level_width * scale)
                        target_height = int(level_height * scale)
                        
                        img = session_slide.read_region((0, 0), thumbnail_level, (level_width, level_height))
                        if img.mode != 'RGB':
                            img = img.convert('RGB')
                        img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
                
                elif preview_type == "macro":
                    if hasattr(session_slide, 'associated_images') and 'macro' in session_slide.associated_images:
                        img = session_slide.associated_images['macro']
                    elif hasattr(session_slide, 'associated_images') and 'overview' in session_slide.associated_images:
                        img = session_slide.associated_images['overview']
                    else:
                        macro_level = min(len(session_slide.level_dimensions) - 1, 2)
                        level_width, level_height = session_slide.level_dimensions[macro_level]
                        img = session_slide.read_region((0, 0), macro_level, (level_width, level_height))
                
                elif preview_type == "label":
                    if hasattr(session_slide, 'associated_images') and 'label' in session_slide.associated_images:
                        img = session_slide.associated_images['label']
                    else:
                        return None, "Label image not available"
                
                if img is None:
                    return None, f"{preview_type} image not available"
                
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                
                original_width, original_height = img.size
                scale = min(size / original_width, size / original_height)
                if scale < 1:
                    target_width = int(original_width * scale)
                    target_height = int(original_height * scale)
                    img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
                
                buffer = BytesIO()
                img.save(buffer, format='JPEG', quality=85)
                image_bytes = buffer.getvalue()
                
                # Cache the generated preview
                if session_current_file_path:
                    thumbnail_cache_service.cache_thumbnail(
                        session_current_file_path, size, preview_type, image_bytes
                    )
                
                return image_bytes, None
                
            except Exception as e:
                logger.error(f"Error generating {preview_type} for session {session_id}: {str(e)}")
                traceback.print_exc()
                return None, f"Error getting {preview_type} image: {str(e)}"
    
    async def generate_thumbnails_for_sessions(self, session_ids: List[str], size: int = 200) -> Dict[str, Dict]:
        """Generate thumbnails for multiple sessions concurrently"""
        if not session_ids:
            return {}
        
        # Submit all thumbnail generation tasks
        futures = {}
        for session_id in session_ids:
            future = asyncio.get_event_loop().run_in_executor(
                self.executor, 
                self._generate_thumbnail_for_session, 
                session_id, 
                size
            )
            futures[future] = session_id
        
        # Collect results
        results = {}
        for future in asyncio.as_completed(futures):
            session_id = futures[future]
            try:
                result = await future
                results[session_id] = result
            except Exception as e:
                logger.error(f"Error generating thumbnail for session {session_id}: {str(e)}")
                results[session_id] = {
                    "status": "error",
                    "message": f"Error generating thumbnail: {str(e)}",
                    "thumbnail": None,
                    "macro": None,
                    "label": None,
                    "filename": "",
                    "available": []
                }
        
        return results
    
    async def generate_specific_preview_for_sessions(self, session_preview_requests: List[Tuple[str, str, int, str]]) -> Dict[str, Tuple[Optional[bytes], Optional[str]]]:
        """Generate specific preview images for multiple sessions concurrently
        
        Args:
            session_preview_requests: List of tuples (session_id, preview_type, size, request_id)
        
        Returns:
            Dict mapping session_id to (image_bytes, error_message)
        """
        if not session_preview_requests:
            return {}
        
        # Submit all preview generation tasks
        futures = {}
        for session_id, preview_type, size, request_id in session_preview_requests:
            future = asyncio.get_event_loop().run_in_executor(
                self.executor,
                self._generate_specific_preview_for_session,
                session_id,
                preview_type,
                size
            )
            futures[future] = (session_id, request_id)
        
        # Collect results
        results = {}
        for future in asyncio.as_completed(futures):
            session_id, request_id = futures[future]
            try:
                result = await future
                results[session_id] = result
            except Exception as e:
                logger.error(f"Error generating preview for session {session_id}: {str(e)}")
                results[session_id] = (None, f"Error generating preview: {str(e)}")
        
        return results
    
    def shutdown(self):
        """Shutdown the executor"""
        self.executor.shutdown(wait=True)

# Global thumbnail service instance
thumbnail_service = ThumbnailService()
