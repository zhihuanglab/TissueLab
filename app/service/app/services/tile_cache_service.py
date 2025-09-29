#!/usr/bin/env python3
"""
Tile Cache Service for TissueLab AI Service
Provides in-memory LRU caching for tiles
"""

import os
import hashlib
import json
import time
import threading
import base64
from typing import Dict, Optional, Tuple, Any, List
from functools import lru_cache
from collections import OrderedDict

from app.core import logger


class TileCacheService:
    """In-memory LRU tile cache service"""
    
    def __init__(self, max_size: int = 1000, max_age_seconds: int = 3600):
        """
        Initialize tile cache service
        
        Args:
            max_size: Maximum number of tiles to cache
            max_age_seconds: Maximum age of cache entries in seconds
        """
        self.max_size = max_size
        self.max_age_seconds = max_age_seconds
        
        # Thread safety
        self._lock = threading.RLock()
        
        # LRU cache using OrderedDict
        self._cache = OrderedDict()
        self._timestamps = {}
        
        # File hash cache to avoid recomputing hashes
        self._file_hash_cache = {}
        self._file_hash_timestamps = {}
        
        # Start cleanup thread
        self._cleanup_thread = threading.Thread(target=self._periodic_cleanup, daemon=True)
        self._cleanup_thread.start()
        
        logger.info(f"Tile cache service initialized with max_size={max_size}, max_age={max_age_seconds}s")
    
    def _generate_file_hash(self, file_path: str) -> str:
        """Generate SHA-1 hash for file (optimized for large files with caching)"""
        if not os.path.exists(file_path):
            return hashlib.sha1(file_path.encode()).hexdigest()
        
        try:
            # Check if we have a cached hash for this file
            current_time = time.time()
            if (file_path in self._file_hash_cache and 
                file_path in self._file_hash_timestamps and
                current_time - self._file_hash_timestamps[file_path] < 300):  # 5 minute cache
                return self._file_hash_cache[file_path]
            
            # For large files, use file size + modification time + first/last 8KB
            stat = os.stat(file_path)
            file_size = stat.st_size
            mtime = stat.st_mtime
            
            # Read first 8KB and last 8KB for content-based hashing
            with open(file_path, 'rb') as f:
                # Read first 8KB
                first_chunk = f.read(8192)
                
                # Read last 8KB
                if file_size > 16384:  # Only if file is larger than 16KB
                    f.seek(-8192, 2)  # Seek to 8KB from end
                    last_chunk = f.read(8192)
                else:
                    last_chunk = b''
            
            # Create hash from file metadata and content samples
            hash_input = f"{file_path}:{file_size}:{mtime}:{first_chunk.hex()}:{last_chunk.hex()}"
            file_hash = hashlib.sha1(hash_input.encode()).hexdigest()
            
            # Cache the hash
            self._file_hash_cache[file_path] = file_hash
            self._file_hash_timestamps[file_path] = current_time
            
            return file_hash
            
        except Exception as e:
            logger.warning(f"Failed to generate file hash for {file_path}: {e}")
            # Fallback to simple path hash
            return hashlib.sha1(file_path.encode()).hexdigest()
    
    def _generate_cache_key(self, file_path: str, level: int, col: int, row: int, 
                           scale_factor: float = 1.0, color_mode: str = None, 
                           channels: List[int] = None, colors: List[List[int]] = None) -> str:
        """Generate cache key for tile parameters using file hash"""
        # Get file hash instead of using file path
        file_hash = self._generate_file_hash(file_path)
        
        # Create a hash of all parameters
        key_data = {
            'file_hash': file_hash,
            'level': level,
            'col': col,
            'row': row,
            'scale_factor': scale_factor,
            'color_mode': color_mode,
            'channels': channels or [],
            'colors': colors or []
        }
        
        key_string = json.dumps(key_data, sort_keys=True)
        return hashlib.sha1(key_string.encode()).hexdigest()
    
    def _is_cache_valid(self, cache_key: str) -> bool:
        """Check if cache entry is valid (not expired)"""
        if cache_key not in self._timestamps:
            return False
        
        current_time = time.time()
        return current_time - self._timestamps[cache_key] <= self.max_age_seconds
    
    def _move_to_end(self, cache_key: str):
        """Move cache key to end (most recently used)"""
        if cache_key in self._cache:
            self._cache.move_to_end(cache_key)
    
    def _evict_oldest(self):
        """Remove oldest cache entry"""
        if self._cache:
            oldest_key = next(iter(self._cache))
            del self._cache[oldest_key]
            if oldest_key in self._timestamps:
                del self._timestamps[oldest_key]
    
    def get_cached_tile(self, file_path: str, level: int, col: int, row: int,
                       scale_factor: float = 1.0, color_mode: str = None,
                       channels: List[int] = None, colors: List[List[int]] = None) -> Optional[bytes]:
        """
        Get cached tile bytes
        
        Args:
            file_path: Path to the source file
            level: Tile level
            col: Column index
            row: Row index
            scale_factor: Scale factor
            color_mode: Color mode
            channels: Channel indices
            colors: Color values
            
        Returns:
            Cached tile bytes if found and valid, None otherwise
        """
        with self._lock:
            try:
                cache_key = self._generate_cache_key(
                    file_path, level, col, row, scale_factor, color_mode, channels, colors
                )
                
                if not self._is_cache_valid(cache_key):
                    return None
                
                # Get tile bytes from memory cache
                tile_bytes = self._cache.get(cache_key)
                if tile_bytes is None:
                    return None
                
                # Move to end (most recently used)
                self._move_to_end(cache_key)
                
                logger.debug(f"Cache hit for tile: {cache_key}")
                return tile_bytes
                
            except Exception as e:
                logger.error(f"Failed to get cached tile: {e}")
                return None
    
    def cache_tile(self, file_path: str, level: int, col: int, row: int,
                   scale_factor: float, color_mode: str, channels: List[int],
                   colors: List[List[int]], tile_bytes: bytes) -> bool:
        """
        Cache tile bytes
        
        Args:
            file_path: Path to the source file
            level: Tile level
            col: Column index
            row: Row index
            scale_factor: Scale factor
            color_mode: Color mode
            channels: Channel indices
            colors: Color values
            tile_bytes: Tile image bytes
            
        Returns:
            True if successfully cached, False otherwise
        """
        with self._lock:
            try:
                cache_key = self._generate_cache_key(
                    file_path, level, col, row, scale_factor, color_mode, channels, colors
                )
                
                # Check if we need to evict old entries
                while len(self._cache) >= self.max_size:
                    self._evict_oldest()
                
                # Store tile bytes in memory cache
                self._cache[cache_key] = tile_bytes
                self._timestamps[cache_key] = time.time()
                
                # Move to end (most recently used)
                self._move_to_end(cache_key)
                
                logger.debug(f"Cached tile: {cache_key}")
                return True
                
            except Exception as e:
                logger.error(f"Failed to cache tile: {e}")
                return False
    
    def get_cached_tile_base64(self, file_path: str, level: int, col: int, row: int,
                              scale_factor: float = 1.0, color_mode: str = None,
                              channels: List[int] = None, colors: List[List[int]] = None) -> Optional[str]:
        """
        Get cached tile as base64 string
        
        Args:
            file_path: Path to the source file
            level: Tile level
            col: Column index
            row: Row index
            scale_factor: Scale factor
            color_mode: Color mode
            channels: Channel indices
            colors: Color values
            
        Returns:
            Base64 encoded tile string if found and valid, None otherwise
        """
        tile_bytes = self.get_cached_tile(
            file_path, level, col, row, scale_factor, color_mode, channels, colors
        )
        
        if tile_bytes:
            return base64.b64encode(tile_bytes).decode('utf-8')
        return None
    
    def _periodic_cleanup(self):
        """Periodic cleanup of expired cache entries"""
        while True:
            try:
                time.sleep(300)  # Run every 5 minutes
                self._cleanup_expired()
            except Exception as e:
                logger.error(f"Error in periodic cleanup: {e}")
    
    def _cleanup_expired(self):
        """Remove expired cache entries"""
        with self._lock:
            current_time = time.time()
            expired_keys = []
            
            # Clean up tile cache
            for cache_key, timestamp in self._timestamps.items():
                if current_time - timestamp > self.max_age_seconds:
                    expired_keys.append(cache_key)
            
            for cache_key in expired_keys:
                if cache_key in self._cache:
                    del self._cache[cache_key]
                if cache_key in self._timestamps:
                    del self._timestamps[cache_key]
            
            # Clean up file hash cache (older than 5 minutes)
            expired_file_hashes = []
            for file_path, timestamp in self._file_hash_timestamps.items():
                if current_time - timestamp > 300:  # 5 minutes
                    expired_file_hashes.append(file_path)
            
            for file_path in expired_file_hashes:
                if file_path in self._file_hash_cache:
                    del self._file_hash_cache[file_path]
                if file_path in self._file_hash_timestamps:
                    del self._file_hash_timestamps[file_path]
            
            if expired_keys or expired_file_hashes:
                logger.info(f"Cleaned up {len(expired_keys)} expired cache entries and {len(expired_file_hashes)} file hashes")
    
    def clear_cache(self, file_path: str = None):
        """
        Clear cache entries
        
        Args:
            file_path: If provided, clear only entries for this file. Otherwise clear all.
        """
        with self._lock:
            if file_path:
                # Clear entries for specific file
                file_hash = self._generate_file_hash(file_path)
                keys_to_remove = []
                
                for cache_key in self._cache.keys():
                    # Check if cache key contains the file hash
                    if file_hash in cache_key:
                        keys_to_remove.append(cache_key)
                
                for key in keys_to_remove:
                    if key in self._cache:
                        del self._cache[key]
                    if key in self._timestamps:
                        del self._timestamps[key]
                
                # Also clear file hash cache for this file
                if file_path in self._file_hash_cache:
                    del self._file_hash_cache[file_path]
                if file_path in self._file_hash_timestamps:
                    del self._file_hash_timestamps[file_path]
                
                logger.info(f"Cleared cache for file: {file_path}")
            else:
                # Clear all entries
                self._cache.clear()
                self._timestamps.clear()
                self._file_hash_cache.clear()
                self._file_hash_timestamps.clear()
                logger.info("Cleared all cache entries")
    
    def get_cache_stats(self) -> Dict[str, Any]:
        """Get cache statistics"""
        with self._lock:
            total_entries = len(self._cache)
            total_size_bytes = sum(len(tile_bytes) for tile_bytes in self._cache.values())
            file_hash_entries = len(self._file_hash_cache)
            
            return {
                'total_entries': total_entries,
                'total_size_bytes': total_size_bytes,
                'total_size_mb': total_size_bytes / (1024 * 1024),
                'max_entries': self.max_size,
                'max_age_seconds': self.max_age_seconds,
                'file_hash_entries': file_hash_entries,
                'cache_type': 'in_memory_lru_with_file_hash'
            }


# Global tile cache instance with reasonable defaults
_tile_cache = TileCacheService(max_size=500, max_age_seconds=3600)  # 500 tiles, 1 hour


def get_tile_cache() -> TileCacheService:
    """Get the global tile cache instance"""
    return _tile_cache
