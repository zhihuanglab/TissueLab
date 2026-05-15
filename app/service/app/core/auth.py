"""Local single-user auth stub.

The desktop build runs the backend on the user's own machine, so token
verification is delegated to the remote ctrl service. Endpoints still receive
an ``AuthUser`` for downstream code that wants a uid for path isolation.
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class AuthUser:
    uid: str = "local"
    email: Optional[str] = "local@tissuelab"
    is_anonymous: bool = False
    provider_id: str = "local"


_LOCAL_USER = AuthUser()


def get_auth_user() -> AuthUser:
    return _LOCAL_USER


def get_optional_auth_user() -> Optional[AuthUser]:
    return _LOCAL_USER
