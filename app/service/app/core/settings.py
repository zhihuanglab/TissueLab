"""Service settings for the TissueLab open edition.

Everything runs on one machine and every request belongs to one local user, so
the configuration surface is deliberately small. Values are read from
``.env.<ENV>`` next to ``main.py`` (``.env.local`` by default) and may be
overridden by real environment variables or CLI flags (``--service-root``,
``--host``, ``--port``).
"""
import os
from typing import Optional

from dotenv import load_dotenv
from pydantic_settings import BaseSettings

# Resolve ENV and service root once; do not let .env override existing env vars
env = os.getenv("ENV", "local")
service_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # .../app/service
env_file = os.path.join(service_root, f".env.{env}")

# Do not override existing environment variables (including ENV)
load_dotenv(env_file, override=False)

# A packaged desktop install has no writable .env next to the code, so the
# per-user service root (Electron passes --service-root <app data dir>) may
# carry its own .env.local — that is where a desktop user puts OPENAI_API_KEY.
_root_env = os.path.join(os.getenv("TL_SERVICE_ROOT", service_root), ".env.local")
if os.path.abspath(_root_env) != os.path.abspath(env_file):
    load_dotenv(_root_env, override=False)


class Settings(BaseSettings):
    ENVIRONMENT: str = os.getenv("ENVIRONMENT", env)

    # Where storage/ (uploads, model registry, logs, task node logs) lives.
    # Defaults to the service checkout; Electron passes ``--service-root``
    # pointing at the per-user app data folder.
    TL_SERVICE_ROOT: str = os.getenv("TL_SERVICE_ROOT", service_root)

    # The single local principal. All storage lives under users/<LOCAL_USER_ID>.
    LOCAL_USER_ID: str = os.getenv("TL_LOCAL_USER_ID", "local")

    # Network binding. Loopback by default — see docs/local-mode.md.
    HOST: str = os.getenv("TL_HOST", "127.0.0.1")

    # Optional external TaskNodeManager (remote task nodes). Unset = local only.
    TASKNODE_MANAGER_URL: Optional[str] = os.getenv("TASKNODE_MANAGER_URL")
    BACKEND_INSTANCE_ID: int = int(os.getenv("BACKEND_INSTANCE_ID", "1"))

    # LLM agent (planning / chat / code generation). Optional: without a key the
    # agent routes return a clear "not configured" error and everything else
    # (viewer, segmentation, classifiers, workflows with installed nodes) works.
    OPENAI_API_KEY: Optional[str] = os.getenv("OPENAI_API_KEY")

    # Public HTTPS base for task node bundles (catalog + zip archives).
    TL_BUNDLE_BASE_URL: str = os.getenv(
        "TL_BUNDLE_BASE_URL",
        "https://storage.googleapis.com/tissuelab-2025.firebasestorage.app",
    )

    # codeexec sandbox backend: "0" host subprocess (full FS access, local dev only),
    # "1" require Docker (isolated, fail-closed if Docker missing), "auto" Docker-if-available.
    CODEEXEC_DOCKER: str = os.getenv("CODEEXEC_DOCKER", "auto")
    # Max sandboxed code runs executing at once (1 = strictly one at a time; the
    # rest queue FIFO). Raise for more throughput at the cost of host memory.
    CODEEXEC_MAX_CONCURRENCY: int = int(os.getenv("CODEEXEC_MAX_CONCURRENCY", "1"))

    # Seconds a segmentation handler may go untouched before it is released.
    # The sweeper exists so a server does not hold every visitor's centroids and
    # KDTree; the desktop app has one user looking at one slide, and losing that
    # workset costs them a reload for memory they were not short of. Its ping
    # keeps the handler alive at 30s intervals, but a sleeping machine sends
    # none, so any idle window at all eventually drops it. 0 disables the sweep.
    HANDLER_IDLE_TTL_SEC: float = float(
        os.getenv("TL_HANDLER_IDLE_TTL_SEC", "0" if env == "desktop" else "600")
    )


settings = Settings()
