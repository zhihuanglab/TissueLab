from fastapi import APIRouter, Request, Query, Depends
from pydantic import BaseModel
from typing import List, Dict, Optional
from app.core.response import success_response, error_response
from app.services.feedback_service import get_feedback_service
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

@feedback_router.post("/v1/rate")
async def rate_workflow(
    req: FeedbackRequest,
    request: Request,
    auth_user: Optional[AuthUser] = Depends(get_optional_auth_user),
):
    try:
        svc = get_feedback_service()
        firebase_user = getattr(request.state, "user", None)
        token_uid = firebase_user.get("uid") if isinstance(firebase_user, dict) else None
        resolved_user_id = req.user_id or (auth_user.uid if auth_user else None) or token_uid
        result = svc.record_feedback(
            [n.dict() for n in req.nodes],
            req.rating,
            zarr_path=req.zarr_path,
            context=req.context,
            user_id=resolved_user_id,
        )
        if not result.get("success"):
            return error_response(result.get("error", "Failed to record feedback"))
        return success_response({"ok": True})
    except Exception as e:
        return error_response(str(e))


@feedback_router.get("/v1/preferences")
async def get_preferences(
    request: Request,
    user_id: Optional[str] = Query(default=None),
    auth_user: Optional[AuthUser] = Depends(get_optional_auth_user),
):
    try:
        svc = get_feedback_service()
        firebase_user = getattr(request.state, "user", None)
        token_uid = firebase_user.get("uid") if isinstance(firebase_user, dict) else None
        resolved_user_id = user_id or (auth_user.uid if auth_user else None) or token_uid
        return success_response(svc.get_preferences(resolved_user_id))
    except Exception as e:
        return error_response(str(e))
