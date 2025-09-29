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
from typing import Dict, Optional, List, Tuple
import socket as _socket
from datetime import datetime
import shlex

# record global information of sub-service
# Allow multiple processes per conda env by keying registry with a composite key
# composite_key = f"{env_name}::{model_name}"
CUSTOM_NODE_SERVICE_REGISTRY: Dict[str, Dict] = {}
logger = logging.getLogger(__name__)


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
    logs_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "storage", "tasknode_logs"))
    os.makedirs(logs_dir, exist_ok=True)
    if log_path_override:
        log_path = log_path_override
    else:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_model = "".join(c if c.isalnum() or c in ("-","_") else "_" for c in model_name)
        safe_env = "".join(c if c.isalnum() or c in ("-","_") else "_" for c in env_name)
        log_path = os.path.join(logs_dir, f"{safe_model}__{safe_env}__{ts}.log")
    # Open log for append; reuse for all subsequent commands and service stdout/stderr
    try:
        log_file_handle = open(log_path, "a")
    except Exception:
        # Fallback to stdio if log cannot be opened
        log_file_handle = None

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
            alt = os.path.join(env_path, "Scripts", "python.exe") if is_windows else python_exec
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
                os.path.join(env_path, "Scripts"),
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
    if not is_executable_mode:
        # Ensure env's bin is first on PATH
        if is_windows:
            env_dirs = [
                env_path,
                os.path.join(env_path, "Scripts"),
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
    }

    print(f"[Custom Node Service] Service started successfully on port {port}")
    return {"status": "success", "env_name": env_name, "port": port, "log_path": log_path}


def register_custom_node(
    model_name: str,
    service_path: str,
    dependency_path: str,
    python_version: str,
    port: Optional[int] = None,
    env_name: Optional[str] = None,
    install_dependencies: bool = True,
    log_path: Optional[str] = None,
) -> dict:
    """
    Register custom node:
    - Check if a service with the same model_name is running
    - If exists, stop the service but keep the environment
    - Create environment if not exists, start new service
    """
    # Respect provided env_name if given; otherwise derive a default
    env_name = env_name or get_env_name_from_model(model_name)
    
    # Stop existing service for the same (env_name, model_name) only
    composite_key = f"{env_name}::{model_name}"
    if composite_key in CUSTOM_NODE_SERVICE_REGISTRY:
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

    # Create new service with existing or new environment
    result = create_custom_node_env(
        model_name=model_name,
        service_path=service_path,
        dependency_path=dependency_path,
        python_version=python_version,
        port=port,
        env_name=env_name,
        install_dependencies=install_dependencies,
        log_path_override=log_path,
    )
    if result.get("status") != "success":
        return result
    
    port = result.get("port")
    return {"status": "success", "model_name": model_name, "env_name": env_name, "port": port}


def list_custom_node_services() -> dict:
    """
    return all custom node services
    """
    result = {}
    logger.debug(f"[list_custom_node_services] registry_size={len(CUSTOM_NODE_SERVICE_REGISTRY)}")
    for key, info in CUSTOM_NODE_SERVICE_REGISTRY.items():
        proc = info.get("process")
        running = False
        try:
            running = (proc is not None and proc.poll() is None)
        except Exception:
            running = False
        ready = bool(info.get("ready", False))
        logger.debug(f"[list_custom_node_services] key='{key}' env='{info.get('env_name')}' model='{info.get('model_name')}' pid='{getattr(proc, 'pid', None)}' running={running} ready={ready}")
        result[key] = {
            "env_name": info.get("env_name"),
            "model_name": info.get("model_name"),
            "port": info.get("port"),
            "pid": getattr(proc, 'pid', None),
            # Only report running when process is alive and readiness passed
            "running": bool(running and ready),
            "log_path": info.get("log_path"),
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
    """
    # Accept composite key or try to resolve by env name if only one process exists
    key_to_stop = None
    if env_or_key in CUSTOM_NODE_SERVICE_REGISTRY:
        key_to_stop = env_or_key
    else:
        # find first process under env
        for key, rec in CUSTOM_NODE_SERVICE_REGISTRY.items():
            if rec.get("env_name") == env_or_key:
                key_to_stop = key
                break
    if key_to_stop is None:
        return {"status": "fail", "message": f"No running process found for '{env_or_key}'"}
    proc = CUSTOM_NODE_SERVICE_REGISTRY[key_to_stop].get("process")
    logger.debug(f"[stop_custom_node_process] key='{key_to_stop}' pid='{getattr(proc,'pid',None)}' initial_running={(proc is not None and getattr(proc,'poll',lambda:1)() is None)}")
    pid = getattr(proc, 'pid', None)
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
