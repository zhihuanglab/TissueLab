"""
OpenAI Responses API client for the discovery loop.

The proposer and worker drive custom tool calls chained by previous_response_id,
which only OpenAI's Responses API provides — a Chat Completions endpoint
(OPENAI_BASE_URL pointing at vLLM, Ollama, …) cannot run this loop.

DISCOVERY_BASE_URL / DISCOVERY_API_KEY give discovery its own Responses
endpoint, so the chat agent can stay on a self-hosted model: a DISCOVERY_API_KEY
alone goes to OpenAI (https://api.openai.com/v1); with neither, discovery uses
OPENAI_BASE_URL / OPENAI_API_KEY like the agent. Endpoint and key are taken as a
pair, so a key never goes to a host it was not saved for.

A run pins the client it started with (pin_run_client): a Preferences save
mid-run must not move its previous_response_id chains to another endpoint.
"""

from __future__ import annotations

import json
import os
from contextvars import ContextVar
from typing import Any, List, Mapping, Optional, Tuple

from openai import OpenAI

from app.services import llm_config, llm_settings

# The run's client, once its first request made one (a list so that the
# threads a run starts, which copy its context, fill in the same holder).
_run_client: ContextVar[Optional[list]] = ContextVar("discovery_run_client", default=None)

# The loop's prompts were tuned against this model; DISCOVERY_MODEL overrides it.
DEFAULT_DISCOVERY_MODEL = "gpt-5.4"


def discovery_model() -> str:
    return (os.getenv("DISCOVERY_MODEL") or "").strip() or DEFAULT_DISCOVERY_MODEL


def _discovery_env(name: str, env: Optional[Mapping[str, Optional[str]]] = None) -> str:
    return ((os.environ if env is None else env).get(f"DISCOVERY_{name}") or "").strip()


def _connection(env: Optional[Mapping[str, Optional[str]]] = None) -> Tuple[str, str]:
    """(base_url, api_key) for discovery, read from ``env`` (default os.environ);
    raises RuntimeError when the key is missing."""
    env = os.environ if env is None else env
    base_url = _discovery_env("BASE_URL", env)
    api_key = _discovery_env("API_KEY", env)
    agent_url = (env.get("OPENAI_BASE_URL") or "").strip() or llm_config.OPENAI_URL
    if base_url:
        if not api_key and base_url.rstrip("/") == agent_url.rstrip("/"):
            api_key = (env.get("OPENAI_API_KEY") or "").strip()   # the agent's own endpoint
        if not api_key:
            raise RuntimeError(
                "Research has its own endpoint (DISCOVERY_BASE_URL) but no API key for it: add one in "
                "Preferences > AI Models (or set DISCOVERY_API_KEY)."
            )
        return base_url, api_key
    if api_key:
        return llm_config.OPENAI_URL, api_key   # a research key of its own, no endpoint: OpenAI
    api_key = (env.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError(
            "Research is not configured: add an API key in Preferences > AI Models "
            "(or set OPENAI_API_KEY in .env.local)."
        )
    return agent_url, api_key


def unavailable_reason() -> Optional[str]:
    """Why a discovery run cannot start with the current LLM settings, or None."""
    try:
        _connection()
    except RuntimeError as exc:
        return str(exc)
    # Research's own endpoint (or OpenAI, for its own key alone) is declared to speak the Responses API.
    own = _discovery_env("BASE_URL") or _discovery_env("API_KEY")
    if not own and llm_config.api_mode() != "responses":
        return (
            "Discovery needs OpenAI's Responses API; the configured endpoint speaks "
            "Chat Completions only. Give Research its own endpoint in Preferences > AI Models "
            "(or DISCOVERY_BASE_URL / DISCOVERY_API_KEY) to keep the agent on its current model."
        )
    return None


def _build_client(settings: Mapping[str, Optional[str]]) -> OpenAI:
    base_url, api_key = _connection(settings)
    return OpenAI(base_url=base_url, api_key=api_key)


# Rebuilt once Preferences change the LLM settings.
_client_cache = llm_settings.SettingsCached(_build_client)


def get_client() -> OpenAI:
    return _client_cache.get()


def pin_run_client() -> None:
    """From here on, this task and the threads it starts keep the first client they use."""
    _run_client.set([])


def responses_create(payload: dict, timeout: int = 180) -> dict:
    """Call the OpenAI Responses API and return the raw response dict.

    timeout bounds each attempt, and one retry keeps a worker's wall clock
    meaningful: the SDK default (600s, two retries) could hold a call ~30 min.
    """
    pinned = _run_client.get()
    if pinned is None:
        client = get_client()
    else:
        if not pinned:
            pinned.append(get_client())
        client = pinned[0]
    client = client.with_options(timeout=timeout, max_retries=1)
    response = client.responses.create(**payload)
    if hasattr(response, "model_dump"):
        return response.model_dump(mode="json", warnings="none")
    return dict(response)


def output_text(response: dict) -> str:
    """Extract the text output from a Responses API response."""
    if isinstance(response.get("output_text"), str) and response["output_text"]:
        return response["output_text"]
    chunks = []
    for item in response.get("output", []):
        contents = item.get("content") or []
        for content in contents:
            if isinstance(content, dict) and content.get("type") in {"output_text", "text"}:
                text = content.get("text", "")
                if text:
                    chunks.append(text)
    return "\n".join(chunks).strip()


def response_id(response: dict) -> str:
    value = response.get("id")
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError("Responses API payload did not include a response id")
    return value


def custom_tool_calls(response: dict, tool_name: Optional[str] = None) -> List[dict]:
    calls: List[dict] = []
    for item in response.get("output", []):
        if item.get("type") != "custom_tool_call":
            continue
        if tool_name is not None and item.get("name") != tool_name:
            continue
        calls.append(item)
    return calls


def custom_tool_call_output(call_id: str, output: Any) -> dict:
    rendered = output if isinstance(output, str) else json.dumps(output, indent=2)
    return {
        "type": "custom_tool_call_output",
        "call_id": call_id,
        "output": rendered,
    }
