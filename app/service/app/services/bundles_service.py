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
import requests
from typing import Dict, Any, List, Optional

try:
    from google.cloud import storage  # type: ignore
except Exception:
    storage = None  # Defer import errors; caller should handle missing dependency


APP_DIR = os.path.dirname(os.path.dirname(__file__))  # .../app
PROJECT_ROOT = os.path.dirname(APP_DIR)               # repo root (parent of app)

NODES_DIR = os.path.join(PROJECT_ROOT, "storage", "nodes")
TMP_DIR = os.path.join(PROJECT_ROOT, "storage", "tmp")
SERVICE_ACCOUNT_DEFAULT_PATH = os.path.join(PROJECT_ROOT, "credentials", "tasknode.json")


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


def load_catalog() -> Dict[str, Any]:
    """Load bundles catalog from STORAGE_BUCKET_NAME environment variable.

    Looks up STORAGE_BUCKET_NAME and fetches:
      https://storage.googleapis.com/$STORAGE_BUCKET_NAME/bundles/catalog.json

    Returns { "bundles": [...] } or empty when unavailable.
    """
    import os as _os
    import json as _json
    import logging as _logging
    import urllib.request as _urlreq

    bucket_name = _os.environ.get("STORAGE_BUCKET_NAME", "").strip()
    if not bucket_name:
        try:
            _logging.getLogger(__name__).warning("[bundles.catalog] STORAGE_BUCKET_NAME not set")
        except Exception:
            pass
        return {"bundles": []}

    try:
        http_url = f"https://storage.googleapis.com/{bucket_name}/bundles/catalog.json"
        with _urlreq.urlopen(http_url, timeout=5) as resp:
            txt = resp.read().decode("utf-8", errors="ignore")
            data = _json.loads(txt)
            if isinstance(data, dict) and isinstance(data.get("bundles"), list):
                return {"bundles": data.get("bundles")}
    except Exception as e:
        try:
            _logging.getLogger(__name__).warning("[bundles.catalog] fetch failed: %s", e)
        except Exception:
            pass

    return {"bundles": []}


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


def _get_gcs_client():
    """Return a google.cloud.storage Client using one of:
    1) Explicit env var GOOGLE_APPLICATION_CREDENTIALS if set (ADC), else
    2) Repo credential at credentials/tasknode.json, else
    3) Default ADC resolution (may fail if not configured)
    """
    if storage is None:
        return None
    try:
        import logging
        lg = logging.getLogger(__name__)
        sa_env = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        if sa_env and os.path.exists(sa_env):
            lg.info("[bundles.gcs] using ADC env GOOGLE_APPLICATION_CREDENTIALS=%s", sa_env)
            return storage.Client()
        if os.path.exists(SERVICE_ACCOUNT_DEFAULT_PATH):
            lg.info("[bundles.gcs] using repo credential at %s", SERVICE_ACCOUNT_DEFAULT_PATH)
            return storage.Client.from_service_account_json(SERVICE_ACCOUNT_DEFAULT_PATH)
        lg.info("[bundles.gcs] using default ADC resolution (no explicit credentials found)")
        return storage.Client()
    except Exception as e:
        try:
            import logging
            logging.getLogger(__name__).error("[bundles.gcs] failed to create client: %s", e)
        except Exception:
            pass
        return None


def get_download_url_from_api(model_name: str = "ClassificationNode", platform: str = "darwin") -> Dict[str, Any]:
    """
    Get download URL from the new API endpoint.
    Returns the response from https://ctrl.vlm.ai/api/community/v1/tasknodes/signed-url
    """
    try:
        # Hardcode values for now
        model_name = "ClassificationNode"
        platform = "darwin"  # or "win", "linux" based on your needs
        
        api_url = "https://ctrl.vlm.ai/api/community/v1/tasknodes/signed-url"
        
        # Make request to get signed URL
        response = requests.post(api_url, json={
            "model_name": model_name,
            "platform": platform
        }, timeout=30)
        
        if response.status_code == 200:
            data = response.json()
            if data.get("success"):
                return {
                    "status": "success",
                    "download_url": data.get("download_url"),
                    "model_name": data.get("model_name"),
                    "platform": data.get("platform"),
                    "filename": data.get("filename"),
                    "expires_in": data.get("expires_in")
                }
            else:
                return {"status": "fail", "message": "API returned success=false"}
        else:
            return {"status": "fail", "message": f"API request failed with status {response.status_code}"}
            
    except requests.exceptions.RequestException as e:
        return {"status": "fail", "message": f"Request failed: {str(e)}"}
    except Exception as e:
        return {"status": "fail", "message": f"Unexpected error: {str(e)}"}


def generate_signed_url(gs_uri: str, minutes: int = 30, filename: Optional[str] = None) -> Dict[str, Any]:
    """
    Generate a V4 signed URL for a GCS object using default credentials.
    Requires google-cloud-storage to be installed and credentials available via ADC
    (e.g., GOOGLE_APPLICATION_CREDENTIALS env var), but the path should NOT be hardcoded in code.
    """
    if storage is None:
        return {"status": "fail", "message": "google-cloud-storage not installed"}

    parsed = _parse_gs_uri(gs_uri)
    if not parsed:
        return {"status": "fail", "message": f"Invalid GCS URI: {gs_uri}"}

    bucket_name = parsed["bucket"]
    object_name = parsed["object"]

    try:
        client = _get_gcs_client()
        if client is None:
            return {"status": "fail", "message": "GCS client not available (credentials missing)"}
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(object_name)
        disposition = None
        if filename:
            disposition = f"attachment; filename=\"{filename}\""
        url = blob.generate_signed_url(
            version="v4",
            expiration=timedelta(minutes=max(1, minutes)),
            method="GET",
            response_disposition=disposition,
        )
        expires_at = int(time.time()) + minutes * 60
        return {"status": "success", "signed_url": url, "expires_at": expires_at}
    except Exception as e:
        return {"status": "fail", "message": str(e)}



# ---------------------------
# Bundle install workflow (SSE)
# ---------------------------

# In-memory install state
_install_states: Dict[str, Dict[str, Any]] = {}
# Per-install ordered event logs to avoid coalescing fast updates
_install_event_logs: Dict[str, List[Dict[str, Any]]] = {}

def _set_install_state(install_id: str, **kwargs):
    try:
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
    while True:
        try:
            log = _install_event_logs.get(install_id, [])
            # Emit all new events since last cursor
            while cursor < len(log):
                st = log[cursor]
                cursor += 1
                payload = {"install_id": install_id, **st}
                yield f"data: {_json.dumps(payload)}\n\n"
                if st.get("status") in ("done", "failed"):
                    return
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
        from app.services.model_store import model_store
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
        from app.services.tasks_service import register_custom_node_endpoint as service_register_custom_node_endpoint
        from app.services.model_store import model_store
        # Use the existing factory for this node if known; fallback to None
        try:
            store_nodes = model_store.get_nodes_extended()
            existing_factory = (store_nodes.get(model_name) or {}).get("factory")
        except Exception:
            existing_factory = None
        # For prebuilt binaries, env/dependency are not required
        res = service_register_custom_node_endpoint(
            model_name=model_name,
            python_version="3.9",
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

def start_bundle_install(model_name: str = "ClassificationNode", gcs_uri: str = None, filename: Optional[str] = None, entry_relative_path: str = "main",
                         expected_size: Optional[int] = None, expected_sha256: Optional[str] = None) -> str:
    """Start install in a background thread and return install_id."""
    install_id = str(uuid.uuid4())
    _set_install_state(install_id, status="queued", model_name=model_name, message="Queued")

    def _run():
        import logging
        lg = logging.getLogger(__name__)
        try:
            _ensure_dirs()
            # Get download URL from new API
            _set_install_state(install_id, status="signing", step="sign")
            api_res = get_download_url_from_api()
            if api_res.get("status") != "success":
                _set_install_state(install_id, status="failed", step="sign", message=api_res.get("message", "Failed to get download URL"))
                return
            url = api_res.get("download_url")
            # Update filename from API response if available
            if api_res.get("filename"):
                filename = api_res.get("filename")

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
                    from app.services.tasks_service import activation_states
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

