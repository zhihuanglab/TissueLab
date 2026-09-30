"""Discovery loop pieces: the problem spec, the proposer, the controller's rules,
the judge and its CV panel, the slide loaders and the data-intuition brief.

No Docker, no LLM: the sandbox and the model are stubbed; slides are small
synthetic TissueLab .zarr stores.
"""
import copy
import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import zarr

from conftest import SERVICE_DIR

DISCOVERY_DIR = SERVICE_DIR / "app" / "services" / "agent" / "discovery"

PROBLEM = """---
outcome: slope
covariates: [age, sex]
cohort_file: cases.csv
id_column: case
slide_column: slide
---
Which spatial arrangements track the slope?
"""


# ── synthetic data ────────────────────────────────────────────────────────────

def write_slide(path: Path, centroids, class_ids, class_names, regions=None, attrs=None):
    """A TissueLab .zarr with Cell-Segmentation, Cell-Classification and CustomAnnotations."""
    warnings.simplefilter("ignore")
    root = zarr.open_group(str(path), mode="w")
    if attrs:
        root.attrs.update(attrs)
    root.create_group("Cell-Segmentation").create_array("centroids", data=np.asarray(centroids, dtype=np.float32))
    cls = root.create_group("Cell-Classification")
    cls.create_array("class_indices", data=np.asarray(class_ids, dtype=np.int32))
    cls.create_group("classes").create_array("name", data=np.array([n.encode() for n in class_names], dtype="S32"))
    annotations = root.create_group("CustomAnnotations")
    for key, (label, points) in (regions or {}).items():
        group = annotations.create_group(key)
        geometry = {"target": {"selector": {"geometry": {"points": points}}}}
        a = group.create_array("annotation_json", shape=(), dtype=str)
        a[()] = json.dumps(geometry)
        c = group.create_array("comment", shape=(), dtype=str)
        c[()] = label


def make_workspace(tmp_path: Path, n: int = 6) -> Path:
    data = tmp_path / "data"
    data.mkdir()
    rng = np.random.default_rng(0)
    rows = []
    for i in range(n):
        slide = f"s{i}.zarr"
        pts = rng.uniform(0, 100, size=(60, 2))
        write_slide(
            data / slide, pts, rng.integers(0, 3, size=60), ["Alpha", "Beta", "Artefact"],
            regions={"r1": ("Inner", [[0, 0], [40, 0], [40, 40], [0, 40]]),
                     "r2": ("Outer", [[0, 0], [100, 0], [100, 100], [0, 100]])},
        )
        rows.append({"case": f"c{i}", "slide": slide, "mpp": 0.5, "slope": 0.1 * i, "age": 70 + i,
                     "sex": "F" if i % 2 else "M"})
    pd.DataFrame(rows).to_csv(data / "cases.csv", index=False)
    return data


# ── problem.md ────────────────────────────────────────────────────────────────

def test_problem_parses_header_and_question():
    from app.services.agent.discovery.problem import parse_problem

    spec = parse_problem(PROBLEM)
    assert spec.outcome == "slope" and spec.covariates == ("age", "sex")
    assert (spec.cohort_file, spec.id_column, spec.slide_column) == ("cases.csv", "case", "slide")
    assert spec.question == "Which spatial arrangements track the slope?"
    assert spec.protected_names == ["slope", "age", "sex"]


@pytest.mark.parametrize("text, message", [
    ("no header", "YAML header"),
    ("---\noutcome: y\n", "not closed"),
    ("---\noutcome: [\n---\nq", "does not parse"),
    ("---\noutcome: y\n---\n", "research question"),
    ("---\noutcome: y\ncovariates: {a: 1}\n---\nq", "list of names"),
    ("---\noutcome: y\ncovariate: [a]\n---\nq", "unknown setting"),
    ("---\noutcome: y\ncohort_file: /etc/cases.csv\n---\nq", "inside the data folder"),
    ("---\noutcome: y\ncohort_file: ../cases.csv\n---\nq", "inside the data folder"),
])
def test_problem_errors_are_specific(text, message):
    from app.services.agent.discovery.problem import ProblemError, parse_problem

    with pytest.raises(ProblemError, match=message):
        parse_problem(text)


def test_problem_is_checked_against_the_data(tmp_path):
    from app.services.agent.discovery.problem import ProblemError, parse_problem, validate_against_data

    data = make_workspace(tmp_path)
    spec = parse_problem(PROBLEM)
    assert len(validate_against_data(spec, data)) == 6

    cohort = pd.read_csv(data / "cases.csv")
    cohort.loc[0, "slope"] = None
    cohort.to_csv(data / "cases.csv", index=False)
    with pytest.raises(ProblemError, match="numeric with no missing"):
        validate_against_data(spec, data)
    with pytest.raises(ProblemError, match="Cohort file not found"):
        validate_against_data(parse_problem(PROBLEM.replace("cases.csv", "nope.csv")), data)


def test_cohort_file_name_must_match_the_disk_exactly(tmp_path):
    # On a case-insensitive filesystem Cases.csv would open cases.csv, while the
    # sandbox overlay shadows only the literal name: the real file would leak.
    from app.services.agent.discovery.problem import ProblemError, parse_problem, validate_against_data

    data = make_workspace(tmp_path)
    with pytest.raises(ProblemError, match="case-sensitive"):
        validate_against_data(parse_problem(PROBLEM.replace("cases.csv", "Cases.csv")), data)


def test_covariates_the_judge_cannot_use_are_rejected_up_front(tmp_path):
    from app.services.agent.discovery.problem import ProblemError, parse_problem, validate_against_data

    data = make_workspace(tmp_path)
    cohort = pd.read_csv(data / "cases.csv")
    cohort["sex"] = ["F", "M", "F", "unknown", "M", "F"]
    cohort.to_csv(data / "cases.csv", index=False)
    with pytest.raises(ProblemError, match="Unsupported sex values"):
        validate_against_data(parse_problem(PROBLEM), data)


def test_numeric_ids_keep_their_text(tmp_path):
    from app.services.agent.discovery.problem import load_cohort, parse_problem
    from app.services.agent.discovery.shared_lib_source.shared_analysis.slides import donor_ids

    data = make_workspace(tmp_path)
    cohort = pd.read_csv(data / "cases.csv")
    cohort["case"] = [f"{i:03d}" for i in range(len(cohort))]
    cohort.to_csv(data / "cases.csv", index=False)
    spec = parse_problem(PROBLEM)
    assert load_cohort(spec, data)["case"].tolist()[:2] == ["000", "001"]
    assert donor_ids(data, spec.dataset_layout())[:2] == ["000", "001"]


def test_sandbox_cohort_copy_holds_no_outcome_or_covariates(tmp_path):
    from app.services.agent.discovery.problem import parse_problem, write_public_cohort

    data = make_workspace(tmp_path)
    out = write_public_cohort(parse_problem(PROBLEM), data, tmp_path / "public.csv")
    assert list(pd.read_csv(out).columns) == ["case", "slide", "mpp"]


def test_system_prompts_and_code_carry_no_dataset_specifics():
    """Everything dataset-specific belongs in problem.md, never in the system."""
    banned = ["slope_zmem0", "SEA-AD", "sea_ad", "CA1", "Astrocyte", "Pyramidal", "braak", "cerad",
              "max_age_vis", "Corpora", "Lymphocyte", "A12-LFB", "35 donors", "hippocamp"]
    sources = {p.relative_to(DISCOVERY_DIR).as_posix(): p.read_text(encoding="utf-8")
               for p in DISCOVERY_DIR.rglob("*") if p.suffix in {".py", ".md"} and "__pycache__" not in p.parts}
    hits = [(name, word) for name, text in sources.items() for word in banned
            if word.lower() in text.lower() and name != "problem.py"]
    assert hits == []


# ── the controller's rules ────────────────────────────────────────────────────

def test_outcome_references_scan_scripts_and_commands(tmp_path):
    from app.services.agent.discovery.worker import outcome_references

    (tmp_path / "result.py").write_text("x = df['slope']\nage_bins = 3\n")
    (tmp_path / "turn_01.command.sh").write_text("grep sex /data/cases.csv\n")
    hits = outcome_references(tmp_path, [tmp_path / "result.py"], ["slope", "age", "sex"])
    assert hits == ["result.py:1: x = df['slope']", "turn_01.command.sh:1: grep sex /data/cases.csv"]


# ── proposer ──────────────────────────────────────────────────────────────────

PLAN = {
    "candidate_id": "pilot",
    "scientific_question": "Q?",
    "rationale": "r",
    "approach": "a",
    "variations": [{"name": "a", "expected_sign": -1}, {"name": "b", "expected_sign": -1}, {"name": "c", "expected_sign": 1}],
    "baseline_variation": "a",
}


def _resp(rid, *, tool_command=None, text="", usage_in=10):
    output = [{"type": "reasoning", "summary": [{"type": "summary_text", "text": f"think {rid}"}]}]
    if tool_command is not None:
        output.append({"type": "custom_tool_call", "name": "shell_exec", "call_id": f"call_{rid}", "input": tool_command})
    if text:
        output.append({"type": "message", "content": [{"type": "output_text", "text": text}]})
    return {"id": rid, "model": "gpt-test", "output": output,
            "usage": {"input_tokens": usage_in, "output_tokens": 5, "input_tokens_details": {"cached_tokens": 3},
                      "output_tokens_details": {"reasoning_tokens": 2}}}


def _run_proposer(monkeypatch, tmp_path, responses, **extra):
    from app.services.agent.discovery import proposer
    from app.services.agent.discovery.problem import parse_problem

    it = iter(responses)
    requests = []

    def fake_create(payload, timeout=0):
        requests.append(payload)
        return next(it)

    monkeypatch.setattr(proposer, "responses_create", fake_create)
    plan = proposer.run_proposer(
        round_dir=tmp_path / "round_0001", spec=parse_problem(PROBLEM), dataset_guide_text="GUIDE: classes Alpha, Beta",
        accepted_panel_summary={"members": []}, results_log_text="", round_id=1,
        model="gpt-test", reasoning_effort="high", **extra,
    )
    return plan, requests


def test_proposer_is_one_call_with_the_question_and_the_guide(monkeypatch, tmp_path):
    plan, requests = _run_proposer(monkeypatch, tmp_path, [_resp("r1", text=json.dumps(PLAN))])
    assert plan["candidate_id"] == "pilot" and len(requests) == 1
    assert "tools" not in requests[0]   # it never touches the data
    assert "Which spatial arrangements track the slope?" in requests[0]["instructions"]
    assert "GUIDE: classes Alpha, Beta" in requests[0]["instructions"]
    assert plan["proposer_usage"]["calls"] == 1 and plan["proposer_reasoning_summary"] == ["think r1"]
    assert (tmp_path / "round_0001" / "proposer" / "slot_1" / "turn_01.response.json").exists()


def test_a_later_worker_is_told_what_was_already_proposed(monkeypatch, tmp_path):
    earlier = {"candidate_id": "first", "scientific_question": "q1", "approach": "a1"}
    _, requests = _run_proposer(monkeypatch, tmp_path, [_resp("r1", text=json.dumps(PLAN))],
                                proposed_this_round=[earlier], slot=2)
    payload = json.loads(requests[0]["input"].split("\n\n")[0])
    assert payload["already_proposed_this_round"] == [earlier]
    assert (tmp_path / "round_0001" / "proposer" / "slot_2").is_dir()


def test_proposer_is_nudged_for_json_and_missing_signs(monkeypatch, tmp_path):
    unsigned = copy.deepcopy(PLAN)
    for v in unsigned["variations"]:
        v.pop("expected_sign")
    plan, requests = _run_proposer(monkeypatch, tmp_path, [
        _resp("r1", text="Region Inner looks interesting."),
        _resp("r2", text=json.dumps(unsigned)),
        _resp("r3", text=json.dumps(PLAN)),
    ])
    assert "exactly one JSON object" in requests[1]["input"]
    assert "expected_sign" in requests[2]["input"] and "slope" in requests[2]["input"]
    assert [v["expected_sign"] for v in plan["variations"]] == [-1, -1, 1]


def test_plan_normalization_and_sign_parsing():
    from app.services.agent.discovery.proposer import normalize_plan, parse_expected_sign as p

    assert (p(-1), p(1.0), p("+1"), p("negative")) == (-1, 1, 1, -1)
    assert p(0) is None and p(None) is None and p("maybe") is None
    plan = normalize_plan(
        {"candidate_id": "c", "expected_sign": -1,
         "variations": [{"name": "a"}, {"name": "donor_id"}, {"name": "not valid"}, {"name": "b", "expected_sign": 1}]},
        round_id=1,
    )
    # table columns: identifiers only, never the donor_id key
    assert [(v["name"], v["expected_sign"]) for v in plan["variations"]] == [("a", -1), ("b", 1)]
    assert normalize_plan({}, round_id=4)["candidate_id"] == "candidate_round_0004"


def test_feedback_reports_panel_full_and_refuted_direction():
    from app.services.agent.discovery.loop import build_round_feedback, render_feedback_text

    review = {
        "panel_full": True, "current_panel_size": 5, "max_panel_size": 5, "chosen_variation": "v",
        "variation_summaries": [{
            "variation": "v", "is_primary": True, "coverage": 1.0, "partial_r": 0.4, "expected_sign": -1,
            "observed_sign": 1, "best_action": "replace_slot_2", "best_action_replaced_feature": "member_two",
            "gates": {"expected_sign": False}, "cv_gates_passed": 0, "cv_gates_total": 6, "eligible": False,
        }],
    }
    fb = build_round_feedback(round_id=3, plan={"candidate_id": "c"}, worker_status="completed",
                              decision="discard", reason="predictive_cv_gates_failed", review=review)
    text = render_feedback_text(fb)
    assert "PANEL FULL (5/5)" in text
    assert "tested_as=replace_slot_2 (member_two)" in text
    assert "UNEXPECTED_DIRECTION(expected -1, observed +1" in text


# ── judge ─────────────────────────────────────────────────────────────────────

def synthetic_cohort(n: int = 35) -> pd.DataFrame:
    rng = np.random.default_rng(17)
    signal = rng.normal(size=n)
    return pd.DataFrame({
        "case": [f"D{index:03d}" for index in range(n)],
        "slope": -0.1 + 0.045 * signal + rng.normal(scale=0.01, size=n),
        "age": rng.normal(87, 5, size=n),
        "sex": np.where(np.arange(n) % 2, "Male", "Female"),
        "candidate_signal": signal,
    })


def _fast_config(**overrides):
    """The judge's logic at a fraction of the fitting: few repeats and folds, one alpha."""
    from app.services.agent.discovery.panel_cv import PredictivePanelConfig

    return PredictivePanelConfig(**{"outer_repeats": 2, "inner_folds": 2, "ridge_alphas": (1.0,), **overrides})


def test_cv_panel_rewards_a_real_signal():
    from app.services.agent.discovery.panel_cv import PredictivePanelConfig, compare_predictive_panels

    frame = synthetic_cohort().rename(columns={"case": "donor_id"})
    comparison = compare_predictive_panels(
        frame, outcome_column="slope", covariates=["age", "sex"], baseline_feature_columns=[],
        candidate_feature_columns=["candidate_signal"],
        config=_fast_config(min_mean_rmse_improvement=0.0, min_fraction_repeats_better_rmse=0.5),
    )
    assert comparison["acceptance_passed"] and comparison["mean_rmse_improvement"] > 0
    defaults = PredictivePanelConfig()
    assert (defaults.max_panel_size, defaults.outer_repeats, defaults.seed) == (5, 5, 20260821)


@pytest.mark.parametrize("numeric_ids", [False, True])
def test_judge_admits_a_signed_variation_using_the_problems_columns(tmp_path, numeric_ids):
    from app.services.agent.discovery.judge import review_candidate
    from app.services.agent.discovery.problem import parse_problem

    data = tmp_path / "data"
    round_dir = tmp_path / "run" / "round_0001"
    worker_dir = round_dir / "round_0001_worker"
    (worker_dir / "sandbox").mkdir(parents=True)
    data.mkdir()
    cohort = synthetic_cohort()
    if numeric_ids:   # "000".."034": read back as integers unless kept as text
        cohort["case"] = [f"{i:03d}" for i in range(len(cohort))]
    cohort.drop(columns="candidate_signal").assign(slide="x.zarr").to_csv(data / "cases.csv", index=False)
    cohort.rename(columns={"case": "donor_id"}).loc[:, ["donor_id", "candidate_signal"]].to_csv(
        worker_dir / "sandbox" / "donor_feature_table.csv", index=False)
    spec = parse_problem("---\noutcome: slope\ncovariates: [age, sex]\ncohort_file: cases.csv\nid_column: case\n"
                         "slide_column: slide\n---\nq")

    def review(sign):
        return review_candidate(
            accepted_panel={"members": []},
            worker_brief={"baseline_variation": "candidate_signal",
                          "variations": [{"name": "candidate_signal", "expected_sign": sign}]},
            worker_roundup={"status": "completed", "worker_dir": str(worker_dir),
                            "results": {"feature_column": "candidate_signal",
                                        "artifacts": {"donor_feature_table": "/scratch/donor_feature_table.csv"}}},
            data_dir=data, spec=spec, round_dir=round_dir,
            config=_fast_config(min_mean_rmse_improvement=0.0, min_fraction_repeats_better_rmse=0.5),
        )

    kept = review(+1)
    assert kept["keep"]
    assert kept["keep"] and kept["chosen_variation"] == "candidate_signal"
    assert (round_dir / "predictive_cv_review.json").exists()
    assert json.loads((round_dir / "predictive_cv_review.json").read_text())["covariates"] == ["age", "sex"]
    refuted = review(-1)   # the declared direction is wrong: the same signal is not admitted
    assert not refuted["keep"]
    assert refuted["variation_summaries"][0]["gates"]["expected_sign"] is False


# ── slides and the data-intuition brief ───────────────────────────────────────

def test_cell_table_reads_classes_and_assigns_the_smallest_region(tmp_path):
    from app.services.agent.discovery.shared_lib_source.shared_analysis.slides import build_cell_table

    write_slide(
        tmp_path / "s.zarr", [[5, 5], [30, 30], [200, 200]], [0, 1, -1], ["Alpha", "Beta"],
        regions={"big": ("Outer", [[0, 0], [100, 0], [100, 100], [0, 100]]),
                 "small": ("Inner", [[0, 0], [10, 0], [10, 10], [0, 10]])},
    )
    cells = build_cell_table(tmp_path / "s.zarr")
    assert cells["cell_type"].tolist() == ["Alpha", "Beta", "unclassified"]
    assert cells["region"].tolist()[:2] == ["Inner", "Outer"] and cells["region"].isna().tolist() == [False, False, True]


def test_slide_metadata_takes_mpp_from_the_cohort_then_the_zarr(tmp_path):
    from app.services.agent.discovery.shared_lib_source.shared_analysis.slides import load_slide_metadata, slide_path

    write_slide(tmp_path / "a.zarr", [[0, 0]], [0], ["A"], attrs={"mpp": 0.25})
    write_slide(tmp_path / "b.zarr", [[0, 0]], [0], ["A"])
    pd.DataFrame({"case": ["a", "b"], "slide": ["a.zarr", "b.zarr"], "res": [None, 0.5]}).to_csv(tmp_path / "c.csv", index=False)
    layout = {"cohort_file": "c.csv", "id_column": "case", "slide_column": "slide", "mpp_column": "res"}
    assert slide_path(tmp_path, "b", layout) == tmp_path / "b.zarr"
    assert load_slide_metadata(tmp_path, "b", layout)["mpp_x"] == 0.5
    assert load_slide_metadata(tmp_path, "a", layout)["mpp_x"] == 0.25


# ── sandbox mounts ────────────────────────────────────────────────────────────

def test_sandbox_mounts_symlinks_and_masks_earlier_runs(tmp_path):
    from app.services.agent.discovery.sandbox import SandboxSession

    data = tmp_path / "data"
    (data / "slides").mkdir(parents=True)
    target = tmp_path / "elsewhere" / "donor.svs"
    target.parent.mkdir()
    target.write_bytes(b"slide")
    (data / "slides" / "donor.svs").symlink_to(target)
    runs = data / "autoresearch_runs" / "run_old"
    runs.mkdir(parents=True)
    (runs / "linked").symlink_to(target)   # inside the masked folder: must not be walked

    mounts = SandboxSession(tmp_path / "scratch", data_dir=data)._data_mounts()
    assert mounts[:2] == ["-v", f"{data.resolve()}:/data:ro"]
    assert ["-v", f"{target.resolve()}:/data/slides/donor.svs:ro"] == mounts[2:4]
    assert mounts[4:] == ["--tmpfs", "/data/autoresearch_runs:ro,size=64k"]


def test_sandbox_skips_a_symlink_that_an_overlay_replaces(tmp_path):
    from app.services.agent.discovery.sandbox import SandboxSession

    data = tmp_path / "data"
    data.mkdir()
    real = tmp_path / "cohort_real.csv"
    real.write_text("donor_id,slide_name,y\n")
    (data / "cases.csv").symlink_to(real)
    public = tmp_path / "public.csv"
    public.write_text("donor_id,slide_name\n")
    box = SandboxSession(tmp_path / "scratch", data_dir=data, file_overlays={"/data/cases.csv": public})
    # docker refuses a duplicate mount point; the overlay alone must claim the path
    assert not any("/data/cases.csv" in m for m in box._data_mounts())


def test_sandbox_start_cleans_up_a_half_started_container(tmp_path, monkeypatch):
    from app.services.agent.discovery import sandbox

    box = sandbox.SandboxSession(tmp_path / "scratch", data_dir=tmp_path)
    removed = []

    def fake_start_docker():
        box.container_name, box.started = "tl-discovery-x", True

    def failing_runtime():
        raise TimeoutError("runtime did not come up")

    monkeypatch.setattr(box, "_start_docker", fake_start_docker)
    monkeypatch.setattr(box, "_start_docker_runtime", failing_runtime)
    monkeypatch.setattr(sandbox, "_remove_containers", removed.extend)
    with pytest.raises(TimeoutError):
        box.start()
    assert removed == ["tl-discovery-x"] and not box.started


def test_sandbox_keeps_what_the_controller_trusts_read_only(tmp_path, monkeypatch):
    from app.services.agent.discovery import sandbox

    shared = tmp_path / "shared"
    (shared / "lib").mkdir(parents=True)
    (shared / "dataset.json").write_text("{}")
    box = sandbox.SandboxSession(tmp_path / "scratch", data_dir=tmp_path, shared_dir=shared)
    seen = {}
    monkeypatch.setattr(box, "_ensure_docker_image", lambda: None)
    monkeypatch.setattr(sandbox.subprocess, "run",
                        lambda cmd, **kw: seen.setdefault("cmd", cmd) and sandbox.subprocess.CompletedProcess(cmd, 0, "", ""))
    box._start_docker()
    cmd = " ".join(seen["cmd"])
    assert f"{shared.resolve()}:/shared:rw" in cmd
    assert f"{shared.resolve() / 'lib'}:/shared/lib:ro" in cmd
    assert f"{shared.resolve() / 'dataset.json'}:/shared/dataset.json:ro" in cmd
