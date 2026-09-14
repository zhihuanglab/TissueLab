"""Batch orchestration, task node bundle installation and thumbnail streaming."""
import io
import json
import os
import tarfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import pytest
import zarr

from fake_task_node import FakeTaskNode

SLIDE = os.environ.get("TL_TEST_SLIDE", "")


def _ok(r):
    assert r.status_code == 200, r.text
    return r.json()


def _register(client, node, factory="NucleiSeg"):
    body = _ok(client.post("/api/tasks/v1/register_custom_node", json={
        "model_name": node.name, "python_version": "3.11", "service_path": "fake/service.py",
        "dependency_path": "users/local", "factory": factory, "port": node.port,
        "is_remote": True, "remote_host": "127.0.0.1"}))
    assert body.get("code") == 0, body


def _zarr(user_root, local_uid, name):
    path = user_root / name
    if not path.exists():
        zarr.open_group(str(path), mode="w")
    return f"users/{local_uid}/{name}"


def _wait_batch_idle(client, timeout=90):
    deadline = time.time() + timeout
    snap = None
    while time.time() < deadline:
        snap = _ok(client.get("/api/tasks/v1/batch/active"))["data"]
        if not snap.get("active"):
            return snap
        time.sleep(0.3)
    raise AssertionError(f"batch still active: {snap}")


# ----------------------------------------------------------------- batches
def test_batch_runs_every_item_serially(client, user_root, local_uid):
    node = FakeTaskNode(name="BatchNode", execute_seconds=0.3).start()
    try:
        _register(client, node)
        items = []
        for i in range(3):
            rel = _zarr(user_root, local_uid, f"batch-{i}.zarr")
            items.append({"path": rel, "zarr_path": rel, "payload": {"zarr_path": rel, "step1": {"nodeId": "BatchNode", "input": {"i": i}}}})
        body = _ok(client.post("/api/tasks/v1/start_batch", json={"items": items, "stop_on_first_error": True}))
        assert body["code"] == 0, body
        batch = body["data"]["batch"]
        assert batch.get("total") in (3, None) or len(batch.get("items", [])) == 3

        # a manual start is refused while the batch owns the user
        rel0 = items[0]["zarr_path"]
        clash = _ok(client.post("/api/tasks/v1/start_workflow", json={"zarr_path": rel0, "step1": {"nodeId": "BatchNode", "input": {}}}))
        assert clash["code"] == 409, clash

        _wait_batch_idle(client)
        executes = [p for p in node.paths() if p == "/execute"]
        assert len(executes) == 3, node.paths()
        seen = sorted(b.get("i") for p, b in node.calls if p == "/read")
        assert seen == [0, 1, 2]
    finally:
        node.stop()


def test_stop_batch_cancels_running_item_and_skips_the_rest(client, user_root, local_uid):
    node = FakeTaskNode(name="BatchSlowNode", execute_seconds=30).start()
    try:
        _register(client, node)
        items = []
        for i in range(3):
            rel = _zarr(user_root, local_uid, f"batchstop-{i}.zarr")
            items.append({"path": rel, "zarr_path": rel, "payload": {"zarr_path": rel, "step1": {"nodeId": "BatchSlowNode", "input": {}}}})
        body = _ok(client.post("/api/tasks/v1/start_batch", json={"items": items}))
        assert body["code"] == 0, body
        deadline = time.time() + 20
        while time.time() < deadline and "/execute" not in node.paths():
            time.sleep(0.2)
        assert "/execute" in node.paths()

        stop = _ok(client.post("/api/tasks/v1/stop_batch", json={}))
        assert stop["code"] == 0, stop
        _wait_batch_idle(client, timeout=40)
        assert node.cancelled.is_set()
        assert node.paths().count("/execute") == 1, node.paths()
    finally:
        node.stop()


def test_batch_rejects_samples_and_bad_items(client, samples_root):
    zarr.open_group(str(samples_root / "ro.zarr"), mode="w")
    body = _ok(client.post("/api/tasks/v1/start_batch", json={"items": [{"path": "samples/ro.zarr", "zarr_path": "samples/ro.zarr", "payload": {}}]}))
    assert body["code"] == 403, body
    body = _ok(client.post("/api/tasks/v1/start_batch", json={"items": []}))
    assert body["code"] == 400


# ------------------------------------------------------------------ bundles
class _BundleHost:
    """Serves bundles/catalog.json + tasknodes/<file> over HTTP like the public bucket."""

    def __init__(self, tmp_path):
        self.root = tmp_path / "bundle-host"
        (self.root / "bundles").mkdir(parents=True)
        (self.root / "tasknodes").mkdir()
        entry_dir = tmp_path / "payload" / "FakeBundleNode"
        entry_dir.mkdir(parents=True)
        (entry_dir / "run.py").write_text("print('hello from bundle')\n")
        with tarfile.open(self.root / "tasknodes" / "FakeBundleNode.tar.gz", "w:gz") as tar:
            tar.add(entry_dir, arcname="FakeBundleNode")
        self.entry = {
            "model_name": "FakeBundleNode", "version": "1.0.0", "platform": "win", "arch": "x86_64",
            "gcs_uri": "gs://bucket/tasknodes/FakeBundleNode.tar.gz", "filename": "FakeBundleNode.tar.gz",
            "size_bytes": os.path.getsize(self.root / "tasknodes" / "FakeBundleNode.tar.gz"), "sha256": None,
            "entry_relative_path": "FakeBundleNode/run.py", "display_name": "Fake bundle",
        }
        (self.root / "bundles" / "catalog.json").write_text(json.dumps({"bundles": [self.entry]}))
        handler = type("H", (SimpleHTTPRequestHandler,), {"log_message": lambda *a: None})
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **kw: handler(*a, directory=str(self.root), **kw))
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def test_bundle_install_downloads_unpacks_and_persists(client, tmp_path, monkeypatch, service_root):
    from app.core.settings import settings
    import app.utils.bundle as bundle

    host = _BundleHost(tmp_path)
    try:
        monkeypatch.setattr(settings, "TL_BUNDLE_BASE_URL", host.base_url)
        catalog = _ok(client.get("/api/tasks/v1/bundles/catalog"))
        assert catalog["code"] == 0
        url = _ok(client.post("/api/tasks/v1/bundles/signed_url", json={"gcs_uri": host.entry["gcs_uri"]}))
        assert url["data"]["signed_url"] == f"{host.base_url}/tasknodes/FakeBundleNode.tar.gz"

        body = _ok(client.post("/api/tasks/v1/bundles/install", json=host.entry))
        assert body["code"] == 0, body
        install_id = body["data"]["install_id"]

        deadline = time.time() + 60
        state = None
        while time.time() < deadline:
            state = bundle._install_states.get(install_id) or {}
            if state.get("status") in ("done", "failed", "error"):
                break
            time.sleep(0.2)
        steps = [e.get("step") for e in bundle._install_event_logs.get(install_id, [])]
        assert "download" in steps and "unpack" in steps and "persist" in steps, steps
        assert (service_root / "storage" / "nodes" / "FakeBundleNode" / "FakeBundleNode" / "run.py").is_file()
        # activation of a python file without a conda env cannot succeed; it must fail cleanly
        assert state.get("status") in ("done", "failed"), state
        from app.utils.workflow.model_store import model_store
        runtime = (model_store.get_nodes_extended().get("FakeBundleNode") or {}).get("runtime") or {}
        assert runtime.get("service_path", "").endswith("run.py")
    finally:
        host.stop()


def test_bundle_install_refuses_uris_outside_catalog(client, monkeypatch):
    import app.utils.bundle as bundle

    monkeypatch.setattr(bundle, "load_catalog", lambda: {"bundles": []})
    body = _ok(client.post("/api/tasks/v1/bundles/install", json={
        "model_name": "Evil", "gcs_uri": "gs://evil/x.tar.gz", "entry_relative_path": "x"}))
    assert body["code"] == 403 and body["data"]["error_code"] == "BUNDLE_URI_NOT_ALLOWED"


# --------------------------------------------------------------- thumbnails
@pytest.mark.skipif(not os.path.isfile(SLIDE), reason="set TL_TEST_SLIDE to a local whole-slide image")
def test_thumbnail_task_streams_to_owner(client, user_root, local_uid):
    import shutil

    name = os.path.basename(SLIDE)
    if not (user_root / name).exists():
        shutil.copy2(SLIDE, user_root / name)
    inst = _ok(client.post("/api/load/v1/create_instance", json={"file_path": f"users/{local_uid}/{name}"}))["data"]
    instance_id = inst.get("instance_id") or inst.get("instanceId")
    sub = _ok(client.post("/api/thumbnail/v1/thumbnails", json={"session_id": instance_id, "size": 96, "request_id": "ws-1"}))
    assert sub["code"] == 0, sub
    task_id = sub["data"]["task_id"]

    with client.websocket_connect(f"/ws/thumbnail/{task_id}/?token=local") as ws:
        got = None
        for _ in range(40):
            msg = json.loads(ws.receive_text())
            got = msg
            if msg.get("status") in ("completed", "failed", "error"):
                break
        assert got and got.get("status") == "completed", got

    status = _ok(client.get(f"/api/thumbnail/v1/status/{task_id}"))
    assert status["code"] == 0 and status["data"].get("status") == "completed"
    # a task id that was never created is not readable
    other = _ok(client.get("/api/thumbnail/v1/status/not-a-task"))
    assert other["code"] != 0
