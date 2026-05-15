"""
OpenAI Provider Wrapper

Wraps OpenAI's Responses API to match our LLMProvider interface.
Maintains compatibility with existing agent code.
"""

import json
from typing import List, Dict, Any, Optional
from openai import OpenAI
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
                        elif isinstance(c, dict) and c.get("type") == "output_tool":
                            continue
                        elif isinstance(c, dict) and c.get("type") == "output_image":
                            continue
                except Exception:
                    continue
            if parts:
                return "".join(parts)
    except Exception:
        pass
    return ""


class OpenAIProvider(LLMProvider):
    """
    OpenAI provider using Responses API.
    
    Wraps existing OpenAI client to match our provider interface.
    """
    
    def __init__(self, client: Optional[OpenAI] = None):
        """
        Initialize OpenAI provider.
        
        Args:
            client: OpenAI client instance (creates new one if not provided)
        """
        self.client = client or OpenAI()
    
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
        Run inference using OpenAI Responses API or Chat Completions API.
        
        If messages contain images, falls back to Chat Completions API (which supports vision).
        Otherwise uses Responses API for structured JSON output.
        
        Args:
            messages: Chat messages (content can be string or list with images)
            model: Model name (e.g., "gpt-5.2")
            tools: Tool definitions
            json_schema: JSON schema for structured output
            temperature: Sampling temperature
            max_tokens: Maximum tokens to generate
            
        Returns:
            LLMResponse with text and tool calls
        """
        # Check if any message contains images (content is a list with image_url or input_image)
        has_images = False
        for msg in messages:
            content = msg.get("content")
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict):
                        if item.get("type") in ("image_url", "input_image", "image"):
                            has_images = True
                            break
                if has_images:
                    break
        
        # If images are present, use chat.completions API (supports vision)
        if has_images:
            # Convert messages format for chat.completions
            chat_messages = []
            for msg in messages:
                role = msg.get("role")
                content = msg.get("content")
                
                # Convert content format
                if isinstance(content, list):
                    chat_content = []
                    for item in content:
                        if isinstance(item, dict):
                            item_type = item.get("type")
                            if item_type == "input_text":
                                chat_content.append({
                                    "type": "text",
                                    "text": item.get("text", "")
                                })
                            elif item_type == "input_image":
                                # Convert input_image to image_url format for chat.completions
                                img_data = item.get("data", "")
                                if img_data:
                                    chat_content.append({
                                        "type": "image_url",
                                        "image_url": {
                                            "url": f"data:image/png;base64,{img_data}"
                                        }
                                    })
                            elif item_type == "text":
                                chat_content.append(item)
                            elif item_type == "image_url":
                                chat_content.append(item)
                    chat_messages.append({"role": role, "content": chat_content})
                else:
                    chat_messages.append({"role": role, "content": content})
            
            # Use chat.completions API with response_format for JSON schema
            kwargs: Dict[str, Any] = {
                "model": model or "gpt-5.2",
                "messages": chat_messages,
                "temperature": temperature,
            }
            
            # gpt-5.2 不使用 max_tokens，仅对其它模型传入
            effective_model = model or "gpt-5.2"
            if max_tokens and "5.2" not in effective_model:
                kwargs["max_tokens"] = max_tokens
            
            # For chat.completions API, use json_object response_format (simpler than json_schema)
            # The model will return JSON, but we still need to validate against schema manually
            if json_schema:
                kwargs["response_format"] = {"type": "json_object"}
            
            if tools:
                kwargs["tools"] = tools
            
            try:
                response = self.client.chat.completions.create(**kwargs)
                # Extract text from chat.completions response
                text = response.choices[0].message.content if response.choices else ""
                
                # Extract tool calls if any
                tool_calls = []
                message = response.choices[0].message if response.choices else None
                if message and hasattr(message, 'tool_calls') and message.tool_calls:
                    for tc in message.tool_calls:
                        tool_calls.append(ToolCall(
                            name=tc.function.name if hasattr(tc, 'function') else "",
                            arguments=json.loads(tc.function.arguments) if hasattr(tc, 'function') and hasattr(tc.function, 'arguments') else {},
                            id=tc.id if hasattr(tc, 'id') else None,
                        ))
                
                return LLMResponse(
                    text=text,
                    tool_calls=tool_calls,
                    raw_response=response,
                )
            except Exception as e:
                raise RuntimeError(f"OpenAI inference failed: {str(e)}") from e
        
        # No images, use Responses API for structured JSON output
        kwargs: Dict[str, Any] = {
            "model": model or "gpt-5.2",
            "input": messages,
        }
        
        # Add tools if provided
        if tools:
            kwargs["tools"] = tools
        
        # Add JSON schema if provided
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
            
            # Extract text
            text = _extract_response_text(response)
            
            # Extract tool calls
            tool_calls = []
            output = getattr(response, "output", [])
            for block in output:
                if hasattr(block, 'name') and hasattr(block, 'arguments'):
                    # ResponseFunctionToolCall object
                    tool_name = getattr(block, 'name', None)
                    arguments = getattr(block, 'arguments', None)
                    
                    if tool_name:
                        try:
                            if isinstance(arguments, str):
                                args_dict = json.loads(arguments)
                            else:
                                args_dict = arguments or {}
                            
                            tool_calls.append(ToolCall(
                                name=tool_name,
                                arguments=args_dict,
                                id=getattr(block, 'id', None),
                            ))
                        except Exception as e:
                            print(f"[OpenAIProvider] Failed to parse tool call: {e}")
            
            return LLMResponse(
                text=text,
                tool_calls=tool_calls,
                raw_response=response,
            )
            
        except Exception as e:
            raise RuntimeError(f"OpenAI inference failed: {str(e)}") from e
    
    def get_available_models(self) -> List[str]:
        """
        Get list of available OpenAI models.
        
        Returns:
            List of common OpenAI model names
        """
        # Return common models (full list requires API call to /v1/models)
        return [
            "gpt-5.2",
            "gpt-4-turbo",
            "gpt-3.5-turbo",
        ]
    
    def supports_streaming(self) -> bool:
        """OpenAI supports streaming"""
        return True
    
    def supports_tools(self) -> bool:
        """OpenAI supports tool calling"""
        return True
    
    def supports_json_schema(self) -> bool:
        """OpenAI supports structured JSON output"""
        return True

