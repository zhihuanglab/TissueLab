"""Discovery (autoresearch) routes and the Open-specific parts of the loop.

The loop itself is stubbed: these tests cover sessions, the on-disk run
listing, the run/stream/cancel lifecycle, and the preconditions checked
before a run starts. test_discovery_runtime.py covers the loop's internals.
"""
import json
import time

import pytest


@pytest.fixture
def workspace(user_root):
    ws = user_root / f"discovery_ws_{time.time_ns()}"
    ws.mkdir()
    return ws


@pytest.fixture
def llm_ready(monkeypatch):
    import app.api.discovery as discovery_api

    monkeypatch.setattr(discovery_api, "unavailable_reason", lambda: None)
    monkeypatch.setattr(discovery_api, "docker_unavailable_reason", lambda: None)


def _create_session(client, workspace):
    r = client.post("/api/agent/v1/coscientist/sessions", json={
        "context": {"workspace_path": str(workspace)},
        "template_type": "autoresearch",
    })
    body = r.json()
    assert body["code"] == 0, body
    return body["data"]["session_id"]


def test_session_create_list_get(client, workspace, local_uid):
    session_id = _create_session(client, workspace)

    listed = client.get("/api/agent/v1/coscientist/sessions").json()["data"]
    assert session_id in [s["session_id"] for s in listed]

    session = client.get(f"/api/agent/v1/coscientist/sessions/{session_id}").json()["data"]
    assert session["user_id"] == local_uid
    assert session["context"]["template_type"] == "autoresearch"


def test_program_reads_storage_relative_path(client, workspace, storage_root):
    rel = workspace.relative_to(storage_root).as_posix()
    r = client.get("/api/agent/v1/coscientist/program", params={"data_dir": rel}).json()
    assert r["data"] == {"found": False, "content": ""}

    (workspace / "program.md").write_text("Find LFB biomarkers", encoding="utf-8")
    r = client.get("/api/agent/v1/coscientist/program", params={"data_dir": rel}).json()
    assert r["data"] == {"found": True, "content": "Find LFB biomarkers"}


def test_workspace_runs_list_and_load(client, workspace):
    run_root = workspace / "autoresearch_runs" / "run_abc"
    (run_root / "round_0001").mkdir(parents=True)
    (run_root / "run_state.json").write_text(json.dumps({"next_round_id": 2, "config": {"rounds": 3}}))
    (run_root / "program.md").write_text("directive")
    (run_root / "results.tsv").write_text("round_id\tcandidate_id\tdecision\tstatus\n1\tcand_1\tkeep\tok\n")
    (run_root / "round_0001" / "round_summary.json").write_text(json.dumps({"summary": "kept cand_1"}))

    runs = client.get(
        "/api/agent/v1/coscientist/autoresearch_runs", params={"workspace_path": str(workspace)}
    ).json()["data"]["runs"]
    assert [r["run_id"] for r in runs] == ["run_abc"]
    assert runs[0]["status"] == "incomplete"
    assert runs[0]["resume_info"]["next_round_id"] == 2

    loaded = client.get(
        "/api/agent/v1/coscientist/autoresearch_runs/load", params={"run_root_path": str(run_root)}
    ).json()["data"]
    assert loaded["program_text"] == "directive"
    assert loaded["journal"] == [
        {"roundId": 1, "candidateId": "cand_1", "decision": "keep", "status": "ok", "summary": "kept cand_1"}
    ]


def test_start_run_without_key_is_501(client, workspace):
    session_id = _create_session(client, workspace)
    body = client.post(
        f"/api/agent/v1/coscientist/sessions/{session_id}/run", json={"task": "t"}
    ).json()
    assert body["code"] == 501
    assert "OPENAI_API_KEY" in body["message"]


def test_run_streams_loop_events_and_completes(client, workspace, llm_ready, monkeypatch):
    import app.services.agent.discovery.run_manager as run_manager_mod

    seen = {}

    async def fake_loop(**kwargs):
        seen.update(kwargs)
        await kwargs["emit"]({"type": "round_started", "round_id": 1, "total_rounds": 1})
        return {"answer": "done", "status": "completed", "iterations": 1}

    monkeypatch.setattr(run_manager_mod, "run_autoresearch", fake_loop)

    session_id = _create_session(client, workspace)
    body = client.post(
        f"/api/agent/v1/coscientist/sessions/{session_id}/run",
        json={"task": "Find LFB biomarkers", "context": {"workspace_path": str(workspace), "rounds": 1}},
    ).json()
    assert body["code"] == 0, body
    run_id = body["data"]["run_id"]

    with client.stream("GET", f"/api/agent/v1/coscientist/sessions/{session_id}/runs/{run_id}/stream") as r:
        events = [json.loads(line[len("data: "):]) for line in r.iter_lines() if line.startswith("data: ")]

    assert [e["type"] for e in events] == ["start", "round_started", "complete"]
    assert seen["data_dir"] == str(workspace)
    assert seen["run_root"] == str(workspace / "autoresearch_runs" / run_id)
    assert (workspace / "program.md").read_text() == "Find LFB biomarkers"

    session = client.get(f"/api/agent/v1/coscientist/sessions/{session_id}").json()["data"]
    assert session["runs"][-1]["status"] == "completed"


def test_start_run_without_docker_is_501(client, workspace, monkeypatch):
    import app.api.discovery as discovery_api

    monkeypatch.setattr(discovery_api, "unavailable_reason", lambda: None)
    monkeypatch.setattr(discovery_api, "docker_unavailable_reason", lambda: "Docker is not running.")
    session_id = _create_session(client, workspace)
    body = client.post(f"/api/agent/v1/coscientist/sessions/{session_id}/run", json={"task": "t"}).json()
    assert body["code"] == 501
    assert body["message"] == "Docker is not running."


def test_submitted_program_replaces_existing_program_md(client, workspace, llm_ready, monkeypatch):
    import app.services.agent.discovery.run_manager as run_manager_mod

    seen = {}

    async def fake_loop(**kwargs):
        seen["program"] = kwargs["program_text"]
        return {"answer": "", "status": "completed", "iterations": 0}

    monkeypatch.setattr(run_manager_mod, "run_autoresearch", fake_loop)
    (workspace / "program.md").write_text("old objective")

    session_id = _create_session(client, workspace)
    run_id = client.post(
        f"/api/agent/v1/coscientist/sessions/{session_id}/run",
        json={"task": "edited objective", "context": {"workspace_path": str(workspace)}},
    ).json()["data"]["run_id"]
    with client.stream("GET", f"/api/agent/v1/coscientist/sessions/{session_id}/runs/{run_id}/stream") as r:
        list(r.iter_lines())

    assert seen["program"] == "edited objective"
    assert (workspace / "program.md").read_text() == "edited objective"


def test_cancel_stops_the_worker_thread_and_reports_once(client, workspace, llm_ready, monkeypatch):
    import asyncio
    import threading

    import app.services.agent.discovery.run_manager as run_manager_mod

    thread_saw_cancel = threading.Event()
    worker_entered = threading.Event()

    def blocking_worker(cancel_event):
        worker_entered.set()
        if cancel_event.wait(10):
            thread_saw_cancel.set()

    async def fake_loop(**kwargs):
        await kwargs["emit"]({"type": "round_started", "round_id": 1, "total_rounds": 1})
        await asyncio.to_thread(blocking_worker, kwargs["cancel_event"])
        return {"answer": "", "status": "completed", "iterations": 1}

    monkeypatch.setattr(run_manager_mod, "run_autoresearch", fake_loop)

    session_id = _create_session(client, workspace)
    run_id = client.post(
        f"/api/agent/v1/coscientist/sessions/{session_id}/run",
        json={"task": "t", "context": {"workspace_path": str(workspace)}},
    ).json()["data"]["run_id"]
    assert worker_entered.wait(5)

    body = client.post(f"/api/agent/v1/coscientist/sessions/{session_id}/runs/{run_id}/cancel").json()
    assert body["data"] == {"cancelled": True}
    assert thread_saw_cancel.wait(5)

    with client.stream("GET", f"/api/agent/v1/coscientist/sessions/{session_id}/runs/{run_id}/stream") as r:
        events = [json.loads(line[len("data: "):]) for line in r.iter_lines() if line.startswith("data: ")]
    assert [e for e in events if e["type"] == "error"] == [{"type": "error", "message": "Run cancelled"}]

    session = client.get(f"/api/agent/v1/coscientist/sessions/{session_id}").json()["data"]
    assert session["runs"][-1]["status"] == "cancelled"
