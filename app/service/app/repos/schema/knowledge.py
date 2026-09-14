from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


def _now() -> datetime:
    return datetime.now(timezone.utc)


class KnowledgeItem(BaseModel):
    """User private knowledge base item (corrections the agent learned)."""
    model_config = {"arbitrary_types_allowed": True, "protected_namespaces": ()}

    knowledge_id: Optional[str] = Field(None, description="Knowledge item ID (auto-generated)")
    user_id: str = Field(..., description="User ID")

    title: str = Field(..., description="Knowledge title/summary")
    content: str = Field(..., description="Knowledge detailed content")
    category: Optional[str] = Field(None, description="Knowledge category (e.g., workflow_preference, analysis_pattern, user_requirement)")
    tags: Optional[List[str]] = Field(default_factory=list, description="Tag list for retrieval")

    original_query: Optional[str] = Field(None, description="User's original question/query")
    context_key: Optional[str] = Field(None, description="Context key (e.g., zarr file name)")

    source_type: str = Field("correction", description="Source type: correction (user correction), manual, auto_learned")
    source_id: Optional[str] = Field(None, description="Source ID (e.g., conversation ID)")

    original_response: Optional[str] = Field(None, description="Original agent response (corrected)")
    correction_context: Optional[str] = Field(None, description="Correction context conversation")

    importance_score: float = Field(1.0, description="Importance score (0-1) for retrieval ranking")
    usage_count: int = Field(0, description="Usage count")
    last_used_at: Optional[datetime] = Field(None, description="Last used timestamp")

    created_at: datetime = Field(default_factory=_now, description="Creation timestamp")
    updated_at: datetime = Field(default_factory=_now, description="Update timestamp")

    version: int = Field(1, description="Version number")
    parent_knowledge_id: Optional[str] = Field(None, description="Parent knowledge ID (if evolved from another knowledge)")

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "KnowledgeItem":
        return cls(**data)

    def to_dict(self) -> Dict[str, Any]:
        return self.model_dump(exclude_none=True)
