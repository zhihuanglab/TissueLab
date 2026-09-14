"""
LLM Provider Abstraction Layer

The open edition ships the OpenAI-compatible provider. Any endpoint that speaks
the OpenAI API (a self-hosted server, a proxy) can be used through
``OPENAI_BASE_URL``.
"""

from .base_provider import LLMProvider, LLMResponse, ToolCall
from .openai_provider import OpenAIProvider

__all__ = [
    "LLMProvider",
    "LLMResponse",
    "ToolCall",
    "OpenAIProvider",
]
