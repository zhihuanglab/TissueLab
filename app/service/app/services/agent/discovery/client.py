"""
OpenAI Responses API client for the discovery loop.

The proposer and worker drive custom tool calls chained by previous_response_id,
which only OpenAI's Responses API provides — a Chat Completions endpoint
(OPENAI_BASE_URL pointing at vLLM, Ollama, …) cannot run this loop.

DISCOVERY_BASE_URL / DISCOVERY_API_KEY give discovery its own Responses
endpoint, so the chat agent can stay on a self-hosted model; unset, discovery
uses OPENAI_BASE_URL / OPENAI_API_KEY like the agent.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
from pathlib import Path
from typing import Any, List, Optional

from openai import OpenAI

from app.services import llm_config

_client: Optional[OpenAI] = None

# The loop's prompts were tuned against this model; DISCOVERY_MODEL overrides it.
DEFAULT_DISCOVERY_MODEL = "gpt-5.4"


def discovery_model() -> str:
    return (os.getenv("DISCOVERY_MODEL") or "").strip() or DEFAULT_DISCOVERY_MODEL


def _discovery_env(name: str) -> str:
    return (os.getenv(f"DISCOVERY_{name}") or "").strip()


def unavailable_reason() -> Optional[str]:
    """Why a discovery run cannot start with the current LLM settings, or None."""
    if not (_discovery_env("API_KEY") or os.getenv("OPENAI_API_KEY")):
        return (
            "Research is not configured: add an API key in Preferences > AI Models "
            "(or set OPENAI_API_KEY in .env.local)."
        )
    # A dedicated DISCOVERY_BASE_URL is declared to speak the Responses API.
    if not _discovery_env("BASE_URL") and llm_config.api_mode() != "responses":
        return (
            "Discovery needs OpenAI's Responses API; the configured endpoint speaks "
            "Chat Completions only. Give Research its own endpoint in Preferences > AI Models "
            "(or DISCOVERY_BASE_URL / DISCOVERY_API_KEY) to keep the agent on its current model."
        )
    return None


def get_client() -> OpenAI:
    global _client
    if _client is None:
        # None falls back to OPENAI_BASE_URL / OPENAI_API_KEY.
        _client = OpenAI(
            base_url=_discovery_env("BASE_URL") or None,
            api_key=_discovery_env("API_KEY") or None,
        )
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


def input_image_message(
    image_path: str | Path,
    *,
    text: str = "Inspect this image.",
    max_bytes: int = 20 * 1024 * 1024,
) -> dict:
    """A Responses API user message carrying one local image (inspect_image tool)."""
    path = Path(image_path)
    if not path.is_file():
        raise FileNotFoundError(path)
    size = path.stat().st_size
    if size <= 0:
        raise ValueError(f"Image is empty: {path}")
    if size > max_bytes:
        raise ValueError(f"Image exceeds {max_bytes} bytes: {path} ({size} bytes)")
    mime_type, _ = mimetypes.guess_type(path.name)
    if mime_type not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
        raise ValueError(f"Unsupported image type for {path}: {mime_type}")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return {
        "type": "message",
        "role": "user",
        "content": [
            {"type": "input_text", "text": text},
            {"type": "input_image", "image_url": f"data:{mime_type};base64,{encoded}", "detail": "original"},
        ],
    }
