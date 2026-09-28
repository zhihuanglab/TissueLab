"""OpenAI-compatible provider against a mock Chat-Completions-only server.

Proves the agent runs on a self-hosted endpoint (vLLM / Ollama / LM Studio
style) that has no Responses API and may not support json_schema output.
"""
import json
import os
import sys

import pytest

from mock_llm_server import MockLLMServer  # tests/smoke is on sys.path via conftest


@pytest.fixture
def mock_server():
    srv = MockLLMServer().start()
    yield srv
    srv.stop()


@pytest.fixture
def strict_server():
    srv = MockLLMServer(reject_json_schema=True).start()
    yield srv
    srv.stop()


def _client(base_url):
    from openai import OpenAI
    return OpenAI(base_url=base_url, api_key="dummy")


def test_api_mode_auto_detection(monkeypatch):
    from app.services import llm_config

    monkeypatch.delenv("LLM_API", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    assert llm_config.api_mode() == "responses"
    assert llm_config.web_search_available() is True

    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:11434/v1")
    assert llm_config.api_mode() == "chat"
    assert llm_config.is_openai_cloud() is False
    assert llm_config.web_search_available() is False

    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    assert llm_config.api_mode() == "responses"
    monkeypatch.setenv("LLM_API", "chat")
    assert llm_config.api_mode() == "chat"
    assert llm_config.web_search_available() is False

    monkeypatch.setenv("LLM_MODEL", "qwen3")
    monkeypatch.delenv("WORKFLOW_MODEL", raising=False)
    assert llm_config.model_for("WORKFLOW_MODEL") == "qwen3"
    monkeypatch.setenv("WORKFLOW_MODEL", "other")
    assert llm_config.model_for("WORKFLOW_MODEL") == "other"


def test_chat_mode_json_schema_tools_and_images(mock_server):
    from app.services.providers.openai_provider import OpenAIProvider

    provider = OpenAIProvider(_client(mock_server.base_url), api_mode="chat")
    schema = {"name": "route_label", "schema": {"type": "object", "properties": {"label": {"type": "string"}}}, "strict": True}
    res = provider.infer(
        messages=[{"role": "system", "content": "router"}, {"role": "user", "content": "please segment nuclei"}],
        model="mock-llm", json_schema=schema,
        tools=[{"type": "function", "name": "fetch_script", "description": "d", "parameters": {"type": "object", "properties": {}}}],
    )
    assert json.loads(res.text) == {"label": "3"}
    sent = mock_server.requests[-1]["body"]
    assert mock_server.requests[-1]["path"].endswith("/v1/chat/completions")
    assert sent["response_format"]["type"] == "json_schema"
    assert sent["response_format"]["json_schema"]["name"] == "route_label"
    assert sent["tools"][0]["function"]["name"] == "fetch_script"
    assert sent["model"] == "mock-llm"
    assert "temperature" in sent  # non-gpt-5 model: temperature is passed through

    # Responses-style image parts are converted for Chat Completions
    res = provider.infer(messages=[{"role": "user", "content": [
        {"type": "input_text", "text": "look"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
        {"type": "input_image", "data": "BBBB"},
    ]}], model="mock-llm")
    parts = mock_server.requests[-1]["body"]["messages"][0]["content"]
    assert parts[0] == {"type": "text", "text": "look"}
    assert parts[1]["image_url"]["url"].startswith("data:image/png;base64,AAAA")
    assert parts[2]["image_url"]["url"] == "data:image/png;base64,BBBB"
    assert res.text.startswith("mock reply")


def test_chat_mode_falls_back_when_json_schema_is_rejected(strict_server):
    from app.services.providers.openai_provider import OpenAIProvider

    provider = OpenAIProvider(_client(strict_server.base_url), api_mode="chat")
    schema = {"name": "impl_selection", "schema": {"type": "object", "properties": {"selected_impl": {"type": "string"}}}}
    res = provider.infer(messages=[{"role": "system", "content": "pick"}, {"role": "user", "content": "{}"}], model="mock-llm", json_schema=schema)
    assert json.loads(res.text)["selected_impl"] == "StarDist"
    bodies = [r["body"] for r in strict_server.requests]
    assert bodies[0]["response_format"]["type"] == "json_schema"
    assert bodies[1]["response_format"]["type"] == "json_object"
    assert "selected_impl" in bodies[1]["messages"][0]["content"]  # schema inlined into the system prompt


def test_responses_mode_is_used_for_openai_cloud(monkeypatch):
    """Without a custom base URL the provider still builds Responses-API requests."""
    import httpx
    from openai import OpenAI

    from app.services.providers.openai_provider import OpenAIProvider

    seen = {}

    def handler(request: httpx.Request):
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "id": "resp_1", "object": "response", "created_at": 1, "model": "gpt-5.2", "status": "completed",
            "output": [{"type": "message", "id": "m1", "status": "completed", "role": "assistant",
                        "content": [{"type": "output_text", "text": "{\"label\": \"1\"}", "annotations": []}]}],
        })

    client = OpenAI(api_key="k", http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    provider = OpenAIProvider(client, api_mode="responses")
    res = provider.infer(messages=[{"role": "user", "content": "hi"}], model="gpt-5.2",
                         json_schema={"name": "route_label", "schema": {"type": "object"}})
    assert res.text == "{\"label\": \"1\"}"
    assert seen["path"].endswith("/responses")
    assert seen["body"]["text"]["format"]["type"] == "json_schema"


@pytest.mark.asyncio
async def test_workflow_agent_end_to_end_on_chat_only_server(mock_server, monkeypatch):
    """The whole planning / chat / ranking / code path works on a Chat-Completions-only endpoint."""
    monkeypatch.setenv("OPENAI_API_KEY", "dummy")
    monkeypatch.setenv("OPENAI_BASE_URL", mock_server.base_url)
    monkeypatch.setenv("LLM_MODEL", "mock-llm")
    monkeypatch.delenv("LLM_API", raising=False)

    import app.services.agent.workflow_agent as wa

    agent = wa.WorkflowAgent()
    assert agent.model_workflow == "mock-llm"

    assert await agent.classify_intent("please segment nuclei") == "3"
    assert await agent.classify_intent("what is a nucleus?") == "1"

    reply = await agent.chat("hello", history=[], data_context={"zarr_path": "users/local/x.zarr", "web_search_enabled": True}, user_id="local")
    assert reply.startswith("mock reply")

    steps = json.loads(await agent.get_processing_steps("count tumor cells", data_context={"zarr_path": "users/local/x.zarr"}, user_id="local"))
    assert [s["model"] for s in steps["steps"]] == ["NucleiSeg", "NucleiClassify", "CodingAgent"]

    sel = await agent.select_impl_from_candidates("count", steps["steps"][0], [{"impl": "StarDist"}, {"impl": "InstanSegNode"}])
    assert sel["selected_impl"] == "StarDist"

    code = await agent.get_script("count tumor cells", zarr_structure="{}", original_question="count")
    assert code.startswith("def analyze_medical_image")

    system_prompt, user_prompt = await agent.prepare_script_prompts(script_task="count", zarr_structure="{}", original_question="count")
    streamed = "".join(agent.iter_script_chat_stream(system_prompt, user_prompt))
    assert "analyze_medical_image" in streamed

    # every call went to chat/completions; the Responses API was never touched
    paths = {r["path"] for r in mock_server.requests}
    assert paths == {"/v1/chat/completions"}
    # gpt-5-only knobs are not sent to a self-hosted model
    assert all("text" not in r["body"] for r in mock_server.requests)
