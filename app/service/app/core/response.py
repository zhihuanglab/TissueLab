import json
import os
from typing import Any, Optional
import numpy as np

from fastapi import Response

from app.core.errors import AppErrors, AppError

_UNSET = object()


def _summarize_for_log(obj: Any, _list_head: int = 5, _str_max: int = 200) -> Any:
    """Return a log-friendly copy of ``obj`` with long lists/strings collapsed.

    Big numeric arrays (e.g. ``class_indices`` with 200k entries) are replaced by
    a short preview plus a count, so logs stay readable instead of dumping
    megabytes of repetitive values.
    """
    if isinstance(obj, dict):
        return {k: _summarize_for_log(v, _list_head, _str_max) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        n = len(obj)
        if n > _list_head + 5:
            head = [_summarize_for_log(x, _list_head, _str_max) for x in obj[:_list_head]]
            return head + [f"...(+{n - _list_head} more, {n} total)"]
        return [_summarize_for_log(x, _list_head, _str_max) for x in obj]
    if isinstance(obj, str) and len(obj) > _str_max:
        return obj[:_str_max] + f"...(+{len(obj) - _str_max} chars)"
    return obj


def _log_response_body(code: int, content: str, data: Any = _UNSET) -> None:
    """Log a compact response body for every helper-built response. rid/uid come
    from the request contextvars via the logger's filter.

    Long lists/strings inside ``data`` are summarized before logging; a final
    char cap (``LOG_BODY_MAX``) guards against anything still oversized."""
    try:
        if os.getenv("LOG_BODIES", "1") == "0":
            return
        from app.core.logger import logger
        _max = int(os.getenv("LOG_BODY_MAX", "2048"))
        if data is not _UNSET:
            try:
                summary = {"code": code, "data": _summarize_for_log(data)}
                body = json.dumps(summary, cls=NumpyEncoder)
            except Exception:
                body = content
        else:
            body = content
        if len(body) > _max:
            body = body[:_max] + f"...(+{len(body) - _max}B)"
        logger.info(f"resp code={code}: {body}")
    except Exception:
        pass

class NumpyEncoder(json.JSONEncoder):
    """Custom JSON encoder for numpy types"""
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        elif isinstance(obj, np.floating):
            return float(obj)
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        elif isinstance(obj, (bytes, bytearray)):
            return obj.decode("utf-8", "ignore")
        return super().default(obj)


class AppResponse:
    """Stable HTTP-200 application envelope.

    Contract (always present, never null):
      {
        "code": number,          # 0 = success
        "message": string,
        "data": object|array|primitive,  # never null; {} when empty
        "request_id": string     # "" when unknown
      }

    Permission / ACL denials put structured fields inside data:
      data.error_code, data.access_mode, data.operation
    """

    def __init__(
            self,
            code: int = 0,
            message: str = "success",
            data: Any = None,
            request_id: Optional[str] = None
    ):
        self.code = code
        self.message = message if isinstance(message, str) else str(message or "")
        self.data = {} if data is None else data
        self.request_id = request_id if isinstance(request_id, str) else (request_id or "")

    def to_response(self) -> Response:
        """Convert to FastAPI Response"""
        response_data = {
            "code": self.code,
            "message": self.message,
            "data": self.data,
            "request_id": self.request_id or "",
        }

        content = json.dumps(response_data, cls=NumpyEncoder)
        _log_response_body(self.code, content, self.data)
        return Response(
            content=content,
            status_code=200,  # Always return 200
        )


# Convenient Methods
def success_response(
        data: Any = None,
        request_id: Optional[str] = None
) -> Response:
    return AppResponse(
        code=0,
        message="Success",
        data=data,
        request_id=request_id
    ).to_response()


def error_response(
        message: str,
        code: int = AppErrors.SERVER_INTERNAL_ERROR().status_code,
        request_id: Optional[str] = None,
        data: Any = None,
        error_code: Optional[str] = None,
) -> Response:
    payload = {} if data is None else dict(data) if isinstance(data, dict) else {"value": data}
    if error_code:
        payload.setdefault("error_code", error_code)
    return AppResponse(
        code=code,
        message=message,
        data=payload,
        request_id=request_id
    ).to_response()


def permission_denied_response(
        *,
        access_mode: str,
        operation: str,
        request_id: Optional[str] = None,
        error_code: Optional[str] = None,
) -> Response:
    """Return the stable HTTP-200 application envelope for path denials.

    Do not include filesystem paths or backend exception details in the client
    message. Callers can branch on ``data.error_code`` instead.

    Default ``error_code`` follows Ctrl FM naming when ``access_mode`` is known:
    viewer → VIEW_ONLY_FORBIDDEN, samples → PUBLIC_READ_ONLY_FORBIDDEN.
    """
    mode = access_mode or "forbidden"
    op = operation or "access resource"
    if error_code:
        code = error_code
    elif mode == "viewer":
        code = "VIEW_ONLY_FORBIDDEN"
    elif mode == "samples":
        code = "PUBLIC_READ_ONLY_FORBIDDEN"
    else:
        code = "PATH_ACCESS_DENIED"
    if mode == "unauthenticated":
        message = "Authentication is required for this API operation."
    elif mode == "viewer":
        message = f"{op} is not available for this read-only Viewer share."
    elif mode == "samples":
        message = f"{op} is not available for the read-only Samples area."
    else:
        message = "You do not have permission to perform this operation."
    return error_response(
        message=message,
        code=403,
        request_id=request_id or "",
        data={
            "error_code": code,
            "access_mode": mode,
            "operation": op,
        },
    )


def exception_response(
        error: Exception,
        request_id: Optional[str] = None
) -> Response:
    """Handle exceptions and convert to response
    """
    if isinstance(error, AppError):
        return AppResponse(
            code=error.status_code,
            message=error.message,
            data={
                "error_code": str(getattr(error, "error_code", "") or "APP_ERROR"),
                **(getattr(error, "data", None) or {}),
            },
            request_id=request_id or "",
        ).to_response()
    return AppResponse(
        code=AppErrors.SERVER_INTERNAL_ERROR().status_code,
        message="Internal server error occurred.",
        data={"error_code": "SERVER_INTERNAL_ERROR"},
        request_id=request_id or "",
    ).to_response()
