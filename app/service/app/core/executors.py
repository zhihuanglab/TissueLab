"""Shared thread pools for slide-scoped blocking work.

Tile reads use ``loop.run_in_executor(None, ...)`` — and so does
``asyncio.to_thread``. Opening a slide fires a tile burst that fills that
default pool, so a bind handed to ``to_thread`` at the same moment queues behind
it (measured: 51 ms on its own pool, ~790 ms sharing). Hence a separate one.

Sync FastAPI endpoints do not need this: FastAPI already runs them on anyio's
worker threads, which are separate from the tile pool. Use this only where the
caller must stay async.
"""

import os
from concurrent.futures import ThreadPoolExecutor

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

# Sized well under the default pool on purpose. Each tile job runs a libvips
# pipeline that opens a threadpool of its own (2-6 workers observed), so 32
# concurrent tiles put ~190 threads on a 20-core box and the wall-clock cost per
# tile grew with the oversubscription rather than the work. Capping the tile
# jobs keeps total threads near the core count. VIPS_CONCURRENCY is still unset,
# so libvips sizes each pipeline off the core count; lowering it would cut the
# thread count further, at the cost of the pyramid-conversion path that wants it.
tile_executor = ThreadPoolExecutor(
    max_workers=max(4, min(12, os.cpu_count() or 4)),
    thread_name_prefix="tile",
)
