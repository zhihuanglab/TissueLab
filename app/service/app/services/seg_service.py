import math
import h5py
import json
from datetime import datetime
from scipy.spatial import KDTree, Delaunay
import numpy as np
import numba
import time
import os
from typing import Dict, List, Optional, Any, Tuple
import cv2
import traceback
import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
import platform
from app.utils import resolve_path

# Cross-platform file locking imports
try:
    import fcntl
    HAS_FCNTL = True
except ImportError:
    HAS_FCNTL = False

try:
    import msvcrt
    HAS_MSVCRT = True
except ImportError:
    HAS_MSVCRT = False


class H5FileCache:
    """Thread-safe cache for h5 file data with file release support"""
    
    def __init__(self):
        self._cache = {}
        self._lock = threading.RLock()
        self._loading_tasks = {}
        self._file_handles = {}  # Track open file handles for release
        self._handlers = {}  # Track SegmentationHandler instances by file path
        self._file_locks = {}  # Track file locks to prevent concurrent access
        self._pending_updates = {}  # Track files that need cache updates when unlocked
    
    def get_cached_data(self, file_path: str) -> Optional[Dict]:
        """Get cached data for a file with enhanced change detection"""
        with self._lock:
            if file_path in self._cache:
                cache_entry = self._cache[file_path]
                # Enhanced validation: check both mtime and size
                if os.path.exists(file_path):
                    file_mtime = os.path.getmtime(file_path)
                    file_size = os.path.getsize(file_path)
                    
                    # Check if file has changed (mtime or size)
                    if (cache_entry['mtime'] == file_mtime and 
                        cache_entry.get('size', 0) == file_size):
                        print(f"[DEBUG] H5FileCache - Using cached data for {file_path}")
                        return cache_entry['data']
                    else:
                        # File modified, remove from cache
                        print(f"[DEBUG] H5FileCache - File changed, invalidating cache for {file_path}")
                        del self._cache[file_path]
                        # Also close any open file handles for this file
                        if file_path in self._file_handles:
                            try:
                                self._file_handles[file_path].close()
                            except:
                                pass
                            del self._file_handles[file_path]
                        # Notify all handlers that the file has changed
                        self.notify_handlers_file_changed(file_path)
                else:
                    # File doesn't exist, remove from cache
                    print(f"[DEBUG] H5FileCache - File not found, removing from cache: {file_path}")
                    del self._cache[file_path]
                    if file_path in self._file_handles:
                        try:
                            self._file_handles[file_path].close()
                        except:
                            pass
                        del self._file_handles[file_path]
        return None
    
    def set_cached_data(self, file_path: str, data: Dict):
        """Cache data for a file with enhanced metadata"""
        with self._lock:
            if os.path.exists(file_path):
                mtime = os.path.getmtime(file_path)
                size = os.path.getsize(file_path)
                self._cache[file_path] = {
                    'data': data,
                    'mtime': mtime,
                    'size': size,
                    'timestamp': time.time()
                }
                print(f"[DEBUG] H5FileCache - Cached data for {file_path} (size: {size} bytes, mtime: {mtime})")
            else:
                print(f"[WARN] H5FileCache - Cannot cache data for non-existent file: {file_path}")
    
    def is_loading(self, file_path: str) -> bool:
        """Check if a file is currently being loaded"""
        with self._lock:
            return file_path in self._loading_tasks
    
    def set_loading(self, file_path: str, task):
        """Mark a file as being loaded"""
        with self._lock:
            self._loading_tasks[file_path] = task
    
    def clear_loading(self, file_path: str):
        """Clear loading status for a file"""
        with self._lock:
            if file_path in self._loading_tasks:
                del self._loading_tasks[file_path]
    
    def clear_cache(self, file_path: str = None):
        """Clear cache for specific file or all files"""
        with self._lock:
            if file_path:
                if file_path in self._cache:
                    del self._cache[file_path]
                # Close file handle if exists
                if file_path in self._file_handles:
                    try:
                        self._file_handles[file_path].close()
                    except:
                        pass
                    del self._file_handles[file_path]
            else:
                self._cache.clear()
                # Close all file handles
                for handle in self._file_handles.values():
                    try:
                        handle.close()
                    except:
                        pass
                self._file_handles.clear()
    
    def release_h5_file(self, file_path: str) -> bool:
        """Release h5 file handle after data is cached"""
        with self._lock:
            if file_path in self._file_handles:
                try:
                    self._file_handles[file_path].close()
                    del self._file_handles[file_path]
                    print(f"[DEBUG] H5FileCache - Released h5 file handle: {file_path}")
                    return True
                except Exception as e:
                    print(f"[WARN] H5FileCache - Failed to release h5 file handle {file_path}: {e}")
                    return False
            return True
    
    def is_file_handle_open(self, file_path: str) -> bool:
        """Check if a file handle is currently open"""
        with self._lock:
            return file_path in self._file_handles
    
    def register_handler(self, file_path: str, handler):
        """Register a SegmentationHandler instance for a file"""
        with self._lock:
            if file_path not in self._handlers:
                self._handlers[file_path] = []
            self._handlers[file_path].append(handler)
    
    def unregister_handler(self, file_path: str, handler):
        """Unregister a SegmentationHandler instance for a file"""
        with self._lock:
            if file_path in self._handlers:
                try:
                    self._handlers[file_path].remove(handler)
                    if not self._handlers[file_path]:
                        del self._handlers[file_path]
                except ValueError:
                    pass
    
    def notify_handlers_file_changed(self, file_path: str):
        """Notify all handlers that a file has changed"""
        with self._lock:
            if file_path in self._handlers:
                for handler in self._handlers[file_path]:
                    try:
                        # Mark handler as needing reload
                        handler._needs_reload = True
                        # Ensure manual annotations will be re-applied after file changes
                        try:
                            handler._manual_annotations_processed = False
                            handler._processed_file = None
                        except Exception:
                            pass
                    except Exception as e:
                        print(f"[WARN] Failed to notify handler of file change: {e}")
    
    def is_file_changed(self, file_path: str) -> bool:
        """Check if file has changed since last cache"""
        with self._lock:
            if file_path not in self._cache:
                return True
            
            if not os.path.exists(file_path):
                return True
            
            cache_entry = self._cache[file_path]
            current_mtime = os.path.getmtime(file_path)
            current_size = os.path.getsize(file_path)
            
            return (cache_entry['mtime'] != current_mtime or 
                    cache_entry.get('size', 0) != current_size)
    
    def force_refresh_cache(self, file_path: str) -> bool:
        """Force refresh cache for a file"""
        with self._lock:
            if file_path in self._cache:
                print(f"[DEBUG] H5FileCache - Force refreshing cache for {file_path}")
                del self._cache[file_path]
                # Also close any open file handles for this file
                if file_path in self._file_handles:
                    try:
                        self._file_handles[file_path].close()
                    except:
                        pass
                    del self._file_handles[file_path]
                # Notify all handlers that the file has changed
                self.notify_handlers_file_changed(file_path)
                return True
            return False
    
    def refresh_cache_with_reload(self, file_path: str) -> bool:
        """Force refresh cache and reload data from file"""
        with self._lock:
            # First force refresh
            if self.force_refresh_cache(file_path):
                print(f"[DEBUG] H5FileCache - Cache refreshed, now reloading data for {file_path}")
                try:
                    # Trigger preload_data to repopulate cache
                    preload_data(file_path)
                    print(f"[DEBUG] H5FileCache - Successfully reloaded data for {file_path}")
                    return True
                except Exception as e:
                    print(f"[WARN] H5FileCache - Failed to reload data for {file_path}: {e}")
                    return False
            return False
    
    def acquire_file_lock(self, file_path: str, timeout: float = 5.0) -> bool:
        """Acquire a file lock to prevent concurrent access"""
        with self._lock:
            if file_path in self._file_locks:
                return False  # File is already locked
            
            start_time = time.time()
            while time.time() - start_time < timeout:
                try:
                    # Try to open file in exclusive mode to check if it's locked
                    if platform.system() == "Windows" and HAS_MSVCRT:
                        # On Windows, try to open with exclusive access
                        try:
                            with open(file_path, 'r+b') as f:
                                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                                # If we get here, file is not locked, release immediately
                                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
                        except (OSError, IOError):
                            # File is locked, wait a bit and retry
                            time.sleep(0.1)
                            continue
                    elif HAS_FCNTL:
                        # On Unix-like systems, use fcntl
                        try:
                            with open(file_path, 'r+b') as f:
                                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                                # If we get here, file is not locked, release immediately
                                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
                        except (OSError, IOError):
                            # File is locked, wait a bit and retry
                            time.sleep(0.1)
                            continue
                    else:
                        # No file locking available, just check if file exists and is readable
                        try:
                            with open(file_path, 'rb') as f:
                                f.read(1)  # Try to read one byte
                        except (OSError, IOError):
                            # File is locked or not accessible, wait a bit and retry
                            time.sleep(0.1)
                            continue
                    
                    # File is not locked, mark as locked by us
                    self._file_locks[file_path] = time.time()
                    print(f"[DEBUG] H5FileCache - Acquired file lock for {file_path}")
                    return True
                    
                except Exception as e:
                    print(f"[DEBUG] H5FileCache - Error checking file lock for {file_path}: {e}")
                    time.sleep(0.1)
                    continue
            
            print(f"[WARN] H5FileCache - Could not acquire file lock for {file_path} within {timeout}s")
            return False
    
    def release_file_lock(self, file_path: str) -> bool:
        """Release a file lock"""
        with self._lock:
            if file_path in self._file_locks:
                del self._file_locks[file_path]
                print(f"[DEBUG] H5FileCache - Released file lock for {file_path}")
                
                # Check if this file was scheduled for cache update
                if file_path in self._pending_updates:
                    print(f"[DEBUG] H5FileCache - File {file_path} was unlocked, cache update will be processed soon")
                
                return True
            return False
    
    def is_file_locked(self, file_path: str) -> bool:
        """Check if a file is currently locked by us or another process"""
        with self._lock:
            if file_path in self._file_locks:
                return True  # Locked by us
            
            # Check if locked by another process
            try:
                if platform.system() == "Windows" and HAS_MSVCRT:
                    try:
                        with open(file_path, 'r+b') as f:
                            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
                        return False  # Not locked
                    except (OSError, IOError):
                        return True  # Locked
                elif HAS_FCNTL:
                    try:
                        with open(file_path, 'r+b') as f:
                            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
                        return False  # Not locked
                    except (OSError, IOError):
                        return True  # Locked
                else:
                    # No file locking available, just check if file is accessible
                    try:
                        with open(file_path, 'rb') as f:
                            f.read(1)  # Try to read one byte
                        return False  # Not locked
                    except (OSError, IOError):
                        return True  # Locked or not accessible
            except Exception:
                return True  # Assume locked if we can't check
    
    def get_cached_data_fallback(self, file_path: str) -> Optional[Dict]:
        """Get cached data with fallback for locked files - prioritizes cache over file access"""
        with self._lock:
            # If file is locked, prioritize any existing cache (even if stale)
            if self.is_file_locked(file_path):
                print(f"[DEBUG] H5FileCache - File {file_path} is locked, attempting fallback to any existing cache...")
                if file_path in self._cache:
                    cache_entry = self._cache[file_path]
                    print(f"[DEBUG] H5FileCache - Using fallback cache for locked file {file_path}")
                    return cache_entry['data']
                else:
                    print(f"[DEBUG] H5FileCache - No cache available for locked file {file_path}")
                    return None
            
            # If file is not locked, try normal cache retrieval
            cached_data = self.get_cached_data(file_path)
            if cached_data:
                return cached_data
            
            return None
    
    def get_cached_data_priority(self, file_path: str) -> Optional[Dict]:
        """Get cached data with maximum priority for locked files - always returns cache if available"""
        with self._lock:
            # Always check cache first, regardless of file lock status
            if file_path in self._cache:
                cache_entry = self._cache[file_path]
                print(f"[DEBUG] H5FileCache - Using cached data for {file_path} (priority mode)")
                
                # If file was locked but now unlocked, schedule cache update
                if self._was_locked_recently(file_path):
                    print(f"[DEBUG] H5FileCache - File {file_path} was recently locked, scheduling cache update")
                    self._schedule_cache_update(file_path)
                
                return cache_entry['data']
            
            # If no cache and file is locked, return None immediately
            if self.is_file_locked(file_path):
                print(f"[DEBUG] H5FileCache - No cache available for locked file {file_path}")
                return None
            
            # If file is not locked, try normal cache retrieval
            cached_data = self.get_cached_data(file_path)
            if cached_data:
                return cached_data
            
            return None
    
    def _was_locked_recently(self, file_path: str) -> bool:
        """Check if file was locked recently (within last 30 seconds)"""
        with self._lock:
            if file_path in self._file_locks:
                lock_time = self._file_locks[file_path]
                return (time.time() - lock_time) < 30.0
            return False
    
    def _schedule_cache_update(self, file_path: str):
        """Schedule a cache update for when file becomes available"""
        with self._lock:
            if file_path not in self._pending_updates:
                self._pending_updates[file_path] = time.time()
                print(f"[DEBUG] H5FileCache - Scheduled cache update for {file_path}")
    
    def check_and_update_pending_caches(self):
        """Check for files that were locked and update their caches if now available"""
        with self._lock:
            files_to_update = []
            current_time = time.time()
            
            for file_path, schedule_time in list(self._pending_updates.items()):
                # Only try to update if scheduled more than 1 second ago
                if current_time - schedule_time > 1.0:
                    if not self.is_file_locked(file_path):
                        files_to_update.append(file_path)
                        del self._pending_updates[file_path]
            
            # Update caches for available files
            for file_path in files_to_update:
                print(f"[DEBUG] H5FileCache - Updating cache for previously locked file {file_path}")
                try:
                    self.force_refresh_cache(file_path)
                    # Notify handlers that cache has been updated
                    self._notify_handlers_cache_updated(file_path)
                except Exception as e:
                    print(f"[WARN] H5FileCache - Failed to update cache for {file_path}: {e}")
    
    def _notify_handlers_cache_updated(self, file_path: str):
        """Notify handlers that cache has been updated for a file"""
        with self._lock:
            if file_path in self._handlers:
                for handler in self._handlers[file_path]:
                    try:
                        # Trigger a gentle reload without forcing file access
                        handler.load_file(file_path, force_reload=False)
                        print(f"[DEBUG] H5FileCache - Notified handler of cache update for {file_path}")
                    except Exception as e:
                        print(f"[WARN] H5FileCache - Failed to notify handler: {e}")
    
    def start_background_cache_monitor(self):
        """Start background thread to monitor and update caches for unlocked files"""
        def monitor_loop():
            while True:
                try:
                    self.check_and_update_pending_caches()
                    time.sleep(2.0)  # Check every 2 seconds
                except Exception as e:
                    print(f"[ERROR] H5FileCache - Background monitor error: {e}")
                    time.sleep(5.0)  # Wait longer on error
        
        import threading
        monitor_thread = threading.Thread(target=monitor_loop, daemon=True)
        monitor_thread.start()
        print("[DEBUG] H5FileCache - Started background cache monitor")
    

# Global cache instance
_h5_cache = H5FileCache()

# Start background cache monitor
_h5_cache.start_background_cache_monitor()

try:
    from matplotlib.path import Path
    MATPLOTLIB_AVAILABLE = True
except ImportError:
    MATPLOTLIB_AVAILABLE = False
    print("[WARN] Matplotlib not installed. Polygon filtering will fallback to bounding box.")

def safe_load_h5_dataset(dataset):
    """Safely load H5 dataset, handling both scalar and array datasets"""
    try:
        if dataset.shape == ():  # scalar dataset
            return dataset[()]
        else:  # array dataset
            return dataset[:]
    except Exception as e:
        # Fallback: try to load as scalar
        try:
            return dataset[()]
        except Exception as fallback_e:
            print(f"[WARN] Failed to load dataset even as scalar: {fallback_e}")
            return None

@numba.njit(parallel=True, fastmath=True)
def transform_points_numba(points, M):
    # points shape: (N, 2), M shape: (3, 3)
    # Extend points to homogeneous coordinates
    n = points.shape[0]
    result = np.empty_like(points)
    for i in numba.prange(n):
        x, y = points[i,0], points[i,1]
        # Homogeneous coordinate transformation
        new_x = M[0,0]*x + M[0,1]*y + M[0,2]
        new_y = M[1,0]*x + M[1,1]*y + M[1,2]
        result[i,0] = new_x
        result[i,1] = new_y
    return result

def is_file_locked(file_path):
    """check if h5 file is locked"""
    try:
        with h5py.File(file_path, 'r+') as _:
            return False
    except:
        return True

def safe_open_h5_file(file_path: str, mode: str = 'r', max_retries: int = 5, retry_delay: float = 1.0, timeout: float = 30.0):
    """
    Safely open an H5 file with retry logic to handle file locking issues.
    
    Args:
        file_path: Path to the H5 file
        mode: File open mode ('r', 'r+', 'a', 'w')
        max_retries: Maximum number of retry attempts
        retry_delay: Delay between retries in seconds
        timeout: Maximum total time to wait in seconds
        
    Returns:
        h5py.File object or None if failed
        
    Raises:
        OSError: If file cannot be opened after all retries
    """
    start_time = time.time()
    
    for attempt in range(max_retries + 1):
        try:
            # Check if we've exceeded the timeout
            if time.time() - start_time > timeout:
                raise OSError(f"Timeout waiting for file {file_path} to become available after {timeout}s")
            
            # Try to open the file
            h5_file = h5py.File(file_path, mode)
            print(f"[DEBUG] safe_open_h5_file - Successfully opened {file_path} on attempt {attempt + 1}")
            return h5_file
            
        except OSError as e:
            error_msg = str(e).lower()
            
            # Check if it's a file locking error
            if any(keyword in error_msg for keyword in ['lock', 'unable to synchronously open', 'errno = 0', 'getlasterror']):
                if attempt < max_retries:
                    elapsed = time.time() - start_time
                    print(f"[DEBUG] safe_open_h5_file - File {file_path} is locked (attempt {attempt + 1}/{max_retries + 1}), waiting {retry_delay}s (elapsed: {elapsed:.1f}s)")
                    time.sleep(retry_delay)
                    continue
                else:
                    print(f"[ERROR] safe_open_h5_file - Failed to open {file_path} after {max_retries + 1} attempts due to file locking")
                    raise OSError(f"Unable to open file {file_path} after {max_retries + 1} attempts due to file locking: {e}")
            else:
                # Not a locking error, re-raise immediately
                print(f"[ERROR] safe_open_h5_file - Failed to open {file_path} due to non-locking error: {e}")
                raise e
        except Exception as e:
            print(f"[ERROR] safe_open_h5_file - Unexpected error opening {file_path}: {e}")
            raise e
    
    # This should never be reached, but just in case
    raise OSError(f"Failed to open {file_path} after {max_retries + 1} attempts")

def safe_h5_context_manager(file_path: str, mode: str = 'r', max_retries: int = 5, retry_delay: float = 1.0, timeout: float = 30.0):
    """
    Context manager for safely opening H5 files with retry logic.
    
    Usage:
        with safe_h5_context_manager('file.h5', 'a') as hf:
            # Do operations with hf
            pass
    """
    class SafeH5Context:
        def __init__(self, file_path, mode, max_retries, retry_delay, timeout):
            self.file_path = file_path
            self.mode = mode
            self.max_retries = max_retries
            self.retry_delay = retry_delay
            self.timeout = timeout
            self.h5_file = None
            
        def __enter__(self):
            self.h5_file = safe_open_h5_file(
                self.file_path, 
                self.mode, 
                self.max_retries, 
                self.retry_delay, 
                self.timeout
            )
            return self.h5_file
            
        def __exit__(self, exc_type, exc_val, exc_tb):
            if self.h5_file:
                try:
                    self.h5_file.close()
                except Exception as e:
                    print(f"[WARN] safe_h5_context_manager - Error closing file {self.file_path}: {e}")
    
    return SafeH5Context(file_path, mode, max_retries, retry_delay, timeout)

def get_file_path(request_or_params):
    """Extract file path from request parameters"""
    current_file_path = None
    
    # Extract parameters from request object or dict
    if hasattr(request_or_params, 'query_params'):
        # FastAPI Request object
        query_params = request_or_params.query_params
    elif isinstance(request_or_params, dict):
        # Dictionary of parameters
        query_params = request_or_params
    else:
        print(f"[DEBUG] get_file_path - Invalid request_or_params type: {type(request_or_params)}")
        return None
    
    # Try to get relative_path first, then fall back to file_path for compatibility
    file_path = query_params.get('relative_path') or query_params.get('file_path')
    if file_path:
        file_path = resolve_path(file_path)
    
    # If we have a file path, resolve it to an absolute path
    if file_path:
        # Get storage root from centralized path configuration
        from app.config.path_config import STORAGE_ROOT
        
        # Check if the provided path is already absolute
        if os.path.isabs(file_path):
            full_file_path = os.path.normpath(file_path)
        else:
            # If relative, join it with the storage root
            full_file_path = os.path.join(STORAGE_ROOT, file_path.lstrip('/\\'))
            full_file_path = os.path.normpath(full_file_path)
        
        # Security check: Ensure the final path is still within the storage root
        # This is important even for absolute paths to prevent directory traversal
        if not full_file_path.startswith(os.path.normpath(STORAGE_ROOT)):
             # Allow absolute paths outside storage root for local development if they exist
            if os.path.isabs(file_path) and os.path.exists(file_path):
                 pass # Allow it
            else:
                print(f"[DEBUG] get_file_path - Access denied: Path is outside the allowed directory: {full_file_path}")
                return ''
        
        file_path = full_file_path
    
    if not file_path:
        # try to get the current loaded file path from load_service
        try:
            from app.services.load_service import current_file_path
            if current_file_path:
                print(f"[DEBUG] get_file_path - Found from load_service: {current_file_path}")
                
                # if the current file is not a h5 file, try to add the .h5 extension
                if not current_file_path.endswith('.h5'):
                    h5_path = f"{current_file_path}.h5"
                    if os.path.exists(h5_path):
                        file_path = h5_path
                        print(f"[DEBUG] get_file_path - Using related h5 file: {file_path}")
                    else:
                        print(f"[DEBUG] get_file_path - No related h5 file found for: {current_file_path}")
                else:
                    file_path = current_file_path
        except (ImportError, AttributeError):
            print("[DEBUG] get_file_path - Failed to get path from load_service")
    
    current_file_path = file_path
    
    # if the current file is not a h5 file, try to add the .h5 extension
    if current_file_path and not current_file_path.endswith('.h5'):
        h5_path = f"{current_file_path}.h5"
        if os.path.exists(h5_path):
            current_file_path = h5_path
            print(f"[DEBUG] get_file_path - Using related h5 file: {current_file_path}")
        else:
            print(f"[DEBUG] get_file_path - No related h5 file found for: {current_file_path}")
    
    # Additional check: if the file doesn't exist, try to add the .h5 extension
    if current_file_path and not os.path.exists(current_file_path):
        # try to add the .h5 extension
        h5_path = f"{current_file_path}.h5"
        print(f"[DEBUG] get_file_path - Checking with .h5 extension: {h5_path}")
        
        if os.path.exists(h5_path):
            current_file_path = h5_path
            print(f"[DEBUG] get_file_path - Found file with .h5 extension: {current_file_path}")
    
    print(f"[DEBUG] get_file_path - Final path: {current_file_path}")
    return current_file_path

def clear_all_caches_and_reset_handler():
    """clear all caches and reset handler singleton"""
    global _annotations_data
    
    _annotations_data = {}
    
    # clear H5 cache
    _h5_cache.clear_cache()
    
    try:
        handler = SegmentationHandler()
        handler.reset_data()
    except Exception as e:
        print(f"[WARN] Exception while trying to reset SegmentationHandler singleton: {e}")

    print("[DEBUG] All seg_service caches and the SegmentationHandler have been forcefully reset.")
    return {"status": "success", "message": "All caches cleared and handler reset."}

def preload_data(file_path: str):
    """dynamically discover and preload all available datasets in the h5 file"""
    print(f"[DEBUG] preload_data - Starting with file: {file_path}")
    
    # check if the data is already cached with fallback for locked files
    cached_data = _h5_cache.get_cached_data_fallback(file_path)
    if cached_data:
        print(f"[DEBUG] preload_data - using cached data: {file_path}")
        return
    
    # Check if file is locked and skip preload if no cache available
    if _h5_cache.is_file_locked(file_path):
        print(f"[DEBUG] preload_data - File {file_path} is locked and no cache available, skipping preload")
        return
    
    start_time = time.time()

    def should_skip_dataset(name: str) -> bool:
        """Return True if this dataset key should be ignored when caching (e.g., embeddings)."""
        lowered = name.lower()
        skip_tokens = [
            'embedding', 'embeddings', 'embed',
            'umap', 'tsne', 'pca',
            'feature', 'features'
        ]
        return any(token in lowered for token in skip_tokens)

    def load_group_datasets(group, prefix=""):
        """recursively load all datasets in the group"""
        data = {}
        for key in group.keys():
            full_key = f"{prefix}_{key}" if prefix else key
            try:
                if isinstance(group[key], h5py.Dataset):
                    # skip unwanted datasets (e.g., embeddings/features)
                    if should_skip_dataset(full_key):
                        print(f"[DEBUG] preload_data - Skipping dataset (ignored): {full_key}")
                        continue
                    dataset = safe_load_h5_dataset(group[key])
                    if dataset is not None:
                        data[full_key] = dataset
                        print(f"[DEBUG] preload_data - Loaded {full_key} with shape: {dataset.shape if hasattr(dataset, 'shape') else type(dataset)}")
                    else:
                        print(f"[DEBUG] preload_data - Failed to load {full_key}")
                elif isinstance(group[key], h5py.Group):
                    # recursively process subgroups
                    sub_data = load_group_datasets(group[key], full_key)
                    data.update(sub_data)
            except Exception as e:
                print(f"[DEBUG] preload_data - Failed to load {full_key}: {e}")
        return data

    # Open h5 file and store handle for potential release
    f = h5py.File(file_path, 'r')
    try:
        # Store file handle in cache for potential release
        with _h5_cache._lock:
            _h5_cache._file_handles[file_path] = f
        
        print(f"[DEBUG] preload_data - Available groups/datasets in file: {list(f.keys())}")
        
        cache_data = {}
        
        # iterate over all top-level groups and datasets in the file
        for key in f.keys():
            try:
                if isinstance(f[key], h5py.Dataset):
                    # root level datasets
                    if should_skip_dataset(key):
                        print(f"[DEBUG] preload_data - Skipping root dataset (ignored): {key}")
                        continue
                    data = safe_load_h5_dataset(f[key])
                    if data is not None:
                        cache_data[key] = data
                        print(f"[DEBUG] preload_data - Loaded root dataset {key} with shape: {data.shape if hasattr(data, 'shape') else type(data)}")
                    else:
                        print(f"[DEBUG] preload_data - Failed to load root dataset {key}")
                elif isinstance(f[key], h5py.Group):
                    # groups, recursively load the datasets in the group
                    print(f"[DEBUG] preload_data - Processing group: {key}")
                    group_data = load_group_datasets(f[key], key)
                    cache_data.update(group_data)
            except Exception as e:
                print(f"[DEBUG] preload_data - Failed to process {key}: {e}")
        
        # Load user annotations and add to cache
        try:
            if 'user_annotation' in f:
                user_annotation_group = f['user_annotation']
                
                # Load class counts
                if 'class_counts' in user_annotation_group:
                    raw_data = user_annotation_group['class_counts'][()]
                    cache_data['user_annotation_class_counts'] = raw_data
                    print(f"[DEBUG] preload_data - Loaded user_annotation_class_counts")
                
                # Load patch class counts
                if 'patch_class_counts' in user_annotation_group:
                    raw_data = user_annotation_group['patch_class_counts'][()]
                    cache_data['user_annotation_patch_class_counts'] = raw_data
                    print(f"[DEBUG] preload_data - Loaded user_annotation_patch_class_counts")
                
                # Load tissue annotations
                if 'tissue_annotations' in user_annotation_group:
                    raw_data = user_annotation_group['tissue_annotations'][()]
                    cache_data['tissue_annotations'] = raw_data
                    print(f"[DEBUG] preload_data - Loaded tissue_annotations")
                
                # Load manual annotations for caching
                if 'tissue_annotations' in user_annotation_group:
                    try:
                        raw_bytes = user_annotation_group['tissue_annotations'][()]
                        manual_annotations = json.loads(raw_bytes.decode("utf-8"))
                        cache_data['manual_patch_annotations'] = manual_annotations
                        print(f"[DEBUG] preload_data - Loaded manual_patch_annotations")
                    except Exception as e:
                        print(f"[DEBUG] preload_data - Failed to load manual_patch_annotations: {e}")
                
                # Load nuclei annotations if they exist
                if 'nuclei_annotations' in user_annotation_group:
                    try:
                        raw_bytes = user_annotation_group['nuclei_annotations'][()]
                        manual_annotations = json.loads(raw_bytes.decode("utf-8"))
                        cache_data['manual_nuclei_annotations'] = manual_annotations
                        print(f"[DEBUG] preload_data - Loaded manual_nuclei_annotations")
                    except Exception as e:
                        print(f"[DEBUG] preload_data - Failed to load manual_nuclei_annotations: {e}")
                        
        except Exception as e:
            print(f"[DEBUG] preload_data - Failed to load user annotations: {e}")
        
        # cache all loaded data
        _h5_cache.set_cached_data(file_path, cache_data)
        
        end_time = time.time()
        print(f"[DEBUG] preload_data - completed loading data, time: {end_time - start_time:.2f} seconds")
        print(f"[DEBUG] preload_data - Total datasets loaded: {len(cache_data)}")
        print(f"[DEBUG] preload_data - Loaded datasets: {list(cache_data.keys())}")
        
        # print some statistics  
        for key, data in cache_data.items():
            if hasattr(data, 'shape'):
                print(f"[DEBUG] preload_data - {key}: shape={data.shape}, dtype={data.dtype}")
            else:
                print(f"[DEBUG] preload_data - {key}: type={type(data)}")
        
        # Release h5 file after caching data
        print(f"[DEBUG] preload_data - Releasing h5 file: {file_path}")
        _h5_cache.release_h5_file(file_path)
        
    except Exception as e:
        # Ensure file is closed even if error occurs
        try:
            f.close()
        except:
            pass
        # Remove from file handles if it was added
        with _h5_cache._lock:
            if file_path in _h5_cache._file_handles:
                del _h5_cache._file_handles[file_path]
        raise e

async def preload_data_async(file_path: str):
    """Asynchronous version of preload_data"""
    loop = asyncio.get_event_loop()
    with ThreadPoolExecutor() as executor:
        await loop.run_in_executor(executor, preload_data, file_path)

def release_h5_file(file_path: str) -> bool:
    """Manually release h5 file handle after data is cached"""
    return _h5_cache.release_h5_file(file_path)

def is_h5_file_handle_open(file_path: str) -> bool:
    """Check if a h5 file handle is currently open"""
    return _h5_cache.is_file_handle_open(file_path)

def get_open_h5_file_handles() -> List[str]:
    """Get list of h5 files with open handles"""
    with _h5_cache._lock:
        return list(_h5_cache._file_handles.keys())

def force_release_all_h5_files() -> int:
    """Force release all open h5 file handles"""
    open_handles = get_open_h5_file_handles()
    released_count = 0
    
    for file_path in open_handles:
        if _h5_cache.release_h5_file(file_path):
            released_count += 1
    
    print(f"[DEBUG] force_release_all_h5_files - Released {released_count} h5 file handles")
    return released_count

def force_release_all_file_locks() -> int:
    """Force release all file locks"""
    with _h5_cache._lock:
        locked_files = list(_h5_cache._file_locks.keys())
        for file_path in locked_files:
            _h5_cache.release_file_lock(file_path)
    
    print(f"[DEBUG] force_release_all_file_locks - Released {len(locked_files)} file locks")
    return len(locked_files)

def force_refresh_h5_cache(file_path: str) -> bool:
    """Force refresh H5 cache for a specific file"""
    try:
        print(f"[DEBUG] force_refresh_h5_cache - Force refreshing cache for {file_path}")
        return _h5_cache.force_refresh_cache(file_path)
    except Exception as e:
        print(f"[WARN] force_refresh_h5_cache - Failed to refresh cache for {file_path}: {e}")
        return False

def smart_preload_data(file_path: str, force_reload: bool = False) -> bool:
    """Smart preload data with force reload option"""
    try:
        print(f"[DEBUG] smart_preload_data - Preloading data for {file_path}, force_reload={force_reload}")
        if force_reload:
            # Force refresh cache first
            _h5_cache.force_refresh_cache(file_path)
        # Then preload data
        preload_data(file_path)
        print(f"[DEBUG] smart_preload_data - Successfully preloaded data for {file_path}")
        return True
    except Exception as e:
        print(f"[WARN] smart_preload_data - Failed to preload data for {file_path}: {e}")
        return False

def is_h5_file_changed(file_path: str) -> bool:
    """Check if h5 file has changed since last cache"""
    return _h5_cache.is_file_changed(file_path)

def force_refresh_h5_cache(file_path: str) -> bool:
    """Force refresh cache for a h5 file"""
    return _h5_cache.force_refresh_cache(file_path)

def smart_preload_data(file_path: str, force_reload: bool = False):
    """Smart preload data with optional force reload"""
    if force_reload:
        print(f"[DEBUG] smart_preload_data - Force reload requested for: {file_path}")
        _h5_cache.force_refresh_cache(file_path)
    
    return preload_data(file_path)

def cache_file_structure(file_path: str):
    """cache HDF5 file structure and dataset metadata to the unified cache"""
    # check if the data is already cached
    cached_data = _h5_cache.get_cached_data(file_path)
    if cached_data and 'file_structure' in cached_data:
        return cached_data['file_structure']

    data = {}
    with h5py.File(file_path, 'r') as f:
        def gather_data(name):
            obj = f[name]
            if isinstance(obj, h5py.Dataset):
                data[name] = {
                    "shape": obj.shape,
                    "dtype": str(obj.dtype)
                }
            elif isinstance(obj, h5py.Group):
                data[name] = {"type": "Group"}

        f.visit(gather_data)
    
    # add the file structure information to the cache
    if cached_data:
        cached_data['file_structure'] = data
        _h5_cache.set_cached_data(file_path, cached_data)
    else:
        _h5_cache.set_cached_data(file_path, {'file_structure': data})
    
    return data

def query_viewport(handler: "SegmentationHandler",
                  x1: float, y1: float, x2: float, y2: float,
                  polygon_points: Optional[List[Tuple[float, float]]] = None, # Received in RAW frontend/OSD coordinates
                  class_name: Optional[str] = None, color: Optional[str] = None,
                  file_path: Optional[str] = None) -> Dict:
    """
    Query nuclei within viewport, optionally filtering points strictly inside the provided polygon.
    Coordinates (x1, y1, x2, y2, polygon_points) are expected in the RAW, UNscaled frontend/OSD image coordinate system.
    Internal centroids from HDF5 are assumed to be Level 0 coordinates and need scaling.
    """
    print(f"[DEBUG] query_viewport - Service function called.")
    print(f"[DEBUG] query_viewport - BBox parameters (received raw OSD coords): x1={x1}, y1={y1}, x2={x2}, y2={y2}")
    if polygon_points:
        print(f"[DEBUG] query_viewport - Polygon points received (raw OSD coords): {len(polygon_points)} vertices")
    print(f"[DEBUG] query_viewport - File path: {file_path}")

    # get the centroids data from the cache
    if not file_path:
        raise ValueError("File path is required for query_viewport")
    
    cached_data = _h5_cache.get_cached_data(file_path)
    if not cached_data:
        preload_data(file_path)
        cached_data = _h5_cache.get_cached_data(file_path)
        if not cached_data:
            raise ValueError("No cached data found for file")
    
    # try to get the centroids data from different possible keys
    centroids_data = None
    for key in ['centroids', 'SegmentationNode_centroids']:
        if key in cached_data:
            centroids_data = cached_data[key]
            break
    
    if centroids_data is None:
        raise ValueError("Centroids data not found in cache")

    query_start = time.time()
    original_centroids_level0 = np.array(centroids_data) # Level 0 coordinates from HDF5
    total_centroids = len(original_centroids_level0)
    matching_indices = []

    if total_centroids > 0:
        # --- Scale HDF5 Centroids to Match Frontend Coordinate System ---
        scale_factor = 16
        # Important: Keep as float for accurate comparison and PIP test
        scaled_centroids = original_centroids_level0 * scale_factor
        scaled_centroids_x = scaled_centroids[:, 0]
        scaled_centroids_y = scaled_centroids[:, 1]
        print(f"[DEBUG] query_viewport - Scaled backend centroids Min/Max X: {np.min(scaled_centroids_x)} / {np.max(scaled_centroids_x)}")
        print(f"[DEBUG] query_viewport - Scaled backend centroids Min/Max Y: {np.min(scaled_centroids_y)} / {np.max(scaled_centroids_y)}")
        # ---------------------------------------------------------------

        # 1. Filter by Bounding Box using SCALED backend centroids and RAW frontend bbox
        in_bbox_mask = (
            (x1 <= scaled_centroids_x) & (scaled_centroids_x <= x2) &
            (y1 <= scaled_centroids_y) & (scaled_centroids_y <= y2)
        )
        indices_in_bbox = np.where(in_bbox_mask)[0] # Indices refer to original_centroids_level0 array
        print(f"[DEBUG] query_viewport - Found {len(indices_in_bbox)} points within BBox (using scaled backend centroids).")

        if len(indices_in_bbox) > 0:
            # 2. If Polygon points provided, perform PIP test using SCALED backend centroids and RAW frontend polygon
            if polygon_points and MATPLOTLIB_AVAILABLE:
                print(f"[DEBUG] query_viewport - Performing PIP test on {len(indices_in_bbox)} points (using scaled backend centroids).")
                # Get the SCALED coordinates of points within the bbox
                points_to_test = scaled_centroids[indices_in_bbox]

                try:
                    polygon_path = Path(polygon_points) # Use RAW frontend polygon points
                    tolerance_radius = -1e-9
                    # Test SCALED backend points against RAW frontend polygon path
                    is_inside = polygon_path.contains_points(points_to_test, radius=tolerance_radius)
                    final_indices_mask = np.where(is_inside)[0]
                    matching_indices = indices_in_bbox[final_indices_mask].tolist() # Get original indices
                    print(f"[DEBUG] query_viewport - PIP test completed, {len(matching_indices)} points inside polygon.")
                except Exception as pip_error:
                    print(f"[ERROR] query_viewport - Error during PIP test: {pip_error}")
                    traceback.print_exc()
                    matching_indices = indices_in_bbox.tolist() # Fallback to BBox
                    print("[WARN] query_viewport - Falling back to BBox results due to PIP error.")

            else: # Rectangle or no matplotlib
                 if polygon_points and not MATPLOTLIB_AVAILABLE:
                     print("[WARN] query_viewport - Matplotlib not found. Returning all points within bounding box.")
                 matching_indices = indices_in_bbox.tolist()
        # else: BBox empty, matching_indices remains []
    # else: No centroids, matching_indices remains []

    query_end = time.time()
    print(f"[DEBUG] query_viewport - Found final matching centroids: {len(matching_indices)}/{total_centroids}, time: {query_end - query_start:.2f} seconds")

    # Store annotation colors based on the FINAL matching indices (which are indices into the original Level 0 array)
    if class_name and color and len(matching_indices) > 0:
        handler.store_annotation_color(matching_indices, class_name, color)
        print(f"[DEBUG] query_viewport - Stored annotation color for {len(matching_indices)} indices: class_name={class_name}, color={color}")

    return {
        "viewport": {"x1": x1, "y1": y1, "x2": x2, "y2": y2}, # Return original request bbox
        "matching_indices": matching_indices, # Return indices from the original Level 0 centroid array
        "count": len(matching_indices)
    }

def query_patches_in_viewport(handler: "SegmentationHandler",
                             x1: float, y1: float, x2: float, y2: float,
                             polygon_points: Optional[List[Tuple[float, float]]] = None,
                             file_path: Optional[str] = None) -> Dict:
    """
    Query patches whose centroids fall within the viewport or polygon.
    All coordinates are expected in RAW frontend/OSD coordinate system.
    """
    print(f"[DEBUG] query_patches_in_viewport - Service function called.")
    print(f"[DEBUG] query_patches_in_viewport - BBox parameters (raw OSD coords): x1={x1}, y1={y1}, x2={x2}, y2={y2}")
    if polygon_points:
        print(f"[DEBUG] query_patches_in_viewport - Polygon points received (raw OSD coords): {len(polygon_points)} vertices")

    if not file_path:
        raise ValueError("No file path provided for query_patches_in_viewport")

    handler.ensure_file_loaded_in_cache(file_path) # Use cached read
    if not hasattr(handler, 'patch_coordinates') or handler.patch_coordinates is None:
        # This check is now for after the cache loader has run
        raise ValueError("Patch coordinates data is not loaded or empty after cache check.")

    query_start = time.time()
    original_patch_coords_level0 = np.array(handler.patch_coordinates)
    total_patches = len(original_patch_coords_level0)
    matching_indices = []

    if total_patches > 0:
        # Calculate centroids for all patches (in Level 0 coordinates)
        centroids_x = np.mean(original_patch_coords_level0[:, [0, 2]], axis=1)
        centroids_y = np.mean(original_patch_coords_level0[:, [1, 3]], axis=1)
        
        # Scale factor to match frontend coordinates
        scale_factor = 16
        centroids_x_scaled = centroids_x * scale_factor
        centroids_y_scaled = centroids_y * scale_factor

        if polygon_points and MATPLOTLIB_AVAILABLE:
            # For polygon query, first filter by viewport for optimization
            viewport_mask = (
                (centroids_x_scaled >= x1) & (centroids_x_scaled <= x2) &
                (centroids_y_scaled >= y1) & (centroids_y_scaled <= y2)
            )
            indices_in_viewport = np.where(viewport_mask)[0]
            
            if len(indices_in_viewport) > 0:
                # For polygon filtering, use the viewport-filtered centroids
                points_to_test = np.column_stack((
                    centroids_x_scaled[indices_in_viewport],
                    centroids_y_scaled[indices_in_viewport]
                ))

                try:
                    polygon_path = Path(polygon_points)
                    tolerance_radius = -1e-9
                    is_inside = polygon_path.contains_points(points_to_test, radius=tolerance_radius)
                    final_indices_mask = np.where(is_inside)[0]
                    matching_indices = indices_in_viewport[final_indices_mask].tolist()
                    print(f"[DEBUG] query_patches_in_viewport - After polygon filter: {len(matching_indices)} patch centroids inside polygon.")
                except Exception as pip_error:
                    print(f"[ERROR] query_patches_in_viewport - Error during PIP test: {pip_error}")
                    matching_indices = []
                    print("[WARN] query_patches_in_viewport - Error in polygon test, returning empty result")
        else:
            # For bbox query, use the original bbox coordinates
            bbox_mask = (
                (centroids_x_scaled >= min(x1, x2)) & (centroids_x_scaled <= max(x1, x2)) &
                (centroids_y_scaled >= min(y1, y2)) & (centroids_y_scaled <= max(y1, y2))
            )
            matching_indices = np.where(bbox_mask)[0].tolist()

    query_end = time.time()
    print(f"[DEBUG] query_patches_in_viewport - Found final matching patches: {len(matching_indices)}/{total_patches}, time: {query_end - query_start:.2f} seconds")

    return {
        "viewport": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
        "matching_patch_indices": matching_indices,
        "count": len(matching_indices)
    }

def get_tissues(handler: "SegmentationHandler", file_path: Optional[str] = None) -> Dict:
    """Get tissue data"""
    
    # if a new file path is provided, load it
    if file_path and os.path.exists(file_path):
        handler.ensure_file_loaded_in_cache(file_path) # Use cached read
    else:
        # otherwise use the current loaded file path
        file_path = handler.get_current_file_path()
        if file_path:
            handler.ensure_file_loaded_in_cache(file_path) # Use cached read
        else:
            return {
                "tissues": [],
                "tissue_annotations": {},
                "count": 0
            }
    
    tissues = handler.tissues
    tissue_annotations = handler.get_all_tissue_annotations()
    
    return {
        "tissues": tissues,
        "tissue_annotations": tissue_annotations,
        "count": len(tissues)
    }

def reload_segmentation_data(handler: "SegmentationHandler", path: Optional[str] = None) -> Dict:
    """Reload segmentation data"""
    
    if path:
        handler.load_file(path)
        return {
            "message": f"Successfully reload segmentation data from {path}",
        }
    else:
        current_path = handler.get_current_file_path()
        handler.load_file(current_path)
        return {
            "message": f"Successfully reload segmentation data from {current_path}",
        }

def reset_segmentation_data(handler: "SegmentationHandler") -> Dict:
    """Reset all segmentation data when switching images"""
    handler.reset_data()
    
    return {
        "message": "Successfully reset all segmentation data",
    }

def set_segmentation_types(handler: "SegmentationHandler", tissue_type: Optional[str] = None, nuclei_type: Optional[str] = None, patch_type: Optional[str] = None) -> Dict:
    """Set segmentation types"""
    print(f"tissue_type: {tissue_type}, nuclei_type: {nuclei_type}, patch_type: {patch_type}")
    print(f"handler: {handler}")
    
    if tissue_type:
        handler.set_tissue_segmentation_prefix(tissue_type)
        print(f"handler.set_tissue_segmentation_prefix: {handler.set_tissue_segmentation_prefix}")
        return {
            "message": f"Successfully set tissue type to {tissue_type}",
            "tissue_type": tissue_type
        }
    
    elif nuclei_type:
        handler.set_nuclei_segmentation_prefix(nuclei_type)
        return {
            "message": f"Successfully set nuclei type to {nuclei_type}",
            "nuclei_type": nuclei_type
        }
    
    elif patch_type:
        handler.set_patch_classification_prefix(patch_type)
        return {
            "message": f"Successfully set patch type to {patch_type}",
            "patch_type": patch_type
        }
    
    else:
        raise ValueError("Missing type parameter. Either 'tissue' or 'nuclei' or 'patch' must be provided")

def get_classifications(handler: "SegmentationHandler") -> Dict:
    """Get cell classification data"""
    data = handler.get_cell_classification_data()
    if data is None:
        raise ValueError("No classification data in h5")
    return data

def get_annotation_colors(handler: "SegmentationHandler") -> Dict:
    """Get annotation colors from handler"""
    return handler.get_annotation_colors()

def update_class_color_service(handler: "SegmentationHandler", class_name: str, new_color: str, file_path: str):
    """Service function to update a class color."""
    
    # Ensure the handler is operating on the correct file. This will load it
    # if it's not already the current one.
    handler.ensure_file_loaded_in_cache(file_path)
    
    handler.update_class_color_in_h5(class_name, new_color)
    return {"message": f"Successfully updated color for class '{class_name}' to '{new_color}'."}


class SegmentationHandler:
    BUFFER = 200
    VIEWER_SCALE_FACTOR = 16

    def __init__(self, h5_file_path=None):
        self.h5_file = None
        self.centroids = None
        self.contours = None
        self.tissues = None
        self.probabilities = None
        self.annotations_data = {}
        self.tissue_annotations = {}
        self.kd_tree = None
        self.class_id = None
        self.class_name = None
        self.class_hex_color = None
        self.patch_coordinates = None
        self.patch_centroids = None
        self.patch_class_id = None
        self.patch_class_name = None
        self.patch_class_hex_color = None
        self._whole_slide_counts_cache = None
        self._patch_annotation_counts_cache = None
        self._global_label_counts_cache = None
        self.annotation_colors = {
            "class_id": [],
            "class_name": [],
            "class_hex_color": []
        }
        self.nuclei_model_timestamp = None
        self.patch_model_timestamp = None

        # prefix
        self._nuclei_segmentation_prefix = "SegmentationNode"
        self._tissue_segmentation_prefix = "BiomedParseNode"
        self._classification_prefix = 'ClassificationNode'
        self._patch_classification_prefix = 'MuskNode'

        # Debounce reloads to avoid thrashing on rapid requests
        self._last_load_time = 0.0
        self._min_reload_interval = 0.3

        if h5_file_path:
            self.load_file(h5_file_path)

    def reset_data(self):
        """Reset all data when switching to a new image."""
        # Reset all attributes
        self.h5_file = None
        self.centroids = None
        self.contours = None
        self.tissues = None
        self.probabilities = None
        self.annotations_data = {}
        self.tissue_annotations = {}
        self.patch_coordinates = None
        self.kd_tree = None
        self.class_id = None
        self.class_name = None
        self.class_hex_color = None
        self.annotation_colors = {
            "class_id": [],
            "class_name": [],
            "class_hex_color": []
        }
        
        # Reset patch-related attributes
        self.patch_coordinates = None
        self.patch_centroids = None
        self.patch_class_id = None
        self.patch_class_name = None
        self.patch_class_hex_color = None
        self._whole_slide_counts_cache = None
        self._patch_annotation_counts_cache = None
        
        # clear cache
        _h5_cache.clear_cache()
        

    def update_class_definitions(self, ui_classes: List[str], ui_colors: List[str]):
        """
        Merges class definitions from the UI with the handler's in-memory state.
        This ensures that new classes created in the UI are known to the backend for the session.
        """
        if self.class_name is None: self.class_name = []
        if self.class_hex_color is None: self.class_hex_color = []

        # Convert to lists if they are numpy arrays
        current_names = list(self.class_name)
        current_colors = list(self.class_hex_color)

        for i, name in enumerate(ui_classes):
            if name not in current_names:
                current_names.append(name)
                # Ensure the colors list is extended safely
                if i < len(ui_colors):
                    current_colors.append(ui_colors[i])
                else:
                    current_colors.append("#FFFFFF") # Default color for safety

        self.class_name = np.array(current_names)
        self.class_hex_color = np.array(current_colors)

    def ensure_file_loaded_in_cache(self, h5_file_path: str):
        """
        Ensures the specified H5 file is loaded into the handler's memory cache.
        If the file is already loaded, this function does nothing.
        This prevents re-reading from disk and preserves in-memory state
        like temporary overrides.
        """
        # If the requested file is already loaded in memory, do nothing.
        if self.h5_file == h5_file_path:
            return
        
        # Otherwise, load the new file.
        self.load_file(h5_file_path)

    def load_file(self, h5_file_path, force_reload: bool = True):
        # Fast-path: if the same file is already loaded and caller did not
        # request a hard refresh, keep the in-memory state to preserve
        # temporary overrides and cached data.
        if not force_reload and self.h5_file == h5_file_path:
            # Debounce repeated reloads within a short interval
            now = time.time()
            last = getattr(self, '_last_load_time', 0.0)
            min_interval = getattr(self, '_min_reload_interval', 0.3)
            if (now - last) < min_interval and not getattr(self, '_needs_reload', False):
                return

        self._whole_slide_counts_cache = None
        self._patch_annotation_counts_cache = None
        self._global_label_counts_cache = None

        self.h5_file = h5_file_path
        
        # Register this handler with the cache
        _h5_cache.register_handler(h5_file_path, self)
        
        # Check if handler needs reload due to file change
        if hasattr(self, '_needs_reload') and self._needs_reload:
            print(f"[DEBUG] SegmentationHandler - Handler needs reload due to file change")
            self._needs_reload = False
        
        # Always check for cached data first with fallback for locked files
        cached_data = _h5_cache.get_cached_data_fallback(h5_file_path)
        
        if cached_data:
            # Debug: Print available cache keys
            print(f"[Debug] load_file => Available cache keys: {list(cached_data.keys())}")
            # Use preload_data keys directly
            nuclei_prefix = self.get_nuclei_segmentation_prefix()
            classification_prefix = self.get_classification_prefix()
            patch_prefix = self.get_patch_classification_prefix()

            # Handle centroids and contours from nuclei segmentation
            self.centroids = cached_data.get(f'{nuclei_prefix}_centroids')
            self.contours = cached_data.get(f'{nuclei_prefix}_contours')

            # Handle classification data
            class_id_key = f'{classification_prefix}_nuclei_class_id'
            class_name_key = f'{classification_prefix}_nuclei_class_name'
            class_hex_color_key = f'{classification_prefix}_nuclei_class_HEX_color'
            
            print(f"[Debug] load_file => Looking for classification keys: {class_id_key}, {class_name_key}, {class_hex_color_key}")
            
            self.class_id = cached_data.get(class_id_key)
            raw_class_name = cached_data.get(class_name_key)
            raw_class_hex_color = cached_data.get(class_hex_color_key)
            
            # handle class name and hex color from cache
            if raw_class_name is not None:
                if raw_class_name.dtype.kind == 'S':  # byte string
                    self.class_name = np.array([name.decode('utf-8') for name in raw_class_name])
                else:
                    self.class_name = raw_class_name
                print(f"[Debug] load_file => Loaded nuclei_class_name from cache: {self.class_name}")
            else:
                self.class_name = None
                
            if raw_class_hex_color is not None:
                if raw_class_hex_color.dtype.kind == 'S':  # byte string
                    self.class_hex_color = np.array([color.decode('utf-8') for color in raw_class_hex_color])
                else:
                    self.class_hex_color = raw_class_hex_color
                print(f"[Debug] load_file => Loaded nuclei_class_HEX_color from cache: {self.class_hex_color}")
            else:
                self.class_hex_color = None
            
            # Debug: Print classification data loading status
            print(f"[Debug] load_file => class_id: {self.class_id is not None}, class_name: {self.class_name is not None}, class_hex_color: {self.class_hex_color is not None}")
            
            # Check if classification data is missing and needs to be initialized
            if self.class_id is None or self.class_name is None or self.class_hex_color is None:
                print(f"[Debug] load_file => Classification data missing, will be initialized by manual annotations")

            # Handle patch classification data
            self.patch_coordinates = cached_data.get(f'{patch_prefix}_coordinates')
            self.patch_centroids = cached_data.get(f'{patch_prefix}_centroids')
            self.patch_class_id = cached_data.get(f'{patch_prefix}_tissue_class_id')
            self.patch_class_name = cached_data.get(f'{patch_prefix}_tissue_class_name')
            self.patch_class_hex_color = cached_data.get(f'{patch_prefix}_tissue_class_HEX_color')

            # Handle other data
            self.tissues = cached_data.get('tissues', [])
            self.annotations_data = cached_data.get('annotations_data', {})
            self.tissue_annotations = cached_data.get('tissue_annotations', {})
            
            # Update annotation colors if classification data is available
            if self.class_id is not None and self.class_name is not None and self.class_hex_color is not None:
                self.annotation_colors = {
                    "class_id": self.class_id.tolist() if hasattr(self.class_id, 'tolist') else self.class_id,
                    "class_name": self.class_name.tolist() if hasattr(self.class_name, 'tolist') else self.class_name,
                    "class_hex_color": self.class_hex_color.tolist() if hasattr(self.class_hex_color, 'tolist') else self.class_hex_color
                }
            
            # Build KD tree if centroids are available
            if self.centroids is not None and self.contours is not None:
                self.kd_tree = KDTree(self.centroids)
            
            # Ensure patch_coordinates present when loading from cache
            if self.patch_coordinates is None:
                coord_key = f"{self.get_patch_classification_prefix()}_coordinates"
                if coord_key in cached_data:
                    self.patch_coordinates = cached_data[coord_key]
            # Recover patch classification arrays if they exist in cache but not in state
            prefix = self.get_patch_classification_prefix()
            if self.patch_class_id is None:
                key = f"{prefix}_tissue_class_id"
                if key in cached_data:
                    self.patch_class_id = cached_data[key]
            if self.patch_class_name is None:
                key = f"{prefix}_tissue_class_name"
                if key in cached_data and cached_data[key] is not None:
                    self.patch_class_name = [n.decode('utf-8') for n in cached_data[key]]
            if self.patch_class_hex_color is None:
                key = f"{prefix}_tissue_class_HEX_color"
                if key in cached_data and cached_data[key] is not None:
                    self.patch_class_hex_color = [c.decode('utf-8') for c in cached_data[key]]

            # recover tissue_annotations dict for color overrides
            if not self.tissue_annotations and 'tissue_annotations' in cached_data:
                self.tissue_annotations = cached_data['tissue_annotations']

            # Ensure patch_centroids are available when loading from cache
            if self.patch_centroids is None and self.patch_coordinates is not None:
                self.patch_centroids = self.get_patch_centroids()
                # Update cache to include newly generated centroids
                cached_data[f'{patch_prefix}_centroids'] = self.patch_centroids
                _h5_cache.set_cached_data(h5_file_path, cached_data)
            
            # Only apply manual annotations if classification data is missing or incomplete
            # This prevents duplicate application of manual annotations
            needs_manual_annotations = (
                self.class_id is None or 
                self.class_name is None or 
                self.class_hex_color is None or
                len(self.class_name) == 0
            )
            
            if needs_manual_annotations:
                print(f"[Debug] load_file => Classification data missing or incomplete, applying manual annotations for {h5_file_path}")
                try:
                    # Check if manual annotations are already in cache
                    if 'manual_patch_annotations' in cached_data and 'manual_nuclei_annotations' in cached_data:
                        print(f"[Debug] load_file => Manual annotations already in cache, applying from cache")
                        # Apply from cache data
                        self._apply_manual_patch_annotations_from_cache(cached_data)
                        self._apply_manual_nuclei_annotations_from_cache(cached_data)
                    else:
                        # Only access H5 file if manual annotations are not in cache
                        print(f"[Debug] load_file => Manual annotations not in cache, need to access H5 file")
                        # Check if file is locked before attempting to open
                        if _h5_cache.is_file_locked(h5_file_path):
                            print(f"[Debug] load_file => File {h5_file_path} is locked, checking for any existing manual annotations in cache...")
                            
                            # Try to get any existing manual annotations from cache, even if stale
                            with _h5_cache._lock:
                                if h5_file_path in _h5_cache._cache:
                                    cache_entry = _h5_cache._cache[h5_file_path]
                                    cache_data = cache_entry['data']
                                    if 'manual_patch_annotations' in cache_data or 'manual_nuclei_annotations' in cache_data:
                                        print(f"[Debug] load_file => Found existing manual annotations in cache for locked file, using cached data")
                                        self._apply_manual_patch_annotations_from_cache(cache_data)
                                        self._apply_manual_nuclei_annotations_from_cache(cache_data)
                                        return
                                    else:
                                        # Even if no manual annotations, try to use any available cached data
                                        print(f"[Debug] load_file => No manual annotations in cache, but using any available cached data for locked file")
                                        return
                            
                            print(f"[Debug] load_file => No cache available for locked file, waiting briefly...")
                            max_wait_time = 2.0  # Further reduced wait time since we prioritize cache
                            wait_start = time.time()
                            while _h5_cache.is_file_locked(h5_file_path) and (time.time() - wait_start) < max_wait_time:
                                time.sleep(0.1)
                            
                            if _h5_cache.is_file_locked(h5_file_path):
                                print(f"[WARN] load_file => File {h5_file_path} is still locked after {max_wait_time}s, using any available cached data")
                                return
                        
                        # We need to open the h5 file to apply manual annotations
                        with h5py.File(h5_file_path, 'r') as h5_file:
                            self._apply_manual_patch_annotations(h5_file)
                            self._apply_manual_nuclei_annotations(h5_file)
                except Exception as e:
                    print(f"[WARN] Failed to apply manual annotations from cache: {e}")
                    traceback.print_exc()
            else:
                print(f"[Debug] load_file => Classification data already complete, skipping manual annotations")
            
            # Check classification data after processing
            print(f"[Debug] load_file => Final classification data - class_id: {self.class_id is not None}, class_name: {self.class_name is not None}, class_hex_color: {self.class_hex_color is not None}")
            if self.class_name is not None:
                print(f"[Debug] load_file => Final class_name: {self.class_name}")
            if self.class_hex_color is not None:
                print(f"[Debug] load_file => Final class_hex_color: {self.class_hex_color}")
            # Update last load time on cache hit
            self._last_load_time = time.time()
            return
        
        # Load from file if not cached
        start_time = time.time()
        
        # Check if file is locked before attempting to open
        if _h5_cache.is_file_locked(h5_file_path):
            print(f"[Debug] load_file => File {h5_file_path} is locked, waiting before loading from file...")
            max_wait_time = 10.0  # Wait up to 10 seconds
            wait_start = time.time()
            while _h5_cache.is_file_locked(h5_file_path) and (time.time() - wait_start) < max_wait_time:
                time.sleep(0.1)
            
            if _h5_cache.is_file_locked(h5_file_path):
                print(f"[WARN] load_file => File {h5_file_path} is still locked after {max_wait_time}s, cannot load from file")
                return
        
        with h5py.File(h5_file_path, 'r') as h5_file:

            # 1. Load patch coordinates first - this is essential for array sizing
            patch_classification_prefix = self.get_patch_classification_prefix()
            if patch_classification_prefix in h5_file:
                group = h5_file[patch_classification_prefix]
                if "coordinates" in group:
                    self.patch_coordinates = safe_load_h5_dataset(group["coordinates"])
                    if self.patch_coordinates is not None:
                        print(f"[Debug] load_file => patch_coordinates shape: {self.patch_coordinates.shape}")
                        self.patch_centroids = self.get_patch_centroids()
                        print(f"[Debug] load_file => patch_centroids shape: {self.patch_centroids.shape if self.patch_centroids is not None else 'None'}")
                    else:
                        print("[Debug] load_file => Failed to load patch_coordinates")

            # 2. Load model's classification results if they exist
            if patch_classification_prefix in h5_file:
                group = h5_file[patch_classification_prefix]
                if "tissue_class_id" in group:
                    self.patch_class_id = safe_load_h5_dataset(group["tissue_class_id"])
                    if self.patch_class_id is not None:
                        print(f"[Debug] load_file => patch_class_id shape: {self.patch_class_id.shape}")
                    else:
                        print("[Debug] load_file => Failed to load patch_class_id")
                if "tissue_class_name" in group:
                    raw_names = safe_load_h5_dataset(group["tissue_class_name"])
                    if raw_names is not None and len(raw_names) > 0:
                        self.patch_class_name = [name.decode('utf-8') for name in raw_names]
                        print(f"[Debug] load_file => patch_class_name: {self.patch_class_name}")
                    else:
                        print("[Debug] load_file => Failed to load patch_class_name")
                if "tissue_class_HEX_color" in group:
                    raw_colors = safe_load_h5_dataset(group["tissue_class_HEX_color"])
                    if raw_colors is not None and len(raw_colors) > 0:
                        self.patch_class_hex_color = [color.decode('utf-8') for color in raw_colors]
                        print(f"[Debug] load_file => patch_class_hex_color: {self.patch_class_hex_color}")
                    else:
                        print("[Debug] load_file => Failed to load patch_class_hex_color")
                if 'metadata' in group:
                    metadata_str = group['metadata'][()].decode('utf-8')
                    metadata = json.loads(metadata_str)
                    self.patch_model_timestamp = metadata.get('created')
            
            self.annotations_data = {}
            self.tissue_annotations = {}

            nuclei_segmentaion_prefix = self.get_nuclei_segmentation_prefix()
            centroids_path = f"{nuclei_segmentaion_prefix}/centroids"
            contours_path = f"{nuclei_segmentaion_prefix}/contours"
            if centroids_path in h5_file:
                self.centroids = safe_load_h5_dataset(h5_file[centroids_path])
                if self.centroids is not None:
                    print(f"[Debug] load_file => centroids shape: {self.centroids.shape}")
                else:
                    print("[Debug] load_file => Failed to load centroids")
            if contours_path in h5_file:
                self.contours = safe_load_h5_dataset(h5_file[contours_path])
                if self.contours is not None:
                    print(f"[Debug] load_file => contours shape: {self.contours.shape}")
                else:
                    print("[Debug] load_file => Failed to load contours")
            
            # 2) classification to get class_id, class_name, class_hex_color
            classification_prefix = self.get_classification_prefix()
            if classification_prefix in h5_file:
                group = h5_file[classification_prefix]
                if "nuclei_class_id" in group:
                    self.class_id = safe_load_h5_dataset(group["nuclei_class_id"])
                if "nuclei_class_name" in group:
                    raw_names = safe_load_h5_dataset(group["nuclei_class_name"])
                    if raw_names is not None:
                        # handle class name from file
                        if raw_names.dtype.kind == 'S':  # byte string
                            self.class_name = np.array([name.decode('utf-8') for name in raw_names])
                        else:
                            self.class_name = raw_names.astype('U')
                        print(f"[Debug] load_file => Loaded nuclei_class_name: {self.class_name}")
                    else:
                        print("[Debug] load_file => Failed to load nuclei_class_name")
                if "nuclei_class_HEX_color" in group:
                    raw_colors = safe_load_h5_dataset(group["nuclei_class_HEX_color"])
                    if raw_colors is not None:
                        # handle class hex color from file
                        if raw_colors.dtype.kind == 'S':  # byte string
                            self.class_hex_color = np.array([color.decode('utf-8') for color in raw_colors])
                        else:
                            self.class_hex_color = raw_colors.astype('U')
                        print(f"[Debug] load_file => Loaded nuclei_class_HEX_color: {self.class_hex_color}")
                    else:
                        print("[Debug] load_file => Failed to load nuclei_class_HEX_color")
                if 'metadata' in group:
                    metadata_str = group['metadata'][()].decode('utf-8')
                    metadata = json.loads(metadata_str)
                    self.nuclei_model_timestamp = metadata.get('created')
                print(f"[{classification_prefix}] => class_id={set(self.class_id) if self.class_id is not None else None}, class_name={set(self.class_name) if self.class_name is not None else None}, class_hex_color={set(self.class_hex_color) if self.class_hex_color is not None else None}")

                # update to local cache
                if self.class_id is not None and self.class_name is not None and self.class_hex_color is not None:
                    # ensure all data are string format, avoid JSON serialization error
                    class_name_list = [str(name) for name in self.class_name.tolist()]
                    class_hex_color_list = [str(color) for color in self.class_hex_color.tolist()]
                    
                    self.annotation_colors = {
                        "class_id": self.class_id.tolist(),
                        "class_name": class_name_list,
                        "class_hex_color": class_hex_color_list
                    }
                    
            # 3. Apply manual overrides
            self._apply_manual_patch_annotations(h5_file)
            self._apply_manual_nuclei_annotations(h5_file)

            # 3) tissue segmentation
            self.tissues = []
            tissue_segmentaion_prefix = self.get_tissue_segmentation_prefix()
            tissue_output = f"/{tissue_segmentaion_prefix}/output"

            if tissue_output in h5_file:
                dataset = h5_file[tissue_output]
                data = dataset[()]

                if isinstance(data, bytes):
                    decoded_data = data.decode('utf-8', errors='ignore')
                    try:
                        json_data = json.loads(decoded_data)
                        if "contours" in json_data and isinstance(json_data["contours"], list):
                            self.tissues = [
                                {"id": idx, "points": contour}
                                for idx, contour in enumerate(json_data["contours"])
                            ]
                            print(f"Loaded {len(self.tissues)} contours into tissue data.")
                    except json.JSONDecodeError:
                        print("Error: Unable to parse JSON from /BiomedParseNode/output.")

            # 4) patch classification
            patch_classification_prefix = self.get_patch_classification_prefix()
            print('===============================================')
            print(f"[Debug] patch_classification_prefix: {patch_classification_prefix}")
            print('===============================================')
            if patch_classification_prefix in h5_file:
                group = h5_file[patch_classification_prefix]
                if "coordinates" in group:
                    self.patch_coordinates = safe_load_h5_dataset(group["coordinates"])
                    if self.patch_coordinates is not None:
                        print(f"[Debug] load_file => patch_coordinates shape: {self.patch_coordinates.shape}")
                        self.patch_centroids = self.get_patch_centroids()
                        print(f"[Debug] load_file => patch_centroids shape: {self.patch_centroids.shape}")
                    else:
                        print("[Debug] load_file => Failed to load patch_coordinates")
                if "tissue_class_id" in group:
                    self.patch_class_id = safe_load_h5_dataset(group["tissue_class_id"])
                    if self.patch_class_id is not None:
                        print(f"[Debug] load_file => patch_class_id shape: {self.patch_class_id.shape}")
                    else:
                        print("[Debug] load_file => Failed to load patch_class_id")
                if "tissue_class_name" in group:
                    self.patch_class_name = safe_load_h5_dataset(group["tissue_class_name"])
                    if self.patch_class_name is not None:
                        print(f"[Debug] load_file => patch_class_name shape: {self.patch_class_name.shape}")
                    else:
                        print("[Debug] load_file => Failed to load patch_class_name")
                if "tissue_class_HEX_color" in group:
                    self.patch_class_hex_color = safe_load_h5_dataset(group["tissue_class_HEX_color"])
                    if self.patch_class_hex_color is not None:
                        print(f"[Debug] load_file => patch_class_hex_color shape: {self.patch_class_hex_color.shape}")
                    else:
                        print("[Debug] load_file => Failed to load patch_class_hex_color")
            
            # Cache the loaded data
            nuclei_prefix = self.get_nuclei_segmentation_prefix()
            classification_prefix = self.get_classification_prefix()
            patch_prefix = self.get_patch_classification_prefix()
            cache_data = {
                f'{nuclei_prefix}_centroids': self.centroids,
                f'{nuclei_prefix}_contours': self.contours,
                f'{classification_prefix}_nuclei_class_id': self.class_id,
                f'{classification_prefix}_nuclei_class_name': self.class_name,
                f'{classification_prefix}_nuclei_class_HEX_color': self.class_hex_color,
                f'{patch_prefix}_coordinates': self.patch_coordinates,
                f'{patch_prefix}_centroids': self.patch_centroids,
                f'{patch_prefix}_tissue_class_id': self.patch_class_id,
                f'{patch_prefix}_tissue_class_name': self.patch_class_name,
                f'{patch_prefix}_tissue_class_HEX_color': self.patch_class_hex_color,
                'tissues': self.tissues,
                'annotations_data': self.annotations_data,
                'tissue_annotations': self.tissue_annotations
            }
            _h5_cache.set_cached_data(h5_file_path, cache_data)
        
        end_time = time.time()
        print(f"[Debug] load_file => completed loading from file, time: {end_time - start_time:.2f} seconds")

        # Initialize other attributes
        self.annotations_data = {}
        self.tissue_annotations = {}
        if (self.centroids is not None) and (self.contours is not None):
            self.kd_tree = KDTree(self.centroids)

            self._user_annotation_counts_cache = None  # Invalidate counts cache on load
            print("[DEBUG] load_file: Invalidated user counts cache.")

        # Update last load time on file read
        self._last_load_time = time.time()

    def _apply_manual_patch_annotations_from_cache(self, cached_data):
        """Apply manual patch annotations from cached data"""
        print("[Debug] Applying manual patch annotations from cache...")
        if 'manual_patch_annotations' not in cached_data:
            print("[Debug] No manual patch annotations found in cache.")
            return
        
        try:
            manual_annotations = cached_data['manual_patch_annotations']
        except Exception as e:
            print(f"[Error] Failed to load manual annotations from cache: {e}")
            return
            
        if not manual_annotations:
            print("[Debug] Manual annotations are empty.")
            return
        
        # Apply the same logic as the original method but using cached data
        self._apply_manual_patch_annotations_logic(manual_annotations)
    
    def _apply_manual_patch_annotations_logic(self, manual_annotations):
        """Apply manual patch annotations logic using cached data"""
        print("[Debug] Applying manual patch annotations logic from cache...")
        
        if not manual_annotations:
            print("[Debug] Manual patch annotations are empty.")
            return
        
        # Initialize patch_class_id if not exists
        if not hasattr(self, 'patch_class_id') or self.patch_class_id is None:
            if hasattr(self, 'patch_centroids') and self.patch_centroids is not None:
                self.patch_class_id = np.full(len(self.patch_centroids), -1, dtype=int)
            else:
                print("[Error] Cannot apply manual patch annotations without patch centroids data.")
                return
        
        # Process each manual annotation
        for ann_id, annotation in manual_annotations.items():
            patch_id = annotation.get("patch_ID")
            class_name = annotation.get("class_name")
            
            if patch_id is None or class_name is None:
                continue
            
            # Check bounds
            if 0 <= patch_id < len(self.patch_class_id):
                # Find or create class ID
                if not hasattr(self, 'patch_class_name') or self.patch_class_name is None:
                    self.patch_class_name = []
                    self.patch_class_hex_color = []
                
                if class_name not in self.patch_class_name:
                    self.patch_class_name.append(class_name)
                    self.patch_class_hex_color.append(annotation.get('class_color', '#808080'))
                
                target_class_id = self.patch_class_name.index(class_name)
                self.patch_class_id[patch_id] = target_class_id
            else:
                print(f"[Warning] Manual annotation patch_ID {patch_id} is out of bounds.")
        
        print("[Debug] Finished applying manual patch annotations logic from cache.")
    
    def _apply_manual_nuclei_annotations_from_cache(self, cached_data):
        """Apply manual nuclei annotations from cached data"""
        print("[Debug] Applying manual nuclei annotations from cache...")
        if 'manual_nuclei_annotations' not in cached_data:
            print("[Debug] No manual nuclei annotations found in cache.")
            return
        
        try:
            manual_annotations = cached_data['manual_nuclei_annotations']
        except Exception as e:
            print(f"[Error] Failed to load manual nuclei annotations from cache: {e}")
            return
            
        if not manual_annotations:
            print("[Debug] Manual nuclei annotations are empty.")
            return
        
        # Apply the same logic as the original method but using cached data
        self._apply_manual_nuclei_annotations_logic(manual_annotations)

    def _apply_manual_nuclei_annotations_logic(self, manual_annotations):
        """Apply manual nuclei annotations logic using cached data"""
        print("[Debug] Applying manual nuclei annotations logic from cache...")
        
        if not manual_annotations:
            print("[Debug] Manual annotations are empty.")
            return

        # Scenario 1: No model data exists, initialize everything from manual annotations
        if self.class_name is None:
            print("[Debug] No model classification found. Initializing from manual annotations.")
            
            if self.centroids is None:
                print("[Error] Cannot apply manual annotations without centroids data. Aborting.")
                return

            # Create a mapping from class name to a new integer ID
            all_manual_classes = sorted(list(set(item['cell_class'] for item in manual_annotations.values())))
            
            # Ensure "Negative control" is present and first if needed
            if "Negative control" not in all_manual_classes:
                self.class_name = ["Negative control"] + all_manual_classes
            else:
                self.class_name = ["Negative control"] + [cls for cls in all_manual_classes if cls != "Negative control"]

            # Default all nuclei to UNCLASSIFIED (-1) until explicitly annotated
            self.class_id = np.full(len(self.centroids), -1, dtype=int)
            
            # Extract colors, defaulting if necessary
            color_map = {item['cell_class']: item['cell_color'] for item in manual_annotations.values()}
            self.class_hex_color = [color_map.get(name, "#808080") for name in self.class_name]
            if "Negative control" in self.class_name and "Negative control" not in color_map:
                 nc_index = self.class_name.index("Negative control")
                 self.class_hex_color[nc_index] = "#aaaaaa" # Default color for negative control

            print(f"[Debug] Initialized with classes: {self.class_name}")

        # Now, proceed with overriding based on the (potentially just created) class mapping
        class_to_id_map = {name: i for i, name in enumerate(self.class_name)}
        
        # Pre-allocate lists for better performance
        class_name_list = list(self.class_name)
        class_hex_color_list = list(self.class_hex_color)
        
        # Batch process annotations for better performance
        valid_annotations = []
        new_classes = {}
        
        # First pass: collect valid annotations and new classes
        for ann_id, annotation in manual_annotations.items():
            nucleus_id = annotation.get("cell_ID")
            class_name = annotation.get("cell_class")

            if nucleus_id is None or class_name is None:
                continue
                
            # Check timestamp if available
            user_ts_str = annotation.get('datetime')
            if user_ts_str and self.nuclei_model_timestamp:
                try:
                    user_ts = datetime.strptime(user_ts_str, '%Y-%m-%d %H:%M:%S.%f')
                    model_ts = datetime.fromisoformat(self.nuclei_model_timestamp)
                    if user_ts <= model_ts:
                        continue
                except ValueError:
                    pass
            
            # Check bounds
            if 0 <= nucleus_id < len(self.class_id):
                valid_annotations.append((nucleus_id, class_name, annotation.get('cell_color', '#808080')))
                
                # Track new classes
                if class_name not in class_to_id_map:
                    new_classes[class_name] = annotation.get('cell_color', '#808080')
            else:
                print(f"[Warning] Manual annotation cell_ID {nucleus_id} is out of bounds.")
        
        # Add new classes in batch
        if new_classes:
            print(f"[Debug] Found {len(new_classes)} new classes in manual annotations.")
            for class_name, color in new_classes.items():
                # Check if class already exists to avoid duplicates
                if class_name not in class_to_id_map:
                    new_id = len(class_name_list)
                    class_name_list.append(class_name)
                    class_hex_color_list.append(color)
                    class_to_id_map[class_name] = new_id
                else:
                    print(f"[Debug] Class '{class_name}' already exists, skipping duplicate.")
        
        # Second pass: apply annotations in batch
        for nucleus_id, class_name, color in valid_annotations:
            target_class_id = class_to_id_map[class_name]
            self.class_id[nucleus_id] = target_class_id
        
        # Convert back to numpy arrays
        self.class_name = np.array(class_name_list)
        self.class_hex_color = np.array(class_hex_color_list)
        
        # Mark as processed to avoid reprocessing for this specific file
        self._manual_annotations_processed = True
        self._processed_file = getattr(self, 'h5_file', None)
        
        print("[Debug] Finished applying manual nuclei annotations logic from cache.")

    def _apply_manual_patch_annotations(self, h5_file):
        print("[Debug] Applying manual patch annotations...")
        if 'user_annotation' not in h5_file or 'tissue_annotations' not in h5_file['user_annotation']:
            print("[Debug] No manual tissue annotations found in H5 file.")
            return

        try:
            raw_bytes = h5_file['user_annotation/tissue_annotations'][()]
            manual_annotations = json.loads(raw_bytes.decode("utf-8"))
        except Exception as e:
            print(f"[Error] Failed to load or parse manual annotations: {e}")
            return
            
        if not manual_annotations:
            print("[Debug] Manual annotations are empty.")
            return

        # Scenario 1: No model data exists, initialize everything from manual annotations
        if self.patch_class_name is None:
            print("[Debug] No model classification found. Initializing from manual annotations.")
            
            if self.patch_coordinates is None:
                print("[Error] Cannot apply manual annotations without patch coordinates. Aborting.")
                return

            # Create a mapping from class name to a new integer ID
            all_manual_classes = sorted(list(set(item['tissue_class'] for item in manual_annotations.values())))
            
            # Ensure "Negative control" is present and first if needed
            if "Negative control" not in all_manual_classes:
                self.patch_class_name = ["Negative control"] + all_manual_classes
            else:
                self.patch_class_name = ["Negative control"] + [cls for cls in all_manual_classes if cls != "Negative control"]

            self.patch_class_id = np.full(len(self.patch_coordinates), -1, dtype=int) # Default all to unclassified (-1)
            
            # Extract colors, defaulting if necessary
            color_map = {item['tissue_class']: item['tissue_color'] for item in manual_annotations.values()}
            self.patch_class_hex_color = [color_map.get(name, "#808080") for name in self.patch_class_name]
            if "Negative control" in self.patch_class_name and "Negative control" not in color_map:
                 nc_index = self.patch_class_name.index("Negative control")
                 self.patch_class_hex_color[nc_index] = "#aaaaaa" # Default color for negative control

            print(f"[Debug] Initialized with classes: {self.patch_class_name}")
        else:
            # Ensure mutable Python lists for appending new classes/colors
            if isinstance(self.patch_class_name, np.ndarray):
                try:
                    self.patch_class_name = self.patch_class_name.tolist()
                except Exception:
                    self.patch_class_name = list(self.patch_class_name)
            if self.patch_class_hex_color is None:
                self.patch_class_hex_color = []
            elif isinstance(self.patch_class_hex_color, np.ndarray):
                try:
                    self.patch_class_hex_color = self.patch_class_hex_color.tolist()
                except Exception:
                    self.patch_class_hex_color = list(self.patch_class_hex_color)

        # Now, proceed with overriding based on the (potentially just created) class mapping
        class_to_id_map = {name: i for i, name in enumerate(self.patch_class_name)}
        
        for patch_id_str, annotation in manual_annotations.items():
            try:
                patch_id = int(patch_id_str)
            except (ValueError, TypeError):
                continue

            class_name = annotation.get("tissue_class")

            if class_name is None:
                continue

            # Check if the manually annotated class exists in our current list.
            if class_name not in class_to_id_map:
                print(f"[Debug] New class '{class_name}' found in manual annotations. Adding to list.")
                new_id = len(self.patch_class_name)
                self.patch_class_name.append(class_name)
                self.patch_class_hex_color.append(annotation.get('tissue_color', '#808080'))
                class_to_id_map[class_name] = new_id

            # Get the ID for the class and update the patch_class_id array
            target_class_id = class_to_id_map[class_name]
            
            if 0 <= patch_id < len(self.patch_class_id):
                user_ts_str = annotation.get('datetime')
                if user_ts_str and self.patch_model_timestamp:
                    try:
                        user_ts = datetime.strptime(user_ts_str, '%Y-%m-%d %H:%M:%S.%f')
                        model_ts = datetime.fromisoformat(self.patch_model_timestamp)
                        if user_ts <= model_ts:
                            continue
                    except ValueError as ve:
                        pass
                self.patch_class_id[patch_id] = target_class_id
                # print(f"[Debug] Overrode patch {patch_id} with class '{class_name}' (ID: {target_class_id})")
            else:
                print(f"[Warning] Manual annotation patch_ID {patch_id} is out of bounds.")
        
        print("[Debug] Finished applying manual patch annotations.")
        
    def _apply_manual_nuclei_annotations(self, h5_file):
        print("[Debug] Applying manual nuclei annotations...")
        
        # Check if we've already processed this file's annotations for this specific file
        current_file = getattr(self, 'h5_file', None)
        if (hasattr(self, '_manual_annotations_processed') and 
            self._manual_annotations_processed and 
            hasattr(self, '_processed_file') and 
            self._processed_file == current_file):
            print("[Debug] Manual annotations already processed for this file, skipping.")
            return
            
        if 'user_annotation' not in h5_file or 'nuclei_annotations' not in h5_file['user_annotation']:
            print("[Debug] No manual nuclei annotations found in H5 file.")
            # Initialize default classification data if none exists
            if self.class_name is None and self.centroids is not None:
                print("[Debug] Initializing default classification data.")
                self.class_name = ["Negative control"]
                self.class_hex_color = ["#aaaaaa"]
                self.class_id = np.full(len(self.centroids), -1, dtype=int)
                print(f"[Debug] Initialized with default classes: {self.class_name}")
            self._manual_annotations_processed = True
            return

        try:
            raw_bytes = h5_file['user_annotation/nuclei_annotations'][()]
            manual_annotations = json.loads(raw_bytes.decode("utf-8"))
        except Exception as e:
            print(f"[Error] Failed to load or parse manual annotations: {e}")
            return
            
        if not manual_annotations:
            print("[Debug] Manual annotations are empty.")
            return

        # Scenario 1: No model data exists, initialize everything from manual annotations
        if self.class_name is None:
            print("[Debug] No model classification found. Initializing from manual annotations.")
            
            if self.centroids is None:
                print("[Error] Cannot apply manual annotations without centroids data. Aborting.")
                return

            # Create a mapping from class name to a new integer ID
            all_manual_classes = sorted(list(set(item['cell_class'] for item in manual_annotations.values())))
            
            # Ensure "Negative control" is present and first if needed
            if "Negative control" not in all_manual_classes:
                self.class_name = ["Negative control"] + all_manual_classes
            else:
                self.class_name = ["Negative control"] + [cls for cls in all_manual_classes if cls != "Negative control"]

            # Default all nuclei to UNCLASSIFIED (-1) until explicitly annotated
            self.class_id = np.full(len(self.centroids), -1, dtype=int)
            
            # Extract colors, defaulting if necessary
            color_map = {item['cell_class']: item['cell_color'] for item in manual_annotations.values()}
            self.class_hex_color = [color_map.get(name, "#808080") for name in self.class_name]
            if "Negative control" in self.class_name and "Negative control" not in color_map:
                 nc_index = self.class_name.index("Negative control")
                 self.class_hex_color[nc_index] = "#aaaaaa" # Default color for negative control

            print(f"[Debug] Initialized with classes: {self.class_name}")

        # Now, proceed with overriding based on the (potentially just created) class mapping
        class_to_id_map = {name: i for i, name in enumerate(self.class_name)}
        
        # Pre-allocate lists for better performance
        class_name_list = list(self.class_name)
        class_hex_color_list = list(self.class_hex_color)
        
        # Batch process annotations for better performance
        valid_annotations = []
        new_classes = {}
        
        # First pass: collect valid annotations and new classes
        for ann_id, annotation in manual_annotations.items():
            nucleus_id = annotation.get("cell_ID")
            class_name = annotation.get("cell_class")

            if nucleus_id is None or class_name is None:
                continue
                
            # Check timestamp if available
            user_ts_str = annotation.get('datetime')
            if user_ts_str and self.nuclei_model_timestamp:
                try:
                    user_ts = datetime.strptime(user_ts_str, '%Y-%m-%d %H:%M:%S.%f')
                    model_ts = datetime.fromisoformat(self.nuclei_model_timestamp)
                    if user_ts <= model_ts:
                        continue
                except ValueError:
                    pass
            
            # Check bounds
            if 0 <= nucleus_id < len(self.class_id):
                valid_annotations.append((nucleus_id, class_name, annotation.get('cell_color', '#808080')))
                
                # Track new classes
                if class_name not in class_to_id_map:
                    new_classes[class_name] = annotation.get('cell_color', '#808080')
            else:
                print(f"[Warning] Manual annotation cell_ID {nucleus_id} is out of bounds.")
        
        # Add new classes in batch
        if new_classes:
            print(f"[Debug] Found {len(new_classes)} new classes in manual annotations.")
            for class_name, color in new_classes.items():
                # Check if class already exists to avoid duplicates
                if class_name not in class_to_id_map:
                    new_id = len(class_name_list)
                    class_name_list.append(class_name)
                    class_hex_color_list.append(color)
                    class_to_id_map[class_name] = new_id
                else:
                    print(f"[Debug] Class '{class_name}' already exists, skipping duplicate.")
        
        # Second pass: apply annotations in batch
        for nucleus_id, class_name, color in valid_annotations:
            target_class_id = class_to_id_map[class_name]
            self.class_id[nucleus_id] = target_class_id
        
        # Convert back to numpy arrays
        self.class_name = np.array(class_name_list)
        self.class_hex_color = np.array(class_hex_color_list)
        
        # Mark as processed to avoid reprocessing for this specific file
        self._manual_annotations_processed = True
        self._processed_file = getattr(self, 'h5_file', None)
        
        print("[Debug] Finished applying manual nuclei annotations.")

    def set_classification_prefix(self, prefix):
        """set prefix for classification result"""
        self._classification_prefix = prefix

    def get_classification_prefix(self):
        """get prefix for classification result"""
        return self._classification_prefix
    
    def set_nuclei_segmentation_prefix(self, prefix):
        """set prefix for nuclei segmentation result"""
        self._nuclei_segmentation_prefix = prefix

    def get_nuclei_segmentation_prefix(self):
        """get prefix for nuclei segmentation result"""
        return self._nuclei_segmentation_prefix
    
    def set_tissue_segmentation_prefix(self, prefix):
        """set prefix for tissue segmentation result"""
        self._tissue_segmentation_prefix = prefix
    
    def get_patch_classification_prefix(self):
        """get prefix for patch classification result"""
        return self._patch_classification_prefix
    
    def set_patch_classification_prefix(self, prefix):
        """set prefix for patch classification result"""
        self._patch_classification_prefix = prefix

    def get_tissue_segmentation_prefix(self):
        """get prefix for tissue segmentation result"""
        return self._tissue_segmentation_prefix
    
    def get_patch_classification(self):
        """get patch classification result"""
        patch_class_id_instances = getattr(self, 'patch_class_id', None)
        patch_class_name = getattr(self, 'patch_class_name', None)
        patch_class_hex_color = getattr(self, 'patch_class_hex_color', None)

        processed_class_name = patch_class_name
        processed_class_hex_color = patch_class_hex_color

        if processed_class_name is not None:
            if hasattr(processed_class_name, 'tolist'):
                processed_class_name = processed_class_name.tolist()
            if isinstance(processed_class_name, list):
                # Decode bytes to utf-8 if necessary
                processed_class_name = [item.decode('utf-8') if isinstance(item, bytes) else str(item) for item in processed_class_name]
            elif isinstance(processed_class_name, bytes):
                processed_class_name = [processed_class_name.decode('utf-8')]
            else:
                processed_class_name = [str(processed_class_name)]
        else:
            processed_class_name = []

        if processed_class_hex_color is not None:
            if hasattr(processed_class_hex_color, 'tolist'):
                processed_class_hex_color = processed_class_hex_color.tolist()
            if isinstance(processed_class_hex_color, list):
                # Decode bytes to utf-8 if necessary
                processed_class_hex_color = [item.decode('utf-8') if isinstance(item, bytes) else str(item) for item in processed_class_hex_color]
            elif isinstance(processed_class_hex_color, bytes):
                processed_class_hex_color = [processed_class_hex_color.decode('utf-8')]
            else:
                processed_class_hex_color = [str(processed_class_hex_color)]
        else:
            processed_class_hex_color = []

        # The defined class IDs are the indices of the class name array
        defined_class_ids = list(range(len(processed_class_name)))

        # Load counts from the dedicated H5 dataset
        class_counts = [0] * len(processed_class_name)
        try:
            # Try to get from cache first
            cached_data = _h5_cache.get_cached_data(self.h5_file)
            if cached_data and 'user_annotation_patch_class_counts' in cached_data:
                raw_data = cached_data['user_annotation_patch_class_counts']
                if isinstance(raw_data, bytes):
                    counts_dict = json.loads(raw_data.decode('utf-8'))
                else:
                    counts_dict = json.loads(raw_data)
                
                name_to_id = {name: i for i, name in enumerate(processed_class_name)}
                for name, count in counts_dict.items():
                    if name in name_to_id:
                        class_counts[name_to_id[name]] = count
            else:
                # Cache-first approach: if not in cache, trigger cache refresh
                print(f"[Debug] get_patch_annotation_counts => Data not in cache, triggering cache refresh for {self.h5_file}")
                try:
                    # Use the new refresh mechanism
                    if _h5_cache.refresh_cache_with_reload(self.h5_file):
                        # Try cache again after refresh
                        cached_data = _h5_cache.get_cached_data(self.h5_file)
                        if cached_data and 'user_annotation_patch_class_counts' in cached_data:
                            raw_data = cached_data['user_annotation_patch_class_counts']
                            if isinstance(raw_data, bytes):
                                counts_dict = json.loads(raw_data.decode('utf-8'))
                            else:
                                counts_dict = json.loads(raw_data)
                            
                            name_to_id = {name: i for i, name in enumerate(processed_class_name)}
                            for name, count in counts_dict.items():
                                if name in name_to_id:
                                    class_counts[name_to_id[name]] = count
                        else:
                            print(f"[Debug] get_patch_annotation_counts => Still no data in cache after refresh, using empty counts")
                    else:
                        print(f"[Debug] get_patch_annotation_counts => Failed to refresh cache, using empty counts")
                except Exception as e:
                    print(f"[WARN] get_patch_annotation_counts => Failed to refresh cache: {e}, using empty counts")
        except Exception as e:
            print(f"Could not load patch_class_counts, defaulting to zeros. Error: {e}")
            # Fallback to zeros is the default behavior now

        # Final check to ensure all lists have same length as class_name list
        # This can happen if H5 file is inconsistent
        num_classes = len(processed_class_name)
        if len(defined_class_ids) != num_classes: defined_class_ids = list(range(num_classes))
        if len(processed_class_hex_color) != num_classes: processed_class_hex_color = ["#aaaaaa"] * num_classes
        if len(class_counts) != num_classes: class_counts = [0] * num_classes

        return defined_class_ids, processed_class_name, processed_class_hex_color, class_counts
    
    def get_current_file_path(self):
        if self.h5_file:
            return self.h5_file
        return None

    def clear_annotations_cache(self):
        self.annotations_data = {}
        self.tissue_annotations = {}
    
    #   classification
    def get_cell_classification_data(self):
        # defensive programming
        print(f"[Debug] file locked => {is_file_locked(self.h5_file)}")
        self.load_file(self.get_current_file_path(), force_reload=True)

        # If there are no base classifications from the H5 file, there's nothing to return.
        print(f"[Debug] get_cell_classification_data => class_id: {self.class_id is not None}, class_name: {self.class_name is not None}, class_hex_color: {self.class_hex_color is not None}")
        if self.class_id is None or self.class_name is None or self.class_hex_color is None:
            print(f"[Debug] get_cell_classification_data => Missing classification data, returning None")
            return None

        print(f"[Debug] get_cell_classification_data => base class_id shape: {self.class_id.shape}")

        effective_class_ids = np.copy(self.class_id)

        # Apply active learning reclassifications if available
        try:
            from app.services.active_learning_service import _reclassified_cells
            h5_path = self.get_current_file_path()

            if h5_path in _reclassified_cells:
                reclassified_data = _reclassified_cells[h5_path]

                # Convert class names to IDs for reclassification
                class_name_to_id = {name: idx for idx, name in enumerate(self.class_name)}

                for cell_id_str, reclassify_info in reclassified_data.items():
                    try:
                        cell_id = int(cell_id_str)
                        new_class_name = reclassify_info["new_class"]

                        if cell_id < len(effective_class_ids) and new_class_name in class_name_to_id:
                            new_class_id = class_name_to_id[new_class_name]
                            old_class_id = effective_class_ids[cell_id]
                            effective_class_ids[cell_id] = new_class_id
                    except (ValueError, KeyError) as e:
                        continue
        except Exception as e:
            pass

        return {
            "nuclei_class_id": effective_class_ids.tolist(),
            "nuclei_class_name": [str(name) for name in self.class_name] if self.class_name is not None else [],
            "nuclei_class_HEX_color": [str(color) for color in self.class_hex_color] if self.class_hex_color is not None else []
        }

    def store_annotation_color(self, indices, class_name, color):
        """Store the color for the given indices."""
        for idx in indices:
            self.annotation_colors["class_id"].append(idx)
            self.annotation_colors["class_name"].append(class_name)
            self.annotation_colors["class_hex_color"].append(color)

    def get_annotation_color(self, index):
        """Get the color for the given index."""
        try:
            if 0 <= index < len(self.annotation_colors["class_id"]) and index in self.annotation_colors["class_id"]:
                idx = self.annotation_colors["class_id"].index(index)
                if 0 <= idx < len(self.annotation_colors["class_name"]) and 0 <= idx < len(self.annotation_colors["class_hex_color"]):
                    return {
                        "class_name": self.annotation_colors["class_name"][idx],
                        "class_hex_color": self.annotation_colors["class_hex_color"][idx]
                    }
        except (ValueError, IndexError) as e:
            print(f"[Debug] Error getting annotation color for index {index}: {str(e)}")
        return None
    
    def get_annotation_colors(self):
        """Get all annotation colors."""
        return self.annotation_colors

    def create_annotation(self, index, contour, color="#808080", class_id: Optional[Any] = None, class_name: Optional[str] = None, is_patch: bool = False):
        if not isinstance(contour, np.ndarray):
            contour_np = np.array(contour)
        else:
            contour_np = contour

        # Legacy check for old (2, K) format. The new format is (K, 2).
        if contour_np.ndim == 2 and contour_np.shape[0] == 2:
            print(f"[create_annotation] WARNING: Received legacy (2, K) contour format for index {index}. Transposing. Please update the data source to provide (K, 2) format.")
            contour_np = contour_np.T

        # Validate if contour_np is now (K, 2) with K >= 3
        if not (contour_np.ndim == 2 and contour_np.shape[1] == 2 and contour_np.shape[0] >= 3):
            print(f"[create_annotation] Warning: Contour for index {index} has invalid shape {contour_np.shape} after potential transpose. Expected (K, 2) with K >= 3. Skipping.")
            return None

        # Step 3: Points generation and single scaling (VIEWER_SCALE_FACTOR)
        # contour_np is now guaranteed to be (K, 2) XY
        try:
            points = [
                [float(x) * self.VIEWER_SCALE_FACTOR, float(y) * self.VIEWER_SCALE_FACTOR]
                for x, y in contour_np # Iterates over rows (points) of (K,2) array
            ]
        except Exception as e:
            print(f"[create_annotation] Error processing points for contour index {index}, shape {contour_np.shape}: {e}.")
            return None

        if not points or len(points) < 3: # A valid polygon needs at least 3 points
            print(f"[create_annotation] Warning: Contour for index {index} resulted in < 3 points after processing. Points: {points}")
            return None

        annotation_id = str(index)

        if isinstance(color, bytes):
            color = color.decode('utf-8')

        if not is_patch and index in self.annotations_data:
            return self.annotations_data[index]

        effective_color = color
        if not is_patch:
            try:
                if self.class_id is not None and self.class_name is not None and self.class_hex_color is not None and \
                   0 <= index < len(self.class_id) and \
                   0 <= self.class_id[index] < len(self.class_hex_color) and \
                   0 <= self.class_id[index] < len(self.class_name) : # Ensure index is valid for classification arrays
                    
                    assigned_class_id_val = self.class_id[index] # This is the value of the class ID for this nucleus
                    effective_color = self.class_hex_color[assigned_class_id_val]
                    
                    if isinstance(effective_color, bytes):
                        effective_color = effective_color.decode('utf-8')

                # 3. Fallback for older annotation style (deprecated but safe)
                elif index in self.annotation_colors["class_id"]:
                    stored_idx_pos = self.annotation_colors["class_id"].index(index)
                    if 0 <= stored_idx_pos < len(self.annotation_colors["class_hex_color"]):
                        effective_color = self.annotation_colors["class_hex_color"][stored_idx_pos]
                        if isinstance(effective_color, bytes):
                           effective_color = effective_color.decode('utf-8')
            except (ValueError, IndexError, TypeError) as e:
                print(f"[Debug] Error getting stored/classified color for nucleus index {index}: {str(e)}, using provided/default color: {color}")
                effective_color = color

        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        bounds = {
            "minX": min(xs), "minY": min(ys),
            "maxX": max(xs), "maxY": max(ys)
        }

        unique_id = str(index)
        style_body = {
            "id": unique_id, "annotation": unique_id, "type": "TextualBody",
            "purpose": "style", "value": effective_color,
            "created": datetime.now().isoformat(),
            "creator": {"id": "default", "type": "AI"}
        }

        annotation_target_selector = {
            "type": "POLYGON",
            "geometry": {"points": points, "bounds": bounds}
        }

        if is_patch:
            if class_id is not None: annotation_target_selector["class_id"] = class_id
            if class_name: annotation_target_selector["class_name"] = class_name
            annotation_target_selector["class_hex_color"] = effective_color # Should be the class color for patch

        annotation = {
            "id": unique_id, "type": "Annotation", "bodies": [style_body],
            "target": {"annotation": unique_id, "selector": annotation_target_selector},
            "creator": {"isGuest": True, "id": "nrESYlDUe8L1qF6Ffhq4"}, # Example
            "created": datetime.now().isoformat()
        }

        self.annotations_data[index] = annotation
        return annotation

    def create_tissue_annotation(self):
        """
        default color is yellow。
        """
        if not self.tissues:
            print("No tissue polygons loaded.")
            return

        for tissue in self.tissues:
            index = tissue["id"]
            contour = tissue["points"]

            points = [[float(x) * 16, float(y) * 16] for x, y in contour]
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            bounds = {
                "minX": min(xs),
                "minY": min(ys),
                "maxX": max(xs),
                "maxY": max(ys)
            }

            unique_id = str(index)
            tissue_color = "#ffff00"

            style_body = {
                "id": unique_id,
                "annotation": unique_id,
                "type": "TextualBody",
                "purpose": "style",
                "value": tissue_color,
                "created": datetime.now().isoformat(),
                "creator": {
                    "id": "default",
                    "type": "AI"
                }
            }

            annotation = {
                "id": unique_id,
                "type": "Annotation",
                "bodies": [style_body],
                "target": {
                    "annotation": unique_id,
                    "selector": {
                        "type": "POLYGON",
                        "geometry": {
                            "points": points,
                            "bounds": bounds
                        }
                    }
                },
                "creator": {
                    "isGuest": True,
                    "id": "nrESYlDUe8L1qF6Ffhq4"
                },
                "created": datetime.now().isoformat()
            }

            self.tissue_annotations[index] = annotation

    def get_all_tissue_annotations(self):
        """Get all tissue annotations."""
        # first create tissue annotations
        self.create_tissue_annotation()
        # return in list format
        return list(self.tissue_annotations.values())

    def get_all_annotations(self):
        """
        normal annotation。
        """
        return list(self.annotations_data.values())

    def get_annotations_in_viewport(self, x1, y1, x2, y2, use_classification=False):
        print(f"[Debug] get_annotations_in_viewport => use_classification={use_classification}")
        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        radius = max(x2 - x1, y2 - y1) / 2
        radius = radius * 1.2 # add 20% buffer
        points_in_view = self.kd_tree.query_ball_point([center_x, center_y], r=radius) if self.kd_tree else []

        annotations = []
        for idx in points_in_view:
            contour = self.contours[idx]

            # The color logic is now entirely handled by create_annotation,
            # which checks temporary_overrides first. We just need to pass a default.
            annotation = self.create_annotation(idx, contour, color="#808080")
            if annotation:
                annotations.append(annotation)

        counts = self.get_all_nuclei_counts()
        return annotations, counts

    def get_clusters_in_viewport(self, x1, y1, x2, y2):
        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        radius = max(x2 - x1, y2 - y1) / 2 + self.BUFFER
        indices_in_view = self.kd_tree.query_ball_point([center_x, center_y], r=radius) if self.kd_tree else []
        points = (self.centroids[indices_in_view] * 16.0).tolist()
        return points

    def get_centroids_in_viewport(self, x1, y1, x2, y2):
        # Check if handler needs reload due to file change
        if hasattr(self, '_needs_reload') and self._needs_reload:
            print(f"[DEBUG] SegmentationHandler - Reloading data due to file change")
            self.load_file(self.h5_file)
        
        # return points
        if self.centroids is None or self.kd_tree is None:
            print("[Warning] get_centroids_in_viewport => but centroids is None")
            return [], {}
        
        # Debug: Print classification data status
        print(f"[Debug] get_centroids_in_viewport => class_id: {self.class_id is not None}, class_name: {self.class_name is not None}, class_hex_color: {self.class_hex_color is not None}")
        if self.class_id is not None:
            print(f"[Debug] get_centroids_in_viewport => class_id shape: {self.class_id.shape}")
        if self.class_name is not None:
            print(f"[Debug] get_centroids_in_viewport => class_name: {self.class_name}")
        if self.class_hex_color is not None:
            print(f"[Debug] get_centroids_in_viewport => class_hex_color: {self.class_hex_color}")
        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        width = x2 - x1
        height = y2 - y1
        diagonal = math.sqrt(width ** 2 + height ** 2)
        radius = diagonal / 2 + self.BUFFER
        indices_in_view = self.kd_tree.query_ball_point([center_x, center_y], r=radius) if self.kd_tree else []

        points = []
        for idx in indices_in_view:
            effective_class_id = -1  # Default to unclassified
            if self.class_id is not None and idx < len(self.class_id):
                effective_class_id = self.class_id[idx]

            # 3. Add point with its class_id to the list for the frontend.
            points.append([
                idx,
                float(self.centroids[idx][0]) * self.VIEWER_SCALE_FACTOR,
                float(self.centroids[idx][1]) * self.VIEWER_SCALE_FACTOR,
                int(effective_class_id)
            ])
                
        counts = self.get_all_nuclei_counts()
        
        # Add color information to the response
        result = counts.copy()
        if self.class_name is not None and self.class_hex_color is not None:
            result['class_names'] = self.class_name.tolist() if hasattr(self.class_name, 'tolist') else list(self.class_name)
            result['class_colors'] = self.class_hex_color.tolist() if hasattr(self.class_hex_color, 'tolist') else list(self.class_hex_color)
            print(f"[Debug] get_centroids_in_viewport => Added color info: class_names={result['class_names']}, class_colors={result['class_colors']}")
        
        return points, result

    def get_centroids_in_viewport_matrix(self, x1, y1, x2, y2, params):
        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        width = x2 - x1
        height = y2 - y1
        diagonal = math.sqrt(width ** 2 + height ** 2)
        radius = diagonal / 2 + self.BUFFER

        indices_in_view = self.kd_tree.query_ball_point([center_x, center_y], r=radius) if self.kd_tree else []
        if len(indices_in_view) == 0:
            return []

        # Obtain points to be transformed (in image coordinates)
        points = self.centroids[indices_in_view] * 16.0

        zoom = params.get("zoom")
        contentBounds = params.get("contentBounds")
        contentSize = params.get("contentSize")
        container_size = params["containerSize"]
        bounds = params["bounds"]
        margins = params["margins"]

        # Construct the affine transformation matrix (image -> viewport -> viewer)
        # image -> viewport
        # viewport_x = (image_x / contentSize['x']) * contentBounds['width'] + contentBounds['x']
        # viewport_y = (image_y / contentSize['x']) * contentBounds['width'] + contentBounds['y']
        s = contentBounds['width'] / contentSize['x']
        M_image_to_viewport = np.array([
            [s,   0, contentBounds['x']],
            [0,   s, contentBounds['y']],
            [0,   0, 1]
        ], dtype=np.float64)

        # viewport -> viewer
        # scale = container_size["width"] / bounds["width"]
        scale = container_size["width"] / bounds["width"]
        # viewer_x = (viewport_x - bounds['x']) * scale + margins['left']
        # viewer_y = (viewport_y - bounds['y']) * scale + margins['top']
        M_viewport_to_viewer = np.array([
            [scale,     0, (-bounds['x'])*scale + margins['left']],
            [0,     scale, (-bounds['y'])*scale + margins['top']],
            [0,         0, 1]
        ], dtype=np.float64)

        # Merge matrices
        M = M_viewport_to_viewer @ M_image_to_viewport

        # Use Numba to accelerate the point transformation
        pixel_points = transform_points_numba(points, M)
        return pixel_points.tolist()

    def imageToViewportCoordinates(self, image_x, image_y, zoom, contentBounds, contentSize):
        """
        Converts image coordinates to viewport coordinates.

        Args:
            image_x (float): X coordinate in image space.
            image_y (float): Y coordinate in image space.
            zoom (float): The current zoom level.
            contentBounds (dict): contentBounds
            contentSize (dict): contentSize

        Returns:
            list[float, float]: viewport coordinates [x, y].
        """
        # Calculate scale factor
        scale = contentBounds['width']
        delta_x = image_x / contentSize['x'] * scale
        delta_y = image_y / contentSize['x'] * scale

        # Adjust with content bounds
        viewport_x = delta_x + contentBounds['x']
        viewport_y = delta_y + contentBounds['y']

        return [viewport_x, viewport_y]

    def viewportToViewerElementCoordinates(self, viewport_x, viewport_y, container_size, bounds, margins, rotation_degrees):
        """
        Converts viewport coordinates to viewer element coordinates, applying rotation.

        Args:
            viewport_x (float): X coordinate in viewport space.
            viewport_y (float): Y coordinate in viewport space.
            container_size (dict): Dictionary containing the container's width and height.
            bounds (dict): Dictionary containing the content bounds {x, y, width, height}.
            margins (dict): Dictionary containing margins {left, top}.
            rotation_degrees (float): Rotation angle in degrees.

        Returns:
            list[float, float]: Viewer element coordinates [viewer_x, viewer_y].
        """
        # Calculate the container scale
        scale_x = container_size["width"] / bounds["width"]
        scale_y = container_size["height"] / bounds["height"]

        # Normalize viewport coordinates relative to bounds
        normalized_x = viewport_x - bounds["x"]
        normalized_y = viewport_y - bounds["y"]

        # Apply rotation
        radians = math.radians(rotation_degrees)
        if rotation_degrees in [-90, 90]:  # Handle axis swap for 90-degree rotations
            rotated_x = normalized_y * math.sin(radians) + normalized_x * math.cos(radians)
            rotated_y = normalized_y * math.cos(radians) - normalized_x * math.sin(radians)
        else:
            rotated_x = normalized_x * math.cos(radians) - normalized_y * math.sin(radians)
            rotated_y = normalized_x * math.sin(radians) + normalized_y * math.cos(radians)

        # Scale to viewer element size and add margins
        viewer_x = rotated_x * scale_x + margins["left"]
        viewer_y = rotated_y * scale_y + margins["top"]

        return [viewer_x, viewer_y]

    def get_annotations(self, offset=0, limit=None):
        """
        get normal annotations.
        
        Parameters:
            offset (int): start index
            limit (int, optional): the max number of annotations to return
            
        Returns:
            tuple: (annotations list, total count)
        """

        print(f"[Debug] offset: {offset}, type: {type(offset)}")
        print(f"[Debug] limit: {limit}, tyoe: {type(limit)}")
        
        # Convert parameters to integer type
        try:
            offset = int(offset)
        except (ValueError, TypeError):
            print(f"[Debug] Failed to convert offset, using default value 0")
            offset = 0
            
        if limit is not None:
            try:
                limit = int(limit)
            except (ValueError, TypeError):
                print(f"[Debug] Failed to convert limit, using default value 100")
                limit = 100
        
        annotations = []
        total_count = len(self.centroids) if self.centroids is not None else 0
        
        # check if there is centroids and contours data
        if self.centroids is not None and self.contours is not None:
            # determine the end index
            print(len(self.centroids))
            if limit is None:
                print(f"[Debug] limit is None")
                end_idx = len(self.centroids)
            else:
                print(f"[Debug] limit is not None") 
                try:
                    # Make sure limit is an integer
                    limit = int(limit)
                    end_idx = offset + limit
                except (ValueError, TypeError):
                    print(f"[Debug] limit is not a valid number, using default value")
                    end_idx = len(self.centroids)
            
            print(f"[Debug] end_idx={end_idx}")
            print(f"[Debug] get_annotations => offset={offset}, limit={limit}, end_idx={end_idx}")
            
            # iterate over the specified range of indices
            for idx in range(offset, end_idx):
                if idx >= len(self.centroids):
                    break
                    
                if idx in self.annotations_data:
                    annotations.append(self.annotations_data[idx])
                    print(f"[Debug] append 1 => idx={idx}, annotations={self.annotations_data[idx]}")
                else:
                    contour = self.contours[idx]
                    # check if there is classification data
                    if self.class_id is not None and idx < len(self.class_id):
                        c_id = self.class_id[idx]
                        if c_id < len(self.class_hex_color):
                            color = self.class_hex_color[c_id]
                        else:
                            color = "#ff0000"
                    else:
                        color = "#ff0000"
                    
                    annotation = self.create_annotation(idx, contour, color)
                    annotations.append(annotation)
                    print(f"[Debug] append 2 => idx={idx}, annotations={annotation}")

        
        return annotations, total_count

    def save_patch_classification_to_file(self, file_path, format_type="json") -> bool:
        """
        save patch classification results to file, including coordinates, classification ID, name and color information.
        """
        try:
            # ensure we have data to save
            if not hasattr(self, 'patch_coordinates') or self.patch_coordinates is None:
                print("no patch data to export")
                return False

            def decode_if_bytes(data):
                """decode bytes type data to string"""
                if isinstance(data, bytes):
                    return data.decode('utf-8')
                elif isinstance(data, np.ndarray):
                    return [decode_if_bytes(item) for item in data]
                elif isinstance(data, list):
                    return [decode_if_bytes(item) for item in data]
                return data

            patch_data = []
            for i in range(len(self.patch_coordinates)):
                patch = {
                    "id": i,
                    "coordinates": self.patch_coordinates[i].tolist() if self.patch_coordinates is not None else [],
                    "class_id": int(self.patch_class_id[i]) if self.patch_class_id is not None and i < len(self.patch_class_id) else -1,
                    "class_name": decode_if_bytes(self.patch_class_name[self.patch_class_id[i]]) if self.patch_class_name is not None and self.patch_class_id is not None and i < len(self.patch_class_id) else "",
                    "class_hex_color": decode_if_bytes(self.patch_class_hex_color[self.patch_class_id[i]]) if self.patch_class_hex_color is not None and self.patch_class_id is not None and i < len(self.patch_class_id) else "#ff0000"
                }
                patch_data.append(patch)

            if format_type.lower() == "json":
                with open(file_path, 'w', encoding='utf-8') as f:
                    json.dump(patch_data, f, ensure_ascii=False, indent=4)
            elif format_type.lower() == "csv":
                import csv
                with open(file_path, 'w', newline='', encoding='utf-8') as f:
                    writer = csv.writer(f)
                    # write header
                    writer.writerow(["id", "x1", "y1", "x2", "y2", "class_id", "class_name", "class_hex_color"])
                    
                    # write data rows
                    for i in range(len(self.patch_coordinates)):
                        coords = self.patch_coordinates[i]
                        class_id = self.patch_class_id[i] if self.patch_class_id is not None and i < len(self.patch_class_id) else -1
                        class_name = decode_if_bytes(self.patch_class_name[i]) if self.patch_class_name is not None and i < len(self.patch_class_name) else ""
                        class_color = decode_if_bytes(self.patch_class_hex_color[i]) if self.patch_class_hex_color is not None and i < len(self.patch_class_hex_color) else "#ff0000"
                        
                        writer.writerow([
                            i,              # patch id
                            coords[0],      # x1
                            coords[1],      # y1
                            coords[2],      # x2
                            coords[3],      # y2
                            class_id,       # class_id
                            class_name,     # class_name
                            class_color     # class_hex_color
                        ])
            else:
                print(f"unsupported file format: {format_type}, supported formats are csv or json")
                return False
            return True
        except Exception as e:
            print(f"save patch classification to file error: {str(e)}")
            return False

    def save_classification_to_file(self, file_path, format_type="json"):
        """
        Save classification results (annotation_colors) to a CSV or JSON file.

        Parameters:
            file_path (str): Output file path
            format_type (str): File format, supports "csv" or "json", default is "json"

        Returns:
            bool: Returns True if successful, otherwise False
        """
        try:
            # Make sure we have data to save
            if not self.annotation_colors or not self.annotation_colors.get("class_id") or len(self.annotation_colors["class_id"]) == 0:
                print("No classification data to export")
                return False

            if format_type.lower() == "json":
                with open(file_path, 'w', encoding='utf-8') as f:
                    json.dump(self.annotation_colors, f, ensure_ascii=False, indent=4)
            elif format_type.lower() == "csv":
                import csv

                # Get the arrays
                class_ids = self.annotation_colors.get("class_id", [])
                class_names = self.annotation_colors.get("class_name", [])
                class_colors = self.annotation_colors.get("class_hex_color", [])
                
                with open(file_path, 'w', newline='', encoding='utf-8') as f:
                    writer = csv.writer(f)
                    # Write header row with four columns
                    writer.writerow(["id", "class_id", "class_name", "class_hex_color"])
                    
                    # Write data rows
                    for i in range(len(class_ids)):
                        class_id = class_ids[i]
                        
                        # Get corresponding name and color based on class_id
                        class_name = ""
                        class_color = ""
                        if 0 <= class_id < len(class_names):
                            class_name = class_names[class_id]
                        if 0 <= class_id < len(class_colors):
                            class_color = class_colors[class_id]
                            
                        writer.writerow([
                            i,              # id (index)
                            class_id,       # class_id value
                            class_name,     # class_name corresponding to class_id
                            class_color     # class_hex_color corresponding to class_id
                        ])
            else:
                print(f"Unsupported file format: {format_type}, supported formats are csv or json")
                return False
            return True
        except Exception as e:
            print(f"Error saving classification results to file: {str(e)}")
            return False

    def save_segmentation_to_file(self, file_path, format_type="json"):
        """
        Save segmentation results (centroids and contours) to a CSV or JSON file.

        Parameters:
            file_path (str): Output file path
            format_type (str): File format, supports "csv" or "json", default is "json"

        Returns:
            bool: Returns True if successful, otherwise False
        """
        try:
            # Make sure we have data to save, use empty arrays if not available
            centroids_data = self.centroids.tolist() if self.centroids is not None else []
            contours_data = self.contours.tolist() if self.contours is not None else []
            
            segmentation_data = []
            for i in range(len(centroids_data)):
                nucleus = {
                    "id": i,
                    "centroid": centroids_data[i],
                    "contour": contours_data[i],
                    "class_id": self.annotation_colors["class_id"][i] if i < len(self.annotation_colors.get("class_id", [])) else -1,
                    "class_name": self.annotation_colors["class_name"][self.annotation_colors["class_id"][i]] if i < len(self.annotation_colors.get("class_id", [])) and self.annotation_colors["class_id"][i] < len(self.annotation_colors.get("class_name", [])) else "",
                    "class_hex_color": self.annotation_colors["class_hex_color"][self.annotation_colors["class_id"][i]] if i < len(self.annotation_colors.get("class_id", [])) and self.annotation_colors["class_id"][i] < len(self.annotation_colors.get("class_hex_color", [])) else "#ff0000"
                }
                segmentation_data.append(nucleus)
            
            if format_type.lower() == "json":
                with open(file_path, 'w', encoding='utf-8') as f:
                    json.dump(segmentation_data, f, ensure_ascii=False, indent=4)
            elif format_type.lower() == "csv":
                import csv
                
                with open(file_path, 'w', newline='', encoding='utf-8') as f:
                    writer = csv.writer(f)
                    # Write header row
                    writer.writerow(["id", "centroid_x", "centroid_y", "contour", "class_id", "class_name", "class_hex_color"])
                    
                    # Write data rows
                    for i in range(len(centroids_data)):
                        class_id = -1
                        class_name = ""
                        class_color = "#ff0000"  # Default red color
                        
                        # If classification data is available, get the corresponding information
                        if i < len(self.annotation_colors.get("class_id", [])):
                            class_id = self.annotation_colors["class_id"][i]
                            if 0 <= class_id < len(self.annotation_colors.get("class_name", [])):
                                class_name = self.annotation_colors["class_name"][class_id]
                            if 0 <= class_id < len(self.annotation_colors.get("class_hex_color", [])):
                                class_color = self.annotation_colors["class_hex_color"][class_id]
                        
                        contour_str = str(contours_data[i]) if i < len(contours_data) else "[]"
                        centroid_x = centroids_data[i][0] if i < len(centroids_data) else 0
                        centroid_y = centroids_data[i][1] if i < len(centroids_data) else 0
                        
                        writer.writerow([
                            i,             # id (index)
                            centroid_x,    # centroid x coordinate
                            centroid_y,    # centroid y coordinate
                            contour_str,   # contour points
                            class_id,      # class ID
                            class_name,    # class name
                            class_color    # class color
                        ])
            else:
                print(f"Unsupported file format: {format_type}, supported formats are csv or json")
                return False
                
            return True
        except Exception as e:
            print(f"Error saving segmentation results to file: {str(e)}")
            return False

    def get_patch_centroids(self):
        """get all patch centroids"""
        if not hasattr(self, 'patch_coordinates') or self.patch_coordinates is None:
            return []

        centroids_x = np.mean(self.patch_coordinates[:, [0, 2]], axis=1)
        centroids_y = np.mean(self.patch_coordinates[:, [1, 3]], axis=1)
        
        # Only multiply the returned coordinate values by 16
        result = np.column_stack((centroids_x, centroids_y))
        return (result * 16).astype(float)
    
    def get_patch_centroids_in_viewport(self, x1, y1, x2, y2):
        """
        get all patches in viewport, return all patches that have any part in viewport
        """
        # Check if handler needs reload due to file change
        if hasattr(self, '_needs_reload') and self._needs_reload:
            print(f"[DEBUG] SegmentationHandler - Reloading data due to file change")
            self.load_file(self.h5_file)
        
        if not hasattr(self, 'patch_coordinates') or self.patch_coordinates is None:
            return [], {}
        
        # calculate all centroids
        centroids_x = np.mean(self.patch_coordinates[:, [0, 2]], axis=1)
        centroids_y = np.mean(self.patch_coordinates[:, [1, 3]], axis=1)
        
        # create mask for patches that have any part in viewport
        patch_x1 = self.patch_coordinates[:, 0]
        patch_y1 = self.patch_coordinates[:, 1]
        patch_x2 = self.patch_coordinates[:, 2]
        patch_y2 = self.patch_coordinates[:, 3]
        
        mask = (patch_x2 >= x1) & (patch_x1 <= x2) & (patch_y2 >= y1) & (patch_y1 <= y2)
        
        indices = np.where(mask)[0]

        if len(indices) == 0:
            return [], {}

        # Get class IDs for patches in view
        patch_class_ids_in_view = []
        if hasattr(self, 'patch_class_id') and self.patch_class_id is not None:
            patch_class_ids_in_view = self.patch_class_id[indices]

        # Calculate counts
        class_counts_by_id = {}
        if len(patch_class_ids_in_view) > 0:
            unique, counts = np.unique(patch_class_ids_in_view, return_counts=True)
            class_counts_by_id = dict(zip(unique.astype(str), counts))

        # Prepare manual annotations for color overrides
        manual_annots = {}
        if getattr(self, 'tissue_annotations', None):
            manual_annots = self.tissue_annotations
        else:
            # Cache-first approach: try to get from cache
            try:
                cached_data = _h5_cache.get_cached_data(self.h5_file)
                if cached_data and 'tissue_annotations' in cached_data:
                    raw = cached_data['tissue_annotations']
                    if isinstance(raw, (bytes, bytearray)):
                        manual_annots = json.loads(raw.decode('utf-8'))
                    else:
                        manual_annots = json.loads(raw)
                else:
                    # If not in cache, trigger cache refresh
                    print(f"[Debug] get_patch_centroids_in_viewport => tissue_annotations not in cache, triggering refresh for {self.h5_file}")
                    if _h5_cache.refresh_cache_with_reload(self.h5_file):
                        # Try cache again after refresh
                        cached_data = _h5_cache.get_cached_data(self.h5_file)
                        if cached_data and 'tissue_annotations' in cached_data:
                            raw = cached_data['tissue_annotations']
                            if isinstance(raw, (bytes, bytearray)):
                                manual_annots = json.loads(raw.decode('utf-8'))
                            else:
                                manual_annots = json.loads(raw)
                        else:
                            print(f"[Debug] get_patch_centroids_in_viewport => Still no tissue_annotations in cache after refresh, using empty annotations")
                            manual_annots = {}
                    else:
                        print(f"[Debug] get_patch_centroids_in_viewport => Failed to refresh cache, using empty annotations")
                        manual_annots = {}
            except Exception as e:
                print(f"[PATCHES] Failed to read manual tissue_annotations for override: {e}")

        # Get colors for each patch
        colors = []
        if hasattr(self, 'patch_class_hex_color') and self.patch_class_hex_color is not None and len(self.patch_class_hex_color) > 0:
            decoded_colors = [c.decode('utf-8') if isinstance(c, bytes) else str(c) for c in self.patch_class_hex_color]
            # Ensure patch_class_name is a Python list of strings before membership test
            try:
                names_list = list(self.patch_class_name) if self.patch_class_name is not None else []
            except Exception:
                names_list = []
            print(f"[PATCHES] Using decoded_colors len={len(decoded_colors)}; has NC? {'Negative control' in names_list}")
            for idx_in_view, class_id in zip(indices, patch_class_ids_in_view):
                # Manual override first (keys in JSON are strings)
                manual = None
                if isinstance(manual_annots, dict):
                    # Try string key first, then int
                    key_str = str(int(idx_in_view))
                    manual = manual_annots.get(key_str)
                    if manual is None:
                        manual = manual_annots.get(int(idx_in_view))
                if manual and isinstance(manual, dict) and manual.get('tissue_color'):
                    override_color = manual.get('tissue_color')
                    colors.append(override_color)
                    continue
                # Fallback to model/default
                if class_id == -1:
                    colors.append("#cccccc")  # Light gray for unclassified
                elif 0 <= class_id < len(decoded_colors):
                    colors.append(decoded_colors[class_id])
                else:
                    colors.append("#808080")  # Default dark gray for unknown/error
        else:
            # If no color map exists at all, default everything to light gray
            for idx_in_view in indices:
                manual = None
                if isinstance(manual_annots, dict):
                    key_str = str(int(idx_in_view))
                    manual = manual_annots.get(key_str)
                    if manual is None:
                        manual = manual_annots.get(int(idx_in_view))
                if manual and isinstance(manual, dict) and manual.get('tissue_color'):
                    colors.append(manual.get('tissue_color'))
                else:
                    colors.append("#cccccc")

        # Create result array [index, centroid_x, centroid_y, color]
        result_with_colors = []
        centroids_in_view_x = centroids_x[mask] * 16
        centroids_in_view_y = centroids_y[mask] * 16

        for i in range(len(indices)):
            result_with_colors.append([
                int(indices[i]),
                float(centroids_in_view_x[i]),
                float(centroids_in_view_y[i]),
                colors[i]
            ])

        return result_with_colors, self.get_all_patch_counts()

    def merge_patches_in_viewport(self, x1: float, y1: float, x2: float, y2: float):
        """
        Merge adjacent patches within viewport and return the contour points of the merged area.
        Only checks adjacency in 8 directions (up, down, left, right, and diagonals).
        """
        if not hasattr(self, 'patch_coordinates') or self.patch_coordinates is None:
            print("[Debug] No patch data to merge")
            return
        
        # Create mask for all patches
        patch_x1 = self.patch_coordinates[:, 0]
        patch_y1 = self.patch_coordinates[:, 1]
        patch_x2 = self.patch_coordinates[:, 2]
        patch_y2 = self.patch_coordinates[:, 3]
        
        # Find patches within viewport
        viewport_mask = (patch_x2 >= x1) & (patch_x1 <= x2) & (patch_y2 >= y1) & (patch_y1 <= y2)
        viewport_indices = np.where(viewport_mask)[0]
        
        if len(viewport_indices) == 0:
            print(f"[Debug] No patches found in viewport ({x1}, {y1}, {x2}, {y2})")
            return
        
        print(f"[Debug] Found {len(viewport_indices)} patches in viewport")
        
        # Create visit markers array (only mark patches within viewport)
        visited = np.zeros(len(self.patch_coordinates), dtype=bool)
        
        # Pre-calculate patch centers and dimensions for faster adjacency checks
        centers = np.column_stack([
            (patch_x1 + patch_x2) / 2,
            (patch_y1 + patch_y2) / 2
        ])
        dimensions = np.column_stack([
            patch_x2 - patch_x1,
            patch_y2 - patch_y1
        ])
        
        def is_adjacent_vectorized(current_idx, other_indices, tolerance=1e-6):
            """Vectorized version of adjacency check"""
            current_center = centers[current_idx]
            other_centers = centers[other_indices]
            
            current_dim = dimensions[current_idx]
            other_dims = dimensions[other_indices]
            
            # Calculate distances and average dimensions
            dx = np.abs(other_centers[:, 0] - current_center[0])
            dy = np.abs(other_centers[:, 1] - current_center[1])
            
            avg_width = (current_dim[0] + other_dims[:, 0]) / 2
            avg_height = (current_dim[1] + other_dims[:, 1]) / 2
            
            # Return boolean mask of adjacent patches
            return (dx <= avg_width + tolerance) & (dy <= avg_height + tolerance)

        def find_connected_patches(start_idx):
            connected = []
            stack = [start_idx]
            
            if self.patch_class_hex_color is not None and self.patch_class_id is not None:
                # get start patch color and class name
                start_color = self.patch_class_hex_color[self.patch_class_id[start_idx]]
                start_class_name = self.patch_class_name[self.patch_class_id[start_idx]] if self.patch_class_name is not None else None
                
                # decode if bytes type
                if isinstance(start_color, bytes):
                    start_color = start_color.decode('utf-8')
                if isinstance(start_class_name, bytes):
                    start_class_name = start_class_name.decode('utf-8')
                    
                # check if it is default color or Negative control class
                if start_color == "#aaaaaa" or (start_class_name and start_class_name.lower() == "negative control"):
                    return [], None
            else:
                start_color = None
                start_class_name = None

            while stack:
                current = stack.pop()
                if visited[current]:
                    continue
                
                visited[current] = True
                connected.append(current)
                
                # Get unvisited patches in viewport
                unvisited_mask = ~visited[viewport_indices]
                if not np.any(unvisited_mask):
                    continue
                
                unvisited_indices = viewport_indices[unvisited_mask]
                
                # Check adjacency for all unvisited patches at once
                adjacent_mask = is_adjacent_vectorized(current, unvisited_indices)
                adjacent_indices = unvisited_indices[adjacent_mask]
                
                # Filter by color if needed
                if start_color is not None and len(adjacent_indices) > 0:
                    colors = self.patch_class_hex_color[self.patch_class_id[adjacent_indices]]
                    colors = np.array([c.decode('utf-8') if isinstance(c, bytes) else c for c in colors])
                    color_mask = colors == start_color
                    adjacent_indices = adjacent_indices[color_mask]
                
                stack.extend(adjacent_indices)
            
            return connected, start_color if start_color else "#aaaaaa"

        def get_contour_points(patches):
            """Get pixel-style contour points for a group of patches"""
            if not patches:
                return []
            
            coords = self.patch_coordinates[patches]
            min_x = np.min(coords[:, 0])
            min_y = np.min(coords[:, 1])
            max_x = np.max(coords[:, 2])
            max_y = np.max(coords[:, 3])
            
            # Create mask image (using relative coordinates to save memory)
            width = int(max_x - min_x + 1)
            height = int(max_y - min_y + 1)
            mask = np.zeros((height, width), dtype=np.uint8)
            
            # Fill patch areas
            for patch_idx in patches:
                coords = self.patch_coordinates[patch_idx]
                x1, y1, x2, y2 = coords
                # Convert to relative coordinates
                x1_rel = int(x1 - min_x)
                y1_rel = int(y1 - min_y)
                x2_rel = int(x2 - min_x)
                y2_rel = int(y2 - min_y)
                mask[y1_rel:y2_rel+1, x1_rel:x2_rel+1] = 1
            
            try:
                contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                
                if not contours:
                    return []
                
                largest_contour = max(contours, key=cv2.contourArea)
                
                # Convert back to original coordinate system
                points = []
                for point in largest_contour:
                    x = float(point[0][0] + min_x)
                    y = float(point[0][1] + min_y)
                    points.append([x, y])
                
                if points and points[0] != points[-1]:
                    points.append(points[0])
                
                return points
            
            except ImportError:
                print("[Warning] OpenCV not found, falling back to simple boundary")
                vertices = np.array([[float(coords[0]), float(coords[1])] for coords in self.patch_coordinates[patches]])
                min_coords = np.min(vertices, axis=0)
                max_coords = np.max(vertices, axis=0)
                
                return [
                    [float(min_coords[0]), float(min_coords[1])],
                    [float(max_coords[0]), float(min_coords[1])],
                    [float(max_coords[0]), float(max_coords[1])],
                    [float(min_coords[0]), float(max_coords[1])],
                    [float(min_coords[0]), float(min_coords[1])]
                ]

        # Only traverse patches within viewport
        merged_patch_annotations = {}
        for i in viewport_indices:
            if not visited[i]:
                connected_patches, color = find_connected_patches(i)
                if connected_patches and color:
                    # Get contour points
                    contour_points = get_contour_points(connected_patches)
                    
                    # Convert to frontend format
                    points = [[float(x) * 16, float(y) * 16] for x, y in contour_points]
                    xs = [p[0] for p in points]
                    ys = [p[1] for p in points]
                    bounds = {
                        "minX": min(xs),
                        "minY": min(ys),
                        "maxX": max(xs),
                        "maxY": max(ys)
                    }

                    unique_id = f"merged_patch_{len(merged_patch_annotations)}"
                    style_body = {
                        "id": unique_id,
                        "annotation": unique_id,
                        "type": "TextualBody",
                        "purpose": "style",
                        "value": color,
                        "created": datetime.now().isoformat(),
                        "creator": {
                            "id": "default",
                            "type": "AI"
                        }
                    }

                    annotation = {
                        "id": unique_id,
                        "type": "Annotation",
                        "bodies": [style_body],
                        "target": {
                            "annotation": unique_id,
                            "selector": {
                                "type": "POLYGON",
                                "geometry": {
                                    "points": points,
                                    "bounds": bounds
                                }
                            }
                        },
                        "creator": {
                            "isGuest": True,
                            "id": "nrESYlDUe8L1qF6Ffhq4"
                        },
                        "created": datetime.now().isoformat()
                    }

                    merged_patch_annotations[unique_id] = annotation
        
        print(f"[Debug] Created {len(merged_patch_annotations)} merged patch annotations")
        return merged_patch_annotations

    def process_and_store_merged_patches(self):
        """
        process all patches and store the merged patches in cache
        """
        print(f"[Debug] process_and_store_merged_patches - Processing file: {self.get_current_file_path()}")
        if not hasattr(self, 'patch_coordinates') or self.patch_coordinates is None:
            print("[Debug] No patch data to process")
            self._merged_patches_cache = {}
            return

        visited = np.zeros(len(self.patch_coordinates), dtype=bool)
        
        centers = np.column_stack([
            (self.patch_coordinates[:, 0] + self.patch_coordinates[:, 2]) / 2,
            (self.patch_coordinates[:, 1] + self.patch_coordinates[:, 3]) / 2
        ])
        dimensions = np.column_stack([
            self.patch_coordinates[:, 2] - self.patch_coordinates[:, 0],
            self.patch_coordinates[:, 3] - self.patch_coordinates[:, 1]
        ])
        
        def is_adjacent_vectorized(current_idx, other_indices, tolerance=1e-6):
            current_center = centers[current_idx]
            other_centers = centers[other_indices]
            current_dim = dimensions[current_idx]
            other_dims = dimensions[other_indices]
            dx = np.abs(other_centers[:, 0] - current_center[0])
            dy = np.abs(other_centers[:, 1] - current_center[1])
            avg_width = (current_dim[0] + other_dims[:, 0]) / 2
            avg_height = (current_dim[1] + other_dims[:, 1]) / 2
            return (dx <= avg_width + tolerance) & (dy <= avg_height + tolerance)

        def find_connected_patches(start_idx):
            connected = []
            stack = [start_idx]
            
            if self.patch_class_hex_color is not None and self.patch_class_id is not None:
                start_color = self.patch_class_hex_color[self.patch_class_id[start_idx]]
                start_class_name = self.patch_class_name[self.patch_class_id[start_idx]] if self.patch_class_name is not None else None
                
                # decode if bytes type
                if isinstance(start_color, bytes):
                    start_color = start_color.decode('utf-8')
                if isinstance(start_class_name, bytes):
                    start_class_name = start_class_name.decode('utf-8')
                    
                # check if it is default color or Negative control class
                if start_color == "#aaaaaa" or (start_class_name and start_class_name.lower() == "negative control"):
                    return [], None
            else:
                start_color = None
                start_class_name = None

            while stack:
                current = stack.pop()
                if visited[current]:
                    continue
                
                visited[current] = True
                connected.append(current)
                
                unvisited_mask = ~visited
                if not np.any(unvisited_mask):
                    continue
                
                unvisited_indices = np.where(unvisited_mask)[0]
                adjacent_mask = is_adjacent_vectorized(current, unvisited_indices)
                adjacent_indices = unvisited_indices[adjacent_mask]
                
                if start_color is not None and len(adjacent_indices) > 0:
                    colors = self.patch_class_hex_color[self.patch_class_id[adjacent_indices]]
                    colors = np.array([c.decode('utf-8') if isinstance(c, bytes) else c for c in colors])
                    color_mask = colors == start_color
                    adjacent_indices = adjacent_indices[color_mask]
                
                stack.extend(adjacent_indices)
            
            return connected, start_color if start_color else "#aaaaaa"

        def get_contour_points(patches):
            if not patches:
                return []
            
            coords = self.patch_coordinates[patches]
            min_x = np.min(coords[:, 0])
            min_y = np.min(coords[:, 1])
            max_x = np.max(coords[:, 2])
            max_y = np.max(coords[:, 3])
            
            width = int(max_x - min_x + 1)
            height = int(max_y - min_y + 1)
            mask = np.zeros((height, width), dtype=np.uint8)
            
            for patch_idx in patches:
                coords = self.patch_coordinates[patch_idx]
                x1, y1, x2, y2 = coords
                x1_rel = int(x1 - min_x)
                y1_rel = int(y1 - min_y)
                x2_rel = int(x2 - min_x)
                y2_rel = int(y2 - min_y)
                mask[y1_rel:y2_rel+1, x1_rel:x2_rel+1] = 1
            
            try:
                contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                if not contours:
                    return []
                
                largest_contour = max(contours, key=cv2.contourArea)
                points = []
                for point in largest_contour:
                    x = float(point[0][0] + min_x)
                    y = float(point[0][1] + min_y)
                    points.append([x, y])
                
                if points and points[0] != points[-1]:
                    points.append(points[0])
                
                return points
            except ImportError:
                print("[Warning] OpenCV not found, falling back to simple boundary")
                vertices = np.array([[float(coords[0]), float(coords[1])] for coords in self.patch_coordinates[patches]])
                min_coords = np.min(vertices, axis=0)
                max_coords = np.max(vertices, axis=0)
                return [
                    [float(min_coords[0]), float(min_coords[1])],
                    [float(max_coords[0]), float(min_coords[1])],
                    [float(max_coords[0]), float(max_coords[1])],
                    [float(min_coords[0]), float(max_coords[1])],
                    [float(min_coords[0]), float(min_coords[1])]
                ]

        # store merged results
        self._merged_patches_cache = {}
        all_indices = np.arange(len(self.patch_coordinates))
        
        for i in all_indices:
            if not visited[i]:
                connected_patches, color = find_connected_patches(i)
                if connected_patches and color:
                    contour_points = get_contour_points(connected_patches)
                    points = [[float(x) * 16, float(y) * 16] for x, y in contour_points]
                    
                    # calculate bounds
                    xs = [p[0] for p in points]
                    ys = [p[1] for p in points]
                    bounds = {
                        "minX": min(xs),
                        "minY": min(ys),
                        "maxX": max(xs),
                        "maxY": max(ys)
                    }
                    
                    unique_id = f"merged_patch_{len(self._merged_patches_cache)}"
                    
                    # create annotation object
                    annotation = {
                        "id": unique_id,
                        "type": "Annotation",
                        "bodies": [{
                            "id": unique_id,
                            "annotation": unique_id,
                            "type": "TextualBody",
                            "purpose": "style",
                            "value": color,
                            "created": datetime.now().isoformat(),
                            "creator": {"id": "default", "type": "AI"}
                        }],
                        "target": {
                            "annotation": unique_id,
                            "selector": {
                                "type": "POLYGON",
                                "geometry": {
                                    "points": points,
                                    "bounds": bounds
                                }
                            }
                        },
                        "creator": {
                            "isGuest": True,
                            "id": "nrESYlDUe8L1qF6Ffhq4"
                        },
                        "created": datetime.now().isoformat()
                    }
                    
                    self._merged_patches_cache[unique_id] = {
                        "annotation": annotation,
                        "bounds": bounds
                    }
        
        print(f"[Debug] Processed and stored {len(self._merged_patches_cache)} merged patch annotations")

    def get_merged_patches_in_viewport(self, x1: float, y1: float, x2: float, y2: float):
        """
        get the merged patches in viewport
        
        Args:
            x1, y1, x2, y2: the boundary coordinates of the viewport
            
        Returns:
            Dict: the merged patches in viewport
        """
        if not hasattr(self, '_merged_patches_cache'):
            self.process_and_store_merged_patches()
        
        result = {}
        for patch_id, patch_data in self._merged_patches_cache.items():
            bounds = patch_data["bounds"]
            # check if it intersects with the viewport
            if (bounds["maxX"] >= x1 * 16 and bounds["minX"] <= x2 * 16 and 
                bounds["maxY"] >= y1 * 16 and bounds["minY"] <= y2 * 16):
                result[patch_id] = patch_data["annotation"]
        
        print(f"[Debug] Found {len(result)} merged patches in viewport")
        return result

    def get_patches(self, offset=0, limit=None):
        """
        Get patches with pagination support.
        
        Args:
            offset (int): The starting index for pagination
            limit (int, optional): The maximum number of patches to return
            
        Returns:
            tuple: A tuple containing (patches_list, total_count)
        """
        print(f"[Debug] get_patches => offset: {offset}, limit: {limit}")
        
        # Convert offset and limit to integers
        try:
            offset = int(offset)
        except (ValueError, TypeError):
            offset = 0
            print(f"[Debug] get_patches => Invalid offset, using default: {offset}")
            
        try:
            limit = int(limit) if limit is not None else None
        except (ValueError, TypeError):
            limit = None
            print(f"[Debug] get_patches => Invalid limit, using default: {limit}")
            
        patches_list = []
        total_count = 0
        
        # Check if patch data is available
        if not hasattr(self, 'patch_coordinates') or self.patch_coordinates is None:
            print("[Debug] get_patches => No patch data available")
            return patches_list, total_count
            
        total_count = len(self.patch_coordinates)
        
        # Determine the end index for iteration
        end_idx = total_count
        if limit is not None:
            end_idx = min(offset + limit, total_count)
            
        # Iterate over the specified range of indices
        for idx in range(offset, end_idx):
            # Create a patch annotation
            patch_coords = self.patch_coordinates[idx]
            x1_coord, y1_coord, x2_coord, y2_coord = patch_coords
            
            # Create contour points for the patch (rectangle)
            contour = [
                [x1_coord, y1_coord],
                [x2_coord, y1_coord],
                [x2_coord, y2_coord],
                [x1_coord, y2_coord],
                [x1_coord, y1_coord]  # Close the polygon
            ]
            
            # Get class information for the patch
            patch_specific_color = "#ff0000"  # Default color
            patch_assigned_class_id = -1      # Default class_id
            patch_specific_class_name = ""    # Default class_name

            if hasattr(self, 'patch_class_id') and self.patch_class_id is not None and \
               idx < len(self.patch_class_id):
                
                current_patch_class_id_val = self.patch_class_id[idx]
                patch_assigned_class_id = int(current_patch_class_id_val)

                if hasattr(self, 'patch_class_hex_color') and self.patch_class_hex_color is not None and \
                   0 <= current_patch_class_id_val < len(self.patch_class_hex_color):
                    color_val = self.patch_class_hex_color[current_patch_class_id_val]
                    patch_specific_color = color_val.decode('utf-8') if isinstance(color_val, bytes) else str(color_val)

                if hasattr(self, 'patch_class_name') and self.patch_class_name is not None and \
                   0 <= current_patch_class_id_val < len(self.patch_class_name):
                    name_val = self.patch_class_name[current_patch_class_id_val]
                    patch_specific_class_name = name_val.decode('utf-8') if isinstance(name_val, bytes) else str(name_val)
            
            # Create the annotation
            patch_annotation = self.create_annotation(
                index=idx,  # Use patch index as unique ID for the annotation
                contour=contour, 
                color=patch_specific_color, # This will be used for style and as class_hex_color
                class_id=patch_assigned_class_id,
                class_name=patch_specific_class_name,
                is_patch=True
            )
            patches_list.append(patch_annotation)
            
        print(f"[Debug] get_patches => Returning {len(patches_list)} patches out of {total_count}")
        return patches_list, total_count

    def get_all_nuclei_counts(self) -> Dict[str, Any]:
        """
        Returns the persisted class counts from /user_annotation/class_counts in H5.
        Maps to ID-based if possible.
        """
        # Check for active learning reclassifications and clear cache if they exist
        try:
            from app.services.active_learning_service import _reclassified_cells, _load_reclassifications_from_h5
            h5_path = self.get_current_file_path()
            
            # Always try to load reclassifications from H5 file on first access
            if h5_path and (h5_path not in _reclassified_cells or not _reclassified_cells[h5_path]):
                loaded_reclassifications = _load_reclassifications_from_h5(h5_path)
                if loaded_reclassifications:
                    _reclassified_cells[h5_path] = loaded_reclassifications
            
            if h5_path in _reclassified_cells and _reclassified_cells[h5_path]:
                # Clear cache when active learning data exists to ensure fresh calculation
                self._user_annotation_counts_cache = None
        except Exception as e:
            pass

        if hasattr(self, '_user_annotation_counts_cache') and self._user_annotation_counts_cache is not None:
            return self._user_annotation_counts_cache

        counts_dict = {}
        try:
            # Try to get from cache first
            cached_data = _h5_cache.get_cached_data(self.h5_file)
            if cached_data and 'user_annotation_class_counts' in cached_data:
                raw_data = cached_data['user_annotation_class_counts']
                if isinstance(raw_data, bytes):
                    counts_dict = json.loads(raw_data.decode('utf-8'))
                else:
                    counts_dict = json.loads(raw_data)
            else:
                # Cache-first approach: if not in cache, trigger cache refresh
                print(f"[Debug] get_all_nuclei_counts => Data not in cache, triggering cache refresh for {self.h5_file}")
                try:
                    # Use the new refresh mechanism
                    if _h5_cache.refresh_cache_with_reload(self.h5_file):
                        # Try cache again after refresh
                        cached_data = _h5_cache.get_cached_data(self.h5_file)
                        if cached_data and 'user_annotation_class_counts' in cached_data:
                            raw_data = cached_data['user_annotation_class_counts']
                            if isinstance(raw_data, bytes):
                                counts_dict = json.loads(raw_data.decode('utf-8'))
                            else:
                                counts_dict = json.loads(raw_data)
                        else:
                            print(f"[Debug] get_all_nuclei_counts => Still no data in cache after refresh, using empty counts")
                            counts_dict = {}
                    else:
                        print(f"[Debug] get_all_nuclei_counts => Failed to refresh cache, using empty counts")
                        counts_dict = {}
                except Exception as e:
                    print(f"[WARN] get_all_nuclei_counts => Failed to refresh cache: {e}, using empty counts")
                    counts_dict = {}

                    # Apply Active Learning reclassifications to class_counts if they exist
                    try:
                        from app.services.active_learning_service import _reclassified_cells
                        h5_path = self.get_current_file_path()
                        reclassified_data = _reclassified_cells.get(h5_path, {})
                        if reclassified_data:

                            # Get class name to ID mapping for applying reclassifications
                            # Use the actual class names from the counts_dict keys and the dynamic class names
                            class_name_to_id = {}

                            # Try multiple ways to get the class mapping
                            # Method 1: Use self.class_names if available
                            if hasattr(self, 'class_names') and self.class_names is not None:
                                for i, name in enumerate(self.class_names):
                                    class_name_to_id[name] = str(i)

                            # Method 2: If that's empty, create from the counts_dict keys directly
                            if not class_name_to_id:
                                # Standard class order based on global counts
                                standard_order = ['Negative control', 'Lymphocytes', 'Tumor', 'Normal_duct']
                                for i, name in enumerate(standard_order):
                                    if name in counts_dict:  # Only add if exists in counts
                                        class_name_to_id[name] = str(i)


                            # Apply each reclassification with is_original_manual logic
                            reclassifications_applied = 0
                            for cell_id, reclass_info in reclassified_data.items():
                                original_class = reclass_info.get("original_class")
                                new_class = reclass_info.get("new_class")
                                is_original_manual = reclass_info.get("is_original_manual", False)

                                # Add to new class (create if doesn't exist) - ALWAYS
                                if new_class not in counts_dict:
                                    counts_dict[new_class] = 0
                                counts_dict[new_class] += 1

                                # Subtract from original class ONLY if it was manually annotated
                                if is_original_manual and original_class in counts_dict:
                                    counts_dict[original_class] = max(0, counts_dict[original_class] - 1)

                                reclassifications_applied += 1

                    except Exception as e:
                        traceback.print_exc()

                    except Exception as e:
                        print(f"[ERROR] get_all_nuclei_counts: Failed to apply reclassifications: {e}")
                        traceback.print_exc()

        except Exception as e:
            print(f"[ERROR] get_all_nuclei_counts: Failed to load class_counts: {e}")
            traceback.print_exc()
            counts_dict = {}

        # Fallback for old files: if class_counts dataset does not exist, compute from manual annotations.
        if not counts_dict:
            print("[Debug] class_counts not found in H5. Computing from manual annotations for backward compatibility.")
            manual_annotations = {}
            try:
                with h5py.File(self.h5_file, 'r') as h5:
                    if 'user_annotation' in h5 and 'nuclei_annotations' in h5['user_annotation']:
                        raw_bytes = h5['user_annotation/nuclei_annotations'][()]
                        manual_annotations = json.loads(raw_bytes.decode("utf-8"))
                        if manual_annotations:
                            sample_key = next(iter(manual_annotations.keys()))
                            sample_annotation = manual_annotations[sample_key]
                    else:
                        manual_annotations = {}
            except Exception as e:
                print(f"[ERROR] Could not read nuclei_annotations for fallback count: {e}")

            name_counts = {}
            if manual_annotations:
                # Apply active learning reclassifications to manual annotation counts
                try:
                    from app.services.active_learning_service import _reclassified_cells
                    h5_path = self.get_current_file_path()
                    reclassified_data = _reclassified_cells.get(h5_path, {})
                    if reclassified_data:
                        reclassified_keys = list(reclassified_data.keys())[:5]
                except Exception as e:
                    reclassified_data = {}

                matches_found = 0
                total_processed = 0
                for _ann_id, annotation in manual_annotations.items():
                    cell_id = str(annotation.get("cell_ID", _ann_id))  # Handle both cell_ID field and annotation ID
                    original_class_name = annotation.get("cell_class")
                    total_processed += 1


                    if original_class_name:
                        # Check if this cell was reclassified
                        if cell_id in reclassified_data:
                            final_class_name = reclassified_data[cell_id]["new_class"]
                            matches_found += 1
                        else:
                            final_class_name = original_class_name

                        name_counts[final_class_name] = name_counts.get(final_class_name, 0) + 1

            
            counts_dict = name_counts
            
            # Persist the computed counts back to the H5 file for future use
            if counts_dict:
                try:
                    with h5py.File(self.h5_file, 'r+') as h5:
                        user_group = h5.require_group('user_annotation')
                        if 'class_counts' in user_group:
                            del user_group['class_counts']
                        user_group.create_dataset('class_counts', data=json.dumps(counts_dict).encode('utf-8'))
                    print("[Debug] Persisted newly computed nuclei counts to H5 file.")
                except Exception as e:
                    print(f"[Warning] Could not persist computed nuclei counts to H5 file: {e}")

        # If self.class_name exists, map to ID-based dict
        class_counts_by_id = {}
        dynamic_class_names = []
        if self.class_name is not None:
            # Start from in-memory class names
            dynamic_class_names = list(self.class_name)
            # Decode bytes -> str and normalize
            dynamic_class_names = [
                n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n)
            for n in dynamic_class_names]
            # Deduplicate while preserving order
            seen = set()
            dynamic_class_names = [n for n in dynamic_class_names if not (n in seen or seen.add(n))]
            name_to_id = {name: str(i) for i, name in enumerate(dynamic_class_names)}
            class_counts_by_id = {str(i): 0 for i in range(len(dynamic_class_names))}
            for name, count in counts_dict.items():
                # Normalize incoming key
                name = name.decode('utf-8') if isinstance(name, (bytes, bytearray)) else str(name)
                if name in name_to_id:
                    class_counts_by_id[name_to_id[name]] = count
                else:
                    # Add missing classes from counts
                    new_id = str(len(dynamic_class_names))
                    dynamic_class_names.append(name)
                    name_to_id[name] = new_id
                    class_counts_by_id[new_id] = count
        else:
            # No mapping: Use string keys directly, sorted
            keys_norm = [
                k.decode('utf-8') if isinstance(k, (bytes, bytearray)) else str(k)
            for k in counts_dict.keys()]
            # Dedup then sort for determinism
            keys_seen = set()
            keys_unique = [k for k in keys_norm if not (k in keys_seen or keys_seen.add(k))]
            dynamic_class_names = sorted(keys_unique)
            class_counts_by_id = {str(i): counts_dict[name] for i, name in enumerate(dynamic_class_names)}

        self._user_annotation_counts_cache = {'class_counts_by_id': class_counts_by_id, 'dynamic_class_names': dynamic_class_names}
        return self._user_annotation_counts_cache

    def invalidate_user_counts_cache(self):
        """Invalidate all user-related caches to ensure fresh data"""
        self._user_annotation_counts_cache = None
        self._patch_annotation_counts_cache = None
        self._global_label_counts_cache = None
        self._whole_slide_counts_cache = None
        
        # Also mark handler as needing reload
        self._needs_reload = True
        print(f"[DEBUG] SegmentationHandler - Invalidated all user caches and marked for reload")

    def get_global_nuclei_label_counts(self) -> Dict[str, Any]:
        """
        Compute global nuclei label counts across the entire slide using the
        effective in-memory class assignments (model + manual overrides).

        Returns a dict:
          {
            'total_cells': int,
            'class_counts_by_id': { '0': int, '1': int, ... },
            'dynamic_class_names': [str, ...],
            'class_hex_colors': [str, ...]
          }
        """
        # Check for active learning reclassifications and clear cache if they exist
        try:
            from app.services.active_learning_service import _reclassified_cells
            h5_path = self.get_current_file_path()
            if h5_path in _reclassified_cells and _reclassified_cells[h5_path]:
                # Clear cache when active learning data exists to ensure fresh calculation
                self._global_label_counts_cache = None
        except Exception as e:
            pass

        if hasattr(self, '_global_label_counts_cache') and self._global_label_counts_cache is not None:
            return self._global_label_counts_cache

        # Ensure data is loaded and manual overrides have been applied
        self.load_file(self.get_current_file_path(), force_reload=False)

        total_cells = int(len(self.centroids)) if self.centroids is not None else 0

        # If there is no classification palette, return zeros
        if self.class_name is None or self.class_id is None:
            result = {
                'total_cells': total_cells,
                'class_counts_by_id': {},
                'dynamic_class_names': [],
                'class_hex_colors': []
            }
            self._global_label_counts_cache = result
            return result

        # Convert to numpy arrays if needed and apply active learning reclassifications
        try:
            class_ids = np.array(self.class_id)
        except Exception:
            class_ids = self.class_id

        # Apply active learning reclassifications to class_ids for accurate counts
        try:
            from app.services.active_learning_service import _reclassified_cells
            h5_path = self.get_current_file_path()


            if h5_path in _reclassified_cells:
                reclassified_data = _reclassified_cells[h5_path]

                # Create a copy of class_ids to modify
                class_ids = np.copy(class_ids)

                # Convert class names to IDs for reclassification
                class_name_to_id = {name: idx for idx, name in enumerate(self.class_name)}

                for cell_id_str, reclassify_info in reclassified_data.items():
                    try:
                        cell_id = int(cell_id_str)
                        new_class_name = reclassify_info["new_class"]

                        if cell_id < len(class_ids) and new_class_name in class_name_to_id:
                            new_class_id = class_name_to_id[new_class_name]
                            old_class_id = class_ids[cell_id]
                            class_ids[cell_id] = new_class_id
                    except (ValueError, KeyError) as e:
                        continue
        except Exception as e:
            pass

        # Count only labeled nuclei (class_id >= 0)
        labeled_mask = (class_ids >= 0)
        safe_ids = class_ids[labeled_mask] if hasattr(labeled_mask, '__len__') else class_ids
        if safe_ids is None or (hasattr(safe_ids, 'size') and safe_ids.size == 0) or (isinstance(safe_ids, list) and len(safe_ids) == 0):
            bincount = np.array([], dtype=int)
        else:
            max_id = int(np.max(safe_ids)) if hasattr(safe_ids, 'size') and safe_ids.size > 0 else int(max(safe_ids))
            bincount = np.bincount(safe_ids.astype(int), minlength=max(len(self.class_name), max_id + 1))

        # Normalize lengths and types
        names_list = list(self.class_name) if self.class_name is not None else []
        colors_list = list(self.class_hex_color) if self.class_hex_color is not None else []
        # Decode bytes if present
        names_list = [n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n) for n in names_list]
        colors_list = [c.decode('utf-8') if isinstance(c, (bytes, bytearray)) else str(c) for c in colors_list]

        # Ensure bincount length matches number of classes
        num_classes = len(names_list)
        if bincount.shape[0] < num_classes:
            pad = np.zeros(num_classes - bincount.shape[0], dtype=int)
            bincount = np.concatenate([bincount, pad])
        elif bincount.shape[0] > num_classes:
            bincount = bincount[:num_classes]

        class_counts_by_id = {str(i): int(bincount[i]) for i in range(num_classes)}


        result = {
            'total_cells': total_cells,
            'class_counts_by_id': class_counts_by_id,
            'dynamic_class_names': names_list,
            'class_hex_colors': colors_list
        }

        self._global_label_counts_cache = result
        return result

    def invalidate_global_counts_cache(self):
        self._global_label_counts_cache = None

    def get_all_patch_counts(self) -> Dict[str, Any]:
        """
        Returns the persisted patch class counts from /user_annotation/patch_class_counts in H5.
        Maps to ID-based if possible.
        """
        if hasattr(self, '_patch_annotation_counts_cache') and self._patch_annotation_counts_cache is not None:
            return self._patch_annotation_counts_cache

        counts_dict = {}
        manual_annotations = {}
        model_class_names: List[str] = []
        manual_class_names: List[str] = []
        try:
            # Try to get from cache first
            cached_data = _h5_cache.get_cached_data(self.h5_file)
            if cached_data:
                # Get patch class counts from cache
                if 'user_annotation_patch_class_counts' in cached_data:
                    raw_data = cached_data['user_annotation_patch_class_counts']
                    if isinstance(raw_data, bytes):
                        counts_dict = json.loads(raw_data.decode('utf-8'))
                    else:
                        counts_dict = json.loads(raw_data)
                
                # Get tissue annotations from cache
                if 'user_annotation_tissue_annotations' in cached_data:
                    raw_bytes = cached_data['user_annotation_tissue_annotations']
                    if isinstance(raw_bytes, bytes):
                        manual_annotations = json.loads(raw_bytes.decode('utf-8'))
                    else:
                        manual_annotations = json.loads(raw_bytes)
                    for ann in manual_annotations.values():
                        name = ann.get('tissue_class')
                        if isinstance(name, str):
                            manual_class_names.append(name)
                
                # Get model class names from cache
                patch_prefix = self.get_patch_classification_prefix()
                if not self.patch_class_name:
                    key = f"{patch_prefix}_tissue_class_name"
                    if key in cached_data and cached_data[key] is not None:
                        raw_names = cached_data[key]
                        if hasattr(raw_names, '__iter__') and len(raw_names) > 0:
                            model_class_names = [n.decode('utf-8') if isinstance(n, bytes) else str(n) for n in raw_names]
                        else:
                            model_class_names = []
            else:
                # Fallback: read directly from H5 if not in cache
                with h5py.File(self.h5_file, 'r') as h5:
                    if 'user_annotation' in h5 and 'patch_class_counts' in h5['user_annotation']:
                        raw_data = h5['user_annotation/patch_class_counts'][()]
                        counts_dict = json.loads(raw_data.decode('utf-8'))
                    # Try to read manual annotations to learn all class names present, even if count=0
                    if 'user_annotation' in h5 and 'tissue_annotations' in h5['user_annotation']:
                        raw_bytes = h5['user_annotation/tissue_annotations'][()]
                        manual_annotations = json.loads(raw_bytes.decode('utf-8'))
                        for ann in manual_annotations.values():
                            name = ann.get('tissue_class')
                            if isinstance(name, str):
                                manual_class_names.append(name)
                    # If we do not have in-memory model classes, try reading from file
                    patch_prefix = self.get_patch_classification_prefix()
                    if not self.patch_class_name and patch_prefix in h5 and 'tissue_class_name' in h5[patch_prefix]:
                        try:
                            raw_names = safe_load_h5_dataset(h5[patch_prefix]['tissue_class_name'])
                            if raw_names is not None:
                                model_class_names = [n.decode('utf-8') for n in raw_names]
                            else:
                                model_class_names = []
                        except Exception:
                            # Fallback for scalar/other edge cases
                            raw = h5[patch_prefix]['tissue_class_name'][()]
                            if isinstance(raw, (bytes, bytearray)):
                                model_class_names = [raw.decode('utf-8')]
                            else:
                                model_class_names = []
        
        except Exception as e:
            print(f"[ERROR] get_all_patch_counts: Failed to load patch_class_counts: {e}")
            counts_dict = {}

        # Fallback for old files: if patch_class_counts dataset does not exist, compute from manual annotations.
        if not counts_dict:
            print("[Debug] patch_class_counts not found in H5. Computing from manual annotations for backward compatibility.")
            name_counts = {}
            if manual_annotations:
                for _patch_id, annotation in manual_annotations.items():
                    class_name = annotation.get("tissue_class")
                    if class_name:
                        name_counts[class_name] = name_counts.get(class_name, 0) + 1
            counts_dict = name_counts

            # Persist the computed counts back to the H5 file for future use
            if counts_dict:
                try:
                    with h5py.File(self.h5_file, 'r+') as h5:
                        user_group = h5.require_group('user_annotation')
                        if 'patch_class_counts' in user_group:
                            del user_group['patch_class_counts']
                        user_group.create_dataset('patch_class_counts', data=json.dumps(counts_dict).encode('utf-8'))
                    print("[Debug] Persisted newly computed patch counts to H5 file.")
                except Exception as e:
                    print(f"[Warning] Could not persist computed patch counts to H5 file: {e}")

        # Build a robust class list: prefer in-memory model names, else H5 model names, union with manual names, ensure 'Negative control'
        base_names: List[str] = []
        if self.patch_class_name is not None and isinstance(self.patch_class_name, list) and len(self.patch_class_name) > 0:
            base_names = list(self.patch_class_name)
        elif model_class_names:
            base_names = list(model_class_names)

        # Normalize and deduplicate base names
        base_names = [n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n) for n in base_names]
        _seen_names = set()
        base_names = [n for n in base_names if not (n in _seen_names or _seen_names.add(n))]

        # Union with manual names (preserve order)
        for n in manual_class_names:
            if n not in base_names:
                base_names.append(n)

        # Ensure 'Negative control' exists and is first
        if 'Negative control' not in base_names:
            base_names = ['Negative control'] + base_names
        else:
            # Move to front if not already
            if base_names[0] != 'Negative control':
                base_names = ['Negative control'] + [n for n in base_names if n != 'Negative control']

        dynamic_class_names = base_names
        name_to_id = {name: str(i) for i, name in enumerate(dynamic_class_names)}
        class_counts_by_id = {str(i): 0 for i in range(len(dynamic_class_names))}
        for name, count in counts_dict.items():
            if name in name_to_id:
                class_counts_by_id[name_to_id[name]] = count

        self._patch_annotation_counts_cache = {'class_counts_by_id': class_counts_by_id, 'dynamic_class_names': dynamic_class_names}
        return self._patch_annotation_counts_cache

    def invalidate_patch_counts_cache(self):
        self._patch_annotation_counts_cache = None

    def update_class_color_in_h5(self, class_name: str, new_color: str):
        """
        Updates the color for a given class name in the H5 file.

        This method handles two scenarios for persistence:
        1. If a classification model has been run, it updates the canonical color
           in the `/ClassificationNode/nuclei_class_HEX_color` dataset.
        2. It updates the denormalized `cell_color` and `tissue_color` for any
           existing manual annotations in the `/user_annotation/` group to ensure
           consistency.
        """
        if not self.h5_file or not os.path.exists(self.h5_file):
            raise ValueError("A valid H5 file is not loaded.")

        with h5py.File(self.h5_file, 'r+') as h5_file:
            # --- 1. Update ClassificationNode (if it exists) ---
            classification_prefix = self.get_classification_prefix()
            if classification_prefix in h5_file:
                group = h5_file[classification_prefix]
                if 'nuclei_class_name' in group and 'nuclei_class_HEX_color' in group:
                    raw_names = safe_load_h5_dataset(group['nuclei_class_name'])
                    if raw_names is not None:
                        class_names = [name.decode('utf-8') for name in raw_names]
                        if class_name in class_names:
                            class_index = class_names.index(class_name)
                            color_dataset = group['nuclei_class_HEX_color']
                            
                            # Ensure dataset is writeable
                            if color_dataset.dtype.kind == 'S':
                                color_dataset[class_index] = new_color.encode('utf-8')
                                print(f"Updated color in ClassificationNode for '{class_name}'.")
                            else:
                                 print(f"Warning: Color dataset in ClassificationNode is not of string type.")
                    else:
                        print(f"Warning: Failed to load nuclei_class_name from ClassificationNode")

                # Also update patch classification colors if that node exists
                patch_classification_prefix = self.get_patch_classification_prefix()
                if patch_classification_prefix in h5_file:
                    patch_group = h5_file[patch_classification_prefix]
                    if 'tissue_class_name' in patch_group and 'tissue_class_HEX_color' in patch_group:
                        raw_patch_names = safe_load_h5_dataset(patch_group['tissue_class_name'])
                        if raw_patch_names is not None:
                            patch_class_names = [name.decode('utf-8') for name in raw_patch_names]
                            if class_name in patch_class_names:
                                patch_class_index = patch_class_names.index(class_name)
                                patch_color_dataset = patch_group['tissue_class_HEX_color']
                                if patch_color_dataset.dtype.kind == 'S':
                                    patch_color_dataset[patch_class_index] = new_color.encode('utf-8')
                                    print(f"Updated color in {patch_classification_prefix} for '{class_name}'.")
                        else:
                            print(f"Warning: Failed to load tissue_class_name from {patch_classification_prefix}")
            else:
                print(f"Info: ClassificationNode does not exist. Skipping update of model colors.")

            # --- 2. Update Manual Nuclei Annotations ---
            user_annot_group_path = 'user_annotation'
            nuclei_annots_path = f"{user_annot_group_path}/nuclei_annotations"
            if nuclei_annots_path in h5_file:
                raw_bytes = h5_file[nuclei_annots_path][()]
                manual_annotations = json.loads(raw_bytes.decode("utf-8"))
                
                updated = False
                for ann_id, annotation in manual_annotations.items():
                    if annotation.get("cell_class") == class_name:
                        annotation["cell_color"] = new_color
                        updated = True
                
                if updated:
                    del h5_file[nuclei_annots_path]
                    h5_file.create_dataset(nuclei_annots_path, data=json.dumps(manual_annotations).encode('utf-8'))
                    print(f"Updated denormalized colors in user_annotation/nuclei_annotations.")

            # --- 3. Update Manual Tissue/Patch Annotations ---
            tissue_annots_path = f"{user_annot_group_path}/tissue_annotations"
            if tissue_annots_path in h5_file:
                raw_bytes = h5_file[tissue_annots_path][()]
                manual_tissue_annotations = json.loads(raw_bytes.decode("utf-8"))

                updated = False
                for patch_id, annotation in manual_tissue_annotations.items():
                    if annotation.get("tissue_class") == class_name:
                        annotation["tissue_color"] = new_color
                        updated = True

                if updated:
                    del h5_file[tissue_annots_path]
                    h5_file.create_dataset(tissue_annots_path, data=json.dumps(manual_tissue_annotations).encode('utf-8'))
                    print(f"Updated denormalized colors in user_annotation/tissue_annotations.")

            h5_file.flush()

        # --- 4. Invalidate Cache ---
        _h5_cache.clear_cache(self.h5_file)
        print(f"Cache cleared for {self.h5_file} to reflect updated colors.")
        # Invalidate derived caches
        self.invalidate_user_counts_cache()
        self.invalidate_global_counts_cache()


    def delete_class_in_h5(self, class_name: str, reassign_to: str = "Negative control") -> Dict[str, Any]:
        """
        Persistently delete a nuclei class from the H5 file.

        Steps:
        - Remove the deleted class from name/color arrays.
        - Remap nuclei_class_id: nuclei of the deleted class -> UNCLASSIFIED (-1), and shift indices above the deleted index down by 1.
        - Remove manual nuclei annotations for this class and persist updated counts.
        - Invalidate caches so future reads reflect changes.
        """
        if not self.h5_file or not os.path.exists(self.h5_file):
            raise ValueError("A valid H5 file is not loaded.")

        if class_name == "Negative control":
            raise ValueError("Cannot delete 'Negative control' class.")

        affected = 0
        reassigned_to_name = None

        with h5py.File(self.h5_file, 'r+') as h5_file:
            classification_prefix = self.get_classification_prefix()
            if classification_prefix in h5_file:
                group = h5_file[classification_prefix]
                if 'nuclei_class_name' in group and 'nuclei_class_HEX_color' in group and 'nuclei_class_id' in group:
                    # Decode arrays to Python lists
                    raw_names = safe_load_h5_dataset(group['nuclei_class_name'])
                    raw_colors = safe_load_h5_dataset(group['nuclei_class_HEX_color'])
                    class_ids = safe_load_h5_dataset(group['nuclei_class_id'])
                    
                    if raw_names is None or raw_colors is None or class_ids is None:
                        print(f"Warning: Failed to load required datasets from {classification_prefix}")
                    else:
                        names: List[str] = [n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n) for n in raw_names]
                        colors: List[str] = [c.decode('utf-8') if isinstance(c, (bytes, bytearray)) else str(c) for c in raw_colors]

                    # If the class does not exist in H5 palette, skip model remap and continue to manual cleanup
                    if class_name in names:
                        # Prepare provisional arrays
                        names0 = list(names)
                        colors0 = list(colors)
                        del_idx0 = names0.index(class_name)

                        # Reassign affected nuclei to UNCLASSIFIED (-1) and compact indices above deleted one
                        del_idx0 = names0.index(class_name)
                        # Count affected before modifying ids (use original ids space)
                        affected = int(np.sum(class_ids == names.index(class_name))) if class_name in names else 0

                        # Build final names/colors by removing the deleted class (do not insert NC here)
                        names1 = [n for i, n in enumerate(names0) if i != del_idx0]
                        colors1 = [c for i, c in enumerate(colors0) if i != del_idx0]

                        # Vectorized remap to -1 for deleted, shift down others above
                        c0 = class_ids.copy()
                        new_ids = np.where(c0 == del_idx0, -1, np.where(c0 > del_idx0, c0 - 1, c0))

                        # Persist new ids (ensure signed dtype if needed)
                        try:
                            if group['nuclei_class_id'].dtype.kind == 'u':
                                # Recreate as signed int32 to support -1
                                del group['nuclei_class_id']
                                group.create_dataset('nuclei_class_id', data=new_ids.astype(np.int32))
                            else:
                                group['nuclei_class_id'][:] = new_ids.astype(group['nuclei_class_id'].dtype)
                        except Exception:
                            pass

                        # Replace class name/color datasets with resized arrays
                        try:
                            del group['nuclei_class_name']
                        except Exception:
                            pass
                        try:
                            del group['nuclei_class_HEX_color']
                        except Exception:
                            pass

                        name_bytes = np.array([n.encode('utf-8') for n in names1])
                        color_bytes = np.array([c.encode('utf-8') for c in colors1])
                        group.create_dataset('nuclei_class_name', data=name_bytes)
                        group.create_dataset('nuclei_class_HEX_color', data=color_bytes)
                elif 'nuclei_class_name' in group and 'nuclei_class_HEX_color' in group:
                    # Handle case with no nuclei_class_id: prune palette only
                    raw_names = safe_load_h5_dataset(group['nuclei_class_name'])
                    raw_colors = safe_load_h5_dataset(group['nuclei_class_HEX_color'])
                    if raw_names is not None and raw_colors is not None:
                        names: List[str] = [n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n) for n in raw_names]
                        colors: List[str] = [c.decode('utf-8') if isinstance(c, (bytes, bytearray)) else str(c) for c in raw_colors]
                    if class_name in names:
                        del_idx0 = names.index(class_name)
                        names1 = [n for i, n in enumerate(names) if i != del_idx0]
                        colors1 = [c for i, c in enumerate(colors) if i != del_idx0]
                        try:
                            del group['nuclei_class_name']
                        except Exception:
                            pass
                        try:
                            del group['nuclei_class_HEX_color']
                        except Exception:
                            pass
                        name_bytes = np.array([n.encode('utf-8') for n in names1])
                        color_bytes = np.array([c.encode('utf-8') for c in colors1])
                        group.create_dataset('nuclei_class_name', data=name_bytes)
                        group.create_dataset('nuclei_class_HEX_color', data=color_bytes)

            # Update manual nuclei annotations: remove any annotations with the deleted class
            user_group = h5_file.require_group('user_annotation')
            manual_removed = 0

            if 'nuclei_annotations' in user_group:
                try:
                    raw = user_group['nuclei_annotations'][()]
                    manual = json.loads(raw.decode('utf-8') if isinstance(raw, (bytes, bytearray)) else raw)
                    # Remove entries where cell_class matches the deleted class
                    keys_to_delete = [k for k, ann in manual.items() if isinstance(ann, dict) and ann.get('cell_class') == class_name]
                    manual_removed = len(keys_to_delete)
                    if keys_to_delete:
                        for k in keys_to_delete:
                            manual.pop(k, None)
                        del user_group['nuclei_annotations']
                        user_group.create_dataset('nuclei_annotations', data=json.dumps(manual).encode('utf-8'))
                except Exception:
                    pass

            # Recompute and persist class counts from manual annotations
            counts_from_manual: Dict[str, int] = {}
            try:
                if 'nuclei_annotations' in user_group:
                    raw = user_group['nuclei_annotations'][()]
                    manual = json.loads(raw.decode('utf-8') if isinstance(raw, (bytes, bytearray)) else raw)
                    for _ann_id, ann in manual.items():
                        if isinstance(ann, dict):
                            name = ann.get('cell_class')
                            if name:
                                counts_from_manual[name] = counts_from_manual.get(name, 0) + 1
                # persist
                if 'class_counts' in user_group:
                    del user_group['class_counts']
                user_group.create_dataset('class_counts', data=json.dumps(counts_from_manual).encode('utf-8'))
            except Exception:
                pass

            h5_file.flush()

        # Invalidate caches and (optionally) update in-memory state
        _h5_cache.clear_cache(self.h5_file)
        self.invalidate_user_counts_cache()
        self.invalidate_global_counts_cache()
        # Also prune in-memory palette to avoid resurrecting deleted class when no ClassificationNode exists
        try:
            if self.class_name is not None:
                cls_list = self.class_name.tolist() if hasattr(self.class_name, 'tolist') else list(self.class_name)
                col_list = self.class_hex_color.tolist() if (self.class_hex_color is not None and hasattr(self.class_hex_color, 'tolist')) else (list(self.class_hex_color) if self.class_hex_color is not None else [])
                if class_name in cls_list:
                    idx = cls_list.index(class_name)
                    cls_list = [n for i, n in enumerate(cls_list) if i != idx]
                    if col_list and idx < len(col_list):
                        col_list = [c for i, c in enumerate(col_list) if i != idx]
                    self.class_name = np.array(cls_list)
                    self.class_hex_color = np.array(col_list) if col_list else np.array([])
                    # Pruned in-memory palette
        except Exception:
            pass

        # Best-effort immediate state refresh
        try:
            self.load_file(self.h5_file, force_reload=True)
        except Exception:
            pass

        return {"message": "Success", "affected_nuclei": affected, "reassigned_to": reassigned_to_name}

