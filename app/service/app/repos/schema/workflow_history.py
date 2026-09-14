from pydantic import BaseModel
from typing import Any, Dict, List, Optional
from datetime import datetime


class WorkflowHistoryEntry(BaseModel):
    id: str
    name: str
    created_at: datetime
    updated_at: datetime
    zarr_path: str
    panels: List[Dict[str, Any]]
    output_path: str
    color: Optional[str] = None
    number: Optional[int] = None

    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }
