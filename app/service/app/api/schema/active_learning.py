from pydantic import BaseModel
from typing import Optional, Literal

class LabelRequest(BaseModel):
    slide_id: str
    cell_id: str
    class_name: Optional[str] = None
    label: Literal[0, 1]
    prob: float

class RemoveRequest(BaseModel):
    slide_id: str
    cell_id: str

class ReclassifyRequest(BaseModel):
    slide_id: str
    cell_id: str
    original_class: str
    new_class: str
    prob: float

class SaveReclassificationsRequest(BaseModel):
    slide_id: str

class CandidatesRequest(BaseModel):
    slide_id: str
    class_name: Optional[str] = None
    threshold: Optional[float] = 0.5
    sort: Optional[str] = "asc"
    limit: Optional[int] = 80
    offset: Optional[int] = 0
    # Accept either a comma-separated string or a list of ints
    cell_ids: Optional[object] = None
    # New parameter to exclude reclassified cells
    exclude_reclassified: Optional[bool] = False