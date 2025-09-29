#!/usr/bin/env python3
"""
Thread-Safe Thumbnail Service for TissueLab AI Service
Provides thread-safe thumbnail generation with proper locking for CZI and ISyntax files
"""

import os
import asyncio
import threading
import time
import uuid
from typing import Dict, List, Optional, Tuple, Any
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
import base64
from PIL import Image
import traceback
import zmq
import json
from dataclasses import dataclass, asdict
from enum import Enum

from app.services.load_service import get_session_data
from app.core import logger
from app.config.celery_config import CELERY_CONFIG

class FileType(Enum):
    """Supported file types"""
    CZI = "czi"
    ISYNTAX = "isyntax"
    TIFF = "tiff"
    OTHER = "other"

class TaskStatus(Enum):
    """Task status enumeration"""
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

@dataclass
class ThumbnailTask:
    """Thumbnail generation task"""
    task_id: str
    session_id: str
    file_path: str
    file_type: FileType
    size: int
    preview_type: str
    status: TaskStatus
    created_at: float
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    result: Optional[Dict] = None
    error: Optional[str] = None
    priority: int = 0  # Higher number = higher priority

class ThreadSafeThumbnailService:
    """Thread-safe thumbnail service with proper locking for CZI and ISyntax files"""
    
    def __init__(self, max_workers: int = None, zmq_port: int = None):
        self.max_workers = max_workers or CELERY_CONFIG.MAX_WORKERS
        self.zmq_port = zmq_port or CELERY_CONFIG.ZMQ_PORT
        
        # Thread pool for task execution
        self.executor = ThreadPoolExecutor(max_workers=self.max_workers)
        
        # Task management
        self.tasks: Dict[str, ThumbnailTask] = {}
        self.task_lock = threading.Lock()
        
        # File-specific locks for CZI and ISyntax
        self.file_locks: Dict[str, threading.RLock] = {}
        self.file_locks_lock = threading.Lock()
        
        # Session locks
        self.session_locks: Dict[str, threading.RLock] = {}
        self.session_locks_lock = threading.Lock()
        
        # Cache for generated thumbnails
        self.thumbnail_cache: Dict[str, Dict] = {}
        self.cache_lock = threading.Lock()
        
        # ZeroMQ context for task distribution
        self.zmq_context = zmq.Context()
        self.zmq_socket = None
        self.zmq_running = False
        
        # Worker thread
        self.worker_thread = None
        self.running = False
        
        # Statistics
        self.stats = {
            'total_tasks': 0,
            'completed_tasks': 0,
            'failed_tasks': 0,
            'active_tasks': 0
        }
        self.stats_lock = threading.Lock()
        
    def start(self):
        """Start the thumbnail service"""
        if self.running:
            logger.warning("ThreadSafeThumbnailService is already running")
            return
            
        self.running = True
        
        # Start ZeroMQ socket
        self._start_zmq()
        
        # Start worker thread
        self.worker_thread = threading.Thread(target=self._worker_loop, daemon=True)
        self.worker_thread.start()
        
        logger.info(f"ThreadSafeThumbnailService started with {self.max_workers} workers on ZMQ port {self.zmq_port}")
        
    def shutdown(self):
        """Shutdown the service"""
        if not self.running:
            return
            
        self.running = False
        
        # Stop ZeroMQ
        self._stop_zmq()
        
        # Wait for worker thread
        if self.worker_thread and self.worker_thread.is_alive():
            self.worker_thread.join(timeout=5)
            
        # Shutdown executor
        self.executor.shutdown(wait=True)
        
        logger.info("ThreadSafeThumbnailService shutdown complete")
        
    def _start_zmq(self):
        """Start ZeroMQ socket for task distribution"""
        try:
            self.zmq_socket = self.zmq_context.socket(zmq.REP)
            self.zmq_socket.bind(f"tcp://*:{self.zmq_port}")
            self.zmq_running = True
            logger.info(f"ZeroMQ socket bound to port {self.zmq_port}")
        except Exception as e:
            logger.error(f"Failed to start ZeroMQ socket: {e}")
            self.zmq_running = False
            
    def _stop_zmq(self):
        """Stop ZeroMQ socket"""
        if self.zmq_socket:
            try:
                self.zmq_socket.close()
                self.zmq_socket = None
                self.zmq_running = False
                logger.info("ZeroMQ socket closed")
            except Exception as e:
                logger.error(f"Error closing ZeroMQ socket: {e}")
                
    def get_file_lock(self, file_path: str) -> threading.RLock:
        """Get or create a lock for a specific file"""
        with self.file_locks_lock:
            if file_path not in self.file_locks:
                self.file_locks[file_path] = threading.RLock()
            return self.file_locks[file_path]
            
    def get_session_lock(self, session_id: str) -> threading.RLock:
        """Get or create a lock for a specific session"""
        with self.session_locks_lock:
            if session_id not in self.session_locks:
                self.session_locks[session_id] = threading.RLock()
            return self.session_locks[session_id]
            
    def _detect_file_type(self, file_path: str) -> FileType:
        """Detect the type of file based on extension"""
        if not file_path:
            return FileType.OTHER
            
        ext = os.path.splitext(file_path)[1].lower()
        if ext == '.czi':
            return FileType.CZI
        elif ext == '.isyntax':
            return FileType.ISYNTAX
        elif ext in ['.tiff', '.tif', '.svs', '.ndpi']:
            return FileType.TIFF
        else:
            return FileType.OTHER
            
    def submit_thumbnail_task(self, session_id: str, size: int = 200, priority: int = 0) -> str:
        """Submit a thumbnail generation task"""
        try:
            session_data = get_session_data(session_id)
            file_path = session_data.get('current_file_path')
            
            if not file_path:
                raise ValueError(f"No file loaded for session {session_id}")
                
            file_type = self._detect_file_type(file_path)
            task_id = str(uuid.uuid4())
            
            task = ThumbnailTask(
                task_id=task_id,
                session_id=session_id,
                file_path=file_path,
                file_type=file_type,
                size=size,
                preview_type="thumbnail",
                status=TaskStatus.PENDING,
                created_at=time.time(),
                priority=priority
            )
            
            with self.task_lock:
                self.tasks[task_id] = task
                
            with self.stats_lock:
                self.stats['total_tasks'] += 1
                self.stats['active_tasks'] += 1
                
            logger.info(f"Submitted thumbnail task {task_id} for session {session_id} (file: {file_path})")
            return task_id
            
        except Exception as e:
            logger.error(f"Failed to submit thumbnail task: {e}")
            raise
            
    def submit_preview_task(self, session_id: str, preview_type: str, size: int = 200, priority: int = 0) -> str:
        """Submit a preview generation task"""
        try:
            session_data = get_session_data(session_id)
            file_path = session_data.get('current_file_path')
            
            if not file_path:
                raise ValueError(f"No file loaded for session {session_id}")
                
            file_type = self._detect_file_type(file_path)
            task_id = str(uuid.uuid4())
            
            task = ThumbnailTask(
                task_id=task_id,
                session_id=session_id,
                file_path=file_path,
                file_type=file_type,
                size=size,
                preview_type=preview_type,
                status=TaskStatus.PENDING,
                created_at=time.time(),
                priority=priority
            )
            
            with self.task_lock:
                self.tasks[task_id] = task
                
            with self.stats_lock:
                self.stats['total_tasks'] += 1
                self.stats['active_tasks'] += 1
                
            logger.info(f"Submitted preview task {task_id} for session {session_id} (type: {preview_type})")
            return task_id
            
        except Exception as e:
            logger.error(f"Failed to submit preview task: {e}")
            raise
            
    def get_task_status(self, task_id: str) -> Optional[Dict]:
        """Get the status of a task"""
        with self.task_lock:
            if task_id in self.tasks:
                task = self.tasks[task_id]
                return asdict(task)
        return None
        
    def cancel_task(self, task_id: str) -> bool:
        """Cancel a pending task"""
        with self.task_lock:
            if task_id in self.tasks:
                task = self.tasks[task_id]
                if task.status == TaskStatus.PENDING:
                    task.status = TaskStatus.CANCELLED
                    with self.stats_lock:
                        self.stats['active_tasks'] -= 1
                    logger.info(f"Task {task_id} cancelled")
                    return True
        return False
        
    def _worker_loop(self):
        """Main worker loop for processing tasks"""
        while self.running:
            try:
                # Get pending tasks sorted by priority
                with self.task_lock:
                    pending_tasks = [
                        task for task in self.tasks.values()
                        if task.status == TaskStatus.PENDING
                    ]
                    pending_tasks.sort(key=lambda x: (x.priority, x.created_at), reverse=True)
                
                # Process tasks
                for task in pending_tasks[:self.max_workers]:
                    if not self.running:
                        break
                    self._process_task(task)
                    
                time.sleep(0.1)  # Small delay to prevent busy waiting
                
            except Exception as e:
                logger.error(f"Error in worker loop: {str(e)}")
                traceback.print_exc()
                time.sleep(1)  # Wait before retrying
                
    def _process_task(self, task: ThumbnailTask):
        """Process a single task"""
        try:
            # Update task status
            task.status = TaskStatus.PROCESSING
            task.started_at = time.time()
            
            # Submit to thread pool
            future = self.executor.submit(self._execute_task, task)
            future.add_done_callback(lambda f: self._task_completed(task.task_id, f))
            
        except Exception as e:
            logger.error(f"Error processing task {task.task_id}: {str(e)}")
            self._mark_task_failed(task.task_id, str(e))
            
    def _execute_task(self, task: ThumbnailTask) -> Dict:
        """Execute the actual thumbnail/preview generation task"""
        try:
            # Get appropriate locks based on file type
            if task.file_type in [FileType.CZI, FileType.ISYNTAX]:
                # Use file-level lock for CZI and ISyntax files
                file_lock = self.get_file_lock(task.file_path)
                with file_lock:
                    return self._generate_thumbnail_with_session_lock(task)
            else:
                # Use session-level lock for other file types
                return self._generate_thumbnail_with_session_lock(task)
                
        except Exception as e:
            logger.error(f"Error executing task {task.task_id}: {str(e)}")
            raise
            
    def _generate_thumbnail_with_session_lock(self, task: ThumbnailTask) -> Dict:
        """Generate thumbnail with session-level locking"""
        session_lock = self.get_session_lock(task.session_id)
        
        with session_lock:
            try:
                session_data = get_session_data(task.session_id)
                session_slide = session_data.get('slide')
                
                if session_slide is None:
                    raise ValueError(f"No slide loaded for session {task.session_id}")
                    
                if task.preview_type == "thumbnail":
                    return self._generate_thumbnail_image(session_slide, task.size)
                else:
                    return self._generate_preview_image(session_slide, task.preview_type, task.size)
                    
            except Exception as e:
                logger.error(f"Error generating {task.preview_type} for session {task.session_id}: {str(e)}")
                raise
                
    def _generate_thumbnail_image(self, slide, size: int) -> Dict:
        """Generate thumbnail image from slide"""
        try:
            # Special handling for CZI files - use Thumbnail attachment if available
            if hasattr(slide, 'associated_images') and 'macro' in slide.associated_images:
                img = slide.associated_images['macro']
            else:
                # Fallback to original method
                thumbnail_level = len(slide.level_dimensions) - 1
                level_width, level_height = slide.level_dimensions[thumbnail_level]
                scale = min(size / level_width, size / level_height)
                target_width = int(level_width * scale)
                target_height = int(level_height * scale)
                
                img = slide.read_region((0, 0), thumbnail_level, (level_width, level_height))
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
                
            # Convert to base64
            buffer = BytesIO()
            img.save(buffer, format='JPEG', quality=85)
            thumbnail_data = base64.b64encode(buffer.getvalue()).decode('utf-8')
            
            return {
                "status": "success",
                "thumbnail": thumbnail_data,
                "size": size
            }
            
        except Exception as e:
            logger.error(f"Error generating thumbnail: {str(e)}")
            raise
            
    def _generate_preview_image(self, slide, preview_type: str, size: int) -> Dict:
        """Generate preview image from slide"""
        try:
            img = None
            
            if preview_type == "macro":
                if hasattr(slide, 'associated_images') and 'macro' in slide.associated_images:
                    img = slide.associated_images['macro']
                elif hasattr(slide, 'associated_images') and 'overview' in slide.associated_images:
                    img = slide.associated_images['overview']
                else:
                    macro_level = min(len(slide.level_dimensions) - 1, 2)
                    level_width, level_height = slide.level_dimensions[macro_level]
                    img = slide.read_region((0, 0), macro_level, (level_width, level_height))
                    
            elif preview_type == "label":
                if hasattr(slide, 'associated_images') and 'label' in slide.associated_images:
                    img = slide.associated_images['label']
                else:
                    raise ValueError("Label image not available")
                    
            if img is None:
                raise ValueError(f"{preview_type} image not available")
                
            if img.mode != 'RGB':
                img = img.convert('RGB')
                
            # Resize if needed
            original_width, original_height = img.size
            scale = min(size / original_width, size / original_height)
            if scale < 1:
                target_width = int(original_width * scale)
                target_height = int(original_height * scale)
                img = img.resize((target_width, target_height), Image.Resampling.LANCZOS)
                
            # Convert to base64
            buffer = BytesIO()
            img.save(buffer, format='JPEG', quality=85)
            preview_data = base64.b64encode(buffer.getvalue()).decode('utf-8')
            
            return {
                "status": "success",
                "preview": preview_data,
                "type": preview_type,
                "size": size
            }
            
        except Exception as e:
            logger.error(f"Error generating {preview_type} preview: {str(e)}")
            raise
            
    def _task_completed(self, task_id: str, future):
        """Handle task completion"""
        try:
            with self.task_lock:
                if task_id not in self.tasks:
                    return
                task = self.tasks[task_id]
                
            if future.exception():
                self._mark_task_failed(task_id, str(future.exception()))
            else:
                self._mark_task_completed(task_id, future.result())
                
        except Exception as e:
            logger.error(f"Error handling task completion for {task_id}: {str(e)}")
            self._mark_task_failed(task_id, str(e))
            
    def _mark_task_completed(self, task_id: str, result: Dict):
        """Mark a task as completed"""
        with self.task_lock:
            if task_id in self.tasks:
                task = self.tasks[task_id]
                task.status = TaskStatus.COMPLETED
                task.completed_at = time.time()
                task.result = result
                
        with self.stats_lock:
            self.stats['completed_tasks'] += 1
            self.stats['active_tasks'] -= 1
            
        logger.info(f"Task {task_id} completed successfully")
        
    def _mark_task_failed(self, task_id: str, error: str):
        """Mark a task as failed"""
        with self.task_lock:
            if task_id in self.tasks:
                task = self.tasks[task_id]
                task.status = TaskStatus.FAILED
                task.completed_at = time.time()
                task.error = error
                
        with self.stats_lock:
            self.stats['failed_tasks'] += 1
            self.stats['active_tasks'] -= 1
            
        logger.error(f"Task {task_id} failed: {error}")
        
    def get_service_stats(self) -> Dict:
        """Get service statistics"""
        with self.stats_lock:
            return self.stats.copy()
            
    def cleanup_old_tasks(self, max_age_hours: int = 24):
        """Clean up old completed/failed tasks"""
        cutoff_time = time.time() - (max_age_hours * 3600)
        
        with self.task_lock:
            tasks_to_remove = [
                task_id for task_id, task in self.tasks.items()
                if task.status in [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]
                and task.completed_at and task.completed_at < cutoff_time
            ]
            
            for task_id in tasks_to_remove:
                del self.tasks[task_id]
                
        logger.info(f"Cleaned up {len(tasks_to_remove)} old tasks")
        
    def __del__(self):
        """Cleanup on destruction"""
        try:
            self.shutdown()
        except Exception:
            pass
