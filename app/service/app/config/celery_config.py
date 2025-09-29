"""
Celery service configuration for TissueLab AI Service
"""

import os
from typing import Dict, Any

class CeleryConfig:
    """Configuration for Celery thumbnail service"""
    
    # ZeroMQ settings
    ZMQ_PORT = int(os.getenv('CELERY_ZMQ_PORT', 5555))
    ZMQ_HOST = os.getenv('CELERY_ZMQ_HOST', 'localhost')
    
    # Worker settings
    MAX_WORKERS = int(os.getenv('CELERY_MAX_WORKERS', 4))
    WORKER_TIMEOUT = int(os.getenv('CELERY_WORKER_TIMEOUT', 300))  # 5 minutes
    
    # Task settings
    TASK_RETRY_ATTEMPTS = int(os.getenv('CELERY_TASK_RETRY_ATTEMPTS', 3))
    TASK_RETRY_DELAY = int(os.getenv('CELERY_TASK_RETRY_DELAY', 5))  # seconds
    
    # Thumbnail settings
    DEFAULT_THUMBNAIL_SIZE = int(os.getenv('CELERY_DEFAULT_THUMBNAIL_SIZE', 200))
    MAX_THUMBNAIL_SIZE = int(os.getenv('CELERY_MAX_THUMBNAIL_SIZE', 800))
    
    # Cache settings
    TASK_CACHE_TTL = int(os.getenv('CELERY_TASK_CACHE_TTL', 3600))  # 1 hour
    MAX_CACHED_TASKS = int(os.getenv('CELERY_MAX_CACHED_TASKS', 1000))
    
    # Performance settings
    BATCH_SIZE = int(os.getenv('CELERY_BATCH_SIZE', 10))
    CONCURRENT_TASKS = int(os.getenv('CELERY_CONCURRENT_TASKS', 20))
    
    @classmethod
    def get_zmq_url(cls) -> str:
        """Get ZeroMQ connection URL"""
        return f"tcp://{cls.ZMQ_HOST}:{cls.ZMQ_PORT}"
    
    @classmethod
    def get_config_dict(cls) -> Dict[str, Any]:
        """Get configuration as dictionary"""
        return {
            'zmq_port': cls.ZMQ_PORT,
            'zmq_host': cls.ZMQ_HOST,
            'max_workers': cls.MAX_WORKERS,
            'worker_timeout': cls.WORKER_TIMEOUT,
            'task_retry_attempts': cls.TASK_RETRY_ATTEMPTS,
            'task_retry_delay': cls.TASK_RETRY_DELAY,
            'default_thumbnail_size': cls.DEFAULT_THUMBNAIL_SIZE,
            'max_thumbnail_size': cls.MAX_THUMBNAIL_SIZE,
            'task_cache_ttl': cls.TASK_CACHE_TTL,
            'max_cached_tasks': cls.MAX_CACHED_TASKS,
            'batch_size': cls.BATCH_SIZE,
            'concurrent_tasks': cls.CONCURRENT_TASKS
        }
    
    @classmethod
    def validate_config(cls) -> bool:
        """Validate configuration values"""
        try:
            assert cls.ZMQ_PORT > 0 and cls.ZMQ_PORT < 65536, "Invalid ZMQ port"
            assert cls.MAX_WORKERS > 0, "Max workers must be positive"
            assert cls.WORKER_TIMEOUT > 0, "Worker timeout must be positive"
            assert cls.TASK_RETRY_ATTEMPTS >= 0, "Task retry attempts must be non-negative"
            assert cls.TASK_RETRY_DELAY >= 0, "Task retry delay must be non-negative"
            assert cls.DEFAULT_THUMBNAIL_SIZE > 0, "Default thumbnail size must be positive"
            assert cls.MAX_THUMBNAIL_SIZE >= cls.DEFAULT_THUMBNAIL_SIZE, "Max thumbnail size must be >= default"
            assert cls.TASK_CACHE_TTL > 0, "Task cache TTL must be positive"
            assert cls.MAX_CACHED_TASKS > 0, "Max cached tasks must be positive"
            assert cls.BATCH_SIZE > 0, "Batch size must be positive"
            assert cls.CONCURRENT_TASKS > 0, "Concurrent tasks must be positive"
            return True
        except AssertionError as e:
            print(f"Configuration validation failed: {e}")
            return False

# Environment-specific configurations
class DevelopmentConfig(CeleryConfig):
    """Development environment configuration"""
    ZMQ_PORT = 5555
    MAX_WORKERS = 2
    WORKER_TIMEOUT = 120
    TASK_CACHE_TTL = 1800  # 30 minutes

class ProductionConfig(CeleryConfig):
    """Production environment configuration"""
    ZMQ_PORT = 5556
    MAX_WORKERS = 8
    WORKER_TIMEOUT = 600
    TASK_CACHE_TTL = 7200  # 2 hours
    MAX_CACHED_TASKS = 5000

class TestingConfig(CeleryConfig):
    """Testing environment configuration"""
    ZMQ_PORT = 5557
    MAX_WORKERS = 1
    WORKER_TIMEOUT = 60
    TASK_CACHE_TTL = 300  # 5 minutes

# Get current environment
ENVIRONMENT = os.getenv('ENVIRONMENT', 'development').lower()

# Select appropriate configuration
if ENVIRONMENT == 'production':
    config = ProductionConfig
elif ENVIRONMENT == 'testing':
    config = TestingConfig
else:
    config = DevelopmentConfig

# Export configuration
CELERY_CONFIG = config

