"""Shared thread pools for slide-scoped blocking work.

Tile reads use an admitted dedicated pool; metadata and overlays have their
own pools so slow image decoding does not block their work.

Sync FastAPI endpoints do not need this: FastAPI already runs them on anyio's
worker threads, which are separate from the tile pool. Use this only where the
caller must stay async.
"""

from concurrent.futures import ThreadPoolExecutor

from app.core.tile_scheduler import TILE_WORKERS

# Filesystem-bound; sized for isolation from the tile burst, not parallelism.
slide_metadata_executor = ThreadPoolExecutor(
    max_workers=4,
    thread_name_prefix="slide-meta",
)

# Zarr structure reads have their own pool because the one they used to borrow
# is the h5->zarr CONVERSION pool: H5_TO_ZARR_MAX_CONCURRENCY defaults to 2, so
# that ThreadPoolExecutor has four workers, sized for a heavy conversion rather
# than for metadata. The file manager asks for a structure per listed zarr, so a
# page of files queued four at a time — which is what turned a call costing tens
# of milliseconds into the 4-second responses in the logs.
#
# Metadata reads are filesystem-bound and release the GIL, so this is about
# concurrency, not CPU.
zarr_structure_executor = ThreadPoolExecutor(
    max_workers=12,
    thread_name_prefix="zarr-structure",
)

# Admission and per-viewer fairness live in TileScheduler. Native worker
# processes have their own VIPS_CONCURRENCY; conversion keeps its current setting.
tile_executor = ThreadPoolExecutor(max_workers=TILE_WORKERS, thread_name_prefix="tile")

# Local overlay rasterization should continue while disk/native readers are slow.
overlay_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="tile-overlay")
