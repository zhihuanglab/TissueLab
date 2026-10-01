"""Regressions in the agent / LLM-settings plumbing. No network: the OpenAI
client and the provider are replaced by fakes."""
import json
import os
import threading
from types import SimpleNamespace

import pytest

API = "/api/agent/v1/model_settings"
KEY = "sk-regress-abcdefghijkl9876"


@pytest.fixture
def settings_module(client, monkeypatch):
    from app.services import llm_settings

    monkeypatch.setattr(llm_settings, "_baseline", {name: None for name in llm_settings.FIELDS})
    llm_settings.settings_path().unlink(missing_ok=True)
    yield llm_settings
    llm_settings.settings_path().unlink(missing_ok=True)
    llm_settings.apply_saved_settings()


# --- 1. request bodies are logged without secrets ------------------------------

class _CapturingLogger:
    def __init__(self):
        self.lines = []

    def info(self, msg, *a, **k):
        self.lines.append(msg)

    warning = error = debug = info


def test_put_model_settings_logs_body_without_the_key(client, settings_module, monkeypatch):
    """End to end: the middleware reads (and redacts) the body, the route still gets it."""
    import importlib

    lm = importlib.import_module("app.middlewares.logging_middleware")

    log = _CapturingLogger()
    monkeypatch.setattr(lm, "logger", log)
    monkeypatch.setattr(lm, "_LOG_BODIES", True)
    r = client.put(API, json={"fields": {"OPENAI_API_KEY": KEY, "LLM_MODEL": "qwen3"}}, timeout=10)
    assert r.json()["code"] == 0
    assert os.environ["OPENAI_API_KEY"] == KEY  # the route received the full body
    req_lines = [line for line in log.lines if line.startswith("req PUT")]
    assert req_lines and '"OPENAI_API_KEY": "***"' in req_lines[0] and "qwen3" in req_lines[0]
    assert not any(KEY in line for line in log.lines)


def test_redact_is_recursive_and_keeps_non_secrets():
    from app.middlewares.logging_middleware import _redact

    body = {"a": [{"api_token": "t", "x": 1}], "password": "p", "max_tokens": 5, "DISCOVERY_API_KEY": ""}
    assert _redact(body) == {"a": [{"api_token": "***", "x": 1}], "password": "***", "max_tokens": 5,
                             "DISCOVERY_API_KEY": ""}


# --- 2-4. verification agent ----------------------------------------------------

class _FakeCompletions:
    def __init__(self, reply):
        self.reply = reply
        self.kwargs = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=self.reply))])


def _verifier(monkeypatch, model, reply):
    from app.services.agent.verification_agent import VerificationAgent

    monkeypatch.setenv("OPENAI_API_KEY", "dummy")
    agent = VerificationAgent(model=model)
    completions = _FakeCompletions(reply)
    agent.client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    return agent, completions


def test_verification_attaches_png_and_skips_missing_image(tmp_path, monkeypatch):
    png = tmp_path / "overlay.png"
    png.write_bytes(b"\x89PNG fake")
    agent, comp = _verifier(monkeypatch, "gpt-4o", "{}")
    agent.diagnose_result("q", str(png), str(tmp_path / "missing.jpg"))  # no FileNotFoundError
    images = [c for c in comp.kwargs["messages"][0]["content"] if c["type"] == "image_url"]
    assert len(images) == 1
    assert images[0]["image_url"]["url"].startswith("data:image/png;base64,")


def test_verification_omits_sampling_knobs_for_gpt5(monkeypatch):
    agent, comp = _verifier(monkeypatch, "gpt-5.2", "{}")
    agent.diagnose_result("q", "", "")
    assert "temperature" not in comp.kwargs and "max_tokens" not in comp.kwargs

    agent, comp = _verifier(monkeypatch, "qwen3", "{}")
    agent.diagnose_result("q", "", "")
    assert comp.kwargs["temperature"] == 0.3 and comp.kwargs["max_tokens"] == 1000


@pytest.mark.parametrize("wrap", [
    lambda j: j,
    lambda j: f"Here is my diagnosis:\n```json\n{j}\n```\nHope it helps.",
])
def test_verification_parses_nested_json(monkeypatch, wrap):
    payload = {
        "issue_stage": "coding", "confidence": "high", "reasoning": "r", "suggestions": ["s"],
        "stage_details": {"coding": {"has_issue": True, "issues": ["bad index"]}},
    }
    agent, _ = _verifier(monkeypatch, "gpt-5.2", wrap(json.dumps(payload)))
    assert agent.diagnose_result("q", "", "") == payload


def test_verification_falls_back_on_prose(monkeypatch):
    agent, _ = _verifier(monkeypatch, "gpt-5.2", "no json {here")
    out = agent.diagnose_result("q", "", "")
    assert out["issue_stage"] == "none" and out["reasoning"] == "no json {here"


# --- 5. planning errors surface ------------------------------------------------

class _Provider:
    def __init__(self, text=None, exc=None):
        self.text, self.exc = text, exc

    def infer(self, **kwargs):
        if self.exc:
            raise self.exc
        return SimpleNamespace(text=self.text, tool_calls=[])


@pytest.fixture
def planning_agent(client, monkeypatch):
    import app.api.agent as agent_api
    from app.services.agent.workflow_agent import WorkflowAgent

    monkeypatch.setenv("OPENAI_API_KEY", "dummy")
    agent = WorkflowAgent()
    monkeypatch.setattr(agent_api, "get_workflow_agent", lambda: agent)
    return agent


@pytest.mark.parametrize("route", ["/api/agent/v1/get_steps", "/api/agent/v2/get_steps"])
def test_get_steps_reports_llm_errors(client, planning_agent, route):
    planning_agent.openai_provider = _Provider(exc=RuntimeError("Error code: 401 - invalid api key"))
    body = client.post(route, json={"agent_id": "a", "prompt": "count cells"}).json()
    assert body["code"] != 0
    assert "invalid api key" in body["message"]


def test_get_steps_empty_reply_is_still_an_empty_plan(client, planning_agent):
    planning_agent.openai_provider = _Provider(text="")
    body = client.post("/api/agent/v1/get_steps", json={"agent_id": "a", "prompt": "hi"}).json()
    assert body["code"] == 0 and body["data"] == []


# --- 6. task nodes don't inherit API keys ----------------------------------------

def test_node_env_drops_llm_keys(monkeypatch):
    from app.utils.workflow import register

    monkeypatch.setenv("OPENAI_API_KEY", "sk-a")
    monkeypatch.setenv("DISCOVERY_API_KEY", "sk-b")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:1/v1")
    env = register._isolated_child_env()
    assert "OPENAI_API_KEY" not in env and "DISCOVERY_API_KEY" not in env
    assert env["OPENAI_BASE_URL"] == "http://127.0.0.1:1/v1"


# --- 7. URL handling --------------------------------------------------------------

@pytest.mark.parametrize("url,cloud", [
    ("https://api.openai.com/v1", True),
    ("https://openai.com/v1", True),
    ("https://notopenai.com/v1", False),
    ("https://openai.com.evil.example/v1", False),
])
def test_is_openai_cloud_matches_the_host_exactly(monkeypatch, url, cloud):
    from app.services import llm_config

    monkeypatch.setenv("OPENAI_BASE_URL", url)
    assert llm_config.is_openai_cloud() is cloud


def test_base_url_trailing_slash_is_dropped():
    from app.services import llm_settings

    assert llm_settings._validate("OPENAI_BASE_URL", "http://127.0.0.1:8000/v1/") == "http://127.0.0.1:8000/v1"
    with pytest.raises(llm_settings.SettingsError):
        llm_settings._validate("OPENAI_BASE_URL", "ftp://x")


# --- 8. only the app may change the model settings ----------------------------------

@pytest.mark.parametrize("origin", ["https://evil.example", "null", "http://localhost.evil.example"])
def test_put_model_settings_rejects_foreign_origins(client, settings_module, origin):
    r = client.put(API, json={"fields": {"OPENAI_BASE_URL": "https://evil.example/v1"}},
                   headers={"Origin": origin})
    assert r.json()["code"] == 403
    assert "OPENAI_BASE_URL" not in settings_module.load_saved()


@pytest.mark.parametrize("origin", [None, "http://localhost:3000", "http://127.0.0.1:5001", "http://[::1]:3000"])
def test_put_model_settings_allows_the_app(client, settings_module, origin):
    headers = {"Origin": origin} if origin else {}
    r = client.put(API, json={"fields": {"LLM_MODEL": "qwen3"}}, headers=headers)
    assert r.json()["code"] == 0
    assert settings_module.load_saved()["LLM_MODEL"] == "qwen3"


# --- 9. settings saves racing agent construction ----------------------------------

def test_saves_and_getters_race_without_deadlock_or_stale_agent(settings_module, monkeypatch):
    from app.services.agent import verification_agent as va
    from app.services.agent import workflow_agent as wa

    monkeypatch.setenv("OPENAI_API_KEY", "dummy")
    errors = []

    def getters():
        try:
            for _ in range(30):
                wa.get_workflow_agent()
                va.get_verification_agent()
        except Exception as e:  # pragma: no cover - reported below
            errors.append(e)

    def saves():
        try:
            for i in range(30):
                settings_module.update_settings({"OPENAI_API_KEY": f"sk-race-{i:012d}"})
        except Exception as e:  # pragma: no cover
            errors.append(e)

    threads = [threading.Thread(target=getters) for _ in range(3)] + [threading.Thread(target=saves)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert not any(t.is_alive() for t in threads), "deadlock / hang"
    assert not errors
    # Whatever is cached now was built after the last save.
    last_key = os.environ["OPENAI_API_KEY"]
    assert wa.get_workflow_agent().client.api_key == last_key
    assert va.get_verification_agent().client.api_key == last_key


def test_agent_built_across_a_reset_is_not_cached(monkeypatch):
    from app.services.agent import workflow_agent as wa

    monkeypatch.setenv("OPENAI_API_KEY", "dummy")
    wa.reset_workflow_agent()
    real_init = wa.WorkflowAgent.__init__

    def init_then_reset(self):
        real_init(self)
        wa.reset_workflow_agent()  # Preferences saved while this one was being built

    monkeypatch.setattr(wa.WorkflowAgent, "__init__", init_then_reset)
    built = wa.get_workflow_agent()
    assert built is not None and wa._workflow_agent is None


# --- 13. concurrent corrections make one knowledge item -----------------------------

def test_concurrent_save_knowledge_makes_one_item(tmp_path, monkeypatch):
    from app.services.agent import knowledge_store as ks
    from app.services.agent.workflow_agent import WorkflowAgent

    monkeypatch.setattr(ks, "_store", ks.KnowledgeStore(base_dir=str(tmp_path)))
    agent = WorkflowAgent.__new__(WorkflowAgent)
    agent._knowledge_cache = {}
    agent._knowledge_lock = threading.Lock()

    threads = [threading.Thread(target=agent._save_knowledge, args=("u", "t", f"c{i}"),
                                kwargs={"original_query": "q"}) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not any(t.is_alive() for t in threads)
    items = ks.get_knowledge_store().list_items("u")
    assert len(items) == 1 and items[0].version == 8


def test_deeply_nested_secret_body_is_omitted_not_a_500():
    import asyncio
    import importlib
    mw = importlib.import_module("app.middlewares.logging_middleware")

    payload = ('{"api_key":' * 3000 + '"x"' + "}" * 3000).encode()

    class Req:
        headers = {"content-type": "application/json", "content-length": str(len(payload))}

        async def body(self):
            return payload

    old = mw._LOG_BODIES
    mw._LOG_BODIES = True
    try:
        assert asyncio.run(mw._req_body_for_log(Req())) == "<unparsable JSON body omitted>"
    finally:
        mw._LOG_BODIES = old
