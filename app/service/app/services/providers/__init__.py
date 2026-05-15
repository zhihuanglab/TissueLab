"""
LLM Provider Abstraction Layer

Currently exposes only the OpenAI provider; ctrl-service ships a Tinker
client as well but the local TissueLab build sticks to OpenAI to keep
dependency surface small.
"""

from .base_provider import LLMProvider, LLMResponse, ToolCall
from .openai_provider import OpenAIProvider

__all__ = [
    "LLMProvider",
    "LLMResponse",
    "ToolCall",
    "OpenAIProvider",
]
