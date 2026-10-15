"""
OpenAI Responses API client for the discovery loop.

OpenAI uses Responses directly. Chat Completions endpoints use a small adapter
for conversation history and shell function calls, retaining the loop interface.

DISCOVERY_BASE_URL / DISCOVERY_API_KEY give discovery its own API
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
import threading
import uuid
from collections import OrderedDict
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
    configured = (os.getenv("DISCOVERY_MODEL") or "").strip()
    if configured:
        return configured
    if _api_mode(os.environ) == "chat":
        return llm_config.default_model()
    return DEFAULT_DISCOVERY_MODEL


def _api_mode(settings: Mapping[str, Optional[str]]) -> str:
    own_url = (settings.get("DISCOVERY_BASE_URL") or "").strip()
    if own_url or (settings.get("DISCOVERY_API_KEY") or "").strip():
        return llm_config.resolve_api_mode(own_url)
    return llm_config.resolve_api_mode(settings.get("OPENAI_BASE_URL"), settings.get("LLM_API"))


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
    return None


def _build_client(settings: Mapping[str, Optional[str]]) -> Any:
    base_url, api_key = _connection(settings)
    client = OpenAI(base_url=base_url, api_key=api_key)
    return _ChatClient(client) if _api_mode(settings) == "chat" else client


def _may_need_text_tools(error: Exception) -> bool:
    """Try text after server failures or an explicit native-tool rejection."""
    status = getattr(error, "status_code", None)
    if status is not None and 500 <= status < 600:
        return True
    if status not in (400, 422):
        return False
    message = str(error).lower()
    return any(name in message for name in ("tools", "tool_choice", "function calling")) and any(
        marker in message for marker in ("not supported", "does not support", "unsupported", "not implemented")
    )


class _ChatClient:
    """Translate the loop's text and custom shell tool to Chat Completions.

    Try native tools first, then text JSON for eligible errors after SDK retries.
    A validated text response selects text transport for this conversation only.
    Responses-only reasoning settings are not forwarded.
    Only the latest state of each conversation is retained in a bounded cache.
    """

    def __init__(self, client: Any, history: Any = None, lock: Any = None):
        self.client = client
        self.history = history if history is not None else OrderedDict()
        self.lock = lock if lock is not None else threading.Lock()
        self.responses = self

    def with_options(self, **options: Any) -> Any:
        return _ChatClient(self.client.with_options(**options), self.history, self.lock)

    def _text_tool_request(self, request: dict) -> dict:
        """Render the canonical tool history as ordinary chat messages."""
        request = dict(request)
        tools = request.pop("tools")
        request.pop("parallel_tool_calls", None)
        messages = []
        for original in request["messages"]:
            message = dict(original)
            if message["role"] == "tool":
                message = {"role": "user", "content": "Shell tool result:\n" + message["content"]}
            elif message.get("tool_calls"):
                commands = [json.dumps({"tool": call["function"]["name"],
                                       **json.loads(call["function"]["arguments"])})
                            for call in message["tool_calls"]]
                message = {"role": "assistant", "content": "\n".join(commands)}
            messages.append(message)
        instruction = (
            '\nTo call a tool, reply with exactly one JSON object '
            '{"tool":"shell_exec","command":"raw shell command"}. '
            'Use only the tool names listed below. To finish, reply exactly DONE. '
            'Do not add prose. Tool results follow as user messages. Available tools: '
            + json.dumps(tools)
        )
        if messages and messages[0]["role"] == "system":
            messages[0]["content"] += instruction
        else:
            messages.insert(0, {"role": "system", "content": instruction})
        request["messages"] = messages
        return request

    @staticmethod
    def _text_tool_calls(text: str, names: set[str]) -> list[dict]:
        rendered = text.strip()
        if rendered == "DONE":
            return []
        # Accept one enclosing Markdown fence, but never extract JSON from prose.
        lines = rendered.splitlines()
        if len(lines) >= 3 and lines[0] in {"```", "```json"} and lines[-1] == "```":
            rendered = "\n".join(lines[1:-1])
        try:
            command = json.loads(rendered)
        except ValueError as exc:
            raise ValueError("Research text tools require a command JSON object or DONE") from exc
        if (not isinstance(command, dict) or set(command) != {"tool", "command"}
                or not isinstance(command["tool"], str) or command["tool"] not in names
                or not isinstance(command["command"], str) or not command["command"].strip()):
            raise ValueError("Research text tool call has an unknown tool or invalid command")
        return [{"id": "call_" + uuid.uuid4().hex, "type": "function", "function": {
            "name": command["tool"], "arguments": json.dumps({"command": command["command"]}),
        }}]

    def create(self, **payload: Any) -> dict:
        previous = payload.get("previous_response_id")
        with self.lock:
            if previous and previous not in self.history:
                raise RuntimeError("Research conversation state expired; restart this worker.")
            state = self.history.get(previous)
            messages = list(state[0]) if state is not None else []
            use_text = state[1] if state is not None else False
        instructions = payload.get("instructions")
        if instructions:
            messages = [m for m in messages if m["role"] != "system"]
            messages.insert(0, {"role": "system", "content": instructions})
        pending = payload.get("input", "")
        if isinstance(pending, str):
            messages.append({"role": "user", "content": pending})
        else:
            for item in pending:
                if item.get("type") != "custom_tool_call_output":
                    raise ValueError("Unsupported Research input for Chat Completions")
                messages.append({"role": "tool", "tool_call_id": item["call_id"], "content": item["output"]})
        request = {"model": payload["model"], "messages": messages}
        tools = []
        for tool in payload.get("tools", []):
            if tool.get("type") != "custom":
                raise ValueError("Unsupported Research tool for Chat Completions")
            tools.append({"type": "function", "function": {
                "name": tool["name"],
                "description": tool.get("description", "") + " Supply raw shell text in command.",
                "parameters": {"type": "object", "properties": {"command": {"type": "string"}},
                               "required": ["command"], "additionalProperties": False},
            }})
        if tools:
            request["tools"] = tools
            if "parallel_tool_calls" in payload:
                request["parallel_tool_calls"] = payload["parallel_tool_calls"]
        if payload.get("max_output_tokens"):
            request["max_tokens"] = payload["max_output_tokens"]
        text_tools = bool(tools) and use_text
        names = {tool["name"] for tool in payload.get("tools", [])}
        try:
            response = self.client.chat.completions.create(**(self._text_tool_request(request) if text_tools else request))
        except Exception as native_error:
            if text_tools or not tools or not _may_need_text_tools(native_error):
                raise
            try:
                response = self.client.chat.completions.create(**self._text_tool_request(request))
                raw, calls, text = self._read_response(response, True, names)
            except Exception as text_error:
                # Keep the original service failure when ordinary chat also
                # fails or cannot produce a valid tool reply. No state changes.
                raise native_error from text_error
            text_tools = True
        else:
            raw, calls, text = self._read_response(response, text_tools, names)
        output = [{"type": "message", "content": [{"type": "output_text", "text": text}]}] if text else []
        for call in calls:
            function = call["function"]
            arguments = json.loads(function["arguments"])
            command = arguments.get("command")
            if not isinstance(command, str):
                raise ValueError("Research shell tool requires a string command")
            output.append({"type": "custom_tool_call", "name": function["name"],
                           "call_id": call["id"], "input": command})
        assistant = {"role": "assistant", "content": text or None}
        if calls:
            assistant["tool_calls"] = calls
        messages = messages + [assistant]
        identifier = "chat_" + uuid.uuid4().hex
        if payload.get("store") or previous:
            with self.lock:
                if previous:
                    self.history.pop(previous, None)
                self.history[identifier] = (messages, text_tools)
                while len(self.history) > 128:
                    self.history.popitem(last=False)
        usage = raw.get("usage") or {}
        return {"id": identifier, "model": raw.get("model") or payload["model"], "output": output,
                "output_text": text, "usage": {
                    "input_tokens": usage.get("prompt_tokens", 0),
                    "output_tokens": usage.get("completion_tokens", 0),
                    "input_tokens_details": usage.get("prompt_tokens_details") or {},
                    "output_tokens_details": usage.get("completion_tokens_details") or {},
                }}

    @classmethod
    def _read_response(cls, response: Any, text_tools: bool, names: set[str]) -> tuple[dict, list, str]:
        raw = response.model_dump(mode="json", warnings="none") if hasattr(response, "model_dump") else dict(response)
        choice = raw["choices"][0]
        if choice.get("finish_reason") == "length":
            raise RuntimeError("OpenAI-compatible Chat Completions output was truncated; reduce the task or increase the server output limit.")
        message = raw["choices"][0]["message"]
        calls = message.get("tool_calls") or []
        text = message.get("content") or ""
        if text_tools:
            if calls:
                raise ValueError("Research text mode expected text, received native tool calls")
            calls = cls._text_tool_calls(text, names)
            if calls:
                text = ""
        return raw, calls, text


# Rebuilt once Preferences change the LLM settings.
_client_cache = llm_settings.SettingsCached(_build_client)


def get_client() -> Any:
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
