"""A tiny OpenAI-compatible server (Chat Completions + models) for tests.

It answers the way a self-hosted model would: schema-aware canned JSON when a
``response_format`` names one of the agent's schemas, a markdown code block for
code-generation prompts, streamed deltas for ``stream: true``, and a plain echo
otherwise. It implements only ``/v1/chat/completions`` and ``/v1/models`` —
deliberately NOT ``/v1/responses`` — so a passing run proves the service works
against servers that only speak Chat Completions (vLLM, Ollama, LM Studio, …).

    python scripts/mock_llm_server.py --port 18080
    OPENAI_BASE_URL=http://127.0.0.1:18080/v1 OPENAI_API_KEY=dummy python main.py
"""
import argparse
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = "mock-llm"

CODE_BLOCK = (
    "Here is the script.\n\n```python\n"
    "def analyze_medical_image(path):\n"
    "    return {\"answer\": \"mock\", \"path\": path}\n"
    "```\n"
)


def _schema_answer(name: str, messages):
    if name == "route_label":
        # Route on the last USER turn only — the system prompt itself talks about workflows.
        users = [m.get("content", "") for m in messages if m.get("role") == "user" and isinstance(m.get("content"), str)]
        text = (users[-1] if users else "").lower()
        label = "3" if any(k in text for k in ("segment", "classify", "nuclei", "tumor", "workflow", "count")) else "1"
        return {"label": label}
    if name == "workflow_steps":
        return {
            "steps": [
                {"step": 1, "model": "NucleiSeg", "input": [], "impl": "StarDist", "impl_candidates": ["StarDist"]},
                {"step": 2, "model": "NucleiClassify", "input": ["tumor_cell", "other"], "impl": "NuClass", "impl_candidates": ["NuClass"]},
                {"step": 3, "model": "CodingAgent", "input": ["Count tumor cells"], "impl": "GPT-4o Agent", "impl_candidates": ["GPT-4o Agent"]},
            ],
            "workflow_reason": "mock",
        }
    if name == "impl_selection":
        return {"selected_impl": "StarDist", "reason": "mock", "ranking": ["StarDist"]}
    return {"ok": True}


def build_reply(body: dict):
    """Return (text, tool_calls) for a chat.completions request body."""
    messages = body.get("messages") or []
    rf = body.get("response_format") or {}
    if rf.get("type") == "json_schema":
        name = (rf.get("json_schema") or {}).get("name", "")
        return json.dumps(_schema_answer(name, messages)), None
    if rf.get("type") == "json_object":
        # schema was inlined in the system prompt; detect which one
        sys_text = messages[0].get("content", "") if messages else ""
        for name, marker in (("route_label", '"label"'), ("workflow_steps", '"steps"'), ("impl_selection", '"selected_impl"')):
            if name in sys_text or marker in sys_text:
                return json.dumps(_schema_answer(name, messages)), None
        return json.dumps({"is_correction": False}), None
    last = messages[-1].get("content", "") if messages else ""
    last_text = last if isinstance(last, str) else json.dumps(last)
    if "analyze_medical_image" in json.dumps(messages) or "Script Task" in last_text:
        return CODE_BLOCK, None
    if "is_correction" in json.dumps(messages):
        return json.dumps({"is_correction": False}), None
    return f"mock reply: {last_text[:200]}", None


class Handler(BaseHTTPRequestHandler):
    server_version = "MockOpenAI/1.0"

    def log_message(self, *args):  # quiet
        pass

    def _json(self, code: int, payload: dict):
        raw = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._json(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "mock"}]})
        return self._json(404, {"error": {"message": f"unknown route {self.path}"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        self.server.requests.append({"path": self.path, "body": body})
        if not self.path.rstrip("/").endswith("/chat/completions"):
            # Responses API and everything else is deliberately unsupported.
            return self._json(404, {"error": {"message": f"unknown route {self.path}", "type": "invalid_request_error"}})
        if self.server.reject_json_schema and (body.get("response_format") or {}).get("type") == "json_schema":
            return self._json(400, {"error": {"message": "response_format.type json_schema is not supported", "type": "invalid_request_error"}})
        text, tool_calls = build_reply(body)
        created = int(time.time())
        rid = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            for i in range(0, len(text), 24):
                chunk = {"id": rid, "object": "chat.completion.chunk", "created": created, "model": body.get("model", MODEL_ID),
                         "choices": [{"index": 0, "delta": {"content": text[i:i + 24]}, "finish_reason": None}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.flush()
            done = {"id": rid, "object": "chat.completion.chunk", "created": created, "model": body.get("model", MODEL_ID),
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
            self.wfile.write(f"data: {json.dumps(done)}\n\ndata: [DONE]\n\n".encode())
            return
        message = {"role": "assistant", "content": text}
        if tool_calls:
            message["tool_calls"] = tool_calls
            message["content"] = None
        return self._json(200, {
            "id": rid, "object": "chat.completion", "created": created, "model": body.get("model", MODEL_ID),
            "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if tool_calls else "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })


class MockLLMServer:
    """Threaded server; ``requests`` records every POST body for assertions."""

    def __init__(self, host="127.0.0.1", port=0, reject_json_schema=False):
        self.httpd = ThreadingHTTPServer((host, port), Handler)
        self.httpd.requests = []
        self.httpd.reject_json_schema = reject_json_schema
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def port(self) -> int:
        return self.httpd.server_address[1]

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    @property
    def requests(self):
        return self.httpd.requests

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18080)
    ap.add_argument("--reject-json-schema", action="store_true")
    args = ap.parse_args()
    srv = MockLLMServer(port=args.port, reject_json_schema=args.reject_json_schema).start()
    print(f"mock OpenAI-compatible server on {srv.base_url} (Chat Completions only)")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        srv.stop()
