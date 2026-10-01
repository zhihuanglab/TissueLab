"""What starting a run from a plain-text program works out: the cohort files in a data
folder, which of their columns look like the id / slide / mpp columns, which
could be the outcome or covariates, and which of those a free-text program
names — so problem.md's header is written for the user, not by them.

Host-side only: none of this reaches the agents (they get
problem.md, and inside the sandbox the id / slide / mpp columns alone). The one
model call here (resolving plain words to columns) sees column names, never values.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional

import pandas as pd

from .panel_cv import covariate_matrix
from .problem import (
    PROBLEM_FILENAME,
    ProblemError,
    ProblemSpec,
    _relative_inside,
    compose_problem,
    parse_problem,
)

MAX_COHORT_FILES = 20
MAX_COHORT_BYTES = 50 * 1024 * 1024
_DEFAULT_SPEC = ProblemSpec(outcome="-", question="-")

_ID_NAME = re.compile(r"(^|_)(id|case|donor|patient|subject|sample|participant)s?($|_)", re.IGNORECASE)
_SLIDE_NAME = re.compile(r"slide|zarr|path|file|image|wsi", re.IGNORECASE)


def _column_info(values: pd.Series) -> dict[str, Any]:
    present = values.dropna()
    present = present[present.str.strip() != ""]
    numbers = pd.to_numeric(present, errors="coerce")
    numeric = len(present) > 0 and bool(numbers.notna().all())
    info: dict[str, Any] = {
        "name": str(values.name),
        "numeric": numeric,
        "missing": int(len(values) - len(present)),
        "unique": int(present.nunique()),
        "examples": [str(v)[:40] for v in present.unique()[:3]],
    }
    if numeric:
        info["min"] = float(numbers.min())
        info["max"] = float(numbers.max())
    return info


def _judge_accepts_covariate(frame: pd.DataFrame, name: str) -> bool:
    """Whether the judge can adjust for this column (numeric and complete, or a sex column)."""
    try:
        covariate_matrix(frame, [name])
    except ValueError:
        return False
    return True


def _slides_found(data_dir: Path, values: pd.Series) -> int:
    found = 0
    for value in values.dropna().unique():
        try:
            rel = _relative_inside(str(value).strip(), "slide")
        except ProblemError:
            continue
        if (data_dir / rel).exists():
            found += 1
    return found


def inspect_cohort(data_dir: Path, path: Path) -> Optional[dict[str, Any]]:
    """One CSV as the panel shows it, or None when it is not a readable table."""
    if path.stat().st_size > MAX_COHORT_BYTES:
        return None
    try:
        frame = pd.read_csv(path, dtype=str, keep_default_na=True)
    except Exception:
        return None
    if frame.empty or len(frame.columns) < 2:
        return None
    columns = [_column_info(frame[c]) for c in frame.columns]

    # Slide column: the one whose values name the most existing paths here.
    slide_scores = {c: _slides_found(data_dir, frame[c]) for c in frame.columns}
    slide_column = max(
        frame.columns,
        key=lambda c: (slide_scores[c], bool(_SLIDE_NAME.search(c))),
    )
    if slide_scores[slide_column] == 0:
        slide_column = None

    # Id column: complete and unique, preferring a name that says so.
    unique = [
        info["name"] for info in columns
        if info["name"] != slide_column and info["missing"] == 0 and info["unique"] == len(frame)
    ]
    id_column = next((c for c in unique if _ID_NAME.search(c)), unique[0] if unique else None)

    mpp_column = next(
        (info["name"] for info in columns if "mpp" in info["name"].lower() and info["numeric"]),
        None,
    )
    reserved = {id_column, slide_column, mpp_column}
    outcomes = [
        info["name"] for info in columns
        if info["name"] not in reserved and info["numeric"] and info["missing"] == 0 and info["unique"] > 1
    ]
    covariates = [
        info["name"] for info in columns
        if info["name"] not in reserved and info["unique"] > 1 and _judge_accepts_covariate(frame, info["name"])
    ]
    return {
        "file": path.relative_to(data_dir).as_posix(),
        "rows": int(len(frame)),
        "columns": columns,
        "id_column": id_column,
        "slide_column": slide_column,
        "mpp_column": mpp_column,
        "slides_found": slide_scores[slide_column] if slide_column else 0,
        "outcome_candidates": outcomes,
        "covariate_candidates": covariates,
    }


def scan_workspace(data_dir: Path) -> dict[str, Any]:
    csvs = sorted(
        p for p in data_dir.iterdir()
        if p.is_file() and p.suffix.lower() == ".csv" and not p.name.startswith(".")
    )[:MAX_COHORT_FILES]
    cohorts = [info for info in (inspect_cohort(data_dir, p) for p in csvs) if info]
    # Most slides matched first: that is the cohort file.
    cohorts.sort(key=lambda c: (-c["slides_found"], c["file"]))
    return {"cohorts": cohorts}


# ─── The research program in plain words -> outcome / covariates ───────────────
#
# The panel takes one free-text program, as it always did; the judge still needs
# to know which cohort column to predict and which to adjust for. They are read
# off the text by matching the cohort's column names; whatever the text leaves
# open, the model chooses from the column names alone (never a value). Starting a
# run turns the result into problem.md's header.

_ADJUST = re.compile(
    r"adjust|control(?:ling|led)?\s+for|account(?:ing)?\s+for|covariat|confound|correct(?:ing)?\s+for"
    r"|校正|调整|控制|协变量|混杂",
    re.IGNORECASE,
)
_SENTENCE_END = re.compile(r"[.;!?\n。；！？]")


def _mention(text: str, column: str) -> Optional[int]:
    """Where the text names the column (as written, or with _ as space / -)."""
    positions = []
    for variant in {column, column.replace("_", " "), column.replace("_", "-")}:
        match = re.search(rf"(?<![A-Za-z0-9_]){re.escape(variant)}(?![A-Za-z0-9_])", text, re.IGNORECASE)
        if match:
            positions.append(match.start())
    return min(positions) if positions else None


def match_columns(text: str, cohort: dict[str, Any]) -> dict[str, Any]:
    """Outcome and covariates named in the text; columns after "adjust for" etc.
    (in the same sentence) are covariates, the first other outcome-capable column
    is the outcome."""
    mentioned = {}
    for name in cohort["covariate_candidates"]:
        at = _mention(text, name)
        if at is not None:
            mentioned[name] = at
    adjust_spans = []
    for kw in _ADJUST.finditer(text):
        end = _SENTENCE_END.search(text, kw.end())
        adjust_spans.append((kw.start(), end.start() if end else len(text)))
    covariates = [
        name for name, at in sorted(mentioned.items(), key=lambda kv: kv[1])
        if any(start <= at < stop for start, stop in adjust_spans)
    ]
    outcomes = [
        name for name, at in sorted(mentioned.items(), key=lambda kv: kv[1])
        if name in cohort["outcome_candidates"] and name not in covariates
    ]
    return {"outcome": outcomes[0] if outcomes else "", "covariates": covariates}


_ASK_MODEL = """You set up a predictive analysis from a research program and a cohort table's column names.

Research program:
{question}

Columns that can be the outcome (numeric, complete): {outcomes}
Columns that can be covariates (numeric, complete, or sex): {covariates}

Choose:
- "outcome": the column the program wants to predict or explain. If the program names or describes it,
  use that column. If it does not, choose the most plausible primary target among the outcome columns
  (not an identifier, a demographic, or a technical/batch variable).
- "covariates": the columns the program says to adjust or control for. If it says none, choose the
  plain confounders among the covariate columns (demographics such as age or sex), never another
  candidate outcome. May be empty.

Return JSON only: {{"outcome": "<column>", "covariates": ["<column>", ...]}}. Use exact column names
from the lists; map plain words to them (e.g. "age" -> "age_years") when the match is clear."""


def ask_model_for_columns(text: str, cohort: dict[str, Any]) -> Optional[dict[str, Any]]:
    """The model's reading of the text, restricted to the cohort's columns; None when unavailable."""
    from .client import discovery_model, output_text, responses_create, unavailable_reason

    if unavailable_reason():
        return None
    prompt = _ASK_MODEL.format(
        question=text.strip()[:4000],
        outcomes=", ".join(cohort["outcome_candidates"]) or "(none)",
        covariates=", ".join(cohort["covariate_candidates"]) or "(none)",
    )
    try:
        reply = output_text(responses_create({"model": discovery_model(), "input": prompt}, timeout=60))
        found = re.search(r"\{.*\}", reply, re.DOTALL)
        data = json.loads(found.group(0)) if found else {}
    except Exception:
        return None
    outcome = data.get("outcome") if data.get("outcome") in cohort["outcome_candidates"] else ""
    covariates = [
        c for c in (data.get("covariates") or [])
        if isinstance(c, str) and c in cohort["covariate_candidates"] and c != outcome
    ]
    return {"outcome": outcome, "covariates": list(dict.fromkeys(covariates))}


_MODEL_ANSWERS: dict[tuple, dict[str, Any]] = {}
_MODEL_ANSWERS_MAX = 64


def _ask_model_cached(text: str, outcomes: tuple[str, ...], covariates: tuple[str, ...]) -> Optional[dict[str, Any]]:
    """The same program asks once per process (answers only — a failed call is asked again)."""
    key = (text, outcomes, covariates)
    if key not in _MODEL_ANSWERS:
        answer = ask_model_for_columns(text, {"outcome_candidates": list(outcomes), "covariate_candidates": list(covariates)})
        if answer is None:
            return None
        if len(_MODEL_ANSWERS) >= _MODEL_ANSWERS_MAX:
            _MODEL_ANSWERS.pop(next(iter(_MODEL_ANSWERS)))
        _MODEL_ANSWERS[key] = answer
    return _MODEL_ANSWERS[key]


def resolve_program(text: str, data_dir: Path, cohort_file: Optional[str] = None, use_model: bool = True) -> dict[str, Any]:
    """What a free-text program names on this folder's data: the cohort table used
    (the given one if it is here, else the best match; None when there is none),
    and the outcome / covariates read off the text or, for what it leaves open,
    chosen by the model."""
    cohorts = scan_workspace(data_dir)["cohorts"]
    cohort = next((c for c in cohorts if c["file"] == cohort_file), cohorts[0] if cohorts else None)
    if cohort is None:
        return {"cohort": None, "outcome": "", "covariates": []}
    found = match_columns(text, cohort)
    if use_model and text.strip() and (not found["outcome"] or not found["covariates"]):
        asked = _ask_model_cached(text.strip(), tuple(cohort["outcome_candidates"]), tuple(cohort["covariate_candidates"]))
        if asked:
            if not found["outcome"]:
                found["outcome"] = asked["outcome"]
            if not found["covariates"]:
                found["covariates"] = [c for c in asked["covariates"] if c != found["outcome"]]
    return {"cohort": cohort, **found}


def _saved_problem(data_dir: Path) -> Optional[ProblemSpec]:
    """The workspace's problem.md (the last run's problem), if it parses."""
    try:
        return parse_problem((data_dir / PROBLEM_FILENAME).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ProblemError):
        return None


def program_problem(text: str, data_dir: Path) -> str:
    """problem.md for a plain-text program: its header worked out from the cohort
    table. What the text (or the model) leaves open comes from the saved
    problem.md when it used the same table, or is the table's only candidate.
    Raises ProblemError with what to do when no outcome can be chosen."""
    question = text.strip()
    if not question:
        raise ProblemError("Describe the research program first")
    saved = _saved_problem(data_dir)
    found = resolve_program(question, data_dir, saved.cohort_file if saved else None)
    cohort = found["cohort"]
    if cohort is None:
        raise ProblemError("No patient table (CSV) found in this folder")
    candidates = cohort["outcome_candidates"]
    if not candidates:
        raise ProblemError(
            f"No column can be predicted: it must be numeric with a value in every row of {cohort['file']}"
        )
    same_table = saved if saved is not None and saved.cohort_file == cohort["file"] else None
    outcome = found["outcome"]
    if not outcome and same_table and same_table.outcome in candidates:
        outcome = same_table.outcome
    if not outcome and len(candidates) == 1:
        outcome = candidates[0]
    if not outcome:
        raise ProblemError(
            f'Couldn\'t tell which column to predict. Name it in the program, e.g. "predict {candidates[0]}". '
            f"Columns: {', '.join(candidates)}"
        )
    covariates = found["covariates"] or (
        [c for c in same_table.covariates if c in cohort["covariate_candidates"]] if same_table else []
    )
    return compose_problem({
        "outcome": outcome,
        "question": question,
        "covariates": [c for c in dict.fromkeys(covariates) if c != outcome],
        "cohort_file": cohort["file"],
        "id_column": cohort["id_column"] or _DEFAULT_SPEC.id_column,
        "slide_column": cohort["slide_column"] or _DEFAULT_SPEC.slide_column,
        "mpp_column": cohort["mpp_column"] or _DEFAULT_SPEC.mpp_column,
    })
