"""
OpenAI-compatible provider.

Speaks either the Chat Completions protocol (every OpenAI-compatible server:
vLLM, Ollama, LM Studio, llama.cpp, LiteLLM, …) or OpenAI's Responses API.
The protocol is chosen by ``app.services.agent.llm_config.api_mode()``.

Messages are accepted in the Responses ``input`` shape the agent builds
(``input_text`` / ``input_image`` / ``image_url`` content parts) and converted
for Chat Completions. Tools are accepted in the Responses shape
(``{"type": "function", "name", "description", "parameters"}``) and converted
to the nested Chat Completions shape.
"""

import json
from typing import Any, Dict, List, Optional

from openai import OpenAI

from app.services import llm_config
from .base_provider import LLMProvider, LLMResponse, ToolCall


def _extract_response_text(response: Any) -> str:
    """
    Best-effort text extraction from Responses API result.
    Prefers response.output_text, falls back to concatenating text blocks.
    """
    try:
        text = getattr(response, "output_text", None)
        if text:
            return text
        blocks = getattr(response, "output", None)
        if isinstance(blocks, list) and blocks:
            parts = []
            for block in blocks:
                try:
                    contents = block.get("content", []) if isinstance(block, dict) else []
                    for c in contents:
                        if isinstance(c, dict) and c.get("type") == "output_text":
                            parts.append(c.get("text", ""))
                except Exception:
                    continue
            if parts:
                return "".join(parts)
    except Exception:
        pass
    return ""


def _has_images(messages: List[Dict[str, Any]]) -> bool:
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") in ("image_url", "input_image", "image"):
                    return True
    return False


def _to_chat_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Responses-style content parts → Chat Completions content parts."""
    chat_messages: List[Dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")
        if not isinstance(content, list):
            chat_messages.append({"role": role, "content": content})
            continue
        parts: List[Dict[str, Any]] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type in ("input_text", "text"):
                parts.append({"type": "text", "text": item.get("text", "")})
            elif item_type == "input_image":
                img = item.get("image_url") or item.get("data", "")
                if isinstance(img, dict):
                    img = img.get("url", "")
                if img and not str(img).startswith(("data:", "http://", "https://")):
                    img = f"data:image/png;base64,{img}"
                if img:
                    parts.append({"type": "image_url", "image_url": {"url": img}})
            elif item_type == "image_url":
                parts.append(item)
        chat_messages.append({"role": role, "content": parts})
    return chat_messages


def _to_chat_tools(tools: Optional[List[Dict[str, Any]]]) -> Optional[List[Dict[str, Any]]]:
    if not tools:
        return None
    out: List[Dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        if "function" in tool:  # already Chat Completions shape
            out.append(tool)
            continue
        if tool.get("type") == "function" and tool.get("name"):
            out.append({
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "parameters": tool.get("parameters", {"type": "object", "properties": {}}),
                },
            })
    return out or None


def _parse_json_args(arguments: Any) -> Dict[str, Any]:
    if isinstance(arguments, dict):
        return arguments
    if isinstance(arguments, str) and arguments.strip():
        try:
            parsed = json.loads(arguments)
            return parsed if isinstance(parsed, dict) else {}
        except ValueError:
            return {}
    return {}


class OpenAIProvider(LLMProvider):
    """OpenAI-compatible provider (Chat Completions or Responses API)."""

    def __init__(self, client: Optional[OpenAI] = None, api_mode: Optional[str] = None):
        self.client = client or OpenAI()
        self._api_mode = api_mode

    @property
    def api_mode(self) -> str:
        return self._api_mode or llm_config.api_mode()

    def infer(
        self,
        messages: List[Dict[str, Any]],
        model: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        json_schema: Optional[Dict[str, Any]] = None,
        temperature: float = 1.0,
        max_tokens: Optional[int] = None,
    ) -> LLMResponse:
        """
        Run one inference.

        Chat Completions is used when the configured protocol is ``chat`` or
        when the messages carry images (vision goes through Chat Completions
        on OpenAI as well). Otherwise the Responses API is used.
        """
        model = model or llm_config.default_model()
        if self.api_mode == "chat" or _has_images(messages):
            return self._infer_chat(messages, model, tools, json_schema, temperature, max_tokens)
        return self._infer_responses(messages, model, tools, json_schema)

    # ------------------------------------------------------------------ chat
    def _infer_chat(self, messages, model, tools, json_schema, temperature, max_tokens) -> LLMResponse:
        chat_messages = _to_chat_messages(messages)
        kwargs: Dict[str, Any] = {"model": model, "messages": chat_messages}
        # gpt-5 models only accept the default temperature.
        if not llm_config.is_gpt5(model):
            kwargs["temperature"] = temperature
        if max_tokens and not llm_config.is_gpt5(model):
            kwargs["max_tokens"] = max_tokens
        chat_tools = _to_chat_tools(tools)
        if chat_tools:
            kwargs["tools"] = chat_tools

        if json_schema:
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": json_schema.get("name", "response_schema"),
                    "schema": json_schema.get("schema", json_schema),
                    "strict": bool(json_schema.get("strict", True)),
                },
            }

        try:
            response = self.client.chat.completions.create(**kwargs)
        except Exception as e:
            if not json_schema:
                raise RuntimeError(f"OpenAI inference failed: {str(e)}") from e
            # Servers that implement only ``json_object`` (or no response_format
            # at all) reject the schema form. Retry with the schema inlined in
            # the system prompt so the model still knows the required shape.
            schema_hint = (
                "\n\nRespond with a single JSON object that matches this JSON schema exactly, "
                "with no prose before or after it:\n"
                + json.dumps(json_schema.get("schema", json_schema))
            )
            hinted = [dict(m) for m in chat_messages]
            if hinted and hinted[0].get("role") == "system" and isinstance(hinted[0].get("content"), str):
                hinted[0]["content"] = hinted[0]["content"] + schema_hint
            else:
                hinted.insert(0, {"role": "system", "content": schema_hint.strip()})
            kwargs["messages"] = hinted
            kwargs["response_format"] = {"type": "json_object"}
            try:
                response = self.client.chat.completions.create(**kwargs)
            except Exception as e2:
                raise RuntimeError(f"OpenAI inference failed: {str(e2)}") from e2

        message = response.choices[0].message if getattr(response, "choices", None) else None
        text = (getattr(message, "content", None) or "") if message is not None else ""
        tool_calls: List[ToolCall] = []
        for tc in (getattr(message, "tool_calls", None) or []):
            fn = getattr(tc, "function", None)
            if fn is None or not getattr(fn, "name", None):
                continue
            tool_calls.append(ToolCall(
                name=fn.name,
                arguments=_parse_json_args(getattr(fn, "arguments", None)),
                id=getattr(tc, "id", None),
            ))
        return LLMResponse(text=text, tool_calls=tool_calls, raw_response=response)

    # ------------------------------------------------------------- responses
    def _infer_responses(self, messages, model, tools, json_schema) -> LLMResponse:
        kwargs: Dict[str, Any] = {"model": model, "input": messages}
        if tools:
            kwargs["tools"] = tools
        if json_schema:
            kwargs["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": json_schema.get("name", "response_schema"),
                    "schema": json_schema.get("schema", json_schema),
                    "strict": json_schema.get("strict", True),
                }
            }
        try:
            response = self.client.responses.create(**kwargs)
        except Exception as e:
            raise RuntimeError(f"OpenAI inference failed: {str(e)}") from e

        text = _extract_response_text(response)
        tool_calls: List[ToolCall] = []
        for block in getattr(response, "output", []) or []:
            if hasattr(block, "name") and hasattr(block, "arguments"):
                tool_name = getattr(block, "name", None)
                if tool_name:
                    tool_calls.append(ToolCall(
                        name=tool_name,
                        arguments=_parse_json_args(getattr(block, "arguments", None)),
                        id=getattr(block, "id", None),
                    ))
        return LLMResponse(text=text, tool_calls=tool_calls, raw_response=response)

    def get_available_models(self) -> List[str]:
        """Models the server reports, or the configured default when it cannot be asked."""
        try:
            return [m.id for m in self.client.models.list().data]
        except Exception:
            return [llm_config.default_model()]

    def supports_streaming(self) -> bool:
        return True

    def supports_tools(self) -> bool:
        return True

    def supports_json_schema(self) -> bool:
        return True
