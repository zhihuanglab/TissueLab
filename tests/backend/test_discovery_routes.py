"""Discovery routes: problem.md, the on-disk run listing, and the run lifecycle
(start / stream / cancel / resume). The loop itself is stubbed; its internals
are covered by test_discovery_loop.py and test_discovery_runtime.py.
"""
import json
import threading
import time

import pytest

API = "/api/agent/v1/discovery"
PROBLEM = """---
outcome: slope
covariates: [age]
---
Which tissue measurements track the slope?
"""


@pytest.fixture
def workspace(user_root):
    ws = user_root / f"discovery_ws_{time.time_ns()}"
    ws.mkdir()
    (ws / "training_cohort.csv").write_text(
        "donor_id,slide_name,slope,age\nd1,d1.zarr,-0.1,80\nd2,d2.zarr,0.2,75\n", encoding="utf-8"
    )
    for name in ("d1.zarr", "d2.zarr"):
        (ws / name).mkdir()
    return ws


@pytest.fixture
def llm_ready(monkeypatch):
    import app.api.discovery as discovery_api

    monkeypatch.setattr(discovery_api, "unavailable_reason", lambda: None)
    monkeypatch.setattr(discovery_api, "docker_unavailable_reason", lambda: None)


@pytest.fixture
def fake_loop(monkeypatch):
    """Replace the loop; `calls` records its kwargs, `script` its behaviour."""
    import app.services.agent.discovery.run_manager as run_manager_mod

    state = {"calls": [], "script": None}

    async def loop(**kwargs):
        state["calls"].append(kwargs)
        # what the real loop writes first, so the folder is listable / resumable
        state_path = kwargs["run_root"] / "run_state.json"
        if not state_path.exists():
            state_path.write_text(json.dumps({"next_round_id": 1, "config": {"rounds": kwargs["rounds"]}}))
        if state["script"]:
            return await state["script"](**kwargs)
        await kwargs["emit"]({"type": "round_started", "round_id": 1, "total_rounds": 1})
        return {"answer": "done", "status": "completed", "iterations": 1}

    monkeypatch.setattr(run_manager_mod, "run_discovery", loop)
    return state


def _start(client, workspace, task=PROBLEM, **extra):
    return client.post(f"{API}/runs", json={"task": task, "workspace_path": str(workspace), **extra}).json()


def _events(client, run_id):
    with client.stream("GET", f"{API}/runs/{run_id}/stream") as r:
        return [json.loads(line[len("data: "):]) for line in r.iter_lines() if line.startswith("data: ")]


def test_session_routes_are_gone(client):
    # the smoke test asserts the control-plane session surface stays removed
    r = client.get("/api/agent/v1/coscientist/sessions")
    assert r.status_code in (404, 405) or r.json().get("code") in (404, 405)


def test_problem_endpoint_reads_problem_md_and_offers_template(client, workspace, storage_root):
    rel = workspace.relative_to(storage_root).as_posix()
    r = client.get(f"{API}/problem", params={"data_dir": rel}).json()["data"]
    assert r["found"] is False and r["content"] == ""
    assert r["template"].startswith("---\noutcome:")

    (workspace / "problem.md").write_text(PROBLEM, encoding="utf-8")
    r = client.get(f"{API}/problem", params={"data_dir": rel}).json()["data"]
    assert r["found"] is True and r["content"] == PROBLEM


def test_problem_endpoint_accepts_the_open_slides_path_with_either_separator(client, workspace, storage_root):
    # the panel sends the open slide's path; on Windows formatPath uses "\\"
    (workspace / "problem.md").write_text(PROBLEM, encoding="utf-8")
    (workspace / "slide.svs").write_bytes(b"x")
    rel = (workspace / "slide.svs").relative_to(storage_root).as_posix()
    for data_dir in (rel, rel.replace("/", "\\")):
        r = client.get(f"{API}/problem", params={"data_dir": data_dir}).json()["data"]
        assert r["found"] is True and r["content"] == PROBLEM, data_dir


def test_workspace_runs_list_and_load(client, workspace):
    run_root = workspace / "autoresearch_runs" / "run_abc"
    (run_root / "round_0001").mkdir(parents=True)
    (run_root / "run_state.json").write_text(json.dumps({"next_round_id": 2, "config": {"rounds": 3}}))
    (run_root / "problem.md").write_text(PROBLEM)
    (run_root / "results.tsv").write_text("round_id\tcandidate_id\tdecision\tdescription\n1\tcand_1\tkeep\tQ1\n")
    (run_root / "round_0001" / "round_feedback.json").write_text(json.dumps({"summary": "kept cand_1"}))

    runs = client.get(f"{API}/runs", params={"workspace_path": str(workspace)}).json()["data"]["runs"]
    assert [(r["run_id"], r["status"], r["rounds"], r["next_round_id"]) for r in runs] == [("run_abc", "incomplete", 3, 2)]

    loaded = client.get(f"{API}/runs/load", params={"run_root_path": str(run_root)}).json()["data"]
    assert loaded["problem_text"] == PROBLEM
    assert loaded["journal"] == [{"roundId": 1, "focus": "Q1", "summary": "kept cand_1"}]
    assert loaded["status"] == "incomplete" and loaded["final_summary"] is None


def test_start_run_without_key_is_501(client, workspace):
    body = _start(client, workspace)
    assert body["code"] == 501
    assert "OPENAI_API_KEY" in body["message"]


def test_start_run_without_docker_is_501(client, workspace, monkeypatch):
    import app.api.discovery as discovery_api

    monkeypatch.setattr(discovery_api, "unavailable_reason", lambda: None)
    monkeypatch.setattr(discovery_api, "docker_unavailable_reason", lambda: "Docker is not running.")
    body = _start(client, workspace)
    assert body["code"] == 501
    assert body["message"] == "Docker is not running."


@pytest.mark.parametrize("task, message", [
    ("just a question", "YAML header"),
    ("---\ncovariates: [age]\n---\nq", "set `outcome`"),
    ("---\noutcome: missing_col\n---\nq", "lacks column(s) ['missing_col']"),
    ("---\noutcome: slope\ncovariate: [age]\n---\nq", "unknown setting(s) ['covariate']"),
    ("---\noutcome: slope\ncohort_file: Training_Cohort.csv\n---\nq", "names are case-sensitive"),
])
def test_bad_problem_is_rejected_before_the_run(client, workspace, llm_ready, fake_loop, task, message):
    body = _start(client, workspace, task=task)
    assert body["code"] == 400, body
    assert message in body["message"]
    assert fake_loop["calls"] == []


def test_run_streams_loop_events_and_completes(client, workspace, llm_ready, fake_loop):
    body = _start(client, workspace, rounds=2)
    assert body["code"] == 0, body
    run_id = body["data"]["run_id"]

    events = _events(client, run_id)
    assert [e["type"] for e in events] == ["round_started", "complete"]
    call = fake_loop["calls"][0]
    assert call["data_dir"] == workspace
    assert call["run_root"] == workspace / "autoresearch_runs" / run_id
    assert call["spec"].outcome == "slope" and call["spec"].covariates == ("age",)
    assert call["rounds"] == 2
    # the submitted problem is saved to the workspace and the run folder
    assert (workspace / "problem.md").read_text() == PROBLEM
    assert (workspace / "autoresearch_runs" / run_id / "problem.md").read_text() == PROBLEM


def test_submitted_problem_replaces_existing_problem_md(client, workspace, llm_ready, fake_loop):
    (workspace / "problem.md").write_text("---\noutcome: slope\n---\nold question\n")
    _events(client, _start(client, workspace)["data"]["run_id"])
    assert (workspace / "problem.md").read_text() == PROBLEM
    assert fake_loop["calls"][0]["spec"].question == "Which tissue measurements track the slope?"


def test_cancel_stops_the_worker_thread_and_reports_once(client, workspace, llm_ready, fake_loop):
    import asyncio

    thread_saw_cancel = threading.Event()
    worker_entered = threading.Event()

    def blocking_worker(cancel_event):
        worker_entered.set()
        if cancel_event.wait(10):
            thread_saw_cancel.set()

    async def script(**kwargs):
        await asyncio.to_thread(blocking_worker, kwargs["cancel_event"])
        return {"answer": "", "status": "completed", "iterations": 1}

    fake_loop["script"] = script
    run_id = _start(client, workspace)["data"]["run_id"]
    assert worker_entered.wait(5)

    runs = client.get(f"{API}/runs", params={"workspace_path": str(workspace)}).json()["data"]["runs"]
    assert [r["status"] for r in runs if r["run_id"] == run_id] == ["running"]

    assert client.post(f"{API}/runs/{run_id}/cancel").json()["data"] == {"cancelled": True}
    assert thread_saw_cancel.wait(5)
    errors = [e for e in _events(client, run_id) if e["type"] == "error"]
    assert errors == [{"type": "error", "message": "Run cancelled"}]


def test_resume_rereads_the_problem_and_refuses_a_running_folder(client, workspace, llm_ready, fake_loop):
    import asyncio

    release = threading.Event()

    async def script(**kwargs):
        if kwargs.get("model") == "saved-model":   # the resumed run: hold it open
            await asyncio.to_thread(release.wait, 10)
        return {"answer": "", "status": "completed", "iterations": 1}

    fake_loop["script"] = script
    first = _start(client, workspace)["data"]["run_id"]
    _events(client, first)
    run_root = workspace / "autoresearch_runs" / first
    (run_root / "run_state.json").write_text(json.dumps(
        {"next_round_id": 2, "config": {"rounds": 3, "model": "saved-model", "reasoning_effort": "low"}}
    ))
    try:
        resumed = client.post(f"{API}/runs/resume", json={"run_root_path": str(run_root)}).json()
        assert resumed["code"] == 0 and resumed["data"] == {"run_id": first}
        call = fake_loop["calls"][-1]
        assert call["run_root"] == run_root and call["data_dir"] == workspace
        assert call["spec"].outcome == "slope" and call["rounds"] == 2   # rounds 2..3 remain
        assert call["reasoning_effort"] == "low"

        again = client.post(f"{API}/runs/resume", json={"run_root_path": str(run_root)}).json()
        assert again["code"] == 400 and "already running" in again["message"]
    finally:
        release.set()


def test_resume_refuses_a_folder_outside_the_masked_runs_dir(client, workspace, llm_ready, fake_loop):
    copied = workspace / "copies" / "run_x"
    copied.mkdir(parents=True)
    (copied / "run_state.json").write_text(json.dumps({"next_round_id": 1, "config": {"rounds": 1}}))
    (copied / "problem.md").write_text(PROBLEM)
    body = client.post(f"{API}/runs/resume", json={"run_root_path": str(copied)}).json()
    assert body["code"] == 400 and "inside autoresearch_runs/" in body["message"]
    assert fake_loop["calls"] == []


def test_resume_waits_for_threads_of_a_cancelled_run(client, workspace, llm_ready, fake_loop, monkeypatch):
    import app.services.agent.discovery.run_manager as run_manager_mod

    run_id = _start(client, workspace)["data"]["run_id"]
    _events(client, run_id)
    monkeypatch.setattr(run_manager_mod, "run_folder_busy", lambda root: True)
    body = client.post(f"{API}/runs/resume",
                       json={"run_root_path": str(workspace / "autoresearch_runs" / run_id)}).json()
    assert body["code"] == 400 and "still stopping" in body["message"]
