"""Pieces the proposer and the worker share: tool specs, prompt loading, text limits."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .problem import ProblemSpec

PROMPTS_DIR = Path(__file__).parent / "prompts"

SHELL_TOOL_NAME = "shell_exec"
IMAGE_TOOL_NAME = "inspect_image"

SHELL_TOOL_SPEC = {
    "type": "custom",
    "name": SHELL_TOOL_NAME,
    "description": (
        "Run one shell command batch inside the sandbox. "
        "Use it to inspect the data folder, run analysis scripts, and write files into /scratch. "
        "Input must be raw shell text, not JSON. The response contains at most 6,000 "
        "characters; complete stdout and stderr are saved under /scratch/logs."
    ),
    "format": {"type": "text"},
}
IMAGE_TOOL_SPEC = {
    "type": "custom",
    "name": IMAGE_TOOL_NAME,
    "description": (
        "Visually inspect one PNG, JPEG, WEBP, or non-animated GIF generated inside /scratch. "
        "Input must be only its /scratch path as raw text. The image will be attached to your "
        "next turn. Use shell_exec first to render crops, montages, or heatmaps."
    ),
    "format": {"type": "text"},
}


def load_prompt(name: str, spec: ProblemSpec) -> str:
    """A system prompt with the problem's facts filled in.

    Prompts are problem-agnostic templates; `{problem_context}` and
    `{outcome}` are the only places the dataset enters them.
    """
    text = (PROMPTS_DIR / name).read_text(encoding="utf-8")
    return text.replace("{problem_context}", spec.prompt_context()).replace("{outcome}", spec.outcome)


def is_done(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False
    if stripped == "DONE" or stripped.startswith("DONE\n"):
        return True
    lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    return bool(lines) and lines[-1] == "DONE"


def bounded_tool_text(value: Any, limit: int = 3000) -> str:
    """Head and tail of a long tool output, within `limit` characters."""
    text = str(value or "")
    if len(text) <= limit:
        return text
    side = max(1, (limit - 100) // 2)
    return (
        text[:side]
        + f"\n... {len(text) - (2 * side)} characters omitted; see /scratch/logs ...\n"
        + text[-side:]
    )
