"""Discovery (autoresearch) routes and the Open-specific parts of the loop.

The loop itself is stubbed: these tests cover sessions, the on-disk run
listing, the run/stream lifecycle, and that model-written code never runs in
the service process.
"""
import json
import subprocess
import sys
import time

import pytest

from conftest import SERVICE_DIR


@pytest.fixture
def workspace(user_root):
    ws = user_root / f"discovery_ws_{time.time_ns()}"
    ws.mkdir()
    return ws


@pytest.fixture
def llm_ready(monkeypatch):
    import app.api.discovery as discovery_api

    monkeypatch.setattr(discovery_api, "unavailable_reason", lambda: None)


def _create_session(client, workspace):
    r = client.post("/api/agent/v1/coscientist/sessions", json={
        "context": {"workspace_path": str(workspace)},
        "template_type": "autoresearch",
    })
    body = r.json()
    assert body["code"] == 0, body
    return body["data"]["session_id"]


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
    with pytest.raises(AttributeError):
        shared_analysis.not_an_export  # noqa: B018


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


def test_responses_api_is_required(monkeypatch):
    from app.services.agent.discovery import client as discovery_client

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:11434/v1")
    monkeypatch.delenv("LLM_API", raising=False)
    assert "Responses API" in discovery_client.unavailable_reason()

    monkeypatch.delenv("OPENAI_BASE_URL")
    assert discovery_client.unavailable_reason() is None


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


def test_result_script_replay_runs_in_the_sandbox(tmp_path, monkeypatch):
    import app.services.agent.discovery.deterministic_evaluator as evaluator

    calls = []

    class FakeSandbox:
        def __init__(self, scratch_dir, *, data_dir, shared_dir, command_timeout_sec):
            calls.append({"scratch": scratch_dir, "data": data_dir, "shared": shared_dir})

        def start(self):
            calls[-1]["started"] = True

        def exec(self, command, timeout_sec=None):
            calls[-1]["command"] = command
            scratch = calls[-1]["scratch"]
            (scratch / "donor_feature_table.csv").write_text("donor_id,f\nd1,1.0\n")
            (scratch / "__materialized_interface_metadata.json").write_text("{}")
            return {"exit_code": 0, "stdout": "", "stderr": ""}

        def stop(self):
            calls[-1]["stopped"] = True

    monkeypatch.setattr(evaluator, "SandboxSession", FakeSandbox)

    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "result.py").write_text("def compute_donor_score(*a, **k):\n    return {}\n")
    scratch, shared = tmp_path / "scratch", tmp_path / "shared"
    scratch.mkdir()
    shared.mkdir()

    table, _, issues = evaluator.materialize_donor_table_via_script_interface(
        script_path=worker_dir / "result.py",
        data_dir=tmp_path,
        shared_dir=shared,
        scratch_dir=scratch,
        timeout_sec=30,
    )

    assert issues == []
    assert table == scratch / "donor_feature_table.csv"
    call = calls[0]
    assert call["started"] and call["stopped"]
    assert call["command"].startswith("/usr/local/bin/python3 /scratch/__materialize_donor_table.py /scratch/result.py /data /shared /scratch")
    assert sys.executable not in call["command"]
    assert (scratch / "result.py").exists()
