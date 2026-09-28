"""
Discovery session data models.
"""

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone
import uuid


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _make_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


@dataclass
class DiscoveryRun:
    run_id: str
    status: str = "queued"
    task: str = ""
    reasoning_effort: Optional[str] = None
    max_iterations: int = 30
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
    execution_log: List[Dict[str, Any]] = field(default_factory=list)
    artifacts: List[Dict[str, Any]] = field(default_factory=list)
    summary: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DiscoveryRun":
        started_at = data.get("started_at")
        ended_at = data.get("ended_at")
        if started_at is not None and not isinstance(started_at, str):
            started_at = started_at.isoformat() if hasattr(started_at, "isoformat") else str(started_at)
        if ended_at is not None and not isinstance(ended_at, str):
            ended_at = ended_at.isoformat() if hasattr(ended_at, "isoformat") else str(ended_at)
        return cls(
            run_id=data.get("run_id") or _make_id("run"),
            status=data.get("status", "queued"),
            task=data.get("task", ""),
            reasoning_effort=data.get("reasoning_effort"),
            max_iterations=int(data.get("max_iterations", 30)),
            started_at=started_at,
            ended_at=ended_at,
            execution_log=list(data.get("execution_log", [])),
            artifacts=list(data.get("artifacts", [])),
            summary=data.get("summary"),
        )


@dataclass
class DiscoverySession:
    session_id: str
    user_id: Optional[str] = None
    device_id: Optional[str] = None
    dataset_id: Optional[str] = None
    context: Dict[str, Any] = field(default_factory=dict)
    status: str = "active"
    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)
    messages: List[Dict[str, Any]] = field(default_factory=list)
    runs: List[DiscoveryRun] = field(default_factory=list)

    def add_run(self, run: DiscoveryRun) -> None:
        self.runs.append(run)
        self.updated_at = _now_iso()

    def append_message(self, message: Dict[str, Any]) -> None:
        self.messages.append(message)
        self.updated_at = _now_iso()

    def get_run(self, run_id: str) -> Optional[DiscoveryRun]:
        for run in self.runs:
            if run.run_id == run_id:
                return run
        return None

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["runs"] = [run.to_dict() for run in self.runs]
        return data

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DiscoverySession":
        runs = [DiscoveryRun.from_dict(item) for item in data.get("runs", [])]
        created_at = data.get("created_at", _now_iso())
        updated_at = data.get("updated_at", _now_iso())
        if created_at is not None and not isinstance(created_at, str):
            created_at = created_at.isoformat() if hasattr(created_at, "isoformat") else str(created_at)
        if updated_at is not None and not isinstance(updated_at, str):
            updated_at = updated_at.isoformat() if hasattr(updated_at, "isoformat") else str(updated_at)
        return cls(
            session_id=data.get("session_id") or _make_id("cosess"),
            user_id=data.get("user_id"),
            device_id=data.get("device_id"),
            dataset_id=data.get("dataset_id"),
            context=dict(data.get("context", {}) or {}),
            status=data.get("status", "active"),
            created_at=created_at,
            updated_at=updated_at,
            messages=list(data.get("messages", [])),
            runs=runs,
        )


def new_session(
    *,
    user_id: Optional[str],
    device_id: Optional[str],
    dataset_id: Optional[str],
    context: Optional[Dict[str, Any]] = None,
) -> DiscoverySession:
    return DiscoverySession(
        session_id=_make_id("cosess"),
        user_id=user_id,
        device_id=device_id,
        dataset_id=dataset_id,
        context=context or {},
    )


def new_run(
    *,
    task: str,
    reasoning_effort: Optional[str],
    max_iterations: int,
) -> DiscoveryRun:
    return DiscoveryRun(
        run_id=_make_id("run"),
        task=task,
        reasoning_effort=reasoning_effort,
        max_iterations=max_iterations,
    )
