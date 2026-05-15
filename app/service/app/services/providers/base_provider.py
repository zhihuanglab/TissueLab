"""
Base LLM Provider Interface

Abstract base class for all LLM providers to ensure consistent API.
"""

from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional
from dataclasses import dataclass


@dataclass
class ToolCall:
    """Represents a tool call from the LLM"""
    name: str
    arguments: Dict[str, Any]
    id: Optional[str] = None


@dataclass
class LLMResponse:
    """Standardized LLM response format"""
    text: str
    tool_calls: List[ToolCall] = None
    raw_response: Any = None
    
    def __post_init__(self):
        if self.tool_calls is None:
            self.tool_calls = []


class LLMProvider(ABC):
    """Abstract base class for LLM providers"""
    
    @abstractmethod
    def infer(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        json_schema: Optional[Dict[str, Any]] = None,
        temperature: float = 1.0,
        max_tokens: Optional[int] = None,
    ) -> LLMResponse:
        """
        Run inference on the model.
        
        Args:
            messages: List of message dicts with 'role' and 'content'
            model: Model identifier (provider-specific)
            tools: Optional list of tool definitions
            json_schema: Optional JSON schema for structured output
            temperature: Sampling temperature
            max_tokens: Maximum tokens to generate
            
        Returns:
            LLMResponse with text and optional tool calls
        """
        pass
    
    @abstractmethod
    def get_available_models(self) -> List[str]:
        """
        Get list of available models for this provider.
        
        Returns:
            List of model identifiers
        """
        pass
    
    def supports_streaming(self) -> bool:
        """Whether this provider supports streaming responses"""
        return False
    
    def supports_tools(self) -> bool:
        """Whether this provider supports tool/function calling"""
        return False
    
    def supports_json_schema(self) -> bool:
        """Whether this provider supports structured JSON output"""
        return False

