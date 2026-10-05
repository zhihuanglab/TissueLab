"""Per-user knowledge base (corrections the agent learned) stored on disk.

One JSON file per user under ``storage/users/<uid>/knowledge_base.json``.
Replaces the hosted edition's Firestore ``users/{uid}/knowledge_base``
collection with the same item schema (:class:`KnowledgeItem`).
"""
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.config.path_config import SERVICE_ROOT_DIR
from app.repos.schema.knowledge import KnowledgeItem

_lock = threading.RLock()


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(f"not serializable: {type(value)!r}")


class KnowledgeStore:
    def __init__(self, base_dir: Optional[str] = None):
        self._base = base_dir or os.path.join(SERVICE_ROOT_DIR, "storage", "users")

    @property
    def lock(self):
        """Hold across a find-then-upsert so it is atomic (reentrant: the
        store's own methods take it too)."""
        return _lock

    def _path(self, user_id: str) -> str:
        safe = "".join(ch for ch in (user_id or "") if ch.isalnum() or ch in "-_.")
        if not safe:
            raise ValueError("invalid user id")
        folder = os.path.join(self._base, safe)
        os.makedirs(folder, exist_ok=True)
        return os.path.join(folder, "knowledge_base.json")

    def _read_raw(self, user_id: str) -> List[Dict[str, Any]]:
        path = self._path(user_id)
        if not os.path.exists(path):
            return []
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return []
        return data if isinstance(data, list) else []

    def _write_raw(self, user_id: str, items: List[Dict[str, Any]]) -> None:
        path = self._path(user_id)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(items, fh, ensure_ascii=False, indent=2, default=_json_default)
        os.replace(tmp, path)

    def list_items(self, user_id: str) -> List[KnowledgeItem]:
        with _lock:
            raw = self._read_raw(user_id)
        items: List[KnowledgeItem] = []
        for entry in raw:
            try:
                items.append(KnowledgeItem.from_dict(entry))
            except Exception:
                continue
        return items

    def find_by_query(self, user_id: str, original_query: str, context_key: Optional[str]) -> Optional[KnowledgeItem]:
        for item in self.list_items(user_id):
            if item.original_query != original_query:
                continue
            existing_ctx = item.context_key
            if (context_key is None and not existing_ctx) or (context_key is not None and context_key == existing_ctx):
                return item
        return None

    def upsert(self, user_id: str, item: KnowledgeItem) -> str:
        if not item.knowledge_id:
            item.knowledge_id = uuid.uuid4().hex
        item.updated_at = datetime.now(timezone.utc)
        with _lock:
            raw = self._read_raw(user_id)
            replaced = False
            for idx, entry in enumerate(raw):
                if entry.get("knowledge_id") == item.knowledge_id:
                    raw[idx] = item.to_dict()
                    replaced = True
                    break
            if not replaced:
                raw.append(item.to_dict())
            self._write_raw(user_id, raw)
        return item.knowledge_id

    def delete(self, user_id: str, knowledge_id: str) -> bool:
        with _lock:
            raw = self._read_raw(user_id)
            kept = [entry for entry in raw if entry.get("knowledge_id") != knowledge_id]
            if len(kept) == len(raw):
                return False
            self._write_raw(user_id, kept)
        return True


_store: Optional[KnowledgeStore] = None


def get_knowledge_store() -> KnowledgeStore:
    global _store
    if _store is None:
        _store = KnowledgeStore()
    return _store


__all__ = ["KnowledgeStore", "get_knowledge_store"]
