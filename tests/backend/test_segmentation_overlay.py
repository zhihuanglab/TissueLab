"""Viewer overlay pipeline on a real slide with a synthetic segmentation store.

Builds ``<slide>.zarr`` with the layout task nodes produce (Cell-Segmentation
centroids/contours, Cell-Classification class palette + class_indices), opens
the slide, binds it over the segmentation websocket and drives the /seg
routes the sidebar uses: viewport query, counts, classifications, batch
annotation, CSV export — plus the read-only Samples gate on the same data.
"""
import json
import os
import shutil

import numpy as np
import pytest
import zarr

SLIDE = os.environ.get("TL_TEST_SLIDE", "")

pytestmark = pytest.mark.skipif(
    not os.path.isfile(SLIDE), reason="set TL_TEST_SLIDE to a local whole-slide image"
)

N_CELLS = 200


def _ok(r):
    assert r.status_code == 200, r.text
    return r.json()


def _build_seg_store(path):
    rng = np.random.default_rng(42)
    root = zarr.open_group(str(path), mode="w")
    seg = root.create_group("Cell-Segmentation")
    centroids = np.zeros((N_CELLS, 2), dtype="float32")
    centroids[:, 0] = rng.uniform(1000, 3000, N_CELLS)
    centroids[:, 1] = rng.uniform(1000, 3000, N_CELLS)
    c = seg.create_array("centroids", shape=centroids.shape, dtype="float32")
    c[:] = centroids
    angles = np.linspace(0, 2 * np.pi, 32, endpoint=False)
    contours = np.stack([
        np.stack([centroids[:, 0, None] + 8 * np.cos(angles), centroids[:, 1, None] + 8 * np.sin(angles)], axis=-1)
    ], axis=0)[0].astype("float32")  # (N, 32, 2)
    k = seg.create_array("contours", shape=contours.shape, dtype="float32")
    k[:] = contours
    cls = root.create_group("Cell-Classification")
    cls.attrs["class_names"] = ["tumor", "other"]
    cls.attrs["class_colors"] = ["#ff0000", "#00ff00"]
    idx = cls.create_array("class_indices", shape=(N_CELLS,), dtype="int32")
    idx[:] = (np.arange(N_CELLS) % 2).astype("int32")
    root.create_group("User-Annotations")
    return centroids


@pytest.fixture(scope="module")
def seg_slides(user_root, samples_root, local_uid):
    name = os.path.basename(SLIDE)
    out = {}
    for label, folder, rel in (("personal", user_root, f"users/{local_uid}"), ("samples", samples_root, "samples")):
        slide = folder / f"seg-{name}"
        if not slide.exists() or slide.stat().st_size != os.path.getsize(SLIDE):
            shutil.copy2(SLIDE, slide)
        centroids = _build_seg_store(folder / f"seg-{name}.zarr")
        out[label] = {"slide_rel": f"{rel}/seg-{name}", "zarr_rel": f"{rel}/seg-{name}.zarr", "centroids": centroids}
    return out


def _open(client, slide_rel):
    inst = _ok(client.post("/api/load/v1/create_instance", json={"file_path": slide_rel}))["data"]
    instance_id = inst.get("instance_id") or inst.get("instanceId")
    hdr = {"X-Instance-ID": instance_id}
    _ok(client.post("/api/load/v1/upload_path", json={"relative_path": slide_rel}, headers=hdr))
    return instance_id, hdr


def _bind(client, slide_rel, instance_id):
    with client.websocket_connect("/ws/segment/?token=local&device_id=t") as ws:
        ws.send_text(json.dumps({"type": "set_path", "path": slide_rel, "instance_id": instance_id}))
        for _ in range(5):
            msg = ws.receive()
            if msg.get("text"):
                data = json.loads(msg["text"])
                if data.get("type") == "set_path":
                    return data
        raise AssertionError("no set_path ack")


def test_bind_query_counts_and_classes(client, seg_slides):
    s = seg_slides["personal"]
    instance_id, hdr = _open(client, s["slide_rel"])
    ack = _bind(client, s["slide_rel"], instance_id)
    assert ack.get("status") in ("success", "ok", None) and "error" not in str(ack).lower(), ack

    xs, ys = s["centroids"][:, 0], s["centroids"][:, 1]
    q = _ok(client.get("/api/seg/v1/query", params={
        "x1": float(xs.min()) - 1, "y1": float(ys.min()) - 1, "x2": float(xs.max()) + 1, "y2": float(ys.max()) + 1,
        "with_classes": "true"}, headers=hdr))
    assert q["code"] == 0, q
    body = json.dumps(q["data"])
    assert "tumor" in body and "other" in body

    counts = _ok(client.get("/api/seg/v1/total_counts", headers=hdr))
    assert counts["code"] == 0, counts
    flat = json.dumps(counts["data"])
    assert "tumor" in flat and "100" in flat, counts  # 200 cells, alternating classes

    classes = _ok(client.get("/api/seg/v1/classifications", headers=hdr))
    assert classes["code"] == 0 and "tumor" in json.dumps(classes["data"]), classes

    colors = _ok(client.get("/api/seg/v1/annotation_colors", headers=hdr))
    assert colors["code"] == 0


def test_batch_annotation_and_export_on_personal_slide(client, seg_slides, user_root):
    s = seg_slides["personal"]
    instance_id, hdr = _open(client, s["slide_rel"])
    _bind(client, s["slide_rel"], instance_id)
    xs, ys = s["centroids"][:, 0], s["centroids"][:, 1]
    body = _ok(client.post("/api/seg/v1/save_annotation/batch", headers=hdr, json={
        "path": s["zarr_rel"], "instance_id": instance_id, "annotation_type": "nuclei",
        "x1": float(xs.min()) - 1, "y1": float(ys.min()) - 1, "x2": float(xs.min()) + 400, "y2": float(ys.max()) + 1,
        "annotator": "local",
    }))
    assert body["code"] == 0, body

    r = client.get("/api/seg/v1/annotations/export/csv", headers=hdr)
    assert r.status_code == 200
    if r.headers.get("content-type", "").startswith("application/json"):
        assert r.json()["code"] == 0, r.text
    else:
        assert any("," in line for line in r.text.splitlines()), r.text[:200]

    listed = _ok(client.get("/api/seg/v1/annotations/user/list", headers=hdr))
    assert listed["code"] == 0

    store = zarr.open_group(str(user_root / os.path.basename(s["zarr_rel"])), mode="r")
    assert "User-Annotations" in store


def test_samples_slide_overlay_is_read_only(client, seg_slides):
    s = seg_slides["samples"]
    instance_id, hdr = _open(client, s["slide_rel"])
    _bind(client, s["slide_rel"], instance_id)
    xs, ys = s["centroids"][:, 0], s["centroids"][:, 1]
    q = _ok(client.get("/api/seg/v1/query", params={
        "x1": float(xs.min()) - 1, "y1": float(ys.min()) - 1, "x2": float(xs.max()) + 1, "y2": float(ys.max()) + 1}, headers=hdr))
    assert q["code"] == 0, q  # viewing is fine

    denied = _ok(client.post("/api/seg/v1/save_annotation/batch", headers=hdr, json={
        "path": s["zarr_rel"], "instance_id": instance_id, "x1": 0, "y1": 0, "x2": 5000, "y2": 5000}))
    assert denied["code"] == 403 and denied["data"]["error_code"] == "PUBLIC_READ_ONLY_FORBIDDEN"

    r = client.get("/api/seg/v1/annotations/export/csv", headers=hdr)
    assert r.status_code == 200 and r.json()["code"] == 403, r.text
    denied = _ok(client.post("/api/seg/v1/update-class-color", headers=hdr,
                             json={"class_name": "tumor", "new_color": "#0000ff", "file_path": s["zarr_rel"]}))
    assert denied["code"] == 403, denied
    denied = _ok(client.post("/api/seg/v1/export/classifications", headers=hdr, json={"format": "json"}))
    assert denied["code"] == 403, denied
