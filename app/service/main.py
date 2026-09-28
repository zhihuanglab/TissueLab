import os
import sys
import multiprocessing

# Linux: numpy's MADV_HUGEPAGE on large arrays can stall the process for seconds
# under memory fragmentation (direct compaction, GIL held). Set before importing numpy.
if sys.platform == "linux":
    os.environ.setdefault("NUMPY_MADVISE_HUGEPAGE", "0")

# Must run before anything else: app/services/codeexec/sandbox.py uses a
# ProcessPoolExecutor, and under PyInstaller the spawned child re-executes this
# script. Without freeze_support() the child re-runs the whole service instead
# of the worker payload.
multiprocessing.freeze_support()

# Pre-parse CLI flags early so ENV / TL_SERVICE_ROOT are set before app modules import.
try:
    argv = sys.argv[1:]
    if '--env' in argv:
        _i = argv.index('--env')
        if _i + 1 < len(argv):
            os.environ['ENV'] = argv[_i + 1]
    if '--service-root' in argv:
        _k = argv.index('--service-root')
        if _k + 1 < len(argv):
            os.environ['TL_SERVICE_ROOT'] = argv[_k + 1]
except Exception:
    pass

# pyvips wraps whatever libvips-42.dll the DLL search path yields. On Windows
# put the full build first (TL_VIPS_DIR, vendor/, or PATH - see
# app/core/libvips.py). Must run before pyvips is imported (app.services.load).
from app.core.libvips import configure as _configure_libvips
_configure_libvips()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import argparse
from app.api.tasks import tasks_router
from app.api.activation import activation_router
from app.api.load import load_router
from app.api.thumbnail import thumbnail_router
from app.api.seg import seg_router
from app.api.data import data_router
from app.api.radiology import radiology_router
from app.api.feedback import feedback_router
from app.api.review import review_router
from app.api.history import history_router
from app.api.agent import agent_router
from app.api.file_manager import file_manager_router
from app.api.users import users_router
from app.websocket import ws_router
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
import anyio.to_thread
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


# Global cleanup for abrupt exits (Ctrl+C, SIGTERM, console close where possible)
def _cleanup_on_exit(*_args):
    try:
        from app.utils.workflow.register import cleanup_all_custom_node_processes
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

# Concurrent sync `def` routes. Above anyio's default of 40 so a burst of
# lock-waiting requests cannot starve every other sync endpoint.
SYNC_ROUTE_THREADS = 64


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    try:
        print("[SUCCESS] FastAPI service starting...")
        # Two separate pools, and they serve different callers.
        #
        # This one backs run_in_executor / asyncio.to_thread — the work an async
        # handler hands off explicitly.
        n_threads = min(32, (os.cpu_count() or 4) * 4)
        loop = asyncio.get_running_loop()
        default_executor = ThreadPoolExecutor(max_workers=n_threads)
        app.state.default_thread_pool_executor = default_executor
        loop.set_default_executor(default_executor)
        print(f"[INFO] Default executor: ThreadPoolExecutor(max_workers={n_threads})")

        # This one is anyio's, and it is where FastAPI runs every sync `def`
        # route. It defaults to 40. A sync route holds its thread for the whole
        # request, including any wait on zarr_lock — whose timeout is 120s — so
        # the pool fills with waiters and unrelated cheap endpoints queue behind
        # them. Measured with 60 requests contending for one zarr_lock: a cheap
        # sync endpoint peaked at 4.2s on 40 threads and 77ms on 64. The event
        # loop is unaffected either way, so websockets stay live; this is purely
        # the sync endpoints' tail.
        anyio.to_thread.current_default_thread_limiter().total_tokens = SYNC_ROUTE_THREADS
        print(f"[INFO] Sync route threads: {SYNC_ROUTE_THREADS}")

        # Start WebSocket health checker
        await start_websocket_health_checker()
        print("[INFO] WebSocket health checker started")

        # Any file-manager task still marked running on disk belongs to a
        # process that is gone. Resolve it now so reconnecting clients get a
        # real answer instead of "Task not found".
        try:
            from app.services.file_manager.tasks import reconcile_interrupted_tasks
            await asyncio.to_thread(reconcile_interrupted_tasks)
        except Exception as fm_err:
            print(f"[WARN] File manager task reconciliation failed: {fm_err}")

        # Discovery sandboxes left running by a crashed or force-killed service
        # (their owning pid is gone). Background: docker may be slow or absent.
        async def _sweep_discovery_containers() -> None:
            try:
                from app.services.agent.discovery.sandbox import remove_owned_containers
                removed = await asyncio.to_thread(remove_owned_containers, current_process=False)
                if removed:
                    print(f"[INFO] Removed {removed} orphaned discovery sandbox container(s)")
            except Exception as sweep_err:
                print(f"[WARN] Discovery container sweep failed: {sweep_err}")

        asyncio.get_running_loop().create_task(_sweep_discovery_containers())

        # Non-blocking auto-activation on startup if enabled
        from app.services.activation import is_auto_activation_enabled, auto_activate_all_tasknodes
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
        # First: the desktop shell force-kills the service ~2.5s after asking it
        # to stop, and a killed service would leave its discovery containers
        # running (they `sleep infinity`). Stop the runs, then remove them.
        try:
            from app.services.agent.discovery import run_manager as discovery_runs
            from app.services.agent.discovery.sandbox import remove_owned_containers
            manager = discovery_runs._run_manager_instance
            stopping = manager.request_shutdown() if manager is not None else []
            await asyncio.to_thread(remove_owned_containers, current_process=True)
            if stopping:
                # let the cancelled tasks record "cancelled" on their sessions
                await asyncio.wait(stopping, timeout=2)
        except Exception as de:
            print(f"[WARN] Error stopping discovery runs: {de}")

        # Drop all in-memory segmentation handlers before pool shutdown.
        try:
            from app.services.seg_registry import clear_all_instance_handlers
            clear_all_instance_handlers()
            print("[SUCCESS] Cleared all segmentation handlers")
        except Exception as he:
            print(f"[WARN] Error clearing segmentation handlers: {he}")

        # Cleanup all custom node processes to avoid zombies
        try:
            from app.utils.workflow.register import cleanup_all_custom_node_processes
            results = cleanup_all_custom_node_processes()
            try:
                cleaned = [k for k, v in results.items()]
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
    title="TissueLab Service",
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
app.middleware("http")(auth_middleware)
app.add_exception_handler(StarletteHTTPException, error_handler)
# Route generic uncaught exceptions through error_handler too, so they get the
# consistent AppResponse envelope on /api.
app.add_exception_handler(Exception, error_handler)

# router — slide / analysis
app.include_router(tasks_router, prefix="/api/tasks", tags=["tasks"])
app.include_router(activation_router, prefix="/api/activation", tags=["activation"])
app.include_router(load_router, prefix="/api/load", tags=["load"])
app.include_router(thumbnail_router, prefix="/api/thumbnail", tags=["thumbnail"])
app.include_router(seg_router, prefix="/api/seg", tags=["seg"])
app.include_router(data_router, prefix="/api/data", tags=["data"])
app.include_router(radiology_router, prefix="/api/radiology", tags=["radiology"])
app.include_router(review_router, prefix="/api/review", tags=["review"])
app.include_router(ws_router, prefix="/ws", tags=["websocket"])
app.include_router(feedback_router, prefix="/api/feedback", tags=["feedback"])
app.include_router(history_router, prefix="/api/workflow_history", tags=["history"])
# router — formerly served by the separate control plane
app.include_router(agent_router, prefix="/api/agent", tags=["agent"])
app.include_router(file_manager_router, prefix="/api/fm", tags=["file-manager"])
app.include_router(users_router, prefix="/api/users", tags=["users"])


def libvips_summary() -> str:
    """One line for the startup banner and bug reports: version + slide loaders."""
    try:
        import pyvips
        version = f"{pyvips.version(0)}.{pyvips.version(1)}.{pyvips.version(2)}"
        loaders = {
            "openslide": "openslideload", "jp2k": "jp2kload", "tiff": "tiffload",
            "jpeg": "jpegload", "heif": "heifload", "jxl": "jxlload", "magick": "magickload",
        }
        flags = " ".join(f"{k}={'yes' if pyvips.type_find('VipsOperation', op) != 0 else 'no'}" for k, op in loaders.items())
        return f"libvips {version}: {flags}"
    except Exception as e:  # pragma: no cover - only when libvips is missing entirely
        return f"libvips unavailable: {e}"


def _resolve_port(args) -> tuple[int, str]:
    if args.port:
        return args.port, f"Custom Port {args.port}"
    if os.getenv("PORT"):
        return int(os.getenv("PORT")), f"Environment Port {os.getenv('PORT')}"
    if args.dev:
        return 5501, "Development"
    return 5001, "Local"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='TissueLab Service (open edition)')
    parser.add_argument('--dev', action='store_true', help='Run in development mode on port 5501')
    parser.add_argument('--port', type=int, help='Custom port number to run the service on')
    parser.add_argument('--host', type=str, default=None,
                        help='Interface to bind (default 127.0.0.1 / TL_HOST). The service has no '
                             'authentication: binding 0.0.0.0 exposes your slides to the network.')
    parser.add_argument('--env', type=str, help='Environment name to load (.env.{ENV}); default "local"')
    parser.add_argument('--service-root', type=str,
                        help='Absolute path to the service root (overrides TL_SERVICE_ROOT); pre-parsed at startup')
    args = parser.parse_args()

    from app.core.settings import settings as _settings
    from app.config.path_config import STORAGE_ROOT
    from app.services.activation import get_activation_status_message

    port, mode = _resolve_port(args)
    host = args.host or _settings.HOST
    loopback = host in ("127.0.0.1", "localhost", "::1")

    print("================= Startup Diagnostics =================")
    print(f" cwd: {os.getcwd()}")
    print(f" ENV: {os.environ.get('ENV', 'local')}")
    print(f" service root: {_settings.TL_SERVICE_ROOT}")
    print(f" storage root: {STORAGE_ROOT}")
    print(f" local user: {_settings.LOCAL_USER_ID}")
    print(f" LLM agent: {'configured' if os.getenv('OPENAI_API_KEY') else 'not configured (set OPENAI_API_KEY)'}")
    print(f" {libvips_summary()}")
    print("=======================================================")
    print(get_activation_status_message())
    print(" Starting TissueLab Service...")
    print("=" * 50)
    print(f"Mode: {mode}")
    print(f"Main Service: http://{host}:{port}")
    if not loopback:
        print("[WARN] Binding a non-loopback interface. This service performs no "
              "authentication; anyone who can reach this port can read and modify "
              "every slide under the storage root.")
    print("=" * 50)
    print("Press Ctrl+C to stop all services")
    print("")

    try:
        uvicorn.run(
            app,
            host=host,
            port=port,
            reload=False,
            workers=1,
            # Overlay frames are already zstd-compressed, so permessage-deflate
            # re-compresses incompressible bytes — on the event loop, inside
            # send_bytes. A 10.5 MB frame took 225 ms to send with it and 7 ms
            # without, and nothing else in the process was served meanwhile.
            ws_per_message_deflate=False,
        )
    except KeyboardInterrupt:
        print("\n Shutting down services...")
        thumbnail_worker.shutdown()
        print(" All services stopped")
