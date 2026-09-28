"""Preferences > AI Models: LLM endpoints / keys saved by the service and applied
to the process at once (os.environ + cached clients), never echoed back in full.
"""
import os
import stat

import pytest

API = "/api/agent/v1/model_settings"
KEY = "sk-test-abcdefghijklmnop1234"


@pytest.fixture
def settings_module(client, monkeypatch):
    from app.services import llm_settings

    # The session's own environment is the fallback for cleared fields.
    monkeypatch.setattr(llm_settings, "_baseline", {name: None for name in llm_settings.FIELDS})
    llm_settings.settings_path().unlink(missing_ok=True)
    yield llm_settings
    llm_settings.settings_path().unlink(missing_ok=True)
    llm_settings.apply_saved_settings()


def _put(client, **fields):
    return client.put(API, json={"fields": fields}).json()


def test_nothing_saved(client, settings_module):
    body = client.get(API).json()
    assert body["code"] == 0
    fields = body["data"]["fields"]
    assert set(fields) == set(settings_module.FIELDS)
    assert fields["OPENAI_API_KEY"] == {"set": False, "hint": None, "env_set": False, "env_hint": None}
    assert fields["LLM_MODEL"] == {"value": "", "env_value": ""}
    assert body["data"]["status"]["agent_configured"] is False
    assert "Preferences" in body["data"]["status"]["research_unavailable_reason"]


def test_save_applies_at_once_and_hides_the_key(client, settings_module):
    from app.services.agent import verification_agent, workflow_agent
    from app.services.agent.discovery import client as discovery_client

    workflow_agent._workflow_agent = object()
    verification_agent._verification_agent = object()
    discovery_client._client = object()

    reply = client.put(API, json={"fields": {
        "OPENAI_API_KEY": KEY, "OPENAI_BASE_URL": " http://127.0.0.1:11434/v1 ", "LLM_MODEL": "qwen3", "LLM_API": "Chat",
    }})
    assert KEY not in reply.text
    data = reply.json()["data"]
    assert data["fields"]["OPENAI_API_KEY"]["set"] is True
    assert data["fields"]["OPENAI_API_KEY"]["hint"] == "••••1234"
    assert data["fields"]["OPENAI_BASE_URL"]["value"] == "http://127.0.0.1:11434/v1"
    assert data["status"] == {
        "agent_configured": True,
        "agent_protocol": "chat",
        "agent_model": "qwen3",
        "research_model": "gpt-5.4",
        "research_unavailable_reason": data["status"]["research_unavailable_reason"],
    }
    # A Chat Completions endpoint cannot run discovery unless Research has its own.
    assert "Responses API" in data["status"]["research_unavailable_reason"]
    assert KEY not in client.get(API).text

    assert os.environ["OPENAI_API_KEY"] == KEY
    assert os.environ["OPENAI_BASE_URL"] == "http://127.0.0.1:11434/v1"
    assert os.environ["LLM_API"] == "chat"
    assert workflow_agent._workflow_agent is None
    assert verification_agent._verification_agent is None
    assert discovery_client._client is None

    path = settings_module.settings_path()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_research_endpoint_of_its_own(client, settings_module):
    data = _put(client, OPENAI_API_KEY=KEY, OPENAI_BASE_URL="http://127.0.0.1:11434/v1",
                DISCOVERY_BASE_URL="https://api.openai.com/v1", DISCOVERY_API_KEY="sk-research-000000005678",
                DISCOVERY_MODEL="gpt-5.4-mini")["data"]
    assert data["status"]["research_unavailable_reason"] is None
    assert data["status"]["research_model"] == "gpt-5.4-mini"
    assert data["fields"]["DISCOVERY_API_KEY"]["hint"] == "••••5678"
    assert os.environ["DISCOVERY_API_KEY"] == "sk-research-000000005678"


def test_null_keeps_empty_clears(client, settings_module):
    _put(client, OPENAI_API_KEY=KEY, LLM_MODEL="m1")
    data = _put(client, OPENAI_API_KEY=None, LLM_MODEL="m2")["data"]
    assert data["fields"]["OPENAI_API_KEY"]["set"] is True
    assert os.environ["OPENAI_API_KEY"] == KEY and os.environ["LLM_MODEL"] == "m2"

    data = _put(client, OPENAI_API_KEY="", LLM_MODEL="")["data"]
    assert data["fields"]["OPENAI_API_KEY"]["set"] is False
    assert "OPENAI_API_KEY" not in os.environ and "LLM_MODEL" not in os.environ
    assert data["status"]["agent_configured"] is False


def test_cleared_field_falls_back_to_env_file(client, settings_module, monkeypatch):
    monkeypatch.setitem(settings_module._baseline, "LLM_MODEL", "from-env-file")
    monkeypatch.setitem(settings_module._baseline, "OPENAI_API_KEY", "sk-env-file-key-9999")
    body = client.get(API).json()["data"]
    assert body["fields"]["LLM_MODEL"]["env_value"] == "from-env-file"
    assert body["fields"]["OPENAI_API_KEY"]["env_hint"] == "••••9999"

    _put(client, LLM_MODEL="override", OPENAI_API_KEY=KEY)
    assert os.environ["LLM_MODEL"] == "override" and os.environ["OPENAI_API_KEY"] == KEY
    _put(client, LLM_MODEL="", OPENAI_API_KEY="")
    assert os.environ["LLM_MODEL"] == "from-env-file"
    assert os.environ["OPENAI_API_KEY"] == "sk-env-file-key-9999"


@pytest.mark.parametrize("fields, message", [
    ({"OPENAI_BASE_URL": "localhost:11434"}, "http(s) URL"),
    ({"LLM_API": "grpc"}, "LLM_API must be one of"),
    ({"PATH": "/tmp"}, "Unknown setting"),
])
def test_rejects_bad_values_and_saves_nothing(client, settings_module, fields, message):
    body = _put(client, **fields)
    assert body["code"] == 400 and message in body["message"]
    assert not settings_module.settings_path().exists()


def test_saved_settings_survive_a_restart(client, settings_module):
    _put(client, OPENAI_API_KEY=KEY, LLM_MODEL="persisted")
    os.environ.pop("OPENAI_API_KEY")
    os.environ.pop("LLM_MODEL")
    settings_module.apply_saved_settings()
    assert os.environ["OPENAI_API_KEY"] == KEY and os.environ["LLM_MODEL"] == "persisted"


def test_corrupt_file_counts_as_nothing_saved(client, settings_module):
    settings_module.settings_path().write_text("{not json", encoding="utf-8")
    assert client.get(API).json()["data"]["fields"]["OPENAI_API_KEY"]["set"] is False
