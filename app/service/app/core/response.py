import json
from typing import Any, Optional
import numpy as np

from fastapi import Response

from app.core.errors import AppErrors, AppError

class NumpyEncoder(json.JSONEncoder):
    """Custom JSON encoder for numpy types"""
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        elif isinstance(obj, np.floating):
            return float(obj)
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)


class AppResponse:
    def __init__(
            self,
            code: int = 0,
            message: str = "success",
            data: Any = None,
            request_id: Optional[str] = None
    ):
        self.code = code
        self.message = message
        self.data = data if data is not None else {}
        self.request_id = request_id

    def to_response(self) -> Response:
        """Convert to FastAPI Response"""
        response_data = {
            "code": self.code,
            "message": self.message,
        }

        if self.data is not None:
            response_data["data"] = self.data
        if self.request_id is not None:
            response_data["request_id"] = self.request_id

        return Response(
            content=json.dumps(response_data, cls=NumpyEncoder),
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
        request_id: Optional[str] = None
) -> Response:
    return AppResponse(
        code=code,
        message=message,
        request_id=request_id
    ).to_response()


def exception_response(
        error: Exception,
        request_id: Optional[str] = None
) -> Response:
    """Handle exceptions and convert to response
    """
    if isinstance(error, AppError):
        # Handle AppError
        return AppResponse(
            code=error.status_code,
            message=error.message,
            request_id=request_id
        ).to_response()
    else:
        # Handle regular Exception
        return AppResponse(
            code=AppErrors.SERVER_INTERNAL_ERROR().status_code,
            message=str(error),
            request_id=request_id
        ).to_response()
