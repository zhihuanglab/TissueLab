import json
from typing import Any

from starlette.exceptions import HTTPException as StarletteHTTPException

from fastapi import Request
from fastapi.responses import JSONResponse

from app.core.errors import AppError, AppErrors
from app.core.logger import logger
from app.core.response import error_response


def _detail_to_message(detail: Any) -> str:
    """Normalize HTTPException.detail to a single string for AppResponse.message."""
    if detail is None:
        return "Unknown error"
    if isinstance(detail, str):
        return detail
    try:
        return json.dumps(detail, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(detail)


async def error_handler(request: Request, exc: Exception):
    path = request.url.path
    is_api = path.startswith("/api")

    if not is_api and isinstance(exc, StarletteHTTPException) and getattr(exc, "status_code", None) == 404:
        return JSONResponse(
            status_code=404,
            content={"detail": "Not Found"},
        )

    if isinstance(exc, AppError):
        logger.error(f"Caught AppError: {exc.error_code} - {exc.message}")
        if is_api:
            return error_response(message=exc.message, code=exc.status_code)
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": exc.error_code,
                    "message": exc.message,
                },
            },
        )

    if isinstance(exc, StarletteHTTPException):
        logger.error(f"Caught HTTPException: {exc.status_code} - {exc.detail}")
        if is_api:
            return error_response(
                message=_detail_to_message(exc.detail),
                code=exc.status_code,
            )
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
        )

    logger.error(f"Caught unknown error: {exc}")
    error = AppErrors.SERVER_INTERNAL_ERROR()
    if is_api:
        return error_response(message=error.message, code=error.status_code)
    return JSONResponse(
        status_code=error.status_code,
        content={
            "error": {
                "code": error.error_code,
                "message": error.message,
            },
        },
    )
