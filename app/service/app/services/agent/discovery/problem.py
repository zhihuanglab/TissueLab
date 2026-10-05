"""Resolved research settings and optional program.md YAML frontmatter.

Everything dataset-specific lives here, never in the system prompts or code
defaults: which cohort column is the outcome, which covariates every
comparison adjusts for, and where the cohort file and slides are. Example:

    ---
    outcome: slope_zmem0
    covariates: [max_age_vis, sex, braak_numeric, cerad_ordinal]
    cohort_file: training_cohort.csv
    id_column: donor_id
    slide_column: slide_name
    ---
    Find donor-level tissue measurements that predict ...

The outcome and covariates are read host-side by the judge only; inside the
sandbox the cohort file is replaced by a copy holding just the identifier,
slide and mpp columns.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Any

import pandas as pd
import yaml

PROGRAM_FILENAME = "program.md"
RUN_CONFIG_FILENAME = "run_config.json"
EXAMPLE_HEADER = """---
outcome: survival_months
covariates: [age, sex]
---
"""


class ProblemError(ValueError):
    """The research program/configuration is malformed or does not match the data."""


@dataclass(frozen=True)
class ProblemSpec:
    outcome: str
    question: str
    covariates: tuple[str, ...] = ()
    cohort_file: str = "training_cohort.csv"
    id_column: str = "donor_id"
    slide_column: str = "slide_name"
    # Optional microns-per-pixel column; when absent, loaders fall back to
    # metadata/<id>.json next to the slides, else report pixels.
    mpp_column: str = "mpp"
    cohort_selection_reason: str = ""

    @property
    def protected_names(self) -> list[str]:
        """Columns worker code must never name (checked by the controller)."""
        return [self.outcome, *self.covariates]

    def public_columns(self, available: list[str]) -> list[str]:
        """Cohort columns the sandbox may see: identifiers and slide layout only."""
        wanted = [self.id_column, self.slide_column, self.mpp_column]
        return [c for c in wanted if c in available and c not in self.protected_names]

    def dataset_layout(self) -> dict[str, Any]:
        """The outcome-free part, written to /shared/dataset.json for the loaders."""
        return {
            "cohort_file": self.cohort_file,
            "id_column": self.id_column,
            "slide_column": self.slide_column,
            "mpp_column": self.mpp_column,
        }

    def prompt_context(self) -> str:
        """The problem's structured facts, rendered for the system prompts."""
        lines = [
            f"- Outcome (cohort column the judge predicts): `{self.outcome}`",
            "- Covariates every comparison adjusts for: "
            + (", ".join(f"`{c}`" for c in self.covariates) if self.covariates else "none"),
            f"- Cohort file: `/data/{self.cohort_file}` (inside the sandbox only `{self.id_column}`, "
            f"`{self.slide_column}` and, if present, `{self.mpp_column}`)",
            f"- Each row's slide: `/data/<{self.slide_column}>` (a TissueLab .zarr)",
        ]
        return "\n".join(lines)


HEADER_KEYS = frozenset({
    "outcome", "covariates", "cohort_file", "id_column", "slide_column", "mpp_column",
})


def _relative_inside(path: str, what: str) -> PurePosixPath:
    """A path relative to the data folder that cannot leave it."""
    rel = PurePosixPath(str(path).replace("\\", "/"))
    if rel.is_absolute() or not rel.parts or ".." in rel.parts:
        raise ProblemError(f"program.md: `{what}` must be a path inside the data folder, got {path!r}")
    return rel


def _exact_path(data_dir: Path, rel: PurePosixPath) -> Path:
    """data_dir/rel, requiring every component to match the on-disk name exactly.

    On a case-insensitive filesystem `Cases.csv` opens `cases.csv`, but the sandbox
    overlay would shadow only the literal name — the real file would stay visible.
    """
    current = data_dir
    for part in rel.parts:
        try:
            names = os.listdir(current)
        except OSError:
            names = []
        if part not in names:
            raise ProblemError(f"Not found in the data folder (names are case-sensitive): {rel}")
        current = current / part
    return current


def _string_list(value: Any, key: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or not all(isinstance(v, (str, int, float)) for v in value):
        raise ProblemError(f"program.md: `{key}` must be a list of names")
    return tuple(str(v).strip() for v in value if str(v).strip())


def parse_problem(text: str) -> ProblemSpec:
    """Parse explicit program frontmatter. The YAML header must name at least the outcome."""
    stripped = (text or "").lstrip("﻿")
    if not stripped.startswith("---"):
        raise ProblemError(
            "program.md needs a YAML header naming the outcome, e.g.\n" + EXAMPLE_HEADER
        )
    parts = stripped.split("\n")
    try:
        end = next(i for i in range(1, len(parts)) if parts[i].strip() == "---")
    except StopIteration:
        raise ProblemError("program.md: the YAML header is not closed with a `---` line") from None
    try:
        header = yaml.safe_load("\n".join(parts[1:end])) or {}
    except yaml.YAMLError as exc:
        raise ProblemError(f"program.md: the YAML header does not parse: {exc}") from None
    if not isinstance(header, dict):
        raise ProblemError("program.md: the YAML header must be a mapping of settings")
    question = "\n".join(parts[end + 1:]).strip()
    outcome = str(header.get("outcome") or "").strip()
    if not outcome or outcome.startswith("<"):
        raise ProblemError("program.md: set `outcome` to the cohort column to predict")
    if not question:
        raise ProblemError("program.md: describe the research question below the header")

    unknown = sorted(set(header) - HEADER_KEYS)
    if unknown:
        raise ProblemError(f"program.md: unknown setting(s) {unknown}; allowed: {sorted(HEADER_KEYS)}")
    defaults = ProblemSpec(outcome=outcome, question=question)
    spec = ProblemSpec(
        outcome=outcome,
        question=question,
        covariates=_string_list(header.get("covariates"), "covariates"),
        cohort_file=str(header.get("cohort_file") or defaults.cohort_file).strip(),
        id_column=str(header.get("id_column") or defaults.id_column).strip(),
        slide_column=str(header.get("slide_column") or defaults.slide_column).strip(),
        mpp_column=str(header.get("mpp_column") or defaults.mpp_column).strip(),
    )
    _relative_inside(spec.cohort_file, "cohort_file")
    return spec


def write_run_config(spec: ProblemSpec, run_root: Path) -> None:
    """Freeze resolved research settings host-side for this run only."""
    config = {"schema_version": 1, **asdict(spec)}
    (run_root / RUN_CONFIG_FILENAME).write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def read_run_config(run_root: Path) -> ProblemSpec:
    """Read the required configuration snapshot for a run."""
    path = run_root / RUN_CONFIG_FILENAME
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(config, dict) or type(config.get("schema_version")) is not int or config["schema_version"] != 1:
            raise ValueError("unsupported schema_version")
        fields = {key: value for key, value in config.items() if key != "schema_version"}
        if set(fields) != HEADER_KEYS | {"question", "cohort_selection_reason"}:
            raise ValueError("missing or unknown research setting")
        for key in (HEADER_KEYS | {"question"}) - {"covariates"}:
            if not isinstance(fields[key], str) or not fields[key].strip():
                raise ValueError(f"{key} must be a nonempty string")
        if not isinstance(fields["covariates"], list) or not all(isinstance(c, str) and c.strip() for c in fields["covariates"]):
            raise ValueError("covariates must be a list of names")
        if not isinstance(fields["cohort_selection_reason"], str):
            raise ValueError("cohort_selection_reason must be a string")
        _relative_inside(fields["cohort_file"], "cohort_file")
        return ProblemSpec(**{**fields, "covariates": tuple(fields["covariates"])})
    except (ValueError, TypeError) as exc:
        raise ProblemError(f"Invalid {RUN_CONFIG_FILENAME}: {exc}") from exc


def load_cohort(spec: ProblemSpec, data_dir: str | Path) -> pd.DataFrame:
    """The full cohort (outcome and covariates included) — host-side only."""
    try:
        path = _exact_path(Path(data_dir), _relative_inside(spec.cohort_file, "cohort_file"))
    except ProblemError:
        raise ProblemError(f"Cohort file not found: {spec.cohort_file} (in {data_dir}; names are case-sensitive)") from None
    if not path.is_file():
        raise ProblemError(f"Cohort file not found: {spec.cohort_file} (in {data_dir})")
    # Identifiers stay text: "001" must not become 1 (the donor tables key on them).
    return pd.read_csv(path, dtype={spec.id_column: str, spec.slide_column: str})


def validate_against_data(spec: ProblemSpec, data_dir: str | Path) -> pd.DataFrame:
    """Check resolved research settings against the data folder before any model is called."""
    cohort = load_cohort(spec, data_dir)
    columns = list(cohort.columns)
    missing = [c for c in (spec.id_column, spec.slide_column, spec.outcome, *spec.covariates) if c not in columns]
    if missing:
        raise ProblemError(
            f"{spec.cohort_file} lacks column(s) {missing}; it has {columns}"
        )
    if cohort[spec.id_column].duplicated().any():
        raise ProblemError(f"{spec.cohort_file}: `{spec.id_column}` has duplicate values")
    outcome = pd.to_numeric(cohort[spec.outcome], errors="coerce")
    if outcome.isna().any():
        raise ProblemError(f"{spec.cohort_file}: outcome `{spec.outcome}` must be numeric with no missing values")
    slides = [
        _relative_inside(name, spec.slide_column) if pd.notna(name) and str(name).strip() else None
        for name in cohort[spec.slide_column]
    ]
    available = [slide is not None and (Path(data_dir) / slide).exists() for slide in slides]
    if not any(available):
        raise ProblemError(
            f"None of the slides named in `{spec.slide_column}` exist under the data folder"
        )
    # The judge regresses on the covariates: reject values it cannot use now,
    # not after every round's worker budget is spent.
    from .panel_cv import PredictivePanelConfig, covariate_matrix

    coverage = sum(available) / len(cohort)
    if coverage < PredictivePanelConfig.min_candidate_coverage:
        missing_slides = [slide or "<empty slide path>" for slide, exists in zip(slides, available) if not exists]
        examples = ", ".join(str(slide) for slide in missing_slides[:3])
        raise ProblemError(
            f"Only {sum(available)}/{len(cohort)} cohort slides exist under the data folder "
            f"({coverage:.1%}); research requires at least {PredictivePanelConfig.min_candidate_coverage:.0%} "
            f"donor coverage. Cohort: {spec.cohort_file}. Missing {len(missing_slides)} slide(s), e.g. {examples}. "
            "Copy the missing slide data into the workspace before starting research."
        )

    try:
        covariate_matrix(cohort, list(spec.covariates))
    except ValueError as exc:
        raise ProblemError(f"{spec.cohort_file}: {exc}") from None
    return cohort


def write_public_cohort(spec: ProblemSpec, data_dir: str | Path, destination: Path) -> Path:
    """Cohort copy for the sandbox: identifier / slide / mpp columns only."""
    cohort = load_cohort(spec, data_dir)
    destination.parent.mkdir(parents=True, exist_ok=True)
    cohort.loc[:, spec.public_columns(list(cohort.columns))].to_csv(destination, index=False)
    return destination


def write_dataset_layout(spec: ProblemSpec, shared_dir: Path) -> Path:
    path = Path(shared_dir) / "dataset.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(spec.dataset_layout(), indent=2) + "\n", encoding="utf-8")
    return path
