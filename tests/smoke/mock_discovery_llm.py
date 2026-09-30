"""A scripted OpenAI Responses API server that plays the discovery agents.

It is what DISCOVERY_BASE_URL points at in the end-to-end tests. Before round 1
the dataset scout probes the folder (a shell tool call run in the real sandbox)
and writes its guide; every proposer call returns the plan; the worker writes
result.py with the shared loaders, runs it, and says DONE. The data it expects is the synthetic cohort written by
tests/frontend/e2e/make_discovery_dataset.py (cell classes Alpha / Beta, one
region "Inner"). The panel's column choice for a program that names no column
gets score / age, sex. `--delay` slows every reply so a test can stop a run midway.

    python tests/smoke/mock_discovery_llm.py --port 18081 --delay 1
    DISCOVERY_BASE_URL=http://127.0.0.1:18081/v1 DISCOVERY_API_KEY=dummy python main.py
"""
import argparse
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROBE = (
    "ls /data; head -3 /data/cases.csv; "
    "python -c \"from shared_analysis.slides import donor_ids, slide_path, build_cell_table; "
    "ids = donor_ids('/data'); t = build_cell_table(slide_path('/data', ids[0])); "
    "print(len(ids), sorted(t.cell_type.unique()), sorted(t.region.dropna().unique()))\""
)

PLAN = {
    "candidate_id": "alpha_inner_fraction",
    "scientific_question": "The fraction of Alpha cells inside the Inner region tracks the score",
    "rationale": "The brief shows Alpha cells concentrated in Inner; start from the simplest composition measure.",
    "approach": "Among cells in region Inner, the fraction whose cell_type is Alpha; missing if fewer than 20 cells.",
    "variations": [
        {"name": "alpha_frac_inner", "description": "Alpha fraction in Inner", "expected_sign": 1},
        {"name": "alpha_frac_all", "description": "Alpha fraction on the whole slide", "expected_sign": 1},
        {"name": "beta_frac_inner", "description": "Beta fraction in Inner", "expected_sign": -1},
    ],
    "baseline_variation": "alpha_frac_inner",
    "notes": "Support rule: at least 20 cells in Inner.",
}

RESULT_PY = '''
from shared_analysis.slides import build_cell_table, donor_ids, slide_path

def compute_donor_features(donor_id, data_root):
    cells = build_cell_table(slide_path(data_root, donor_id))
    inner = cells[cells["region"] == "Inner"]
    if len(inner) < 20:
        return {"alpha_frac_inner": float("nan"), "alpha_frac_all": float("nan"), "beta_frac_inner": float("nan")}
    return {
        "alpha_frac_inner": float((inner["cell_type"] == "Alpha").mean()),
        "alpha_frac_all": float((cells["cell_type"] == "Alpha").mean()),
        "beta_frac_inner": float((inner["cell_type"] == "Beta").mean()),
    }

if __name__ == "__main__":
    for d in donor_ids("/data"):
        print(d, compute_donor_features(d, "/data"), flush=True)
'''
SCOUT_GUIDE = (
    PROBE + "; "
    "cat > /scratch/dataset_guide.md <<'MDEOF'\n"
    "# Dataset guide\n\nSlides: discovery_slides/sNN.zarr, cell classes Alpha / Beta, one region Inner.\n"
    "MDEOF"
)
COLUMN_CHOICE = {"outcome": "score", "covariates": ["age", "sex"]}

WRITE_AND_RUN = f"cat > /scratch/result.py <<'PYEOF'\n{RESULT_PY}\nPYEOF\ncd /scratch && python result.py | tail -3"


def _tool_call(command: str) -> dict:
    return {"type": "custom_tool_call", "name": "shell_exec", "call_id": f"call_{uuid.uuid4().hex[:8]}", "input": command}


def _text(text: str) -> dict:
    return {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}


def reply_items(body: dict) -> list:
    """The scripted turn for a request: a tool call on the first turn, then the answer."""
    instructions = str(body.get("instructions") or "")
    first_turn = isinstance(body.get("input"), str) and not body.get("previous_response_id")
    if "# Dataset Scout" in instructions:
        return [_tool_call(SCOUT_GUIDE)] if first_turn else [_text("DONE")]
    if isinstance(body.get("input"), str) and body["input"].startswith("You set up a predictive analysis"):
        return [_text(json.dumps(COLUMN_CHOICE))]
    if "# Candidate Proposer" in instructions:
        return [_text(json.dumps(PLAN))]
    if "# Biomarker Worker" in instructions:
        return [_tool_call(WRITE_AND_RUN)] if first_turn else [_text("DONE")]
    return [_text("unrecognised caller")]


class Handler(BaseHTTPRequestHandler):
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
            return self._json(200, {"object": "list", "data": [{"id": "mock-discovery", "object": "model"}]})
        return self._json(404, {"error": {"message": f"unknown route {self.path}"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        self.server.requests.append({"path": self.path, "body": body})
        if not self.path.rstrip("/").endswith("/responses"):
            return self._json(404, {"error": {"message": f"unknown route {self.path}"}})
        time.sleep(self.server.delay)
        return self._json(200, {
            "id": f"resp_{uuid.uuid4().hex[:12]}",
            "object": "response",
            "created_at": int(time.time()),
            "model": body.get("model", "mock-discovery"),
            "status": "completed",
            "output": reply_items(body),
            "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
        })


class MockDiscoveryLLM:
    """Threaded server; ``requests`` records every POST body for assertions."""

    def __init__(self, host="127.0.0.1", port=0, delay=0.0):
        self.httpd = ThreadingHTTPServer((host, port), Handler)
        self.httpd.requests = []
        self.httpd.delay = delay
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/v1"

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18081)
    ap.add_argument("--delay", type=float, default=0.0, help="seconds to wait before every reply")
    args = ap.parse_args()
    srv = MockDiscoveryLLM(port=args.port, delay=args.delay).start()
    print(f"mock discovery Responses server on {srv.base_url}")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        srv.stop()
