from __future__ import annotations

import json
from pathlib import Path
from typing import Any


DEFAULT_SHARED_ROOT = Path("/shared")
DEFAULT_SCRATCH_ROOT = Path("/scratch")


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _read_text(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def load_worker_context(scratch_root: str | Path = DEFAULT_SCRATCH_ROOT) -> dict[str, Any]:
    scratch_root = Path(scratch_root)
    return {
        "worker_brief": _read_json(scratch_root / "worker_brief.json"),
        "program_text": _read_text(scratch_root / "program.md"),
    }


def load_runtime_manifest(shared_root: str | Path = DEFAULT_SHARED_ROOT) -> dict[str, Any]:
    shared_root = Path(shared_root)
    return _read_json(shared_root / "cache" / "runtime_manifest.json")


def render_report(
    *,
    summary: str,
    key_findings: str,
    rationale: str = "",
    axis_interpretation: str = "",
) -> str:
    parts = [
        "# Summary",
        summary.strip(),
        "",
        "# Key Findings",
        key_findings.strip(),
    ]
    if rationale.strip():
        parts.extend(["", "# Rationale", rationale.strip()])
    if axis_interpretation.strip():
        parts.extend(["", "# Axis Interpretation", axis_interpretation.strip()])
    return "\n".join(parts).strip() + "\n"
