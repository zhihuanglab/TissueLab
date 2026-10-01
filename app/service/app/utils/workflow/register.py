# app/service/custom_node_service.py
import errno
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
import traceback
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

from app.config.path_config import SERVICE_STORAGE_DIR as _SERVICE_STORAGE_DIR  # noqa: E402

_TASKNODE_LOGS_BASE_DIR = os.path.join(_SERVICE_STORAGE_DIR, "tasknode_logs")
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


# Grace between SIGTERM and SIGKILL in the no-psutil fallback below.
_KILL_GRACE_SEC = 5.0


def _descendant_pids(root_pid: int, _depth: int = 0) -> List[int]:
    """Every descendant of ``root_pid``, deepest last.

    ``pkill -P`` reaches only one level, so a task node that spawned workers of
    its own survived the parent it was supposed to die with.
    """
    if _depth > 8:  # guard against a pathological tree / pid reuse cycle
        return []
    try:
        out = subprocess.run(
            ["pgrep", "-P", str(root_pid)],
            capture_output=True, text=True, timeout=2,
        ).stdout
    except Exception:
        return []
    found: List[int] = []
    for line in out.split("\n"):
        try:
            child = int(line.strip())
        except ValueError:
            continue
        if child > 0:
            found.append(child)
            found.extend(_descendant_pids(child, _depth + 1))
    return found


def _living_pids(pids: List[int]) -> List[int]:
    """Which of ``pids`` are still running.

    Signal 0 alone is not enough: it also succeeds for a ZOMBIE — a child that
    has already exited but has not been reaped. These processes are our own
    children, so counting a zombie as alive would burn the whole grace period
    and then SIGKILL a corpse. One ``ps`` answers for the whole set.
    """
    if not pids:
        return []
    try:
        out = subprocess.run(
            ["ps", "-o", "pid=,stat=", "-p", ",".join(str(p) for p in pids)],
            capture_output=True, text=True, timeout=2,
        ).stdout
    except Exception:
        # Fall back to the coarse check rather than reporting everything dead.
        living = []
        for pid in pids:
            try:
                os.kill(pid, 0)
                living.append(pid)
            except OSError as e:
                if getattr(e, "errno", None) == errno.EPERM:
                    living.append(pid)
        return living

    living = []
    for line in out.split("\n"):
        parts = line.split()
        if len(parts) < 2:
            continue
        try:
            pid = int(parts[0])
        except ValueError:
            continue
        if parts[1].startswith("Z"):  # exited, just not reaped yet
            continue
        living.append(pid)
    return living


def _posix_kill_tree(pid: int) -> Tuple[bool, str]:
    """SIGTERM the whole tree, verify, then SIGKILL whatever ignored it.

    The previous version sent SIGTERM and SIGKILL back to back with nothing in
    between, so the handler never got to run and a task node was always hard
    killed — leaving half-written intermediate results behind.
    """
    import signal

    # Children first so a parent cannot re-parent or respawn them while it dies.
    tree = list(reversed(_descendant_pids(pid))) + [pid]
    for target in tree:
        try:
            os.kill(target, signal.SIGTERM)
        except OSError:
            pass  # already gone

    deadline = time.time() + _KILL_GRACE_SEC
    alive = _living_pids(tree)
    while alive and time.time() < deadline:
        time.sleep(0.1)
        alive = _living_pids(alive)

    if not alive:
        return True, "terminated (SIGTERM)"

    for target in alive:
        try:
            os.kill(target, signal.SIGKILL)
        except OSError:
            pass
    time.sleep(0.2)
    survivors = _living_pids(alive)
    if survivors:
        return False, f"processes survived SIGKILL: {survivors}"
    return True, "terminated (SIGKILL after grace)"


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
            return _posix_kill_tree(int(pid))
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


def _bind_port(port: int) -> Optional[socket.socket]:
    """Bind ``port``, or None if it is taken. The socket holds the reservation."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("0.0.0.0", port))
        return s
    except OSError:
        s.close()
        return None


def _reserve_port(preferred: Optional[int] = None, start_port: int = 8001,
                  max_tries: int = 100) -> Tuple[Optional[int], Optional[socket.socket]]:
    """Claim a port and keep holding it until the node is about to bind.

    Probing with a bind that is released right away leaves the port free for
    the seconds a node needs to boot, so two concurrent starts can hand the
    same port to two nodes: one of them fails to bind, and its readiness probe
    then connects to the *other* node's listener and reports it ready.
    """
    if preferred is not None:
        sock = _bind_port(int(preferred))
        if sock is not None:
            return int(preferred), sock
        start_port = int(preferred) + 1
    for candidate in range(start_port, start_port + max_tries):
        sock = _bind_port(candidate)
        if sock is not None:
            return candidate, sock
    return None, None


def _rosetta_prefix(python_exec: str) -> List[str]:
    """``["/usr/bin/arch", "-x86_64"]`` when the env's python is an Intel build.

    An osx-64 env (some deps ship no arm64 build) needs its python and
    everything it spawns pinned to the Intel slice. macOS only: /usr/bin/arch on
    Linux is coreutils' and does not run commands at all. ``bin/python`` in a
    conda env is a symlink and ``file`` describes the link itself, so the target
    is resolved first.
    """
    if sys.platform != "darwin" or not os.path.exists("/usr/bin/arch"):
        return []
    try:
        file_out = subprocess.run(["/usr/bin/file", "-b", os.path.realpath(python_exec)],
                                  capture_output=True, text=True)
    except Exception:
        return []
    return ["/usr/bin/arch", "-x86_64"] if "x86_64" in (file_out.stdout or "").lower() else []


def get_env_name_from_model(model_name: str) -> str:
    """
    Generate a fixed environment name based on model_name
    """
    return f"{model_name}_tissuelab_ai_service_tasknode"


def _isolated_child_env() -> Dict[str, str]:
    """Parent environment, minus everything that can leak packages into a node.

    A node process must import only from its own conda env. Three inherited
    settings break that, and all bind *ahead* of the env's site-packages:

    * ``~/.local/lib/pythonX.Y/site-packages`` (user site), enabled by default
    * ``PYTHONPATH``, inherited from whatever launched this service
    * ``PYTHONHOME``, which would point the node's interpreter at another
      installation's standard library

    The failure is confusing because the node then mixes sources — FastAPI from
    the env, torch/huggingface-hub from the leak — so a version pinned in the
    env is not the version the node runs, and ``pip list`` in that env does not
    show what went wrong.

    Nothing here undoes leaks of the service's own files: the service does not
    modify its environment to locate them (see ``app.core.libvips.configure``),
    and the desktop shell passes it nothing that names the bundle, so there is
    nothing to undo. (On macOS the discovery sandbox appends Docker's install
    dirs to PATH; appended, they only resolve commands a node would not find
    otherwise.) It does write the LLM settings from Preferences into its
    environment (``app.services.llm_settings``); the API keys among them are
    dropped here, since a node has no use for them.
    """
    from app.services.llm_settings import SECRETS

    env_vars = os.environ.copy()
    env_vars["PYTHONNOUSERSITE"] = "1"
    env_vars.pop("PYTHONPATH", None)
    env_vars.pop("PYTHONHOME", None)
    for name in SECRETS:
        env_vars.pop(name, None)
    return env_vars


# --- conda discovery ---------------------------------------------------------
# The desktop build is launched from Finder/Dock/Explorer, so it inherits a bare
# PATH and none of the shell rc files that `conda init` edits. `bash -lc conda`
# does not rescue it either: on macOS `conda init` writes to ~/.zshrc, which a
# bash login shell never reads. So locate conda ourselves and invoke it directly.

_CONDA_MISSING_MESSAGE = (
    "conda was not found on this machine. Install Miniforge/Miniconda, or launch "
    "TissueLab from a terminal where `conda` is on PATH."
)
_CONDA_EXE_MEMO: List[Optional[str]] = []  # one slot; empty = not probed yet


def _is_windows() -> bool:
    return os.name == 'nt' or sys.platform.startswith('win')


def _conda_exe_candidates() -> List[str]:
    """Paths a conda executable may live at, most likely first."""
    home = os.path.expanduser("~")
    names = ("miniforge3", "mambaforge", "miniconda3", "anaconda3", "miniconda", "anaconda")
    if _is_windows():
        bases = [home, os.environ.get("LOCALAPPDATA", ""), os.environ.get("PROGRAMDATA", "")]
        suffixes = [("Scripts", "conda.exe"), ("condabin", "conda.bat")]
    else:
        bases = [home, os.path.join(home, "opt"), "/opt", "/opt/homebrew", "/usr/local"]
        suffixes = [("bin", "conda"), ("condabin", "conda")]
    roots = [os.environ.get("CONDA_ROOT", ""), os.environ.get("MAMBA_ROOT_PREFIX", "")]
    roots += [os.path.join(base, name) for base in bases if base for name in names]
    return [os.path.join(root, *suffix) for root in roots if root for suffix in suffixes]


def _conda_exe_from_login_shell() -> Optional[str]:
    """Ask the user's own login shell — the only way to find a custom install.

    ``-i`` matters: zsh reads ~/.zshrc, the file `conda init zsh` edits, only
    when interactive. That hook exports CONDA_EXE as an absolute path.
    """
    shell = os.environ.get("SHELL")
    if _is_windows() or not shell or not os.path.isfile(shell):
        return None
    try:
        proc = subprocess.run([shell, "-lic", 'printf "\nCONDA_EXE=%s\n" "$CONDA_EXE"'],
                              capture_output=True, text=True, timeout=20,
                              stdin=subprocess.DEVNULL)
    except Exception as e:
        logger.debug(f"login shell conda probe failed: {e}")
        return None
    # The rc files print their own noise first, so pick the marked line out.
    for line in (proc.stdout or "").splitlines():
        path = line.partition("CONDA_EXE=")[2].strip() if "CONDA_EXE=" in line else ""
        if path and os.path.isfile(path):
            return path
    return None


def find_conda_executable() -> Optional[str]:
    """Absolute path to a usable ``conda``, or None if there is none. Memoized."""
    if _CONDA_EXE_MEMO:
        return _CONDA_EXE_MEMO[0]

    found = os.environ.get("CONDA_EXE") or shutil.which("conda")
    if not found or not os.path.isfile(found):
        found = next((c for c in _conda_exe_candidates() if os.path.isfile(c)), None)
    if not found:
        found = _conda_exe_from_login_shell()

    if found:
        logger.info(f"Using conda executable: {found}")
    else:
        logger.warning("No conda executable found (PATH, CONDA_EXE, common install "
                       "locations and the login shell were all checked)")
    _CONDA_EXE_MEMO.append(found)
    return found


def _run_conda(args: List[str], timeout: Optional[float] = 120, **kwargs):
    """Run ``conda <args>``. Returns None when conda cannot be located."""
    exe = find_conda_executable()
    if not exe:
        return None
    kwargs.setdefault("env", _isolated_child_env())
    kwargs.setdefault("text", True)
    if "stdout" not in kwargs and "stderr" not in kwargs:
        kwargs.setdefault("capture_output", True)
    return subprocess.run([exe, *args], timeout=timeout, **kwargs)


def _conda_env_name_of(prefix: str) -> str:
    """Basename of an env prefix, tolerating either path separator."""
    return re.split(r"[\\/]+", prefix.strip())[-1]


def _conda_env_prefixes() -> List[str]:
    """Absolute paths of every conda env, or [] if conda cannot be reached."""
    proc = _run_conda(["env", "list", "--json"], timeout=60)
    if proc is None or proc.returncode != 0 or not proc.stdout:
        return []
    try:
        return json.loads(proc.stdout).get("envs", []) or []
    except Exception as e:
        logger.error(f"conda env listing returned unparsable JSON: {e}")
        return []


def _conda_env_path(env_name: str) -> Optional[str]:
    """Return absolute path of a conda env by name, or None if not found."""
    return next((p for p in _conda_env_prefixes() if _conda_env_name_of(p) == env_name), None)


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
    python_version: Python version used to create the Conda environment (e.g., "3.11")
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

    # Held from the moment it is picked until the node itself binds it.
    port_holder: Optional[socket.socket] = None

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
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
        # Create env if missing, regardless of whether the name was user-specified or auto-derived
        env_path = _conda_env_path(env_name)
        if not env_path:
            if log_file_handle:
                try:
                    log_file_handle.write(f"$ conda create -n {env_name} python={python_version} -y\n")
                    log_file_handle.write(f"[Custom Node Service] Creating new conda environment: {env_name}\n")
                    log_file_handle.flush()
                except Exception:
                    pass
            try:
                proc = _run_conda(
                    ["create", "-n", env_name, f"python={python_version}", "-y"],
                    timeout=None,
                    check=True,
                    stdout=log_file_handle,
                    stderr=log_file_handle,
                )
                if proc is None:
                    return {"status": "fail", "message": _CONDA_MISSING_MESSAGE, "log_path": log_path}
            except subprocess.CalledProcessError as e:
                return {"status": "fail", "message": f"Failed to create environment: {e}", "log_path": log_path}
            env_path = _conda_env_path(env_name)
        else:
            if log_file_handle:
                try:
                    log_file_handle.write(f"[Custom Node Service] Using existing environment: {env_name}\n")
                    log_file_handle.flush()
                except Exception:
                    pass

        # Resolve env python early for consistent architecture and use it for pip installs
        if not env_path:
            return {"status": "fail", "message": f"Could not resolve path for conda env '{env_name}'", "log_path": log_path}
        python_exec = os.path.join(env_path, "python.exe") if is_windows else os.path.join(env_path, "bin", "python")
        if not os.path.exists(python_exec):
            alt = os.path.join(env_path, "CodingAgent", "python.exe") if is_windows else python_exec
            if not os.path.exists(alt):
                return {"status": "fail", "message": f"Python executable not found in env '{env_name}'", "log_path": log_path}
            python_exec = alt
        arch_prefix = _rosetta_prefix(python_exec)

    # 2. Optionally install dependencies
    if (not is_executable_mode) and install_dependencies:
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
        env_vars = _isolated_child_env()
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

    # 3. pick a port (explicit or free) and hold it until the node takes over
    if port is not None:
        chosen, port_holder = _reserve_port(preferred=port)
        if chosen is None:
            return {"status": "fail", "message": f"Requested port {port} is not available and no free port was found", "log_path": log_path}
        port = chosen
    else:
        port, port_holder = _reserve_port()
        if port is None:
            return {"status": "fail", "message": "No available port", "log_path": log_path}

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
    # Prefer the service file's directory as working dir; fallback to dependency folder or current dir
    working_dir = os.path.dirname(service_path) or (os.path.dirname(dependency_path) if dependency_path else ".")
    # Reuse existing log file handle if available; else open a new one
    if log_file_handle is None:
        log_file_handle = open(log_path, "a")
    env_vars = _isolated_child_env()
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
    port_holder.close()  # release it the instant before the node binds
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
                # A dead process cannot be the one listening: something else
                # holds this port, so the node is not up.
                return p.poll() is None
            except Exception:
                pass
            time.sleep(0.3)
        return False

    ready = _wait_for_listen(proc, port, timeout=120.0)
    if not ready:
        # If process died, attempt a one-time restart on a new port; otherwise, report failure
        try:
            if proc.poll() is not None:
                alt_port, port_holder = _reserve_port(start_port=int(port) + 1)
                if alt_port is None:
                    alt_port, port_holder = _reserve_port()
                if alt_port is None:
                    return {"status": "fail", "message": f"Failed to start service; no fallback port available", "log_path": log_path}
                port = alt_port
                cmd = _build_cmd(service_path, port)
                port_holder.close()
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

        # Kill the whole tree, not just the node process: a node that spawned
        # workers would otherwise leave them holding `existing_port`, so the
        # replacement silently starts on a different port — and they outlive
        # app quit too, since cleanup only walks the registry we just cleared.
        proc = CUSTOM_NODE_SERVICE_REGISTRY[composite_key].get("process")
        _kill_process_tree(getattr(proc, "pid", None))
        del CUSTOM_NODE_SERVICE_REGISTRY[composite_key]
        _clear_health_check_cache(composite_key)

    # Handle remote vs local deployment
    if is_remote:
        if not remote_host:
            return {"status": "fail", "message": "remote_host is required for remote node registration"}
        # For remote nodes, port must be explicitly provided and cannot be modified
        if port is None:
            return {"status": "fail", "message": "Port is required for remote node registration"}
        port_to_use = port  # Use the provided port exactly, do not modify
        # Remote node: perform health check (only once, no retries)

        # Try health check only once
        timeout = 5.0
        is_healthy, health_message = check_remote_node_health(remote_host, port_to_use, timeout=timeout)

        if not is_healthy:
            # check_remote_node_health already returns messages in the format "Failed to connect to host:port"
            # or other error messages, so we can use it directly
            return {"status": "fail", "message": health_message}

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
        # Local nodes: the requested port, else the one this node had, else none —
        # create_custom_node_env reserves a free one when it is given none. Only a
        # remote node's port has to be told to us, since we do not start it.
        port_to_use = port if port is not None else existing_port
        
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
    # Create a snapshot of items to avoid "dictionary changed size during iteration" error
    # This can happen if a node is registered while we're iterating
    registry_snapshot = list(CUSTOM_NODE_SERVICE_REGISTRY.items())

    for key, info in registry_snapshot:
        # Skip if node was removed from registry during iteration (e.g., during disconnect)
        # This avoids health checks on nodes that are being disconnected
        if key not in CUSTOM_NODE_SERVICE_REGISTRY:
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

            # --- Node is marked as ready + running: normal periodic health check ---
            elif port and info.get("ready", False) and current_running_status:
                if key not in CUSTOM_NODE_SERVICE_REGISTRY:
                    continue
                
                current_time = time.time()
                cache_entry = _HEALTH_CHECK_CACHE.get(key)
                use_cache = False
                
                if cache_entry:
                    time_since_check = current_time - cache_entry.get("last_check", 0)
                    if time_since_check < _HEALTH_CHECK_CACHE_TTL:
                        running = cache_entry.get("cached_running", False)
                        use_cache = True

                if not use_cache:
                    try:
                        is_healthy, health_msg = check_remote_node_health(remote_host, port, timeout=_HEALTH_CHECK_TIMEOUT_NORMAL)
                        if key not in CUSTOM_NODE_SERVICE_REGISTRY:
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
    """Names of the conda environments on this machine; [] if conda is absent."""
    envs = list(dict.fromkeys(_conda_env_name_of(p) for p in _conda_env_prefixes()))
    if not envs:
        logger.warning("No conda environments found")
    return {"status": "success", "envs": envs}


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
    try:
        removed = _run_conda(["env", "remove", "-n", env_name, "-y"], timeout=None, check=True)
        if removed is None:
            return {"status": "fail", "message": _CONDA_MISSING_MESSAGE}
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
        return {"status": "success", "message": f"Node '{model_name}' was already disconnected or not found in registry"}

    registry_entry = CUSTOM_NODE_SERVICE_REGISTRY[key_to_stop]
    is_remote = registry_entry.get("is_remote")
    remote_host = registry_entry.get("remote_host")

    # Handle remote nodes - they don't have local processes to stop
    if is_remote is True:
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
            return {"status": "success", "message": f"Remote node {model_name} has been disconnected"}
        except KeyError:
            logger.warning(f"[stop_custom_node_process] Key '{key_to_stop}' not found in registry")
            return {"status": "success", "message": f"Remote node '{key_to_stop}' was already disconnected"}
        except Exception as e:
            logger.error(f"[stop_custom_node_process] Error removing remote node '{key_to_stop}': {e}", exc_info=e)
            return {"status": "fail", "message": f"Error disconnecting remote node: {str(e)}"}

    # Local node stopping
    proc = registry_entry.get("process")

    # Only try to kill process if it exists
    if proc is None:
        # Remove from registry if no process
        try:
            CUSTOM_NODE_SERVICE_REGISTRY[key_to_stop]["running"] = False
        except Exception:
            pass
        stopped_env = registry_entry.get("env_name", env_or_key)
        return {"status": "success", "message": f"Node {stopped_env} was not running, removed from registry"}
    
    pid = getattr(proc, 'pid', None)
    if pid is None:
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
    return {"status": "success", "message": f"Process for {stopped_env} has been stopped"}
