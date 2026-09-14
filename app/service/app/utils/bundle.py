import os
import json
import time
import platform as _platform
from datetime import timedelta, datetime
import asyncio
import hashlib
import tarfile
import urllib.request
import shutil
import threading
import uuid
from typing import Dict, Any, List, Optional

from app.core.settings import settings


APP_DIR = os.path.dirname(os.path.dirname(__file__))  # .../app
PROJECT_ROOT = os.path.dirname(APP_DIR)               # repo root (parent of app)

from app.config.path_config import SERVICE_STORAGE_DIR

NODES_DIR = os.path.join(SERVICE_STORAGE_DIR, "nodes")
TMP_DIR = os.path.join(SERVICE_STORAGE_DIR, "tmp")


def _current_platform_arch() -> Dict[str, str]:
    # platform: 'darwin'|'linux'|'win'
    sysplat = _platform.system().lower()  # 'darwin', 'linux', 'windows'
    if sysplat.startswith("darwin"):
        plat = "darwin"
    elif sysplat.startswith("windows"):
        plat = "win"
    else:
        plat = "linux"
    machine = _platform.machine().lower()  # 'arm64', 'x86_64', etc.
    # Normalize common values
    if machine in ("aarch64", "arm64"):
        arch = "arm64"
    elif machine in ("x86_64", "amd64"):
        arch = "x86_64"
    else:
        arch = machine
    return {"platform": plat, "arch": arch}


def _bundle_base_url() -> str:
    return (settings.TL_BUNDLE_BASE_URL or "").rstrip("/")


def load_catalog() -> Dict[str, Any]:
    """Load the bundles catalog from ``{TL_BUNDLE_BASE_URL}/bundles/catalog.json``.

    Returns { "bundles": [...] } or empty when unavailable.
    """
    import logging as _logging

    base = _bundle_base_url()
    if not base:
        _logging.getLogger(__name__).warning("[bundles.catalog] TL_BUNDLE_BASE_URL not set")
        return {"bundles": []}
    try:
        with urllib.request.urlopen(f"{base}/bundles/catalog.json", timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
            if isinstance(data, dict) and isinstance(data.get("bundles"), list):
                return {"bundles": data.get("bundles")}
    except Exception as e:
        _logging.getLogger(__name__).warning("[bundles.catalog] fetch failed: %s", e)
    return {"bundles": []}


def find_bundle(model_name: str, platform: str, arch: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """First catalog entry matching ``model_name`` + ``platform`` (+ ``arch`` when given)."""
    for b in load_catalog().get("bundles", []) or []:
        if not isinstance(b, dict):
            continue
        if b.get("model_name") != model_name or b.get("platform") != platform:
            continue
        if arch and b.get("arch") and b.get("arch") != arch:
            continue
        return b
    return None


def filter_catalog_for_current_platform(catalog: Dict[str, Any]) -> List[Dict[str, Any]]:
    info = _current_platform_arch()
    plat = info["platform"]
    arch = info["arch"]
    out: List[Dict[str, Any]] = []
    for b in catalog.get("bundles", []):
        try:
            if b.get("platform") == plat and b.get("arch") == arch:
                out.append(b)
        except Exception:
            continue
    return out


def catalog_gcs_uris(catalog: Optional[Dict[str, Any]] = None) -> set[str]:
    """All known bundle object URIs from catalog.json (any platform)."""
    data = catalog if catalog is not None else load_catalog()
    uris: set[str] = set()
    for b in data.get("bundles", []) or []:
        if not isinstance(b, dict):
            continue
        for key in ("gcs_uri", "gs_uri", "uri"):
            val = b.get(key)
            if isinstance(val, str) and val.startswith("gs://"):
                uris.add(val)
    return uris


def assert_gcs_uri_in_catalog(gcs_uri: str) -> Optional[str]:
    """Return an error message when ``gcs_uri`` is not a published bundle."""
    if not gcs_uri or not isinstance(gcs_uri, str) or not gcs_uri.startswith("gs://"):
        return "Invalid bundle URI"
    allowed = catalog_gcs_uris()
    if not allowed:
        return "Bundle catalog unavailable; cannot resolve bundle URIs"
    if gcs_uri not in allowed:
        return "Bundle URI is not in the published bundles catalog"
    return None


def _parse_gs_uri(gs_uri: str) -> Optional[Dict[str, str]]:
    # Expect gs://bucket/path/to/object
    if not gs_uri or not gs_uri.startswith("gs://"):
        return None
    try:
        without = gs_uri[len("gs://"):]
        bucket, _, obj = without.partition("/")
        if not bucket or not obj:
            return None
        return {"bucket": bucket, "object": obj}
    except Exception:
        return None


def resolve_download_url(gs_uri: str, filename: Optional[str] = None) -> Dict[str, Any]:
    """Map a catalog ``gs://bucket/object`` URI onto the public bundle host.

    ``TL_BUNDLE_BASE_URL`` already names the bucket, so only the object path
    is appended. The result key is still ``signed_url`` for the renderer.
    """
    parsed = _parse_gs_uri(gs_uri)
    if not parsed:
        return {"status": "fail", "message": f"Invalid bundle URI: {gs_uri}"}
    base = _bundle_base_url()
    if not base:
        return {"status": "fail", "message": "TL_BUNDLE_BASE_URL not configured"}
    url = f"{base}/{parsed['object'].lstrip('/')}"
    return {"status": "success", "signed_url": url, "expires_at": None}


# ---------------------------
# Bundle install workflow (SSE)
# ---------------------------

# In-memory install state
_install_states: Dict[str, Dict[str, Any]] = {}
# Per-install ordered event logs to avoid coalescing fast updates
_install_event_logs: Dict[str, List[Dict[str, Any]]] = {}

# How long a finished install's state and event log stay readable by a
# reconnecting SSE client before they are reclaimed.
_INSTALL_STATE_TTL_SEC = 30 * 60
_INSTALL_TERMINAL = frozenset({"done", "completed", "success", "error", "failed", "cancelled"})


def _purge_finished_installs(now: float | None = None) -> int:
    """Drop terminal install records past their TTL. Returns how many went.

    The per-install event log is already capped, but the number of installs was
    not — every bundle ever installed kept up to a thousand event dicts for the
    life of the process.
    """
    current = time.time() if now is None else now
    expired = [
        iid for iid, st in _install_states.items()
        if str(st.get("status") or "").lower() in _INSTALL_TERMINAL
        and current - float(st.get("ts") or 0.0) >= _INSTALL_STATE_TTL_SEC
    ]
    for iid in expired:
        _install_states.pop(iid, None)
        _install_event_logs.pop(iid, None)
    return len(expired)


def _set_install_state(install_id: str, **kwargs):
    try:
        _purge_finished_installs()
        st = _install_states.get(install_id, {})
        st.update(kwargs)
        st["ts"] = time.time()
        _install_states[install_id] = st
        # Append to per-install event log so SSE can emit all intermediate states
        log = _install_event_logs.get(install_id)
        if log is None:
            log = []
            _install_event_logs[install_id] = log
        # store a shallow copy to freeze the event at this moment
        log.append(dict(st))
        # prevent unbounded growth
        if len(log) > 2000:
            del log[: len(log) - 1000]
    except Exception:
        pass

async def generate_install_events(install_id: str):
    """Async generator for SSE install status by install_id.
    Emits all queued state changes in order to prevent coalescing fast updates (e.g., final 100% download)."""
    import json as _json
    # Emit any existing log from the beginning
    cursor = 0
    last_send_monotonic = 0.0
    HEARTBEAT_INTERVAL_SEC = 15.0
    while True:
        try:
            now = time.monotonic()
            log = _install_event_logs.get(install_id, [])
            # Emit all new events since last cursor
            while cursor < len(log):
                st = log[cursor]
                cursor += 1
                payload = {"install_id": install_id, **st}
                yield f"data: {_json.dumps(payload)}\n\n"
                last_send_monotonic = now
                if st.get("status") in ("done", "failed"):
                    return
            if (now - last_send_monotonic) >= HEARTBEAT_INTERVAL_SEC:
                # Unpack/activate steps can stall without status changes for minutes.
                yield f"data: {_json.dumps({'heartbeat': True, 'ts': int(time.time())})}\n\n"
                last_send_monotonic = now
            await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            return
        except Exception:
            await asyncio.sleep(0.2)

def _ensure_dirs():
    os.makedirs(NODES_DIR, exist_ok=True)
    os.makedirs(TMP_DIR, exist_ok=True)

def _download_with_progress(url: str, target_path: str, install_id: str) -> Dict[str, Any]:
    """Stream download to target_path and update progress in _install_states."""
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req) as resp, open(target_path, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        received = 0
        chunk_size = 4 * 1024 * 1024
        while True:
            chunk = resp.read(chunk_size)
            if not chunk:
                break
            out.write(chunk)
            received += len(chunk)
            _set_install_state(install_id, status="downloading", step="download", received_bytes=received, total_bytes=total)
        # Emit a final 100% progress update before transitioning to the next step
        if total > 0:
            _set_install_state(install_id, status="downloading", step="download", received_bytes=total, total_bytes=total)
        else:
            _set_install_state(install_id, status="downloading", step="download", received_bytes=received, total_bytes=received)
    return {"received": received, "total": total}

def _extract_tar_gz(tar_path: str, dest_dir: str):
    with tarfile.open(tar_path, "r:gz") as tar:
        def is_within_directory(directory, target):
            abs_directory = os.path.abspath(directory)
            abs_target = os.path.abspath(target)
            prefix = os.path.commonprefix([abs_directory, abs_target])
            return prefix == abs_directory
        def safe_extract(tar_obj, path="."):
            for member in tar_obj.getmembers():
                member_path = os.path.join(path, member.name)
                if not is_within_directory(path, member_path):
                    raise Exception("Attempted Path Traversal in Tar File")
            tar_obj.extractall(path)
        safe_extract(tar, dest_dir)

def _chmod_executable(path: str):
    try:
        mode = os.stat(path).st_mode
        os.chmod(path, mode | 0o111)
    except Exception:
        pass

def _persist_runtime(model_name: str, service_path: str):
    try:
        from app.utils.workflow.model_store import model_store
        store_nodes = model_store.get_nodes_extended()
        existing_factory = None
        try:
            existing_factory = (store_nodes.get(model_name) or {}).get("factory")
        except Exception:
            existing_factory = None
        # Merge runtime service_path into node's metadata
        model_store.register_node(model_name, factory=existing_factory, metadata={
            "runtime": {
                "service_path": service_path,
            }
        })
        return True
    except Exception:
        return False

def _activate_node(model_name: str, service_path: str) -> Dict[str, Any]:
    try:
        from app.services.tasks import register_custom_node_endpoint as service_register_custom_node_endpoint
        from app.utils.workflow.model_store import model_store
        # Use the existing factory for this node if known; fallback to None
        try:
            store_nodes = model_store.get_nodes_extended()
            existing_factory = (store_nodes.get(model_name) or {}).get("factory")
        except Exception:
            existing_factory = None
        # For prebuilt binaries, env/dependency are not required
        res = service_register_custom_node_endpoint(
            model_name=model_name,
            python_version="3.11",
            service_path=service_path,
            dependency_path="",
            factory=existing_factory,
            description=None,
            port=None,
            env_name=None,
            install_dependencies=False,
            io_specs=None,
            log_path=None,
        )
        return res or {"code": 1, "message": "Unknown activation response"}
    except Exception as e:
        return {"code": 1, "message": str(e)}

def start_bundle_install(model_name: str, gcs_uri: str, filename: Optional[str], entry_relative_path: str,
                         expected_size: Optional[int] = None, expected_sha256: Optional[str] = None) -> str:
    """Start install in a background thread and return install_id."""
    install_id = str(uuid.uuid4())
    _set_install_state(install_id, status="queued", model_name=model_name, message="Queued")

    def _run():
        import logging
        lg = logging.getLogger(__name__)
        try:
            _ensure_dirs()
            # Resolve the public download URL
            _set_install_state(install_id, status="signing", step="sign")
            sign_res = resolve_download_url(gcs_uri, filename=filename)
            if sign_res.get("status") != "success":
                _set_install_state(install_id, status="failed", step="sign", message=sign_res.get("message", "Failed to resolve URL"))
                return
            url = sign_res.get("signed_url")

            # Download to tmp path
            tmp_name = f"{model_name}__{int(time.time())}.tar.gz"
            tmp_path = os.path.join(TMP_DIR, tmp_name)
            _set_install_state(install_id, status="downloading", step="download", received_bytes=0, total_bytes=0)
            dl_stats = _download_with_progress(url, tmp_path, install_id)

            # Optional size check
            if expected_size and dl_stats.get("received") and abs(int(expected_size) - int(dl_stats.get("received"))) > 1024:
                lg.warning("[bundles.install] Size mismatch (expected=%s, got=%s)", expected_size, dl_stats.get("received"))

            # Optional sha256 check
            if expected_sha256:
                _set_install_state(install_id, status="verifying", step="verify")
                h = hashlib.sha256()
                with open(tmp_path, "rb") as f:
                    for chunk in iter(lambda: f.read(4 * 1024 * 1024), b""):
                        h.update(chunk)
                if h.hexdigest().lower() != expected_sha256.lower():
                    _set_install_state(install_id, status="failed", step="verify", message="SHA256 mismatch")
                    try: os.remove(tmp_path)
                    except Exception: pass
                    return

            # Unpack into nodes dir
            dest_root = os.path.join(NODES_DIR, model_name)
            os.makedirs(dest_root, exist_ok=True)
            _set_install_state(install_id, status="unpacking", step="unpack")
            _extract_tar_gz(tmp_path, dest_root)

            # Ensure entry executable
            entry_abs = os.path.join(dest_root, entry_relative_path)
            _chmod_executable(entry_abs)

            # Persist runtime
            _set_install_state(install_id, status="persisting", step="persist", service_path=entry_abs)
            _persist_runtime(model_name, entry_abs)

            # Activate
            _set_install_state(install_id, status="activating", step="activate")
            act_res = _activate_node(model_name, entry_abs)
            if isinstance(act_res, dict) and act_res.get("code") == 0:
                # Monitor activation status and propagate
                try:
                    from app.services.tasks import activation_states
                    start_ts = time.time()
                    while True:
                        st = activation_states.get(model_name)
                        if st and st.get("status") in ("ready", "failed"):
                            if st.get("status") == "ready":
                                _set_install_state(install_id, status="done", step="ready", message="Node is ready")
                            else:
                                _set_install_state(install_id, status="failed", step="activate", message=st.get("data", {}).get("message") or "Activation failed")
                            break
                        if time.time() - start_ts > 600:  # 10 min timeout
                            _set_install_state(install_id, status="failed", step="activate", message="Activation timed out")
                            break
                        time.sleep(0.5)
                except Exception:
                    _set_install_state(install_id, status="failed", step="activate", message="Activation monitoring failed")
            else:
                _set_install_state(install_id, status="failed", step="activate", message=(act_res or {}).get("message", "Activation failed"))

        except Exception as e:
            _set_install_state(install_id, status="failed", step="error", message=str(e))
        finally:
            # Cleanup tmp file
            try:
                if 'tmp_path' in locals() and os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return install_id

