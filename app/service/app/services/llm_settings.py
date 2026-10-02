"""Model endpoints and API keys set from the app's Preferences.

The agent and the discovery loop read their LLM connection from environment
variables (see :mod:`app.services.llm_config` and
:mod:`app.services.agent.discovery.client`), normally supplied by
``.env.local``. Preferences saves overrides for the same variables in
``<storage>/llm_settings.json`` and applies them to ``os.environ``: a saved value
wins over ``.env.local`` / the shell, a cleared one falls back to it. A saved
LLM_MODEL also wins over the per-role models of .env.local (CHAT_MODEL, …).

Cached LLM clients are :class:`SettingsCached`: built from one consistent read
of the settings (never half of a save) and rebuilt once those change, so the
next request uses the new connection; a request already in flight finishes on
the old one.

``RESEARCH_USES_AGENT`` is the one setting that is not an environment variable.
Saved "true": discovery runs on the agent's endpoint and key, whatever
DISCOVERY_BASE_URL / DISCOVERY_API_KEY say (in Preferences or .env.local).
Saved "false" or never saved: those variables decide (see the discovery client).
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Callable, Dict, Generic, List, Mapping, Optional, Tuple, TypeVar
from urllib.parse import urlparse

from app.config.path_config import SERVICE_STORAGE_DIR
from app.services.llm_config import OPENAI_URL, ROLE_MODEL_VARS

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
# Each endpoint with the key that goes to it.
CONNECTIONS = (("OPENAI_BASE_URL", "OPENAI_API_KEY"), ("DISCOVERY_BASE_URL", "DISCOVERY_API_KEY"))
# Everything a cached client / agent is built from.
WATCHED = FIELDS + ROLE_MODEL_VARS

# What the process had before Preferences touched it (.env.local, the shell):
# a cleared setting falls back to this.
_baseline: Dict[str, Optional[str]] = {name: os.environ.get(name) for name in WATCHED}
# Guards the settings file and os.environ while a save applies.
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


def snapshot() -> Dict[str, Optional[str]]:
    """The LLM settings in one read that no save is half-way through."""
    with _lock:
        return {name: os.environ.get(name) for name in WATCHED}


T = TypeVar("T")
_caches: List["SettingsCached"] = []


class SettingsCached(Generic[T]):
    """One object (client, agent) built from the current LLM settings.

    ``build`` gets a :func:`snapshot`; the object is reused while the settings
    still read the same and rebuilt once they differ. Keyed on the values, not
    on a save counter, so one built from settings replaced meanwhile is never
    served again, and an environment changed some other way is noticed too.
    """

    def __init__(self, build: Callable[[Mapping[str, Optional[str]]], T]):
        self._build = build
        self._entry: Optional[Tuple[tuple, T]] = None
        _caches.append(self)

    def get(self) -> T:
        settings = snapshot()
        key = tuple(settings.values())
        entry = self._entry
        if entry is not None and entry[0] == key:
            return entry[1]
        value = self._build(settings)
        self._entry = (key, value)
        return value

    def clear(self) -> None:
        self._entry = None


def openai_kwargs(settings: Mapping[str, Optional[str]]) -> dict:
    """The agent's endpoint and key for ``OpenAI(**…)``, both from ``settings``
    (the SDK would otherwise read each from os.environ on its own)."""
    return {
        "api_key": settings.get("OPENAI_API_KEY") or None,
        "base_url": settings.get("OPENAI_BASE_URL") or OPENAI_URL,
    }


def _reset_clients() -> None:
    """Drop every cached client built from the old environment."""
    for cache in _caches:
        cache.clear()


def _apply(saved: Mapping[str, str]) -> None:
    research_on_agent = saved.get(USES_AGENT) == "true"
    for name in WATCHED:
        if name in RESEARCH_CONNECTION and research_on_agent:
            value = None
        elif name in ROLE_MODEL_VARS and saved.get("LLM_MODEL"):
            # The model chosen in Preferences is the later, explicit choice.
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
    if name in URL_FIELDS:
        try:
            parsed = urlparse(value)
            parsed.port  # raises on "host:abc"
            host = parsed.hostname
        except ValueError:
            host = None
        if not value.lower().startswith(("http://", "https://")) or not host:
            raise SettingsError(f"{name} must be an http(s) URL, got {value!r}.")
        value = value.rstrip("/")  # the SDK appends "/chat/completions" itself
    if name == "LLM_API":
        value = value.lower()
        if value not in LLM_API_VALUES:
            raise SettingsError(f"LLM_API must be one of {', '.join(LLM_API_VALUES)} (or empty for auto).")
    if name == USES_AGENT:
        value = value.lower()
        if value not in ("true", "false"):
            raise SettingsError(f"{USES_AGENT} must be true or false.")
    return value


def _endpoint(saved: Mapping[str, str], url_name: str) -> Tuple[str, Optional[int]]:
    """(host, port) a connection's key goes to; empty means OpenAI."""
    parsed = urlparse(saved.get(url_name) or _baseline.get(url_name) or OPENAI_URL)
    return (parsed.hostname or "").lower(), parsed.port


def update_settings(changes: Mapping[str, Optional[str]]) -> List[str]:
    """Merge ``changes`` into the saved overrides, persist, and apply them.

    Per field: ``None`` (or absent) keeps the saved value, ``""`` clears it (back
    to ``.env.local``), any other string replaces it. ``RESEARCH_USES_AGENT``
    takes "true" / "false" (saved as given) or "" (back to following .env.local);
    "true" drops research's own endpoint / key.

    A saved key never follows its endpoint to another host: moving the endpoint
    without a new key clears it. Returns the keys cleared that way.
    """
    unknown = sorted(set(changes) - set(FIELDS) - {USES_AGENT})
    if unknown:
        raise SettingsError(f"Unknown setting(s): {', '.join(unknown)}.")
    with _lock:
        saved = load_saved()
        before = {url: _endpoint(saved, url) for url, _ in CONNECTIONS}
        for name, value in changes.items():
            if value is None:
                continue
            value = _validate(name, value.strip()) if value.strip() else ""
            if value:
                saved[name] = value
            else:
                saved.pop(name, None)
        cleared = []
        for url, key in CONNECTIONS:
            if changes.get(key) is None and key in saved and _endpoint(saved, url) != before[url]:
                saved.pop(key)
                cleared.append(key)
        if saved.get(USES_AGENT) == "true":
            # Its own endpoint / key would only sit there unused.
            for name in RESEARCH_CONNECTION:
                saved.pop(name, None)
        _write(saved)
        _apply(saved)
        return cleared


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
    # As saved; never saved: on unless something gives research a connection of its own.
    uses_agent = saved.get(USES_AGENT)
    fields[USES_AGENT] = {
        "value": uses_agent == "true" if uses_agent else not any(os.environ.get(n) for n in RESEARCH_CONNECTION),
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
        "agent_model": llm_config.model_for("CHAT_MODEL"),  # what chat runs on
        "research_model": discovery_model(),
        "research_unavailable_reason": unavailable_reason(),
    }


__all__ = [
    "FIELDS",
    "SettingsCached",
    "SettingsError",
    "USES_AGENT",
    "apply_saved_settings",
    "load_saved",
    "openai_kwargs",
    "public_settings",
    "settings_path",
    "snapshot",
    "status",
    "update_settings",
]
