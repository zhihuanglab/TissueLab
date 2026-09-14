"""LLM connection settings shared by the agent and the providers.

The agent speaks the OpenAI API. Two wire protocols exist:

* ``chat`` — Chat Completions (``/v1/chat/completions``). Implemented by every
  OpenAI-compatible server (vLLM, Ollama, LM Studio, llama.cpp, LiteLLM,
  SGLang, TGI, …) and by OpenAI itself.
* ``responses`` — the newer Responses API (``/v1/responses``). OpenAI-only in
  practice; it also carries the hosted ``web_search`` tool.

``LLM_API`` picks the protocol. When unset, ``chat`` is used for any
``OPENAI_BASE_URL`` other than api.openai.com and ``responses`` otherwise.

Models: every role (router / chat / workflow / code / ranking / vision) can be
set individually; ``LLM_MODEL`` is the shared default so a self-hosted server
with a single model needs one variable.
"""
import os
from urllib.parse import urlparse

DEFAULT_CLOUD_MODEL = "gpt-5.2"


def base_url() -> str:
    return (os.getenv("OPENAI_BASE_URL") or "").strip()


def is_openai_cloud() -> bool:
    """True when requests go to api.openai.com (no custom base URL)."""
    url = base_url()
    if not url:
        return True
    host = (urlparse(url).hostname or "").lower()
    return host.endswith("openai.com")


def api_mode() -> str:
    """``"chat"`` or ``"responses"``."""
    forced = (os.getenv("LLM_API") or "").strip().lower()
    if forced in ("chat", "chat_completions", "chat-completions", "completions"):
        return "chat"
    if forced in ("responses", "response"):
        return "responses"
    return "responses" if is_openai_cloud() else "chat"


def default_model() -> str:
    return (os.getenv("LLM_MODEL") or "").strip() or DEFAULT_CLOUD_MODEL


def model_for(role_env: str) -> str:
    """Model for one role, e.g. ``model_for("WORKFLOW_MODEL")``."""
    return (os.getenv(role_env) or "").strip() or default_model()


def web_search_available() -> bool:
    """The hosted web_search tool exists only on OpenAI's Responses API."""
    return is_openai_cloud() and api_mode() == "responses"


def is_gpt5(model: str) -> bool:
    return (model or "").lower().startswith("gpt-5")


__all__ = [
    "DEFAULT_CLOUD_MODEL",
    "api_mode",
    "base_url",
    "default_model",
    "is_gpt5",
    "is_openai_cloud",
    "model_for",
    "web_search_available",
]
