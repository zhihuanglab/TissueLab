import os
import sys

# Pre-parse CLI flags early so submodules see them at import time
try:
    argv = sys.argv[1:]
    # optional explicit override for SERVICE_ROOT (use TL_SERVICE_ROOT to avoid system conflicts)
    if '--service-root' in argv:
        _k = argv.index('--service-root')
        if _k + 1 < len(argv):
            os.environ['TL_SERVICE_ROOT'] = argv[_k + 1]
except Exception:
    pass

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import argparse
from app.api.tasks import tasks_router
from app.api.activation import activation_router
from app.api.load import load_router
from app.api.thumbnail import thumbnail_router  # Import Thumbnail router
from app.api.seg import seg_router
from app.api.data import data_router
from app.api.radiology import radiology_router
from app.api.feedback import feedback_router
from app.api.review import review_router
from app.api.agent import agent_router
from app.websocket import ws_router  # Import WebSocket router
from app.websocket.device_connection_manager import start_websocket_health_checker
from app.services.thumbnail import thumbnail_worker  # Import thumbnail_worker for shutdown
from app.core import settings
from app.middlewares import error_handler
from app.middlewares.logging_middleware import logging_middleware
from app.middlewares.auth_middleware import auth_middleware
from starlette.exceptions import HTTPException as StarletteHTTPException
import uvicorn
import asyncio
import atexit
import signal
from concurrent.futures import ThreadPoolExecutor
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

# No Firebase admin needed for the local desktop build (auth runs on the remote ctrl service)

# Global cleanup for abrupt exits (Ctrl+C, SIGTERM, console close where possible)
def _cleanup_on_exit(*_args):
    try:
        from app.services.register_service import cleanup_all_custom_node_processes
        results = cleanup_all_custom_node_processes()
        try:
            cleaned = [k for k, v in results.items()]
            if cleaned:
                print(f"[INFO] Cleaned up TaskNode processes on exit: {len(cleaned)}")
        except Exception:
            pass
    except Exception as e:
        try:
            print(f"[WARN] Cleanup on exit encountered error: {e}")
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
        print("[SUCCESS] FastAPI service starting...")
        # Set default executor: large thread pool for sync tile endpoints (pathview pattern)
        n_threads = min(32, (os.cpu_count() or 4) * 4)
        loop = asyncio.get_running_loop()
        default_executor = ThreadPoolExecutor(max_workers=n_threads)
        app.state.default_thread_pool_executor = default_executor
        loop.set_default_executor(default_executor)
        print(f"[INFO] Default executor: ThreadPoolExecutor(max_workers={n_threads})")

        # Start WebSocket health checker
        await start_websocket_health_checker()
        print("[INFO] WebSocket health checker started")
        
        # Initialize tile service
        from app.services.tile_service import get_tile_service
        tile_service = get_tile_service()
        print("[INFO] Tile service initialized")
        
        # Non-blocking auto-activation on startup if enabled
        from app.services.auto_activation_service import is_auto_activation_enabled, auto_activate_all_tasknodes
        if is_auto_activation_enabled():
            print("[INFO] Auto-activation enabled: starting in background (non-blocking)...")
            loop = asyncio.get_running_loop()
            loop.run_in_executor(None, lambda: asyncio.run(auto_activate_all_tasknodes()))
        else:
            print("[INFO] TaskNode auto-activation is disabled (set AUTO_ACTIVATE_TASKNODES=true to enable)")
    except Exception as e:
        print(f"[ERROR] Failed to start FastAPI service: {e}")
    
    yield
    
    # Shutdown
    try:
        # Stop tile service
        from app.services.tile_service import shutdown_tile_service
        shutdown_tile_service()
        print("[SUCCESS] Tile service shutdown successfully")
        
        # Cleanup all custom node processes to avoid zombies
        try:
            from app.services.register_service import cleanup_all_custom_node_processes
            results = cleanup_all_custom_node_processes()
            try:
                # Print a compact summary
                cleaned = [k for k,v in results.items()]
                print(f"[SUCCESS] Cleaned up TaskNode processes: {len(cleaned)}")
            except Exception:
                pass
        except Exception as ce:
            print(f"[WARN] Error cleaning up TaskNode processes: {ce}")

        # Wait for default pool (e.g. load.py run_in_executor) to finish; avoids abrupt wait=False on loop.close
        try:
            await asyncio.get_running_loop().shutdown_default_executor()
            print("[SUCCESS] Default ThreadPoolExecutor shut down")
        except Exception as ex:
            print(f"[WARN] Default executor shutdown: {ex}")
    except Exception as e:
        print(f"[ERROR] Error during service shutdown: {e}")

# init
app = FastAPI(
    title="TissueLab AI Service",
    version="1.0.0",
    openapi_url="/api/v1/openapi.json",
    docs_url="/api/v1/docs",
    lifespan=lifespan
)


# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Download-Count"],  # Explicitly expose custom headers
)

# middlewares
app.middleware("http")(logging_middleware)
app.middleware("http")(auth_middleware)
app.add_exception_handler(StarletteHTTPException, error_handler)

# router
app.include_router(tasks_router, prefix="/api/tasks", tags=["tasks"])
app.include_router(activation_router, prefix="/api/activation", tags=["activation"])
app.include_router(load_router, prefix="/api/load", tags=["load"])
app.include_router(thumbnail_router, prefix="/api/thumbnail", tags=["thumbnail"])  # Add Thumbnail router
app.include_router(seg_router, prefix="/api/seg", tags=["seg"])
app.include_router(data_router, prefix="/api/data", tags=["data"])
app.include_router(radiology_router, prefix="/api/radiology", tags=["radiology"])
app.include_router(review_router, prefix="/api/review", tags=["review"])  # Review workflow router
app.include_router(ws_router, prefix="/ws", tags=["websocket"])  # Add WebSocket router
app.include_router(feedback_router, prefix="/api/feedback", tags=["feedback"])  # Feedback router
app.include_router(agent_router, prefix="/api/agent", tags=["agent"])  # Local LLM agent (Phase 1: /v1/chat only)

# for local debug
if __name__ == "__main__":
    # Parse command line arguments
    parser = argparse.ArgumentParser(description='TissueLab AI Service')
    parser.add_argument('--dev', action='store_true', help='Run in development mode on port 5501')
    parser.add_argument('--port', type=int, help='Custom port number to run the service on')
    args = parser.parse_args()

    # Determine port based on arguments and environment
    if args.port:
        port = args.port
        mode = f"Custom Port {port}"
    elif os.getenv("PORT"):
        port = int(os.getenv("PORT"))
        mode = f"Environment Port {port}"
    elif args.dev:
        port = 5501
        mode = "Development"
    else:
        port = 5001
        mode = "Production"
    from app.services.auto_activation_service import get_activation_status_message

    print(get_activation_status_message())
    print(" Starting TissueLab AI Service...")
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
        print("\n Shutting down services...")
        thumbnail_worker.shutdown()
        print(" All services stopped")