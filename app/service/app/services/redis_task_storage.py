#!/usr/bin/env python3
"""
Redis Task Storage for Multi-Instance Support
Provides shared task state management across multiple service instances
"""

import json
import time
import redis
from typing import Dict, List, Optional, Any
from app.core import logger
from app.config.celery_config import CELERY_CONFIG
from app.config.redis_config import redis_config

class RedisTaskStorage:
    """Redis-based task storage for multi-instance environments"""
    
    def __init__(self, redis_host: str = None, redis_port: int = None, redis_db: int = None):
        """Initialize Redis connection"""
        self.redis_client = redis.Redis(
            host=redis_host or redis_config.REDIS_HOST, 
            port=redis_port or redis_config.REDIS_PORT, 
            db=redis_db or redis_config.REDIS_DB,
            password=redis_config.REDIS_PASSWORD,
            socket_timeout=redis_config.REDIS_SOCKET_TIMEOUT,
            socket_connect_timeout=redis_config.REDIS_SOCKET_CONNECT_TIMEOUT,
            max_connections=redis_config.REDIS_MAX_CONNECTIONS,
            decode_responses=True
        )
        self.task_prefix = redis_config.TASK_KEY_PREFIX
        self.queue_key = redis_config.TASK_QUEUE_KEY
        
    def store_task(self, task_id: str, task_data: Dict) -> bool:
        """Store task data in Redis"""
        try:
            key = f"{self.task_prefix}{task_id}"
            task_data['updated_at'] = time.time()
            self.redis_client.hset(key, mapping=task_data)
            # Set expiration for automatic cleanup
            self.redis_client.expire(key, CELERY_CONFIG.TASK_CACHE_TTL)
            return True
        except Exception as e:
            logger.error(f"Failed to store task {task_id}: {str(e)}")
            return False
    
    def get_task(self, task_id: str) -> Optional[Dict]:
        """Retrieve task data from Redis"""
        try:
            key = f"{self.task_prefix}{task_id}"
            task_data = self.redis_client.hgetall(key)
            if not task_data:
                return None
            
            # Convert numeric fields back to proper types
            for field in ['created_at', 'started_at', 'completed_at', 'updated_at', 'size']:
                if field in task_data and task_data[field]:
                    try:
                        task_data[field] = float(task_data[field])
                    except (ValueError, TypeError):
                        pass
            
            # Parse JSON fields
            if 'result' in task_data and task_data['result']:
                try:
                    task_data['result'] = json.loads(task_data['result'])
                except json.JSONDecodeError:
                    pass
                    
            return task_data
        except Exception as e:
            logger.error(f"Failed to get task {task_id}: {str(e)}")
            return None
    
    def update_task_status(self, task_id: str, status: str, **kwargs) -> bool:
        """Update task status and additional fields"""
        try:
            key = f"{self.task_prefix}{task_id}"
            update_data = {'status': status, 'updated_at': time.time()}
            
            # Add timestamp based on status
            if status == 'processing' and 'started_at' not in kwargs:
                update_data['started_at'] = time.time()
            elif status in ['completed', 'error'] and 'completed_at' not in kwargs:
                update_data['completed_at'] = time.time()
            
            # Add any additional fields
            for key_name, value in kwargs.items():
                if key_name == 'result' and isinstance(value, (dict, list)):
                    update_data[key_name] = json.dumps(value)
                else:
                    update_data[key_name] = value
            
            self.redis_client.hset(key, mapping=update_data)
            return True
        except Exception as e:
            logger.error(f"Failed to update task {task_id}: {str(e)}")
            return False
    
    def delete_task(self, task_id: str) -> bool:
        """Delete task from Redis"""
        try:
            key = f"{self.task_prefix}{task_id}"
            return bool(self.redis_client.delete(key))
        except Exception as e:
            logger.error(f"Failed to delete task {task_id}: {str(e)}")
            return False
    
    def enqueue_task(self, task_data: Dict) -> bool:
        """Add task to the distributed queue"""
        try:
            task_json = json.dumps(task_data)
            self.redis_client.lpush(self.queue_key, task_json)
            return True
        except Exception as e:
            logger.error(f"Failed to enqueue task: {str(e)}")
            return False
    
    def dequeue_task(self, timeout: int = 1) -> Optional[Dict]:
        """Get next task from the distributed queue (blocking)"""
        try:
            result = self.redis_client.brpop(self.queue_key, timeout=timeout)
            if result:
                _, task_json = result
                return json.loads(task_json)
            return None
        except Exception as e:
            logger.error(f"Failed to dequeue task: {str(e)}")
            return None
    
    def get_queue_length(self) -> int:
        """Get the number of tasks in the queue"""
        try:
            return self.redis_client.llen(self.queue_key)
        except Exception as e:
            logger.error(f"Failed to get queue length: {str(e)}")
            return 0
    
    def get_tasks_by_status(self, status: str) -> List[Dict]:
        """Get all tasks with a specific status"""
        try:
            pattern = f"{self.task_prefix}*"
            tasks = []
            
            for key in self.redis_client.scan_iter(match=pattern):
                task_data = self.redis_client.hgetall(key)
                if task_data.get('status') == status:
                    task_id = key.replace(self.task_prefix, '')
                    task_data['task_id'] = task_id
                    tasks.append(task_data)
            
            return tasks
        except Exception as e:
            logger.error(f"Failed to get tasks by status {status}: {str(e)}")
            return []
    
    def cleanup_old_tasks(self, max_age: int = None) -> int:
        """Clean up old completed tasks"""
        try:
            max_age = max_age or CELERY_CONFIG.TASK_CACHE_TTL
            current_time = time.time()
            pattern = f"{self.task_prefix}*"
            cleaned_count = 0
            
            for key in self.redis_client.scan_iter(match=pattern):
                task_data = self.redis_client.hgetall(key)
                status = task_data.get('status')
                completed_at = task_data.get('completed_at')
                
                if (status in ['completed', 'error'] and completed_at and 
                    current_time - float(completed_at) > max_age):
                    self.redis_client.delete(key)
                    cleaned_count += 1
            
            if cleaned_count > 0:
                logger.info(f"Cleaned up {cleaned_count} old tasks from Redis")
            
            return cleaned_count
        except Exception as e:
            logger.error(f"Failed to cleanup old tasks: {str(e)}")
            return 0
    
    def health_check(self) -> bool:
        """Check Redis connection health"""
        try:
            self.redis_client.ping()
            return True
        except Exception as e:
            logger.error(f"Redis health check failed: {str(e)}")
            return False

# Global instance
redis_task_storage = RedisTaskStorage()
