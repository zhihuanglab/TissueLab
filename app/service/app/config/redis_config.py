#!/usr/bin/env python3
"""
Redis Configuration for TissueLab Service
"""

import os
from typing import Optional

class RedisConfig:
    """Redis configuration settings"""
    
    # Redis connection settings
    REDIS_HOST: str = os.getenv('REDIS_HOST', 'localhost')
    REDIS_PORT: int = int(os.getenv('REDIS_PORT', '6379'))
    REDIS_DB: int = int(os.getenv('REDIS_DB', '0'))
    REDIS_PASSWORD: Optional[str] = os.getenv('REDIS_PASSWORD')
    
    # Connection pool settings
    REDIS_MAX_CONNECTIONS: int = int(os.getenv('REDIS_MAX_CONNECTIONS', '20'))
    REDIS_SOCKET_TIMEOUT: int = int(os.getenv('REDIS_SOCKET_TIMEOUT', '5'))
    REDIS_SOCKET_CONNECT_TIMEOUT: int = int(os.getenv('REDIS_SOCKET_CONNECT_TIMEOUT', '5'))
    
    # Task-specific settings
    TASK_KEY_PREFIX: str = os.getenv('TASK_KEY_PREFIX', 'celery_task:')
    TASK_QUEUE_KEY: str = os.getenv('TASK_QUEUE_KEY', 'celery_task_queue')
    TASK_RESULT_TTL: int = int(os.getenv('TASK_RESULT_TTL', '3600'))  # 1 hour
    
    @classmethod
    def get_redis_url(cls) -> str:
        """Get Redis connection URL"""
        if cls.REDIS_PASSWORD:
            return f"redis://:{cls.REDIS_PASSWORD}@{cls.REDIS_HOST}:{cls.REDIS_PORT}/{cls.REDIS_DB}"
        else:
            return f"redis://{cls.REDIS_HOST}:{cls.REDIS_PORT}/{cls.REDIS_DB}"

# Global config instance
redis_config = RedisConfig()
