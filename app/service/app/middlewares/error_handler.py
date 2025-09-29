from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi import HTTPException

from fastapi import Request
from fastapi.responses import JSONResponse

from app.core import settings
from app.core.errors import AppError, AppErrors
from app.core.logger import logger


async def error_handler(request: Request, exc: Exception):
    path = request.url.path

    if not path.startswith('/api') and isinstance(exc, StarletteHTTPException) and getattr(exc, 'status_code', None) == 404:
        return JSONResponse(
            status_code=404,
            content={"detail": "Not Found"}
        )

    if isinstance(exc, HTTPException):
        logger.error(f"Caught HTTPException: {exc.status_code} - {exc.detail}")
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail}
        )

    if isinstance(exc, AppError):
        logger.error(f"Caught AppError: {exc.error_code} - {exc.message}")

        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": exc.error_code,
                    "message": exc.message
                }
            }
        )
    else:
        logger.error(f'Caught unknown error: {exc}')
        error = AppErrors.SERVER_INTERNAL_ERROR()

        return JSONResponse(
            status_code=error.status_code,
            content={
                "error": {
                    "code": error.error_code,
                    "message": error.message
                }
            }
        )


