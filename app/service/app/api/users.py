"""Local user routes (profile + avatar).

Only the routes the renderer needs for the single local principal. There is no
sign-in, invite, follow graph or e-mail flow in the open edition.
"""
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from app.core.auth import AuthUser, get_auth_user
from app.core.errors import AppErrors
from app.services import users as users_service

users_router = APIRouter()

_MAX_AVATAR_BYTES = 5 * 1024 * 1024


class UpdateProfileRequest(BaseModel):
    preferred_name: Optional[str] = None
    custom_title: Optional[str] = None
    organization: Optional[str] = None
    avatar_url: Optional[str] = None


def _avatar_url(request: Request, uid: str) -> Optional[str]:
    path = users_service.avatar_path(uid)
    if not path:
        return None
    version = int(os.path.getmtime(path))
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/users/{uid}/avatar?v={version}"


@users_router.post("/v1/ping")
def ping():
    return {"now_ts": int(datetime.now(timezone.utc).timestamp())}


@users_router.post("/v1/me")
def me(request: Request, auth_user: AuthUser = Depends(get_auth_user)):
    return users_service.me_response(auth_user, _avatar_url(request, auth_user.uid))


@users_router.post("/v1/init_me")
def init_me(auth_user: AuthUser = Depends(get_auth_user)):
    users_service.ensure_profile(auth_user.uid)
    return {"success": True, "user_id": auth_user.uid}


@users_router.post("/v1/update_profile")
def update_profile(body: UpdateProfileRequest, auth_user: AuthUser = Depends(get_auth_user)):
    users_service.update_profile(
        auth_user.uid,
        preferred_name=body.preferred_name,
        custom_title=body.custom_title,
        organization=body.organization,
    )
    return {"success": True, "message": "Profile updated successfully"}


def _assert_own(user_id: str, auth_user: AuthUser) -> None:
    if user_id != auth_user.uid:
        raise AppErrors.USER_FORBIDDEN()


@users_router.get("/{user_id}/avatar")
def get_avatar(user_id: str, auth_user: AuthUser = Depends(get_auth_user)):
    _assert_own(user_id, auth_user)
    path = users_service.avatar_path(user_id)
    if not path:
        raise AppErrors.RESOURCE_NOT_FOUND("No avatar set")
    return FileResponse(path, headers={"Cache-Control": "no-cache"})


@users_router.post("/{user_id}/avatar")
async def upload_avatar(
    user_id: str,
    request: Request,
    file: UploadFile = File(...),
    auth_user: AuthUser = Depends(get_auth_user),
):
    _assert_own(user_id, auth_user)
    content = await file.read()
    if not content:
        raise AppErrors.INPUT_FILE_NOT_FOUND()
    if len(content) > _MAX_AVATAR_BYTES:
        raise AppErrors.PARAMS_ERROR("Avatar must be 5 MB or smaller")
    try:
        users_service.save_avatar(user_id, file.filename or "", content)
    except ValueError as e:
        raise AppErrors.PARAMS_ERROR(str(e))
    return JSONResponse(content={"success": True, "avatar_url": _avatar_url(request, user_id)})


@users_router.delete("/{user_id}/avatar")
def delete_avatar(user_id: str, auth_user: AuthUser = Depends(get_auth_user)):
    _assert_own(user_id, auth_user)
    removed = users_service.delete_avatar(user_id)
    return {"success": True, "removed": removed}
