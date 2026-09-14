"""Workflow history persisted as one JSON document per entry under
``storage/users/<uid>/workflow_history/``."""
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.config.path_config import SERVICE_ROOT_DIR
from app.repos.schema.workflow_history import WorkflowHistoryEntry

_lock = threading.RLock()


def _to_iso(value: Any) -> Any:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return value


def _from_iso(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return value
    return value


class WorkflowHistoryRepo:
    SUB_COLLECTION = 'workflow_history'

    def __init__(self, base_dir: Optional[str] = None):
        self._base = base_dir or os.path.join(SERVICE_ROOT_DIR, 'storage', 'users')

    def _user_dir(self, uid: str) -> str:
        path = os.path.join(self._base, uid, self.SUB_COLLECTION)
        os.makedirs(path, exist_ok=True)
        return path

    def _entry_path(self, uid: str, entry_id: str) -> str:
        safe = ''.join(ch for ch in entry_id if ch.isalnum() or ch in '-_')
        if not safe:
            raise ValueError("invalid entry id")
        return os.path.join(self._user_dir(uid), f"{safe}.json")

    def generate_id(self) -> str:
        return str(uuid.uuid4())

    def save_entry(self, uid: str, entry: WorkflowHistoryEntry) -> str:
        """Create or overwrite a workflow history entry."""
        now = datetime.now(timezone.utc)
        data = {
            'id': entry.id,
            'name': entry.name,
            'created_at': _to_iso(entry.created_at),
            'updated_at': _to_iso(now),
            'zarr_path': entry.zarr_path,
            'panels': entry.panels,
            'output_path': entry.output_path,
            'color': entry.color,
            'number': entry.number,
        }
        path = self._entry_path(uid, entry.id)
        with _lock:
            tmp = path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, path)
        return entry.id

    def _read(self, path: str) -> Optional[Dict[str, Any]]:
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        for field in ('created_at', 'updated_at'):
            data[field] = _from_iso(data.get(field))
        return data

    def list_entries(self, uid: str, limit: int = 50) -> List[Dict[str, Any]]:
        """List entries ordered by created_at descending."""
        results: List[Dict[str, Any]] = []
        with _lock:
            folder = self._user_dir(uid)
            for name in os.listdir(folder):
                if not name.endswith('.json'):
                    continue
                data = self._read(os.path.join(folder, name))
                if data:
                    results.append(data)

        def _key(item: Dict[str, Any]):
            created = item.get('created_at')
            if isinstance(created, datetime):
                if created.tzinfo is None:
                    created = created.replace(tzinfo=timezone.utc)
                return created.timestamp()
            return 0.0

        results.sort(key=_key, reverse=True)
        return results[:limit] if limit and limit > 0 else results

    def get_entry(self, uid: str, entry_id: str) -> Optional[Dict[str, Any]]:
        """Read a single entry."""
        with _lock:
            return self._read(self._entry_path(uid, entry_id))

    def delete_entry(self, uid: str, entry_id: str) -> bool:
        """Delete an entry. Returns True if it existed."""
        path = self._entry_path(uid, entry_id)
        with _lock:
            if not os.path.exists(path):
                return False
            os.remove(path)
        return True
