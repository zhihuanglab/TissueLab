"""Request/result types for the user code-execution pipeline."""

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class ExecRequest:
    """One user code-execution request.

    code        : the Python source to run.
    zarr_path    : absolute path to the input .zarr (exposed read-only to the code
                   as `zarr_path` / `path`, and as analyze_medical_image's argument).
    output_dir   : absolute path to the *user's own* writable output directory
                   (the only place the code is allowed to write). None = no writes.
    uid          : the requesting user's id (for logging / per-user isolation).
    """

    code: str
    zarr_path: str
    output_dir: Optional[str] = None   # the user's own dir — the ONLY writable mount
    read_roots: list = field(default_factory=list)  # dirs mounted READ-ONLY (storage + shared data)
    uid: Optional[str] = None
    max_memory_mb: int = 8192
    max_cpu_seconds: int = 55
    timeout_seconds: int = 60


@dataclass
class ExecResult:
    """Outcome of an execution attempt (or a pre-execution rejection)."""

    ok: bool
    result: Any = None
    stdout: str = ""
    error: Optional[str] = None
    error_type: Optional[str] = None
    traceback: Optional[str] = None
    backend: str = ""               # "docker" | "subprocess" | "" (rejected)
    rejected_by: Optional[str] = None   # "guard" | "review" when blocked before run
    reject_reason: Optional[str] = None

    def to_payload(self) -> dict:
        """JSON-able dict the API layer folds into `execution_result`."""
        payload: dict = {}
        if self.result is not None:
            if isinstance(self.result, dict):
                payload.update(self.result)
            else:
                payload["result"] = self.result
        if self.stdout:
            payload.setdefault("stdout", self.stdout)
        if self.error:
            payload["error"] = self.error
        if self.error_type:
            payload["error_type"] = self.error_type
        if self.traceback:
            payload["traceback"] = self.traceback
        if self.rejected_by:
            payload["rejected_by"] = self.rejected_by
            payload["reject_reason"] = self.reject_reason or ""
        payload["backend"] = self.backend or ("rejected" if self.rejected_by else "")
        return payload

    @classmethod
    def rejected(cls, by: str, reason: str) -> "ExecResult":
        return cls(ok=False, rejected_by=by, reject_reason=reason,
                   error=f"Blocked by {by}: {reason}", error_type="Blocked")
