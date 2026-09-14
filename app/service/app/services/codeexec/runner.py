"""Orchestrator.

- Docker preferred when available.
- CODEEXEC_DOCKER=0, or auto without Docker: host subprocess (unrestricted local/dev).
- CODEEXEC_DOCKER=1 without Docker: fail-closed (SandboxUnavailable).
- Docker path: guard (static) → review (LLM) → isolated container.
"""

from app.core.logger import logger

from . import guard, review, sandbox
from .schema import ExecRequest, ExecResult


def run_user_code(req: ExecRequest) -> ExecResult:
    backend = sandbox.choose_backend()

    if backend == "unavailable":
        return ExecResult(
            ok=False, error_type="SandboxUnavailable",
            error="Docker sandbox is required but unavailable. Set CODEEXEC_DOCKER=0 only for local unrestricted runs.",
        )

    if backend == "subprocess":
        # Local / unrestricted — full filesystem access, no guard or review.
        logger.info(f"[codeexec] uid={req.uid} backend=subprocess (unrestricted)")
        return sandbox.run_subprocess(req)

    # ── Docker path: layered checks, then the isolated container ──────────────
    violations = guard.check(req.code)
    if violations:
        reason = "; ".join(violations[:5])
        logger.info(f"[codeexec] guard blocked uid={req.uid}: {reason}")
        return ExecResult.rejected("guard", reason)

    safe, reason = review.review_code(req.code)
    if not safe:
        logger.info(f"[codeexec] review blocked uid={req.uid}: {reason}")
        return ExecResult.rejected("review", reason)

    result = sandbox.run_docker(req)
    logger.info(f"[codeexec] ran uid={req.uid} backend=docker ok={result.ok}")
    return result
