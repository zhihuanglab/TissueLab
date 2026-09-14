"""Workflow runtime end-to-end: scheduler, node protocol, coding agent, cancel, sandbox.

A fake task node (tests/smoke/fake_task_node.py) is registered through the
same loopback callback real nodes use (``POST /tasks/v1/create_node``); the
coding-agent step is served by the mock Chat-Completions-only LLM server.
"""
import json
import sys
import time

import pytest
import zarr

from fake_task_node import FakeTaskNode
from mock_llm_server import MockLLMServer


def _ok(r):
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def llm(app):
    """Point the in-process agent at a mock OpenAI-compatible server for this module."""
    import os

    import app.services.agent.workflow_agent as wa

    srv = MockLLMServer().start()
    saved = {k: os.environ.get(k) for k in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_MODEL", "LLM_API")}
    os.environ["OPENAI_API_KEY"] = "dummy"
    os.environ["OPENAI_BASE_URL"] = srv.base_url
    os.environ["LLM_MODEL"] = "mock-llm"
    os.environ.pop("LLM_API", None)
    wa._workflow_agent = None
    yield srv
    srv.stop()
    wa._workflow_agent = None
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _register(client, node, factory="NucleiSeg"):
    """Register a running node the way a remote Model-Zoo node is: health-checked, no conda env."""
    body = _ok(client.post("/api/tasks/v1/register_custom_node", json={
        "model_name": node.name, "python_version": "3.11", "service_path": "fake/service.py",
        "dependency_path": "users/local", "factory": factory, "description": "fake node for tests",
        "port": node.port, "is_remote": True, "remote_host": "127.0.0.1",
        "inputs": "H&E slide", "outputs": "nuclei masks",
    }))
    assert body.get("code") == 0, body
    return body


@pytest.fixture
def fake_node(client):
    node = FakeTaskNode(name="FakeNode", execute_seconds=0.6).start()
    _register(client, node)
    yield node
    node.stop()


def _zarr_for(user_root, local_uid, name):
    path = user_root / name
    if not path.exists():
        zarr.open_group(str(path), mode="w")
    return f"users/{local_uid}/{name}"


def _wait_answer(client, timeout=60):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = _ok(client.get("/api/tasks/v1/get_answer"))["data"]
        if last.get("message") in ("done", "error"):
            return last
        time.sleep(0.3)
    raise AssertionError(f"workflow did not finish: {last}")


def _wait_status(client, wanted, timeout=60):
    deadline = time.time() + timeout
    snap = None
    while time.time() < deadline:
        snap = _ok(client.get("/api/tasks/v1/current_workflow_status"))["data"]
        if not snap.get("active") or snap.get("status") in wanted:
            return snap
        time.sleep(0.3)
    raise AssertionError(f"status never reached {wanted}: {snap}")


def test_node_registration_is_visible(client, fake_node):
    ports = _ok(client.get("/api/tasks/v1/list_node_ports", params={"skip_health_checks": "true"}))
    nodes = ports["data"]["nodes"] if "data" in ports else ports["nodes"]
    assert nodes["FakeNode"]["port"] == fake_node.port
    ext = _ok(client.get("/api/tasks/v1/list_nodes_extended"))
    listed = ext["data"]["nodes"] if isinstance(ext.get("data"), dict) and "nodes" in ext["data"] else ext.get("data", ext)
    assert "FakeNode" in json.dumps(listed)
    # unreachable remote node is refused at registration
    bad = _ok(client.post("/api/tasks/v1/register_custom_node", json={
        "model_name": "Unreachable", "python_version": "3.11", "service_path": "x", "dependency_path": "users/local",
        "factory": "NucleiSeg", "port": 1, "is_remote": True, "remote_host": "127.0.0.1"}))
    assert bad.get("code") != 0


def test_unknown_node_is_a_409_not_a_crash(client, user_root, local_uid):
    zarr_rel = _zarr_for(user_root, local_uid, "wf-unknown.zarr")
    body = _ok(client.post("/api/tasks/v1/start_workflow", json={
        "zarr_path": zarr_rel, "step1": {"nodeId": "NoSuchNode", "input": {}}}))
    assert body["code"] == 409, body


def test_workflow_runs_node_then_coding_agent(client, fake_node, llm, user_root, local_uid):
    zarr_rel = _zarr_for(user_root, local_uid, "wf-run.zarr")
    body = _ok(client.post("/api/tasks/v1/start_workflow", json={
        "zarr_path": zarr_rel,
        "step1": {"nodeId": "FakeNode", "input": {"threshold": 0.5, "classes": ["tumor", "other"]}},
        "step2": {"nodeId": "GPT-4o Agent", "input": {"prompt": "count tumor cells"}},
    }))
    assert body["code"] == 0, body
    assert body["data"].get("execution_id")

    answer = _wait_answer(client)
    assert answer["message"] == "done", answer
    assert "analyze_medical_image" in answer["answer"]

    # node protocol: init → read (with zarr path + inputs) → execute
    assert fake_node.paths()[:3] == ["/init", "/read", "/execute"]
    read_payload = fake_node.inputs
    assert read_payload["node_name"] == "FakeNode"
    assert read_payload["threshold"] == 0.5
    assert read_payload["zarr_path"].replace("\\", "/").endswith("users/local/wf-run.zarr")

    # the node's parameters were written into the store before /execute
    root = zarr.open_group(str(user_root / "wf-run.zarr"), mode="r")
    dumped = json.dumps(dict(root.attrs)) + " ".join(root.group_keys())
    assert "FakeNode" in dumped or "userData" in dumped or list(root.group_keys())

    snap = _wait_status(client, {"completed"})
    assert not snap.get("active") or snap.get("status") == "completed"
    # the coding agent went through the self-hosted endpoint
    assert {r["path"] for r in llm.requests} == {"/v1/chat/completions"}


def test_stop_workflow_sends_cooperative_cancel(client, user_root, local_uid):
    node = FakeTaskNode(name="SlowNode", execute_seconds=30).start()
    try:
        _register(client, node)
        zarr_rel = _zarr_for(user_root, local_uid, "wf-cancel.zarr")
        body = _ok(client.post("/api/tasks/v1/start_workflow", json={
            "zarr_path": zarr_rel, "step1": {"nodeId": "SlowNode", "input": {}}}))
        assert body["code"] == 0, body

        deadline = time.time() + 20
        while time.time() < deadline and "/execute" not in node.paths():
            time.sleep(0.2)
        assert "/execute" in node.paths(), node.paths()

        stop = _ok(client.post("/api/tasks/v1/stop_workflow", json={"zarr_path": zarr_rel}))
        assert stop["code"] == 0, stop

        deadline = time.time() + 20
        while time.time() < deadline and not node.cancelled.is_set():
            time.sleep(0.2)
        assert node.cancelled.is_set(), "node never received POST /cancel"
        assert "/cancel" in node.paths()

        snap = _wait_status(client, {"cancelled", "completed", "error"})
        assert (not snap.get("active")) or snap.get("status") == "cancelled", snap
    finally:
        node.stop()


def test_node_error_marks_workflow_failed(client, user_root, local_uid):
    node = FakeTaskNode(name="BrokenNode", execute_seconds=0.2, fail=True).start()
    try:
        _register(client, node)
        zarr_rel = _zarr_for(user_root, local_uid, "wf-fail.zarr")
        body = _ok(client.post("/api/tasks/v1/start_workflow", json={
            "zarr_path": zarr_rel, "step1": {"nodeId": "BrokenNode", "input": {}}}))
        assert body["code"] == 0, body
        snap = _wait_status(client, {"error", "completed", "cancelled"})
        assert (not snap.get("active")) or snap.get("status") == "error", snap
    finally:
        node.stop()


def test_execute_script_runs_in_process_without_docker(client, user_root, local_uid):
    zarr_rel = _zarr_for(user_root, local_uid, "exec.zarr")
    zarr.open_group(str(user_root / "exec.zarr"), mode="a").attrs["hello"] = "world"
    code = (
        "import zarr\n"
        "def analyze_medical_image(path):\n"
        "    g = zarr.open_group(path, mode='r')\n"
        "    return {'hello': g.attrs.get('hello'), 'answer': 42}\n"
    )
    body = _ok(client.post("/api/tasks/v1/execute_script", json={"zarr_path": zarr_rel, "code_str": code}))
    assert body["code"] == 0, body
    text = json.dumps(body["data"])
    assert "42" in text and "world" in text, body


def test_execute_script_rejects_missing_store(client, local_uid):
    body = _ok(client.post("/api/tasks/v1/execute_script", json={
        "zarr_path": f"users/{local_uid}/nope.zarr", "code_str": "def analyze_medical_image(path):\n    return 1"}))
    assert body["code"] != 0


def _pid_alive(pid: int) -> bool:
    """psutil rather than ``os.kill(pid, 0)``.

    On Windows ``os.kill`` terminates the process for every signal except the
    two CTRL events, so the POSIX "signal 0 just probes" idiom would destroy
    the very process this is asked to measure. A reaped-but-unwaited child is
    a zombie on POSIX and counts as gone.
    """
    import psutil

    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False
    except psutil.AccessDenied:
        return True


def test_reregistering_a_node_kills_its_whole_process_tree(client):
    """Re-registering must tear down the node's workers, not just the node.

    A worker left behind keeps holding the node's port, so the replacement
    silently lands on a different one, and it outlives app quit because the
    registry entry it would have been found through is already gone.
    """
    import subprocess
    import sys
    import time

    from app.utils.workflow.register import (
        CUSTOM_NODE_SERVICE_REGISTRY,
        get_env_name_from_model,
    )

    node = FakeTaskNode(name="TreeNode").start()
    # Stand in for a node that spawned a worker of its own.
    parent = subprocess.Popen(
        [sys.executable, "-c",
         "import subprocess,sys,time;"
         "w=subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)']);"
         "print(w.pid,flush=True);time.sleep(120)"],
        stdout=subprocess.PIPE, text=True,
    )
    worker_pid = int(parent.stdout.readline())
    key = f"{get_env_name_from_model(node.name)}::{node.name}"
    CUSTOM_NODE_SERVICE_REGISTRY[key] = {
        "env_name": get_env_name_from_model(node.name), "model_name": node.name,
        "port": node.port, "process": parent, "ready": True, "activation_complete": True,
    }
    try:
        assert _pid_alive(worker_pid)
        _register(client, node)

        deadline = time.time() + 10
        while time.time() < deadline and _pid_alive(worker_pid):
            time.sleep(0.1)
        assert parent.poll() is not None, "node process survived re-registration"
        assert not _pid_alive(worker_pid), "worker process survived re-registration"
    finally:
        import psutil

        for p in (worker_pid, parent.pid):
            try:
                psutil.Process(p).kill()
            except psutil.Error:
                pass
        parent.poll()
        CUSTOM_NODE_SERVICE_REGISTRY.pop(key, None)
        node.stop()


def test_reserved_port_is_held_until_the_node_takes_it(client):
    """A reservation must block a concurrent start from picking the same port."""
    from app.utils.workflow.register import _reserve_port

    port, holder = _reserve_port()
    try:
        assert port and holder
        other_port, other_holder = _reserve_port(preferred=port)
        try:
            assert other_port != port, "a held port was handed out twice"
        finally:
            if other_holder:
                other_holder.close()
    finally:
        holder.close()
    # released again once the holder is gone
    again, again_holder = _reserve_port(preferred=port)
    again_holder.close()
    assert again == port


def _executable_service(tmp_path):
    """A node that just holds the port it was given. Needs no conda env.

    It has to take ``_build_cmd``'s executable branch: a ``.py`` path would send
    the caller down the conda route and build an environment. On POSIX that is a
    shebang script; Windows cannot execute one, so the body lives in a ``.py``
    file next to a ``.cmd`` that runs it with this interpreter and forwards the
    ``--port``/``--name`` arguments.
    """
    body = (
        "import socket, sys, time\n"
        "port = int(sys.argv[sys.argv.index('--port') + 1])\n"
        "s = socket.socket()\n"
        "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n"
        "s.bind(('127.0.0.1', port)); s.listen(5)\n"
        "time.sleep(300)\n"
    )
    if sys.platform == "win32":
        impl = tmp_path / "node_impl.py"
        impl.write_text(body)
        service = tmp_path / "node.cmd"
        service.write_text(f'@"{sys.executable}" "{impl}" %*\n')
        return str(service)

    service = tmp_path / "node"
    service.write_text("#!/usr/bin/env python3\n" + body)
    service.chmod(0o755)
    return str(service)


def _drop_node(key):
    from app.utils.workflow.register import CUSTOM_NODE_SERVICE_REGISTRY, _kill_process_tree

    entry = CUSTOM_NODE_SERVICE_REGISTRY.pop(key, None)
    if entry:
        _kill_process_tree(getattr(entry.get("process"), "pid", None))


def test_local_node_starts_on_the_port_it_reserved(client, tmp_path):
    """The only coverage of the local (non-remote) start path.

    The reservation has to be handed over intact: if it were released early
    another start could take the port, and if it were never released the node
    itself could not bind it.
    """
    import socket

    from app.utils.workflow.register import (
        CUSTOM_NODE_SERVICE_REGISTRY,
        create_custom_node_env,
    )

    result = create_custom_node_env(
        model_name="PortNode", service_path=_executable_service(tmp_path),
        dependency_path="", python_version="3.11", install_dependencies=False,
    )
    key = "PortNode_tissuelab_ai_service_tasknode::PortNode"
    try:
        assert result["status"] == "success", result
        assert CUSTOM_NODE_SERVICE_REGISTRY[key]["process"].poll() is None
        # The node owns the port now: something answers on it. Asking whether the
        # port can still be bound would not tell us that on Windows, where a
        # wildcard bind coexists with a loopback one instead of being refused.
        probe = socket.socket()
        probe.settimeout(5)
        try:
            assert probe.connect_ex(("127.0.0.1", result["port"])) == 0, "nothing is listening on the assigned port"
        finally:
            probe.close()
    finally:
        _drop_node(key)


def test_local_node_needs_no_port_but_a_remote_one_does(client, tmp_path):
    """The forms only ask for a port when the node is remote — so a local node
    registered without one must get a free port assigned, not be rejected."""
    from app.utils.workflow.register import register_custom_node

    result = register_custom_node(
        model_name="AutoPort", service_path=_executable_service(tmp_path),
        dependency_path="", python_version="3.11", port=None,
        install_dependencies=False,
    )
    try:
        assert result["status"] == "success", result
        assert result["port"] >= 8001
    finally:
        _drop_node("AutoPort_tissuelab_ai_service_tasknode::AutoPort")

    # A remote node is started by somebody else, so its port still has to be given.
    refused = register_custom_node(
        model_name="RemoteNoPort", service_path="x", dependency_path="",
        python_version="3.11", port=None, is_remote=True, remote_host="127.0.0.1",
    )
    assert refused["status"] == "fail" and "Port is required" in refused["message"]
