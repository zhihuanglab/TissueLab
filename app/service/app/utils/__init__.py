import os
from urllib.parse import unquote

from app.config.path_config import STORAGE_ROOT

def resolve_path(path: str) -> str:
    """
    resolve path, compatible with absolute path and relative path
    - absolute path: return directly
    - relative path: concatenate to STORAGE_ROOT
    """
    if not path:
        return STORAGE_ROOT
    decoded_path = unquote(path).strip()
    # normalize Windows-style backslashes to POSIX-style separators for consistent handling
    decoded_path = decoded_path.replace('\\', '/')
    # expand user home if present
    decoded_path = os.path.expanduser(decoded_path)
    # if absolute path, return directly
    if os.path.isabs(decoded_path):
        return os.path.realpath(decoded_path)
    # otherwise concatenate to STORAGE_ROOT with normalized relative path
    normalized_rel = os.path.normpath(decoded_path.lstrip('/'))
    full_path = os.path.join(STORAGE_ROOT, normalized_rel)
    return os.path.realpath(full_path)

from app.utils.decorator import async_retry

__all__ = ["async_retry", "resolve_path"]
