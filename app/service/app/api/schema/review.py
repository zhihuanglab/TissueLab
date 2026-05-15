from pydantic import BaseModel
from typing import Optional, Literal, List

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
    # Optional fields for color and centroid (passed from frontend to avoid reading Zarr)
    centroid_x: Optional[float] = None
    centroid_y: Optional[float] = None
    cell_color: Optional[str] = None
    is_manual_reclassification: Optional[bool] = False

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
    # New parameter to specify which side of threshold: 'left' (prob < threshold) or 'right' (prob >= threshold)
    side: Optional[Literal["left", "right"]] = "left"


class ShuffleCandidatesRequest(BaseModel):
    slide_id: str
    threshold: Optional[float] = 0.5
    limit: Optional[int] = 80
    class_names: Optional[List[str]] = None  # filter to subset of classes
    exclude: Optional[bool] = True

