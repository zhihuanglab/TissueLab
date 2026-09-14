"""Task node bundle resolution without cloud credentials."""
import pytest

CATALOG = {"bundles": [
    {"model_name": "SegmentationNode", "version": "1.0.0", "platform": "win", "arch": "x86_64",
     "gcs_uri": "gs://tissuelab-2025.firebasestorage.app/tasknodes/TissueLab_Segmentation_Win.zip",
     "filename": "TissueLab_Segmentation_Win.zip", "entry_relative_path": "x/x"},
    {"model_name": "SegmentationNode", "version": "1.0.0", "platform": "darwin", "arch": "arm64",
     "gcs_uri": "gs://tissuelab-2025.firebasestorage.app/tasknodes/TissueLab_Segmentation_Mac.zip",
     "filename": "TissueLab_Segmentation_Mac.zip", "entry_relative_path": "x/x"},
]}


@pytest.fixture
def catalog(monkeypatch):
    import app.utils.bundle as bundle

    monkeypatch.setattr(bundle, "load_catalog", lambda: CATALOG)
    return CATALOG


def test_resolve_download_url_maps_object_onto_public_host(app, monkeypatch):
    from app.core.settings import settings
    from app.utils.bundle import resolve_download_url

    monkeypatch.setattr(settings, "TL_BUNDLE_BASE_URL", "https://host.example/bucket/")
    res = resolve_download_url("gs://bucket/tasknodes/a.zip")
    assert res["status"] == "success"
    assert res["signed_url"] == "https://host.example/bucket/tasknodes/a.zip"
    assert resolve_download_url("not-a-uri")["status"] == "fail"


def test_find_bundle_and_catalog_membership(app, catalog):
    from app.utils.bundle import assert_gcs_uri_in_catalog, find_bundle

    assert find_bundle("SegmentationNode", "win")["filename"] == "TissueLab_Segmentation_Win.zip"
    assert find_bundle("SegmentationNode", "linux") is None
    assert assert_gcs_uri_in_catalog(CATALOG["bundles"][0]["gcs_uri"]) is None
    assert assert_gcs_uri_in_catalog("gs://other/x.zip")
    assert assert_gcs_uri_in_catalog("http://x")


def test_download_url_route(client, catalog):
    r = client.post("/api/tasks/v1/bundles/download_url", json={"model_name": "SegmentationNode", "platform": "win"})
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["download_url"].endswith("/tasknodes/TissueLab_Segmentation_Win.zip")
    assert body["filename"] == "TissueLab_Segmentation_Win.zip"

    r = client.post("/api/tasks/v1/bundles/download_url", json={"model_name": "SegmentationNode", "platform": "linux"})
    assert r.status_code == 404 and r.json()["success"] is False

    r = client.post("/api/tasks/v1/bundles/download_url", json={"model_name": ""})
    assert r.status_code == 400


def test_signed_url_route_rejects_uris_outside_catalog(client, catalog):
    r = client.post("/api/tasks/v1/bundles/signed_url", json={"gcs_uri": "gs://evil/x.zip"})
    assert r.json()["code"] == 403
    r = client.post("/api/tasks/v1/bundles/signed_url", json={"gcs_uri": CATALOG["bundles"][1]["gcs_uri"]})
    assert r.json()["code"] == 0
    assert r.json()["data"]["signed_url"].endswith("TissueLab_Segmentation_Mac.zip")
