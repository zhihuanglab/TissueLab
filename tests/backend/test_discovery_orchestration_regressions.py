"""Regressions in the discovery orchestration: thread accounting, legacy problem.md
keys, the run's event stream, the proposer's failure modes, the run listing,
resumed round counts, the trusted dataset guide, and the LLM client.

No Docker, no network: every stage and the model are stubbed.
"""
import asyncio
import concurrent.futures
import json
import threading
import time
from pathlib import Path

import pandas as pd
import pytest

API = "/api/agent/v1/discovery"
PROBLEM = """---
outcome: slope
covariates: [age]
---
Which tissue measurements track the slope?
"""
PLAN = {
    "candidate_id": "pilot", "scientific_question": "q", "approach": "a",
    "variations": [{"name": "a", "expected_sign": 1}, {"name": "b", "expected_sign": -1},
                   {"name": "c", "expected_sign": 1}],
    "baseline_variation": "a",
}


def _spec():
    from app.services.agent.discovery.problem import parse_problem

    return parse_problem(PROBLEM)


def _data(tmp_path: Path) -> Path:
    data = tmp_path / "data"
    data.mkdir()
    pd.DataFrame({"donor_id": ["d1", "d2"], "slide_name": ["a.zarr", "b.zarr"],
                  "slope": [0.1, 0.2], "age": [70, 71]}).to_csv(data / "training_cohort.csv", index=False)
    return data


def _in_time(fn, seconds=10):
    """fn() in a thread; fails instead of hanging the suite."""
    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        return pool.submit(fn).result(timeout=seconds)


# ── 1. thread accounting ─────────────────────────────────────────────────────

def test_a_call_cancelled_while_queued_never_counts_as_busy(tmp_path):
    import app.services.agent.discovery.loop as loop

    run_root = tmp_path / "run"
    run_root.mkdir()
    ran = threading.Event()
    release = threading.Event()

    async def scenario():
        running = asyncio.get_running_loop()
        running.set_default_executor(concurrent.futures.ThreadPoolExecutor(max_workers=1))
        blocker = running.run_in_executor(None, release.wait, 10)   # saturates the executor
        queued = asyncio.create_task(loop._in_thread(run_root, ran.set))
        await asyncio.sleep(0.05)
        assert not loop.run_folder_busy(run_root)   # queued, not running: no thread touches the folder
        queued.cancel()
        with pytest.raises(asyncio.CancelledError):
            await queued
        release.set()
        await blocker
        # a call that does run is counted while it runs and released after
        seen = await loop._in_thread(run_root, lambda: loop.run_folder_busy(run_root))
        return seen

    assert asyncio.run(scenario()) is True
    assert not ran.is_set()
    assert not loop.run_folder_busy(run_root)


# ── 2. legacy problem.md keys ────────────────────────────────────────────────

def test_problem_md_with_the_dropped_class_rules_still_parses():
    from app.services.agent.discovery.problem import ProblemError, parse_problem

    spec = parse_problem("---\noutcome: slope\nexcluded_classes: [Other]\nexclude_only_classes: [x]\n---\nq\n")
    assert spec.outcome == "slope"
    with pytest.raises(ProblemError, match="unknown setting"):
        parse_problem("---\noutcome: slope\nclass_rules: [x]\n---\nq\n")


# ── 3. the event stream ──────────────────────────────────────────────────────

@pytest.fixture
def workspace(user_root):
    ws = user_root / f"discovery_orch_{time.time_ns()}"
    ws.mkdir()
    (ws / "training_cohort.csv").write_text(
        "donor_id,slide_name,slope,age\nd1,d1.zarr,-0.1,80\nd2,d2.zarr,0.2,75\n", encoding="utf-8")
    for name in ("d1.zarr", "d2.zarr"):
        (ws / name).mkdir()
    return ws


@pytest.fixture
def held_loop(monkeypatch):
    """A run that stays open until `release` is set."""
    import app.api.discovery as discovery_api
    import app.services.agent.discovery.run_manager as run_manager_mod

    monkeypatch.setattr(discovery_api, "unavailable_reason", lambda: None)
    monkeypatch.setattr(discovery_api, "docker_unavailable_reason", lambda: None)
    release = threading.Event()

    async def loop(**kwargs):
        (kwargs["run_root"] / "run_state.json").write_text(json.dumps({"next_round_id": 1, "config": {"rounds": 1}}))
        await kwargs["emit"]({"type": "round_started", "round_id": 1})
        await asyncio.to_thread(release.wait, 10)
        return {"answer": "done", "status": "completed", "iterations": 1}

    monkeypatch.setattr(run_manager_mod, "run_discovery", loop)
    yield release
    release.set()


def _events(client, run_id):
    with client.stream("GET", f"{API}/runs/{run_id}/stream") as r:
        return [json.loads(line[len("data: "):]) for line in r.iter_lines() if line.startswith("data: ")]


def test_a_newer_stream_takes_over_and_a_finished_run_is_forgotten(client, workspace, held_loop):
    from app.services.agent.discovery import get_discovery_run_manager

    run_id = client.post(f"{API}/runs", json={"task": PROBLEM, "workspace_path": str(workspace)}).json()["data"]["run_id"]
    first: dict = {}
    reader = threading.Thread(target=lambda: first.setdefault("events", _events(client, run_id)))
    reader.start()
    manager = get_discovery_run_manager()
    deadline = time.monotonic() + 5
    while run_id not in manager._streaming and time.monotonic() < deadline:
        time.sleep(0.01)
    old_reader = manager._streaming[run_id]

    # a reattach (the old connection may have dropped unnoticed) takes over at once;
    # the old reader stops instead of splitting the events
    second: dict = {}
    reattach = threading.Thread(target=lambda: second.setdefault("events", _events(client, run_id)))
    reattach.start()
    while manager._streaming.get(run_id) is old_reader and time.monotonic() < deadline:
        time.sleep(0.01)
    reader.join(5)
    assert not reader.is_alive()
    assert [e["type"] for e in first["events"]] == ["round_started"]

    held_loop.set()
    reattach.join(10)
    assert [e["type"] for e in second["events"]] == ["complete"]
    # the end reached its reader: nothing is kept, and a late stream returns at once
    assert run_id not in manager._queues and run_id not in manager._tasks
    assert _in_time(lambda: _events(client, run_id)) == [{"type": "error", "message": "Run not found"}]


async def _drain(stream):
    return [event async for event in stream if event is not None]


def test_a_silent_stream_sends_heartbeats(monkeypatch, tmp_path):
    import app.services.agent.discovery.run_manager as run_manager_mod

    monkeypatch.setattr(run_manager_mod, "STREAM_HEARTBEAT_SEC", 0.02)
    release = asyncio.Event()

    async def quiet(**kwargs):
        await release.wait()
        return {}

    monkeypatch.setattr(run_manager_mod, "run_discovery", quiet)

    async def scenario():
        manager = run_manager_mod.DiscoveryRunManager()
        await manager._launch("run_x", tmp_path)
        stream = manager.read_stream("run_x")
        beats = [await asyncio.wait_for(stream.__anext__(), 2) for _ in range(3)]
        release.set()
        rest = await asyncio.wait_for(_drain(stream), 2)
        return beats, rest, manager

    beats, rest, manager = asyncio.run(scenario())
    assert beats == [None, None, None]
    assert [e["type"] for e in rest] == ["complete"]
    assert "run_x" not in manager._queues and "run_x" not in manager._streaming


def test_a_superseded_reader_hands_back_an_event_it_took(tmp_path):
    import app.services.agent.discovery.run_manager as run_manager_mod

    async def scenario():
        manager = run_manager_mod.DiscoveryRunManager()
        queue = manager._queues["run_x"] = asyncio.Queue()
        old = manager.read_stream("run_x")
        pending = asyncio.ensure_future(old.__anext__())
        await asyncio.sleep(0)            # the old reader is waiting on the queue
        queue.put_nowait({"type": "tick"})
        new = manager.read_stream("run_x")
        first_new = asyncio.ensure_future(new.__anext__())
        await asyncio.sleep(0.05)
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(pending, 2)
        got = await asyncio.wait_for(first_new, 2)
        queue.put_nowait(None)
        rest = await asyncio.wait_for(_drain(new), 2)
        return got, rest

    got, rest = asyncio.run(scenario())
    assert got == {"type": "tick"} and rest == []


def test_a_stream_opened_after_the_run_ended_gets_the_ending_then_not_found(client, workspace, held_loop):
    held_loop.set()
    run_id = client.post(f"{API}/runs", json={"task": PROBLEM, "workspace_path": str(workspace)}).json()["data"]["run_id"]
    from app.services.agent.discovery import get_discovery_run_manager

    manager = get_discovery_run_manager()
    deadline = time.monotonic() + 5
    while manager.is_active(run_id) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert [e["type"] for e in _in_time(lambda: _events(client, run_id))] == ["round_started", "complete"]
    assert _in_time(lambda: _events(client, run_id)) == [{"type": "error", "message": "Run not found"}]


def test_a_run_cancelled_before_it_starts_still_ends_its_stream(monkeypatch, tmp_path):
    import app.services.agent.discovery.run_manager as run_manager_mod

    async def never(**kwargs):
        raise AssertionError("not reached")

    monkeypatch.setattr(run_manager_mod, "run_discovery", never)

    async def scenario():
        manager = run_manager_mod.DiscoveryRunManager()
        await manager._launch("run_x", tmp_path)
        assert await manager.cancel_run("run_x") and await manager.cancel_run("run_x")   # idempotent
        events = await asyncio.wait_for(_drain(manager.read_stream("run_x")), 2)
        return events, manager

    events, manager = asyncio.run(scenario())
    assert events == []   # the task never ran; the sentinel still came
    assert "run_x" not in manager._queues


def test_events_for_a_stream_that_is_not_reading_are_bounded(monkeypatch, tmp_path):
    import app.services.agent.discovery.run_manager as run_manager_mod

    monkeypatch.setattr(run_manager_mod, "EVENT_BACKLOG", 5)

    async def chatty(**kwargs):
        for i in range(50):
            await kwargs["emit"]({"type": "tick", "i": i})
        return {}

    monkeypatch.setattr(run_manager_mod, "run_discovery", chatty)

    async def scenario():
        manager = run_manager_mod.DiscoveryRunManager()
        await manager._launch("run_x", tmp_path)
        await asyncio.wait_for(manager._tasks["run_x"], 2)
        return await asyncio.wait_for(_drain(manager.read_stream("run_x")), 2)

    events = asyncio.run(scenario())
    assert len(events) < 5 and events[-1]["type"] == "complete"


# ── 5–7. the proposer ────────────────────────────────────────────────────────

def _resp(rid, text):
    return {"id": rid, "model": "m", "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}]}


def _propose(monkeypatch, tmp_path, replies, **extra):
    from app.services.agent.discovery import proposer

    it = iter(replies)
    requests = []
    monkeypatch.setattr(proposer, "responses_create", lambda payload, timeout=0: requests.append(payload) or next(it))
    plan = proposer.run_proposer(
        round_dir=tmp_path / "round_0001", spec=_spec(), accepted_panel_summary={"members": []},
        results_log_text="", round_id=1, model="m", reasoning_effort="low", **extra)
    return plan, requests


def test_a_proposer_that_never_gives_a_plan_fails_instead_of_launching_a_placeholder(monkeypatch, tmp_path):
    with pytest.raises(RuntimeError, match="no parseable JSON plan"):
        _propose(monkeypatch, tmp_path, [_resp(f"r{i}", "I think regions matter.") for i in range(3)])


def test_parse_json_takes_a_single_plan_in_a_list_and_nothing_else():
    from app.services.agent.discovery.proposer import parse_json

    assert parse_json(json.dumps([PLAN]))["candidate_id"] == "pilot"
    assert parse_json(json.dumps([PLAN, PLAN])) == {}
    assert parse_json("[1, 2]") == {} and parse_json('"text"') == {} and parse_json("nonsense") == {}


def test_a_listed_plan_from_the_model_is_used(monkeypatch, tmp_path):
    plan, _ = _propose(monkeypatch, tmp_path, [_resp("r1", json.dumps([PLAN]))])
    assert plan["candidate_id"] == "pilot"


def test_without_a_guide_the_proposer_is_told_there_is_none(monkeypatch, tmp_path):
    _, requests = _propose(monkeypatch, tmp_path, [_resp("r1", json.dumps(PLAN))])
    assert "None for this run" in requests[0]["instructions"]
    _, requests = _propose(monkeypatch, tmp_path, [_resp("r1", json.dumps(PLAN))], dataset_guide_text="GUIDE")
    assert "GUIDE" in requests[0]["instructions"] and "None for this run" not in requests[0]["instructions"]


def test_proposer_retry_backoff_stops_on_cancel(monkeypatch):
    from app.services.agent.discovery import proposer

    cancel = threading.Event()

    def failing(payload, timeout=0):
        cancel.set()   # cancelled while the request failed
        raise ConnectionError("down")

    monkeypatch.setattr(proposer, "responses_create", failing)
    started = time.monotonic()
    with pytest.raises(RuntimeError, match="cancelled"):
        proposer._create_with_retry({}, timeout=1, cancel_event=cancel)
    assert time.monotonic() - started < proposer.PROPOSER_RETRY_BACKOFF_SEC


# ── 9, 11. the loop: trusted guide, resumed round count ──────────────────────

def _stub_stages(monkeypatch, seen):
    import app.services.agent.discovery.loop as loop

    def proposer(**kwargs):
        seen.append(kwargs["dataset_guide_text"])
        raise RuntimeError("no plan")   # each round ends at the proposer

    monkeypatch.setattr(loop, "run_proposer", proposer)
    return loop


async def _noop(event):
    pass


def test_a_guide_file_the_scout_did_not_record_is_ignored(monkeypatch, tmp_path):
    seen: list = []
    loop = _stub_stages(monkeypatch, seen)
    run_root = tmp_path / "run"
    (run_root / "shared").mkdir(parents=True)
    (run_root / "shared" / "dataset_guide.md").write_text("written by a worker")
    # every run since the flag records it from the start
    (run_root / "run_state.json").write_text(json.dumps({"next_round_id": 2, "config": {"rounds": 1}, "guide": False}))

    def scout(**kwargs):
        (Path(kwargs["shared_dir"]) / "dataset_guide.md").write_text("scouted")
        return {"status": "completed", "turns": 1}

    monkeypatch.setattr(loop, "run_scout", scout)
    asyncio.run(loop.run_discovery(spec=_spec(), data_dir=_data(tmp_path), run_root=run_root, emit=_noop,
                                   rounds=1, model="m", dataset_scout=False))
    assert seen == [""]
    # with the scout on, it runs again and its guide is the one recorded
    asyncio.run(loop.run_discovery(spec=_spec(), data_dir=tmp_path / "data", run_root=run_root, emit=_noop,
                                   rounds=1, model="m", dataset_scout=True))
    assert seen[-1] == "scouted"
    assert json.loads((run_root / "run_state.json").read_text())["guide"] is True


def test_resume_with_more_rounds_raises_the_runs_total(monkeypatch, tmp_path):
    loop = _stub_stages(monkeypatch, [])
    run_root = tmp_path / "run"
    run_root.mkdir()
    (run_root / "run_state.json").write_text(json.dumps({"next_round_id": 3, "config": {"rounds": 2}}))
    asyncio.run(loop.run_discovery(spec=_spec(), data_dir=_data(tmp_path), run_root=run_root, emit=_noop,
                                   rounds=2, model="m", dataset_scout=False))
    state = json.loads((run_root / "run_state.json").read_text())
    assert state["next_round_id"] == 5 and state["config"]["rounds"] == 4


# ── 10. the run listing ──────────────────────────────────────────────────────

def test_one_corrupt_run_state_does_not_hide_the_other_runs(client, workspace):
    runs_dir = workspace / "autoresearch_runs"
    (runs_dir / "run_good").mkdir(parents=True)
    (runs_dir / "run_good" / "run_state.json").write_text(json.dumps({"next_round_id": 1, "config": {"rounds": 1}}))
    (runs_dir / "run_bad").mkdir()
    (runs_dir / "run_bad" / "run_state.json").write_text("{not json")
    (runs_dir / "run_list").mkdir()
    (runs_dir / "run_list" / "run_state.json").write_text("[]")
    body = client.get(f"{API}/runs", params={"workspace_path": str(workspace)}).json()
    assert body["code"] == 0, body
    assert [r["run_id"] for r in body["data"]["runs"]] == ["run_good"]


# ── 12, 13. the LLM client ───────────────────────────────────────────────────

@pytest.fixture
def clean_llm_env(monkeypatch):
    from app.services.agent.discovery import client as discovery_client

    for name in ("OPENAI_BASE_URL", "OPENAI_API_KEY", "DISCOVERY_BASE_URL", "DISCOVERY_API_KEY", "LLM_API"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(discovery_client, "_client", None)
    return discovery_client


def test_a_run_keeps_its_client_when_settings_change_mid_run(clean_llm_env, monkeypatch):
    discovery_client = clean_llm_env

    class FakeClient:
        def __init__(self, name):
            self.name = name
            self.responses = self

        def with_options(self, **kwargs):
            return self

        def create(self, **payload):
            return {"id": "r", "via": self.name}

    clients = iter([FakeClient("first"), FakeClient("second"), FakeClient("third")])
    monkeypatch.setattr(discovery_client, "get_client", lambda: next(clients))

    async def run():
        discovery_client.pin_run_client()
        # the proposer and a worker thread of the same run, before and after a settings save
        a = await asyncio.to_thread(discovery_client.responses_create, {})
        b = await asyncio.to_thread(discovery_client.responses_create, {})
        return a["via"], b["via"]

    assert asyncio.run(run()) == ("first", "first")
    # outside a run every call takes the current client
    assert discovery_client.responses_create({})["via"] == "second"


def test_endpoint_and_key_are_taken_as_a_pair(clean_llm_env, monkeypatch):
    discovery_client = clean_llm_env
    monkeypatch.setenv("OPENAI_API_KEY", "sk-agent")

    # a research endpoint without its own key never receives the agent's key
    monkeypatch.setenv("DISCOVERY_BASE_URL", "https://third-party.example/v1")
    assert "DISCOVERY_API_KEY" in discovery_client.unavailable_reason()
    with pytest.raises(RuntimeError, match="no API key"):
        discovery_client.get_client()

    # ...unless it is the agent's own endpoint
    monkeypatch.setenv("OPENAI_BASE_URL", "https://third-party.example/v1/")
    monkeypatch.setenv("LLM_API", "responses")
    assert discovery_client.unavailable_reason() is None
    assert discovery_client.get_client().api_key == "sk-agent"
    monkeypatch.setattr(discovery_client, "_client", None)

    # a research key without its endpoint never goes to the agent's endpoint
    monkeypatch.delenv("DISCOVERY_BASE_URL")
    monkeypatch.setenv("DISCOVERY_API_KEY", "sk-research")
    client = discovery_client.get_client()
    assert client.api_key == "sk-agent" and str(client.base_url).startswith("https://third-party.example/v1")
    monkeypatch.setattr(discovery_client, "_client", None)

    # the full research pair is used as is
    monkeypatch.setenv("DISCOVERY_BASE_URL", "https://research.example/v1")
    client = discovery_client.get_client()
    assert client.api_key == "sk-research" and str(client.base_url).startswith("https://research.example/v1")
    monkeypatch.setattr(discovery_client, "_client", None)


# ── 8. stream / cancel check access to the run's folder ──────────────────────

def test_stream_and_cancel_check_access_to_the_runs_folder(client, workspace, held_loop, monkeypatch):
    import app.api.discovery as discovery_api
    from app.core.errors import AppErrors

    run_id = client.post(f"{API}/runs", json={"task": PROBLEM, "workspace_path": str(workspace)}).json()["data"]["run_id"]
    checked = []

    async def deny(auth_user, path, operation):
        checked.append((path, operation))
        raise AppErrors.USER_FORBIDDEN("no")

    monkeypatch.setattr(discovery_api, "assert_can_access_path_async", deny)
    monkeypatch.setattr(discovery_api, "assert_can_write_path_async", deny)
    assert client.get(f"{API}/runs/{run_id}/stream").json()["code"] == 403
    assert client.post(f"{API}/runs/{run_id}/cancel").json()["code"] == 403
    run_root = str(workspace / "autoresearch_runs" / run_id)
    assert [p for p, _ in checked] == [run_root, run_root]


def test_a_run_from_before_the_guide_flag_keeps_its_scouts_guide(tmp_path):
    from app.services.agent.discovery.loop import guide_recorded

    (tmp_path / "shared").mkdir()
    assert not guide_recorded({}, tmp_path)
    (tmp_path / "shared" / "dataset_guide.md").write_text("guide")
    assert guide_recorded({"next_round_id": 3}, tmp_path)         # legacy: no flag at all
    assert not guide_recorded({"guide": False}, tmp_path)         # recorded: not the scout's
    assert guide_recorded({"guide": True}, tmp_path)
