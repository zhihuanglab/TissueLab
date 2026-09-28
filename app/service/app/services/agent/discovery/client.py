"""
OpenAI Responses API client for the discovery loop.

The scout and workers drive custom tool calls chained by previous_response_id,
which only OpenAI's Responses API provides — a Chat Completions endpoint
(OPENAI_BASE_URL pointing at vLLM, Ollama, …) cannot run this loop.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional

from openai import OpenAI

from app.services import llm_config

logger = logging.getLogger(__name__)

_client: Optional[OpenAI] = None

# The loop's prompts were tuned against this model; DISCOVERY_MODEL overrides it.
DEFAULT_DISCOVERY_MODEL = "gpt-5.4"


def discovery_model() -> str:
    return (os.getenv("DISCOVERY_MODEL") or "").strip() or DEFAULT_DISCOVERY_MODEL


def unavailable_reason() -> Optional[str]:
    """Why a discovery run cannot start with the current LLM settings, or None."""
    if not os.getenv("OPENAI_API_KEY"):
        return (
            "Discovery is not configured: set OPENAI_API_KEY in app/service/.env.local."
        )
    if llm_config.api_mode() != "responses":
        return (
            "Discovery needs OpenAI's Responses API; the configured endpoint speaks "
            "Chat Completions only (OPENAI_BASE_URL / LLM_API)."
        )
    return None


def get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI()
    return _client


def responses_create(payload: dict, timeout: int = 180) -> dict:
    """Call the OpenAI Responses API and return the raw response dict.

    timeout bounds each attempt, and one retry keeps a worker's wall clock
    meaningful: the SDK default (600s, two retries) could hold a call ~30 min.
    """
    client = get_client().with_options(timeout=timeout, max_retries=1)
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


def call_model(
    prompt_text: str,
    *,
    model: Optional[str] = None,
    reasoning_effort: str = "high",
    tools: Optional[List[dict]] = None,
    tool_input: Optional[Any] = None,
    previous_response_id: Optional[str] = None,
) -> dict:
    """High-level helper for a single Responses API call."""
    payload: Dict[str, Any] = {
        "model": model or discovery_model(),
        "instructions": prompt_text,
        "input": tool_input or prompt_text,
        "store": True,
        "reasoning": {"effort": reasoning_effort},
    }
    if tools:
        payload["tools"] = tools
        payload["parallel_tool_calls"] = False
    if previous_response_id:
        payload["previous_response_id"] = previous_response_id
    return responses_create(payload, timeout=300)
