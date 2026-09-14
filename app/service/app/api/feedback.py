import asyncio
from fastapi import APIRouter, Request, Query, Depends
from pydantic import BaseModel
from typing import List, Dict, Optional
from app.core.response import success_response, error_response
from app.services.feedback import get_feedback_service
from app.core.auth import get_optional_auth_user, AuthUser

feedback_router = APIRouter()


class NodeFeedback(BaseModel):
    model: str
    impl: str


class FeedbackRequest(BaseModel):
    nodes: List[NodeFeedback]
    rating: str  # "up" | "down"
    zarr_path: Optional[str] = None
    context: Optional[Dict] = None
    user_id: Optional[str] = None


def _resolve_user_id(explicit_user_id: Optional[str], auth_user: Optional[AuthUser], request: Request) -> Optional[str]:
    """Resolve the effective user id from the explicit field, the auth dependency, or the token."""
    state_user = getattr(request.state, "user", None)
    token_uid = state_user.get("uid") if isinstance(state_user, dict) else None
    return explicit_user_id or (auth_user.uid if auth_user else None) or token_uid


@feedback_router.post("/v1/rate")
async def rate_workflow(
    req: FeedbackRequest,
    request: Request,
    auth_user: Optional[AuthUser] = Depends(get_optional_auth_user),
):
    try:
        # Off the loop: this reads and rewrites two JSON documents while holding
        # the service lock, and the endpoint is a coroutine.
        result = await asyncio.to_thread(
            get_feedback_service().record_feedback,
            [n.dict() for n in req.nodes],
            req.rating,
            zarr_path=req.zarr_path,
            context=req.context,
            user_id=_resolve_user_id(req.user_id, auth_user, request),
        )
        if not result.get("success"):
            return error_response(result.get("error", "Failed to record feedback"))
        return success_response({"ok": True})
    except Exception as e:
        return error_response(str(e))


@feedback_router.get("/v1/preferences")
def get_preferences(
    request: Request,
    user_id: Optional[str] = Query(default=None),
    auth_user: Optional[AuthUser] = Depends(get_optional_auth_user),
):
    try:
        resolved_user_id = _resolve_user_id(user_id, auth_user, request)
        return success_response(get_feedback_service().get_preferences(resolved_user_id))
    except Exception as e:
        return error_response(str(e))
