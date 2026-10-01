"""Regression tests for discovery sandbox / judge fixes (no Docker needed)."""
import os
import shutil
import subprocess
import sys
import tempfile
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
    assert mounted == [f"{data.resolve()}:/data:ro", f"{external.resolve()}:/data/slides:ro"]


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
