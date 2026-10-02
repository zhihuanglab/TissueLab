"""Discovery review fixes: a moved run folder still resumes, the proposer's history is
bounded and donor-free, the program's columns are read more carefully, problem.md
keeps its header, run lifecycle edges (busy folder, finished resume, detached
stream, repeated stop, readable validation errors), the winner pick and
infrastructure-failure stop of the loop, and the admission bar.

No Docker, no LLM: the sandbox and the model are stubbed.
"""
import asyncio
import json
import shutil
import threading
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

API = "/api/agent/v1/discovery"
PROBLEM = """---
outcome: slope
covariates: [age]
---
Which measurements track the slope?
"""


def _fast_config(**overrides):
    from app.services.agent.discovery.panel_cv import PredictivePanelConfig

    return PredictivePanelConfig(**{"outer_repeats": 2, "inner_folds": 2, "ridge_alphas": (1.0,), **overrides})


# ── 1. accepted_panel.json paths survive moving the run folder ───────────────

def _donor_table(path: Path, column: str, values) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame({"donor_id": [f"d{i}" for i in range(len(values))], column: values}).to_csv(path, index=False)


def test_a_moved_run_folder_still_judges_its_panel(tmp_path):
    from app.services.agent.discovery.judge import review_candidate
    from app.services.agent.discovery.loop import _panel_member_record
    from app.services.agent.discovery.problem import parse_problem

    rng = np.random.default_rng(0)
    n = 30
    data = tmp_path / "data"
    data.mkdir()
    age = rng.normal(80, 5, n)
    signal = rng.normal(size=n)
    pd.DataFrame({"donor_id": [f"d{i}" for i in range(n)], "slide": "x.zarr",
                  "slope": signal + 0.01 * age + rng.normal(scale=0.3, size=n), "age": age}).to_csv(
        data / "cases.csv", index=False)
    spec = parse_problem("---\noutcome: slope\ncovariates: [age]\ncohort_file: cases.csv\nslide_column: slide\n---\nq")

    run_a = data / "autoresearch_runs" / "run_a"
    new_worker = run_a / "round_0001" / "round_0001_worker"
    old_worker = run_a / "round_0002" / "round_0002_worker"
    _donor_table(new_worker / "sandbox" / "donor_feature_table.csv", "m1", rng.normal(size=n))
    _donor_table(old_worker / "sandbox" / "donor_feature_table.csv", "m2", rng.normal(size=n))
    member = _panel_member_record(
        round_id=1, plan={"candidate_id": "m1"}, slot=1, run_root=run_a,
        worker_roundup={"worker_dir": str(new_worker), "results_path": str(new_worker / "results.json"),
                        "result_path": str(new_worker / "result.py"), "results": {"feature_column": "m1"}},
    )
    assert member["worker_dir"] == "round_0001/round_0001_worker"
    assert member["donor_feature_table"] == "round_0001/round_0001_worker/sandbox/donor_feature_table.csv"
    # how runs from before recorded a member: absolute paths
    legacy = {"feature_name": "m2", "feature_column": "m2", "worker_dir": str(old_worker),
              "donor_feature_table": str(old_worker / "sandbox" / "donor_feature_table.csv")}

    run_b = data / "autoresearch_runs" / "run_b"
    shutil.move(str(run_a), str(run_b))   # the folder is moved / renamed
    candidate = run_b / "round_0003" / "round_0003_worker"
    _donor_table(candidate / "sandbox" / "donor_feature_table.csv", "c", signal)

    review = review_candidate(
        accepted_panel={"members": [member, legacy]},
        worker_brief={"baseline_variation": "c", "variations": [{"name": "c", "expected_sign": 1}]},
        worker_roundup={"status": "completed", "worker_dir": str(candidate), "results": {}},
        data_dir=data, spec=spec, round_dir=candidate, config=_fast_config(), run_root=run_b,
    )
    assert review["current_panel_size"] == 2 and review["decision"] in ("keep", "discard")
    assert "action_reviews" not in review and "artifacts" not in review   # nothing read them


# ── 2–3. the proposer's history: bounded, and no donor ids ───────────────────

def _feedback(round_id: int, question: str) -> dict:
    from app.services.agent.discovery.loop import build_round_feedback

    summary = {"variation": "v", "is_primary": True, "coverage": 1.0, "partial_r": 0.3,
               "partial_r_loo_min": 0.2, "partial_r_loo_max": 0.4, "top_influence_donor": "DONOR_SECRET_7",
               "top_influence_share": 0.2, "gates": {"mean_rmse_improvement": False},
               "cv_gates_passed": 4, "cv_gates_total": 5}
    return build_round_feedback(
        round_id=round_id, plan={"candidate_id": f"cand{round_id}", "scientific_question": question},
        worker_status="completed", decision="discard", reason="predictive_cv_gates_failed",
        review={"variation_summaries": [summary]},
    )


def _write_history(run_root: Path, rounds: int, question: str = "q") -> None:
    from app.services.agent.discovery.loop import _append_results_row, _write_json, feedback_path

    run_root.mkdir(parents=True, exist_ok=True)
    for round_id in range(1, rounds + 1):
        _append_results_row(run_root, {"round_id": round_id, "worker": "", "candidate_id": f"cand{round_id}"})
        _write_json(feedback_path(run_root / f"round_{round_id:04d}", ""), _feedback(round_id, question))


def test_feedback_never_names_a_donor():
    from app.services.agent.discovery.loop import render_feedback_text

    fb = _feedback(1, "q")
    assert "DONOR_SECRET_7" not in json.dumps(fb) and "DONOR_SECRET_7" not in render_feedback_text(fb)
    assert fb["variations"][0]["top_influence_share"] == 0.2


def test_feedback_history_is_full_for_recent_rounds_and_bounded(tmp_path, monkeypatch):
    import app.services.agent.discovery.loop as loop

    _write_history(tmp_path, 12)
    text = loop.load_feedback_history(tmp_path)
    lines = text.splitlines()
    # rounds 8-12 in full (with their question line), 1-7 one line each
    full = [line for line in lines if line.startswith("  question:")]
    assert len(full) == loop.FEEDBACK_FULL_ROUNDS
    compact = [line for line in lines if line.startswith("round=") and "question='q'" in line]
    assert [int(line.split()[0].split("=")[1]) for line in compact] == list(range(1, 8))

    # past the character budget the oldest candidates are counted, not shown
    monkeypatch.setattr(loop, "FEEDBACK_CHAR_BUDGET", 2500)
    _write_history(tmp_path / "long", 12, question="x" * 300)
    bounded = loop.load_feedback_history(tmp_path / "long")
    assert len(bounded) <= 2500 + 60
    assert bounded.splitlines()[0].endswith("earlier candidate(s) not shown)")
    assert "candidate=cand12" in bounded and "candidate=cand1 " not in bounded


# ── 4. the id column ─────────────────────────────────────────────────────────

def _cohort_folder(tmp_path: Path, frame: pd.DataFrame) -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    for name in frame["slide"]:
        (tmp_path / name).mkdir(exist_ok=True)
    frame.to_csv(tmp_path / "cohort.csv", index=False)
    return tmp_path


@pytest.fixture
def no_model(monkeypatch):
    import app.services.agent.discovery.workspace_scan as scan

    monkeypatch.setattr(scan, "_MODEL_ANSWERS", {})
    monkeypatch.setattr(scan, "ask_model_for_columns", lambda text, cohort: None)


def test_a_fractional_column_is_never_the_id(tmp_path, no_model):
    from app.services.agent.discovery.problem import ProblemError, parse_problem
    from app.services.agent.discovery.workspace_scan import inspect_cohort, program_problem

    slides = ["a.zarr", "b.zarr", "c.zarr"]
    data = _cohort_folder(tmp_path / "text", pd.DataFrame(
        {"slide": slides, "slope": [0.11, 0.52, 0.93], "label": ["x1", "x2", "x3"]}))
    assert inspect_cohort(data, data / "cohort.csv")["id_column"] == "label"

    data = _cohort_folder(tmp_path / "floats", pd.DataFrame({"slide": slides, "slope": [0.11, 0.52, 0.93]}))
    info = inspect_cohort(data, data / "cohort.csv")
    assert info["id_column"] is None and info["outcome_candidates"] == ["slope"]
    with pytest.raises(ProblemError, match="identifies each donor"):
        program_problem("predict slope", data)

    # a whole-number column can be the id, unless it is what the program predicts
    data = _cohort_folder(tmp_path / "ints", pd.DataFrame(
        {"slide": slides, "num": [101, 102, 103], "slope": [0.11, 0.52, 0.93]}))
    assert parse_problem(program_problem("predict slope", data)).id_column == "num"
    with pytest.raises(ProblemError, match="identifies each donor"):
        program_problem("predict num", data)


# ── 5–6. outcome and covariates from the program's words ─────────────────────

COHORT = {"outcome_candidates": ["slope", "age", "mmse"], "covariate_candidates": ["slope", "age", "mmse", "sex"]}


@pytest.mark.parametrize("text, outcome, covariates", [
    ("Among older donors (age), predict slope.", "slope", []),
    ("Predict slope independent of age.", "slope", ["age"]),
    ("Controlling for age, which features explain slope?", "slope", ["age"]),
    ("Adjusting for age and sex, predict slope", "slope", ["age", "sex"]),
    ("Find features associated with slope, conditional on age.", "slope", ["age"]),
    ("Account for sex; the target is mmse.", "mmse", ["sex"]),
    ("Does tissue predict age?", "age", []),
    ("Study age and slope.", "", []),                                   # two candidates, no cue: the model decides
    ("Explain slope. Also predict mmse.", "", []),                      # two cued outcomes: ambiguous
])
def test_outcome_and_covariates_from_the_words(text, outcome, covariates):
    from app.services.agent.discovery.workspace_scan import match_columns

    found = match_columns(text, COHORT)
    assert (found["outcome"], found["covariates"]) == (outcome, covariates)


@pytest.mark.parametrize("text", [
    "Predict slope without adjusting for age.",
    "Predict slope with no covariates.",
    "Unadjusted: predict slope.",
    "Predict slope; do not adjust for anything.",
    "预测 slope，不做校正",
])
def test_a_program_that_says_no_adjustment_gets_none(tmp_path, monkeypatch, text):
    import app.services.agent.discovery.workspace_scan as scan
    from app.services.agent.discovery.problem import parse_problem

    asked = []
    monkeypatch.setattr(scan, "_MODEL_ANSWERS", {})
    monkeypatch.setattr(scan, "ask_model_for_columns",
                        lambda t, c: asked.append(t) or {"outcome": "slope", "covariates": ["age"]})
    data = _cohort_folder(tmp_path, pd.DataFrame({
        "donor_id": ["d1", "d2", "d3"], "slide": ["a.zarr", "b.zarr", "c.zarr"],
        "slope": [0.1, 0.5, 0.9], "age": [70, 75, 80]}))
    (data / "problem.md").write_text("---\noutcome: slope\ncovariates: [age]\ncohort_file: cohort.csv\n"
                                     "slide_column: slide\n---\nold\n")
    spec = parse_problem(scan.program_problem(text, data))
    assert (spec.outcome, spec.covariates) == ("slope", ())
    assert asked == []   # decided in code: the model is not asked

    # silent about adjustment: the model still chooses the plain confounders
    spec = parse_problem(scan.program_problem("Predict slope.", data))
    assert spec.covariates == ("age",) and asked == ["Predict slope."]


# ── 7. problem.md keeps its header; one run per folder ───────────────────────

def test_a_new_program_keeps_the_saved_layout_columns(tmp_path, no_model):
    from app.services.agent.discovery.problem import parse_problem
    from app.services.agent.discovery.workspace_scan import program_problem

    data = _cohort_folder(tmp_path, pd.DataFrame({
        "donor_id": ["d1", "d2", "d3"], "case": ["c1", "c2", "c3"], "slide": ["a.zarr", "b.zarr", "c.zarr"],
        "res": [0.25, 0.25, 0.5], "slope": [0.1, 0.5, 0.9], "age": [70, 75, 80]}))
    (data / "problem.md").write_text("---\noutcome: slope\ncohort_file: cohort.csv\nid_column: case\n"
                                     "slide_column: slide\nmpp_column: res\n---\nold\n")
    spec = parse_problem(program_problem("Predict age.", data))
    assert (spec.outcome, spec.id_column, spec.slide_column, spec.mpp_column) == ("age", "case", "slide", "res")
    # a saved column that is now the outcome is not kept as the layout
    (data / "problem.md").write_text("---\noutcome: slope\ncohort_file: cohort.csv\nid_column: case\n"
                                     "slide_column: slide\nmpp_column: res\n---\nold\n")
    spec = parse_problem(program_problem("Predict res.", data))
    assert spec.outcome == "res" and spec.mpp_column == "mpp"


@pytest.fixture
def workspace(user_root):
    ws = user_root / f"discovery_fix_ws_{time.time_ns()}"
    ws.mkdir()
    (ws / "training_cohort.csv").write_text(
        "donor_id,slide_name,slope,age\nd1,d1.zarr,-0.1,80\nd2,d2.zarr,0.2,75\n", encoding="utf-8")
    for name in ("d1.zarr", "d2.zarr"):
        (ws / name).mkdir()
    return ws


@pytest.fixture
def held_loop(monkeypatch):
    import app.api.discovery as discovery_api
    import app.services.agent.discovery.run_manager as run_manager_mod

    monkeypatch.setattr(discovery_api, "unavailable_reason", lambda: None)
    monkeypatch.setattr(discovery_api, "docker_unavailable_reason", lambda: None)
    release = threading.Event()
    calls = []

    async def loop(**kwargs):
        calls.append(kwargs)
        state_path = kwargs["run_root"] / "run_state.json"
        if not state_path.exists():
            state_path.write_text(json.dumps({"next_round_id": 1, "config": {"rounds": kwargs["rounds"]}}))
        await asyncio.to_thread(release.wait, 10)
        return {"answer": "done", "status": "completed", "iterations": 1}

    monkeypatch.setattr(run_manager_mod, "run_discovery", loop)
    release.calls = calls
    yield release
    release.set()


def _events(client, run_id, **params):
    with client.stream("GET", f"{API}/runs/{run_id}/stream", params=params) as r:
        return [json.loads(line[len("data: "):]) for line in r.iter_lines() if line.startswith("data: ")]


def test_a_second_start_in_a_busy_folder_is_refused(client, workspace, held_loop):
    first = client.post(f"{API}/runs", json={"task": PROBLEM, "workspace_path": str(workspace)}).json()
    assert first["code"] == 0, first
    second = client.post(f"{API}/runs", json={"task": PROBLEM, "workspace_path": str(workspace)}).json()
    assert second["code"] == 400 and second["message"] == "A research run is already in progress in this folder."
    held_loop.set()
    _events(client, first["data"]["run_id"])
    third = client.post(f"{API}/runs", json={"task": PROBLEM, "workspace_path": str(workspace)}).json()
    assert third["code"] == 0, third
    _events(client, third["data"]["run_id"])


# ── 8. resuming a finished run needs more rounds ─────────────────────────────

def test_a_finished_run_resumes_only_with_more_rounds(client, workspace, held_loop):
    held_loop.set()
    run_root = workspace / "autoresearch_runs" / "run_done"
    run_root.mkdir(parents=True)
    (run_root / "problem.md").write_text(PROBLEM)
    (run_root / "run_state.json").write_text(json.dumps({"next_round_id": 4, "config": {"rounds": 3}}))
    body = client.post(f"{API}/runs/resume", json={"run_root_path": str(run_root)}).json()
    assert body["code"] == 400 and "finished all its rounds" in body["message"]
    body = client.post(f"{API}/runs/resume", json={"run_root_path": str(run_root), "additional_rounds": 2}).json()
    assert body["code"] == 0, body
    _events(client, "run_done")
    assert held_loop.calls[-1]["rounds"] == 2

    # an unfinished run finishes its remaining rounds
    (run_root / "run_state.json").write_text(json.dumps({"next_round_id": 2, "config": {"rounds": 3}}))
    body = client.post(f"{API}/runs/resume", json={"run_root_path": str(run_root)}).json()
    assert body["code"] == 0, body
    _events(client, "run_done")
    assert held_loop.calls[-1]["rounds"] == 2


# ── 9, 11. readable validation errors; a repeated stop is fine ───────────────

def test_invalid_settings_come_back_readable(client, workspace):
    body = client.post(f"{API}/runs", json={"task": PROBLEM, "workspace_path": str(workspace),
                                            "worker_wall_clock_sec": 60}).json()
    assert body["code"] == 422 and body["message"] == "worker_wall_clock_sec: must be ≥ 120"
    body = client.post(f"{API}/runs", json={"task": PROBLEM, "workspace_path": str(workspace),
                                            "reasoning_effort": "extreme"}).json()
    assert body["code"] == 422 and body["message"].startswith("reasoning_effort:")


def test_stopping_a_run_that_is_not_running_is_not_an_error(client):
    body = client.post(f"{API}/runs/run_not_here/cancel").json()
    assert body["code"] == 0 and body["data"] == {"cancelled": False, "reason": "not active"}


# ── 10. a stream for a run that is not running here ──────────────────────────

@pytest.mark.parametrize("state, status", [
    ({"next_round_id": 4, "config": {"rounds": 3}}, "completed"),
    ({"next_round_id": 2, "config": {"rounds": 3}}, "incomplete"),
    ({"next_round_id": 2, "config": {"rounds": 3}, "stopped": "cancelled"}, "cancelled"),
])
def test_a_stream_for_a_run_on_disk_reports_its_state(client, workspace, state, status):
    run_root = workspace / "autoresearch_runs" / "run_disk"
    run_root.mkdir(parents=True)
    (run_root / "run_state.json").write_text(json.dumps(state))
    assert _events(client, "run_disk", run_root_path=str(run_root)) == [
        {"type": "run_detached", "run_id": "run_disk", "status": status}]
    assert _events(client, "run_disk") == [{"type": "error", "message": "Run not found"}]


def test_a_cancelled_run_is_marked_on_disk_and_cleared_on_resume(tmp_path):
    from app.services.agent.discovery.loop import _load_or_init_state, mark_run_cancelled, run_status_on_disk

    (tmp_path / "run_state.json").write_text(json.dumps({"next_round_id": 2, "config": {"rounds": 3}}))
    mark_run_cancelled(tmp_path)
    assert run_status_on_disk(tmp_path) == "cancelled"
    _load_or_init_state(run_root=tmp_path, config={})
    assert run_status_on_disk(tmp_path) == "incomplete"


# ── 12–13. the loop: the winner, admitted, and infrastructure failures ───────

def _loop_workspace(tmp_path: Path) -> Path:
    data = tmp_path / "data"
    data.mkdir()
    pd.DataFrame({"donor_id": ["d1", "d2", "d3"], "slide_name": ["a.zarr", "b.zarr", "c.zarr"],
                  "slope": [0.1, 0.2, 0.3], "age": [70, 71, 72]}).to_csv(data / "training_cohort.csv", index=False)
    return data


def _spec():
    from app.services.agent.discovery.problem import parse_problem

    return parse_problem(PROBLEM)


async def _quiet(event):
    pass


def test_a_zero_rmse_winner_wins_and_results_say_who_was_admitted(tmp_path, monkeypatch):
    import app.services.agent.discovery.loop as loop

    data = _loop_workspace(tmp_path)
    monkeypatch.setattr(loop, "run_proposer", lambda **kw: {
        "candidate_id": f"cand{kw['slot']}", "variations": [{"name": "a"}], "baseline_variation": "a"})

    def fake_worker(**kwargs):
        name = kwargs["worker_brief"]["worker_name"]
        (tmp_path / name).mkdir(exist_ok=True)
        return {"worker_name": name, "worker_dir": str(tmp_path / name),
                "results_path": str(tmp_path / name / "results.json"), "summary": "ok", "results": {}}

    def fake_judge(**kwargs):
        slot = int(kwargs["worker_brief"]["worker_name"].rsplit("_", 1)[1])
        rmse = {1: 0.0, 2: 0.04}[slot]
        results = {"feature_name": f"cand{slot}", "feature_column": "a", "panel_candidate_rmse": rmse,
                   "predictive_validation_passed": True}
        return {"decision": "keep", "reason": "predictive_cv_improved", "keep": True, "chosen_variation": "a",
                "accepted_panel_rmse": rmse, "variation_summaries": [],
                "chosen_review": {"action": "add", "slot": None, "evaluation": {"results": results}}}

    monkeypatch.setattr(loop, "run_worker", fake_worker)
    monkeypatch.setattr(loop, "review_candidate", fake_judge)
    result = asyncio.run(loop.run_discovery(spec=_spec(), data_dir=data, run_root=tmp_path / "run", emit=_quiet,
                                            rounds=1, model="m", dataset_scout=False, workers_per_round=2))
    assert [m["feature_name"] for m in result["accepted_panel"]["members"]] == ["cand1"]
    winner = json.loads((tmp_path / "round_0001_worker_1" / "results.json").read_text())
    loser = json.loads((tmp_path / "round_0001_worker_2" / "results.json").read_text())
    assert winner["admitted"] is True and winner["predictive_validation_passed"] is True
    # it passed every gate, but another worker's candidate entered the panel
    assert loser["admitted"] is False and loser["predictive_validation_passed"] is True
    assert loser["decision_reason"] == "another_worker_better"


def test_two_rounds_of_infrastructure_failures_stop_the_run(tmp_path, monkeypatch):
    import app.services.agent.discovery.loop as loop

    data = _loop_workspace(tmp_path)
    proposed = []
    monkeypatch.setattr(loop, "run_proposer", lambda **kw: proposed.append(kw["round_id"]) or {
        "candidate_id": "c", "variations": [{"name": "a"}], "baseline_variation": "a"})

    def docker_down(**kwargs):
        raise RuntimeError("Docker did not start the sandbox within 60s")

    monkeypatch.setattr(loop, "run_worker", docker_down)
    with pytest.raises(RuntimeError, match="infrastructure reason in 2 rounds in a row"):
        asyncio.run(loop.run_discovery(spec=_spec(), data_dir=data, run_root=tmp_path / "run", emit=_quiet,
                                       rounds=5, model="m", dataset_scout=False))
    assert proposed == [1, 2]
    # both rounds are recorded: the run resumes from round 3
    assert json.loads((tmp_path / "run" / "run_state.json").read_text())["next_round_id"] == 3

    # a worker that wrote no result.py is the hypothesis's failure, not the infrastructure's
    def no_result(**kwargs):
        from app.services.agent.discovery.worker import NoResultProduced
        raise NoResultProduced(f"{kwargs['worker_brief']['worker_name']}: no result.py produced (turn cap)")

    monkeypatch.setattr(loop, "run_worker", no_result)
    out = asyncio.run(loop.run_discovery(spec=_spec(), data_dir=data, run_root=tmp_path / "run2", emit=_quiet,
                                         rounds=3, model="m", dataset_scout=False))
    assert out["iterations"] == 3


# ── the admission bar ────────────────────────────────────────────────────────

def test_admission_needs_a_meaningful_gain_in_4_of_5_repeats():
    from app.services.agent.discovery.panel_cv import PredictivePanelConfig, min_repeats_better

    config = PredictivePanelConfig()
    assert config.min_mean_rmse_improvement == 0.01   # 1% of the outcome's SD
    assert (config.outer_repeats, min_repeats_better(config)) == (5, 4)
    assert min_repeats_better(_fast_config(min_fraction_repeats_better_rmse=0.5)) == 1


def test_the_runs_list_shows_each_runs_question(client, workspace):
    runs_dir = workspace / "autoresearch_runs"
    for run_id, problem in (("run_q", "---\noutcome: slope\n---\n\n" + "Which cells track decline? " * 10 + "\nmore"),
                            ("run_none", None)):
        (runs_dir / run_id).mkdir(parents=True)
        (runs_dir / run_id / "run_state.json").write_text(json.dumps({"next_round_id": 1, "config": {"rounds": 1}}))
        if problem:
            (runs_dir / run_id / "problem.md").write_text(problem)
    runs = {r["run_id"]: r for r in client.get(f"{API}/runs", params={"workspace_path": str(workspace)}).json()["data"]["runs"]}
    assert runs["run_none"]["question"] is None
    question = runs["run_q"]["question"]
    assert question.startswith("Which cells track decline?") and len(question) == 120 and question.endswith("…")
