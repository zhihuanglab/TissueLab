"""Discovery runtime: the worker's controller, the round loop, cancellation,
sandbox lifecycle helpers, and the LLM client limits.

No Docker, no LLM: the sandbox and the model are stubbed.
"""
import asyncio
import json
import subprocess
import threading
from pathlib import Path

import pandas as pd
import pytest

PROBLEM = """---
outcome: slope
covariates: [age]
---
Which measurements track the slope?
"""


def _spec():
    from app.services.agent.discovery.problem import parse_problem

    return parse_problem(PROBLEM)


def _workspace(tmp_path: Path) -> Path:
    data = tmp_path / "data"
    data.mkdir()
    pd.DataFrame({"donor_id": ["d1", "d2", "d3"], "slide_name": ["a.zarr", "b.zarr", "c.zarr"],
                  "slope": [0.1, 0.2, 0.3], "age": [70, 71, 72]}).to_csv(data / "training_cohort.csv", index=False)
    return data


# ── the worker's controller ───────────────────────────────────────────────────

class ScriptedSandbox:
    """The worker writes result.py via a shell command; materialization writes the donor table."""

    result_py = "def compute_donor_features(donor_id, data_root):\n    return {'a': 1.0, 'b': 2.0}\n"
    table = "donor_id,a,b\nd1,1.0,2.0\nd2,1.5,2.5\nd3,2.0,3.0\n"
    instances: list = []

    def __init__(self, scratch_dir, *, data_dir, shared_dir, command_timeout_sec, file_overlays):
        self.scratch = Path(scratch_dir)
        self.file_overlays = file_overlays
        self.stopped = False
        ScriptedSandbox.instances.append(self)

    def start(self):
        pass

    def watch_cancel(self, cancel_event):
        return lambda: None

    def stop(self):
        self.stopped = True

    def exec(self, command, timeout_sec=None):
        if ".tl_materialize.py" in command:
            (self.scratch / "donor_feature_table.csv").write_text(self.table)
            (self.scratch / "materialize_report.json").write_text(json.dumps(
                {"status": "ok", "errors": {}, "rows": 3, "coverage": {"a": 1.0, "b": 1.0}, "n_errors": 0}))
        else:
            (self.scratch / "result.py").write_text(self.result_py)
        return {"exit_code": 0, "stdout": "", "stderr": ""}


def _worker_responses():
    tool = {"id": "r1", "output": [{"type": "custom_tool_call", "name": "shell_exec", "call_id": "c1",
                                    "input": "cat > /scratch/result.py <<EOF ... EOF && python result.py"}]}
    done = {"id": "r2", "output": [{"type": "message", "content": [{"type": "output_text", "text": "DONE"}]}]}
    return iter([tool, done])


@pytest.fixture
def scripted_worker(monkeypatch):
    from app.services.agent.discovery import worker

    ScriptedSandbox.instances = []
    ScriptedSandbox.result_py = "def compute_donor_features(donor_id, data_root):\n    return {'a': 1.0, 'b': 2.0}\n"
    responses = _worker_responses()
    monkeypatch.setattr(worker, "SandboxSession", ScriptedSandbox)
    monkeypatch.setattr(worker, "responses_create", lambda payload, timeout=0: next(responses))
    return worker


def _run_worker(worker, tmp_path, data):
    return worker.run_worker(
        worker_brief={"worker_name": "round_0001_worker", "candidate_id": "cand", "baseline_variation": "a",
                      "variations": [{"name": "a"}, {"name": "b"}]},
        round_dir=tmp_path / "run" / "round_0001", spec=_spec(), data_dir=data,
        shared_dir=tmp_path / "run" / "shared", model="m",
    )


def test_worker_controller_materializes_and_passes_a_clean_script(scripted_worker, tmp_path):
    data = _workspace(tmp_path)
    result = _run_worker(scripted_worker, tmp_path, data)
    assert result["controller_checks"]["primary_coverage"] == 1.0
    assert result["results"]["feature_column"] == "a" and result["results"]["outcome"] == "slope"
    box = ScriptedSandbox.instances[0]
    assert box.stopped
    # the sandbox's cohort file carries identifiers only
    public = Path(box.file_overlays["/data/training_cohort.csv"]).read_text()
    assert public.splitlines()[0] == "donor_id,slide_name"
    assert json.loads(Path(result["results_path"]).read_text())["status"] == "ok"


def test_worker_controller_rejects_outcome_contact(scripted_worker, tmp_path):
    ScriptedSandbox.result_py = "def compute_donor_features(d, r):\n    return {'a': df['slope'], 'b': 1}\n"
    data = _workspace(tmp_path)
    with pytest.raises(scripted_worker.ControllerChecksFailed, match="OUTCOME_REFERENCE"):
        _run_worker(scripted_worker, tmp_path, data)
    assert ScriptedSandbox.instances[0].stopped


# ── the loop ──────────────────────────────────────────────────────────────────

def test_loop_runs_stages_off_the_event_loop_and_writes_findings(tmp_path, monkeypatch):
    import app.services.agent.discovery.loop as loop

    data = _workspace(tmp_path)
    threads, events = {}, []
    cancel = threading.Event()
    proposals = iter([RuntimeError("model unavailable"), {"candidate_id": "cand", "scientific_question": "q",
                                                          "variations": [{"name": "a"}], "baseline_variation": "a"}])

    def fake_proposer(**kwargs):
        threads["proposer"] = threading.get_ident()
        assert loop.run_folder_busy(tmp_path / "run")   # counted while the thread runs
        assert kwargs["cancel_event"] is cancel and kwargs["dataset_guide_text"] == "guide"
        item = next(proposals)
        if isinstance(item, Exception):
            raise item
        return item

    def fake_worker(**kwargs):
        threads["worker"] = threading.get_ident()
        assert kwargs["cancel_event"] is cancel and kwargs["spec"].outcome == "slope"
        return {"worker_name": kwargs["worker_brief"]["worker_name"], "worker_dir": str(tmp_path / "w"),
                "results_path": "", "summary": "ok", "results": {"feature_name": "cand", "feature_column": "a"}}

    def fake_judge(**kwargs):
        threads["judge"] = threading.get_ident()
        results = {"feature_name": "cand", "feature_column": "a", "panel_candidate_rmse": 0.05,
                   "mean_rmse_improvement": 0.004}
        return {"decision": "keep", "reason": "predictive_cv_improved", "keep": True, "chosen_variation": "a",
                "chosen_review": {"action": "add", "slot": None, "evaluation": {"results": results}},
                "accepted_panel_rmse": 0.05, "variation_summaries": []}

    def fake_scout(**kwargs):
        threads["scout"] = threading.get_ident()
        # state is written first: a cancel while scouting leaves a resumable run
        assert (tmp_path / "run" / "run_state.json").exists()
        (Path(kwargs["shared_dir"]) / "dataset_guide.md").write_text("guide")
        return {"status": "completed", "turns": 3}

    monkeypatch.setattr(loop, "run_scout", fake_scout)
    monkeypatch.setattr(loop, "run_proposer", fake_proposer)
    monkeypatch.setattr(loop, "run_worker", fake_worker)
    monkeypatch.setattr(loop, "review_candidate", fake_judge)

    async def emit(event):
        events.append(event["type"])

    async def scenario():
        threads["loop"] = threading.get_ident()
        return await loop.run_discovery(
            spec=_spec(), data_dir=data, run_root=tmp_path / "run", emit=emit, rounds=2, model="m",
            cancel_event=cancel,
        )

    result = asyncio.run(scenario())
    assert not loop.run_folder_busy(tmp_path / "run")

    for stage in ("scout", "proposer", "worker", "judge"):
        assert threads[stage] != threads["loop"], f"{stage} ran on the event loop"
    # round 1: the proposer failed and cost only that round
    assert events.count("proposer_failed") == 1 and events.count("round_completed") == 2
    assert events.index("scout_started") < events.index("scout_done") < events.index("round_started")
    assert json.loads((tmp_path / "run" / "run_state.json").read_text())["config"]["dataset_scout"] is True
    assert "judging" in events
    rows = pd.read_csv(tmp_path / "run" / "results.tsv", sep="\t")
    assert rows["status"].tolist() == ["proposer_failed", "completed"]
    assert rows["decision"].tolist() == ["discard", "keep"]
    assert result["accepted_panel"]["members"][0]["feature_column"] == "a"
    findings = (tmp_path / "run" / "research_findings.md").read_text()
    assert findings == result["answer"] and "Outcome: slope" in findings and "- cand [a]" in findings
    # the sandbox's loaders and the outcome-free layout are in place
    shared = tmp_path / "run" / "shared"
    assert (shared / "lib" / "shared_analysis" / "slides.py").exists()
    assert json.loads((shared / "dataset.json").read_text())["cohort_file"] == "training_cohort.csv"
    assert "slope" not in (shared / "dataset.json").read_text()


def test_several_workers_run_side_by_side_and_only_the_best_is_admitted(tmp_path, monkeypatch):
    import time

    import app.services.agent.discovery.loop as loop

    data = _workspace(tmp_path)
    active, peak, lock = [0], [0], threading.Lock()

    def fake_proposer(**kwargs):
        # each plan is asked for knowing the ones before it
        assert len(kwargs["proposed_this_round"]) == kwargs["slot"] - 1
        return {"candidate_id": f"cand{kwargs['slot']}", "scientific_question": f"q{kwargs['slot']}",
                "variations": [{"name": "a"}], "baseline_variation": "a"}

    def fake_worker(**kwargs):
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        time.sleep(0.3)
        with lock:
            active[0] -= 1
        name = kwargs["worker_brief"]["worker_name"]
        return {"worker_name": name, "worker_dir": str(tmp_path / name), "results_path": "", "summary": "ok",
                "results": {"feature_name": kwargs["worker_brief"]["candidate_id"], "feature_column": "a"}}

    def fake_judge(**kwargs):
        slot = int(kwargs["worker_brief"]["worker_name"].rsplit("_", 1)[1])
        rmse = {1: 0.06, 2: 0.04}.get(slot)   # 1 and 2 both qualify, 2 is better; 3 does not
        results = {"feature_name": f"cand{slot}", "feature_column": "a", "panel_candidate_rmse": rmse}
        return {"decision": "keep" if rmse else "discard", "reason": "predictive_cv_improved" if rmse else "no_improvement",
                "keep": bool(rmse), "chosen_variation": "a", "accepted_panel_rmse": rmse, "variation_summaries": [],
                "chosen_review": {"action": "add", "slot": None, "evaluation": {"results": results}}}

    monkeypatch.setattr(loop, "run_proposer", fake_proposer)
    monkeypatch.setattr(loop, "run_worker", fake_worker)
    monkeypatch.setattr(loop, "review_candidate", fake_judge)

    async def emit(event):
        pass

    result = asyncio.run(loop.run_discovery(spec=_spec(), data_dir=data, run_root=tmp_path / "run", emit=emit,
                                            rounds=1, model="m", dataset_scout=False, workers_per_round=3))
    assert peak[0] == 3   # side by side, not one after another
    assert [m["feature_name"] for m in result["accepted_panel"]["members"]] == ["cand2"]
    rows = pd.read_csv(tmp_path / "run" / "results.tsv", sep="\t")
    assert rows["worker"].tolist() == [1, 2, 3] and rows["decision"].tolist() == ["discard", "keep", "discard"]
    round_dir = tmp_path / "run" / "round_0001"
    assert json.loads((round_dir / "round_feedback_1.json").read_text())["reason"] == "another_worker_better"
    assert all((round_dir / f"plan_{k}.json").exists() for k in (1, 2, 3))
    assert json.loads((tmp_path / "run" / "run_state.json").read_text())["config"]["workers_per_round"] == 3
    # the proposer's history shows all three candidates
    assert all(f"candidate=cand{k}" in loop.load_feedback_history(tmp_path / "run") for k in (1, 2, 3))


def test_a_judge_failure_is_reported_not_swallowed(tmp_path, monkeypatch):
    import app.services.agent.discovery.loop as loop

    data = _workspace(tmp_path)
    monkeypatch.setattr(loop, "run_proposer", lambda **kw: {"candidate_id": "cand", "variations": [{"name": "a"}],
                                                          "baseline_variation": "a"})
    monkeypatch.setattr(loop, "run_worker", lambda **kw: {"worker_name": "w", "worker_dir": str(tmp_path / "w"),
                                                        "results_path": "", "summary": "ok", "results": {}})

    def broken_judge(**kwargs):
        raise ValueError("Covariate contains missing or non-numeric values: age")

    monkeypatch.setattr(loop, "review_candidate", broken_judge)

    async def emit(event):
        pass

    asyncio.run(loop.run_discovery(spec=_spec(), data_dir=data, run_root=tmp_path / "run", emit=emit, rounds=1,
                                   model="m", dataset_scout=False))
    row = pd.read_csv(tmp_path / "run" / "results.tsv", sep="\t").iloc[0]
    assert row["decision"] == "discard" and "judge failed: ValueError: Covariate" in row["error"]
    feedback = json.loads((tmp_path / "run" / "round_0001" / "round_feedback.json").read_text())
    assert "judge failed" in loop.render_feedback_text(feedback)   # the next proposer sees why


# ── the dataset scout ─────────────────────────────────────────────────────────

class ScoutSandbox(ScriptedSandbox):
    """The scout's commands; the one naming the guide writes it."""

    def exec(self, command, timeout_sec=None):
        self.commands = getattr(self, "commands", []) + [command]
        if "dataset_guide.md" in command:
            (self.scratch / "dataset_guide.md").write_text("# Guide\n" + "x" * 20000)
        return {"exit_code": 0, "stdout": "ok", "stderr": ""}


def _message(text, rid):
    return {"id": rid, "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}]}


def _shell(command, rid):
    return {"id": rid, "output": [{"type": "custom_tool_call", "name": "shell_exec", "call_id": rid, "input": command}]}


def test_scout_writes_the_guide_into_shared_from_an_outcome_blind_sandbox(tmp_path, monkeypatch):
    from app.services.agent.discovery import scout

    data = _workspace(tmp_path)
    shared = tmp_path / "run" / "shared"
    shared.mkdir(parents=True)
    ScriptedSandbox.instances = []
    replies = iter([_shell("ls /data", "r1"), _shell("cat > /scratch/dataset_guide.md <<'EOF' ... EOF", "r2"),
                    _message("DONE", "r3")])
    requests, events = [], []
    monkeypatch.setattr(scout, "SandboxSession", ScoutSandbox)
    monkeypatch.setattr(scout, "responses_create", lambda payload, timeout=0: requests.append(payload) or next(replies))

    result = scout.run_scout(spec=_spec(), data_dir=data, shared_dir=shared, run_root=tmp_path / "run",
                             model="m", on_event=events.append)
    assert result == {"status": "completed", "turns": 2}
    guide = (shared / "dataset_guide.md").read_text()
    assert guide.startswith("# Guide") and len(guide) == scout.GUIDE_MAX_CHARS
    box = ScriptedSandbox.instances[0]
    assert box.stopped and box.commands[0] == "ls /data"
    # the cohort it sees has no outcome / covariate columns
    public = pd.read_csv(box.file_overlays["/data/training_cohort.csv"])
    assert list(public.columns) == ["donor_id", "slide_name"]
    assert "Which measurements track the slope?" in requests[0]["instructions"]
    assert [e["type"] for e in events] == ["scout_tool_call", "scout_tool_result"] * 2


def test_scout_without_a_guide_reports_it(tmp_path, monkeypatch):
    from app.services.agent.discovery import scout

    data = _workspace(tmp_path)
    shared = tmp_path / "run" / "shared"
    shared.mkdir(parents=True)
    replies = iter([_message("DONE", f"r{i}") for i in range(3)])
    monkeypatch.setattr(scout, "SandboxSession", ScoutSandbox)
    monkeypatch.setattr(scout, "responses_create", lambda payload, timeout=0: next(replies))
    result = scout.run_scout(spec=_spec(), data_dir=data, shared_dir=shared, run_root=tmp_path / "run", model="m")
    assert result["status"] == "no_guide" and not (shared / "dataset_guide.md").exists()


# ── sandbox lifecycle ─────────────────────────────────────────────────────────

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
        f"tl-discovery-mine\t{os.getpid()}",
        "tl-discovery-orphan\t999999",
        f"tl-discovery-other\t{live_other}",
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
    assert removed == [["tl-discovery-mine"], ["tl-discovery-orphan"]]


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
        manager = DiscoveryRunManager()
        manager._tasks["run_a"] = asyncio.create_task(asyncio.sleep(30))
        manager._cancel_events["run_a"] = threading.Event()
        stopping = manager.request_shutdown()
        await asyncio.wait(stopping, timeout=2)
        return manager, stopping

    manager, stopping = asyncio.run(scenario())
    assert manager._cancel_events["run_a"].is_set()
    assert all(task.cancelled() for task in stopping)


# ── LLM client ────────────────────────────────────────────────────────────────

def test_responses_api_is_required(monkeypatch):
    from app.services.agent.discovery import client as discovery_client

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:11434/v1")
    monkeypatch.delenv("LLM_API", raising=False)
    assert "Responses API" in discovery_client.unavailable_reason()

    monkeypatch.delenv("OPENAI_BASE_URL")
    assert discovery_client.unavailable_reason() is None


def test_a_dedicated_discovery_endpoint_frees_the_agent_model(monkeypatch):
    # The chat agent on a self-hosted Chat Completions server, discovery on its own Responses endpoint.
    from app.services.agent.discovery import client as discovery_client

    monkeypatch.setenv("OPENAI_API_KEY", "local-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:11434/v1")
    monkeypatch.delenv("LLM_API", raising=False)
    assert "DISCOVERY_BASE_URL" in discovery_client.unavailable_reason()

    monkeypatch.setenv("DISCOVERY_BASE_URL", "https://api.openai.com/v1")
    monkeypatch.setenv("DISCOVERY_API_KEY", "sk-discovery")
    assert discovery_client.unavailable_reason() is None
    client = discovery_client.get_client()
    assert str(client.base_url).rstrip("/") == "https://api.openai.com/v1" and client.api_key == "sk-discovery"
