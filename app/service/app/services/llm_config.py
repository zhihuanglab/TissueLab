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
with a single model needs one variable. A LLM_MODEL saved in Preferences beats
the per-role variables of .env.local (see :mod:`app.services.llm_settings`).
"""
import os
from typing import Optional
from urllib.parse import urlparse

DEFAULT_CLOUD_MODEL = "gpt-5.2"
OPENAI_URL = "https://api.openai.com/v1"
# The per-role overrides of LLM_MODEL read through model_for().
ROLE_MODEL_VARS = (
    "OPENAI_MODEL_ROUTER",
    "CHAT_MODEL",
    "WORKFLOW_MODEL",
    "CODE_MODEL",
    "RANKING_MODEL",
    "OPENAI_MODEL_SEARCH",
    "OPENAI_VISION_MODEL",
    "CODEEXEC_REVIEW_MODEL",
)


def base_url() -> str:
    return (os.getenv("OPENAI_BASE_URL") or "").strip()


def is_openai_cloud() -> bool:
    """True when requests go to api.openai.com (no custom base URL)."""
    return resolve_api_mode(base_url()) == "responses"


def api_mode() -> str:
    """``"chat"`` or ``"responses"``."""
    return resolve_api_mode(base_url(), os.getenv("LLM_API"))


def resolve_api_mode(url: Optional[str], forced: Optional[str] = None) -> str:
    """Resolve a connection's protocol without reading process settings."""
    forced = (forced or "").strip().lower()
    if forced in ("chat", "chat_completions", "chat-completions", "completions"):
        return "chat"
    if forced in ("responses", "response"):
        return "responses"
    host = (urlparse((url or "").strip() or OPENAI_URL).hostname or "").lower()
    return "responses" if host == "openai.com" or host.endswith(".openai.com") else "chat"


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
    "OPENAI_URL",
    "ROLE_MODEL_VARS",
    "api_mode",
    "base_url",
    "default_model",
    "is_gpt5",
    "is_openai_cloud",
    "model_for",
    "resolve_api_mode",
    "web_search_available",
]
