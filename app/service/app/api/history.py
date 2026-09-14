from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.auth import get_auth_user, AuthUser
from app.core.response import success_response, error_response
from app.services import history as history_service

history_router = APIRouter()


class SaveWorkflowHistoryRequest(BaseModel):
    id: Optional[str] = None          # if provided, upsert; otherwise create new
    name: Optional[str] = None
    zarr_path: str
    panels: List[Dict[str, Any]]
    output_path: str
    color: Optional[str] = None
    number: Optional[int] = None


@history_router.post("/v1/workflow_history")
def save_workflow_history(
    body: SaveWorkflowHistoryRequest,
    auth_user: AuthUser = Depends(get_auth_user),
):
    """Save or update a workflow history entry for the authenticated user."""
    try:
        entry_id = history_service.save_workflow_history(
            auth_user.uid,
            id=body.id,
            name=body.name,
            zarr_path=body.zarr_path,
            panels=body.panels,
            output_path=body.output_path,
            color=body.color,
            number=body.number,
        )
        return success_response({"id": entry_id})
    except Exception as e:
        return error_response(str(e))


@history_router.get("/v1/workflow_history")
def list_workflow_history(
    limit: int = 50,
    auth_user: AuthUser = Depends(get_auth_user),
):
    """List all workflow history entries for the authenticated user."""
    try:
        entries = history_service.list_workflow_history(auth_user.uid, limit=limit)
        return success_response({"entries": entries})
    except Exception as e:
        return error_response(str(e))


@history_router.get("/v1/workflow_history/{entry_id}")
def get_workflow_history_entry(
    entry_id: str,
    auth_user: AuthUser = Depends(get_auth_user),
):
    """Read a single workflow history entry."""
    try:
        entry = history_service.get_workflow_history_entry(auth_user.uid, entry_id)
        if entry is None:
            raise HTTPException(status_code=404, detail="Entry not found")
        return success_response(entry)
    except HTTPException:
        raise
    except Exception as e:
        return error_response(str(e))


@history_router.delete("/v1/workflow_history/{entry_id}")
def delete_workflow_history_entry(
    entry_id: str,
    auth_user: AuthUser = Depends(get_auth_user),
):
    """Delete a workflow history entry."""
    try:
        deleted = history_service.delete_workflow_history_entry(auth_user.uid, entry_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Entry not found")
        return success_response({"deleted": entry_id})
    except HTTPException:
        raise
    except Exception as e:
        return error_response(str(e))
