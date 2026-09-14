"""Radiology volumes (NIfTI) through the loader / view-link, and H5 → Zarr conversion jobs."""
import time

import numpy as np
import pytest


def _ok(r):
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def nifti(user_root, local_uid):
    nib = pytest.importorskip("nibabel")
    data = (np.random.default_rng(0).random((24, 24, 8)) * 255).astype("uint8")
    img = nib.Nifti1Image(data, np.eye(4))
    path = user_root / "volume.nii.gz"
    nib.save(img, str(path))
    return f"users/{local_uid}/volume.nii.gz"


def test_nifti_view_link_and_download(client, nifti, local_uid):
    link = _ok(client.post("/api/fm/v1/files/view-link", params={"path": nifti}))
    assert link.get("success") is True, link
    token = link.get("download_token") or link.get("view_token") or link.get("token")
    assert token, link
    r = client.get(f"/api/fm/v1/files/download/{token}")
    assert r.status_code == 200 and len(r.content) > 100

    # view links are for radiology formats only; a slide is not an in-viewer load
    denied = _ok(client.post("/api/fm/v1/files/view-link", params={"path": f"users/{local_uid}/not-a-volume.svs"}))
    assert denied.get("success") is not True
    # and never for the public Samples area
    denied = _ok(client.post("/api/fm/v1/files/view-link", params={"path": "samples/volume.nii.gz"}))
    assert denied.get("success") is not True


def test_nifti_opens_as_instance(client, nifti):
    body = _ok(client.post("/api/load/v1/create_instance", json={"file_path": nifti}))
    assert body["code"] == 0, body
    inst = body["data"].get("instance_id") or body["data"].get("instanceId")
    up = _ok(client.post("/api/load/v1/upload_path", json={"relative_path": nifti}, headers={"X-Instance-ID": inst}))
    assert up["code"] == 0, up
    # Volumes are rendered client-side (NiiVue) from the view-link download, so the
    # server registers the file without parsing it: no tile/properties for NIfTI.
    assert "nii" in str(up["data"]).lower()
    _ok(client.request("DELETE", "/api/load/v1/delete_instance", json={"instance_id": inst}, headers={"X-Instance-ID": inst}))


def test_radiology_zarr_listing(client, nifti, user_root, local_uid):
    import zarr
    zarr.open_group(str(user_root / "volume.nii.gz.zarr"), mode="w").create_group("Segmentation")
    body = _ok(client.get("/api/radiology/v1/list_zarr_files", params={"base_path": f"users/{local_uid}"}))
    assert body["code"] == 0, body
    assert "volume.nii.gz.zarr" in str(body["data"])
    denied = _ok(client.get("/api/radiology/v1/list_zarr_files", params={"base_path": "users/other"}))
    assert denied["code"] == 403


def test_h5_to_zarr_conversion_job(client, user_root, local_uid):
    h5py = pytest.importorskip("h5py")
    src = user_root / "convert-me.h5"
    with h5py.File(src, "w") as f:
        g = f.create_group("Cell-Segmentation")
        g.create_dataset("centroids", data=np.arange(20, dtype="float32").reshape(10, 2))
        f.attrs["origin"] = "test"
    target = f"users/{local_uid}/convert-me.zarr"
    body = _ok(client.post("/api/data/v1/convert", json={
        "source_path": f"users/{local_uid}/convert-me.h5", "target_path": target, "overwrite": True}))
    assert body["code"] == 0, body
    job_id = body["data"].get("job_id") or body["data"].get("id")
    assert job_id, body
    deadline = time.time() + 60
    job = None
    while time.time() < deadline:
        job = _ok(client.get(f"/api/data/v1/convert/{job_id}"))["data"]
        if job.get("status") in ("completed", "done", "success", "succeeded", "failed", "error"):
            break
        time.sleep(0.3)
    assert job and job.get("status") in ("completed", "done", "success", "succeeded"), job
    assert (user_root / "convert-me.zarr").is_dir()
    structure = _ok(client.get("/api/data/v1/structure", params={"relative_path": target}))
    assert "centroids" in str(structure["data"])

    # conversion into the Samples area is a write and therefore refused
    denied = _ok(client.post("/api/data/v1/convert", json={
        "source_path": f"users/{local_uid}/convert-me.h5", "target_path": "samples/x.zarr"}))
    assert denied["code"] == 403
