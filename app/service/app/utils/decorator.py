from typing import Type, Tuple, TypeVar, Callable, Any, Optional
import functools
import asyncio

from app.core.errors import AppErrors

T = TypeVar('T')


def async_retry(
        retries: int = 3,
        delay: float = 2.0,
        exceptions: Tuple[Type[Exception], ...] = (Exception,),
        logger: Any = None,
) -> Callable[[Callable[..., T]], Callable[..., T]]:
    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> T:
            attempt = 0
            last_exception: Optional[Exception] = None

            while attempt < retries:
                try:
                    return await func(*args, **kwargs)
                except exceptions as e:
                    last_exception = e
                    if logger:
                        logger.error(f"Attempt {attempt + 1} failed: {str(e)}")
                    if attempt < retries - 1:
                        if logger:
                            logger.info(f"Retrying in {delay} seconds...")
                        await asyncio.sleep(delay)
                attempt += 1

            if last_exception:
                raise AppErrors.SERVER_INTERNAL_ERROR(f'{str(last_exception)}')

        return wrapper

    return decorator