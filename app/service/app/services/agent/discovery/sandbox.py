"""
Docker sandbox for model-written code (proposer exploration, worker scripts,
the controller's donor-table materialization).

Each session is one container with:
- the data folder read-only at /data, with every run-output folder masked so a
  run never sees earlier runs' results, every other table (csv / tsv / xlsx /
  xls / parquet) shadowed by an empty file, plus optional read-only single-file
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
import posixpath
import shutil
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Optional

import psutil


_DOCKER_IMAGE_LOCK = threading.Lock()

# A Finder-launched macOS app inherits launchd's bare PATH, which lacks the
# docker CLI (and the credential helpers it calls); append where Docker
# Desktop and Homebrew install them.
_MAC_DOCKER_DIRS = ("/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin")


def _add_docker_to_path() -> None:
    if sys.platform != "darwin" or shutil.which("docker"):
        return
    current = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    os.environ["PATH"] = os.pathsep.join([*current, *(d for d in _MAC_DOCKER_DIRS if d not in current)])


_add_docker_to_path()

# Caps on the two docker calls made while _DOCKER_IMAGE_LOCK is held. An inspect
# is instant when the daemon is healthy; a first build pulls a base image.
DOCKER_INSPECT_TIMEOUT = 30
DOCKER_BUILD_TIMEOUT = 1800
DOCKER_RUN_TIMEOUT = 120
DOCKER_CLI_TIMEOUT = 15
# Bytes of each output stream a command returns (the tail); the rest is dropped as it streams.
OUTPUT_TAIL_BYTES = 20_000

# Resource caps for the container. The code inside is model-generated and
# unreviewed, so an unbounded container could take the host down with it.
SANDBOX_MEMORY = os.environ.get("TL_SANDBOX_MEMORY", "8g")
SANDBOX_CPUS = os.environ.get("TL_SANDBOX_CPUS", "4")
SANDBOX_PIDS_LIMIT = os.environ.get("TL_SANDBOX_PIDS_LIMIT", "512")
SANDBOX_TMPFS_SIZE = os.environ.get("TL_SANDBOX_TMPFS_SIZE", "512m")

OWNER_LABEL = "tissuelab.discovery.pid"
OWNER_STARTED_LABEL = "tissuelab.discovery.pid_started"
SHARED_READ_ONLY = ("lib", "dataset.json", "dataset_guide.md")
# Runs live under <data folder>/autoresearch_runs; the sandbox masks it (at any depth).
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
                sys.path.insert(0, os.path.dirname(path))   # as `python script.py` does
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
                sys.path.insert(0, cwd)   # as `python -c` does
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
                    # SIG_IGN is inherited: left in place, the request's own
                    # subprocesses are auto-reaped and always report exit 0.
                    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
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

# Tabular files other than the (overlaid) cohort may carry outcomes: each is
# shadowed by an empty file. Capped so a huge tree cannot explode the mount list.
TABULAR_SUFFIXES = (".csv", ".tsv", ".xlsx", ".xls", ".parquet")
MAX_MASKS = 2000
MAX_WALK_ENTRIES = 200_000


# -- host access to sandbox-writable folders -------------------------------------
# /scratch and /shared are writable from the container, so model-written code can
# plant symlinks (or FIFOs) there. Every host-side read / write in them goes
# through these helpers: no symlink below the root is followed, only regular
# files are touched. POSIX walks with dir_fd + O_NOFOLLOW (race-free); Windows
# falls back to an lstat check per component.

class UnsafePathError(OSError):
    """A path below a sandbox-writable root crosses a symlink or is not a regular file."""


_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_O_NONBLOCK = getattr(os, "O_NONBLOCK", 0)   # a planted FIFO must not block the open
_O_BINARY = getattr(os, "O_BINARY", 0)
_DIR_FD_OK = bool(_O_NOFOLLOW) and os.open in os.supports_dir_fd


def _relative_parts(relative: str | Path) -> tuple[str, ...]:
    parts = posixpath.normpath(str(relative).replace("\\", "/")).split("/")
    if not parts or parts[0] in ("", ".", "..") or ".." in parts:
        raise UnsafePathError(f"not a plain relative path: {relative}")
    return tuple(parts)


def _open_contained(root: str | Path, relative: str | Path, flags: int, mode: int = 0o644,
                    *, make_dirs: bool = False) -> int:
    parts = _relative_parts(relative)
    flags |= _O_NONBLOCK | _O_BINARY
    if not _DIR_FD_OK:
        path = Path(root)
        for i, part in enumerate(parts):
            path = path / part
            if i < len(parts) - 1 and make_dirs and not os.path.lexists(path):
                path.mkdir(exist_ok=True)
            if os.path.islink(path):
                if i == len(parts) - 1 and flags & os.O_CREAT:
                    os.unlink(path)
                    continue
                raise UnsafePathError(f"symlink in sandbox path: {path}")
        fd = os.open(path, flags, mode)
    else:
        dir_fd = os.open(root, os.O_RDONLY | _O_DIRECTORY)
        try:
            for part in parts[:-1]:
                if make_dirs:
                    try:
                        os.mkdir(part, dir_fd=dir_fd)
                    except FileExistsError:
                        pass
                try:
                    nxt = os.open(part, os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW, dir_fd=dir_fd)
                except OSError as e:   # ELOOP / ENOTDIR: a link where a folder should be
                    if isinstance(e, FileNotFoundError):
                        raise
                    raise UnsafePathError(f"symlink in sandbox path: {relative}") from e
                os.close(dir_fd)
                dir_fd = nxt
            try:
                fd = os.open(parts[-1], flags | _O_NOFOLLOW, mode, dir_fd=dir_fd)
            except OSError as e:
                if not _is_link_at(dir_fd, parts[-1]):
                    raise
                if not flags & os.O_CREAT:
                    raise UnsafePathError(f"symlink in sandbox path: {relative}") from e
                os.unlink(parts[-1], dir_fd=dir_fd)   # writing: replace the planted link
                fd = os.open(parts[-1], flags | _O_NOFOLLOW | os.O_EXCL, mode, dir_fd=dir_fd)
        finally:
            os.close(dir_fd)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise UnsafePathError(f"not a regular file: {relative}")
    return fd


def _is_link_at(dir_fd: int, name: str) -> bool:
    try:
        return stat.S_ISLNK(os.stat(name, dir_fd=dir_fd, follow_symlinks=False).st_mode)
    except OSError:
        return False


def write_contained(root: str | Path, relative: str | Path, data: str | bytes, *,
                    mode: Optional[int] = None, make_dirs: bool = True) -> None:
    """Write root/relative without following links (str is written UTF-8 with LF newlines)."""
    payload = data.encode("utf-8") if isinstance(data, str) else data
    fd = _open_contained(root, relative, os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
                         0o644 if mode is None else mode, make_dirs=make_dirs)
    try:
        if mode is not None and hasattr(os, "fchmod"):
            os.fchmod(fd, mode)
        view = memoryview(payload)
        while view:
            view = view[os.write(fd, view):]
    finally:
        os.close(fd)


def read_contained(root: str | Path, relative: str | Path, max_bytes: Optional[int] = None) -> Optional[bytes]:
    """Bytes of root/relative, or None when missing, linked or not a regular file."""
    try:
        fd = _open_contained(root, relative, os.O_RDONLY)
    except OSError:
        return None
    try:
        chunks, total = [], 0
        while max_bytes is None or total < max_bytes:
            chunk = os.read(fd, 1 << 20 if max_bytes is None else min(1 << 20, max_bytes - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        return b"".join(chunks)
    except OSError:
        return None
    finally:
        os.close(fd)


def stat_contained(root: str | Path, relative: str | Path) -> Optional[os.stat_result]:
    """stat of root/relative as a regular file reached without links, else None."""
    try:
        fd = _open_contained(root, relative, os.O_RDONLY)
    except OSError:
        return None
    try:
        return os.fstat(fd)
    finally:
        os.close(fd)


# -- data folder scan ------------------------------------------------------------

def _scan_data(base: Path) -> dict[str, list[Path]]:
    """One bounded walk below base, not following links and not entering .zarr stores
    (their chunk files are never links out) or run-output folders (masked).

    Returns {"symlinks", "runs", "tabular"}: every symlink, every RUNS_DIRNAME
    folder at any depth, every tabular file (a linked one counts as tabular too,
    so it is masked, not mounted).
    """
    found: dict[str, list[Path]] = {"symlinks": [], "runs": [], "tabular": []}
    seen = 0
    for root, dirs, files in os.walk(base):
        root_path = Path(root)
        for name in [*dirs, *files]:
            seen += 1
            entry = root_path / name
            linked = entry.is_symlink()
            if name == RUNS_DIRNAME and name in dirs:
                found["runs"].append(entry)
            elif name.lower().endswith(TABULAR_SUFFIXES) and (name in files or linked):
                found["tabular"].append(entry)
            elif linked:
                found["symlinks"].append(entry)
        dirs[:] = [n for n in dirs if n != RUNS_DIRNAME and not n.lower().endswith(".zarr")]
        if seen > MAX_WALK_ENTRIES:
            print(f"[discovery] data folder scan stopped after {MAX_WALK_ENTRIES} entries: {base}")
            break
    for key in found:
        found[key].sort(key=lambda p: p.relative_to(base).as_posix())
    return found


def _symlinks_under(data_dir: Path) -> list[Path]:
    """Every symlink below data_dir, skipping run-output folders at any depth.

    Linked directories are not followed, and a .zarr store is checked itself
    but not walked: its (often millions of) chunk files are never links out.
    """
    return _scan_data(data_dir)["symlinks"]


def _read_tail(stream, name: str, tails: dict[str, bytes]) -> None:
    """Read a pipe to EOF, keeping its last OUTPUT_TAIL_BYTES in tails[name]."""
    tail = b""
    with stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            tail = (tail + chunk)[-OUTPUT_TAIL_BYTES:]
    tails[name] = tail


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
        # Keys are normalized (a Windows-style or ./-prefixed cohort_file) so the
        # overlay sits exactly on the real file's path.
        self.file_overlays = {
            posixpath.normpath(str(k).replace("\\", "/")): str(Path(v).resolve())
            for k, v in (file_overlays or {}).items()
        }
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
        # stdin is closed (an inherited one can hang a command that reads it), and
        # each stream is drained as it arrives keeping only its tail, so a chatty
        # command cannot fill the service's memory.
        proc = subprocess.Popen(
            ["docker", "exec", "-w", "/",
             self.container_name, "/bin/sh", "-lc", self._wrap_command(command)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        tails: dict[str, bytes] = {}
        readers = [
            threading.Thread(target=_read_tail, args=(stream, name, tails), daemon=True)
            for name, stream in (("stdout", proc.stdout), ("stderr", proc.stderr))
        ]
        for reader in readers:
            reader.start()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            self._kill_inflight()
            return {
                "exit_code": -1,
                "stdout": "",
                "stderr": f"Command timed out after {timeout}s (process killed)",
            }
        for reader in readers:
            reader.join(timeout=5)   # docker exited; its pipes close with it
        return {
            "exit_code": proc.returncode,
            "stdout": tails.get("stdout", b"").decode("utf-8", errors="replace"),
            "stderr": tails.get("stderr", b"").decode("utf-8", errors="replace"),
        }

    # -- warm Python runtime ----------------------------------------------------

    def _runtime_root(self) -> Path:
        return self.scratch_dir / RUNTIME_DIRNAME

    def _runtime_exec_root(self) -> str:
        return f"/scratch/{RUNTIME_DIRNAME}"

    def _install_runtime_files(self) -> None:
        # Written as bytes (LF on Windows too: the container runs them) and
        # without following links (/scratch may be a reused, container-written folder).
        root = self.scratch_dir
        write_contained(root, f"{RUNTIME_DIRNAME}/{RUNTIME_SERVER_SCRIPT}", RUNTIME_SERVER_CODE, mode=0o755)
        write_contained(root, f"{RUNTIME_DIRNAME}/{RUNTIME_CLIENT_SCRIPT}", RUNTIME_CLIENT_CODE, mode=0o755)
        for name in ("python", "python3", "tlpy"):
            write_contained(
                root, f"{RUNTIME_DIRNAME}/bin/{name}",
                RUNTIME_WRAPPER_TEMPLATE.format(
                    real_python=SANDBOX_PYTHON,
                    client_path=f"{self._runtime_exec_root()}/{RUNTIME_CLIENT_SCRIPT}",
                ),
                mode=0o755,
            )

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

    def _empty_mask_file(self) -> Path:
        # Beside /scratch, not in it: the container cannot write it.
        path = self.scratch_dir.parent / ".tl_empty_mask"
        if not path.is_file() or path.is_symlink() or path.stat().st_size:
            path.unlink(missing_ok=True)
            path.write_bytes(b"")
        return path

    def _data_mounts(self) -> list[str]:
        mounts = ["-v", f"{self.data_dir}:/data:ro"]
        try:
            scan = _scan_data(self.data_dir)
        except OSError:
            scan = {"symlinks": [], "runs": [], "tabular": []}
        runs = [(self.data_dir, p) for p in scan["runs"]]
        tabular = [(self.data_dir, p) for p in scan["tabular"]]
        # Symlink targets outside the mounted folder are otherwise invisible:
        # overlay each resolved link at its original relative path.
        for entry in scan["symlinks"]:
            try:
                target = entry.resolve(strict=True)
                relative = entry.relative_to(self.data_dir)
            except (OSError, ValueError):
                continue
            # A link back into the data folder would expose, through a second
            # mount, what the overlays and the masks hide (and one to an
            # ancestor, e.g. `root -> /`, the whole host): never mount those.
            # Relative ones still resolve inside the container's /data.
            if target.is_relative_to(self.data_dir) or self.data_dir.is_relative_to(target):
                continue
            container_path = (Path("/data") / relative).as_posix()
            if container_path in self.file_overlays:
                continue   # shadowed by an overlay (e.g. a symlinked cohort file)
            if target.is_file() and target.name.lower().endswith(TABULAR_SUFFIXES):
                tabular.append((self.data_dir, entry))   # masked, not mounted
                continue
            mounts.extend(["-v", f"{target}:{container_path}:ro"])
            if target.is_dir():   # a linked folder brings its own tables / run folders
                try:
                    sub = _scan_data(target)
                except OSError:
                    continue
                rebase = lambda p, t=target, e=entry: e / p.relative_to(t)
                runs += [(self.data_dir, rebase(p)) for p in sub["runs"]]
                tabular += [(self.data_dir, rebase(p)) for p in sub["tabular"]]
        # Earlier runs' outputs (results, panels, reports) sit inside the data
        # folder, at any depth; an empty tmpfs over each keeps them out of view.
        masks: list[str] = []
        for base, path in runs:
            masks.extend(["--tmpfs", f"{(Path('/data') / path.relative_to(base)).as_posix()}:ro,size=64k"])
        # Other tables may carry the outcome: an empty file shadows each. The
        # loaders read only the (overlaid) cohort file and metadata/<id>.json
        # (shared_analysis/slides.py), which is JSON and stays visible.
        # A link to a file inside the folder is masked at its target: a second
        # mount through the link would stack on (and could blank) an overlay.
        table_paths = set()
        for base, path in tabular:
            if path.is_symlink():
                try:
                    target = path.resolve(strict=True)
                except OSError:
                    continue
                if not target.is_file():
                    continue
                if target.is_relative_to(self.data_dir):
                    base, path = self.data_dir, target
            table_paths.add((Path("/data") / path.relative_to(base)).as_posix())
        container_tables = sorted(table_paths - set(self.file_overlays))
        if container_tables:
            if len(container_tables) + len(runs) > MAX_MASKS:
                # Refuse rather than start with outcome tables visible.
                raise RuntimeError(
                    f"The data folder holds {len(container_tables)} tables outside the cohort file; "
                    f"the sandbox masks at most {MAX_MASKS}. Move unrelated tables out of the data folder."
                )
            empty = self._empty_mask_file()
            for container_path in container_tables:
                masks.extend(["-v", f"{empty}:{container_path}:ro"])
        return mounts + masks

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
            "--label", f"{OWNER_STARTED_LABEL}={_own_create_time()}",   # tells a reused pid apart
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
                # A link planted by an earlier session would bind a host file into this one.
                if (self.shared_dir / name).exists() and not (self.shared_dir / name).is_symlink():
                    cmd.extend(["-v", f"{self.shared_dir / name}:/shared/{name}:ro"])
        cmd.extend([self.image, "sleep", "infinity"])
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, check=False, timeout=DOCKER_RUN_TIMEOUT,
            )
        except subprocess.TimeoutExpired as e:
            # The container may still come up after the CLI gave up: remove it by name.
            _remove_containers([self.container_name])
            raise RuntimeError(f"Docker did not start the sandbox within {DOCKER_RUN_TIMEOUT}s") from e
        if proc.returncode != 0:
            _remove_containers([self.container_name])   # a created-but-not-started one is left otherwise
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


def _own_create_time() -> str:
    try:
        return f"{psutil.Process().create_time():.3f}"
    except (psutil.Error, OSError):
        return ""


def _owner_alive(pid: int, started: str) -> bool:
    """The owner pid is running and is the same process (not a reused pid)."""
    if not psutil.pid_exists(pid):
        return False
    try:
        expected = float(started)
    except ValueError:
        return True   # an unlabeled (older) container: the pid is all there is
    try:
        return abs(psutil.Process(pid).create_time() - expected) < 1.0
    except (psutil.Error, OSError):
        return False


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
             "--format", f'{{{{.Names}}}}\t{{{{.Label "{OWNER_LABEL}"}}}}\t{{{{.Label "{OWNER_STARTED_LABEL}"}}}}'],
            capture_output=True, text=True, check=False, timeout=DOCKER_CLI_TIMEOUT,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 0
    if proc.returncode != 0:
        return 0
    own_pid, own_started = os.getpid(), _own_create_time()
    doomed: list[str] = []
    for line in proc.stdout.splitlines():
        name, _, rest = line.partition("\t")
        pid_text, _, started = rest.partition("\t")
        try:
            pid = int(pid_text.strip())
        except ValueError:
            continue
        started = started.strip()
        if current_process:
            if pid == own_pid:
                doomed.append(name.strip())
        elif pid == own_pid:
            if started and started != own_started:   # an earlier process that had our pid
                doomed.append(name.strip())
        elif not _owner_alive(pid, started):
            doomed.append(name.strip())
    _remove_containers(doomed)
    return len(doomed)
