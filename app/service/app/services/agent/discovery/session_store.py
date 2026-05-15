"""
Discovery session storage backends.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.services.agent.discovery.models import DiscoverySession, DiscoveryRun, new_session


class DiscoverySessionStore(ABC):
    """Abstract session store interface."""

    @abstractmethod
    def create_session(
        self,
        *,
        user_id: Optional[str],
        device_id: Optional[str],
        dataset_id: Optional[str],
        context: Optional[Dict[str, Any]] = None,
    ) -> DiscoverySession:
        raise NotImplementedError

    @abstractmethod
    def get_session(self, session_id: str) -> Optional[DiscoverySession]:
        raise NotImplementedError

    @abstractmethod
    def list_sessions(
        self,
        *,
        user_id: Optional[str] = None,
        device_id: Optional[str] = None,
        limit: int = 50,
    ) -> List[DiscoverySession]:
        raise NotImplementedError

    @abstractmethod
    def update_session(self, session: DiscoverySession) -> None:
        raise NotImplementedError

    @abstractmethod
    def add_run(self, session_id: str, run: DiscoveryRun) -> None:
        raise NotImplementedError

    @abstractmethod
    def append_message(self, session_id: str, message: Dict[str, Any]) -> None:
        raise NotImplementedError

    @abstractmethod
    def append_run_event(self, session_id: str, run_id: str, event: Dict[str, Any]) -> None:
        raise NotImplementedError

    @abstractmethod
    def update_run_status(
        self,
        session_id: str,
        run_id: str,
        *,
        status: str,
        summary: Optional[Dict[str, Any]] = None,
        artifacts: Optional[List[Dict[str, Any]]] = None,
        ended_at: Optional[str] = None,
    ) -> None:
        raise NotImplementedError


class LocalDiscoveryStore(DiscoverySessionStore):
    """Local JSON-backed store."""

    def __init__(self, root_dir: Optional[str] = None) -> None:
        base = Path(root_dir) if root_dir else Path(__file__).resolve().parents[2] / "storage" / "discovery_sessions"
        self.root_dir = base
        self.root_dir.mkdir(parents=True, exist_ok=True)
        self._locks: Dict[str, threading.RLock] = {}
        self._global_lock = threading.RLock()

    def _get_lock(self, session_id: str) -> threading.RLock:
        with self._global_lock:
            if session_id not in self._locks:
                self._locks[session_id] = threading.RLock()
            return self._locks[session_id]

    def _session_path(self, session_id: str) -> Path:
        return self.root_dir / f"{session_id}.json"

    def _load_session(self, session_id: str) -> Optional[DiscoverySession]:
        path = self._session_path(session_id)
        if not path.exists():
            return None
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return DiscoverySession.from_dict(data)

    def _save_session(self, session: DiscoverySession) -> None:
        path = self._session_path(session.session_id)
        with path.open("w", encoding="utf-8") as f:
            json.dump(session.to_dict(), f, indent=2)

    def create_session(
        self,
        *,
        user_id: Optional[str],
        device_id: Optional[str],
        dataset_id: Optional[str],
        context: Optional[Dict[str, Any]] = None,
    ) -> DiscoverySession:
        session = new_session(
            user_id=user_id,
            device_id=device_id,
            dataset_id=dataset_id,
            context=context or {},
        )
        with self._get_lock(session.session_id):
            self._save_session(session)
        return session

    def get_session(self, session_id: str) -> Optional[DiscoverySession]:
        with self._get_lock(session_id):
            return self._load_session(session_id)

    def list_sessions(
        self,
        *,
        user_id: Optional[str] = None,
        device_id: Optional[str] = None,
        limit: int = 50,
    ) -> List[DiscoverySession]:
        sessions: List[DiscoverySession] = []
        for file in sorted(self.root_dir.glob("*.json"), key=os.path.getmtime, reverse=True):
            try:
                with file.open("r", encoding="utf-8") as f:
                    data = json.load(f)
                session = DiscoverySession.from_dict(data)
                if user_id or device_id:
                    if user_id and session.user_id == user_id:
                        pass
                    elif device_id and session.device_id == device_id:
                        pass
                    else:
                        continue
                sessions.append(session)
                if len(sessions) >= limit:
                    break
            except Exception:
                continue
        return sessions

    def update_session(self, session: DiscoverySession) -> None:
        with self._get_lock(session.session_id):
            self._save_session(session)

    def add_run(self, session_id: str, run: DiscoveryRun) -> None:
        with self._get_lock(session_id):
            session = self._load_session(session_id)
            if not session:
                raise ValueError(f"Session {session_id} not found")
            session.add_run(run)
            self._save_session(session)

    def append_message(self, session_id: str, message: Dict[str, Any]) -> None:
        with self._get_lock(session_id):
            session = self._load_session(session_id)
            if not session:
                raise ValueError(f"Session {session_id} not found")
            session.append_message(message)
            self._save_session(session)

    def append_run_event(self, session_id: str, run_id: str, event: Dict[str, Any]) -> None:
        with self._get_lock(session_id):
            session = self._load_session(session_id)
            if not session:
                raise ValueError(f"Session {session_id} not found")
            run = session.get_run(run_id)
            if not run:
                raise ValueError(f"Run {run_id} not found in session {session_id}")
            run.execution_log.append(event)
            session.updated_at = datetime.now(timezone.utc).isoformat()
            self._save_session(session)

    def update_run_status(
        self,
        session_id: str,
        run_id: str,
        *,
        status: str,
        summary: Optional[Dict[str, Any]] = None,
        artifacts: Optional[List[Dict[str, Any]]] = None,
        ended_at: Optional[str] = None,
    ) -> None:
        with self._get_lock(session_id):
            session = self._load_session(session_id)
            if not session:
                raise ValueError(f"Session {session_id} not found")
            run = session.get_run(run_id)
            if not run:
                raise ValueError(f"Run {run_id} not found in session {session_id}")
            run.status = status
            if summary is not None:
                run.summary = summary
            if artifacts is not None:
                run.artifacts = artifacts
            if ended_at:
                run.ended_at = ended_at
            session.updated_at = datetime.now(timezone.utc).isoformat()
            self._save_session(session)


_store_instance: Optional[DiscoverySessionStore] = None


def get_discovery_session_store() -> DiscoverySessionStore:
    """Local TissueLab build always uses the filesystem-backed store."""
    global _store_instance
    if _store_instance is None:
        _store_instance = LocalDiscoveryStore()
    return _store_instance
