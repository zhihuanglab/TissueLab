from __future__ import annotations

import os


def symlink_relative(
    source: str | os.PathLike[str],
    dest: str | os.PathLike[str],
    *,
    target_is_directory: bool | None = None,
) -> None:
    """Create a symlink whose stored target is relative to its parent directory.

    On Windows, ``target_is_directory`` must be True for directory targets
    (zarr stores). Auto-detect from the source when omitted.
    """
    source_s = os.path.abspath(os.fspath(source))
    dest_s = os.path.abspath(os.fspath(dest))
    dest_parent = os.path.dirname(dest_s) or "."
    try:
        rel_source = os.path.relpath(source_s, start=dest_parent)
    except ValueError:
        # Windows cannot express a relative path across different drives.
        rel_source = source_s
    kwargs: dict[str, object] = {}
    if os.name == "nt":
        if target_is_directory is None:
            target_is_directory = os.path.isdir(source_s)
        kwargs["target_is_directory"] = bool(target_is_directory)
    os.symlink(rel_source, dest_s, **kwargs)
