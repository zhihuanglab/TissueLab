#!/usr/bin/env python3
"""
Thumbnail Cache Service for TissueLab AI Service
Provides file-based caching for thumbnails without Redis dependency
"""

import os
import hashlib
import json
import time
import threading
from pathlib import Path
from typing import Dict, Optional, Tuple, Any
from PIL import Image
import base64
from io import BytesIO

from app.core import logger
from app.config.path_config import STORAGE_ROOT


class ThumbnailCacheService:
    """File-based thumbnail cache service"""
    
    def __init__(self, cache_dir: str = None, max_cache_size_mb: int = 500, max_age_hours: int = 24):
        """
        Initialize thumbnail cache service
        
        Args:
            cache_dir: Directory to store cache files (default: storage/.thumbnail_cache)
            max_cache_size_mb: Maximum cache size in MB
            max_age_hours: Maximum age of cache entries in hours
        """
        # Use storage directory instead of storage/uploads for thumbnail cache
        storage_dir = Path(STORAGE_ROOT).parent  # Go up one level from storage/uploads to storage
        self.cache_dir = Path(cache_dir) if cache_dir else storage_dir / ".thumbnail_cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        
        self.max_cache_size_bytes = max_cache_size_mb * 1024 * 1024
        self.max_age_seconds = max_age_hours * 3600
        
        # Thread safety
        self._lock = threading.RLock()
        
        # Cache metadata file
        self.metadata_file = self.cache_dir / "cache_metadata.json"
        self.metadata = self._load_metadata()
        
        # Start cleanup thread
        self._cleanup_thread = threading.Thread(target=self._periodic_cleanup, daemon=True)
        self._cleanup_thread.start()
        
        logger.info(f"Thumbnail cache service initialized: {self.cache_dir}")
    
    def _load_metadata(self) -> Dict[str, Any]:
        """Load cache metadata from file"""
        try:
            if self.metadata_file.exists():
                with open(self.metadata_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
        except Exception as e:
            logger.warning(f"Failed to load cache metadata: {e}")
        return {}
    
    def _save_metadata(self):
        """Save cache metadata to file"""
        try:
            with open(self.metadata_file, 'w', encoding='utf-8') as f:
                json.dump(self.metadata, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save cache metadata: {e}")
    
    def _generate_cache_key(self, file_path: str, size: int, preview_type: str = "thumbnail") -> str:
        """Generate cache key for file path, size and preview type"""
        # Normalize file path and get file modification time for cache invalidation
        normalized_path = os.path.normpath(file_path)
        try:
            file_mtime = os.path.getmtime(normalized_path) if os.path.exists(normalized_path) else 0
        except OSError:
            file_mtime = 0
        
        # Create hash from path, size, preview type and file mtime
        key_string = f"{normalized_path}:{size}:{preview_type}:{file_mtime}"
        return hashlib.md5(key_string.encode('utf-8')).hexdigest()
    
    def _get_cache_file_path(self, cache_key: str) -> Path:
        """Get cache file path for a cache key"""
        # Use first 2 characters as subdirectory to avoid too many files in one directory
        subdir = cache_key[:2]
        subdir_path = self.cache_dir / subdir
        subdir_path.mkdir(exist_ok=True)
        return subdir_path / f"{cache_key}.jpg"
    
    def _get_metadata_file_path(self, cache_key: str) -> Path:
        """Get metadata file path for a cache key"""
        subdir = cache_key[:2]
        subdir_path = self.cache_dir / subdir
        subdir_path.mkdir(exist_ok=True)
        return subdir_path / f"{cache_key}.meta"
    
    def get_cached_thumbnail(self, file_path: str, size: int, preview_type: str = "thumbnail") -> Optional[bytes]:
        """
        Get cached thumbnail if available and valid
        
        Args:
            file_path: Path to the source file
            size: Thumbnail size
            preview_type: Type of preview (thumbnail, macro, label)
            
        Returns:
            Cached thumbnail bytes or None if not found/expired
        """
        with self._lock:
            cache_key = self._generate_cache_key(file_path, size, preview_type)
            
            # Check if we have metadata for this cache key
            if cache_key not in self.metadata:
                return None
            
            cache_info = self.metadata[cache_key]
            cache_file = self._get_cache_file_path(cache_key)
            
            # Check if cache file exists
            if not cache_file.exists():
                # Remove from metadata if file doesn't exist
                del self.metadata[cache_key]
                self._save_metadata()
                return None
            
            # Check if cache is expired
            current_time = time.time()
            if current_time - cache_info['timestamp'] > self.max_age_seconds:
                # Remove expired cache
                try:
                    cache_file.unlink()
                    metadata_file = self._get_metadata_file_path(cache_key)
                    if metadata_file.exists():
                        metadata_file.unlink()
                except OSError:
                    pass
                del self.metadata[cache_key]
                self._save_metadata()
                return None
            
            # Read and return cached thumbnail
            try:
                with open(cache_file, 'rb') as f:
                    return f.read()
            except OSError as e:
                logger.warning(f"Failed to read cached thumbnail {cache_key}: {e}")
                return None
    
    def cache_thumbnail(self, file_path: str, size: int, preview_type: str, thumbnail_bytes: bytes) -> bool:
        """
        Cache thumbnail bytes
        
        Args:
            file_path: Path to the source file
            size: Thumbnail size
            preview_type: Type of preview (thumbnail, macro, label)
            thumbnail_bytes: Thumbnail image bytes
            
        Returns:
            True if successfully cached, False otherwise
        """
        with self._lock:
            try:
                cache_key = self._generate_cache_key(file_path, size, preview_type)
                cache_file = self._get_cache_file_path(cache_key)
                metadata_file = self._get_metadata_file_path(cache_key)
                
                # Write thumbnail bytes
                with open(cache_file, 'wb') as f:
                    f.write(thumbnail_bytes)
                
                # Update metadata
                cache_info = {
                    'file_path': file_path,
                    'size': size,
                    'preview_type': preview_type,
                    'timestamp': time.time(),
                    'file_size': len(thumbnail_bytes)
                }
                
                self.metadata[cache_key] = cache_info
                self._save_metadata()
                
                # Write individual metadata file for easier cleanup
                with open(metadata_file, 'w', encoding='utf-8') as f:
                    json.dump(cache_info, f, indent=2)
                
                logger.debug(f"Cached thumbnail: {cache_key}")
                return True
                
            except Exception as e:
                logger.error(f"Failed to cache thumbnail: {e}")
                return False
    
    def get_cached_thumbnail_base64(self, file_path: str, size: int, preview_type: str = "thumbnail") -> Optional[str]:
        """
        Get cached thumbnail as base64 data URL
        
        Args:
            file_path: Path to the source file
            size: Thumbnail size
            preview_type: Type of preview (thumbnail, macro, label)
            
        Returns:
            Base64 data URL or None if not found/expired
        """
        thumbnail_bytes = self.get_cached_thumbnail(file_path, size, preview_type)
        if thumbnail_bytes:
            return f"data:image/jpeg;base64,{base64.b64encode(thumbnail_bytes).decode()}"
        return None
    
    def cache_thumbnail_from_base64(self, file_path: str, size: int, preview_type: str, base64_data: str) -> bool:
        """
        Cache thumbnail from base64 data URL
        
        Args:
            file_path: Path to the source file
            size: Thumbnail size
            preview_type: Type of preview (thumbnail, macro, label)
            base64_data: Base64 data URL
            
        Returns:
            True if successfully cached, False otherwise
        """
        try:
            # Extract base64 data from data URL
            if base64_data.startswith('data:image/jpeg;base64,'):
                base64_string = base64_data[23:]  # Remove 'data:image/jpeg;base64,' prefix
            else:
                base64_string = base64_data
            
            thumbnail_bytes = base64.b64decode(base64_string)
            return self.cache_thumbnail(file_path, size, preview_type, thumbnail_bytes)
        except Exception as e:
            logger.error(f"Failed to cache thumbnail from base64: {e}")
            return False
    
    def invalidate_cache(self, file_path: str = None, cache_key: str = None):
        """
        Invalidate cache entries
        
        Args:
            file_path: Invalidate all cache entries for this file path
            cache_key: Invalidate specific cache key
        """
        with self._lock:
            if cache_key:
                # Invalidate specific cache key
                if cache_key in self.metadata:
                    self._remove_cache_entry(cache_key)
            elif file_path:
                # Invalidate all cache entries for file path
                normalized_path = os.path.normpath(file_path)
                keys_to_remove = []
                for key, info in self.metadata.items():
                    if info.get('file_path') == normalized_path:
                        keys_to_remove.append(key)
                
                for key in keys_to_remove:
                    self._remove_cache_entry(key)
    
    def _remove_cache_entry(self, cache_key: str):
        """Remove a cache entry and its files"""
        try:
            cache_file = self._get_cache_file_path(cache_key)
            metadata_file = self._get_metadata_file_path(cache_key)
            
            if cache_file.exists():
                cache_file.unlink()
            if metadata_file.exists():
                metadata_file.unlink()
            
            if cache_key in self.metadata:
                del self.metadata[cache_key]
                self._save_metadata()
                
        except OSError as e:
            logger.warning(f"Failed to remove cache entry {cache_key}: {e}")
    
    def get_cache_stats(self) -> Dict[str, Any]:
        """Get cache statistics"""
        with self._lock:
            total_entries = len(self.metadata)
            total_size = sum(info.get('file_size', 0) for info in self.metadata.values())
            
            return {
                'total_entries': total_entries,
                'total_size_bytes': total_size,
                'total_size_mb': total_size / (1024 * 1024),
                'cache_dir': str(self.cache_dir),
                'max_size_mb': self.max_cache_size_bytes / (1024 * 1024),
                'max_age_hours': self.max_age_seconds / 3600
            }
    
    def _periodic_cleanup(self):
        """Periodic cleanup of expired and oversized cache entries"""
        while True:
            try:
                time.sleep(3600)  # Run every hour
                self._cleanup_expired()
                self._cleanup_oversized()
            except Exception as e:
                logger.error(f"Error in periodic cleanup: {e}")
    
    def _cleanup_expired(self):
        """Remove expired cache entries"""
        with self._lock:
            current_time = time.time()
            keys_to_remove = []
            
            for cache_key, cache_info in self.metadata.items():
                if current_time - cache_info['timestamp'] > self.max_age_seconds:
                    keys_to_remove.append(cache_key)
            
            for cache_key in keys_to_remove:
                self._remove_cache_entry(cache_key)
            
            if keys_to_remove:
                logger.info(f"Cleaned up {len(keys_to_remove)} expired cache entries")
    
    def _cleanup_oversized(self):
        """Remove oldest cache entries if cache is oversized"""
        with self._lock:
            total_size = sum(info.get('file_size', 0) for info in self.metadata.values())
            
            if total_size <= self.max_cache_size_bytes:
                return
            
            # Sort by timestamp (oldest first)
            sorted_entries = sorted(
                self.metadata.items(),
                key=lambda x: x[1]['timestamp']
            )
            
            # Remove oldest entries until under size limit
            removed_count = 0
            for cache_key, cache_info in sorted_entries:
                if total_size <= self.max_cache_size_bytes:
                    break
                
                self._remove_cache_entry(cache_key)
                total_size -= cache_info.get('file_size', 0)
                removed_count += 1
            
            if removed_count > 0:
                logger.info(f"Cleaned up {removed_count} cache entries due to size limit")
    
    def clear_all_cache(self):
        """Clear all cache entries"""
        with self._lock:
            try:
                # Remove all cache files
                for cache_file in self.cache_dir.rglob("*.jpg"):
                    cache_file.unlink()
                for metadata_file in self.cache_dir.rglob("*.meta"):
                    metadata_file.unlink()
                
                # Clear metadata
                self.metadata.clear()
                self._save_metadata()
                
                logger.info("Cleared all thumbnail cache")
            except Exception as e:
                logger.error(f"Failed to clear cache: {e}")


# Global cache service instance
thumbnail_cache_service = ThumbnailCacheService()
