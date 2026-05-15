"""
Autoresearch: minimal iterative biomarker research loop.

Users provide a research directive (program.md) and a data folder.
Each round runs: propose one candidate → run one worker → evaluate panel gain
→ keep or discard → append one row to results.tsv.
"""

from .simple_loop import run_autoresearch

__all__ = ["run_autoresearch"]
