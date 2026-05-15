# app/service/custom_node_service.py
import os
import sys
import re
import time
import random
import string
import socket
import subprocess
import json
import logging
import shutil
from typing import Dict, Optional, List, Tuple
import socket as _socket
from datetime import datetime, timedelta
import shlex
import requests

# record global information of sub-service
# Allow multiple processes per conda env by keying registry with a composite key
# composite_key = f"{env_name}::{model_name}"
CUSTOM_NODE_SERVICE_REGISTRY: Dict[str, Dict] = {}
logger = logging.getLogger(__name__)

# Health check cache to avoid frequent checks on the same node
# Format: {node_key: {"last_check": timestamp, "is_healthy": bool, "cached_running": bool}}
_HEALTH_CHECK_CACHE: Dict[str, Dict] = {}
_HEALTH_CHECK_CACHE_TTL = 5.0  # Cache TTL in seconds (5 seconds)
_HEALTH_CHECK_RECOVERY_TTL = 15.0  # Longer TTL for offline node recovery checks (avoid hammering)
_HEALTH_CHECK_TIMEOUT_NORMAL = 2.0  # Health check timeout for running nodes (was 0.3s — too aggressive)
_HEALTH_CHECK_TIMEOUT_RECOVERY = 3.0  # Slightly longer timeout for recovery checks
_HEALTH_CHECK_FAILURE_THRESHOLD = 3  # Require N consecutive failures before marking offline

# Track consecutive health check failures per node
_HEALTH_CHECK_FAILURE_COUNTS: Dict[str, int] = {}

# Set of node names currently executing a workflow task (skip health checks for these)
_EXECUTING_NODES: set = set()


def mark_node_executing(model_name: str):
    """Mark a node as currently executing (skip health checks)."""
    _EXECUTING_NODES.add(model_name)


def unmark_node_executing(model_name: str):
    """Unmark a node as executing (resume health checks)."""
    _EXECUTING_NODES.discard(model_name)

def _clear_health_check_cache(node_key: str):
    """Clear health check cache, failure count, and executing state for a specific node"""
    if node_key in _HEALTH_CHECK_CACHE:
        del _HEALTH_CHECK_CACHE[node_key]
    _HEALTH_CHECK_FAILURE_COUNTS.pop(node_key, None)
    # Also try to clear executing state by model_name
    # node_key format is "env_name::model_name"
    if "::" in node_key:
        model_name = node_key.split("::", 1)[1]
        _EXECUTING_NODES.discard(model_name)

_TASKNODE_LOGS_BASE_DIR = os.path.abspath(
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "storage", "tasknode_logs")
)
_TASKNODE_LOG_RETENTION_DAYS = max(0, int(os.environ.get("TASKNODE_LOG_RETENTION_DAYS", "7")))
_LAST_LOG_CLEANUP_STAMP: Optional[str] = None


def _safe_name_component(value: str) -> str:
    return "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in value)


def _cleanup_tasknode_logs(base_dir: str, retention_days: int) -> None:
    if retention_days <= 0:
        return

    cutoff_date = datetime.now().date() - timedelta(days=retention_days)

    try:
        for entry in os.scandir(base_dir):
            path = entry.path
            try:
                if entry.is_dir():
                    try:
                        folder_date = datetime.strptime(entry.name, "%Y-%m-%d").date()
                    except ValueError:
                        continue
                    if folder_date < cutoff_date:
                        shutil.rmtree(path, ignore_errors=True)
                elif entry.is_file() and entry.name.lower().endswith(".log"):
                    try:
                        file_date = datetime.fromtimestamp(entry.stat().st_mtime).date()
                    except Exception:
                        continue
                    if file_date < cutoff_date:
                        try:
                            os.remove(path)
                        except Exception:
                            pass
            except Exception:
                continue
    except FileNotFoundError:
        pass


def _resolve_log_path(model_name: str, env_name: str, override: Optional[str] = None) -> str:
    if override:
        override_dir = os.path.dirname(os.path.abspath(override))
        if override_dir:
            os.makedirs(override_dir, exist_ok=True)
        return override

    global _LAST_LOG_CLEANUP_STAMP

    os.makedirs(_TASKNODE_LOGS_BASE_DIR, exist_ok=True)

    today_stamp = datetime.now().strftime("%Y-%m-%d")
    if _LAST_LOG_CLEANUP_STAMP != today_stamp:
        _cleanup_tasknode_logs(_TASKNODE_LOGS_BASE_DIR, _TASKNODE_LOG_RETENTION_DAYS)
        _LAST_LOG_CLEANUP_STAMP = today_stamp

    day_dir = os.path.join(_TASKNODE_LOGS_BASE_DIR, today_stamp)
    os.makedirs(day_dir, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_model = _safe_name_component(model_name)
    safe_env = _safe_name_component(env_name)
    return os.path.join(day_dir, f"{safe_model}__{safe_env}__{ts}.log")


# --- Process management utilities -------------------------------------------------
def _kill_process_tree(pid: Optional[int]) -> Tuple[bool, str]:
    """
    Terminate a process and all of its children cross-platform.

    Returns (ok, message)
    """
    try:
        if pid is None or int(pid) <= 0:
            return False, "invalid pid"
    except Exception:
        return False, "invalid pid"

    # Try psutil if available
    try:
        import psutil  # type: ignore
        try:
            proc = psutil.Process(int(pid))
        except psutil.NoSuchProcess:
            return True, "no such process"

        children = proc.children(recursive=True)
        for c in children:
            try:
                c.terminate()
            except Exception:
                pass
        gone, alive = psutil.wait_procs(children, timeout=5)
        for a in alive:
            try:
                a.kill()
            except Exception:
                pass
        # now parent
        try:
            proc.terminate()
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except psutil.TimeoutExpired:
            try:
                proc.kill()
            except Exception:
                pass
        return True, "terminated (psutil)"
    except Exception:
        # Fallback without psutil
        pass

    # Platform-specific fallbacks
    try:
        if os.name == 'nt' or sys.platform.startswith('win'):
            # taskkill terminates the whole tree (/T) forcefully (/F)
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True, "terminated (taskkill)"
        else:
            import signal
            # Try graceful TERM
            try:
                os.kill(int(pid), signal.SIGTERM)
            except Exception:
                pass
            # Best-effort: kill children by parent
            try:
                subprocess.run(["pkill", "-TERM", "-P", str(pid)], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                pass
            # Force kill parent
            try:
                os.kill(int(pid), signal.SIGKILL)
            except Exception:
                pass
            return True, "terminated (signals)"
    except Exception as e:
        return False, f"terminate error: {e}"


def cleanup_all_custom_node_processes() -> Dict[str, str]:
    """
    Kill all processes recorded in CUSTOM_NODE_SERVICE_REGISTRY. Returns mapping key->result message.
    """
    results: Dict[str, str] = {}
    for key, rec in list(CUSTOM_NODE_SERVICE_REGISTRY.items()):
        proc = rec.get("process")
        pid = getattr(proc, 'pid', None)
        ok, msg = _kill_process_tree(pid)
        results[key] = msg
        try:
            # Clear entry regardless
            CUSTOM_NODE_SERVICE_REGISTRY[key]["process"] = None
            CUSTOM_NODE_SERVICE_REGISTRY[key]["ready"] = False
        except Exception:
            pass
    return results


def find_free_port(start_port: int = 8001, max_tries: int = 100) -> Optional[int]:
    """
    from start_port, try the bindings in order, and return if you find an available port.
    """
    port = start_port
    for _ in range(max_tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("0.0.0.0", port))
                return port
            except OSError:
                port += 1
    return None


def get_env_name_from_model(model_name: str) -> str:
    """
    Generate a fixed environment name based on model_name
    """
    return f"{model_name}_tissuelab_ai_service_tasknode"


def _is_port_available(port: int) -> bool:
    with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as s:
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def _conda_env_exists(env_name: str) -> bool:
    """Check if a conda env exists by name using a login shell and JSON output."""
    try:
        is_windows = os.name == 'nt' or sys.platform.startswith('win')
        if is_windows:
            proc = subprocess.run(["cmd", "/c", "conda", "env", "list", "--json"], capture_output=True, text=True)
        else:
            proc = subprocess.run(["/bin/bash", "-lc", "conda env list --json"], capture_output=True, text=True)
        if proc.returncode != 0:
            return False
        data = json.loads(proc.stdout or "{}")
        paths: List[str] = data.get("envs", []) or []
        for p in paths:
            # Compare by basename to handle full paths
            name = p.strip().split("/")[-1].split("\\")[-1]
            if name == env_name:
                return True
        return False
    except Exception:
        return False


def _conda_env_path(env_name: str) -> Optional[str]:
    """Return absolute path of a conda env by name, or None if not found."""
    try:
        is_windows = os.name == 'nt' or sys.platform.startswith('win')
        if is_windows:
            proc = subprocess.run(["cmd", "/c", "conda", "env", "list", "--json"], capture_output=True, text=True)
        else:
            proc = subprocess.run(["/bin/bash", "-lc", "conda env list --json"], capture_output=True, text=True)
        if proc.returncode != 0 or not proc.stdout:
            return None
        data = json.loads(proc.stdout)
        paths: List[str] = data.get("envs", []) or []
        for p in paths:
            base = p.strip().split("/")[-1].split("\\")[-1]
            if base == env_name:
                return p
        return None
    except Exception:
        return None


def create_custom_node_env(
    model_name: str,
    service_path: str,
    dependency_path: str,
    python_version: str,
    port: Optional[int] = None,
    env_name: Optional[str] = None,
    install_dependencies: bool = True,
    log_path_override: Optional[str] = None,
) -> dict:
    """
    Create or reuse existing Conda environment, install dependencies and start service
    
    service_path: Uvicorn entry point when starting the service (e.g., "custom_node:app")
    dependency_path: Absolute path to requirements.txt
    python_version: Python version used to create the Conda environment (e.g., "3.9")
    """
    env_name = env_name or get_env_name_from_model(model_name)

    # Prepare per-run log file under storage/tasknode_logs as early as possible
    log_path = _resolve_log_path(model_name, env_name, override=log_path_override)
    # Open log for append; reuse for all subsequent commands and service stdout/stderr
    try:
        log_file_handle = open(log_path, "a")
    except Exception:
        # Fallback to stdio if log cannot be opened
        log_file_handle = None

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    print(f"[Custom Node Service] Processing model: {model_name}, env: {env_name}")
    if log_file_handle:
        try:
            log_file_handle.write(f"[Custom Node Service] Starting setup for model={model_name} env={env_name} at {ts}\n")
            log_file_handle.flush()
        except Exception:
            pass

    # Decide whether to use conda env based on service_path type (executables don't need env)
    is_windows = os.name == 'nt' or sys.platform.startswith('win')
    is_executable_mode = False
    try:
        is_executable_mode = (
            bool(service_path)
            and os.path.isfile(service_path)
            and os.access(service_path, os.X_OK)
            and not service_path.lower().endswith('.py')
            and not service_path.lower().endswith('.spec')
        )
    except Exception:
        is_executable_mode = False

    python_exec = None
    arch_prefix: List[str] = []

    if not is_executable_mode:
        env_exists = _conda_env_exists(env_name)

        # Create env if missing, regardless of whether the name was user-specified or auto-derived
        if not env_exists:
            print(f"[Custom Node Service] Creating new conda environment: {env_name}")
            if log_file_handle:
                try:
                    log_file_handle.write(f"$ conda create -n {env_name} python={python_version} -y\n")
                    log_file_handle.write(f"[Custom Node Service] Creating new conda environment: {env_name}\n")
                    log_file_handle.flush()
                except Exception:
                    pass
            create_env_cmd = ["/bin/bash", "-lc", f"conda create -n {env_name} python={python_version} -y"]
            try:
                subprocess.run(create_env_cmd, check=True, stdout=log_file_handle, stderr=log_file_handle)
            except subprocess.CalledProcessError as e:
                return {"status": "fail", "message": f"Failed to create environment: {e}", "log_path": log_path}
        else:
            print(f"[Custom Node Service] Using existing environment: {env_name}")
            if log_file_handle:
                try:
                    log_file_handle.write(f"[Custom Node Service] Using existing environment: {env_name}\n")
                    log_file_handle.flush()
                except Exception:
                    pass

        # Resolve env python early for consistent architecture and use it for pip installs
        env_path = _conda_env_path(env_name)
        if not env_path:
            return {"status": "fail", "message": f"Could not resolve path for conda env '{env_name}'", "log_path": log_path}
        python_exec = os.path.join(env_path, "python.exe") if is_windows else os.path.join(env_path, "bin", "python")
        if not os.path.exists(python_exec):
            alt = os.path.join(env_path, "CodingAgent", "python.exe") if is_windows else python_exec
            if not os.path.exists(alt):
                return {"status": "fail", "message": f"Python executable not found in env '{env_name}'", "log_path": log_path}
            python_exec = alt
        if not is_windows:
            try:
                file_out = subprocess.run(["/usr/bin/file", "-b", python_exec], capture_output=True, text=True)
                desc = (file_out.stdout or "").lower()
                if "x86_64" in desc and os.path.exists("/usr/bin/arch"):
                    arch_prefix = ["/usr/bin/arch", "-x86_64"]
            except Exception:
                pass

    # 2. Optionally install dependencies
    if (not is_executable_mode) and install_dependencies:
        print(f"[Custom Node Service] Installing dependencies for {env_name}")
        if not os.path.exists(dependency_path):
            return {"status": "fail", "message": f"Dependency file not found: {dependency_path}", "log_path": log_path}
        pip_cmd: List[str] = arch_prefix + [python_exec, "-u", "-m", "pip", "install", "-r", dependency_path]
        if log_file_handle:
            try:
                log_file_handle.write(f"[Custom Node Service] Installing dependencies for {env_name}\n")
                log_file_handle.write("$ " + " ".join(shlex.quote(x) for x in pip_cmd) + "\n")
                log_file_handle.flush()
            except Exception:
                pass
        # Ensure the env bin path is at front for any subtools spawned by pip
        env_vars = os.environ.copy()
        env_vars["PYTHONUNBUFFERED"] = "1"
        if is_windows:
            env_dirs = [
                env_path,
                os.path.join(env_path, "CodingAgent"),
                os.path.join(env_path, "Library", "bin"),
            ]
            env_vars["PATH"] = ";".join(env_dirs + [env_vars.get('PATH', '')])
            env_vars["CONDA_PREFIX"] = env_path
        else:
            env_bin = os.path.join(env_path, "bin")
            env_vars["PATH"] = f"{env_bin}:{env_vars.get('PATH','')}"
            env_vars["CONDA_PREFIX"] = env_path
        try:
            subprocess.run(pip_cmd, check=True, stdout=log_file_handle, stderr=log_file_handle, env=env_vars)
        except subprocess.CalledProcessError as e:
            return {"status": "fail", "message": f"Install dependencies failed: {e}", "log_path": log_path}

    # 3. pick a port (explicit or free)
    requested_port = port
    port_auto_selected = False
    if port is not None:
        if not _is_port_available(port):
            alt = find_free_port(start_port=(int(port) + 1))
            if alt is None:
                return {"status": "fail", "message": f"Requested port {port} is not available and no free port was found", "log_path": log_path}
            port = alt
            port_auto_selected = True
    else:
        port = find_free_port(start_port=8001)
        if port is None:
            return {"status": "fail", "message": "No available port", "log_path": log_path}

    print(f"[Custom Node Service] Starting service on port {port}")
    # 4. start the service (detect mode: executable vs python script)

    def _build_cmd(path: str, p: int) -> List[str]:
        try:
            if os.path.isfile(path) and os.access(path, os.X_OK) and not path.lower().endswith('.py'):
                # Compiled binary or executable script
                return arch_prefix + [path, "--port", str(p), "--name", model_name]
        except Exception:
            pass
        # Default: run as python script
        return arch_prefix + [python_exec, path, "--port", str(p), "--name", model_name]

    cmd = _build_cmd(service_path, port)
    print(f"[Custom Node Service] Exec: {' '.join(shlex.quote(c) for c in cmd)}")
    print(f"[Custom Node Service] Logging to: {log_path}")
    # Prefer the service file's directory as working dir; fallback to dependency folder or current dir
    working_dir = os.path.dirname(service_path) or (os.path.dirname(dependency_path) if dependency_path else ".")
    print(f"[Custom Node Service] Working directory: {working_dir}")
    # Reuse existing log file handle if available; else open a new one
    if log_file_handle is None:
        log_file_handle = open(log_path, "a")
    env_vars = os.environ.copy()
    env_vars["PYTHONUNBUFFERED"] = "1"
    env_vars["CUDA_VISIBLE_DEVICES"] = "0"
    if not is_executable_mode:
        # Ensure env's bin is first on PATH
        if is_windows:
            env_dirs = [
                env_path,
                os.path.join(env_path, "CodingAgent"),
                os.path.join(env_path, "Library", "bin"),
            ]
            env_vars["PATH"] = ";".join(env_dirs + [env_vars.get('PATH', '')])
            env_vars["CONDA_PREFIX"] = env_path
        else:
            env_bin = os.path.join(env_path, "bin")
            env_vars["PATH"] = f"{env_bin}:{env_vars.get('PATH','')}"
            env_vars["CONDA_PREFIX"] = env_path
    proc = subprocess.Popen(cmd, cwd=working_dir, stdout=log_file_handle, stderr=log_file_handle, env=env_vars)
    # Record to registry immediately but mark not ready yet; avoid reporting as running until ready
    composite_key = f"{env_name}::{model_name}"
    CUSTOM_NODE_SERVICE_REGISTRY[composite_key] = {
        "port": port,
        "process": proc,
        "model_name": model_name,
        "env_name": env_name,
        "log_path": log_path,
        "ready": False,
        "activation_complete": False,
    }

    def _wait_for_listen(p: subprocess.Popen, target_port: int, timeout: float = 12.0) -> bool:
        start = time.time()
        while time.time() - start < timeout:
            # If process died, stop waiting
            if p.poll() is not None:
                return False
            # Try TCP connect
            try:
                s = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
                s.settimeout(0.5)
                s.connect(("127.0.0.1", int(target_port)))
                s.close()
                return True
            except Exception:
                pass
            time.sleep(0.3)
        return False

    ready = _wait_for_listen(proc, port, timeout=120.0)
    if not ready:
        # If process died, attempt a one-time restart on a new port; otherwise, report failure
        try:
            if proc.poll() is not None:
                alt_port = find_free_port(start_port=int(port) + 1) or find_free_port(start_port=8001)
                if alt_port is None:
                    return {"status": "fail", "message": f"Failed to start service; no fallback port available", "log_path": log_path}
                port = alt_port
                port_auto_selected = True
                cmd = _build_cmd(service_path, port)
                proc = subprocess.Popen(cmd, cwd=working_dir, stdout=log_file_handle, stderr=log_file_handle, env=env_vars)
                CUSTOM_NODE_SERVICE_REGISTRY[composite_key] = {
                    "port": port,
                    "process": proc,
                    "model_name": model_name,
                    "env_name": env_name,
                    "log_path": log_path,
                    "ready": False,
                    "activation_complete": False,
                }
                # Allow up to 120s for restart as well
                ready = _wait_for_listen(proc, port, timeout=120.0)
            # else: still starting; proceed without killing (treat as not ready)
        except Exception:
            pass

    # If still not ready after attempts, return failure so caller/SSE can report 'failed'
    if not ready:
        try:
            CUSTOM_NODE_SERVICE_REGISTRY[composite_key] = {
                "port": port,
                "process": proc,
                "model_name": model_name,
                "env_name": env_name,
                "log_path": log_path,
                "ready": False,
                "activation_complete": True,
            }
        except Exception:
            pass
        return {"status": "fail", "message": "Failed to start service within timeout", "log_path": log_path}

    # 5. record to registry final state; mark ready based on readiness check
    composite_key = f"{env_name}::{model_name}"
    CUSTOM_NODE_SERVICE_REGISTRY[composite_key] = {
        "port": port,
        "process": proc,
        "model_name": model_name,
        "env_name": env_name,
        "log_path": log_path,
        "ready": bool(ready),
        "activation_complete": True,
    }

    print(f"[Custom Node Service] Service started successfully on port {port}")
    return {"status": "success", "env_name": env_name, "port": port, "log_path": log_path}


def check_remote_node_health(remote_host: str, port: int, timeout: float = 5.0) -> Tuple[bool, str]:
    """
    Check if a remote node is healthy by calling its /status endpoint (fallback to /health).
    Most tasknodes use /status endpoint.
    
    Args:
        remote_host: Remote server hostname/IP
        port: Port number of the remote service
        timeout: Request timeout in seconds
        
    Returns:
        Tuple of (is_healthy: bool, message: str)
    """
    # Try /status endpoint first (most tasknodes use this)
    endpoints = ["/status", "/health"]
    
    last_error = None
    for endpoint in endpoints:
        try:
            health_url = f"http://{remote_host}:{port}{endpoint}"
            response = requests.get(health_url, timeout=timeout)
            
            if response.status_code == 200:
                return True, f"Health check passed via {endpoint}"
            else:
                last_error = f"Health check failed with status {response.status_code} on {endpoint}"
        except requests.exceptions.ConnectionError as e:
            last_error = f"Failed to connect to {remote_host}:{port}"
            # Try next endpoint
            continue
        except requests.exceptions.Timeout as e:
            last_error = f"Health check timeout for {remote_host}:{port}"
            # Try next endpoint
            continue
        except Exception as e:
            last_error = f"Health check error on {endpoint}: {str(e)}"
            # Try next endpoint
            continue
    
    # If all endpoints failed, return the last error
    return False, last_error or f"Health check failed for {remote_host}:{port}"


def register_custom_node(
    model_name: str,
    service_path: str,
    dependency_path: str,
    python_version: str,
    port: Optional[int] = None,
    env_name: Optional[str] = None,
    install_dependencies: bool = True,
    log_path: Optional[str] = None,
    # is_remote is the single source of truth for remote vs local.
    # remote_host/mnt_path are only used when is_remote=True.
    is_remote: bool = False,
    remote_host: Optional[str] = None,
    mnt_path: Optional[str] = None,
) -> dict:
    """
    Register custom node (local or remote):
    - For local nodes: Check if a service with the same model_name is running,
      stop it if exists, create environment if not exists, start new service
    - For remote nodes: Only perform health check, register if healthy
      (remote node should be already running and managed externally)
    """
    # Respect provided env_name if given; otherwise derive a default
    env_name = env_name or get_env_name_from_model(model_name)
    
    # Stop existing service for the same (env_name, model_name) only
    composite_key = f"{env_name}::{model_name}"
    existing_port = None
    if composite_key in CUSTOM_NODE_SERVICE_REGISTRY:
        # Always save existing port for potential reuse (only for local nodes)
        existing_port = CUSTOM_NODE_SERVICE_REGISTRY[composite_key].get("port")
        if existing_port:
            print(f"[Custom Node Service] Found existing port {existing_port} in registry for {composite_key}")

        proc = CUSTOM_NODE_SERVICE_REGISTRY[composite_key].get("process")
        try:
            if proc is not None and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except Exception:
                    proc.kill()
        except Exception:
            pass
        del CUSTOM_NODE_SERVICE_REGISTRY[composite_key]

    # Handle remote vs local deployment
    if is_remote:
        if not remote_host:
            return {"status": "fail", "message": "remote_host is required for remote node registration"}
        # For remote nodes, port must be explicitly provided and cannot be modified
        if port is None:
            return {"status": "fail", "message": "Port is required for remote node registration"}
        port_to_use = port  # Use the provided port exactly, do not modify
        # Remote node: perform health check (only once, no retries)
        print(f"[Custom Node Service] Registering remote node: {model_name} at {remote_host}:{port_to_use}")
        
        # Try health check only once
        timeout = 5.0
        print(f"[Custom Node Service] Attempting health check (timeout={timeout}s)...")
        is_healthy, health_message = check_remote_node_health(remote_host, port_to_use, timeout=timeout)
        
        if not is_healthy:
            # check_remote_node_health already returns messages in the format "Failed to connect to host:port"
            # or other error messages, so we can use it directly
            return {"status": "fail", "message": health_message}
        
        print(f"[Custom Node Service] Remote node health check passed: {health_message}")
        
        # Register remote node in registry (no local process)
        # For remote nodes, set log_path to model_name so frontend can show log button
        # The frontend will use model_name to call the /logs/tail API endpoint
        CUSTOM_NODE_SERVICE_REGISTRY[composite_key] = {
            "env_name": env_name,
            "model_name": model_name,
            "port": port_to_use,
            "process": None,  # No local process for remote nodes
            "remote_host": remote_host,
            "mnt_path": mnt_path,
            "log_path": model_name,  # Use model_name for remote nodes so frontend can call /logs/tail API
            "is_remote": True,
            "ready": True,  # Mark as ready since health check passed
            "running": True,
            "activation_complete": True,
        }
        
        return {
            "status": "success",
            "model_name": model_name,
            "env_name": env_name,
            "port": port_to_use,
            "remote_host": remote_host
        }
    else:
        # For local nodes, use requested port, or fallback to existing port if no port was requested
        port_to_use = port if port is not None else existing_port
        if not port_to_use:
            return {"status": "fail", "message": "Port is required for node registration"}
        
        # Local node deployment
        result = create_custom_node_env(
            model_name=model_name,
            service_path=service_path,
            dependency_path=dependency_path,
            python_version=python_version,
            port=port_to_use,
            env_name=env_name,
            install_dependencies=install_dependencies,
            log_path_override=log_path,
        )
        if result.get("status") != "success":
            return result
        
        # Mark as explicitly local for consistent downstream checks.
        if composite_key in CUSTOM_NODE_SERVICE_REGISTRY:
            CUSTOM_NODE_SERVICE_REGISTRY[composite_key]["is_remote"] = False

        port = result.get("port")
        return {"status": "success", "model_name": model_name, "env_name": env_name, "port": port}


def list_custom_node_services(skip_health_checks: bool = False) -> dict:
    """
    return all custom node services (both local and remote)
    Performs health checks for both local and remote nodes to detect offline nodes.
    
    Args:
        skip_health_checks: If True, skip health checks to avoid timeout delays (useful during disconnect operations)
    """
    result = {}
    logger.debug(f"[list_custom_node_services] registry_size={len(CUSTOM_NODE_SERVICE_REGISTRY)}, skip_health_checks={skip_health_checks}")
    # Create a snapshot of items to avoid "dictionary changed size during iteration" error
    # This can happen if a node is registered while we're iterating
    registry_snapshot = list(CUSTOM_NODE_SERVICE_REGISTRY.items())
    nodes_to_remove = []  # Track nodes that should be removed from registry
    
    for key, info in registry_snapshot:
        # Skip if node was removed from registry during iteration (e.g., during disconnect)
        # This avoids health checks on nodes that are being disconnected
        if key not in CUSTOM_NODE_SERVICE_REGISTRY:
            logger.debug(f"[list_custom_node_services] Skipping {key} - node was removed from registry")
            continue
            
        proc = info.get("process")
        is_remote = info.get("is_remote")
        remote_host = info.get("remote_host")
        model_name = info.get("model_name", "")
        
        # For remote nodes, perform actual health check
        if is_remote is True and remote_host:
            port = info.get("port")
            current_running_status = info.get("running", False)

            # --- Skip health checks when explicitly requested (e.g. disconnect operation) ---
            if skip_health_checks:
                running = current_running_status if port and info.get("ready", False) else False

            # --- Skip health checks for nodes that are currently executing a workflow task ---
            # During /execute the node's HTTP server is likely blocked (single worker),
            # so any /status probe would timeout and falsely mark the node offline.
            elif model_name in _EXECUTING_NODES:
                running = current_running_status if port and info.get("ready", False) else False
                logger.debug(f"[list_custom_node_services] Skipping health check for {key} — node is currently executing")

            # --- Node is marked as ready + running: normal periodic health check ---
            elif port and info.get("ready", False) and current_running_status:
                if key not in CUSTOM_NODE_SERVICE_REGISTRY:
                    logger.debug(f"[list_custom_node_services] Skipping health check for {key} - node was removed from registry")
                    continue
                
                current_time = time.time()
                cache_entry = _HEALTH_CHECK_CACHE.get(key)
                use_cache = False
                
                if cache_entry:
                    time_since_check = current_time - cache_entry.get("last_check", 0)
                    if time_since_check < _HEALTH_CHECK_CACHE_TTL:
                        running = cache_entry.get("cached_running", False)
                        use_cache = True
                        logger.debug(f"[list_custom_node_services] Using cached health check result for {key} (checked {time_since_check:.1f}s ago)")
                
                if not use_cache:
                    try:
                        is_healthy, health_msg = check_remote_node_health(remote_host, port, timeout=_HEALTH_CHECK_TIMEOUT_NORMAL)
                        if key not in CUSTOM_NODE_SERVICE_REGISTRY:
                            logger.debug(f"[list_custom_node_services] Node {key} was removed during health check, skipping")
                            continue
                        if not is_healthy:
                            # Increment consecutive failure counter instead of immediately marking offline
                            fail_count = _HEALTH_CHECK_FAILURE_COUNTS.get(key, 0) + 1
                            _HEALTH_CHECK_FAILURE_COUNTS[key] = fail_count
                            if fail_count >= _HEALTH_CHECK_FAILURE_THRESHOLD:
                                logger.warning(f"[list_custom_node_services] Remote node {key} ({model_name}) offline after {fail_count} consecutive failures: {health_msg}")
                                running = False
                                if key in CUSTOM_NODE_SERVICE_REGISTRY:
                                    CUSTOM_NODE_SERVICE_REGISTRY[key]["running"] = False
                            else:
                                # Not enough failures yet — still consider running
                                logger.debug(f"[list_custom_node_services] Remote node {key} health check failed ({fail_count}/{_HEALTH_CHECK_FAILURE_THRESHOLD}): {health_msg}")
                                running = True  # Tolerate transient failure
                        else:
                            running = True
                            _HEALTH_CHECK_FAILURE_COUNTS.pop(key, None)  # Reset on success
                        
                        _HEALTH_CHECK_CACHE[key] = {
                            "last_check": current_time,
                            "is_healthy": is_healthy,
                            "cached_running": running
                        }
                    except Exception as e:
                        if key not in CUSTOM_NODE_SERVICE_REGISTRY:
                            logger.debug(f"[list_custom_node_services] Node {key} was removed during health check error, skipping")
                            continue
                        fail_count = _HEALTH_CHECK_FAILURE_COUNTS.get(key, 0) + 1
                        _HEALTH_CHECK_FAILURE_COUNTS[key] = fail_count
                        if fail_count >= _HEALTH_CHECK_FAILURE_THRESHOLD:
                            logger.warning(f"[list_custom_node_services] Health check error for remote node {key} ({fail_count} consecutive): {e}")
                            running = False
                            if key in CUSTOM_NODE_SERVICE_REGISTRY:
                                CUSTOM_NODE_SERVICE_REGISTRY[key]["running"] = False
                        else:
                            logger.debug(f"[list_custom_node_services] Health check error for {key} ({fail_count}/{_HEALTH_CHECK_FAILURE_THRESHOLD}): {e}")
                            running = True  # Tolerate transient failure
                        
                        _HEALTH_CHECK_CACHE[key] = {
                            "last_check": current_time,
                            "is_healthy": False,
                            "cached_running": running
                        }

            # --- Node previously marked offline: do periodic RECOVERY checks ---
            # (KEY FIX: previously this branch was skipped entirely, creating a deadlock
            #  where offline nodes could never recover.)
            elif port and info.get("ready", False) and not current_running_status:
                current_time = time.time()
                cache_entry = _HEALTH_CHECK_CACHE.get(key)
                # Use longer TTL for recovery checks to avoid hammering offline nodes
                if cache_entry and (current_time - cache_entry.get("last_check", 0)) < _HEALTH_CHECK_RECOVERY_TTL:
                    running = cache_entry.get("cached_running", False)
                else:
                    # Attempt recovery health check
                    try:
                        is_healthy, health_msg = check_remote_node_health(remote_host, port, timeout=_HEALTH_CHECK_TIMEOUT_RECOVERY)
                        if key not in CUSTOM_NODE_SERVICE_REGISTRY:
                            continue
                        if is_healthy:
                            logger.info(f"[list_custom_node_services] Remote node {key} ({model_name}) RECOVERED — marking as running")
                            running = True
                            if key in CUSTOM_NODE_SERVICE_REGISTRY:
                                CUSTOM_NODE_SERVICE_REGISTRY[key]["running"] = True
                            _HEALTH_CHECK_FAILURE_COUNTS.pop(key, None)
                        else:
                            running = False
                        _HEALTH_CHECK_CACHE[key] = {
                            "last_check": current_time,
                            "is_healthy": is_healthy,
                            "cached_running": running
                        }
                    except Exception as e:
                        if key not in CUSTOM_NODE_SERVICE_REGISTRY:
                            continue
                        logger.debug(f"[list_custom_node_services] Recovery check failed for {key}: {e}")
                        running = False
                        _HEALTH_CHECK_CACHE[key] = {
                            "last_check": current_time,
                            "is_healthy": False,
                            "cached_running": False
                        }
            else:
                # Entry is not marked as ready
                running = False
                if key in _HEALTH_CHECK_CACHE:
                    del _HEALTH_CHECK_CACHE[key]
            pid = None
        else:
            # For local nodes, check process status
            running = False
            try:
                if proc is not None:
                    # Check if process is still alive
                    poll_result = proc.poll()
                    if poll_result is None:
                        # Process is still running
                        running = True
                    else:
                        # Process has terminated (poll() returns exit code, None means still running)
                        logger.warning(f"[list_custom_node_services] Local node {key} ({info.get('model_name')}) process has terminated (exit code: {poll_result})")
                        running = False
                        # Update registry to mark as not running
                        if key in CUSTOM_NODE_SERVICE_REGISTRY:
                            CUSTOM_NODE_SERVICE_REGISTRY[key]["running"] = False
                            CUSTOM_NODE_SERVICE_REGISTRY[key]["process"] = None
                else:
                    # No process object, node is not running
                    logger.warning(f"[list_custom_node_services] Local node {key} ({info.get('model_name')}) has proc=None — process object was lost or cleared")
                    running = False
            except Exception as e:
                logger.warning(f"[list_custom_node_services] Error checking local node {key} process: {e}")
                running = False
                # Update registry to mark as not running
                if key in CUSTOM_NODE_SERVICE_REGISTRY:
                    CUSTOM_NODE_SERVICE_REGISTRY[key]["running"] = False
            
            ready = bool(info.get("ready", False))
            activation_complete = bool(info.get("activation_complete", True))  # default True for backward compat
            proc_alive = running  # Save pre-ready check value for diagnostics
            pid = getattr(proc, 'pid', None) if proc is not None else None
            
            # If activation is still in progress (create_custom_node_env is still
            # running _wait_for_listen), skip this node — it's not "offline", it's
            # simply still starting.  Report it as starting so the frontend shows
            # the right state.
            if proc_alive and not ready and not activation_complete:
                logger.info(f"[list_custom_node_services] Local node {key} ({info.get('model_name')}) still activating (pid={pid}), skipping")
                result[key] = {
                    "env_name": info.get("env_name"),
                    "model_name": info.get("model_name"),
                    "port": info.get("port"),
                    "pid": pid,
                    "running": True,   # treat as running so frontend doesn't show offline
                    "starting": True,  # extra flag so frontend can optionally show "starting..."
                    "log_path": info.get("log_path"),
                    "remote_host": remote_host,
                }
                continue
            
            # Auto-recover: if process is alive but ready=False (and activation
            # IS complete), do a quick TCP probe on the port to see if it has
            # become reachable since startup.  This handles the race where
            # _wait_for_listen timed out but the service eventually started.
            if proc_alive and not ready and info.get("port"):
                try:
                    _s = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
                    _s.settimeout(1.0)
                    _s.connect(("127.0.0.1", int(info["port"])))
                    _s.close()
                    # Port is now reachable — fix the ready flag so future calls skip this probe
                    logger.info(f"[list_custom_node_services] LOCAL NODE RECOVERY: {key} ({info.get('model_name')}) port {info['port']} is reachable — setting ready=True")
                    if key in CUSTOM_NODE_SERVICE_REGISTRY:
                        CUSTOM_NODE_SERVICE_REGISTRY[key]["ready"] = True
                    ready = True
                except Exception:
                    pass  # still not reachable, keep ready=False
            
            running = bool(running and ready)
            # Diagnostic: log when ready=False causes a live process to appear offline
            if proc_alive and not ready:
                logger.error(f"[list_custom_node_services] LOCAL NODE BUG: {key} ({info.get('model_name')}) process is ALIVE (pid={pid}) but ready=False → reported as offline! Registry ready={info.get('ready')}")
            if not running:
                logger.info(f"[list_custom_node_services] Local node {key} offline: proc={'alive' if proc is not None and proc_alive else ('exited' if proc is not None else 'None')}, ready={ready}, pid={pid}")
        
        logger.debug(f"[list_custom_node_services] key='{key}' env='{info.get('env_name')}' model='{info.get('model_name')}' pid='{pid}' remote='{remote_host}' running={running} ready={ready if not remote_host else 'n/a'}")
        result[key] = {
            "env_name": info.get("env_name"),
            "model_name": info.get("model_name"),
            "port": info.get("port"),
            "pid": pid,
            "is_remote": bool(is_remote),
            "running": running,
            "ready": ready if not remote_host else None,  # so frontend can show Starting when running but not ready
            "starting": (running and not ready) if not remote_host else None,  # not ready = starting, not disconnected
            "log_path": info.get("log_path"),
            "remote_host": remote_host,
        }
    
    return result


def list_available_conda_envs() -> dict:
    """
    Return available conda environments across platforms. Prefer JSON output; 
    gracefully fall back to text parsing. Never raises; returns [] on failure.
    """

    def _unique(seq):
        seen = set()
        out = []
        for x in seq:
            if x and x not in seen:
                seen.add(x)
                out.append(x)
        return out

    def _basename_cross(path: str) -> str:
        # Split on both separators to be robust across OS/path styles
        parts = re.split(r"[\\/]+", path.strip())
        return parts[-1] if parts else path.strip()

    is_windows = os.name == 'nt' or sys.platform.startswith('win')

    # 1) JSON mode
    try:
        if is_windows:
            proc = subprocess.run(["cmd", "/c", "conda", "env", "list", "--json"], capture_output=True, text=True)
        else:
            proc = subprocess.run(["/bin/bash", "-lc", "conda env list --json"], capture_output=True, text=True)
        if proc.returncode == 0 and proc.stdout:
            data = json.loads(proc.stdout)
            env_paths = data.get("envs", []) or []
            names = [_basename_cross(p) for p in env_paths]
            return {"status": "success", "envs": _unique(names)}
    except Exception:
        pass

    # 2) Fallback: plain text list
    try:
        if is_windows:
            proc = subprocess.run(["cmd", "/c", "conda", "env", "list"], capture_output=True, text=True)
        else:
            proc = subprocess.run(["/bin/bash", "-lc", "conda env list"], capture_output=True, text=True)
        if proc.returncode == 0 and proc.stdout:
            lines = [l.strip() for l in proc.stdout.splitlines()]
            # Skip header and comments; name is the first token on each env line
            names = []
            for line in lines:
                if not line or line.startswith('#') or line.lower().startswith('name'):
                    continue
                token = line.split()[0]
                if token:
                    names.append(token)
            return {"status": "success", "envs": _unique(names)}
    except Exception:
        pass

    # 3) Graceful fallback
    return {"status": "success", "envs": []}


def stop_custom_node_env(env_name: str) -> dict:
    """
    stop and delete the custom node environment
    """
    # Stop and delete the entire conda environment: terminate all processes under this env
    any_found = False
    for key, rec in list(CUSTOM_NODE_SERVICE_REGISTRY.items()):
        if rec.get("env_name") == env_name:
            any_found = True
            proc = rec.get("process")
            pid = getattr(proc, 'pid', None)
            _kill_process_tree(pid)
            del CUSTOM_NODE_SERVICE_REGISTRY[key]
            _clear_health_check_cache(key)
    if not any_found:
        return {"status": "fail", "message": f"Environment {env_name} does not exist"}
    remove_env_cmd = f"conda env remove -n {env_name} -y"
    try:
        subprocess.run(remove_env_cmd, shell=True, check=True)
    except subprocess.CalledProcessError as e:
        return {"status": "fail", "message": f"Failed to remove environment: {e}"}
    return {"status": "success", "message": f"Environment {env_name} has been stopped and removed"}


def stop_custom_node_process(env_or_key: str) -> dict:
    """
    Stop the node process only, keep the conda environment intact.
    Supports local nodes and remote nodes via API.
    """
    # Accept composite key or try to resolve by env name or model_name if only one process exists
    key_to_stop = None
    if env_or_key in CUSTOM_NODE_SERVICE_REGISTRY:
        key_to_stop = env_or_key
    else:
        # find first process under env_name
        for key, rec in CUSTOM_NODE_SERVICE_REGISTRY.items():
            if rec.get("env_name") == env_or_key:
                key_to_stop = key
                break
        # If not found by env_name, try to find by model_name (useful for remote nodes)
        if key_to_stop is None:
            for key, rec in CUSTOM_NODE_SERVICE_REGISTRY.items():
                if rec.get("model_name") == env_or_key:
                    key_to_stop = key
                    break
        # Also try to match composite key format (env_name::model_name)
        if key_to_stop is None and "::" in env_or_key:
            # Try exact match first
            if env_or_key in CUSTOM_NODE_SERVICE_REGISTRY:
                key_to_stop = env_or_key
            else:
                # Try to match by model_name part of composite key
                model_name_part = env_or_key.split("::")[-1]
                for key, rec in CUSTOM_NODE_SERVICE_REGISTRY.items():
                    if rec.get("model_name") == model_name_part:
                        key_to_stop = key
                        break
    # If node not found in registry, it might already be disconnected/stopped
    # For remote nodes, this is acceptable - just return success
    # For local nodes, also return success if node was already stopped
    if key_to_stop is None:
        # Check if this might be a remote node that was already disconnected
        # Try to extract model_name from env_or_key
        model_name = env_or_key
        if "::" in env_or_key:
            model_name = env_or_key.split("::")[-1]
        
        # If it's a remote node request (indicated by model_name), treat as success
        # This allows cleanup of already-disconnected remote nodes
        logger.info(f"[stop_custom_node_process] Node '{env_or_key}' not found in registry, may already be disconnected")
        return {"status": "success", "message": f"Node '{model_name}' was already disconnected or not found in registry"}

    registry_entry = CUSTOM_NODE_SERVICE_REGISTRY[key_to_stop]
    is_remote = registry_entry.get("is_remote")
    remote_host = registry_entry.get("remote_host")

    # Handle remote nodes - they don't have local processes to stop
    if is_remote is True:
        logger.info(f"[stop_custom_node_process] Remote node detected (host: {remote_host}), removing from registry immediately")
        # For remote nodes, remove from registry immediately (no local process to stop, no need to wait)
        # This avoids timeout delays if the node is already offline
        try:
            # Get info before deletion
            stopped_env = registry_entry.get("env_name", env_or_key)
            model_name = registry_entry.get("model_name", env_or_key)
            # Remove the entry from registry immediately - no health checks or other operations needed
            del CUSTOM_NODE_SERVICE_REGISTRY[key_to_stop]
            # Clear health check cache for this node
            _clear_health_check_cache(key_to_stop)
            logger.info(f"[stop_custom_node_process] Remote node '{key_to_stop}' (model: {model_name}, env: {stopped_env}) removed from registry")
            return {"status": "success", "message": f"Remote node {model_name} has been disconnected"}
        except KeyError:
            logger.warning(f"[stop_custom_node_process] Key '{key_to_stop}' not found in registry")
            return {"status": "success", "message": f"Remote node '{key_to_stop}' was already disconnected"}
        except Exception as e:
            logger.error(f"[stop_custom_node_process] Error removing remote node '{key_to_stop}': {e}")
            return {"status": "fail", "message": f"Error disconnecting remote node: {str(e)}"}

    # Local node stopping
    proc = registry_entry.get("process")
    logger.debug(f"[stop_custom_node_process] key='{key_to_stop}' pid='{getattr(proc,'pid',None)}' initial_running={(proc is not None and getattr(proc,'poll',lambda:1)() is None)}")
    
    # Only try to kill process if it exists
    if proc is None:
        logger.info(f"[stop_custom_node_process] No process found for '{key_to_stop}', removing from registry")
        # Remove from registry if no process
        try:
            CUSTOM_NODE_SERVICE_REGISTRY[key_to_stop]["running"] = False
        except Exception:
            pass
        stopped_env = registry_entry.get("env_name", env_or_key)
        return {"status": "success", "message": f"Node {stopped_env} was not running, removed from registry"}
    
    pid = getattr(proc, 'pid', None)
    if pid is None:
        logger.info(f"[stop_custom_node_process] No PID found for '{key_to_stop}', removing from registry")
        # Remove from registry if no PID
        CUSTOM_NODE_SERVICE_REGISTRY[key_to_stop]["process"] = None
        try:
            CUSTOM_NODE_SERVICE_REGISTRY[key_to_stop]["running"] = False
        except Exception:
            pass
        stopped_env = registry_entry.get("env_name", env_or_key)
        return {"status": "success", "message": f"Node {stopped_env} had no PID, removed from registry"}
    
    ok, msg = _kill_process_tree(pid)
    if not ok and "no such process" not in (msg or ""):
        logger.warning(f"[stop_custom_node_process] error stopping pid='{pid}': {msg}")
        return {"status": "fail", "message": f"Failed to stop process: {msg}"}
    # keep registry entry but clear process
    CUSTOM_NODE_SERVICE_REGISTRY[key_to_stop]["process"] = None
    try:
        # Explicitly mark not running
        CUSTOM_NODE_SERVICE_REGISTRY[key_to_stop]["running"] = False
    except Exception:
        pass
    stopped_env = CUSTOM_NODE_SERVICE_REGISTRY.get(key_to_stop, {}).get("env_name", env_or_key)
    logger.debug(f"[stop_custom_node_process] key='{key_to_stop}' stopped;")
    return {"status": "success", "message": f"Process for {stopped_env} has been stopped"}
