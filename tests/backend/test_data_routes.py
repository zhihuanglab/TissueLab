"""Zarr data browser routes (/api/data) on generated stores, incl. extract gating."""
import numpy as np
import pytest
import zarr


def _ok(r):
    assert r.status_code == 200, r.text
    return r.json()


def _make_store(path):
    root = zarr.open_group(str(path), mode="w")
    root.attrs["slide"] = "synthetic"
    seg = root.create_group("Cell-Segmentation")
    arr = seg.create_array("centroids", shape=(10, 2), dtype="float32")
    arr[:] = np.arange(20, dtype="float32").reshape(10, 2)
    arr.attrs["unit"] = "px"
    root.create_group("User-Annotations")


@pytest.fixture(scope="module")
def stores(user_root, samples_root, local_uid):
    _make_store(user_root / "data.zarr")
    _make_store(samples_root / "data.zarr")
    return {"personal": f"users/{local_uid}/data.zarr", "samples": "samples/data.zarr", "other": "users/other/data.zarr"}


def test_info_structure_and_search(client, stores):
    info = _ok(client.get("/api/data/v1/info", params={"relative_path": stores["personal"]}))
    assert info["code"] == 0, info
    structure = _ok(client.get("/api/data/v1/structure", params={"relative_path": stores["personal"], "path": "/"}))
    assert structure["code"] == 0, structure
    dumped = str(structure["data"])
    assert "Cell-Segmentation" in dumped and "centroids" in dumped
    found = _ok(client.get("/api/data/v1/search", params={"relative_path": stores["personal"], "query": "centro"}))
    assert found["code"] == 0 and "centroids" in str(found["data"])
    arr = _ok(client.get("/api/data/v1/arrays/Cell-Segmentation/centroids", params={"relative_path": stores["personal"]}))
    assert arr["code"] == 0 and list(arr["data"].get("shape", [])) == [10, 2], arr
    attrs = _ok(client.get("/api/data/v1/objects/Cell-Segmentation/centroids/attributes", params={"relative_path": stores["personal"]}))
    assert attrs["code"] == 0 and "px" in str(attrs["data"])


def test_samples_can_be_inspected_and_sliced_but_not_dumped(client, stores):
    structure = _ok(client.get("/api/data/v1/structure", params={"relative_path": stores["samples"]}))
    assert structure["code"] == 0
    sliced = _ok(client.get("/api/data/v1/arrays/Cell-Segmentation/centroids/data",
                            params={"relative_path": stores["samples"], "start_indices": "0,0", "end_indices": "2,2"}))
    assert sliced["code"] == 0, sliced
    dump = _ok(client.get("/api/data/v1/arrays/Cell-Segmentation/centroids/data", params={"relative_path": stores["samples"]}))
    assert dump["code"] == 403 and dump["data"]["error_code"] == "PUBLIC_READ_ONLY_FORBIDDEN", dump
    export = _ok(client.post("/api/data/v1/export/structure", params={"relative_path": stores["samples"]},
                             json={"export_path": "samples/out.json"}))
    assert export["code"] == 403, export


def test_personal_store_allows_dump_and_export(client, stores, user_root):
    dump = _ok(client.get("/api/data/v1/arrays/Cell-Segmentation/centroids/data", params={"relative_path": stores["personal"]}))
    assert dump["code"] == 0, dump
    export = _ok(client.post("/api/data/v1/export/structure", params={"relative_path": stores["personal"]},
                             json={"export_path": stores["personal"].replace("data.zarr", "structure.json")}))
    assert export["code"] == 0, export
    assert (user_root / "structure.json").exists() or "structure" in str(export["data"]).lower()


def test_other_user_store_is_denied(client, stores):
    body = _ok(client.get("/api/data/v1/structure", params={"relative_path": stores["other"]}))
    assert body["code"] == 403 and body["data"]["error_code"] == "READ_ACCESS_DENIED"


def test_annotation_put_delete_respects_samples(client, stores):
    denied = _ok(client.put("/api/data/v1/arrays/Cell-Segmentation/centroids/annotations/1",
                            params={"relative_path": stores["samples"]}, json={"new_class_name": "tumor"}))
    assert denied["code"] == 403
    denied = _ok(client.delete("/api/data/v1/arrays/Cell-Segmentation/centroids/annotations/1",
                               params={"relative_path": stores["samples"]}))
    assert denied["code"] == 403
