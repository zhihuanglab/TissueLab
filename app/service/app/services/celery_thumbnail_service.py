#!/usr/bin/env python3
"""
Celery Thumbnail Service for TissueLab AI Service
Provides asynchronous thumbnail generation using Celery task queue
"""

import os
import asyncio
import threading
import time
import uuid
from typing import Dict, List, Optional, Any, Tuple
from concurrent.futures import ThreadPoolExecutor
import traceback

from app.services.thumbnail_service import ThumbnailService
from app.services.thumbnail_cache_service import thumbnail_cache_service
from app.core import logger
from app.config.celery_config import CELERY_CONFIG

class CeleryThumbnailService:
    """Celery-based thumbnail service for asynchronous processing"""
    
    def __init__(self, zmq_port: int = None, max_workers: int = None):
        """Initialize the Celery thumbnail service"""
        self.zmq_port = zmq_port or CELERY_CONFIG.ZMQ_PORT
        self.max_workers = max_workers or CELERY_CONFIG.MAX_WORKERS
        self.thumbnail_service = ThumbnailService(max_workers=self.max_workers)
        self.executor = ThreadPoolExecutor(max_workers=self.max_workers)
        self.tasks = {}  # Task cache
        self.task_lock = threading.Lock()
        self.ws_notifier = None
        self.running = False
        self.worker_thread = None
        
    def start_worker(self):
        """Start the Celery worker thread"""
        if self.running:
            logger.warning("Celery worker is already running")
            return
            
        self.running = True
        self.worker_thread = threading.Thread(target=self._worker_loop, daemon=True)
        self.worker_thread.start()
        logger.info(f"Celery thumbnail worker started on port {self.zmq_port}")
        
    def shutdown(self):
        """Shutdown the Celery service"""
        if not self.running:
            return
            
        self.running = False
        if self.worker_thread and self.worker_thread.is_alive():
            self.worker_thread.join(timeout=5)
            
        self.executor.shutdown(wait=True)
        logger.info("Celery thumbnail service shutdown complete")
        
    def set_ws_notifier(self, notifier_func):
        """Set WebSocket notifier function for task updates"""
        self.ws_notifier = notifier_func
        
    def _worker_loop(self):
        """Main worker loop for processing tasks"""
        while self.running:
            try:
                # Process pending tasks
                with self.task_lock:
                    pending_tasks = [task_id for task_id, task in self.tasks.items() 
                                   if task['status'] == 'pending']
                
                for task_id in pending_tasks:
                    if not self.running:
                        break
                    self._process_task(task_id)
                    
                time.sleep(0.1)  # Small delay to prevent busy waiting
                
            except Exception as e:
                logger.error(f"Error in worker loop: {str(e)}")
                traceback.print_exc()
                time.sleep(1)  # Wait before retrying
                
    def _process_task(self, task_id: str):
        """Process a single task"""
        try:
            with self.task_lock:
                if task_id not in self.tasks:
                    return
                task = self.tasks[task_id]
                
            # Update task status
            task['status'] = 'processing'
            task['started_at'] = time.time()
            
            # Submit task to thread pool
            future = self.executor.submit(self._execute_task, task)
            future.add_done_callback(lambda f: self._task_completed(task_id, f))
            
        except Exception as e:
            logger.error(f"Error processing task {task_id}: {str(e)}")
            self._update_task_status(task_id, 'error', str(e))
            
    def _execute_task(self, task: Dict) -> Dict:
        """Execute the actual task with isolated slide objects"""
        try:
            task_type = task.get('type')
            session_id = task.get('session_id')
            file_path = task.get('file_path')
            request_id = task.get('request_id')

            if task_type == 'thumbnail':
                size = task.get('size', 200)
                if session_id:
                    # Create isolated slide object for this task
                    result = self._generate_thumbnail_with_isolated_slide(session_id, size)
                elif file_path:
                    # Use file path directly with isolated slide loading
                    result = self._generate_thumbnail_from_path_isolated(file_path, size, request_id)
                else:
                    raise ValueError("Either session_id or file_path must be provided")
            elif task_type == 'preview':
                preview_type = task.get('preview_type')
                size = task.get('size', 200)
                if session_id:
                    # Create isolated slide object for this task
                    if preview_type == 'all':
                        result = self._generate_thumbnail_with_isolated_slide(session_id, size)
                    else:
                        result = self._generate_preview_with_isolated_slide(session_id, preview_type, size)
                elif file_path:
                    # Use file path directly with isolated slide loading
                    if preview_type == 'all':
                        result = self._generate_thumbnail_from_path_isolated(file_path, size, request_id)
                    else:
                        result = self._generate_preview_from_path_isolated(file_path, preview_type, size, request_id)
                else:
                    raise ValueError("Either session_id or file_path must be provided")
            else:
                raise ValueError(f"Unknown task type: {task_type}")

            # Add request_id to result if available
            if request_id and isinstance(result, dict):
                result['request_id'] = request_id

            return result

        except Exception as e:
            logger.error(f"Error executing task: {str(e)}")
            return {
                "status": "error",
                "message": str(e)
            }

    def _create_isolated_slide_object(self, file_path: str):
        """Create an isolated slide object for a specific task"""
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

        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File {file_path} not found")

        file_ext = file_path.rsplit('.', 1)[1].lower()

        if file_ext in ['tif', 'tiff', 'btf']:
            try:
                # First try tiffslide
                slide_obj = TiffSlideWrapper(file_path)
            except Exception as e:
                # If tiffslide fails, try our wrapper
                slide_obj = TiffFileWrapper(file_path)
        elif file_ext in ['svs', 'qptiff']:
            slide_obj = TiffSlideWrapper(file_path)
        elif file_ext in ['ndpi']:
            # For NDPI files, use TiffFileWrapper directly (tiffslide has dimension issues)
            slide_obj = TiffSlideWrapper(file_path)
        elif file_ext in ['jpeg', 'jpg', 'png', 'bmp']:
            slide_obj = SimpleImageWrapper(file_path)
        elif file_ext in ['isyntax']:
            slide_obj = ISyntaxImageWrapper(file_path)
        elif file_ext in ['czi']:
            slide_obj = CziImageWrapper(file_path)
        elif file_ext in ['dcm']:
            slide_obj = DicomImageWrapper(file_path)
        elif file_ext in ['nii']:
            slide_obj = NiftiImageWrapper(file_path)
        else:
            raise ValueError(f"Unsupported file format: {file_ext}")

        return slide_obj

    def _generate_thumbnail_with_isolated_slide(self, session_id: str, size: int = 200) -> Dict:
        """Generate thumbnail using an isolated slide object"""
        from app.services.load_service import get_session_data, get_slide_preview_data
        from io import BytesIO

        slide_obj = None
        try:
            # Get session data
            session_data = get_session_data(session_id)
            original_file_path = session_data.get('current_file_path')

            if not original_file_path or not os.path.exists(original_file_path):
                return {
                    "status": "error",
                    "message": f"No valid file path found for session {session_id}",
                    "thumbnail": None,
                    "macro": None,
                    "label": None,
                    "filename": "",
                    "available": []
                }

            # Check cache first for all preview types
            cached_thumbnail = thumbnail_cache_service.get_cached_thumbnail_base64(
                original_file_path, size, "thumbnail"
            )
            cached_macro = thumbnail_cache_service.get_cached_thumbnail_base64(
                original_file_path, size, "macro"
            )
            cached_label = thumbnail_cache_service.get_cached_thumbnail_base64(
                original_file_path, size, "label"
            )
            
            # If all previews are cached, return cached data
            if cached_thumbnail and cached_macro and cached_label:
                return {
                    "status": "success",
                    "thumbnail": cached_thumbnail,
                    "macro": cached_macro,
                    "label": cached_label,
                    "filename": os.path.basename(original_file_path),
                    "available": ["thumbnail", "macro", "label"]
                }

            # Create isolated slide object
            slide_obj = self._create_isolated_slide_object(original_file_path)

            # Generate preview data using the isolated slide object
            result = get_slide_preview_data(slide_obj, original_file_path, size)
            result["status"] = "success"
            
            # Cache the generated previews
            if result.get("thumbnail"):
                thumbnail_cache_service.cache_thumbnail_from_base64(
                    original_file_path, size, "thumbnail", result["thumbnail"]
                )
            if result.get("macro"):
                thumbnail_cache_service.cache_thumbnail_from_base64(
                    original_file_path, size, "macro", result["macro"]
                )
            if result.get("label"):
                thumbnail_cache_service.cache_thumbnail_from_base64(
                    original_file_path, size, "label", result["label"]
                )
            
            return result

        except Exception as e:
            logger.error(f"Error generating thumbnail with isolated slide for session {session_id}: {str(e)}")
            return {
                "status": "error",
                "message": f"Error generating thumbnail: {str(e)}",
                "thumbnail": None,
                "macro": None,
                "label": None,
                "filename": "",
                "available": []
            }

        finally:
            # Clean up the isolated slide object
            if slide_obj and hasattr(slide_obj, 'close'):
                try:
                    slide_obj.close()
                except:
                    pass

    def _generate_preview_with_isolated_slide(self, session_id: str, preview_type: str, size: int = 200) -> Tuple[Optional[bytes], Optional[str]]:
        """Generate preview using an isolated slide object"""
        from app.services.load_service import get_session_data, get_slide_preview_image

        slide_obj = None
        try:
            # Get session data
            session_data = get_session_data(session_id)
            original_file_path = session_data.get('current_file_path')

            if not original_file_path or not os.path.exists(original_file_path):
                return None, f"No valid file path found for session {session_id}"

            # Check cache first
            cached_bytes = thumbnail_cache_service.get_cached_thumbnail(
                original_file_path, size, preview_type
            )
            if cached_bytes:
                return cached_bytes, None

            # Create isolated slide object
            slide_obj = self._create_isolated_slide_object(original_file_path)

            # Generate preview image using the isolated slide object
            image_bytes, error_msg = get_slide_preview_image(slide_obj, preview_type, size)
            
            # Cache the generated preview
            if image_bytes and original_file_path:
                thumbnail_cache_service.cache_thumbnail(
                    original_file_path, size, preview_type, image_bytes
                )
            
            return image_bytes, error_msg

        except Exception as e:
            logger.error(f"Error generating preview with isolated slide for session {session_id}: {str(e)}")
            return None, f"Error generating preview: {str(e)}"

        finally:
            # Clean up the isolated slide object
            if slide_obj and hasattr(slide_obj, 'close'):
                try:
                    slide_obj.close()
                except:
                    pass

    def _generate_thumbnail_from_path_isolated(self, file_path: str, size: int = 200, request_id: str = None) -> Dict:
        """Generate thumbnail from file path using isolated slide loading"""
        from app.services.load_service import get_slide_preview_data
        from app.utils import resolve_path

        slide_obj = None
        try:
            # Resolve file path
            resolved_path = resolve_path(file_path)

            # Check cache first for all preview types
            cached_thumbnail = thumbnail_cache_service.get_cached_thumbnail_base64(
                resolved_path, size, "thumbnail"
            )
            cached_macro = thumbnail_cache_service.get_cached_thumbnail_base64(
                resolved_path, size, "macro"
            )
            cached_label = thumbnail_cache_service.get_cached_thumbnail_base64(
                resolved_path, size, "label"
            )
            
            # If all previews are cached, return cached data
            if cached_thumbnail and cached_macro and cached_label:
                result = {
                    "status": "success",
                    "thumbnail": cached_thumbnail,
                    "macro": cached_macro,
                    "label": cached_label,
                    "filename": os.path.basename(resolved_path),
                    "available": ["thumbnail", "macro", "label"]
                }
                if request_id:
                    result["request_id"] = request_id
                return result

            # Create isolated slide object
            slide_obj = self._create_isolated_slide_object(resolved_path)

            # Generate preview data using the isolated slide object
            result = get_slide_preview_data(slide_obj, resolved_path, size)
            result["status"] = "success"
            
            # Cache the generated previews
            if result.get("thumbnail"):
                thumbnail_cache_service.cache_thumbnail_from_base64(
                    resolved_path, size, "thumbnail", result["thumbnail"]
                )
            if result.get("macro"):
                thumbnail_cache_service.cache_thumbnail_from_base64(
                    resolved_path, size, "macro", result["macro"]
                )
            if result.get("label"):
                thumbnail_cache_service.cache_thumbnail_from_base64(
                    resolved_path, size, "label", result["label"]
                )
            
            if request_id:
                result["request_id"] = request_id
            return result

        except Exception as e:
            logger.error(f"Error generating thumbnail from path {resolved_path}: {str(e)}")
            return {
                "status": "error",
                "message": f"Error generating thumbnail: {str(e)}",
                "thumbnail": None,
                "macro": None,
                "label": None,
                "filename": os.path.basename(resolved_path) if resolved_path else "",
                "available": []
            }

        finally:
            # Clean up the isolated slide object
            if slide_obj and hasattr(slide_obj, 'close'):
                try:
                    slide_obj.close()
                except:
                    pass

    def _generate_preview_from_path_isolated(self, file_path: str, preview_type: str, size: int = 200, request_id: str = None) -> Dict:
        """Generate preview from file path using isolated slide loading"""
        from app.services.load_service import get_slide_preview_image
        from app.utils import resolve_path

        slide_obj = None
        try:
            # Resolve file path
            resolved_path = resolve_path(file_path)

            # Check cache first
            cached_bytes = thumbnail_cache_service.get_cached_thumbnail(
                resolved_path, size, preview_type
            )
            if cached_bytes:
                result = {
                    "status": "success",
                    "image_bytes": cached_bytes,
                    "file_path": file_path,
                    "response_type": "binary"
                }
                if request_id:
                    result["request_id"] = request_id
                return result

            # Create isolated slide object
            slide_obj = self._create_isolated_slide_object(resolved_path)

            # Generate preview image using the isolated slide object
            image_bytes, error_msg = get_slide_preview_image(slide_obj, preview_type, size)

            if image_bytes is None:
                return {
                    "status": "error",
                    "message": error_msg,
                    "response_type": "error"
                }

            # Cache the generated preview
            thumbnail_cache_service.cache_thumbnail(
                resolved_path, size, preview_type, image_bytes
            )

            result = {
                "status": "success",
                "image_bytes": image_bytes,
                "file_path": file_path,
                "response_type": "binary"
            }
            if request_id:
                result["request_id"] = request_id
            return result

        except Exception as e:
            logger.error(f"Error generating preview from path {resolved_path}: {str(e)}")
            return {
                "status": "error",
                "message": f"Error generating preview: {str(e)}",
                "response_type": "error"
            }

        finally:
            # Clean up the isolated slide object
            if slide_obj and hasattr(slide_obj, 'close'):
                try:
                    slide_obj.close()
                except:
                    pass

    def _task_completed(self, task_id: str, future):
        """Handle task completion"""
        try:
            result = future.result()
            
            if result.get('status') == 'error':
                self._update_task_status(task_id, 'error', result.get('message', 'Unknown error'))
            else:
                self._update_task_status(task_id, 'completed', result)
                
        except Exception as e:
            logger.error(f"Error handling task completion for {task_id}: {str(e)}")
            self._update_task_status(task_id, 'error', str(e))
            
    def _update_task_status(self, task_id: str, status: str, result: Any = None):
        """Update task status and notify if needed"""
        with self.task_lock:
            if task_id in self.tasks:
                self.tasks[task_id]['status'] = status
                self.tasks[task_id]['completed_at'] = time.time()
                if result:
                    self.tasks[task_id]['result'] = result
                    
        # Notify WebSocket clients if notifier is set
        if self.ws_notifier:
            try:
                # Check if we're in an async context
                try:
                    asyncio.get_running_loop()
                    # We're in an async context, create a task
                    asyncio.create_task(self.ws_notifier({
                        'task_id': task_id,
                        'status': status,
                        'result': result
                    }))
                except RuntimeError:
                    # No running event loop, run in a new thread with asyncio
                    def run_async_notification():
                        try:
                            new_loop = asyncio.new_event_loop()
                            asyncio.set_event_loop(new_loop)
                            new_loop.run_until_complete(self.ws_notifier({
                                'task_id': task_id,
                                'status': status,
                                'result': result
                            }))
                            new_loop.close()
                        except Exception as e:
                            logger.error(f"Error in async notification thread: {str(e)}")
                    
                    thread = threading.Thread(target=run_async_notification)
                    thread.daemon = True
                    thread.start()
            except Exception as e:
                logger.error(f"Error notifying WebSocket: {str(e)}")
                
    async def submit_thumbnail_task(self, session_id: str, size: int = 200, request_id: str = None) -> str:
        """Submit a thumbnail generation task"""
        task_id = str(uuid.uuid4())
        
        task = {
            'id': task_id,
            'type': 'thumbnail',
            'session_id': session_id,
            'size': size,
            'request_id': request_id,
            'status': 'pending',
            'created_at': time.time(),
            'result': None
        }
        
        with self.task_lock:
            self.tasks[task_id] = task
            
        logger.info(f"Submitted thumbnail task {task_id} for session {session_id}")
        return task_id
        
    async def submit_preview_task(self, session_id: str = None, preview_type: str = "all", size: int = 200, file_path: str = None, request_id: str = None) -> str:
        """Submit a preview generation task"""
        task_id = str(uuid.uuid4())
        
        task = {
            'id': task_id,
            'type': 'preview',
            'session_id': session_id,
            'file_path': file_path,
            'preview_type': preview_type,
            'size': size,
            'request_id': request_id,
            'status': 'pending',
            'created_at': time.time(),
            'result': None
        }
        
        with self.task_lock:
            self.tasks[task_id] = task
            
        if session_id:
            logger.info(f"Submitted preview task {task_id} for session {session_id}")
        elif file_path:
            logger.info(f"Submitted preview task {task_id} for file {file_path}")
        else:
            raise ValueError("Either session_id or file_path must be provided")
            
        return task_id
        
    async def get_task_status(self, task_id: str) -> Dict:
        """Get the status of a task"""
        with self.task_lock:
            if task_id not in self.tasks:
                return {'error': f'Task {task_id} not found'}
                
            task = self.tasks[task_id]
            return {
                'task_id': task_id,
                'status': task['status'],
                'created_at': task['created_at'],
                'started_at': task.get('started_at'),
                'completed_at': task.get('completed_at'),
                'result': task.get('result')
            }
            
    def get_pending_tasks_count(self) -> int:
        """Get the number of pending tasks"""
        with self.task_lock:
            return len([task for task in self.tasks.values() if task['status'] == 'pending'])
            
    def get_running_tasks_count(self) -> int:
        """Get the number of running tasks"""
        with self.task_lock:
            return len([task for task in self.tasks.values() if task['status'] == 'processing'])
            
    def cleanup_old_tasks(self, max_age: int = None):
        """Clean up old completed tasks"""
        max_age = max_age or CELERY_CONFIG.TASK_CACHE_TTL
        current_time = time.time()
        
        with self.task_lock:
            tasks_to_remove = []
            for task_id, task in self.tasks.items():
                if (task['status'] in ['completed', 'error'] and 
                    current_time - task.get('completed_at', 0) > max_age):
                    tasks_to_remove.append(task_id)
                    
            for task_id in tasks_to_remove:
                del self.tasks[task_id]
                
        if tasks_to_remove:
            logger.info(f"Cleaned up {len(tasks_to_remove)} old tasks")

# Global instance for the service
celery_thumbnail_service = CeleryThumbnailService()
