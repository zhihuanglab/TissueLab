from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
# Firebase removed for open source
from app.api.tasks import tasks_router
from app.api.activation import activation_router
from app.api.load import load_router
from app.api.celery_load import celery_load_router  # Import Celery router
from app.api.seg import seg_router
from app.api.h5 import h5_router
from app.api.feedback import feedback_router
from app.api.active_learning import al_router
from app.websocket import ws_router  # Import WebSocket router
from app.core import settings
from app.middlewares import error_handler
from app.middlewares.logging_middleware import logging_middleware
# Auth middleware removed for open source
from starlette.exceptions import HTTPException as StarletteHTTPException
from app.services.celery_thumbnail_service import celery_thumbnail_service  # Import Celery service
import uvicorn
import sys
import os
import threading
import time
import argparse
import asyncio
import atexit
import signal
# Set global Pillow pixel limit (must run before any PIL.Image.open usage)
try:
    from PIL import Image as PILImage
    PILImage.MAX_IMAGE_PIXELS = None  # or set a large int threshold
    print("Pillow MAX_IMAGE_PIXELS set to None (no limit)")
except Exception as _:
    pass

if getattr(sys, 'frozen', False):
    application_path = os.path.dirname(sys.executable)
else:
    application_path = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, application_path)

# Firebase initialization removed for open source

# Start Celery worker in background thread
def start_celery_worker():
    """Start Celery worker in background thread"""
    try:
        print("🚀 Starting Celery worker in background...")
        # Start the actual ZeroMQ worker
        celery_thumbnail_service.start_worker()
        
        # Set WebSocket notifier
        from app.websocket.thumbnail_consumer import notify_thumbnail_update
        celery_thumbnail_service.set_ws_notifier(notify_thumbnail_update)
        
        print("Celery thumbnail service started successfully")
        
        # Keep the thread alive
        while True:
            time.sleep(1)
    except Exception as e:
        print(f"Celery worker error: {e}")

# Start Celery worker thread
celery_thread = threading.Thread(target=start_celery_worker, daemon=True)
celery_thread.start()

# Global cleanup for abrupt exits (Ctrl+C, SIGTERM, console close where possible)
def _cleanup_on_exit(*_args):
    try:
        from app.services.register_service import cleanup_all_custom_node_processes
        results = cleanup_all_custom_node_processes()
        try:
            cleaned = [k for k, v in results.items()]
            if cleaned:
                print(f"Cleaned up TaskNode processes on exit: {len(cleaned)}")
        except Exception:
            pass
    except Exception as e:
        try:
            print(f" Cleanup on exit encountered error: {e}")
        except Exception:
            pass

# Register atexit and signals
atexit.register(_cleanup_on_exit)
for sig in (getattr(signal, 'SIGINT', None), getattr(signal, 'SIGTERM', None)):
    if sig is not None:
        try:
            signal.signal(sig, lambda s, f: _cleanup_on_exit(s, f))
        except Exception:
            pass
# Windows console break (optional)
if hasattr(signal, 'SIGBREAK'):
    try:
        signal.signal(signal.SIGBREAK, lambda s, f: _cleanup_on_exit(s, f))
    except Exception:
        pass

# Lifespan context manager for Celery service
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    try:
        print("FastAPI service starting...")
        # Non-blocking auto-activation on startup if enabled
        from app.services.auto_activation_service import is_auto_activation_enabled, auto_activate_all_tasknodes
        if is_auto_activation_enabled():
            print("Auto-activation enabled: starting in background (non-blocking)...")
            loop = asyncio.get_running_loop()
            loop.run_in_executor(None, lambda: asyncio.run(auto_activate_all_tasknodes()))
        else:
            print("TaskNode auto-activation is disabled (set AUTO_ACTIVATE_TASKNODES=true to enable)")
    except Exception as e:
        print(f"Failed to start FastAPI service: {e}")
    
    yield
    
    # Shutdown
    try:
        # Stop Celery service
        celery_thumbnail_service.shutdown()
        # Cleanup all custom node processes to avoid zombies
        try:
            from app.services.register_service import cleanup_all_custom_node_processes
            results = cleanup_all_custom_node_processes()
            try:
                # Print a compact summary
                cleaned = [k for k,v in results.items()]
                print(f"Cleaned up TaskNode processes: {len(cleaned)}")
            except Exception:
                pass
        except Exception as ce:
            print(f" Error cleaning up TaskNode processes: {ce}")
        print("Celery thumbnail service shutdown successfully")
    except Exception as e:
        print(f"Error during Celery service shutdown: {e}")

# init
app = FastAPI(
    title="API Service",
    version="1.0.0",
    openapi_url="/api/v1/openapi.json",
    docs_url="/api/v1/docs",
    lifespan=lifespan
)


# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Download-Count"],  # Explicitly expose custom headers
)

# middlewares
app.middleware("http")(logging_middleware)
# Auth middleware removed for open source
app.add_exception_handler(StarletteHTTPException, error_handler)

# router
app.include_router(tasks_router, prefix="/api/tasks", tags=["tasks"])
app.include_router(activation_router, prefix="/api/activation", tags=["activation"])
app.include_router(load_router, prefix="/api/load", tags=["load"])
app.include_router(celery_load_router, prefix="/api", tags=["celery"])  # Add Celery router
app.include_router(seg_router, prefix="/api/seg", tags=["seg"])
app.include_router(h5_router, prefix="/api/hdf5", tags=["hdf5"])
app.include_router(al_router, prefix="/api/al", tags=["active-learning"])  # Add Active Learning router
app.include_router(ws_router, prefix="/ws", tags=["websocket"])  # Add WebSocket router
app.include_router(feedback_router, prefix="/api/feedback", tags=["feedback"])  # Feedback router

# for local debug
if __name__ == "__main__":
    # Parse command line arguments
    parser = argparse.ArgumentParser(description='TissueLab AI Service')
    parser.add_argument('--dev', action='store_true', help='Run in development mode on port 5501')
    args = parser.parse_args()
    
    # Determine port based on dev option
    port = 5501 if args.dev else 5001
    mode = "Development" if args.dev else "Production"
        # Show auto-activation configuration
    from app.services.auto_activation_service import get_activation_status_message
    print(get_activation_status_message())
    print("🎯 Starting TissueLab AI Service...")
    print("=" * 50)
    print(f"Mode: {mode}")
    print(f"Main Service: http://127.0.0.1:{port}")
    print("Celery Worker: Running in background")
    print("=" * 50)
    print("Press Ctrl+C to stop all services")
    print("")
    
    try:
        uvicorn.run(
            app,
            host="127.0.0.1",
            port=port,
            reload=False,
            workers=1
        )
    except KeyboardInterrupt:
        print("\nShutting down services...")
        celery_thumbnail_service.shutdown()
        print("All services stopped")