from typing import Literal, Optional

from pydantic import BaseModel, Field


class H5ToZarrConversionRequest(BaseModel):
    source_path: str = Field(..., description="Source H5/HDF5 file path")
    target_path: Optional[str] = Field(
        None, description="Optional target Zarr directory path"
    )
    compression: Literal["gzip", "lz4", "zstd", "blosc", "none"] = Field(
        "gzip", description="Compression algorithm"
    )
    chunk_size_mb: float = Field(
        64.0, gt=0, description="Target chunk size in MB"
    )
    workers: int = Field(
        4, ge=1, le=32, description="Worker threads used during conversion"
    )
    skip_empty: bool = Field(True, description="Skip empty arrays")
    skip_objects: bool = Field(True, description="Skip object arrays")
    overwrite: bool = Field(
        False, description="Overwrite existing Zarr directory if present"
    )
    test: bool = Field(False, description="Run post-conversion validation")
    verbose: bool = Field(False, description="Enable verbose logging")
    write_stats: bool = Field(
        False,
        description="Persist conversion statistics JSON alongside output",
    )


__all__ = ["H5ToZarrConversionRequest"]

