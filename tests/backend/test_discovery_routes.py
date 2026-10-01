"""Discovery routes: the program / problem.md, the on-disk run listing, and the run lifecycle
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


@pytest.fixture
def no_model(monkeypatch):
    """The column-choosing model gives no answer (as without a key)."""
    import app.services.agent.discovery.workspace_scan as scan

    monkeypatch.setattr(scan, "_MODEL_ANSWERS", {})
    monkeypatch.setattr(scan, "ask_model_for_columns", lambda text, cohort: None)


def _started_problem(client, workspace, fake_loop, text):
    """Start a run from a plain-text program; the problem.md it was turned into, and the spec."""
    body = _start(client, workspace, task=text)
    assert body["code"] == 0, body
    assert body["data"]["outcome"] == fake_loop_outcome(body, workspace)
    _events(client, body["data"]["run_id"])
    run_problem = (workspace / "autoresearch_runs" / body["data"]["run_id"] / "problem.md").read_text()
    assert (workspace / "problem.md").read_text() == run_problem
    return run_problem, fake_loop["calls"][-1]["spec"]


def fake_loop_outcome(body, workspace):
    """The outcome the start reply names is the one in the run's problem.md."""
    from app.services.agent.discovery.problem import parse_problem

    run_problem = workspace / "autoresearch_runs" / body["data"]["run_id"] / "problem.md"
    return parse_problem(run_problem.read_text()).outcome


def test_get_program_returns_the_saved_question(client, workspace, storage_root):
    rel = (workspace / "slide.svs").relative_to(storage_root).as_posix()
    assert client.get(f"{API}/program", params={"data_dir": rel}).json()["data"] == {"text": ""}

    (workspace / "problem.md").write_text(PROBLEM, encoding="utf-8")
    (workspace / "slide.svs").write_bytes(b"x")
    # the open slide's path, with either separator (formatPath uses "\\" on Windows)
    for data_dir in (rel, rel.replace("/", "\\"), str(workspace)):
        r = client.get(f"{API}/program", params={"data_dir": data_dir}).json()
        assert r["data"] == {"text": "Which tissue measurements track the slope?"}, data_dir

    # a problem.md that does not parse comes back as written
    (workspace / "problem.md").write_text("---\ncovariates: [age]\n---\nq\n", encoding="utf-8")
    assert client.get(f"{API}/program", params={"data_dir": str(workspace)}).json()["data"]["text"] == \
        "---\ncovariates: [age]\n---\nq\n"


def test_plain_program_names_its_outcome_and_covariates(client, workspace, llm_ready, fake_loop, no_model):
    text = "Which tissue measurements predict the slope, adjusting for age?"
    problem, spec = _started_problem(client, workspace, fake_loop, text)
    assert problem == f"---\noutcome: slope\ncovariates: [age]\n---\n{text}\n"
    assert (spec.outcome, spec.covariates, spec.question) == ("slope", ("age",), text)
    # "age" can be the outcome too, when not after "adjust"
    _, spec = _started_problem(client, workspace, fake_loop, "Does tissue predict age?")
    assert (spec.outcome, spec.covariates) == ("age", ())


def test_plain_program_lets_the_model_choose_from_column_names(client, workspace, llm_ready, fake_loop, monkeypatch):
    import app.services.agent.discovery.client as client_mod
    import app.services.agent.discovery.workspace_scan as scan

    monkeypatch.setattr(scan, "_MODEL_ANSWERS", {})
    seen = []
    monkeypatch.setattr(client_mod, "unavailable_reason", lambda: None)
    monkeypatch.setattr(client_mod, "responses_create", lambda payload, timeout=0: seen.append(payload) or {
        "output_text": 'Sure: {"outcome": "slope", "covariates": ["age", "not_a_column"]}'
    })
    text = "找出能预测记忆衰退速度的组织特征，校正年龄"
    problem, spec = _started_problem(client, workspace, fake_loop, text)
    assert (spec.outcome, spec.covariates) == ("slope", ("age",))
    assert problem.startswith("---\noutcome: slope\ncovariates: [age]\n---\n")
    prompt = seen[0]["input"]
    assert "slope" in prompt and "-0.1" not in prompt and "80" not in prompt  # names, never values
    # the same program asks once
    _started_problem(client, workspace, fake_loop, text)
    assert len(seen) == 1


def test_plain_program_falls_back_to_the_saved_header(client, workspace, llm_ready, fake_loop, no_model):
    (workspace / "problem.md").write_text("---\noutcome: age\ncovariates: [slope]\n---\nold question\n")
    problem, spec = _started_problem(client, workspace, fake_loop, "Find tissue features that matter.")
    assert (spec.outcome, spec.covariates) == ("age", ("slope",))
    assert problem == "---\noutcome: age\ncovariates: [slope]\n---\nFind tissue features that matter.\n"


def test_saved_header_for_another_table_is_not_used(client, workspace, llm_ready, fake_loop, no_model):
    (workspace / "problem.md").write_text("---\noutcome: age\ncohort_file: other.csv\n---\nq\n")
    body = _start(client, workspace, task="Find tissue features that matter.")
    assert body["code"] == 400 and "Couldn't tell which column to predict" in body["message"]


def test_plain_program_takes_the_only_outcome_candidate(client, workspace, llm_ready, fake_loop, no_model):
    (workspace / "training_cohort.csv").write_text(
        "donor_id,slide_name,slope,sex\nd1,d1.zarr,-0.1,F\nd2,d2.zarr,0.2,M\n", encoding="utf-8"
    )
    _, spec = _started_problem(client, workspace, fake_loop, "Find tissue features that matter.")
    assert spec.outcome == "slope"


def test_ambiguous_plain_program_says_what_to_name(client, workspace, llm_ready, fake_loop, no_model):
    body = _start(client, workspace, task="Find tissue features that matter.")
    assert body["code"] == 400, body
    assert body["message"] == (
        'Couldn\'t tell which column to predict. Name it in the program, e.g. "predict slope". Columns: slope, age'
    )
    assert fake_loop["calls"] == [] and not (workspace / "problem.md").exists()


def test_plain_program_needs_a_cohort_table_with_an_outcome(client, workspace, llm_ready, fake_loop, no_model):
    (workspace / "training_cohort.csv").unlink()
    body = _start(client, workspace, task="Find tissue features.")
    assert body["code"] == 400 and body["message"] == "No patient table (CSV) found in this folder"

    (workspace / "cases.csv").write_text("donor_id,slide_name,group\nd1,d1.zarr,a\nd2,d2.zarr,b\n", encoding="utf-8")
    body = _start(client, workspace, task="Find tissue features.")
    assert body["code"] == 400 and "numeric with a value in every row of cases.csv" in body["message"]
    assert fake_loop["calls"] == []


def test_compose_problem_quotes_what_yaml_would_misread():
    from app.services.agent.discovery.problem import compose_problem, parse_problem

    text = compose_problem({
        "outcome": "null", "covariates": ["age (y)", "true"], "question": " q ",
        "cohort_file": "c d.csv", "id_column": "donor_id", "slide_column": "slide_name", "mpp_column": "mpp",
    })
    assert text == '---\noutcome: "null"\ncovariates: ["age (y)", "true"]\ncohort_file: "c d.csv"\n---\nq\n'
    spec = parse_problem(text)
    assert (spec.outcome, spec.covariates, spec.cohort_file) == ("null", ("age (y)", "true"), "c d.csv")


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
    assert loaded["outcome"] == "slope"   # the panel shows what the run predicts
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
    ("just a question", "Couldn't tell which column to predict"),
    ("   ", "Describe the research program first"),
    ("---\ncovariates: [age]\n---\nq", "set `outcome`"),
    ("---\noutcome: missing_col\n---\nq", "lacks column(s) ['missing_col']"),
    ("---\noutcome: slope\ncovariate: [age]\n---\nq", "unknown setting(s) ['covariate']"),
    ("---\noutcome: slope\ncohort_file: Training_Cohort.csv\n---\nq", "names are case-sensitive"),
])
def test_bad_problem_is_rejected_before_the_run(client, workspace, llm_ready, fake_loop, no_model, task, message):
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


def test_a_new_run_can_reuse_an_earlier_runs_dataset_guide(client, workspace, llm_ready, fake_loop):
    earlier = workspace / "autoresearch_runs" / "run_earlier"
    (earlier / "shared").mkdir(parents=True)
    # "guide": its scout recorded writing the guide (a worker could write the file too)
    (earlier / "run_state.json").write_text(json.dumps({"next_round_id": 2, "config": {"rounds": 1}, "guide": True}))
    (earlier / "shared" / "dataset_guide.md").write_text("# Guide from before\n")
    runs = client.get(f"{API}/runs", params={"workspace_path": str(workspace)}).json()["data"]["runs"]
    assert [(r["run_id"], r["has_guide"]) for r in runs] == [("run_earlier", True)]

    body = _start(client, workspace, reuse_guide_from="run_earlier")
    assert body["code"] == 0, body
    run_root = workspace / "autoresearch_runs" / body["data"]["run_id"]
    _events(client, body["data"]["run_id"])
    # copied in before the loop starts, so the loop skips the scout and says where the guide came from
    assert (run_root / "shared" / "dataset_guide.md").read_text() == "# Guide from before\n"
    assert fake_loop["calls"][-1]["guide_from"] == "run_earlier"


@pytest.mark.parametrize("run_id, message", [
    ("../elsewhere", "Not a run id"),
    ("run_missing", "has no dataset guide"),
])
def test_reusing_a_guide_needs_an_earlier_run_here_that_has_one(client, workspace, llm_ready, fake_loop, run_id, message):
    body = _start(client, workspace, reuse_guide_from=run_id)
    assert body["code"] == 400 and message in body["message"]
    assert not (workspace / "autoresearch_runs").exists() or not any((workspace / "autoresearch_runs").iterdir())


def test_a_problem_md_header_goes_as_written(client, workspace, llm_ready, fake_loop):
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
        assert resumed["code"] == 0 and resumed["data"] == {"run_id": first, "outcome": "slope"}
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
