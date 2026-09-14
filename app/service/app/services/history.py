"""Workflow history service: persistence and serialization for saved workflows.

Wraps WorkflowHistoryRepo with the business logic (id/name defaults, created_at
preservation, Firestore timestamp serialization) that previously lived in the API layer.
"""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.repos.workflow_history_repo import WorkflowHistoryRepo
from app.repos.schema.workflow_history import WorkflowHistoryEntry


def _serialize_timestamps(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Convert Firestore/datetime timestamp fields to ISO strings in-place."""
    for field in ('created_at', 'updated_at'):
        val = entry.get(field)
        if val is not None and hasattr(val, 'timestamp'):
            entry[field] = datetime.fromtimestamp(val.timestamp(), tz=timezone.utc).isoformat()
        elif isinstance(val, datetime):
            entry[field] = val.isoformat()
    return entry


def save_workflow_history(
    uid: str,
    *,
    id: Optional[str],
    name: Optional[str],
    zarr_path: str,
    panels: List[Dict[str, Any]],
    output_path: str,
    color: Optional[str],
    number: Optional[int],
) -> str:
    """Create or upsert a workflow history entry; returns the entry id."""
    repo = WorkflowHistoryRepo()
    now = datetime.now(timezone.utc)
    entry_id = id or repo.generate_id()
    entry_name = name or f"Workflow {now.strftime('%Y-%m-%d %H:%M')}"

    # Preserve created_at when updating an existing entry
    existing = repo.get_entry(uid, entry_id)
    created_at = now
    if existing and existing.get('created_at'):
        raw = existing['created_at']
        if hasattr(raw, 'timestamp'):
            created_at = datetime.fromtimestamp(raw.timestamp(), tz=timezone.utc)
        elif isinstance(raw, datetime):
            created_at = raw

    entry = WorkflowHistoryEntry(
        id=entry_id,
        name=entry_name,
        created_at=created_at,
        updated_at=now,
        zarr_path=zarr_path,
        panels=panels,
        output_path=output_path,
        color=color,
        number=number,
    )
    repo.save_entry(uid, entry)
    return entry_id


def list_workflow_history(uid: str, limit: int = 50) -> List[Dict[str, Any]]:
    """List workflow history entries with timestamps serialized to ISO strings."""
    repo = WorkflowHistoryRepo()
    entries = repo.list_entries(uid, limit=limit)
    return [_serialize_timestamps(e) for e in entries]


def get_workflow_history_entry(uid: str, entry_id: str) -> Optional[Dict[str, Any]]:
    """Read a single workflow history entry, or None if it does not exist."""
    repo = WorkflowHistoryRepo()
    entry = repo.get_entry(uid, entry_id)
    if entry is None:
        return None
    return _serialize_timestamps(entry)


def delete_workflow_history_entry(uid: str, entry_id: str) -> bool:
    """Delete a workflow history entry; returns True if it existed."""
    repo = WorkflowHistoryRepo()
    return repo.delete_entry(uid, entry_id)
