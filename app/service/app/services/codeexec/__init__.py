"""User code-execution pipeline.

Runs user-/agent-submitted analysis code against a zarr file behind three layers
of defence — a static AST guard, an optional LLM safety review, and a sandboxed
runner (Docker, with a resource-limited subprocess fallback). The point is that a
user can run any code without being able to touch other users' files.

Public API:
    from app.services.codeexec import run_user_code, ExecRequest, ExecResult
"""

from .runner import run_user_code
from .schema import ExecRequest, ExecResult

__all__ = ["run_user_code", "ExecRequest", "ExecResult"]
