"""Platform assumptions in the path rules, checked from any host.

The service ships for macOS, Windows and Linux and the path code branches on
per-platform behaviour, which a POSIX-only run accepts in silence. These
exercise the real functions; the Windows-specific behaviour they depend on is
stated where it cannot be reproduced here.
"""
import os

import pytest


def test_containment_answers_no_when_the_paths_cannot_be_compared():
    """``commonpath`` raises rather than answering, and that must mean "outside".

    This is the Windows layout that matters: storage under ``C:\\Users\\...``
    and slides on ``D:\\``, where ``ntpath.commonpath`` raises ValueError
    ("Paths don't have the same drive"). Swallowing it as "not inside storage"
    is what lets a D: slide through; letting it propagate would 500 every
    request that named one. Mixing an absolute and a relative path raises the
    same ValueError, so the branch is reachable from here.
    """
    from app.config.path_config import _inside_root

    assert _inside_root("relative/path", "/absolute/root") is False
    assert _inside_root("/absolute/path", "relative/root") is False
    assert _inside_root(None, "/root") is False


def test_is_local_desktop_path_separates_storage_from_the_users_disk(tmp_path, storage_root):
    from app.config.path_config import is_local_desktop_path

    assert is_local_desktop_path(str(tmp_path / "Downloads" / "slide.svs.zarr")) is True
    assert is_local_desktop_path(str(storage_root / "users" / "local" / "x.zarr")) is False
    assert is_local_desktop_path(str(storage_root)) is False
    assert is_local_desktop_path("") is False


def test_normalize_rel_path_keeps_absolute_paths_absolute():
    """The USER_FORBIDDEN bug: ``strip('/')`` turned ``/home/me/x`` into
    ``home/me/x``, which callers then resolved under the storage root.

    POSIX-only damage — a Windows path starts with a drive letter or ``\\\\``,
    neither of which has a leading ``/`` to lose — so a Windows-only test run
    would never have found it. A UNC path is absolute to ``ntpath`` and not to
    ``posixpath``, hence the separate check on either host.
    """
    from app.services.file_manager.common import normalize_rel_path

    native = r"C:\Users\me\Downloads\slide.svs" if os.name == "nt" else "/home/me/Downloads/slide.svs"
    assert normalize_rel_path(native) == native.replace("\\", "/")
    assert normalize_rel_path(r"\\nas\slides\x.svs") == "//nas/slides/x.svs"


@pytest.mark.parametrize("given,expected", [
    ("users/local/slide.svs", "users/local/slide.svs"),
    ("users/local/folder/", "users/local/folder"),
    (r"users\local\slide.svs", "users/local/slide.svs"),
    ("", ""),
    (None, ""),
])
def test_normalize_rel_path_still_normalizes_storage_relative_paths(given, expected):
    from app.services.file_manager.common import normalize_rel_path

    assert normalize_rel_path(given) == expected
