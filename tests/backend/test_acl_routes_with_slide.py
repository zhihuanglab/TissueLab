"""Path / instance guards exercised through the real routes on a real slide.

Needs a whole-slide image; set ``TL_TEST_SLIDE``. Skipped otherwise. The
slide is copied into the read-only Samples area and into the local user's
Personal area, and every write-gated surface is hit on both.
"""
import json
import os
import shutil

import pytest

SLIDE = os.environ.get("TL_TEST_SLIDE", "")

pytestmark = pytest.mark.skipif(
    not os.path.isfile(SLIDE), reason="set TL_TEST_SLIDE to a local whole-slide image"
)


@pytest.fixture(scope="module")
def slides(storage_root, user_root, samples_root, local_uid):
    name = os.path.basename(SLIDE)
    personal = user_root / name
    sample = samples_root / name
    size = os.path.getsize(SLIDE)
    for target in (personal, sample):
        if not target.exists() or target.stat().st_size != size:
            shutil.copy2(SLIDE, target)
    return {
        "name": name,
        "personal_rel": f"users/{local_uid}/{name}",
        "samples_rel": f"samples/{name}",
        "other_rel": f"users/someone-else/{name}",
    }


def _env(r):
    assert r.status_code == 200, r.text
    return r.json()


def _instance(client, rel):
    body = _env(client.post("/api/load/v1/create_instance", json={"file_path": rel}))
    assert body["code"] == 0, body
    data = body["data"]
    return data.get("instance_id") or data.get("instanceId")


def test_read_is_allowed_on_samples_and_personal_but_not_other_users(client, slides):
    assert _instance(client, slides["personal_rel"])
    assert _instance(client, slides["samples_rel"])
    body = _env(client.post("/api/load/v1/create_instance", json={"file_path": slides["other_rel"]}))
    assert body["code"] == 403
    assert body["data"]["error_code"] == "READ_ACCESS_DENIED"


def test_tiles_require_the_owning_instance(client, slides):
    inst = _instance(client, slides["personal_rel"])
    _env(client.post("/api/load/v1/upload_path", json={"relative_path": slides["personal_rel"]}, headers={"X-Instance-ID": inst}))
    r = client.get("/api/load/v1/tile/0/0_0.jpeg", params={"instance_id": inst})
    assert r.status_code == 200 and r.headers["content-type"].startswith("image/")
    r = client.get("/api/load/v1/tile/0/0_0.jpeg", params={"instance_id": "not-an-instance"})
    body = r.json()
    assert body["code"] == 403 and body["data"]["error_code"] == "INSTANCE_OWNER_MISMATCH"
    # thumbnails go through the same ownership check
    body = _env(client.post("/api/thumbnail/v1/thumbnails", json={"session_id": "not-an-instance", "size": 64, "request_id": "t"}))
    assert body["code"] == 403


def test_samples_slide_can_be_viewed_but_not_annotated(client, slides):
    inst = _instance(client, slides["samples_rel"])
    zarr_rel = slides["samples_rel"] + ".zarr"
    body = _env(client.post("/api/seg/v1/save_annotation/batch", json={"path": zarr_rel, "instance_id": inst, "annotations": []}))
    assert body["code"] == 403
    assert body["data"]["error_code"] == "PUBLIC_READ_ONLY_FORBIDDEN"
    assert body["data"]["access_mode"] == "samples"

    body = _env(client.post("/api/seg/v1/clear_nuclei_annotations", json={"path": zarr_rel, "x1": 0, "y1": 0, "x2": 10, "y2": 10}))
    assert body["code"] == 403 and body["data"]["error_code"] == "PUBLIC_READ_ONLY_FORBIDDEN"

    body = _env(client.post("/api/tasks/v1/execute_script", json={"zarr_path": zarr_rel, "code_str": "def analyze_medical_image(path):\n    return 1"}))
    assert body["code"] == 403 and body["data"]["error_code"] == "PUBLIC_READ_ONLY_FORBIDDEN"

    body = _env(client.post("/api/tasks/v1/start_workflow", json={"zarr_path": zarr_rel, "step1": {"model": "StarDist", "input": {}}}))
    assert body["code"] == 403 and body["data"]["error_code"] == "PUBLIC_READ_ONLY_FORBIDDEN"


def test_samples_cannot_be_extracted_or_mutated_through_the_file_manager(client, slides, local_uid):
    body = _env(client.post("/api/fm/v1/files/download-link", params={"path": slides["samples_rel"]}))
    assert body["code"] == 403, body
    r = client.post("/api/fm/v1/files/upload", data={"path": "samples"}, files=[("files", ("x.txt", b"x", "text/plain"))])
    assert r.json()["code"] == 403
    body = _env(client.post("/api/fm/v1/files/move", json={"items": [slides["samples_rel"]], "new_path": f"users/{local_uid}"}))
    assert body["code"] == 403
    # but the local user's own slide can be linked out
    body = _env(client.post("/api/fm/v1/files/download-link", params={"path": slides["personal_rel"]}))
    assert body.get("success") is True and body.get("download_token")


def test_personal_slide_accepts_writes(client, slides):
    inst = _instance(client, slides["personal_rel"])
    zarr_rel = slides["personal_rel"] + ".zarr"
    body = _env(client.post("/api/tasks/v1/execute_script", json={"zarr_path": zarr_rel, "code_str": "def analyze_medical_image(path):\n    return 1"}))
    # not a permission denial: the guard passed (the run itself may fail for other reasons)
    assert body.get("code") != 403 or body["data"].get("error_code") != "PUBLIC_READ_ONLY_FORBIDDEN"
    body = _env(client.post("/api/seg/v1/save_annotation/batch", json={"path": zarr_rel, "instance_id": inst, "annotations": []}))
    assert body.get("data", {}).get("error_code") not in ("PUBLIC_READ_ONLY_FORBIDDEN", "READ_ACCESS_DENIED")


def test_zarr_replacement_requires_user_owned_candidate(client, slides, local_uid):
    body = _env(client.post("/api/fm/v1/zarr/validate_replacement", json={
        "candidate_path": "samples/staging", "target_slide_path": slides["personal_rel"]}))
    assert body["code"] == 403, body
    body = _env(client.post("/api/fm/v1/zarr/validate_replacement", json={
        "candidate_path": f"users/{local_uid}/staging-missing", "target_slide_path": slides["samples_rel"]}))
    assert body["code"] == 403, body


def test_delete_instance_of_unknown_id_is_not_an_error(client):
    body = _env(client.request("DELETE", "/api/load/v1/delete_instance", json={"instance_id": "gone"}))
    assert body["code"] in (0, 403, 404)


def test_presence_websocket_accepts_own_slide(client, slides):
    # The denial path (another user's tree → connection refused) is covered by
    # tests/smoke/smoke_test.py against a real server: the handler returns
    # before accepting, which the in-process TestClient cannot observe.
    with client.websocket_connect(f"/ws/presence?file_path={slides['personal_rel']}&token=local&device_id=t") as ws:
        ws.send_text(json.dumps({"type": "ping"}))


def test_segment_websocket_binds_personal_slide(client, slides):
    inst = _instance(client, slides["personal_rel"])
    with client.websocket_connect("/ws/segment/?token=local&device_id=t") as ws:
        ws.send_text(json.dumps({"type": "set_path", "path": slides["personal_rel"], "instance_id": inst}))
        msg = ws.receive()
        assert msg.get("text") or msg.get("bytes")
