"""Pydantic request/response models for the file manager API."""
from typing import Dict, List, Optional

from pydantic import BaseModel


class FileOperationRequest(BaseModel):
    path: str
    new_path: Optional[str] = None
    items: Optional[List[str]] = None
    content: Optional[str] = None

class DeleteRequest(BaseModel):
    items: List[str]

class MoveRequest(BaseModel):
    items: List[str]
    new_path: str

class CopyToPersonalRequest(BaseModel):
    source_path: str  # Relative path to copy from (e.g. "samples/Data/slide.svs")
    # When true, link the slide in place (symlink WSI + sparse .zarr overlay)
    # instead of copying its bytes. Only valid for single files under samples/.
    link: bool = False
    # When true, ALSO byte-copy the slide's sibling ``.zarr`` (segmentation +
    # Cell-Classification + User-Annotations etc.) next to the WSI, so the
    # recipient gets the precomputed analysis instead of a blank slate. Default
    # false preserves the historical "raw slide only" behavior. Ignored when
    # link=True (the link path builds its own sparse overlay). A full .zarr can
    # be multi-GB and counts against the user's quota.
    include_zarr: bool = False

class CompressRequest(BaseModel):
    items: List[str]
    dest_path: Optional[str] = None
    zip_name: Optional[str] = None
    overwrite: bool = False

class DecompressRequest(BaseModel):
    zip_path: str
    dest_path: Optional[str] = None
    overwrite: bool = False

class RefreshMetadataRequest(BaseModel):
    """Single-file metadata refresh after a non-file-manager write (e.g. AI service
    workflow saved a classifier to disk).

    `path` may be storage-relative (`users/<uid>/foo/bar.tlcls`) or absolute under
    STORAGE_ROOT — both are accepted. Multiple paths can be passed via `paths`
    for batch refresh.
    """
    path: Optional[str] = None
    paths: Optional[List[str]] = None

