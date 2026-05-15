#!/usr/bin/env python3
"""
Tile Service for TissueLab AI Service
Provides dedicated thread pool for tile processing to avoid blocking the async loop
"""

import asyncio
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Dict, Optional, Any, Callable
from queue import Queue, PriorityQueue
import logging
import os

from app.core import logger


@dataclass
class TileTask:
    """Tile processing task"""
    task_id: str
    level: int
    col: int
    row: int
    scale_factor: float
    color_mode: Optional[str]
    channels: Optional[list]
    colors: Optional[list]
    session_id: str
    callback: Optional[Callable] = None
    priority: int = 0  # Higher number = higher priority
    created_at: float = None
    
    def __post_init__(self):
        if self.created_at is None:
            self.created_at = time.time()


class TileService:
    """Dedicated tile service with separate thread pool to avoid blocking async loop"""
    
    def __init__(self):
        """
        Initialize tile service
        
        Args:
            max_workers: Maximum number of worker threads for tile processing
        """
        self.max_workers = min(32, os.cpu_count() * 2)
        
        # Thread pool for tile processing
        self.executor = ThreadPoolExecutor(max_workers=self.max_workers, thread_name_prefix="TileWorker")

        # Statistics
        self.stats = {
            'total_tasks': 0,
            'completed_tasks': 0,
            'failed_tasks': 0,
            'active_tasks': 0
        }
        self.stats_lock = threading.Lock()
        
        logger.info(f"Tile service initialized with max_workers={self.max_workers}")
    
    def start(self):
        """Start the tile service (no-op for simplified version)"""
        logger.info("Tile service started")
    
    def stop(self):
        """Stop the tile service"""
        self.executor.shutdown(wait=True)
        logger.info("Tile service stopped")

    async def get_tile_async(self, level: int, col: int, row: int, 
                           scale_factor: float = 1.0,
                           color_mode: Optional[str] = None,
                           channels: Optional[list] = None,
                           colors: Optional[list] = None,
                           session_id: str = "default",
                           priority: int = 0) -> Dict:
        """
        Get tile asynchronously using the dedicated thread pool
        
        Args:
            level: Tile level
            col: Column
            row: Row
            scale_factor: Scale factor
            color_mode: Color mode
            channels: Channel list
            colors: Color list
            session_id: Session ID
            priority: Task priority (higher = more important)
        
        Returns:
            Tile result dictionary
        """
        # Update stats
        with self.stats_lock:
            self.stats['total_tasks'] += 1
            self.stats['active_tasks'] += 1
        
        try:
            # Use the thread pool executor directly
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                self.executor,
                self._execute_tile_task,
                level, col, row, scale_factor, color_mode, channels, colors, session_id
            )
            
            # Update stats
            with self.stats_lock:
                self.stats['completed_tasks'] += 1
                self.stats['active_tasks'] -= 1
            
            return result
            
        except Exception as e:
            logger.error(f"Error in tile task: {e}")
            traceback.print_exc()
            
            # Update stats
            with self.stats_lock:
                self.stats['failed_tasks'] += 1
                self.stats['active_tasks'] -= 1
            
            return {"status": "error", "message": str(e)}
    
    def _execute_tile_task(self, level: int, col: int, row: int,
                          scale_factor: float, color_mode: Optional[str],
                          channels: Optional[list], colors: Optional[list],
                          session_id: str) -> Dict:
        """Execute tile task in thread pool"""
        try:
            from app.services.load_service import get_tile

            result = get_tile(
                level=level,
                col=col,
                row=row,
                scale_factor=scale_factor,
                color_mode=color_mode,
                channels=channels,
                colors=colors,
                session_id=session_id
            )

            return result

        except Exception as e:
            logger.error(f"Error executing tile task: {e}")
            traceback.print_exc()
            return {"status": "error", "message": str(e)}
    
    def get_stats(self) -> Dict:
        """Get service statistics"""
        with self.stats_lock:
            return self.stats.copy()
    


# Global tile service instance
_tile_service = None
_tile_service_lock = threading.Lock()


def get_tile_service() -> TileService:
    """Get or create the global tile service instance"""
    global _tile_service
    
    with _tile_service_lock:
        if _tile_service is None:
            _tile_service = TileService()
            _tile_service.start()
        return _tile_service


def shutdown_tile_service():
    """Shutdown the global tile service"""
    global _tile_service
    
    with _tile_service_lock:
        if _tile_service is not None:
            _tile_service.stop()
            _tile_service = None
