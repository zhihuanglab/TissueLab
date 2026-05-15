"""
Sandboxed execution environment for autoresearch workers.

Each worker runs inside a Docker container with:
- The user's data folder mounted read-only at /data
- A writable /scratch directory for output
- No network access
- Resource limits
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional


_DOCKER_IMAGE_LOCK = threading.Lock()

DEFAULT_IMAGE = "tissuelab-autoresearch-worker"
RUNTIME_DIRNAME = ".tl_runtime"
RUNTIME_SOCKET_NAME = "runtime.sock"
DOCKER_RUNTIME_SOCKET_PATH = "/tmp/tl_runtime.sock"
RUNTIME_SERVER_SCRIPT = "runtime_server.py"
RUNTIME_CLIENT_SCRIPT = "runtime_client.py"
DOCKERFILE_TEMPLATE = """\
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
        build-essential libopenslide0 && \\
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \\
    numpy pandas scipy scikit-learn matplotlib seaborn \\
    "zarr<3" pillow openslide-python tifffile h5py openpyxl \\
    rich statsmodels shapely scikit-image networkx

WORKDIR /scratch
"""

RUNTIME_SERVER_CODE = r"""#!/usr/bin/env python3
import contextlib
import io
import json
import os
import runpy
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
        os.chdir(old_cwd)
    return {
        "exit_code": int(exit_code),
        "stdout": stdout_buf.getvalue(),
        "stderr": stderr_buf.getvalue(),
    }


def main():
    sock_path = Path(SOCKET_PATH)
    sock_path.parent.mkdir(parents=True, exist_ok=True)
    if sock_path.exists():
        sock_path.unlink()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(sock_path))
    server.listen(8)
    try:
        while True:
            conn, _ = server.accept()
            with conn:
                reader = conn.makefile("r", encoding="utf-8")
                writer = conn.makefile("w", encoding="utf-8")
                line = reader.readline()
                if not line:
                    continue
                try:
                    req = json.loads(line)
                except Exception:
                    writer.write(json.dumps({"exit_code": 2, "stdout": "", "stderr": "Invalid runtime request"}) + "\n")
                    writer.flush()
                    continue
                resp = _execute(req)
                writer.write(json.dumps(resp) + "\n")
                writer.flush()
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

    if head == "-c" and len(args) >= 2:
        req = {"mode": "exec", "code": args[1], "args": args[2:], "cwd": cwd}
    elif head == "-":
        req = {"mode": "exec", "code": sys.stdin.read(), "args": args[1:], "cwd": cwd}
    elif not head.startswith("-"):
        script_path = Path(head)
        if script_path.exists():
            req = {"mode": "run_path", "path": str(script_path.resolve()), "args": args[1:], "cwd": cwd}

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


class SandboxSession:
    """Manages a Docker container for a single worker's sandboxed execution."""

    def __init__(
        self,
        scratch_dir: str | Path,
        *,
        data_dir: str | Path,
        shared_dir: Optional[str | Path] = None,
        backend: str = "docker",
        image: str = DEFAULT_IMAGE,
        auto_build: bool = True,
        command_timeout_sec: int = 300,
    ) -> None:
        self.scratch_dir = Path(scratch_dir).resolve()
        self.scratch_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir = Path(data_dir).resolve()
        self.shared_dir = Path(shared_dir).resolve() if shared_dir else None
        if self.shared_dir:
            self.shared_dir.mkdir(parents=True, exist_ok=True)
        self.backend = backend
        self.image = image
        self.auto_build = bool(auto_build)
        self.command_timeout_sec = int(command_timeout_sec)
        self.container_name: Optional[str] = None
        self.runtime_process: Optional[subprocess.Popen] = None
        self.started = False
        self.persistent_python_ready = False
        self.real_python_path = sys.executable

    def _docker_data_mounts(self) -> list[str]:
        mounts = ["-v", f"{self.data_dir}:/data:ro"]
        # If /data contains symlinks to files or directories outside the mounted
        # root, those targets are invisible inside the container. Overlay the
        # resolved targets onto the same /data/<name> paths so worker shell
        # exploration sees the real slide contents.
        try:
            children = sorted(self.data_dir.iterdir(), key=lambda p: p.name)
        except OSError:
            return mounts

        for child in children:
            if not child.is_symlink():
                continue
            try:
                target = child.resolve(strict=True)
            except OSError:
                continue
            mounts.extend(["-v", f"{target}:/data/{child.name}:ro"])
        return mounts

    def describe(self) -> dict:
        if self.backend == "docker":
            return {
                "backend": "docker",
                "data_root": "/data",
                "scratch_root": "/scratch",
                "shared_root": "/shared" if self.shared_dir else None,
                "python_import_root": "/shared/lib" if self.shared_dir else None,
                "persistent_python_ready": self.persistent_python_ready,
                "notes": [
                    "Data folder is mounted read-only at /data.",
                    "Write ephemeral output into /scratch.",
                    "Persistent shared storage is at /shared (read-write, persists across rounds).",
                    "If /shared/lib exists it is already on PYTHONPATH inside shell_exec commands.",
                    "python/python3 are wrapped to reuse a warm per-worker runtime for scripts, -c, and stdin code when available.",
                    "No network access available.",
                ],
            }
        return {
            "backend": "host",
            "data_root": str(self.data_dir),
            "scratch_root": str(self.scratch_dir),
            "shared_root": str(self.shared_dir) if self.shared_dir else None,
            "persistent_python_ready": self.persistent_python_ready,
            "notes": [
                "Running on host (no Docker isolation).",
                "python/python3 are wrapped to reuse a warm per-worker runtime for scripts, -c, and stdin code when available.",
            ],
        }

    def start(self) -> None:
        if self.started:
            return
        if self.backend == "docker":
            self.real_python_path = "/usr/local/bin/python3"
        else:
            self.real_python_path = sys.executable
        self._install_runtime_files()
        if self.backend == "docker":
            self._start_docker()
        elif self.backend == "host":
            self._start_host_runtime()
            self.started = True
        else:
            raise ValueError(f"Unsupported sandbox backend: {self.backend}")
        if self.backend == "docker":
            self._start_docker_runtime()

    def stop(self) -> None:
        if not self.started:
            return
        if self.runtime_process is not None:
            self.runtime_process.terminate()
            try:
                self.runtime_process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.runtime_process.kill()
            self.runtime_process = None
        socket_path = self._runtime_socket_path()
        if socket_path.exists():
            socket_path.unlink()
        if self.backend == "docker" and self.container_name:
            subprocess.run(
                ["docker", "rm", "-f", self.container_name],
                capture_output=True, text=True, check=False,
            )
            self.container_name = None
        self.started = False
        self.persistent_python_ready = False

    def exec(self, command: str, timeout_sec: Optional[int] = None) -> dict:
        if not self.started:
            raise RuntimeError("Sandbox session has not been started")
        timeout = int(timeout_sec or self.command_timeout_sec)
        if self.backend == "docker":
            return self._docker_exec(command, timeout)
        return self._host_exec(command, timeout)

    # -- Persistent runtime helpers -----------------------------------------

    def _runtime_root(self) -> Path:
        return self.scratch_dir / RUNTIME_DIRNAME

    def _runtime_socket_path(self) -> Path:
        if self.backend == "docker":
            return self._runtime_root() / RUNTIME_SOCKET_NAME
        digest = hashlib.sha1(str(self.scratch_dir).encode()).hexdigest()[:12]
        return Path("/tmp") / f"tlrt_{digest}.sock"

    def _runtime_server_path(self) -> Path:
        return self._runtime_root() / RUNTIME_SERVER_SCRIPT

    def _runtime_client_path(self) -> Path:
        return self._runtime_root() / RUNTIME_CLIENT_SCRIPT

    def _runtime_bin_dir(self) -> Path:
        return self._runtime_root() / "bin"

    def _runtime_exec_root(self) -> str:
        return f"/scratch/{RUNTIME_DIRNAME}" if self.backend == "docker" else str(self._runtime_root())

    def _runtime_exec_socket(self) -> str:
        if self.backend == "docker":
            return DOCKER_RUNTIME_SOCKET_PATH
        return str(self._runtime_socket_path())

    def _runtime_exec_server(self) -> str:
        return f"{self._runtime_exec_root()}/{RUNTIME_SERVER_SCRIPT}"

    def _runtime_exec_client(self) -> str:
        return f"{self._runtime_exec_root()}/{RUNTIME_CLIENT_SCRIPT}"

    def _runtime_exec_bin_dir(self) -> str:
        return f"{self._runtime_exec_root()}/bin"

    def _install_runtime_files(self) -> None:
        runtime_root = self._runtime_root()
        runtime_root.mkdir(parents=True, exist_ok=True)
        self._runtime_bin_dir().mkdir(parents=True, exist_ok=True)

        server_path = self._runtime_server_path()
        client_path = self._runtime_client_path()
        server_path.write_text(RUNTIME_SERVER_CODE, encoding="utf-8")
        client_path.write_text(RUNTIME_CLIENT_CODE, encoding="utf-8")
        os.chmod(server_path, 0o755)
        os.chmod(client_path, 0o755)

        for name in ("python", "python3", "tlpy"):
            wrapper_path = self._runtime_bin_dir() / name
            wrapper_path.write_text(
                RUNTIME_WRAPPER_TEMPLATE.format(
                    real_python=self.real_python_path,
                    client_path=self._runtime_exec_client(),
                ),
                encoding="utf-8",
            )
            os.chmod(wrapper_path, 0o755)

        socket_path = self._runtime_socket_path()
        if socket_path.exists():
            socket_path.unlink()

    def _runtime_env(self) -> dict[str, str]:
        return {
            "TL_RUNTIME_ROOT": self._runtime_exec_root(),
            "TL_RUNTIME_SOCKET": self._runtime_exec_socket(),
            "TL_REAL_PYTHON": self.real_python_path,
        }

    def _wait_for_runtime_socket(self, timeout_sec: float = 5.0) -> bool:
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            if self.backend == "docker":
                if self.container_name:
                    probe = subprocess.run(
                        [
                            "docker", "exec",
                            self.container_name,
                            "/bin/sh", "-lc",
                            f'[ -S "{self._runtime_exec_socket()}" ]',
                        ],
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    if probe.returncode == 0:
                        self.persistent_python_ready = True
                        return True
                time.sleep(0.1)
                continue

            socket_path = self._runtime_socket_path()
            if socket_path.exists():
                self.persistent_python_ready = True
                return True
            time.sleep(0.05)
        self.persistent_python_ready = False
        return False

    def _start_host_runtime(self) -> None:
        env = os.environ.copy()
        env.update(self._runtime_env())
        env["HOME"] = str(self.scratch_dir)
        env["MPLCONFIGDIR"] = str(self.scratch_dir / ".matplotlib")
        server_log = self._runtime_root() / "server.log"
        with server_log.open("w", encoding="utf-8") as log_file:
            self.runtime_process = subprocess.Popen(
                [self.real_python_path, str(self._runtime_server_path())],
                cwd=str(self.scratch_dir),
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
            )
        self._wait_for_runtime_socket()

    def _start_docker_runtime(self) -> None:
        assert self.container_name is not None
        env = self._runtime_env()
        cmd = [
            "docker", "exec", "-d",
            "-w", "/",
        ]
        for key, value in env.items():
            cmd.extend(["-e", f"{key}={value}"])
        cmd.extend(
            [
                self.container_name,
                "/bin/sh",
                "-lc",
                (
                    f'cd /scratch && exec {self.real_python_path} {self._runtime_exec_server()} '
                    f'>{self._runtime_exec_root()}/server.log 2>&1'
                ),
            ]
        )
        subprocess.run(cmd, capture_output=True, text=True, check=False)
        self._wait_for_runtime_socket()

    # -- Docker helpers -------------------------------------------------------

    def _start_docker(self) -> None:
        self._ensure_docker_image()
        digest = hashlib.sha1(str(self.scratch_dir).encode()).hexdigest()[:12]
        self.container_name = f"tl-autoresearch-{digest}-{int(time.time())}"
        cmd = [
            "docker", "run", "-d", "--rm",
            "--name", self.container_name,
            "--network", "none",
            "--read-only",
            "--tmpfs", "/tmp:rw,nosuid,size=512m",
            "-w", "/",
            "-e", "HOME=/scratch",
            "-e", "MPLCONFIGDIR=/scratch/.matplotlib",
            "-v", f"{self.scratch_dir}:/scratch:rw",
        ]
        cmd.extend(self._docker_data_mounts())
        if self.shared_dir:
            cmd.extend(["-v", f"{self.shared_dir}:/shared:rw"])
        cmd.extend([
            self.image, "sleep", "infinity",
        ])
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            raise RuntimeError(
                f"Failed to start Docker sandbox: {proc.stderr.strip() or proc.stdout.strip()}"
            )
        self.started = True

    def _docker_exec(self, command: str, timeout: int) -> dict:
        assert self.container_name is not None
        wrapped = self._wrap_command(command)
        try:
            proc = subprocess.run(
                ["docker", "exec", "-i", "-w", "/",
                 self.container_name, "/bin/sh", "-lc", wrapped],
                capture_output=True, text=True,
                timeout=timeout, check=False,
            )
            return {
                "backend": "docker",
                "exit_code": proc.returncode,
                "stdout": proc.stdout[-20_000:],
                "stderr": proc.stderr[-20_000:],
            }
        except subprocess.TimeoutExpired:
            return {
                "backend": "docker",
                "exit_code": -1,
                "stdout": "",
                "stderr": f"Command timed out after {timeout}s",
            }

    def _ensure_docker_image(self) -> None:
        with _DOCKER_IMAGE_LOCK:
            check = subprocess.run(
                ["docker", "image", "inspect", self.image],
                capture_output=True, text=True, check=False,
            )
            if check.returncode == 0:
                return
            if not self.auto_build:
                raise RuntimeError(
                    f"Docker image '{self.image}' not found and auto_build is disabled"
                )
            print(f"[autoresearch] Building Docker image '{self.image}'...")
            proc = subprocess.run(
                ["docker", "build", "-t", self.image, "-f", "-", "."],
                input=DOCKERFILE_TEMPLATE,
                capture_output=True, text=True, check=False,
                cwd=str(Path(__file__).parent),
            )
            if proc.returncode != 0:
                raise RuntimeError(
                    f"Docker build failed: {proc.stderr.strip() or proc.stdout.strip()}"
                )
            print(f"[autoresearch] Docker image '{self.image}' built successfully")

    # -- Host fallback --------------------------------------------------------

    def _host_exec(self, command: str, timeout: int) -> dict:
        env = os.environ.copy()
        env["HOME"] = str(self.scratch_dir)
        env["MPLCONFIGDIR"] = str(self.scratch_dir / ".matplotlib")
        env.update(self._runtime_env())
        runtime_bin = self._runtime_exec_bin_dir()
        env["PATH"] = f"{runtime_bin}:{env.get('PATH', '')}" if env.get("PATH") else runtime_bin
        if self.shared_dir:
            shared_lib = str(Path("/shared") / "lib") if self.backend == "docker" else str(self.shared_dir / "lib")
            existing = env.get("PYTHONPATH", "")
            env["PYTHONPATH"] = f"{shared_lib}:{existing}" if existing else shared_lib
        try:
            proc = subprocess.run(
                ["/bin/sh", "-lc", self._wrap_command(command)],
                cwd=str(self.scratch_dir),
                env=env,
                capture_output=True, text=True,
                timeout=timeout, check=False,
            )
            return {
                "backend": "host",
                "exit_code": proc.returncode,
                "stdout": proc.stdout[-20_000:],
                "stderr": proc.stderr[-20_000:],
            }
        except subprocess.TimeoutExpired:
            return {
                "backend": "host",
                "exit_code": -1,
                "stdout": "",
                "stderr": f"Command timed out after {timeout}s",
            }

    def _wrap_command(self, command: str) -> str:
        prelude_lines = [
            'cd /scratch || exit 97',
            f'export TL_RUNTIME_ROOT="{self._runtime_exec_root()}"',
            f'export TL_RUNTIME_SOCKET="{self._runtime_exec_socket()}"',
            f'export TL_REAL_PYTHON="{self.real_python_path}"',
            f'export PATH="{self._runtime_exec_bin_dir()}:$PATH"',
        ]
        if self.shared_dir:
            prelude_lines.extend(
                [
                    'export PYTHONPATH="/shared/lib${PYTHONPATH:+:$PYTHONPATH}"',
                    'export TL_SHARED_ROOT="/shared"',
                    'export TL_SHARED_CACHE="/shared/cache"',
                    'export TL_SHARED_TEMPLATE="/shared/templates/worker_analysis_template.py"',
                ]
            )
        prelude = "\n".join(prelude_lines)
        if not prelude:
            return command
        return f"{prelude}\n{command}"
