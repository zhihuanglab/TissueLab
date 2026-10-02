"""Regression tests for discovery sandbox / judge fixes (no Docker needed)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from app.services.agent.discovery import sandbox
from app.services.agent.discovery.sandbox import SandboxSession


# ── mounts ────────────────────────────────────────────────────────────────────

def _mounted(mounts):
    return [mounts[i + 1] for i in range(len(mounts) - 1) if mounts[i] == "-v"]


def test_links_into_or_above_the_data_folder_are_not_mounted(tmp_path):
    data = tmp_path / "data"
    (data / "sub").mkdir(parents=True)
    (data / "cases.csv").write_text("id\n")
    external = tmp_path / "slides_elsewhere"
    external.mkdir()
    (data / "root").symlink_to("/")
    (data / "parent").symlink_to(tmp_path)
    (data / "self").symlink_to(data)
    (data / "abs_cohort.csv").symlink_to(data / "cases.csv")
    (data / "sub" / "rel_cohort.csv").symlink_to("../cases.csv")
    (data / "slides").symlink_to(external)

    mounted = _mounted(SandboxSession(tmp_path / "scratch", data_dir=data)._data_mounts())
    # the linked tables are masked at their target (inside the folder), never mounted twice
    empty = tmp_path / ".tl_empty_mask"
    assert mounted == [f"{data.resolve()}:/data:ro", f"{external.resolve()}:/data/slides:ro",
                       f"{empty}:/data/cases.csv:ro"]


def test_symlink_walk_skips_zarr_contents_and_linked_dirs(tmp_path):
    data = tmp_path / "data"
    store = data / "a.zarr" / "Cell-Segmentation"
    store.mkdir(parents=True)
    (store / "inside_link").symlink_to(tmp_path)          # inside a store: not looked at
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / "deep").mkdir(parents=True)
    (elsewhere / "deep" / "link").symlink_to(tmp_path)
    (data / "b.zarr").symlink_to(elsewhere)                # a linked store: found, not followed
    (data / "linked_dir").symlink_to(elsewhere)

    found = [p.relative_to(data).as_posix() for p in sandbox._symlinks_under(data)]
    assert found == ["b.zarr", "linked_dir"]


def test_overlay_path_is_normalized_and_shadows_a_linked_cohort(tmp_path):
    data = tmp_path / "data"
    (data / "sub").mkdir(parents=True)
    real = tmp_path / "real.csv"
    real.write_text("id,y\n")
    (data / "sub" / "cases.csv").symlink_to(real)
    public = tmp_path / "public.csv"
    public.write_text("id\n")
    box = SandboxSession(tmp_path / "scratch", data_dir=data,
                         file_overlays={"/data/./sub\\cases.csv": public})
    assert box.file_overlays == {"/data/sub/cases.csv": str(public.resolve())}
    assert not any("cases.csv" in m for m in box._data_mounts())


def test_docker_dirs_are_appended_to_a_bare_macos_path(monkeypatch):
    monkeypatch.setattr(sandbox.sys, "platform", "darwin")
    monkeypatch.setattr(sandbox.shutil, "which", lambda name: None)
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    sandbox._add_docker_to_path()
    assert os.environ["PATH"].split(os.pathsep) == ["/usr/bin", "/bin", *sandbox._MAC_DOCKER_DIRS]


# ── exec output handling (docker exec swapped for a local shell) ──────────────

def _local_exec(monkeypatch, script):
    real_popen = subprocess.Popen
    seen = {}

    def fake_popen(cmd, **kwargs):
        seen["cmd"], seen["kwargs"] = cmd, kwargs
        return real_popen(["/bin/sh", "-c", script], **kwargs)

    monkeypatch.setattr(sandbox.subprocess, "Popen", fake_popen)
    box = SandboxSession(tempfile.mkdtemp(), data_dir=tempfile.mkdtemp())
    box.started, box.container_name = True, "tl-test"
    return box, seen


def test_exec_keeps_the_tail_decodes_leniently_and_closes_stdin(monkeypatch):
    script = (
        "head -c 3000000 /dev/zero | tr '\\0' x; printf 'END'; "
        "printf '\\377\\376bad' >&2; cat; exit 3"   # cat would hang on an inherited stdin
    )
    box, seen = _local_exec(monkeypatch, script)
    result = box.exec("ignored", timeout_sec=20)
    assert result["exit_code"] == 3
    assert len(result["stdout"]) == sandbox.OUTPUT_TAIL_BYTES and result["stdout"].endswith("xEND")
    assert result["stderr"].endswith("bad") and "�" in result["stderr"]
    assert seen["kwargs"]["stdin"] is subprocess.DEVNULL and "-i" not in seen["cmd"]


def test_exec_drains_both_streams_concurrently(monkeypatch):
    # Megabytes to stderr before any stdout: a reader blocked on stdout alone would deadlock.
    script = (
        "head -c 3000000 /dev/zero | tr '\\0' e >&2; "
        "head -c 3000000 /dev/zero | tr '\\0' o; "
        "(head -c 3000000 /dev/zero | tr '\\0' E >&2) & head -c 3000000 /dev/zero | tr '\\0' O; wait"
    )
    box, _ = _local_exec(monkeypatch, script)
    result = box.exec("ignored", timeout_sec=30)
    assert result["exit_code"] == 0
    assert result["stdout"] == "O" * sandbox.OUTPUT_TAIL_BYTES
    assert result["stderr"] == "E" * sandbox.OUTPUT_TAIL_BYTES


def test_exec_timeout_kills_and_reports(monkeypatch):
    box, _ = _local_exec(monkeypatch, "head -c 3000000 /dev/zero >&2; exec sleep 30")
    killed = []
    monkeypatch.setattr(box, "_kill_inflight", lambda: killed.append(True))
    start = time.monotonic()
    result = box.exec("ignored", timeout_sec=1)
    assert result["exit_code"] == -1 and killed and time.monotonic() - start < 10


# ── warm runtime server, run locally ──────────────────────────────────────────

@pytest.fixture
def runtime():
    root = Path(tempfile.mkdtemp(prefix="tlrt"))   # short: AF_UNIX paths are length-limited
    (root / "server.py").write_text(sandbox.RUNTIME_SERVER_CODE)
    (root / "client.py").write_text(sandbox.RUNTIME_CLIENT_CODE)
    env = {**os.environ, "TL_RUNTIME_SOCKET": str(root / "s.sock"), "TL_RUNTIME_ROOT": str(root),
           "TL_SHARED_ROOT": str(root / "none"), "TL_REAL_PYTHON": sys.executable}
    server = subprocess.Popen([sys.executable, str(root / "server.py")], env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 60
    while not (root / "s.sock").exists() and time.monotonic() < deadline:
        time.sleep(0.05)

    def run(*args, cwd):
        return subprocess.run([sys.executable, str(root / "client.py"), *args], env=env, cwd=cwd,
                              capture_output=True, text=True, timeout=60)

    yield root, run
    server.kill()
    server.wait()
    shutil.rmtree(root, ignore_errors=True)


def test_runtime_reports_child_exit_codes_and_matches_interpreter_sys_path(runtime):
    root, run = runtime
    project = root / "proj"
    project.mkdir()
    (project / "helper.py").write_text("VALUE = 7\n")
    (project / "main.py").write_text(
        "import subprocess, sys, helper\n"
        "rc = subprocess.run([sys.executable, '-c', 'raise SystemExit(5)']).returncode\n"
        "print(helper.VALUE, rc)\n"
    )
    result = run(str(project / "main.py"), cwd=root)       # script dir importable from another cwd
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == ["7", "5"]

    result = run("-c", "import helper; print(helper.VALUE)", cwd=project)   # -c imports from cwd
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "7"


# ── predictive CV ─────────────────────────────────────────────────────────────

def _frame(n, outcome, seed=0):
    rng = np.random.default_rng(seed)
    signal = rng.normal(size=n)
    return pd.DataFrame({
        "donor_id": [f"d{i}" for i in range(n)],
        "y": outcome(signal, rng),
        "age": rng.normal(60, 5, size=n),
        "f": signal,
    })


def _compare(frame, **overrides):
    from app.services.agent.discovery.panel_cv import PredictivePanelConfig, compare_predictive_panels

    config = PredictivePanelConfig(**{"outer_repeats": 2, "inner_folds": 2, "ridge_alphas": (1.0,), **overrides})
    return compare_predictive_panels(frame, outcome_column="y", covariates=["age"], baseline_feature_columns=[],
                                     candidate_feature_columns=["f"], config=config)


def test_constant_outcome_and_single_positive_do_not_crash():
    from app.services.agent.discovery.panel_cv import prediction_metrics

    assert np.isnan(prediction_metrics(np.ones(4), np.arange(4.0))["r2"])
    constant = _compare(_frame(20, lambda s, r: np.full(len(s), 2.0)))
    assert constant["acceptance_passed"] is False
    one_positive = _compare(_frame(20, lambda s, r: (np.arange(len(s)) == 0).astype(float)))
    assert np.isfinite(one_positive["worst_leave_one_donor_rmse_improvement"])


def test_cohort_smaller_than_outer_folds_runs_leave_one_out_and_one_donor_is_refused():
    small = _compare(_frame(3, lambda s, r: s + r.normal(0, 0.1, len(s))))
    assert len(small["baseline_tuning"]) == 2 * 3
    with pytest.raises(ValueError, match="at least 2 donors"):
        _compare(_frame(1, lambda s, r: s))


def test_rmse_gates_do_not_depend_on_the_outcome_units():
    frame = _frame(30, lambda s, r: 0.3 * s + r.normal(0, 1, len(s)))
    scaled = frame.assign(y=frame["y"] * 1e-4)    # e.g. a slope recorded per day instead of per year
    gates = _compare(frame, min_mean_rmse_improvement=0.05)["acceptance_gates"]
    assert gates == _compare(scaled, min_mean_rmse_improvement=0.05)["acceptance_gates"]


def test_influence_stats_partial_r_matches_a_direct_computation():
    from app.services.agent.discovery.judge import _influence_stats

    frame = _frame(30, lambda s, r: s + r.normal(0, 1, len(s)))
    stats = _influence_stats(frame, "f", "y", ["age"])
    X = np.column_stack([np.ones(30), frame["age"]])
    resid = lambda v: v - X @ np.linalg.lstsq(X, v, rcond=None)[0]
    expected = np.corrcoef(resid(frame["y"].to_numpy()), resid(frame["f"].to_numpy()))[0, 1]
    assert stats["partial_r"] == pytest.approx(expected)


# ── workspace scan and slide paths ────────────────────────────────────────────

def test_covariate_candidates_are_those_the_judge_accepts(tmp_path):
    from app.services.agent.discovery.workspace_scan import inspect_cohort

    (tmp_path / "s1.zarr").mkdir()
    (tmp_path / "s2.zarr").mkdir()
    (tmp_path / "s3.zarr").mkdir()
    pd.DataFrame({
        "donor_id": ["a", "b", "c"], "slide": ["s1.zarr", "s2.zarr", "s3.zarr"],
        "y": [1.0, 2.0, 3.0], "age": [50, 60, 70], "sex": ["M", "F", "female"],
        "site": ["x", "y", "x"], "bmi": [20.0, None, 22.0],
    }).to_csv(tmp_path / "cohort.csv", index=False)
    info = inspect_cohort(tmp_path, tmp_path / "cohort.csv")
    assert info["covariate_candidates"] == ["y", "age", "sex"]


def test_slide_paths_accept_windows_separators(tmp_path):
    from app.services.agent.discovery.shared_lib_source.shared_analysis.slides import slide_path

    pd.DataFrame({"case": ["a"], "slide": ["slides\\a.zarr"]}).to_csv(tmp_path / "c.csv", index=False)
    layout = {"cohort_file": "c.csv", "id_column": "case", "slide_column": "slide"}
    assert slide_path(tmp_path, "a", layout) == tmp_path / "slides" / "a.zarr"


# ── data folder masks: nested run folders and outcome-bearing tables ──────────

def test_run_folders_are_masked_at_any_depth_and_not_walked(tmp_path):
    data = tmp_path / "data"
    nested = data / "project" / "sub" / sandbox.RUNS_DIRNAME / "run_old"
    nested.mkdir(parents=True)
    (data / sandbox.RUNS_DIRNAME).mkdir()
    (nested / "linked").symlink_to(tmp_path)   # inside a masked folder: never mounted
    mounts = SandboxSession(tmp_path / "scratch", data_dir=data)._data_mounts()
    tmpfs = [mounts[i + 1] for i in range(len(mounts) - 1) if mounts[i] == "--tmpfs"]
    assert tmpfs == [f"/data/{sandbox.RUNS_DIRNAME}:ro,size=64k",
                     f"/data/project/sub/{sandbox.RUNS_DIRNAME}:ro,size=64k"]
    assert _mounted(mounts) == [f"{data.resolve()}:/data:ro"]
    assert sandbox._symlinks_under(data) == []


def test_tables_other_than_the_cohort_are_masked_but_metadata_json_is_not(tmp_path):
    data = tmp_path / "data"
    for rel in ("cases.csv", "clinical/labels.xlsx", "deep/a/b.parquet", "x.TSV", "old.xls"):
        (data / rel).parent.mkdir(parents=True, exist_ok=True)
        (data / rel).write_text("donor_id,slope\n")
    (data / "metadata").mkdir()
    (data / "metadata" / "d1.json").write_text("{}")
    external = tmp_path / "ext"
    external.mkdir()
    (external / "outcomes.csv").write_text("donor_id,slope\n")
    (data / "linked").symlink_to(external)                       # a linked folder's tables too
    (tmp_path / "far.csv").write_text("donor_id,slope\n")
    (data / "far.csv").symlink_to(tmp_path / "far.csv")          # a linked table: masked, not mounted
    public = tmp_path / "public.csv"
    public.write_text("donor_id\n")
    box = SandboxSession(tmp_path / "scratch", data_dir=data, file_overlays={"/data/cases.csv": public})
    mounted = _mounted(box._data_mounts())
    empty = str(tmp_path / ".tl_empty_mask")
    assert mounted[0] == f"{data.resolve()}:/data:ro"
    assert f"{external.resolve()}:/data/linked:ro" in mounted
    masked = sorted(m.split(":")[1] for m in mounted if m.startswith(empty + ":"))
    assert masked == ["/data/clinical/labels.xlsx", "/data/deep/a/b.parquet", "/data/far.csv",
                      "/data/linked/outcomes.csv", "/data/old.xls", "/data/x.TSV"]
    assert not any("far.csv" in m and not m.startswith(empty) for m in mounted)
    assert not any("cases.csv" in m or "metadata" in m for m in mounted)   # overlay / loader JSON untouched
    assert (tmp_path / ".tl_empty_mask").read_bytes() == b""


def test_too_many_tables_refuse_to_start_rather_than_leak(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    for i in range(4):
        (data / f"t{i}.csv").write_text("a\n")
    monkeypatch.setattr(sandbox, "MAX_MASKS", 3)
    with pytest.raises(RuntimeError, match="masks at most 3"):
        SandboxSession(tmp_path / "scratch", data_dir=data)._data_mounts()


# ── host access to sandbox-writable folders ───────────────────────────────────

def test_contained_io_refuses_links_and_fifos(tmp_path):
    root = tmp_path / "scratch"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret")
    (root / "logs").symlink_to(outside)
    (root / "secret.txt").symlink_to(outside / "secret.txt")
    with pytest.raises(OSError):
        sandbox.write_contained(root, "logs/turn_01.stdout.txt", "x")
    assert sorted(p.name for p in outside.iterdir()) == ["secret.txt"]
    assert sandbox.read_contained(root, "secret.txt") is None
    assert sandbox.read_contained(root, "logs/secret.txt") is None
    assert sandbox.stat_contained(root, "secret.txt") is None
    sandbox.write_contained(root, "secret.txt", "mine")   # a write replaces the planted link
    assert not (root / "secret.txt").is_symlink() and (outside / "secret.txt").read_text() == "secret"
    os.mkfifo(root / "pipe")
    assert sandbox.read_contained(root, "pipe") is None    # returns, does not block on the FIFO
    assert sandbox.read_contained(root, "../outside/secret.txt") is None
    with pytest.raises(OSError):
        sandbox.write_contained(root, "../outside/new.txt", "x")


def test_contained_io_without_dir_fd_still_refuses_links(tmp_path, monkeypatch):
    monkeypatch.setattr(sandbox, "_DIR_FD_OK", False)   # the Windows path
    test_contained_io_refuses_links_and_fifos(tmp_path)


def test_runtime_files_are_written_with_lf_and_executable(tmp_path):
    box = SandboxSession(tmp_path / "scratch", data_dir=tmp_path)
    box._install_runtime_files()
    rt = tmp_path / "scratch" / sandbox.RUNTIME_DIRNAME
    for path in (rt / sandbox.RUNTIME_SERVER_SCRIPT, rt / "bin" / "python"):
        assert b"\r\n" not in path.read_bytes() and os.access(path, os.X_OK)


# ── the worker's controller against a hostile sandbox ─────────────────────────

PROBLEM = "---\noutcome: slope\ncovariates: [age]\n---\nWhich measurements track the slope?\n"
CLEAN_RESULT = "def compute_donor_features(donor_id, data_root):\n    return {'a': 1.0}\n"


class _HostileSandbox:
    """Writes result.py, then plants links: logs -> outside folder, donor table -> outside file."""

    outside: Path = None
    timeouts: list = []

    def __init__(self, scratch_dir, *, data_dir, shared_dir, command_timeout_sec, file_overlays):
        self.scratch = Path(scratch_dir)

    def start(self):
        pass

    def watch_cancel(self, cancel_event):
        return lambda: None

    def stop(self):
        pass

    def exec(self, command, timeout_sec=None):
        _HostileSandbox.timeouts.append(timeout_sec)
        if ".tl_materialize.py" in command:
            (self.scratch / "materialize_report.json").write_text(
                '{"status": "ok", "errors": {}, "rows": 3, "coverage": {"a": 1.0}, "n_errors": 0}')
            (self.scratch / "donor_feature_table.csv").symlink_to(self.outside / "table.csv")
        else:
            (self.scratch / "result.py").write_text(CLEAN_RESULT)
            shutil.rmtree(self.scratch / "logs")
            (self.scratch / "logs").symlink_to(self.outside)
        return {"exit_code": 0, "stdout": "out", "stderr": "err"}


def _worker_module(monkeypatch, replies):
    from app.services.agent.discovery import worker

    monkeypatch.setattr(worker, "SandboxSession", _HostileSandbox)
    monkeypatch.setattr(worker, "responses_create", lambda payload, timeout=0: next(replies))
    return worker


def _cohort(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    pd.DataFrame({"donor_id": ["d1", "d2", "d3"], "slide_name": ["a.zarr", "b.zarr", "c.zarr"],
                  "slope": [0.1, 0.2, 0.3], "age": [70, 71, 72]}).to_csv(data / "training_cohort.csv", index=False)
    return data


def _run(worker, tmp_path, data, **kw):
    from app.services.agent.discovery.problem import parse_problem

    return worker.run_worker(
        worker_brief={"worker_name": "w", "candidate_id": "c", "baseline_variation": "a", "variations": [{"name": "a"}]},
        round_dir=tmp_path / "run" / "round_0001", spec=parse_problem(PROBLEM), data_dir=data,
        shared_dir=tmp_path / "run" / "shared", model="m", **kw,
    )


def test_worker_never_writes_or_reads_through_planted_links(tmp_path, monkeypatch):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "table.csv").write_text("donor_id,a\nd1,1\nd2,1\nd3,1\n")   # would pass every check if read
    _HostileSandbox.outside, _HostileSandbox.timeouts = outside, []
    replies = iter([
        {"id": "r1", "output": [{"type": "custom_tool_call", "name": "shell_exec", "call_id": "c1", "input": "x"}]},
        {"id": "r2", "output": [{"type": "message", "content": [{"type": "output_text", "text": "DONE"}]}]},
    ])
    worker = _worker_module(monkeypatch, replies)
    with pytest.raises(worker.ControllerChecksFailed):
        _run(worker, tmp_path, _cohort(tmp_path), worker_wall_clock_sec=600)
    assert sorted(p.name for p in outside.iterdir()) == ["table.csv"]          # no log written outside
    results = json.loads((tmp_path / "run" / "round_0001" / "w" / "results.json").read_text())
    assert results["controller_checks"]["table_written"] is False                # the linked table was not read
    # materialization is bounded by the remaining wall clock plus the grace
    assert _HostileSandbox.timeouts[-1] <= 600 + worker.MATERIALIZE_GRACE


def test_root_owned_leftovers_are_moved_aside(tmp_path, monkeypatch):
    from app.services.agent.discovery import worker

    worker_dir = tmp_path / "w"
    (worker_dir / "sandbox").mkdir(parents=True)
    (worker_dir / "sandbox" / "result.py").write_text("stale")
    monkeypatch.setattr(worker.shutil, "rmtree", lambda *a, **k: None)   # as when root owns the files
    fresh = worker._fresh_scratch(worker_dir)
    assert fresh == worker_dir / "sandbox" and list(fresh.iterdir()) == []
    stale = [p for p in worker_dir.iterdir() if p.name.startswith(".sandbox.stale-")]
    assert len(stale) == 1 and (stale[0] / "result.py").read_text() == "stale"


# ── leak audit ────────────────────────────────────────────────────────────────

def test_leak_audit_ignores_prose_but_catches_column_access(tmp_path):
    from app.services.agent.discovery.worker import outcome_references

    clean = tmp_path / "clean.py"
    clean.write_text(
        '"""Features for the slope study; never reads slope or age."""\n'
        "# the outcome (slope) is not touched here\n"
        "def f(x):\n"
        "    '''age-independent.'''\n"
        "    return x  # not slope\n"
    )
    assert outcome_references(tmp_path, [clean], ["slope", "age"]) == []
    for code in ('v = df["slope"]\n', "v = df['AGE']\n", "v = df.slope\n", "slope = 1\n"):
        dirty = tmp_path / "dirty.py"
        dirty.write_text(code)
        assert outcome_references(tmp_path, [dirty], ["slope", "age"]), code
    (tmp_path / "turn_01.command.sh").write_text("ls /data  # look for slope\n")
    assert outcome_references(tmp_path, [], ["slope"]) == []
    (tmp_path / "turn_02.command.sh").write_text("grep slope /data/x.csv\n")
    assert outcome_references(tmp_path, [], ["slope"]) == ["turn_02.command.sh:1: grep slope /data/x.csv"]


def test_leak_audit_flags_a_linked_script(tmp_path):
    from app.services.agent.discovery.worker import outcome_references

    (tmp_path / "real.txt").write_text("x = 1\n")
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    (scratch / "helper.py").symlink_to(tmp_path / "real.txt")
    hits = outcome_references(tmp_path, [scratch / "helper.py"], ["slope"])
    assert hits and "not auditable" in hits[0]


# ── cancel interrupts an in-flight LLM call ───────────────────────────────────

def _slow_reply(payload, timeout=0):
    time.sleep(30)
    raise AssertionError("not reached")


def test_cancel_returns_while_the_worker_waits_on_the_model(tmp_path, monkeypatch):
    from app.services.agent.discovery import worker

    monkeypatch.setattr(worker, "SandboxSession", _HostileSandbox)
    monkeypatch.setattr(worker, "responses_create", _slow_reply)
    cancel = threading.Event()
    threading.Timer(0.3, cancel.set).start()
    start = time.monotonic()
    with pytest.raises(RuntimeError, match="cancelled"):
        _run(worker, tmp_path, _cohort(tmp_path), cancel_event=cancel)
    assert time.monotonic() - start < 5


def test_cancel_returns_while_the_scout_waits_on_the_model(tmp_path, monkeypatch):
    from app.services.agent.discovery import scout
    from app.services.agent.discovery.problem import parse_problem

    monkeypatch.setattr(scout, "SandboxSession", _HostileSandbox)
    monkeypatch.setattr(scout, "responses_create", _slow_reply)
    cancel = threading.Event()
    threading.Timer(0.3, cancel.set).start()
    start = time.monotonic()
    with pytest.raises(RuntimeError, match="cancelled"):
        scout.run_scout(spec=parse_problem(PROBLEM), data_dir=_cohort(tmp_path), shared_dir=tmp_path / "shared",
                        run_root=tmp_path / "run", model="m", cancel_event=cancel)
    assert time.monotonic() - start < 5


def test_scout_ignores_a_linked_guide(tmp_path, monkeypatch):
    from app.services.agent.discovery import scout
    from app.services.agent.discovery.problem import parse_problem

    secret = tmp_path / "secret.md"
    secret.write_text("host secret")

    class LinkingSandbox(_HostileSandbox):
        def exec(self, command, timeout_sec=None):
            (self.scratch / "dataset_guide.md").symlink_to(secret)
            return {"exit_code": 0, "stdout": "", "stderr": ""}

    replies = iter([
        {"id": "r1", "output": [{"type": "custom_tool_call", "name": "shell_exec", "call_id": "c1", "input": "x"}]},
        {"id": "r2", "output": [{"type": "message", "content": [{"type": "output_text", "text": "DONE"}]}]},
    ])
    shared = tmp_path / "shared"
    shared.mkdir()
    monkeypatch.setattr(scout, "SandboxSession", LinkingSandbox)
    monkeypatch.setattr(scout, "responses_create", lambda payload, timeout=0: next(replies))
    result = scout.run_scout(spec=parse_problem(PROBLEM), data_dir=_cohort(tmp_path), shared_dir=shared,
                             run_root=tmp_path / "run", model="m")
    assert result["status"] == "no_guide" and not (shared / "dataset_guide.md").exists()


# ── container lifecycle ───────────────────────────────────────────────────────

def test_docker_run_timeout_removes_the_named_container(tmp_path, monkeypatch):
    box = SandboxSession(tmp_path / "scratch", data_dir=tmp_path)
    removed = []
    monkeypatch.setattr(box, "_ensure_docker_image", lambda: None)

    def slow_run(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))

    monkeypatch.setattr(sandbox.subprocess, "run", slow_run)
    monkeypatch.setattr(sandbox, "_remove_containers", removed.extend)
    with pytest.raises(RuntimeError, match="did not start"):
        box._start_docker()
    assert removed == [box.container_name] and not box.started


def test_startup_sweep_treats_a_reused_pid_as_dead(monkeypatch):
    reused, live = 4242, 4343
    listing = "\n".join([f"tl-reused\t{reused}\t1000.000", f"tl-live\t{live}\t2000.000",
                         f"tl-old-mine\t{os.getpid()}\t1.000"])
    removed = []

    class Proc:
        def __init__(self, pid=None):
            self.pid = pid

        def create_time(self):
            return {reused: 5000.0, live: 2000.2}.get(self.pid, 9999.0)

    def fake_run(cmd, **kwargs):
        if cmd[:2] == ["docker", "ps"]:
            return subprocess.CompletedProcess(cmd, 0, stdout=listing, stderr="")
        removed.extend(cmd[3:])
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(sandbox.shutil, "which", lambda name: "/usr/bin/docker")
    monkeypatch.setattr(sandbox.subprocess, "run", fake_run)
    monkeypatch.setattr(sandbox.psutil, "pid_exists", lambda pid: True)
    monkeypatch.setattr(sandbox.psutil, "Process", Proc)
    assert sandbox.remove_owned_containers(current_process=False) == 2
    assert sorted(removed) == ["tl-old-mine", "tl-reused"]
