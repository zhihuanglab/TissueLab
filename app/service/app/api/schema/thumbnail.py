from typing import List, Literal

from pydantic import BaseModel, Field


class PreviewBatchRequest(BaseModel):
    file_paths: List[str] = Field(..., min_length=1, max_length=50, description="Slide paths")
    preview_type: Literal["all", "cell_overlay", "patch_overlay"] = Field(
        "all", description="Bundled thumbnail/macro/label, or a classification overlay"
    )
    size: int = Field(200, ge=16, le=1024, description="Longest side in px")


class TaskIdsRequest(BaseModel):
    task_ids: List[str] = Field(..., min_length=1, max_length=100)


__all__ = ["PreviewBatchRequest", "TaskIdsRequest"]
