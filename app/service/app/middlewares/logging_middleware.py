from fastapi import Request
import time
from app.core.logger import logger


async def logging_middleware(request: Request, call_next):
    start = time.time()

    response = await call_next(request)

    duration = int((time.time() - start) * 1000)
    method = request.method
    url = request.url.path
    status_code = response.status_code

    logger.info(f"{method} {url} - {status_code} - {duration}ms")

    return response
