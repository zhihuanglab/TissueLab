"""What the Research panel offers before a run: the cohort files in a data folder,
which of their columns look like the id / slide / mpp columns, and which could
be the outcome or covariates — so problem.md's header is picked from menus, not
typed.

Host-side and for the panel only: none of this reaches the agents (they get
problem.md, and inside the sandbox the id / slide / mpp columns alone).
"""
from __future__ import annotations

import re
from pathlib import Path, PurePosixPath
from typing import Any, Optional

import pandas as pd

from .problem import ProblemSpec, ProblemError, _relative_inside
from .sandbox import RUNS_DIRNAME

MAX_COHORT_FILES = 20
MAX_COHORT_BYTES = 50 * 1024 * 1024
MAX_SLIDES_LISTED = 2000
TEMPLATE_COHORT = ProblemSpec(outcome="-", question="-").cohort_file

_ID_NAME = re.compile(r"(^|_)(id|case|donor|patient|subject|sample|participant)s?($|_)", re.IGNORECASE)
_SLIDE_NAME = re.compile(r"slide|zarr|path|file|image|wsi", re.IGNORECASE)
_SLIDE_SUFFIX = ".zarr"


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
    covariates = [info["name"] for info in columns if info["name"] not in reserved and info["unique"] > 1]
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


def find_slides(data_dir: Path) -> list[str]:
    """.zarr stores in the folder and one level down (relative paths)."""
    found: list[str] = []
    for level in (data_dir.iterdir(), *(p.iterdir() for p in data_dir.iterdir() if _is_subfolder(p))):
        for entry in level:
            if entry.is_dir() and entry.name.endswith(_SLIDE_SUFFIX):
                found.append(entry.relative_to(data_dir).as_posix())
    return sorted(found)[:MAX_SLIDES_LISTED]


def _is_subfolder(path: Path) -> bool:
    return (
        path.is_dir()
        and not path.name.startswith(".")
        and not path.name.endswith(_SLIDE_SUFFIX)
        and path.name != RUNS_DIRNAME
    )


def scan_workspace(data_dir: Path) -> dict[str, Any]:
    csvs = sorted(
        p for p in data_dir.iterdir()
        if p.is_file() and p.suffix.lower() == ".csv" and not p.name.startswith(".")
    )[:MAX_COHORT_FILES]
    cohorts = [info for info in (inspect_cohort(data_dir, p) for p in csvs) if info]
    # Most slides matched first: that is the cohort file.
    cohorts.sort(key=lambda c: (-c["slides_found"], c["file"]))
    return {"cohorts": cohorts, "slides": find_slides(data_dir)}


def problem_fields(spec: ProblemSpec) -> dict[str, Any]:
    """A parsed problem.md as the panel's form holds it."""
    return {
        "outcome": spec.outcome,
        "question": spec.question,
        "covariates": list(spec.covariates),
        "cohort_file": spec.cohort_file,
        "id_column": spec.id_column,
        "slide_column": spec.slide_column,
        "mpp_column": spec.mpp_column,
        "excluded_classes": list(spec.excluded_classes),
        "exclude_only_classes": list(spec.exclude_only_classes),
    }


def _donor_id(slide: str) -> str:
    """P001.svs.zarr -> P001."""
    name = PurePosixPath(slide).name
    return name.split(".", 1)[0] or name


def write_cohort_template(data_dir: Path) -> str:
    """Start a cohort file from the slides here: one row per slide, the outcome to fill in."""
    target = data_dir / TEMPLATE_COHORT
    if target.exists():
        raise ProblemError(f"{TEMPLATE_COHORT} already exists in this folder")
    slides = find_slides(data_dir)
    if not slides:
        raise ProblemError("No .zarr slides in this folder (or one level down) to list")
    ids = [_donor_id(s) for s in slides]
    if len(set(ids)) != len(ids):
        ids = [PurePosixPath(s).with_suffix("").as_posix().replace("/", "_") for s in slides]
    frame = pd.DataFrame({"donor_id": ids, "slide_name": slides, "outcome": [""] * len(slides)})
    frame.to_csv(target, index=False)
    return TEMPLATE_COHORT
