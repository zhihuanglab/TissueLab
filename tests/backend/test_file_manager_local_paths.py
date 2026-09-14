"""The file manager, driven against files on the user's own disk.

This surface gates in the *service* layer (``app/services/file_manager``), not
on the route, so the route-decorator scan in
``test_local_paths_are_never_denied.py`` cannot see it — these 29 routes were
invisible to it. They also have their own denial vocabulary
(``USER_FORBIDDEN``, ``PERSONAL_ROOT_REQUIRED``, ``PUBLIC_SAMPLES_EXTRACT_*``),
so a denial here would not have shown up there either.

The open edition's file manager reaches the local disk: the app opens slides
the user picked in a native dialog, and the manager lists, links and refreshes
them where they are.
"""
import json
import os

import pytest

FM_DENIAL_CODES = {
    "USER_FORBIDDEN",
    "PERSONAL_ROOT_REQUIRED",
    "PUBLIC_READ_ONLY_FORBIDDEN",
    "PUBLIC_SAMPLES_EXTRACT_FORBIDDEN",
    "VIEW_ONLY_FORBIDDEN",
    "VIEW_ONLY_EXTRACT_FORBIDDEN",
    "VIEW_ACL_UNAVAILABLE",
    "AUTHENTICATED_DOWNLOAD_REQUIRED",
    "READ_ACCESS_DENIED",
    "PATH_ACCESS_DENIED",
    "USER_OWNED_PATH_REQUIRED",
}


@pytest.fixture
def local_tree(tmp_path, storage_root):
    """A folder of the user's own files, outside the storage root."""
    root = tmp_path / "Downloads" / "SVS"
    root.mkdir(parents=True)
    assert not str(root).startswith(str(storage_root))

    (root / "slide.svs").write_bytes(b"x" * 64)
    (root / "notes.txt").write_text("hello")
    (root / "sub").mkdir()
    (root / "sub" / "nested.txt").write_text("nested")
    return root


def _denial(response):
    """The permission denial in *response*, or None. Other failures are fine."""
    try:
        body = response.json()
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(body, dict):
        return None
    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    code = data.get("error_code") or body.get("error_code")
    return f"{code}: {json.dumps(body)[:180]}" if code in FM_DENIAL_CODES else None


def test_browsing_and_reading_a_local_folder_is_not_denied(client, local_tree):
    denied = []
    for method, url, kw in [
        ("GET", "/api/fm/v1/files", {"params": {"path": str(local_tree)}}),
        ("GET", "/api/fm/v1/files", {"params": {"path": str(local_tree / "sub")}}),
        ("GET", "/api/fm/v1/files/access", {"params": {"path": str(local_tree / "slide.svs")}}),
        ("POST", "/api/fm/v1/files/view-link", {"params": {"path": str(local_tree / "slide.svs")}}),
        ("POST", "/api/fm/v1/files/download-link", {"params": {"path": str(local_tree / "slide.svs")}}),
        ("POST", "/api/fm/v1/files/refresh-metadata", {"json": {"path": str(local_tree / "slide.svs")}}),
    ]:
        problem = _denial(client.request(method, url, **kw))
        if problem:
            denied.append(f"{method} {url} -> {problem}")
    assert not denied, "file manager denied the user's own files:\n  " + "\n  ".join(denied)


def test_mutating_local_files_is_not_denied(client, local_tree):
    denied = []
    for method, url, kw in [
        ("POST", "/api/fm/v1/files/create",
         {"json": {"path": str(local_tree / "made-here"), "content": ""}}),
        ("POST", "/api/fm/v1/files/rename",
         {"json": {"path": str(local_tree / "notes.txt"),
                   "new_path": str(local_tree / "renamed.txt")}}),
        ("POST", "/api/fm/v1/files/move",
         {"json": {"items": [str(local_tree / "sub" / "nested.txt")],
                   "new_path": str(local_tree)}}),
        ("POST", "/api/fm/v1/files/compress",
         {"json": {"items": [str(local_tree / "slide.svs")],
                   "dest_path": str(local_tree), "zip_name": "bundle.zip"}}),
        ("POST", "/api/fm/v1/files/upload/init",
         {"data": {"filename": "new.svs", "total_size": 10, "path": str(local_tree)}}),
    ]:
        problem = _denial(client.request(method, url, **kw))
        if problem:
            denied.append(f"{method} {url} -> {problem}")
    assert not denied, "file manager denied a write to the user's own files:\n  " + "\n  ".join(denied)


def test_copy_from_local_disk_into_the_personal_workspace(client, local_tree):
    """The "bring this into my workspace" flows, sourced from the local disk."""
    denied = []
    for url in ("/api/fm/v1/files/copy-to-personal", "/api/fm/v1/folders/copy-to-personal"):
        target = str(local_tree / "slide.svs") if "files/" in url else str(local_tree)
        problem = _denial(client.post(url, json={"source_path": target}))
        if problem:
            denied.append(f"POST {url} -> {problem}")
    assert not denied, "\n  ".join(denied)


def test_samples_is_still_read_only_through_the_file_manager(client, samples_root):
    """The fix must not have opened the one area that is meant to be closed."""
    sample = samples_root / "fm-guard.svs"
    sample.write_bytes(b"x")

    blocked = client.post("/api/fm/v1/files/delete", json={"items": ["samples/fm-guard.svs"]})
    assert _denial(blocked), f"Samples delete should still be refused: {blocked.text[:200]}"

    extract = client.post("/api/fm/v1/files/download-link", params={"path": "samples/fm-guard.svs"})
    assert _denial(extract), f"Samples download should still be refused: {extract.text[:200]}"


def test_deleting_outside_the_storage_root_stays_refused(client, local_tree):
    """Not a permission bug — a deliberate blast-radius limit, kept on purpose.

    ``delete_items`` refuses any path outside STORAGE_ROOT after the ACL has
    already passed ("never delete outside STORAGE_ROOT ... so a crafted or
    absolute path can't make the worker touch anything outside the managed
    store"). Every other file-manager operation reaches the local disk; this
    one deliberately does not, because it is the only irreversible one.

    It answers ``USER_FORBIDDEN``, which reads as an ACL denial and is not:
    the guards pass, the scope check refuses. Worth a distinct code if anyone
    ever surfaces this in the UI.
    """
    target = local_tree / "notes.txt"
    body = client.post("/api/fm/v1/files/delete", json={"items": [str(target)]}).json()
    assert body.get("code") == 403, body
    assert target.exists(), "the refusal must actually have prevented the delete"
