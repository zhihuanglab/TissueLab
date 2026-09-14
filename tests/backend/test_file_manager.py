"""File manager (ported from the control plane) running against the local disk only."""
import io
import time

import pytest


def _ok(r):
    assert r.status_code == 200, r.text
    return r.json()


def test_config_points_at_local_user(client, local_uid):
    body = _ok(client.get("/api/fm/v1/config"))
    assert body["defaultPath"] == f"users/{local_uid}"
    assert isinstance(body["storageUsage"], int)
    assert body["storageQuota"] > 0
    assert isinstance(body["virtualLinks"], list)


def test_list_root_defaults_to_personal_folder(client, user_root, local_uid):
    (user_root / "listed.txt").write_text("hi")
    rows = _ok(client.get("/api/fm/v1/files"))
    assert isinstance(rows, list)
    names = {row["name"] for row in rows}
    assert "listed.txt" in names
    row = next(r for r in rows if r["name"] == "listed.txt")
    assert row["path"] == f"users/{local_uid}/listed.txt"
    assert row["is_dir"] is False and row["size"] == 2


def test_list_paginated_shape(client, user_root):
    for i in range(3):
        (user_root / f"page{i}.txt").write_text("x")
    body = _ok(client.get("/api/fm/v1/files", params={"limit": 2, "sort_by": "name", "sort_dir": "asc"}))
    assert set(body) >= {"items", "pagination"}
    assert len(body["items"]) == 2
    assert body["pagination"]["total"] >= 3


def test_other_users_and_traversal_are_forbidden(client, local_uid):
    body = _ok(client.get("/api/fm/v1/files", params={"path": "users/someone-else"}))
    assert body["code"] == 403
    body = _ok(client.get("/api/fm/v1/files", params={"path": f"users/{local_uid}/../someone-else"}))
    assert body["code"] == 403


def test_create_rename_move_delete(client, user_root, local_uid):
    base = f"users/{local_uid}"
    _ok(client.post("/api/fm/v1/files/create", json={"path": f"{base}/folder-a/"}))
    assert (user_root / "folder-a").is_dir()
    _ok(client.post("/api/fm/v1/files/create", json={"path": f"{base}/folder-a/note.txt", "content": "hello"}))
    assert (user_root / "folder-a" / "note.txt").read_text() == "hello"

    dup = _ok(client.post("/api/fm/v1/files/create", json={"path": f"{base}/folder-a/note.txt"}))
    assert dup["code"] == 400

    _ok(client.post("/api/fm/v1/files/rename", json={"path": f"{base}/folder-a/note.txt", "new_path": f"{base}/folder-a/renamed.txt"}))
    assert (user_root / "folder-a" / "renamed.txt").exists()

    _ok(client.post("/api/fm/v1/files/create", json={"path": f"{base}/folder-b/"}))
    _ok(client.post("/api/fm/v1/files/move", json={"items": [f"{base}/folder-a/renamed.txt"], "new_path": f"{base}/folder-b"}))
    assert (user_root / "folder-b" / "renamed.txt").exists()

    body = _ok(client.post("/api/fm/v1/files/delete", json={"items": [f"{base}/folder-a", f"{base}/folder-b"]}))
    assert body["success"] is True
    task_id = body.get("task_id")
    deadline = time.time() + 20
    while task_id and time.time() < deadline:
        status = _ok(client.get(f"/api/fm/v1/files/task_status/{task_id}"))
        if status.get("status") in ("completed", "failed", "error"):
            break
        time.sleep(0.2)
    assert not (user_root / "folder-a").exists()
    assert not (user_root / "folder-b").exists()


def test_samples_are_read_only_for_writes(client, samples_root):
    (samples_root / "ro.txt").write_text("x")
    body = _ok(client.post("/api/fm/v1/files/create", json={"path": "samples/new/"}))
    assert body["code"] == 403
    body = _ok(client.post("/api/fm/v1/files/rename", json={"path": "samples/ro.txt", "new_path": "samples/rw.txt"}))
    assert body["code"] == 403
    body = _ok(client.post("/api/fm/v1/files/delete", json={"items": ["samples/ro.txt"]}))
    assert body["code"] == 403
    assert (samples_root / "ro.txt").exists()


def test_upload_then_download_link(client, user_root, local_uid):
    base = f"users/{local_uid}"
    r = client.post(
        "/api/fm/v1/files/upload",
        data={"path": base, "overwrite": "true"},
        files=[("files", ("uploaded.txt", io.BytesIO(b"payload"), "text/plain"))],
    )
    body = _ok(r)
    assert body.get("success") is True, body
    assert (user_root / "uploaded.txt").read_bytes() == b"payload"

    link = _ok(client.post("/api/fm/v1/files/download-link", params={"path": f"{base}/uploaded.txt"}))
    token = link.get("download_token")
    assert link.get("success") is True and token
    r = client.get(f"/api/fm/v1/files/download/{token}")
    assert r.status_code == 200 and r.content == b"payload"


def test_chunked_upload(client, user_root, local_uid):
    base = f"users/{local_uid}"
    payload = b"0123456789" * 300  # 3000 bytes
    chunk_size = 1024
    init = _ok(client.post("/api/fm/v1/files/upload/init", data={
        "filename": "chunked.bin", "total_size": str(len(payload)), "path": base,
        "chunk_size": str(chunk_size), "overwrite": "true",
    }))
    upload_id = init["upload_id"]
    total = (len(payload) + chunk_size - 1) // chunk_size
    for idx in range(total):
        chunk = payload[idx * chunk_size:(idx + 1) * chunk_size]
        _ok(client.post("/api/fm/v1/files/upload/chunk", data={"upload_id": upload_id, "chunk_index": str(idx)},
                        files={"chunk_data": ("blob", io.BytesIO(chunk), "application/octet-stream")}))
    status = _ok(client.get(f"/api/fm/v1/files/upload/status/{upload_id}"))
    assert status["upload_id"] == upload_id
    done = _ok(client.post("/api/fm/v1/files/upload/complete", data={"upload_id": upload_id}))
    assert done.get("success") is True, done
    assert (user_root / "chunked.bin").read_bytes() == payload


def test_search_scoped_to_personal(client, user_root, local_uid):
    (user_root / "needle-slide.svs").write_bytes(b"x")
    rows = _ok(client.get("/api/fm/v1/files/search", params={"query": "needle"}))
    assert any(r["name"] == "needle-slide.svs" for r in rows)


def test_file_access_peek(client, user_root, samples_root, local_uid):
    (user_root / "peek.svs").write_bytes(b"x")
    body = _ok(client.get("/api/fm/v1/files/access", params={"path": f"users/{local_uid}/peek.svs"}))
    assert body == {"path": f"users/{local_uid}/peek.svs", "shareMode": None, "readOnly": False}
    (samples_root / "peek.svs").write_bytes(b"x")
    body = _ok(client.get("/api/fm/v1/files/access", params={"path": "samples/peek.svs"}))
    assert body["readOnly"] is True and body["shareMode"] is None
    body = _ok(client.get("/api/fm/v1/files/access", params={"path": "users/other/peek.svs"}))
    assert body["code"] == 403


def test_share_routes_are_gone(client):
    for path in ("/api/fm/v1/files/shared", "/api/fm/v1/files/share"):
        r = client.get(path)
        assert r.status_code in (404, 405) or r.json().get("code") == 404


def test_compress_and_decompress(client, user_root, local_uid):
    base = f"users/{local_uid}"
    # Only directory-format .zarr stores are compressed (that is the feature's contract).
    (user_root / "zipme.zarr").mkdir(exist_ok=True)
    (user_root / "zipme.zarr" / "zarr.json").write_text('{"zarr_format": 3, "node_type": "group"}')
    body = _ok(client.post("/api/fm/v1/files/compress", json={"items": [f"{base}/zipme.zarr"], "zip_name": "zipme.zip", "overwrite": True}))
    task_id = body.get("task_id")
    assert task_id
    deadline = time.time() + 30
    while time.time() < deadline:
        status = _ok(client.get(f"/api/fm/v1/files/task_status/{task_id}"))
        if status.get("status") in ("completed", "failed", "error"):
            break
        time.sleep(0.2)
    assert status.get("status") == "completed", status
    assert (user_root / "zipme.zip").exists()

    (user_root / "unzipped").mkdir(exist_ok=True)  # destination must be an existing folder
    body = _ok(client.post("/api/fm/v1/files/decompress", json={"zip_path": f"{base}/zipme.zip", "dest_path": f"{base}/unzipped", "overwrite": True}))
    task_id = body.get("task_id")
    deadline = time.time() + 30
    while time.time() < deadline:
        status = _ok(client.get(f"/api/fm/v1/files/task_status/{task_id}"))
        if status.get("status") in ("completed", "failed", "error"):
            break
        time.sleep(0.2)
    assert status.get("status") == "completed", status
    extracted = list((user_root / "unzipped").rglob("zarr.json"))
    assert extracted, list((user_root / "unzipped").rglob("*"))


def test_refresh_metadata_is_a_stat_only_noop(client, user_root, local_uid):
    (user_root / "meta.txt").write_text("abc")
    body = _ok(client.post("/api/fm/v1/files/refresh-metadata", json={"paths": [f"users/{local_uid}/meta.txt", "users/other/x"]}))
    assert body["success"] is True
    assert body["refreshed"][0]["size"] == 3
    assert body["skipped"][0]["reason"] == "forbidden"
