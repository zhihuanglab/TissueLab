"""Classifier files, freeform manual annotations, panel configs, node listing utilities."""
import base64
import json

import zarr


def _ok(r):
    assert r.status_code == 200, r.text
    return r.json()


def test_classifier_file_save_load_and_model_names(client, user_root, local_uid, samples_root):
    payload = base64.b64encode(b"not-a-real-model-but-bytes").decode()
    dest = f"users/{local_uid}/classifiers/demo.tlcls"
    body = _ok(client.post("/api/seg/v1/classifier_file/save", json={"path": dest, "content_base64": payload}))
    assert body["code"] == 0, body
    assert (user_root / "classifiers" / "demo.tlcls").read_bytes() == b"not-a-real-model-but-bytes"

    r = client.get("/api/seg/v1/classifier_file/load", params={"file_path": dest})
    assert r.status_code == 200 and r.content == b"not-a-real-model-but-bytes"

    names = _ok(client.post("/api/seg/v1/classifier_file/model_names", json={"paths": [dest]}))
    assert names["code"] == 0, names

    # copy mode and the read-only Samples area
    body = _ok(client.post("/api/seg/v1/classifier_file/save", json={"path": f"users/{local_uid}/classifiers/copy.tlcls", "copy_from_path": dest}))
    assert body["code"] == 0 and body["data"]["mode"] == "copy", body
    (samples_root / "classifiers").mkdir(exist_ok=True)
    denied = _ok(client.post("/api/seg/v1/classifier_file/save", json={"path": "samples/classifiers/x.tlcls", "content_base64": payload}))
    assert denied["code"] == 403 and denied["data"]["error_code"] == "PUBLIC_READ_ONLY_FORBIDDEN"
    denied = _ok(client.post("/api/seg/v1/classifier_file/save", json={"path": "users/other/classifiers/x.tlcls", "content_base64": payload}))
    assert denied["code"] == 403
    missing = client.get("/api/seg/v1/classifier_file/load", params={"file_path": f"users/{local_uid}/classifiers/nope.tlcls"})
    assert missing.json()["code"] == 404


def test_manual_annotations_round_trip(client, user_root, local_uid, samples_root):
    zarr.open_group(str(user_root / "manual.zarr"), mode="w")
    rel = f"users/{local_uid}/manual.zarr"
    item = {"path": rel, "id": "ann-1", "shape": "polygon", "vertices": [[0, 0], [10, 0], [10, 10]], "style": "#ff00ff", "comment": "hello"}
    body = _ok(client.post("/api/tasks/v1/save_manual_annotation", json=item))
    assert body["code"] == 0, body
    manual = user_root / "manual.zarr" / "User-Annotations" / "manual.json"
    assert manual.exists()
    saved = json.loads(manual.read_text(encoding="utf-8"))
    assert "ann-1" in json.dumps(saved)

    body = _ok(client.post("/api/tasks/v1/delete_manual_annotation", json={"path": rel, "id": "ann-1"}))
    assert body["code"] == 0, body
    assert "ann-1" not in manual.read_text(encoding="utf-8")

    zarr.open_group(str(samples_root / "manual.zarr"), mode="w")
    denied = _ok(client.post("/api/tasks/v1/save_manual_annotation", json={**item, "path": "samples/manual.zarr"}))
    assert denied["code"] == 403 and denied["data"]["error_code"] == "PUBLIC_READ_ONLY_FORBIDDEN"


def test_panel_config_round_trip(client, service_root):
    cfg = {"title": "Cell/Nuclei Segmentation", "panel": [{"name": "threshold", "type": "number", "default": 0.5}]}
    body = _ok(client.post("/api/tasks/v1/save_panel_config", json={"model_name": "StarDist", "panel_config": cfg}))
    assert body["code"] == 0, body
    got = _ok(client.get("/api/tasks/v1/get_panel_config/StarDist"))
    assert got["code"] == 0 and "threshold" in json.dumps(got["data"]), got
    allc = _ok(client.get("/api/tasks/v1/get_all_panel_configs"))
    assert allc["code"] == 0 and "StarDist" in json.dumps(allc["data"])
    # persisted under the service root, never next to the code
    assert (service_root / "storage" / "model_registry.json").exists()


def test_registry_reload_and_environment_listing(client):
    body = _ok(client.post("/api/tasks/v1/reload_model_registry"))
    assert body["code"] == 0, body
    ext = _ok(client.get("/api/tasks/v1/list_nodes_extended"))
    assert ext["code"] == 0
    listed = json.dumps(ext["data"])
    assert "StarDist" in listed or "NuClass" in listed  # preset registry seeded
    envs = _ok(client.get("/api/tasks/v1/list_conda_envs"))
    assert envs["code"] == 0, envs
    status = _ok(client.get("/api/activation/v1/status"))
    assert status["code"] == 0
