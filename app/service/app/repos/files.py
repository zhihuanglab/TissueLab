"""File table for the open edition.

The hosted control plane keeps a metadata document per file (size/mtime cache,
owner, share recipients). The open edition has one user and the disk is the
source of truth, so there is no table: the file manager stats the filesystem
and share grants do not exist. ``FilesRepo`` keeps the interface the ported
file-manager code calls, and every lookup answers "no record" — this is the
Null Object pattern, not a stub waiting for a database.
"""
from typing import Any, Dict, Iterator, List, Optional


class FilesRepo:
    """No-record file table (single local user, disk is the source of truth)."""

    def upsert_file(self, file_id: str, data: Dict[str, Any]) -> None:
        return None

    def create_if_absent(self, file_id: str, data: Dict[str, Any]) -> None:
        return None

    def delete_file(self, file_id: str) -> None:
        return None

    def delete_subtree_by_prefix(self, rel_prefix: str, on_progress=None, progress_every: int = 100) -> int:
        return 0

    def get_file(self, file_id: str, user_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        return None

    def find_by_owner_and_path(self, owner_id: str, rel_path: str) -> Optional[Dict[str, Any]]:
        return None

    def query_user_files(self, user_id: str) -> List[Dict[str, Any]]:
        return []

    def iter_subtree_by_prefix(self, rel_prefix: str) -> Iterator[Dict[str, Any]]:
        return iter(())

    def find_links_from(self, *args, **kwargs) -> List[Dict[str, Any]]:
        return []

    def query_recipient_umbrellas_for_source(self, *args, **kwargs) -> List[Dict[str, Any]]:
        return []

    def can_access(self, user_id: Optional[str], file_doc: Dict[str, Any]) -> bool:
        return False


__all__ = ["FilesRepo"]
