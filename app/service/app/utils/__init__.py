import os
from urllib.parse import unquote

from app.config.path_config import STORAGE_ROOT, resolve_virtual_path

def resolve_path(path: str) -> str:
    """
    resolve path, compatible with absolute path and relative path
    - absolute path: return directly
    - relative path: concatenate to STORAGE_ROOT

    Virtual-path aliases (e.g. 'samples/Data/...' → '/tissuelab/data/...') are
    expanded before deciding absolute-vs-relative so every caller that goes
    through resolve_path — thumbnail/preview, segmentation, load, file manager,
    etc. — sees the real on-disk path. Applying it twice is idempotent (absolute
    targets don't match any alias), so call-sites that already pre-resolve via
    resolve_virtual_path keep working unchanged.

    Uses os.path.abspath (NOT realpath) so symlinks are intentionally NOT
    followed. A "use without copying" sample is exposed as a symlink under
    users/{uid}/... (the WSI, and the embedding group inside the .zarr); we must
    operate on that user-space path. Following the link back to the shared
    samples source would make reads land on the wrong (source) zarr — so a
    classifier run's overlay would never appear to update — and would make a
    delete remove the shared original. abspath still collapses '.'/'..'
    components, so path traversal is normalized exactly as before; only symlink
    resolution changes.
    """
    if not path:
        return STORAGE_ROOT
    decoded_path = unquote(path).strip()
    # normalize Windows-style backslashes to POSIX-style separators for consistent handling
    decoded_path = decoded_path.replace('\\', '/')
    # expand user home if present
    decoded_path = os.path.expanduser(decoded_path)
    # expand virtual-path aliases (e.g. 'samples/Data/...' → '/tissuelab/data/...')
    decoded_path = resolve_virtual_path(decoded_path)
    # if absolute path, return directly
    if os.path.isabs(decoded_path):
        return os.path.abspath(decoded_path)
    # otherwise concatenate to STORAGE_ROOT with normalized relative path
    normalized_rel = os.path.normpath(decoded_path.lstrip('/'))
    full_path = os.path.join(STORAGE_ROOT, normalized_rel)
    return os.path.abspath(full_path)

from app.utils.common.decorator import async_retry
from app.utils.converter import (
    ConversionConfig,
    convert_h5_to_zarr,
    test_zarr_file,
)


__all__ = ["async_retry", "resolve_path", "ConversionConfig", "convert_h5_to_zarr", "test_zarr_file"]
