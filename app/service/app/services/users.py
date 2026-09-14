"""Local user profile.

The open edition has one principal. Its profile (display name, title,
organization, avatar) is a JSON document under ``storage/users/<uid>/`` and
the avatar image sits next to it. There is no account, plan or subscription;
the response shape mirrors the hosted ``/users/v1/me`` so the renderer keeps
working unchanged.
"""
import json
import os
import threading
import time
from typing import Any, Dict, Optional

from app.config.path_config import SERVICE_ROOT_DIR
from app.core.identity import AuthUser

_lock = threading.RLock()

_AVATAR_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
_PROFILE_FIELDS = ("preferred_name", "custom_title", "organization")


def _user_dir(uid: str) -> str:
    safe = "".join(ch for ch in uid if ch.isalnum() or ch in "-_.")
    if not safe:
        raise ValueError("invalid user id")
    path = os.path.join(SERVICE_ROOT_DIR, "storage", "users", safe)
    os.makedirs(path, exist_ok=True)
    return path


def _profile_path(uid: str) -> str:
    return os.path.join(_user_dir(uid), "profile.json")


def load_profile(uid: str) -> Dict[str, Any]:
    with _lock:
        path = _profile_path(uid)
        if not os.path.exists(path):
            return {}
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}


def save_profile(uid: str, data: Dict[str, Any]) -> None:
    with _lock:
        path = _profile_path(uid)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)


def ensure_profile(uid: str) -> Dict[str, Any]:
    """Create the profile on first use and return it."""
    profile = load_profile(uid)
    if not profile.get("registered_at"):
        profile["registered_at"] = int(time.time() * 1000)
        save_profile(uid, profile)
    return profile


def update_profile(uid: str, **fields: Optional[str]) -> Dict[str, Any]:
    profile = ensure_profile(uid)
    for key in _PROFILE_FIELDS:
        if key in fields and fields[key] is not None:
            profile[key] = fields[key]
    save_profile(uid, profile)
    return profile


def avatar_path(uid: str) -> Optional[str]:
    folder = _user_dir(uid)
    for ext in _AVATAR_EXTS:
        candidate = os.path.join(folder, f"avatar{ext}")
        if os.path.isfile(candidate):
            return candidate
    return None


def save_avatar(uid: str, filename: str, content: bytes) -> str:
    ext = os.path.splitext(filename or "")[1].lower()
    if ext == ".jpeg":
        ext = ".jpg"
    if ext not in _AVATAR_EXTS:
        raise ValueError("Unsupported avatar format; use PNG, JPG, WEBP or GIF")
    delete_avatar(uid)
    target = os.path.join(_user_dir(uid), f"avatar{ext}")
    with open(target, "wb") as fh:
        fh.write(content)
    return target


def delete_avatar(uid: str) -> bool:
    existing = avatar_path(uid)
    if not existing:
        return False
    os.remove(existing)
    return True


def me_response(user: AuthUser, avatar_url: Optional[str]) -> Dict[str, Any]:
    profile = ensure_profile(user.uid)
    return {
        "user_id": user.uid,
        "email": user.email,
        "is_anonymous": False,
        "hd_download_account": 0,
        "registered_at": int(profile.get("registered_at") or 0),
        "plan": {
            "total_limit": 0,
            "available_count": 0,
            "usage_count": 0,
            "lifetime_limit": 0,
            "expire_limit": None,
            "expire_at": None,
        },
        "subscription": {
            "in_subscription": False,
            "subscription_name": None,
            "start_at": None,
            "end_at": None,
        },
        "allow_email_notify": False,
        "ever_paid": False,
        "preferred_name": profile.get("preferred_name"),
        "custom_title": profile.get("custom_title"),
        "organization": profile.get("organization"),
        "avatar_url": avatar_url,
    }
