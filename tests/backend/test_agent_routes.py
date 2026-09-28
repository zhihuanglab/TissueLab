"""Agent routes, exercised with a fake LLM so no network or key is needed."""
import json

import pytest


class FakeAgent:
    code_provider_name = "openai"

    def __init__(self):
        self.calls = []

    async def classify_intent(self, query, history=None):
        self.calls.append(("classify_intent", query))
        return "3" if "segment" in query.lower() else "1"

    async def chat(self, prompt, history=None, data_context=None, user_id=None):
        self.calls.append(("chat", prompt, user_id))
        return f"echo: {prompt}"

    async def summary_answer(self, question, answer):
        return f"{question} -> {answer}"

    async def get_processing_steps(self, query, history=None, data_context=None, user_id=None):
        self.calls.append(("get_processing_steps", data_context))
        return json.dumps({
            "steps": [
                {"step": 2, "model": "NucleiClassify", "input": ["tumor_cell", "other"], "impl": "NuClass", "impl_candidates": ["NuClass"]},
                {"step": 1, "model": "NucleiSeg", "input": [], "impl": "", "impl_candidates": []},
            ],
            "workflow_reason": "nuclei",
        })

    async def select_impl_from_candidates(self, query, step, candidates, feedback_text=None):
        names = [c["impl"] for c in candidates]
        return {"selected_impl": names[-1], "reason": "last wins", "ranking": list(reversed(names))}

    async def prepare_script_prompts(self, **kwargs):
        return "SYS", "USER"

    def iter_script_chat_stream(self, system_prompt, user_prompt):
        yield "```python\n"
        yield "def analyze_medical_image(path):\n    return 1\n"
        yield "```"

    async def get_script(self, **kwargs):
        return "def analyze_medical_image(path):\n    return 2\n"


@pytest.fixture
def fake_agent(monkeypatch):
    import app.api.agent as agent_api

    agent = FakeAgent()
    monkeypatch.setattr(agent_api, "get_workflow_agent", lambda: agent)
    return agent


def test_agent_routes_report_missing_key_as_501(client):
    r = client.post("/api/agent/v1/chat", json={"agent_id": "a", "prompt": "hi"})
    assert r.status_code == 200
    body = r.json()
    assert body["code"] == 501
    assert "OPENAI_API_KEY" in body["message"]


def test_entrance_and_chat(client, fake_agent, local_uid):
    r = client.post("/api/agent/v1/entrance_agent", json={"agent_id": "a", "prompt": "please segment nuclei"})
    assert r.json()["data"] == {"need_workflow": True, "label": "3"}

    r = client.post("/api/agent/v1/chat", json={"agent_id": "a", "prompt": "hello", "history": []})
    data = r.json()["data"]
    assert data["response"] == "echo: hello" and data["agent_id"] == "a"
    assert ("chat", "hello", local_uid) in fake_agent.calls

    r = client.post("/api/agent/v1/summary_answer", json={"agent_id": "a", "prompt": "q", "parameters": {"answer": "42"}})
    assert r.json()["data"]["response"] == "q -> 42"


def test_get_steps_normalises_sorts_and_fills_candidates(client, fake_agent):
    from app.utils.workflow.model_store import model_store

    category_map = model_store.get_category_map()
    r = client.post("/api/agent/v1/get_steps", json={
        "agent_id": "a", "prompt": "count tumor cells",
        "data_context": {"zarr_path": "users/local/s.svs.zarr"},
    })
    body = r.json()
    assert body["code"] == 0, body
    steps = body["data"]
    assert [s["step"] for s in steps] == [1, 2]
    seg = steps[0]
    assert seg["model"] == "NucleiSeg"
    # candidates were filled from the model registry and one was selected
    expected = category_map.get("NucleiSeg", [])
    if expected:
        assert seg["impl_candidates"] == expected
        assert seg["impl"] == expected[-1]
        assert seg["impl_selected_via_feedback"] is True
    assert steps[1]["impl_candidates"][0] == "NuClass"
    # preference hint merged into the data_context the agent received
    _, dc = next(c for c in fake_agent.calls if c[0] == "get_processing_steps")
    assert dc["zarr_path"] == "users/local/s.svs.zarr"


def test_get_steps_v2_returns_reason(client, fake_agent):
    r = client.post("/api/agent/v2/get_steps", json={"agent_id": "a", "prompt": "count", "rois_info": "roi"})
    data = r.json()["data"]
    assert data["workflow_reason"] == "nuclei"
    assert [s["step"] for s in data["steps"]] == [1, 2]


def test_process_script_and_stream(client, fake_agent):
    r = client.post("/api/agent/v1/process_script", json={
        "agent_id": "a", "prompt": "ratio", "data_context": {"zarr_structure": {"a": 1}},
    })
    assert "return 2" in r.json()["data"]

    with client.stream("POST", "/api/agent/v1/process_script_stream", json={"agent_id": "a", "prompt": "ratio"}) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        events = [json.loads(line[5:]) for line in r.iter_lines() if line.startswith("data:")]
    deltas = [e["delta"] for e in events if "delta" in e]
    assert "".join(deltas).startswith("```python")
    done = [e for e in events if e.get("done")]
    assert done and done[0]["code"] == "def analyze_medical_image(path):\n    return 1"


def test_verify_result_runs_off_loop(client, fake_agent, monkeypatch):
    import app.api.agent as agent_api

    class FakeVerifier:
        def diagnose_result(self, **kwargs):
            return {"issue_stage": "none", "confidence": "high", "reasoning": "ok", "suggestions": [], "kwargs": sorted(kwargs)}

    monkeypatch.setattr(agent_api, "get_verification_agent", lambda: FakeVerifier())
    r = client.post("/api/agent/v1/verify/result", json={
        "user_query": "q", "result_overlay_thumbnail_path": "a.png", "original_thumbnail_path": "b.png",
    })
    assert r.json()["data"]["issue_stage"] == "none"


def test_summary_answer_task_route_uses_in_process_agent(client, fake_agent, monkeypatch):
    import app.services.agent.workflow_agent as wa

    monkeypatch.setattr(wa, "get_workflow_agent", lambda: fake_agent)
    r = client.post("/api/tasks/v1/summary_answer", json={"agent_id": "a", "prompt": "q", "parameters": {"answer": "7"}})
    body = r.json()
    assert body["code"] == 0
    assert body["data"]["response"] == "q -> 7"
    assert body["data"]["control_error"] is None


def test_summary_answer_task_route_falls_back_without_agent(client):
    r = client.post("/api/tasks/v1/summary_answer", json={"agent_id": "a", "prompt": "q", "parameters": {"answer": "7"}})
    body = r.json()
    assert body["code"] == 0
    assert body["data"]["control_error"]
    assert isinstance(body["data"]["response"], str)


@pytest.mark.asyncio
async def test_generate_script_output_streams_into_ui_state(tmp_path, monkeypatch):
    import zarr

    import app.services.agent.workflow_agent as wa
    from app.services.tasks import _generate_script_output
    from app.services.workflow.ui_state import user_workflow_status

    fake = FakeAgent()
    monkeypatch.setattr(wa, "get_workflow_agent", lambda: fake)
    zpath = tmp_path / "slide.svs.zarr"
    zarr.open_group(str(zpath), mode="w").create_group("Cell-Segmentation")

    user_workflow_status["u"] = {"status": "running"}
    result = await _generate_script_output("count cells", str(zpath), uid="u")
    assert result["generated_script"] == "def analyze_medical_image(path):\n    return 1"
    assert user_workflow_status["u"]["cur_answer"].startswith("```python")

    result = await _generate_script_output("count cells", str(zpath), uid=None)
    assert "return 2" in result["generated_script"]

    result = await _generate_script_output("count cells", str(tmp_path / "missing.zarr"), uid="u")
    assert "error" in result


@pytest.mark.asyncio
async def test_generate_script_output_without_key_reports_error(tmp_path):
    from app.services.tasks import _generate_script_output

    (tmp_path / "x.zarr").mkdir()
    result = await _generate_script_output("count", str(tmp_path / "x.zarr"), uid="u")
    assert "OPENAI_API_KEY" in result["error"]
