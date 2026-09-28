"""Model endpoints and API keys set from the app's Preferences.

The agent and the discovery loop read their LLM connection from environment
variables (see :mod:`app.services.llm_config` and
:mod:`app.services.agent.discovery.client`), normally supplied by
``.env.local``. Preferences saves overrides for the same variables in
``<storage>/llm_settings.json`` and applies them to ``os.environ``: a saved value
wins over ``.env.local`` / the shell, a cleared one falls back to it. Applying
drops the cached LLM clients so the next request uses the new connection; a
request already in flight finishes on the old one.

``RESEARCH_USES_AGENT`` is the one setting that is not an environment variable:
while it is on, discovery runs on the agent's endpoint and key, whatever
DISCOVERY_BASE_URL / DISCOVERY_API_KEY say (in Preferences or .env.local).
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Dict, Mapping, Optional

from app.config.path_config import SERVICE_STORAGE_DIR

SETTINGS_FILENAME = "llm_settings.json"

FIELDS = (
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "LLM_MODEL",
    "LLM_API",
    "DISCOVERY_BASE_URL",
    "DISCOVERY_API_KEY",
    "DISCOVERY_MODEL",
)
# Research follows the agent's connection ("same as the agent" in Preferences).
USES_AGENT = "RESEARCH_USES_AGENT"
RESEARCH_CONNECTION = ("DISCOVERY_BASE_URL", "DISCOVERY_API_KEY")
SECRETS = frozenset({"OPENAI_API_KEY", "DISCOVERY_API_KEY"})
URL_FIELDS = frozenset({"OPENAI_BASE_URL", "DISCOVERY_BASE_URL"})
LLM_API_VALUES = ("chat", "responses")

# What the process had before Preferences touched it (.env.local, the shell):
# a cleared setting falls back to this.
_baseline: Dict[str, Optional[str]] = {name: os.environ.get(name) for name in FIELDS}
_lock = threading.Lock()


class SettingsError(ValueError):
    pass


def settings_path() -> Path:
    return Path(SERVICE_STORAGE_DIR) / SETTINGS_FILENAME


def load_saved() -> Dict[str, str]:
    """The saved overrides; an unreadable file counts as none."""
    try:
        raw = json.loads(settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {
        k: v.strip() for k, v in raw.items()
        if (k in FIELDS or k == USES_AGENT) and isinstance(v, str) and v.strip()
    }


def _write(saved: Mapping[str, str]) -> None:
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    # Holds API keys: owner-only from the moment it exists.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(dict(saved), fh, indent=2, sort_keys=True)
    os.replace(tmp, path)


def _reset_clients() -> None:
    """Drop every cached client built from the old environment."""
    from app.services.agent import verification_agent, workflow_agent
    from app.services.agent.discovery import client as discovery_client

    workflow_agent._workflow_agent = None
    verification_agent._verification_agent = None
    discovery_client._client = None


def _apply(saved: Mapping[str, str]) -> None:
    for name in FIELDS:
        if name in RESEARCH_CONNECTION and saved.get(USES_AGENT):
            value = None
        else:
            value = saved.get(name) or _baseline.get(name)
        if value:
            os.environ[name] = value
        else:
            os.environ.pop(name, None)
    _reset_clients()


def apply_saved_settings() -> None:
    """Apply the saved overrides (service startup)."""
    with _lock:
        _apply(load_saved())


def _validate(name: str, value: str) -> str:
    if name in URL_FIELDS and not value.lower().startswith(("http://", "https://")):
        raise SettingsError(f"{name} must be an http(s) URL, got {value!r}.")
    if name == "LLM_API":
        value = value.lower()
        if value not in LLM_API_VALUES:
            raise SettingsError(f"LLM_API must be one of {', '.join(LLM_API_VALUES)} (or empty for auto).")
    if name == USES_AGENT:
        value = value.lower()
        if value not in ("true", "false"):
            raise SettingsError(f"{USES_AGENT} must be true or false.")
    return value


def update_settings(changes: Mapping[str, Optional[str]]) -> Dict[str, str]:
    """Merge ``changes`` into the saved overrides, persist, and apply them.

    Per field: ``None`` (or absent) keeps the saved value, ``""`` clears it (back
    to ``.env.local``), any other string replaces it. ``RESEARCH_USES_AGENT``
    takes "true" / "false"; turning it on drops research's own endpoint / key.
    """
    unknown = sorted(set(changes) - set(FIELDS) - {USES_AGENT})
    if unknown:
        raise SettingsError(f"Unknown setting(s): {', '.join(unknown)}.")
    with _lock:
        saved = load_saved()
        for name, value in changes.items():
            if value is None:
                continue
            value = _validate(name, value.strip()) if value.strip() else ""
            if value and not (name == USES_AGENT and value == "false"):
                saved[name] = value
            else:
                saved.pop(name, None)
        if saved.get(USES_AGENT):
            # Its own endpoint / key would only sit there unused.
            for name in RESEARCH_CONNECTION:
                saved.pop(name, None)
        _write(saved)
        _apply(saved)
        return saved


def key_hint(value: Optional[str]) -> Optional[str]:
    """``••••abcd`` for a key long enough to keep the rest secret."""
    if not value:
        return None
    return "••••" + value[-4:] if len(value) >= 12 else "••••"


def public_settings() -> dict:
    """Every field as the UI shows it; API keys only as a hint, never in full."""
    saved = load_saved()
    fields = {}
    for name in FIELDS:
        env_value = _baseline.get(name) or ""
        if name in SECRETS:
            fields[name] = {
                "set": name in saved,
                "hint": key_hint(saved.get(name)),
                "env_set": bool(env_value),
                "env_hint": key_hint(env_value),
            }
        else:
            fields[name] = {"value": saved.get(name, ""), "env_value": env_value}
    # On when asked for, or when nothing gives research a connection of its own.
    fields[USES_AGENT] = {
        "value": bool(saved.get(USES_AGENT)) or not any(os.environ.get(n) for n in RESEARCH_CONNECTION),
    }
    return {"fields": fields, "status": status()}


def status() -> dict:
    """What the current settings add up to."""
    from app.services import llm_config
    from app.services.agent.discovery.client import discovery_model, unavailable_reason
    from app.services.agent.workflow_agent import agent_configured

    return {
        "agent_configured": agent_configured(),
        "agent_protocol": llm_config.api_mode(),
        "agent_model": llm_config.default_model(),
        "research_model": discovery_model(),
        "research_unavailable_reason": unavailable_reason(),
    }


__all__ = [
    "FIELDS",
    "SettingsError",
    "USES_AGENT",
    "apply_saved_settings",
    "load_saved",
    "public_settings",
    "settings_path",
    "status",
    "update_settings",
]
