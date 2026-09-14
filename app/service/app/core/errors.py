from typing import Any, Callable, Dict, Optional
from fastapi import HTTPException


class AppError(HTTPException):
    """customize error types"""

    def __init__(
            self,
            status_code: int,
            error_code: str,
            message: str,
            data: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(status_code=status_code, detail=message)
        self.error_code = error_code
        self.message = message
        self.data = data or {}

    def __str__(self):
        return f"AppError(status_code={self.status_code}, error_code={self.error_code}, message={self.message})"

    def to_dict(self):
        return {
            "status_code": self.status_code,
            "error_code": self.error_code,
            "message": self.message,
            "data": self.data,
        }

def create_app_error(
        status_code: int,
        error_code: str,
        default_message: str
) -> Callable[[Optional[str]], AppError]:
    """Factory function to create an application error"""

    def error_factory(custom_message: Optional[str] = None) -> AppError:
        return AppError(
            status_code=status_code,
            error_code=error_code,
            message=custom_message or default_message
        )

    return error_factory


class AppErrors:
    """Application Error Collection"""
    # Authentication errors
    AUTH_TOKEN_NOT_FOUND = create_app_error(401, 'AUTH_TOKEN_NOT_FOUND', 'No authentication token provided.')
    AUTH_TOKEN_INVALID = create_app_error(401, 'AUTH_TOKEN_INVALID', 'Invalid or expired token.')

    # Input validation error
    INPUT_FILE_NOT_FOUND = create_app_error(400, 'INPUT_FILE_NOT_FOUND', 'No file uploaded.')

    # User-related errors
    USER_NOT_FOUND = create_app_error(404, 'USER_NOT_FOUND', 'The user was not found.')
    USER_FORBIDDEN = create_app_error(403, 'USER_FORBIDDEN', 'You do not have permission to perform this action.')

    # Resource errors
    RESOURCE_NOT_FOUND = create_app_error(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.')
    RESOURCE_CONFLICT = create_app_error(409, 'RESOURCE_CONFLICT', 'The resource already exists or conflicts with the current state.')

    # Business Logic Errors
    BUSINESS_QUOTA_EXCEEDED = create_app_error(429, 'BUSINESS_QUOTA_EXCEEDED', 'You have exceeded your quota.')
    STORAGE_QUOTA_EXCEEDED = create_app_error(429, 'STORAGE_QUOTA_EXCEEDED', 'You have exceeded your storage quota.')
    REQUEST_QUOTA_EXCEEDED = create_app_error(429, 'REQUEST_QUOTA_EXCEEDED', 'You have exceeded your request quota.')

    # Server error
    SERVER_INTERNAL_ERROR = create_app_error(500, 'SERVER_INTERNAL_ERROR', 'Internal server error occurred')
    NOT_IMPLEMENTED = create_app_error(501, 'NOT_IMPLEMENTED', 'This operation is not supported in the current configuration.')

    # 400: parameter problems are client errors. The file manager (ported from
    # the control plane) always used 400 and the frontend only shows the message.
    PARAMS_ERROR = create_app_error(400, 'PARAMS_ERROR', 'Parameters error occurred')
