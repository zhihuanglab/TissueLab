from typing import Any, Dict, List, Optional
from datetime import datetime

# Firebase removed for open source


class FilesRepo:
    COLLECTION = 'files'

    def __init__(self):
        self.db = firestore.client()
        self.col = self.db.collection(self.COLLECTION)

    def upsert_file(self, file_id: str, data: Dict[str, Any]) -> None:
        now = datetime.utcnow()
        payload = {
            **data,
            'updatedAt': firestore.SERVER_TIMESTAMP,
        }
        # set merge to preserve existing fields such as createdAt
        self.col.document(file_id).set(payload, merge=True)

    def create_if_absent(self, file_id: str, data: Dict[str, Any]) -> None:
        payload = {
            **data,
            'createdAt': firestore.SERVER_TIMESTAMP,
            'updatedAt': firestore.SERVER_TIMESTAMP,
        }
        self.col.document(file_id).set(payload, merge=True)

    def get_file(self, file_id: str) -> Optional[Dict[str, Any]]:
        snap = self.col.document(file_id).get()
        return snap.to_dict() if snap.exists else None

    def find_by_owner_and_path(self, owner_id: str, rel_path: str) -> Optional[Dict[str, Any]]:
        """Find first file document by ownerId and localPath.

        Returns a dict with fields and an added 'id' key for the document id, or None if not found.
        """
        try:
            query = (
                self.col
                .where('ownerId', '==', owner_id)
                .where('localPath', '==', rel_path)
                .limit(1)
            )
            docs = list(query.stream())
            if not docs:
                return None
            doc = docs[0]
            data = doc.to_dict() or {}
            data['id'] = doc.id
            return data
        except Exception:
            return None

    def query_user_files(self, user_id: str) -> List[Dict[str, Any]]:
        docs = self.col.where('ownerId', '==', user_id).stream()
        return [d.to_dict() for d in docs]

    def query_shared_with(self, user_id: str) -> List[Dict[str, Any]]:
        """List files that are explicitly shared with the user."""
        shared_docs = self.col.where('sharedWith', 'array_contains', user_id).stream()

        results: Dict[str, Dict[str, Any]] = {}
        for d in shared_docs:
            data = d.to_dict()
            # Include files shared with the user, even if they own the file
            results[d.id] = {**data, 'id': d.id}
        return list(results.values())

    def can_access(self, user_id: Optional[str], file_doc: Dict[str, Any]) -> bool:
        if not file_doc:
            return False
        if user_id and file_doc.get('ownerId') == user_id:
            return True
        if user_id and user_id in (file_doc.get('sharedWith') or []):
            return True
        return False


