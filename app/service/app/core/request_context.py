"""Per-request context shared between the logging middleware and the response
helpers (path/method/ip), so log lines emitted from the response layer — which
has no request handle — stay traceable."""
import contextvars

req_var: "contextvars.ContextVar[dict]" = contextvars.ContextVar("req", default={})

__all__ = ["req_var"]
