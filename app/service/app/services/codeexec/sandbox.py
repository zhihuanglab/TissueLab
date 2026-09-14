"""Execution backends.

Preferred: a Docker container with NO network, the input zarr mounted read-only
at /data, the user's own output dir mounted read-write at /out, a read-only root
filesystem, and memory / CPU / pid limits. Even if the guard and the LLM review
both miss something, the container physically cannot see other users' files.

Fail-closed by default: if Docker is unavailable and CODEEXEC_DOCKER is not
explicitly ``0``, refuse to run. Local unrestricted host subprocess is only for
``CODEEXEC_DOCKER=0``.
"""

import json
import os
import shutil
import subprocess
import tempfile
import traceback as _tb
import uuid
from concurrent.futures import ProcessPoolExecutor

from app.core.logger import logger
from .schema import ExecRequest, ExecResult

try:
    import resource  # Unix only
except Exception:  # pragma: no cover
    resource = None

_DOCKER_IMAGE = os.getenv("CODEEXEC_DOCKER_IMAGE", "tissuelab-codeexec")
_DOCKER_MODE = os.getenv("CODEEXEC_DOCKER", "auto").lower()  # auto | 1 | 0


# ── Shared inner runner (exec the user code, capture stdout + return) ──────────
# Kept as a self-contained source string so the SAME logic runs both in-process
# (subprocess fallback) and inside the container.
_RUNNER_SRC = r'''
import io, json, sys, contextlib, traceback
code = open(sys.argv[1]).read()
zarr_path = sys.argv[2]
out = {}
buf = io.StringIO()
ns = {"zarr_path": zarr_path, "path": zarr_path}
try:
    with contextlib.redirect_stdout(buf):
        exec(code, ns)
        fn = ns.get("analyze_medical_image")
        result = fn(zarr_path) if callable(fn) else ns.get("result")
    out = result if isinstance(result, dict) else ({"result": result} if result is not None else {})
    txt = buf.getvalue()
    if txt:
        out.setdefault("stdout", txt)
except Exception as e:
    out = {"error": str(e), "error_type": type(e).__name__,
           "traceback": traceback.format_exc(), "stdout": buf.getvalue()}
json.dump(out, open(sys.argv[3], "w"), default=str)
'''


def _docker_available() -> bool:
    if _DOCKER_MODE == "0":
        return False
    if not shutil.which("docker"):
        return False
    try:
        # NOTE: `docker image inspect` is unreliable under the containerd image
        # store (some Docker Desktop builds report "No such image" for an image
        # that exists and runs fine). `docker images -q` is robust: it prints the
        # image ID when present and nothing when absent.
        r = subprocess.run(["docker", "images", "-q", _DOCKER_IMAGE],
                           capture_output=True, text=True, timeout=10)
        return r.returncode == 0 and bool(r.stdout.strip())
    except Exception:
        return False


# ── Docker backend ────────────────────────────────────────────────────────────
def _force_remove_container(name: str) -> bool:
    """Kill and remove a container by name. True when it is gone (or never ran).

    Best effort by design: the caller is already returning a timeout to the
    user, and a failure to reap must not turn that into a 500.
    """
    if not name:
        return False
    try:
        proc = subprocess.run(
            ["docker", "rm", "-f", name],
            capture_output=True, text=True, timeout=15,
        )
    except Exception as e:
        logger.warning("codeexec: could not remove container %s: %s", name, e)
        return False
    if proc.returncode == 0:
        logger.info("codeexec: removed timed-out container %s", name)
        return True
    stderr = (proc.stderr or "").lower()
    # Already gone is success — the container may have exited on its own.
    if "no such container" in stderr:
        return True
    logger.warning(
        "codeexec: docker rm -f %s failed: %s", name, (proc.stderr or "").strip()[:200]
    )
    return False


def run_docker(req: ExecRequest) -> ExecResult:
    scratch = tempfile.mkdtemp(prefix="codeexec_")
    # Bound outside the try so the timeout handler can always reach it.
    container_name = f"codeexec_{uuid.uuid4().hex}"
    # Set on every path that has already dealt with the container. Not a claim
    # that it is gone — a reap can fail — only that this path has issued the
    # `docker rm -f`. The cleanup below is for the paths that never got that far.
    settled = False
    try:
        with open(os.path.join(scratch, "user_code.py"), "w") as f:
            f.write(req.code)
        with open(os.path.join(scratch, "runner.py"), "w") as f:
            f.write(_RUNNER_SRC)

        # Run as the host service account so output files are owned by it (not root).
        user_flag = ["--user", f"{os.getuid()}:{os.getgid()}"] if hasattr(os, "getuid") else []

        # READ-ONLY mounts at their real host paths — the code may READ any
        # reference/other file under these, but can never modify or delete them.
        mounts, seen = [], set()
        # Always expose the input zarr read-only — it may live outside the read
        # roots (e.g. a file opened from an arbitrary local path) — plus the
        # configured read roots (storage + shared data).
        for root in [req.zarr_path, *(req.read_roots or [])]:
            if root and os.path.isdir(root) and root not in seen:
                seen.add(root)
                mounts += ["-v", f"{root}:{root}:ro"]
        # READ-WRITE: ONLY the user's own output dir (overlays the read-only mount at
        # that subpath) — the single place the code may create / modify / delete files.
        env_flag = []
        if req.output_dir:
            os.makedirs(req.output_dir, exist_ok=True)
            mounts += ["-v", f"{req.output_dir}:{req.output_dir}:rw"]
            env_flag = ["-e", f"TL_EXPORT_DIR={req.output_dir}"]

        # The container is named so a timeout can reach it:
        # `subprocess.run(timeout=)` kills the `docker run` CLIENT, while the
        # container keeps running detached — still executing the user's code
        # with a read-write mount on their output dir — and `--rm` only fires
        # once it finally exits.
        cmd = [
            "docker", "run", "--rm", "--name", container_name,
            "--network", "none", *user_flag, *env_flag,
            "--memory", f"{req.max_memory_mb}m", "--memory-swap", f"{req.max_memory_mb}m",
            "--cpus", "2", "--pids-limit", "256",
            "--read-only", "--tmpfs", "/tmp:size=512m",
            "-v", f"{scratch}:/work:rw", *mounts,
            _DOCKER_IMAGE, "python", "/work/runner.py",
            "/work/user_code.py", req.zarr_path, "/work/result.json",
        ]

        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=req.timeout_seconds)
        # `docker run` returned, so the container has exited and --rm took it.
        settled = True
        result_path = os.path.join(scratch, "result.json")
        if proc.returncode != 0 and not os.path.exists(result_path):
            return ExecResult(ok=False, backend="docker",
                              error=(proc.stderr or "container exited non-zero").strip()[:2000],
                              error_type="DockerError")
        with open(result_path) as f:
            out = json.load(f)
        return ExecResult(ok="error" not in out, result=out,
                          stdout=out.get("stdout", ""), backend="docker",
                          error=out.get("error"), error_type=out.get("error_type"),
                          traceback=out.get("traceback"))
    except subprocess.TimeoutExpired:
        # Best effort, and deliberately not retried in `finally`: the retry would
        # be the same `docker rm -f` microseconds after it failed, and when the
        # daemon is what is wedged it would add another 15s to a request that has
        # already timed out. `_force_remove_container` logs the failure.
        settled = True
        _force_remove_container(container_name)
        return ExecResult(ok=False, backend="docker", error_type="Timeout",
                          error=f"Execution timed out after {req.timeout_seconds}s.")
    except Exception as e:
        return ExecResult(ok=False, backend="docker", error=str(e),
                          error_type=type(e).__name__, traceback=_tb.format_exc())
    finally:
        # The scratch dir is bind-mounted into the container, so dropping it while
        # something is still running against it pulls the mount out from under
        # that process. `settled` covers only the paths that got as far as `docker
        # run` returning (or reaping it themselves); anything that unwound before
        # that — a spawn failure, a cancelled worker, KeyboardInterrupt — may have
        # left a container holding a read-write mount on the user's output dir.
        if not settled:
            _force_remove_container(container_name)
        shutil.rmtree(scratch, ignore_errors=True)


# ── Subprocess fallback ───────────────────────────────────────────────────────
def _exec_with_limits(code_str, zarr_path, output_dir, max_memory_mb, max_cpu_seconds):
    """Runs in a ProcessPoolExecutor child. Same exec/capture as the container."""
    import io
    import contextlib
    # This child is a fresh interpreter (spawn; under PyInstaller a re-launch of
    # the frozen executable) that never ran main.py's startup, so it binds
    # libvips the same way the service does before user code can `import
    # pyvips`. Before the rlimits: dlopen of the libvips stack needs headroom.
    from app.core.libvips import configure as _configure_libvips
    _configure_libvips()
    if output_dir:
        os.environ["TL_EXPORT_DIR"] = output_dir
    if resource is not None:
        try:
            mb = max_memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (mb, mb))
            resource.setrlimit(resource.RLIMIT_CPU, (max_cpu_seconds, max_cpu_seconds))
            resource.setrlimit(resource.RLIMIT_FSIZE, (500 * 1024 * 1024, 500 * 1024 * 1024))
        except Exception:
            pass
    ns = {"zarr_path": zarr_path, "path": zarr_path}
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            exec(code_str, ns)
            fn = ns.get("analyze_medical_image")
            result = fn(zarr_path) if callable(fn) else ns.get("result")
        out = result if isinstance(result, dict) else ({"result": result} if result is not None else {})
        txt = buf.getvalue()
        if txt:
            out.setdefault("stdout", txt)
        return out
    except MemoryError:
        return {"error": "Script exceeded memory limit", "error_type": "MemoryError", "stdout": buf.getvalue()}
    except Exception as e:
        return {"error": str(e), "error_type": type(e).__name__,
                "traceback": _tb.format_exc(), "stdout": buf.getvalue()}


def _kill_pool_workers(executor: ProcessPoolExecutor) -> int:
    """Kill a pool's worker processes. Returns how many were signalled.

    ``shutdown(cancel_futures=True)`` only cancels futures that have not started
    yet — a task already running in a worker cannot be cancelled — and
    ``wait=False`` means we do not block on it either. So a timed-out run left a
    worker executing the user's code indefinitely. RLIMIT_CPU eventually stops
    a busy loop, but nothing stops code that sleeps or blocks on I/O.

    ``_processes`` is private because concurrent.futures offers no public way to
    do this; the pool is created per call and discarded here, so reaching for it
    is contained to this function.
    """
    processes = list((getattr(executor, "_processes", None) or {}).values())
    for process in processes:
        try:
            process.kill()
        except Exception as e:  # pragma: no cover - platform dependent
            logger.warning("codeexec: could not kill sandbox worker: %s", e)
    for process in processes:
        try:
            process.join(timeout=5)
        except Exception:
            pass
    if processes:
        logger.info("codeexec: killed %d timed-out sandbox worker(s)", len(processes))
    return len(processes)


def run_subprocess(req: ExecRequest) -> ExecResult:
    executor = ProcessPoolExecutor(max_workers=1)
    timed_out = False
    try:
        fut = executor.submit(_exec_with_limits, req.code, req.zarr_path,
                              req.output_dir, req.max_memory_mb, req.max_cpu_seconds)
        out = fut.result(timeout=req.timeout_seconds)
        return ExecResult(ok="error" not in out, result=out, stdout=out.get("stdout", ""),
                          backend="subprocess", error=out.get("error"),
                          error_type=out.get("error_type"), traceback=out.get("traceback"))
    except TimeoutError:
        timed_out = True
        return ExecResult(ok=False, backend="subprocess", error_type="Timeout",
                          error=f"Execution timed out after {req.timeout_seconds}s.")
    except Exception as e:
        return ExecResult(ok=False, backend="subprocess", error=str(e),
                          error_type=type(e).__name__, traceback=_tb.format_exc())
    finally:
        if timed_out:
            # Kill before shutdown: shutdown would otherwise leave the running
            # worker to finish on its own time.
            _kill_pool_workers(executor)
        executor.shutdown(wait=False, cancel_futures=True)


def choose_backend() -> str:
    """Decide the backend WITHOUT running anything. Returns:
    - "docker"      → isolated container (read-only data, write-only own folder)
    - "subprocess"  → host process, UNRESTRICTED (CODEEXEC_DOCKER=0, or auto without Docker)
    - "unavailable" → CODEEXEC_DOCKER=1 but Docker is missing (fail-closed)
    """
    if _docker_available():
        return "docker"
    if _DOCKER_MODE == "1":
        logger.error(
            "[codeexec] Docker unavailable and CODEEXEC_DOCKER=1 — refusing to run."
        )
        return "unavailable"
    logger.warning(
        "[codeexec] Docker unavailable (CODEEXEC_DOCKER=%s) — running on the host (unrestricted).",
        _DOCKER_MODE,
    )
    return "subprocess"

