from pydantic import BaseModel
from typing import Optional, Literal, List, Any


class RoiBox(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float


class CandidatesRequest(BaseModel):
    slide_id: str
    class_name: Optional[str] = None
    threshold: Optional[float] = 0.5
    sort: Optional[str] = "asc"
    limit: Optional[int] = 80
    offset: Optional[int] = 0
    # Accept either a comma-separated string or a list of ints (legacy; prefer roi)
    cell_ids: Optional[object] = None
    # Spatial ROI — preferred over cell_ids to avoid giant payloads
    roi: Optional[RoiBox] = None
    polygon_points: Optional[List[Any]] = None
    # New parameter to exclude saved cells
    exclude_saved: Optional[bool] = False
    # New parameter to specify which side of threshold: 'left' (prob < threshold) or 'right' (prob >= threshold)
    side: Optional[Literal["left", "right"]] = "left"
    # When true, return only cells already saved (reviewed) for this class
    saved_only: Optional[bool] = False


class PatchTileRequest(BaseModel):
    """A single patch tile at an adjustable view size (Target Patch preview)."""
    slide_id: str
    patch_id: int
    # Side of the square region to read, in slide pixels. The patch size
    # renders the patch exactly; larger shows surrounding context.
    window_size_px: Optional[int] = None
