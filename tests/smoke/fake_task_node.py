"""A fake Model-Zoo task node speaking the service's node protocol.

The service drives a task node over HTTP: ``GET /status`` (health),
``POST /init``, ``POST /read`` (inputs incl. ``zarr_path``), ``POST /execute``
(long poll until done), ``GET /progress`` (SSE ``data: {"progress": n}``) and
``POST /cancel`` (cooperative stop). This module implements exactly that so
the scheduler, cancel path and UI state can be tested without conda envs or
models.

    python tests/smoke/fake_task_node.py --port 18090 --execute-seconds 2
"""
import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class _Handler(BaseHTTPRequestHandler):
    server_version = "FakeTaskNode/1.0"

    def log_message(self, *args):
        pass

    def _json(self, code, payload):
        raw = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def do_GET(self):
        node = self.server.node
        path = self.path.split("?", 1)[0].rstrip("/")
        if path in ("/status", "/health"):
            return self._json(200, {"status": "ok", "model_name": node.name})
        if path == "/progress":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                while not node.finished.is_set():
                    self.wfile.write(f"data: {json.dumps({'progress': node.progress})}\n\n".encode())
                    self.wfile.flush()
                    time.sleep(0.2)
                self.wfile.write(f"data: {json.dumps({'progress': 100})}\n\n".encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionError, OSError):
                pass
            return
        return self._json(404, {"status": "error", "message": "unknown route"})

    def do_POST(self):
        node = self.server.node
        path = self.path.rstrip("/")
        body = self._body()
        node.calls.append((path, body))
        if path == "/init":
            node.initialized = True
            node.finished.clear()
            node.cancelled.clear()
            node.progress = 0
            return self._json(200, {"status": "success"})
        if path == "/read":
            node.inputs = body
            return self._json(200, {"status": "success"})
        if path == "/execute":
            if not node.initialized:
                return self._json(200, {"status": "error", "message": "Please /init first"})
            deadline = time.time() + node.execute_seconds
            while time.time() < deadline and not node.cancelled.is_set():
                node.progress = min(99, node.progress + 10)
                time.sleep(0.1)
            node.finished.set()
            if node.cancelled.is_set():
                return self._json(200, {"status": "cancelled", "message": "cancelled"})
            if node.fail:
                return self._json(200, {"status": "error", "message": "fake node failure"})
            return self._json(200, {"status": "success", "output": {"node": node.name, "inputs": node.inputs}})
        if path == "/cancel":
            node.cancelled.set()
            return self._json(200, {"status": "cancelling"})
        return self._json(404, {"status": "error", "message": "unknown route"})


class FakeTaskNode:
    def __init__(self, name="FakeNode", port=0, execute_seconds=0.5, fail=False):
        self.name = name
        self.execute_seconds = execute_seconds
        self.fail = fail
        self.calls = []
        self.inputs = {}
        self.initialized = False
        self.progress = 0
        self.finished = threading.Event()
        self.cancelled = threading.Event()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
        self.httpd.node = self
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def port(self):
        return self.httpd.server_address[1]

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def paths(self):
        return [p for p, _ in self.calls]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18090)
    ap.add_argument("--name", default="FakeNode")
    ap.add_argument("--execute-seconds", type=float, default=2.0)
    args = ap.parse_args()
    node = FakeTaskNode(args.name, args.port, args.execute_seconds).start()
    print(f"fake task node '{node.name}' on http://127.0.0.1:{node.port}")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        node.stop()
