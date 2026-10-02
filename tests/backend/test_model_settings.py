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
    assert set(fields) == {*settings_module.FIELDS, "RESEARCH_USES_AGENT"}
    assert fields["RESEARCH_USES_AGENT"] == {"value": True}
    assert fields["OPENAI_API_KEY"] == {"set": False, "hint": None, "env_set": False, "env_hint": None}
    assert fields["LLM_MODEL"] == {"value": "", "env_value": ""}
    assert body["data"]["status"]["agent_configured"] is False
    assert "Preferences" in body["data"]["status"]["research_unavailable_reason"]


def test_save_applies_at_once_and_hides_the_key(client, settings_module):
    from app.services.agent import verification_agent, workflow_agent
    from app.services.agent.discovery import client as discovery_client

    caches = (workflow_agent._agent_cache, verification_agent._agent_cache, discovery_client._client_cache)
    for cache in caches:
        cache._entry = ((), object())

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
    assert all(cache._entry is None for cache in caches)

    path = settings_module.settings_path()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_research_same_as_agent_switch(client, settings_module, monkeypatch):
    # .env.local gives research its own endpoint: the switch starts off.
    monkeypatch.setitem(settings_module._baseline, "DISCOVERY_BASE_URL", "https://env.example/v1")
    monkeypatch.setitem(settings_module._baseline, "DISCOVERY_API_KEY", "sk-env-research-0000")
    settings_module.apply_saved_settings()
    assert client.get(API).json()["data"]["fields"]["RESEARCH_USES_AGENT"] == {"value": False}

    # On: research follows the agent, the .env.local pair and any saved one notwithstanding.
    _put(client, DISCOVERY_BASE_URL="https://saved.example/v1", DISCOVERY_API_KEY="sk-saved-research-1111")
    data = _put(client, RESEARCH_USES_AGENT="true", OPENAI_API_KEY=KEY)["data"]
    assert data["fields"]["RESEARCH_USES_AGENT"] == {"value": True}
    assert data["fields"]["DISCOVERY_BASE_URL"]["value"] == ""
    assert data["fields"]["DISCOVERY_API_KEY"]["set"] is False
    assert "DISCOVERY_BASE_URL" not in os.environ and "DISCOVERY_API_KEY" not in os.environ
    assert data["status"]["research_unavailable_reason"] is None  # the agent is on OpenAI here
    settings_module.apply_saved_settings()
    assert "DISCOVERY_BASE_URL" not in os.environ

    # Off again: back to .env.local's pair, and saved as off.
    data = _put(client, RESEARCH_USES_AGENT="false")["data"]
    assert data["fields"]["RESEARCH_USES_AGENT"] == {"value": False}
    assert os.environ["DISCOVERY_BASE_URL"] == "https://env.example/v1"
    assert settings_module.load_saved()["RESEARCH_USES_AGENT"] == "false"


def test_research_switch_untouched_follows_env_and_off_round_trips(client, settings_module, monkeypatch):
    # Saves that leave the switch alone (the UI sends it only when changed) never pin it:
    # research's own pair added to .env.local later still takes effect.
    _put(client, LLM_MODEL="m1")
    assert "RESEARCH_USES_AGENT" not in settings_module.load_saved()
    assert client.get(API).json()["data"]["fields"]["RESEARCH_USES_AGENT"] == {"value": True}
    monkeypatch.setitem(settings_module._baseline, "DISCOVERY_BASE_URL", "https://env.example/v1")
    monkeypatch.setitem(settings_module._baseline, "DISCOVERY_API_KEY", "sk-env-research-0000")
    settings_module.apply_saved_settings()
    assert os.environ["DISCOVERY_BASE_URL"] == "https://env.example/v1"
    assert client.get(API).json()["data"]["fields"]["RESEARCH_USES_AGENT"] == {"value": False}

    # Turned off with no research connection anywhere: still off on reopen.
    monkeypatch.setitem(settings_module._baseline, "DISCOVERY_BASE_URL", None)
    monkeypatch.setitem(settings_module._baseline, "DISCOVERY_API_KEY", None)
    data = _put(client, RESEARCH_USES_AGENT="false")["data"]
    assert data["fields"]["RESEARCH_USES_AGENT"] == {"value": False}
    assert client.get(API).json()["data"]["fields"]["RESEARCH_USES_AGENT"] == {"value": False}
    # "" goes back to following .env.local.
    data = _put(client, RESEARCH_USES_AGENT="")["data"]
    assert data["fields"]["RESEARCH_USES_AGENT"] == {"value": True}
    assert "RESEARCH_USES_AGENT" not in settings_module.load_saved()


def test_preferences_model_beats_per_role_models_from_env(client, settings_module, monkeypatch):
    monkeypatch.setitem(settings_module._baseline, "CHAT_MODEL", "env-chat")
    monkeypatch.setitem(settings_module._baseline, "WORKFLOW_MODEL", "env-workflow")
    settings_module.apply_saved_settings()
    from app.services import llm_config

    assert llm_config.model_for("WORKFLOW_MODEL") == "env-workflow"
    assert client.get(API).json()["data"]["status"]["agent_model"] == "env-chat"

    data = _put(client, LLM_MODEL="prefs-model")["data"]
    assert data["status"]["agent_model"] == "prefs-model"
    assert llm_config.model_for("WORKFLOW_MODEL") == "prefs-model"
    assert "CHAT_MODEL" not in os.environ

    # Cleared: the per-role models of .env.local are back.
    data = _put(client, LLM_MODEL="")["data"]
    assert data["status"]["agent_model"] == "env-chat"
    assert os.environ["WORKFLOW_MODEL"] == "env-workflow"


@pytest.mark.parametrize("url, key", [("OPENAI_BASE_URL", "OPENAI_API_KEY"), ("DISCOVERY_BASE_URL", "DISCOVERY_API_KEY")])
def test_moving_the_endpoint_clears_its_saved_key(client, settings_module, url, key):
    _put(client, **{url: "https://api.openai.com/v1", key: KEY})
    # Same host (path / trailing slash): the key stays.
    body = _put(client, **{url: "https://api.openai.com/v1/"})
    assert body["data"]["cleared_keys"] == [] and settings_module.load_saved()[key] == KEY

    # Another host without a new key: the saved key never goes there.
    body = _put(client, **{url: "https://third-party.example/v1"})
    assert body["data"]["cleared_keys"] == [key]
    assert key not in settings_module.load_saved()
    assert body["data"]["fields"][key]["set"] is False

    # Another host with its key: kept.
    body = _put(client, **{url: "http://127.0.0.1:8000/v1", key: "sk-local-key-00005678"})
    assert body["data"]["cleared_keys"] == []
    assert settings_module.load_saved()[key] == "sk-local-key-00005678"
    # Another port on the same host is another server.
    body = _put(client, **{url: "http://127.0.0.1:9000/v1"})
    assert body["data"]["cleared_keys"] == [key]


def test_research_key_alone_goes_to_openai(client, settings_module):
    from app.services.agent.discovery import client as discovery_client

    data = _put(client, OPENAI_API_KEY=KEY, OPENAI_BASE_URL="http://127.0.0.1:11434/v1",
                RESEARCH_USES_AGENT="false", DISCOVERY_API_KEY="sk-research-key-4321")["data"]
    assert data["status"]["research_unavailable_reason"] is None
    research = discovery_client.get_client()
    assert research.api_key == "sk-research-key-4321"
    assert str(research.base_url).startswith("https://api.openai.com/v1")


def test_cached_clients_follow_every_save(client, settings_module):
    from app.services.agent import verification_agent, workflow_agent
    from app.services.agent.discovery import client as discovery_client

    _put(client, OPENAI_API_KEY=KEY, OPENAI_BASE_URL="https://api.openai.com/v1")
    agent = workflow_agent.get_workflow_agent()
    assert workflow_agent.get_workflow_agent() is agent
    research = discovery_client.get_client()
    assert discovery_client.get_client() is research

    _put(client, OPENAI_API_KEY="sk-second-key-00009999")
    for current in (workflow_agent.get_workflow_agent(), verification_agent.get_verification_agent()):
        assert current.client.api_key == "sk-second-key-00009999"
    assert workflow_agent.get_workflow_agent() is not agent
    assert discovery_client.get_client().api_key == "sk-second-key-00009999"

    # An environment changed some other way is noticed too.
    os.environ["OPENAI_API_KEY"] = "sk-third-key-000077777"
    assert discovery_client.get_client().api_key == "sk-third-key-000077777"


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
    ({"OPENAI_BASE_URL": "http://"}, "http(s) URL"),
    ({"DISCOVERY_BASE_URL": "https:///v1"}, "http(s) URL"),
    ({"OPENAI_BASE_URL": "http://host:abc/v1"}, "http(s) URL"),
    ({"LLM_API": "grpc"}, "LLM_API must be one of"),
    ({"PATH": "/tmp"}, "Unknown setting"),
    ({"RESEARCH_USES_AGENT": "yes"}, "must be true or false"),
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


def test_first_build_files_lose_their_automatic_research_switch(client, settings_module, monkeypatch):
    import json
    # The first Preferences build wrote RESEARCH_USES_AGENT=true on every save, with no format mark.
    settings_module.settings_path().write_text(json.dumps({"LLM_MODEL": "m1", "RESEARCH_USES_AGENT": "true"}))
    monkeypatch.setitem(settings_module._baseline, "DISCOVERY_BASE_URL", "https://env.example/v1")
    monkeypatch.setitem(settings_module._baseline, "DISCOVERY_API_KEY", "sk-env-research-0000")
    settings_module.apply_saved_settings()
    assert os.environ["DISCOVERY_BASE_URL"] == "https://env.example/v1"
    assert json.loads(settings_module.settings_path().read_text()) == {"LLM_MODEL": "m1", "_format": 2}
    # Chosen in the current build: kept.
    _put(client, RESEARCH_USES_AGENT="true")
    settings_module.apply_saved_settings()
    assert settings_module.load_saved()["RESEARCH_USES_AGENT"] == "true"
    assert "DISCOVERY_BASE_URL" not in os.environ


@pytest.mark.parametrize("url, key", [("OPENAI_BASE_URL", "OPENAI_API_KEY"), ("DISCOVERY_BASE_URL", "DISCOVERY_API_KEY")])
def test_env_file_key_stays_with_its_endpoint(client, settings_module, monkeypatch, url, key):
    monkeypatch.setitem(settings_module._baseline, url, "https://env.example/v1")
    monkeypatch.setitem(settings_module._baseline, key, "sk-env-file-key-9999")
    settings_module.apply_saved_settings()
    assert os.environ[key] == "sk-env-file-key-9999"

    _put(client, **{url: "https://env.example:443/v2"})   # same host: still its key
    assert os.environ[key] == "sk-env-file-key-9999"
    _put(client, **{url: "https://third-party.example/v1"})
    assert key not in os.environ
    _put(client, **{key: KEY})                             # a key typed for the new endpoint
    assert os.environ[key] == KEY
    _put(client, **{url: "", key: ""})                     # back to .env.local's pair
    assert os.environ[url] == "https://env.example/v1" and os.environ[key] == "sk-env-file-key-9999"
