import atexit
import contextvars
import logging
import os
import queue
import sys
from logging.handlers import QueueHandler, QueueListener, TimedRotatingFileHandler


# Per-request logging context. Set by the request-logging middleware so the
# ContextFilter below can stamp rid/uid onto every record. Defaults to '-' for
# logs emitted outside any request (startup, background threads).
rid_var: "contextvars.ContextVar[str]" = contextvars.ContextVar("rid", default="-")
uid_var: "contextvars.ContextVar[str]" = contextvars.ContextVar("uid", default="-")


class _ContextFilter(logging.Filter):
    """Stamp the current request's rid/uid (from contextvars) onto every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.rid = rid_var.get()
        record.uid = uid_var.get()
        return True


def _resolve_log_dir() -> str:
    """Service-local <service_root>/storage/logs, derived from this file's
    location (NOT SERVICE_ROOT_DIR). The Dev/AI service's SERVICE_ROOT_DIR
    (TL_SERVICE_ROOT) points at the Ctrl-Service dir, so using it would dump
    this service's logs into Ctrl-Service/storage/logs and share one file.
    This keeps them under app/service/storage/logs, next to tasknode_logs.

    The packaged build is the one exception: there this file lives inside
    TissueLab.app, which is code-signed, so logging next to it invalidates the
    signature (macOS then refuses to launch the app) and fails outright once
    the app is installed somewhere read-only. Electron passes the per-user
    root as --service-root, which main.py puts in the environment before this
    module is imported."""
    # __file__: app/service/app/core/logger.py  ->  three dirnames reach app/service
    service_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if getattr(sys, "frozen", False):
        service_root = os.getenv("TL_SERVICE_ROOT", service_root)
    base = os.getenv("LOG_DIR_OVERRIDE", os.path.join(service_root, "storage", "logs"))
    os.makedirs(base, exist_ok=True)
    return base


logger = logging.getLogger()
logger.setLevel(logging.INFO)

# pyvips forwards libvips' own diagnostics ("residual reducev by 0.125",
# "threadpool completed with 3 workers", ...) at INFO — a dozen lines per
# tile, ~6% of a day's log and pure noise. Keep its warnings.
logging.getLogger("pyvips").setLevel(logging.WARNING)

_formatter = logging.Formatter(
    "%(asctime)s %(levelname)s [rid=%(rid)s uid=%(uid)s] %(message)s"
)
_ctx_filter = _ContextFilter()

# Logging must never block the caller: under Electron stdout is a pipe, and
# when the main process stops draining it every stream.write blocks — the
# request-logging middleware runs on the event loop, so the whole service
# froze (measured 2.5 s for a 3 s pause). The root logger therefore only
# enqueues; a QueueListener thread owns the real sinks. The context filter is
# on the QueueHandler so rid/uid come from the caller's contextvars. The queue
# is bounded, and past the bound records are dropped rather than blocking the
# caller. 50k is sized for the case this exists to survive: under heavy tile
# load the service emits ~1.6k records/s, so it covers a ~30 s stdout stall at
# ~28 MB of ordinary request lines (more when bodies are logged at full size).
_log_queue: "queue.Queue[logging.LogRecord]" = queue.Queue(
    maxsize=int(os.getenv("LOG_QUEUE_MAX", "50000"))
)


class _DropOnFullQueueHandler(QueueHandler):
    def enqueue(self, record: logging.LogRecord) -> None:
        try:
            self.queue.put_nowait(record)
        except queue.Full:
            pass


_queue_handler = _DropOnFullQueueHandler(_log_queue)
_queue_handler.addFilter(_ctx_filter)
logger.addHandler(_queue_handler)

# stdout — keep for `docker logs` / live tailing.
_stream_handler = logging.StreamHandler(sys.stdout)
_stream_handler.setFormatter(_formatter)
_sink_handlers = [_stream_handler]

# Daily-rotating file on the persistent volume. Each file holds one day; old
# files are pruned by backupCount so disk stays bounded. Never let logging
# setup crash the app — fall back to stdout-only on any error.
try:
    _backup_days = int(os.getenv("LOG_BACKUP_DAYS", "14"))
    _file_handler = TimedRotatingFileHandler(
        os.path.join(_resolve_log_dir(), "app.log"),
        when="midnight",
        backupCount=_backup_days,
        encoding="utf-8",
        utc=True,
    )
    _file_handler.suffix = "%Y-%m-%d"
    _file_handler.setFormatter(_formatter)
    _sink_handlers.append(_file_handler)
except Exception as _e:
    logger.warning(f"Daily file logging disabled, using stdout only: {_e}")

_listener = QueueListener(_log_queue, *_sink_handlers)
_listener.start()


@atexit.register
def _drain_log_queue() -> None:
    """Flush what is queued at shutdown. QueueListener.stop() posts its sentinel
    with put_nowait, which raises if the queue happens to be full."""
    try:
        _listener.stop()
    except Exception:
        pass
