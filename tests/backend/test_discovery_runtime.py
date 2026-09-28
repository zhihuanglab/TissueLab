"""Discovery loop internals that the Open port changed or fixed.

No Docker, no LLM: the sandbox and the model are stubbed. Covers the result.py
replay (sandboxed, persisted, cached), the loop's cancel / off-event-loop
behaviour, sandbox lifecycle helpers, and the LLM client limits.
"""
import asyncio
import json
import subprocess
import sys
import threading

import pandas as pd
import pytest

from conftest import SERVICE_DIR


class FakeSandbox:
    """Stands in for the Docker sandbox; exec writes what the replay helper would."""

    instances = []
    table = "donor_id,f\nd1,1.0\n"
    metadata = "{}"

    def __init__(self, scratch_dir, *, data_dir, shared_dir, command_timeout_sec):
        self.scratch = scratch_dir
        self.command = None
        self.cancel_event = None
        self.started = self.stopped = False
        FakeSandbox.instances.append(self)

    def watch_cancel(self, cancel_event):
        self.cancel_event = cancel_event
        return lambda: None

    def start(self):
        self.started = True

    def exec(self, command, timeout_sec=None):
        self.command = command
        (self.scratch / "donor_feature_table.csv").write_text(FakeSandbox.table)
        (self.scratch / "__materialized_interface_metadata.json").write_text(FakeSandbox.metadata)
        return {"exit_code": 0, "stdout": "", "stderr": ""}

    def stop(self):
        self.stopped = True


@pytest.fixture
def fake_sandbox(monkeypatch):
    import app.services.agent.discovery.deterministic_evaluator as evaluator

    FakeSandbox.instances = []
    FakeSandbox.table = "donor_id,f\nd1,1.0\n"
    FakeSandbox.metadata = "{}"
    monkeypatch.setattr(evaluator, "SandboxSession", FakeSandbox)
    return FakeSandbox


def _write_worker(tmp_path, body="def compute_donor_score(*a, **k):\n    return 1.0\n"):
    worker_dir = tmp_path / "round_0001" / "round_0001_worker"
    worker_dir.mkdir(parents=True)
    (worker_dir / "result.py").write_text(body)
    return worker_dir


# ── service process / shared library ────────────────────────────────────────

def test_service_process_does_not_load_sandbox_only_packages():
    # scikit-learn lives only in the worker image; importing the loop and the
    # routes must not pull it into the service.
    code = (
        "import sys, app.api.discovery, app.services.agent.discovery.deterministic_evaluator; "
        "print('sklearn' in sys.modules)"
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=SERVICE_DIR, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip().splitlines()[-1] == "False"


def test_shared_analysis_exports_resolve_lazily():
    from app.services.agent.discovery.shared_lib_source import shared_analysis

    assert "partial_correlation" in shared_analysis.__all__
    assert callable(shared_analysis.partial_correlation)
    assert shared_analysis.stats.partial_correlation is shared_analysis.partial_correlation
    with pytest.raises(AttributeError):
        shared_analysis.not_an_export  # noqa: B018


def test_copy_tree_skips_bytecode(tmp_path):
    from app.services.agent.discovery.shared_runtime import copy_tree

    src = tmp_path / "src"
    (src / "__pycache__").mkdir(parents=True)
    (src / "mod.py").write_text("x = 1\n")
    (src / "__pycache__" / "mod.cpython-311.pyc").write_bytes(b"\0")
    copy_tree(src, tmp_path / "dst")
    assert [p.name for p in (tmp_path / "dst").rglob("*")] == ["mod.py"]


# ── result.py replay ────────────────────────────────────────────────────────

def test_result_script_replay_runs_in_the_sandbox(tmp_path, fake_sandbox):
    import app.services.agent.discovery.deterministic_evaluator as evaluator

    worker_dir = _write_worker(tmp_path)
    scratch, shared = tmp_path / "scratch", tmp_path / "shared"
    scratch.mkdir()
    shared.mkdir()
    cancel = threading.Event()

    table, _, issues = evaluator.materialize_donor_table_via_script_interface(
        script_path=worker_dir / "result.py",
        data_dir=tmp_path,
        shared_dir=shared,
        scratch_dir=scratch,
        timeout_sec=30,
        cancel_event=cancel,
    )

    assert issues == []
    assert table == scratch / "donor_feature_table.csv"
    box = fake_sandbox.instances[0]
    assert box.started and box.stopped
    assert box.cancel_event is cancel
    assert box.command.startswith(
        "/usr/local/bin/python3 -B /scratch/__materialize_donor_table.py /scratch/result.py /data /shared /scratch"
    )
    assert sys.executable not in box.command
    assert (scratch / "result.py").exists()


def test_replayed_table_outlives_the_evaluation_and_is_reused(tmp_path, fake_sandbox):
    import app.services.agent.discovery.deterministic_evaluator as evaluator

    worker_dir = _write_worker(tmp_path)
    kwargs = dict(worker_dir=worker_dir, script_path=worker_dir / "result.py", data_dir=tmp_path, cancel_event=None)

    table, _, issues = evaluator._replay_donor_table(**kwargs)
    assert issues == [] and table.exists()
    assert table.is_relative_to(worker_dir / "replay")

    again, _, _ = evaluator._replay_donor_table(**kwargs)
    assert again == table
    assert len(fake_sandbox.instances) == 1  # second evaluation reused the replay

    (worker_dir / "result.py").write_text("def compute_donor_score(*a, **k):\n    return 2.0\n")
    evaluator._replay_donor_table(**kwargs)
    assert len(fake_sandbox.instances) == 2  # a changed script replays again


def test_cancelled_replay_is_not_recorded(tmp_path, fake_sandbox):
    # A replay killed by cancel/shutdown says nothing about the script; a
    # recorded failure would drop that candidate for good on resume.
    import app.services.agent.discovery.deterministic_evaluator as evaluator

    worker_dir = _write_worker(tmp_path)
    cancelled = threading.Event()
    cancelled.set()
    evaluator._replay_donor_table(
        worker_dir=worker_dir, script_path=worker_dir / "result.py", data_dir=tmp_path, cancel_event=cancelled,
    )
    assert not (worker_dir / "replay" / evaluator.REPLAY_RECORD_NAME).exists()


def test_replay_only_candidate_gets_a_panel_score(tmp_path, fake_sandbox):
    # Regression: the replayed table used to live in a TemporaryDirectory that
    # was gone by the time the panel score read it, so every worker relying on
    # replay was discarded with no panel score.
    import app.services.agent.discovery.deterministic_evaluator as evaluator

    n = 32
    donors = [f"d{i}" for i in range(n)]
    outcome = [0.3 * i + (0.5 if i % 3 == 0 else -0.2) for i in range(n)]
    pd.DataFrame({
        "donor_id": donors,
        "slide_name": [f"{d}.svs.zarr" for d in donors],
        "slope_zmem0": outcome,
        "max_age_vis": [70 + (i % 9) for i in range(n)],
        "braak_numeric": [i % 6 for i in range(n)],
        "cerad_ordinal": [i % 4 for i in range(n)],
        "sex": ["male" if i % 2 else "female" for i in range(n)],
    }).to_csv(tmp_path / "training_cohort.csv", index=False)

    feature = [v + (0.4 if i % 2 else -0.4) for i, v in enumerate(outcome)]
    FakeSandbox.table = pd.DataFrame({
        "donor_id": donors,
        "slide_name": [f"{d}.svs.zarr" for d in donors],
        "cand": feature,
    }).to_csv(index=False)
    FakeSandbox.metadata = json.dumps({"feature_name": "cand", "feature_column": "cand"})

    worker_dir = _write_worker(tmp_path)
    evaluation = evaluator.evaluate_worker_artifacts(
        worker_name="round_0001_worker",
        worker_dir=worker_dir,
        data_dir=tmp_path,
        results_path=None,
        primary_outcome="slope_zmem0",
        panel_state={"members": []},
    )

    results = evaluation["results"]
    table_path = results["artifacts"]["donor_feature_table"]
    assert table_path.startswith(str(worker_dir / "replay"))
    assert results.get("panel_candidate_score") is not None, evaluation.get("summary")


# ── sandbox lifecycle ───────────────────────────────────────────────────────

def test_watch_cancel_kills_the_container_until_stopped(tmp_path, monkeypatch):
    from app.services.agent.discovery.sandbox import SandboxSession

    box = SandboxSession(tmp_path / "scratch", data_dir=tmp_path)
    killed = threading.Event()
    monkeypatch.setattr(box, "kill", killed.set)

    cancel = threading.Event()
    stop_watch = box.watch_cancel(cancel)
    cancel.set()
    assert killed.wait(3)
    stop_watch()

    killed.clear()
    later = threading.Event()
    stop_later = box.watch_cancel(later)
    stop_later()  # the command finished first
    later.set()
    assert not killed.wait(1)


def test_owned_container_cleanup_respects_live_owners(monkeypatch):
    import os

    from app.services.agent.discovery import sandbox

    live_other = 424242
    listing = "\n".join([
        f"tl-autoresearch-mine\t{os.getpid()}",
        "tl-autoresearch-orphan\t999999",
        f"tl-autoresearch-other\t{live_other}",
    ])
    removed = []

    def fake_run(cmd, **kwargs):
        if cmd[:2] == ["docker", "ps"]:
            return subprocess.CompletedProcess(cmd, 0, stdout=listing, stderr="")
        if cmd[:3] == ["docker", "rm", "-f"]:
            removed.append(sorted(cmd[3:]))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(sandbox.shutil, "which", lambda name: "/usr/bin/docker")
    monkeypatch.setattr(sandbox.subprocess, "run", fake_run)
    monkeypatch.setattr(sandbox.psutil, "pid_exists", lambda pid: pid == live_other)

    assert sandbox.remove_owned_containers(current_process=True) == 1
    assert sandbox.remove_owned_containers(current_process=False) == 1
    assert removed == [["tl-autoresearch-mine"], ["tl-autoresearch-orphan"]]


def test_docker_preflight_reasons(monkeypatch):
    from app.services.agent.discovery import sandbox

    monkeypatch.setattr(sandbox.shutil, "which", lambda name: None)
    assert "docker CLI was not found" in sandbox.docker_unavailable_reason()

    monkeypatch.setattr(sandbox.shutil, "which", lambda name: "/usr/bin/docker")
    monkeypatch.setattr(
        sandbox.subprocess, "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, stdout="", stderr="Cannot connect to the Docker daemon"),
    )
    assert sandbox.docker_unavailable_reason() == "Docker is not running: Cannot connect to the Docker daemon"

    monkeypatch.setattr(
        sandbox.subprocess, "run", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, stdout="29.0", stderr=""),
    )
    assert sandbox.docker_unavailable_reason() is None


def test_request_shutdown_signals_threads_and_cancels_tasks():
    from app.services.agent.discovery.run_manager import DiscoveryRunManager

    async def scenario():
        manager = DiscoveryRunManager(store=None)
        manager._tasks["run_a"] = asyncio.create_task(asyncio.sleep(30))
        stopping = manager.request_shutdown()
        await asyncio.wait(stopping, timeout=2)
        return manager, stopping

    manager, stopping = asyncio.run(scenario())
    assert manager._cancel_event("run_a").is_set()
    assert all(task.cancelled() for task in stopping)


# ── the loop ────────────────────────────────────────────────────────────────

def test_loop_runs_blocking_stages_off_the_event_loop_and_writes_findings(tmp_path, monkeypatch):
    import app.services.agent.discovery.simple_loop as loop

    threads = {}
    cancel = threading.Event()

    def record(stage):
        threads[stage] = threading.get_ident()

    def fake_worker(**kwargs):
        record("worker")
        assert kwargs["cancel_event"] is cancel
        return {"worker_name": kwargs["worker_brief"]["worker_name"], "worker_dir": str(tmp_path / "w"),
                "results_path": "", "summary": "ok"}

    def fake_evaluate(**kwargs):
        record("evaluate")
        assert kwargs["cancel_event"] is cancel
        return {"results": {"feature_name": "cand", "panel_candidate_score": 0.5,
                            "panel_baseline_score": 0.1, "delta_panel_score": 0.4}, "summary": "scored"}

    monkeypatch.setattr(loop, "ensure_shared_runtime", lambda **kw: record("shared_runtime") or {})
    monkeypatch.setattr(loop, "_propose_candidate", lambda **kw: {"candidate_id": "cand", "scientific_question": "q"})
    monkeypatch.setattr(loop, "run_worker", fake_worker)
    monkeypatch.setattr(loop, "evaluate_worker_artifacts", fake_evaluate)

    events = []

    async def emit(event):
        events.append(event["type"])

    async def scenario():
        threads["loop"] = threading.get_ident()
        return await loop.run_autoresearch(
            program_text="p", data_dir=tmp_path, run_root=tmp_path / "run", emit=emit,
            rounds=1, dataset_scout_enabled=False, cancel_event=cancel,
        )

    result = asyncio.run(scenario())

    for stage in ("shared_runtime", "worker", "evaluate"):
        assert threads[stage] != threads["loop"], f"{stage} ran on the event loop"
    assert events[-3:] == ["worker_completed", "round_summary", "round_completed"]
    assert result["accepted_panel"]["members"][0]["feature_name"] == "cand"
    findings = (tmp_path / "run" / "research_findings.md").read_text()
    assert findings == result["answer"]
    assert "- cand (round 1" in findings


# ── LLM client ──────────────────────────────────────────────────────────────

def test_responses_api_is_required(monkeypatch):
    from app.services.agent.discovery import client as discovery_client

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:11434/v1")
    monkeypatch.delenv("LLM_API", raising=False)
    assert "Responses API" in discovery_client.unavailable_reason()

    monkeypatch.delenv("OPENAI_BASE_URL")
    assert discovery_client.unavailable_reason() is None


def test_responses_calls_carry_the_callers_timeout(monkeypatch):
    from app.services.agent.discovery import client as discovery_client

    seen = {}

    class FakeResponses:
        def create(self, **payload):
            seen["payload"] = payload
            return {"id": "resp_1", "output": []}

    class FakeClient:
        responses = FakeResponses()

        def with_options(self, **options):
            seen["options"] = options
            return self

    monkeypatch.setattr(discovery_client, "get_client", lambda: FakeClient())
    discovery_client.responses_create({"model": "m", "input": "hi"}, timeout=42)
    assert seen["options"] == {"timeout": 42, "max_retries": 1}
    assert seen["payload"] == {"model": "m", "input": "hi"}
