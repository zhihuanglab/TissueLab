"""
OpenAI Responses API client for the autoresearch system.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

from openai import OpenAI


_client: Optional[OpenAI] = None
WEB_SEARCH_TOOL = {"type": "web_search_preview"}


def get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _client


def responses_create(payload: dict, timeout: int = 180) -> dict:
    """Call the OpenAI Responses API and return the raw response dict."""
    client = get_client()
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
    model: str = "gpt-5.4",
    reasoning_effort: str = "high",
    tools: Optional[List[dict]] = None,
    tool_input: Optional[Any] = None,
    previous_response_id: Optional[str] = None,
) -> dict:
    """High-level helper for a single Responses API call."""
    payload: Dict[str, Any] = {
        "model": model,
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
