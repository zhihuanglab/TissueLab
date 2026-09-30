"""
Docker sandbox for model-written code (proposer exploration, worker scripts,
the controller's donor-table materialization).

Each session is one container with:
- the data folder read-only at /data, with the run-output folder masked so a
  run never sees earlier runs' results, plus optional read-only single-file
  overlays (the outcome-free cohort file)
- a writable /scratch (the session's own folder) and a shared /shared
- no network, a read-only root filesystem, and memory / CPU / pid / tmpfs caps
  (TL_SANDBOX_* environment variables)
- a warm Python runtime: `python` inside the container forwards to a server
  that forks one child per request, so a stuck request can be killed without
  losing the warm imports

The container still runs as root internally; /scratch is a host bind mount
owned by the service user, and the read-only rootfs plus the dropped network
are what contain the process.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Optional

import psutil


_DOCKER_IMAGE_LOCK = threading.Lock()

# Caps on the two docker calls made while _DOCKER_IMAGE_LOCK is held. An inspect
# is instant when the daemon is healthy; a first build pulls a base image.
DOCKER_INSPECT_TIMEOUT = 30
DOCKER_BUILD_TIMEOUT = 1800
DOCKER_RUN_TIMEOUT = 120
DOCKER_CLI_TIMEOUT = 15

# Resource caps for the container. The code inside is model-generated and
# unreviewed, so an unbounded container could take the host down with it.
SANDBOX_MEMORY = os.environ.get("TL_SANDBOX_MEMORY", "8g")
SANDBOX_CPUS = os.environ.get("TL_SANDBOX_CPUS", "4")
SANDBOX_PIDS_LIMIT = os.environ.get("TL_SANDBOX_PIDS_LIMIT", "512")
SANDBOX_TMPFS_SIZE = os.environ.get("TL_SANDBOX_TMPFS_SIZE", "512m")

OWNER_LABEL = "tissuelab.discovery.pid"
SHARED_READ_ONLY = ("lib", "dataset.json", "dataset_guide.md")
# Runs live under <data folder>/autoresearch_runs; the sandbox masks it.
RUNS_DIRNAME = "autoresearch_runs"
SANDBOX_PYTHON = "/usr/local/bin/python3"

RUNTIME_DIRNAME = ".tl_runtime"
RUNTIME_SOCKET_NAME = "runtime.sock"
DOCKER_RUNTIME_SOCKET_PATH = "/tmp/tl_runtime.sock"
RUNTIME_SERVER_SCRIPT = "runtime_server.py"
RUNTIME_CLIENT_SCRIPT = "runtime_client.py"
# zarr 3 reads the stores TissueLab writes; the rest is the analysis stack
# worker scripts reach for.
DOCKERFILE_TEMPLATE = """\
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
        build-essential libopenslide0 && \\
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \\
    numpy pandas scipy scikit-learn matplotlib seaborn \\
    "zarr>=3,<4" pillow openslide-python tifffile h5py openpyxl \\
    rich statsmodels shapely scikit-image networkx \\
    numba pyarrow tqdm

WORKDIR /scratch
"""
# The tag follows the Dockerfile, so changing it builds a fresh image instead
# of silently reusing a stale one.
DEFAULT_IMAGE = (
    "tissuelab-discovery-worker:"
    + hashlib.sha256(DOCKERFILE_TEMPLATE.encode("utf-8")).hexdigest()[:12]
)

RUNTIME_SERVER_CODE = r"""#!/usr/bin/env python3
import contextlib
import importlib
import io
import json
import os
import runpy
import signal
import socket
import sys
import traceback
from pathlib import Path

SOCKET_PATH = os.environ.get("TL_RUNTIME_SOCKET", "/scratch/.tl_runtime/runtime.sock")
ROOT = Path(os.environ.get("TL_RUNTIME_ROOT", "/scratch/.tl_runtime"))


def _execute(req):
    mode = req.get("mode")
    cwd = req.get("cwd") or "/scratch"
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    exit_code = 0
    old_cwd = os.getcwd()
    old_argv = list(sys.argv)
    old_path = list(sys.path)
    # Honor the caller's PYTHONPATH (forwarded by the client) and always expose the shared
    # helper library, so `PYTHONPATH=/shared/lib python x.py` behaves like a plain interpreter.
    extra_paths = [p for p in str(req.get("pythonpath") or "").split(":") if p]
    shared_lib = os.path.join(os.environ.get("TL_SHARED_ROOT", "/shared"), "lib")
    if os.path.isdir(shared_lib) and shared_lib not in extra_paths:
        extra_paths.append(shared_lib)
    for p in reversed(extra_paths):
        if p not in sys.path:
            sys.path.insert(0, p)
    try:
        os.chdir(cwd)
        with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
            if mode == "run_path":
                path = req["path"]
                args = list(req.get("args") or [])
                sys.argv = [path, *args]
                try:
                    runpy.run_path(path, run_name="__main__")
                except SystemExit as exc:
                    code = exc.code
                    if code is None:
                        exit_code = 0
                    elif isinstance(code, int):
                        exit_code = code
                    else:
                        exit_code = 1
                        print(code, file=sys.stderr)
            elif mode == "exec":
                code = req["code"]
                args = list(req.get("args") or [])
                sys.argv = ["-c", *args]
                try:
                    exec(compile(code, "<tl_runtime>", "exec"), {"__name__": "__main__"})
                except SystemExit as exc:
                    code = exc.code
                    if code is None:
                        exit_code = 0
                    elif isinstance(code, int):
                        exit_code = code
                    else:
                        exit_code = 1
                        print(code, file=sys.stderr)
            else:
                exit_code = 2
                print(f"Unsupported runtime mode: {mode}", file=sys.stderr)
    except Exception:
        exit_code = 1
        stderr_buf.write(traceback.format_exc())
    finally:
        sys.argv = old_argv
        sys.path[:] = old_path
        os.chdir(old_cwd)
    return {
        "exit_code": int(exit_code),
        "stdout": stdout_buf.getvalue(),
        "stderr": stderr_buf.getvalue(),
    }


def _preload():
    # Warm the import cache in the parent so forked request children start fast.
    shared_lib = os.path.join(os.environ.get("TL_SHARED_ROOT", "/shared"), "lib")
    if os.path.isdir(shared_lib) and shared_lib not in sys.path:
        sys.path.insert(0, shared_lib)
    for name in ("numpy", "pandas", "scipy.spatial", "zarr", "shared_analysis.slides"):
        try:
            importlib.import_module(name)
        except Exception:
            pass


def _handle(conn):
    with conn:
        reader = conn.makefile("r", encoding="utf-8")
        writer = conn.makefile("w", encoding="utf-8")
        line = reader.readline()
        if not line:
            return
        try:
            req = json.loads(line)
        except Exception:
            writer.write(json.dumps({"exit_code": 2, "stdout": "", "stderr": "Invalid runtime request"}) + "\n")
            writer.flush()
            return
        resp = _execute(req)
        writer.write(json.dumps(resp) + "\n")
        writer.flush()


def main():
    sock_path = Path(SOCKET_PATH)
    sock_path.parent.mkdir(parents=True, exist_ok=True)
    if sock_path.exists():
        sock_path.unlink()
    (sock_path.parent / "server.pid").write_text(str(os.getpid()), encoding="utf-8")
    _preload()
    # Each request runs in a forked child: a stuck or killed request cannot wedge the
    # server, and the host can kill request children on timeout (see _kill_inflight_docker).
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(sock_path))
    server.listen(8)
    try:
        while True:
            conn, _ = server.accept()
            pid = os.fork()
            if pid == 0:
                code = 0
                try:
                    server.close()
                    _handle(conn)
                except Exception:
                    code = 1
                finally:
                    os._exit(code)
            conn.close()
    finally:
        server.close()
        try:
            sock_path.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
"""

RUNTIME_CLIENT_CODE = r"""#!/usr/bin/env python3
import json
import os
import socket
import subprocess
import sys
from pathlib import Path


def _fallback(argv):
    real_python = os.environ.get("TL_REAL_PYTHON")
    if not real_python:
        real_python = sys.executable
    proc = subprocess.run([real_python, *argv], capture_output=True, text=True)
    if proc.stdout:
        sys.stdout.write(proc.stdout)
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    raise SystemExit(proc.returncode)


def _send_request(req):
    socket_path = os.environ.get("TL_RUNTIME_SOCKET")
    if not socket_path or not os.path.exists(socket_path):
        _fallback(sys.argv[1:])
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(socket_path)
    with sock:
        writer = sock.makefile("w", encoding="utf-8")
        reader = sock.makefile("r", encoding="utf-8")
        writer.write(json.dumps(req) + "\n")
        writer.flush()
        line = reader.readline()
    if not line:
        return {"exit_code": 1, "stdout": "", "stderr": "Runtime produced no response"}
    return json.loads(line)


def _print_and_exit(resp):
    stdout = resp.get("stdout") or ""
    stderr = resp.get("stderr") or ""
    if stdout:
        sys.stdout.write(stdout)
    if stderr:
        sys.stderr.write(stderr)
    raise SystemExit(int(resp.get("exit_code", 1)))


def main():
    if os.environ.get("TL_DISABLE_PERSISTENT_PYTHON") == "1":
        _fallback(sys.argv[1:])

    args = list(sys.argv[1:])
    ignored = []
    while args and args[0] in {"-u", "-B"}:
        ignored.append(args.pop(0))

    if not args:
        _fallback(sys.argv[1:])

    cwd = os.getcwd()
    head = args[0]
    req = None

    pythonpath = os.environ.get("PYTHONPATH", "")
    if head == "-c" and len(args) >= 2:
        req = {"mode": "exec", "code": args[1], "args": args[2:], "cwd": cwd, "pythonpath": pythonpath}
    elif head == "-":
        req = {"mode": "exec", "code": sys.stdin.read(), "args": args[1:], "cwd": cwd, "pythonpath": pythonpath}
    elif not head.startswith("-"):
        script_path = Path(head)
        if script_path.exists():
            req = {"mode": "run_path", "path": str(script_path.resolve()), "args": args[1:], "cwd": cwd, "pythonpath": pythonpath}

    if req is None:
        _fallback(sys.argv[1:])

    resp = _send_request(req)
    _print_and_exit(resp)


if __name__ == "__main__":
    main()
"""

RUNTIME_WRAPPER_TEMPLATE = """#!/bin/sh
exec "{real_python}" "{client_path}" "$@"
"""


def _symlinks_under(data_dir: Path) -> list[Path]:
    """Every symlink below data_dir, skipping the (masked) run-output folder."""
    found: list[Path] = []
    for root, dirs, files in os.walk(data_dir):
        root_path = Path(root)
        if root_path == data_dir and RUNS_DIRNAME in dirs:
            dirs.remove(RUNS_DIRNAME)
        for name in [*dirs, *files]:
            entry = root_path / name
            if entry.is_symlink():
                found.append(entry)
    return sorted(found, key=lambda p: p.relative_to(data_dir).as_posix())


class SandboxSession:
    """One Docker container for one proposer, worker or controller step."""

    def __init__(
        self,
        scratch_dir: str | Path,
        *,
        data_dir: str | Path,
        shared_dir: Optional[str | Path] = None,
        command_timeout_sec: int = 300,
        file_overlays: Optional[dict[str, str | Path]] = None,
    ) -> None:
        self.scratch_dir = Path(scratch_dir).resolve()
        self.scratch_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir = Path(data_dir).resolve()
        self.shared_dir = Path(shared_dir).resolve() if shared_dir else None
        if self.shared_dir:
            self.shared_dir.mkdir(parents=True, exist_ok=True)
        # container path -> host file, bind-mounted read-only over /data (the
        # outcome-free cohort file shadowing the real one).
        self.file_overlays = {str(k): str(Path(v).resolve()) for k, v in (file_overlays or {}).items()}
        self.image = DEFAULT_IMAGE
        self.command_timeout_sec = int(command_timeout_sec)
        self.container_name: Optional[str] = None
        self.started = False

    def start(self) -> None:
        if self.started:
            return
        self._install_runtime_files()
        self._start_docker()
        try:
            self._start_docker_runtime()
        except Exception:
            self.stop()   # never leave a half-started `sleep infinity` container behind
            raise

    def stop(self) -> None:
        if not self.started:
            return
        if self.container_name:
            _remove_containers([self.container_name])
            self.container_name = None
        self.started = False

    def watch_cancel(self, cancel_event: Optional[threading.Event]) -> Callable[[], None]:
        """Kill the container once cancel_event is set; returns a function that ends the watch."""
        if cancel_event is None:
            return lambda: None
        done = threading.Event()

        def _watch() -> None:
            while not done.is_set():
                if cancel_event.wait(0.5):
                    if not done.is_set():
                        self.kill()
                    return

        threading.Thread(target=_watch, name="discovery-cancel-watch", daemon=True).start()
        return done.set

    def kill(self) -> None:
        """Remove the container now, from any thread.

        Used on cancel: a command running inside the container returns as
        soon as the container is gone, so the calling thread stops waiting on
        it. stop() still runs afterwards from the owning thread.
        """
        if self.container_name:
            _remove_containers([self.container_name])

    def exec(self, command: str, timeout_sec: Optional[int] = None) -> dict:
        if not self.started:
            raise RuntimeError("Sandbox session has not been started")
        timeout = int(timeout_sec or self.command_timeout_sec)
        assert self.container_name is not None
        try:
            proc = subprocess.run(
                ["docker", "exec", "-i", "-w", "/",
                 self.container_name, "/bin/sh", "-lc", self._wrap_command(command)],
                capture_output=True, text=True,
                timeout=timeout, check=False,
            )
            return {
                "exit_code": proc.returncode,
                "stdout": proc.stdout[-20_000:],
                "stderr": proc.stderr[-20_000:],
            }
        except subprocess.TimeoutExpired:
            self._kill_inflight()
            return {
                "exit_code": -1,
                "stdout": "",
                "stderr": f"Command timed out after {timeout}s (process killed)",
            }

    # -- warm Python runtime ----------------------------------------------------

    def _runtime_root(self) -> Path:
        return self.scratch_dir / RUNTIME_DIRNAME

    def _runtime_exec_root(self) -> str:
        return f"/scratch/{RUNTIME_DIRNAME}"

    def _install_runtime_files(self) -> None:
        runtime_root = self._runtime_root()
        bin_dir = runtime_root / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        server_path = runtime_root / RUNTIME_SERVER_SCRIPT
        client_path = runtime_root / RUNTIME_CLIENT_SCRIPT
        server_path.write_text(RUNTIME_SERVER_CODE, encoding="utf-8")
        client_path.write_text(RUNTIME_CLIENT_CODE, encoding="utf-8")
        os.chmod(server_path, 0o755)
        os.chmod(client_path, 0o755)
        for name in ("python", "python3", "tlpy"):
            wrapper_path = bin_dir / name
            wrapper_path.write_text(
                RUNTIME_WRAPPER_TEMPLATE.format(
                    real_python=SANDBOX_PYTHON,
                    client_path=f"{self._runtime_exec_root()}/{RUNTIME_CLIENT_SCRIPT}",
                ),
                encoding="utf-8",
            )
            os.chmod(wrapper_path, 0o755)

    def _runtime_env(self) -> dict[str, str]:
        return {
            "TL_RUNTIME_ROOT": self._runtime_exec_root(),
            "TL_RUNTIME_SOCKET": DOCKER_RUNTIME_SOCKET_PATH,
            "TL_REAL_PYTHON": SANDBOX_PYTHON,
            **({"TL_SHARED_ROOT": "/shared"} if self.shared_dir else {}),
        }

    def _start_docker_runtime(self) -> None:
        assert self.container_name is not None
        cmd = ["docker", "exec", "-d", "-w", "/"]
        for key, value in self._runtime_env().items():
            cmd.extend(["-e", f"{key}={value}"])
        cmd.extend([
            self.container_name, "/bin/sh", "-lc",
            (
                f"cd /scratch && exec {SANDBOX_PYTHON} {self._runtime_exec_root()}/{RUNTIME_SERVER_SCRIPT} "
                f">{self._runtime_exec_root()}/server.log 2>&1"
            ),
        ])
        subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=DOCKER_CLI_TIMEOUT)
        self._wait_for_runtime_socket()

    def _wait_for_runtime_socket(self, timeout_sec: float = 5.0) -> bool:
        """True once the warm runtime listens; without it `python` falls back to a cold interpreter."""
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            probe = subprocess.run(
                ["docker", "exec", self.container_name, "/bin/sh", "-lc",
                 f'[ -S "{DOCKER_RUNTIME_SOCKET_PATH}" ]'],
                capture_output=True, text=True, check=False, timeout=DOCKER_CLI_TIMEOUT,
            )
            if probe.returncode == 0:
                return True
            time.sleep(0.1)
        return False

    def _kill_inflight(self) -> None:
        """After a timeout, kill the timed-out command's process tree and any runtime
        request child still running, so later commands (and the controller's
        materialization) do not queue behind a zombie computation."""
        code = (
            "import os,signal\n"
            f"root={self._runtime_exec_root()!r}\n"
            "def kids(pp):\n"
            "    out=[]\n"
            "    for d in os.listdir('/proc'):\n"
            "        if not d.isdigit(): continue\n"
            "        try: st=open(f'/proc/{d}/stat').read()\n"
            "        except OSError: continue\n"
            "        if int(st.rsplit(')',1)[1].split()[1])==pp: out.append(int(d))\n"
            "    return out\n"
            "def killtree(p, include_self):\n"
            "    for c in kids(p): killtree(c, True)\n"
            "    if include_self:\n"
            "        try: os.kill(p, signal.SIGKILL)\n"
            "        except OSError: pass\n"
            "def readpid(name):\n"
            "    try: return int(open(os.path.join(root,name)).read().strip())\n"
            "    except Exception: return None\n"
            "p=readpid('current_cmd.pid')\n"
            "if p and p!=os.getpid(): killtree(p, True)\n"
            "s=readpid('server.pid')\n"
            "if s: killtree(s, False)\n"
        )
        try:
            subprocess.run(
                ["docker", "exec", self.container_name, SANDBOX_PYTHON, "-c", code],
                capture_output=True, text=True, check=False, timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass

    def _wrap_command(self, command: str) -> str:
        prelude_lines = [
            "cd /scratch || exit 97",
            'export TL_DATA_ROOT="/data"',
            f'export TL_RUNTIME_ROOT="{self._runtime_exec_root()}"',
            f'export TL_RUNTIME_SOCKET="{DOCKER_RUNTIME_SOCKET_PATH}"',
            f'export TL_REAL_PYTHON="{SANDBOX_PYTHON}"',
            f'export PATH="{self._runtime_exec_root()}/bin:$PATH"',
            f'echo $$ > "{self._runtime_exec_root()}/current_cmd.pid" 2>/dev/null || true',
        ]
        if self.shared_dir:
            prelude_lines.extend([
                'export PYTHONPATH="/shared/lib${PYTHONPATH:+:$PYTHONPATH}"',
                'export TL_SHARED_ROOT="/shared"',
            ])
        return "\n".join(prelude_lines) + "\n" + command

    # -- container ---------------------------------------------------------------

    def _data_mounts(self) -> list[str]:
        mounts = ["-v", f"{self.data_dir}:/data:ro"]
        # Symlink targets outside the mounted folder are otherwise invisible:
        # overlay each resolved link at its original relative path.
        try:
            entries = _symlinks_under(self.data_dir)
        except OSError:
            entries = []
        for entry in entries:
            try:
                target = entry.resolve(strict=True)
                relative = entry.relative_to(self.data_dir)
            except (OSError, ValueError):
                continue
            container_path = (Path("/data") / relative).as_posix()
            if container_path in self.file_overlays:
                continue   # shadowed by an overlay (e.g. a symlinked cohort file)
            mounts.extend(["-v", f"{target}:{container_path}:ro"])
        # Earlier runs' outputs (results, panels, reports) sit inside the data
        # folder; an empty tmpfs over it keeps them out of this run's view.
        if (self.data_dir / RUNS_DIRNAME).is_dir():
            mounts.extend(["--tmpfs", f"/data/{RUNS_DIRNAME}:ro,size=64k"])
        return mounts

    def _start_docker(self) -> None:
        self._ensure_docker_image()
        digest = hashlib.sha1(str(self.scratch_dir).encode()).hexdigest()[:12]
        self.container_name = f"tl-discovery-{digest}-{int(time.time())}"
        cmd = [
            "docker", "run", "-d", "--rm",
            "--name", self.container_name,
            # Owner pid: lets service shutdown and the next startup find
            # containers this process left behind (see remove_owned_containers).
            "--label", f"{OWNER_LABEL}={os.getpid()}",
            "--network", "none",
            "--read-only",
            "--memory", SANDBOX_MEMORY,
            "--memory-swap", SANDBOX_MEMORY,   # no swap on top of the cap
            "--cpus", SANDBOX_CPUS,
            "--pids-limit", SANDBOX_PIDS_LIMIT,
            "--tmpfs", f"/tmp:rw,nosuid,size={SANDBOX_TMPFS_SIZE}",
            "-w", "/",
            "-e", "HOME=/scratch",
            "-e", "MPLCONFIGDIR=/scratch/.matplotlib",
            "-v", f"{self.scratch_dir}:/scratch:rw",
        ]
        cmd.extend(self._data_mounts())
        for container_path, host_path in sorted(self.file_overlays.items()):
            cmd.extend(["-v", f"{host_path}:{container_path}:ro"])
        if self.shared_dir:
            cmd.extend(["-v", f"{self.shared_dir}:/shared:rw"])
            # What the controller trusts stays read-only: the loaders, the cohort
            # layout and the dataset guide. The rest of /shared is writable.
            for name in SHARED_READ_ONLY:
                if (self.shared_dir / name).exists():
                    cmd.extend(["-v", f"{self.shared_dir / name}:/shared/{name}:ro"])
        cmd.extend([self.image, "sleep", "infinity"])
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, check=False, timeout=DOCKER_RUN_TIMEOUT,
            )
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(f"Docker did not start the sandbox within {DOCKER_RUN_TIMEOUT}s") from e
        if proc.returncode != 0:
            raise RuntimeError(
                f"Failed to start Docker sandbox: {proc.stderr.strip() or proc.stdout.strip()}"
            )
        self.started = True

    def _ensure_docker_image(self) -> None:
        # Both calls below carry a timeout because this lock is module-wide: a
        # Docker daemon that stops answering would otherwise hold it forever and
        # every later sandbox run would block on it, permanently.
        with _DOCKER_IMAGE_LOCK:
            try:
                check = subprocess.run(
                    ["docker", "image", "inspect", self.image],
                    capture_output=True, text=True, check=False,
                    timeout=DOCKER_INSPECT_TIMEOUT,
                )
            except subprocess.TimeoutExpired as e:
                raise RuntimeError(f"Docker did not answer within {DOCKER_INSPECT_TIMEOUT}s") from e
            if check.returncode == 0:
                return
            print(f"[discovery] Building Docker image '{self.image}'...")
            try:
                proc = subprocess.run(
                    ["docker", "build", "-t", self.image, "-f", "-", "."],
                    input=DOCKERFILE_TEMPLATE,
                    capture_output=True, text=True, check=False,
                    cwd=str(self.scratch_dir),   # the Dockerfile copies nothing: keep the context tiny
                    timeout=DOCKER_BUILD_TIMEOUT,
                )
            except subprocess.TimeoutExpired as e:
                raise RuntimeError(f"Docker build exceeded {DOCKER_BUILD_TIMEOUT}s") from e
            if proc.returncode != 0:
                raise RuntimeError(f"Docker build failed: {proc.stderr.strip() or proc.stdout.strip()}")
            print(f"[discovery] Docker image '{self.image}' built successfully")


def _remove_containers(names: list[str]) -> None:
    if not names:
        return
    try:
        subprocess.run(
            ["docker", "rm", "-f", *names],
            capture_output=True, text=True, check=False, timeout=DOCKER_CLI_TIMEOUT,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


def docker_unavailable_reason() -> Optional[str]:
    """Why discovery sandboxes cannot run right now, or None when Docker is usable."""
    if not shutil.which("docker"):
        return "Discovery needs Docker to sandbox model-written code, but the docker CLI was not found."
    try:
        proc = subprocess.run(
            ["docker", "info", "--format", "{{.ServerVersion}}"],
            capture_output=True, text=True, check=False, timeout=DOCKER_CLI_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return f"Docker did not answer within {DOCKER_CLI_TIMEOUT}s; is the Docker daemon running?"
    except OSError as e:
        return f"Could not run docker: {e}"
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip().splitlines()
        return "Docker is not running" + (f": {detail[-1]}" if detail else ".")
    return None


def remove_owned_containers(*, current_process: bool) -> int:
    """Remove discovery sandboxes by owner.

    current_process=True removes this process's containers (service shutdown);
    False removes those whose owning process is gone (startup sweep after a
    crash or a force-kill). Containers of another live service are left alone.
    """
    if not shutil.which("docker"):
        return 0
    try:
        proc = subprocess.run(
            ["docker", "ps", "-a", "--filter", f"label={OWNER_LABEL}",
             "--format", f'{{{{.Names}}}}\t{{{{.Label "{OWNER_LABEL}"}}}}'],
            capture_output=True, text=True, check=False, timeout=DOCKER_CLI_TIMEOUT,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 0
    if proc.returncode != 0:
        return 0
    own_pid = os.getpid()
    doomed: list[str] = []
    for line in proc.stdout.splitlines():
        name, _, pid_text = line.partition("\t")
        try:
            pid = int(pid_text.strip())
        except ValueError:
            continue
        if current_process:
            if pid == own_pid:
                doomed.append(name.strip())
        elif pid != own_pid and not psutil.pid_exists(pid):
            doomed.append(name.strip())
    _remove_containers(doomed)
    return len(doomed)
