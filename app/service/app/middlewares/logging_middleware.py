import json
import os
import re
import time
import uuid

from fastapi import Request

from app.core.identity import LOCAL_USER_ID
from app.core.logger import logger, rid_var, uid_var
from app.core.request_context import req_var

# Body logging knobs.
_LOG_BODIES = os.getenv("LOG_BODIES", "1") != "0"
_BODY_MAX = int(os.getenv("LOG_BODY_MAX", "2048"))       # max chars written per body
_READ_MAX = int(os.getenv("LOG_BODY_READ_MAX", "100000"))  # don't even read bodies bigger than this
# JSON fields whose values never reach the log (API keys in Preferences, tokens...).
_SECRET_NAME = re.compile(r"key|token|secret|password", re.IGNORECASE)


def _redact(obj):
    if isinstance(obj, dict):
        return {
            k: "***" if isinstance(v, str) and v and _SECRET_NAME.search(str(k)) else _redact(v)
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [_redact(v) for v in obj]
    return obj


def _truncate(s: str) -> str:
    s = " ".join(s.split())  # collapse newlines/whitespace so a body stays one line
    if len(s) > _BODY_MAX:
        return s[:_BODY_MAX] + f"...(+{len(s) - _BODY_MAX}B)"
    return s


async def _req_body_for_log(request: Request) -> str:
    """Return a one-line, truncated request body for logging. Only JSON bodies
    are logged; multipart/binary (file uploads) and oversized bodies are skipped
    so we never dump file contents or blow up the log."""
    if not _LOG_BODIES:
        return ""
    ctype = request.headers.get("content-type", "")
    if "application/json" not in ctype:
        return ""  # skip multipart/form/octet-stream uploads and non-JSON
    clen = request.headers.get("content-length", "")
    if clen.isdigit() and int(clen) > _READ_MAX:
        return f"<{clen}B body omitted>"
    try:
        raw = await request.body()  # cached by Starlette; downstream can still read it
    except Exception:
        return ""
    if not raw:
        return ""
    text = raw.decode("utf-8", "replace")
    if _SECRET_NAME.search(text):  # cheap pre-check: parse only bodies that may hold a secret
        try:
            text = json.dumps(_redact(json.loads(text)), ensure_ascii=False)
        except (ValueError, RecursionError):
            return "<unparsable JSON body omitted>"
    return _truncate(text)


async def logging_middleware(request: Request, call_next):
    rid = (request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12])[:32]
    uid = LOCAL_USER_ID
    rid_token = rid_var.set(rid)
    uid_token = uid_var.set(uid)
    req_token = req_var.set({
        "path": request.url.path,
        "method": request.method,
        "ip": request.client.host if request.client else None,
    })
    req_body = await _req_body_for_log(request)
    if req_body:
        logger.info(f"req {request.method} {request.url.path} {req_body}")
    start = time.time()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        response.headers["X-Request-ID"] = rid
        return response
    finally:
        duration = int((time.time() - start) * 1000)
        logger.info(f"{request.method} {request.url.path} - {status_code} - {duration}ms")
        rid_var.reset(rid_token)
        uid_var.reset(uid_token)
        req_var.reset(req_token)
