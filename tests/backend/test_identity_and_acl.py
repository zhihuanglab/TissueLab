"""Local identity provider and the path guards that keep running against it."""
import os

import pytest


def test_every_request_is_the_local_user(client, local_uid):
    r = client.post("/api/users/v1/me")
    assert r.status_code == 200
    body = r.json()
    assert body["user_id"] == local_uid
    assert body["is_anonymous"] is False
    assert body["plan"]["usage_count"] == 0
    assert body["subscription"]["in_subscription"] is False


def test_bearer_tokens_are_ignored_not_rejected(client, local_uid):
    r = client.post("/api/users/v1/me", headers={"Authorization": "Bearer whatever"})
    assert r.status_code == 200
    assert r.json()["user_id"] == local_uid


def test_auth_dependencies_resolve_local_principal():
    from app.core.auth import get_auth_user, get_optional_auth_user
    from app.core.identity import LOCAL_USER_ID
    from starlette.requests import Request

    scope = {"type": "http", "method": "GET", "path": "/api/x", "headers": []}
    request = Request(scope)
    assert get_auth_user(request).uid == LOCAL_USER_ID
    assert get_optional_auth_user(request).uid == LOCAL_USER_ID
    assert get_auth_user(request).is_anonymous is False


@pytest.mark.asyncio
async def test_websocket_identity():
    from app.core.identity import LOCAL_USER_ID
    from app.middlewares.websocket_auth_middleware import authenticate_websocket, websocket_auth_required

    class _WS:
        query_params = {}
        headers = {}

    assert (await authenticate_websocket(_WS())).uid == LOCAL_USER_ID
    assert (await websocket_auth_required(_WS())).uid == LOCAL_USER_ID


def test_read_acl_own_tree_samples_and_other_users(app, user_root, samples_root, local_uid):
    from app.config.path_config import authorize_storage_read_path

    own = user_root / "slide.svs"
    own.write_bytes(b"x")
    assert authorize_storage_read_path(f"users/{local_uid}/slide.svs", local_uid) == str(own.resolve()) or \
        os.path.normcase(authorize_storage_read_path(f"users/{local_uid}/slide.svs", local_uid)) == os.path.normcase(str(own))

    sample = samples_root / "acl-sample.svs"
    sample.write_bytes(b"x")
    assert authorize_storage_read_path("samples/acl-sample.svs", local_uid)

    with pytest.raises(PermissionError):
        authorize_storage_read_path("users/someone-else/slide.svs", local_uid)


def test_read_acl_blocks_traversal(app, user_root, local_uid):
    from app.config.path_config import authorize_storage_read_path

    with pytest.raises(PermissionError):
        authorize_storage_read_path(f"users/{local_uid}/../someone-else/slide.svs", local_uid)
    with pytest.raises(PermissionError):
        authorize_storage_read_path(f"users/{local_uid}/%2e%2e/someone-else/slide.svs", local_uid)


def test_absolute_desktop_paths_are_allowed(app, tmp_path, local_uid):
    """The local user's own filesystem is theirs, existing or not.

    The "not yet" half is the load-bearing one: every output path is a path
    that does not exist at the moment it is authorized.
    """
    from app.config.path_config import authorize_storage_read_path

    slide = tmp_path / "desktop.svs"
    slide.write_bytes(b"x")
    assert authorize_storage_read_path(str(slide), local_uid)
    assert authorize_storage_read_path(str(tmp_path / "missing.svs"), local_uid)


def test_samples_are_read_only_and_shares_do_not_exist(app, local_uid):
    from app.config.path_config import get_path_share_mode, get_restricted_access_mode

    assert get_restricted_access_mode("samples/CMU-1.svs", local_uid) == "samples"
    assert get_restricted_access_mode(f"users/{local_uid}/x.svs", local_uid) is None
    assert get_path_share_mode(f"users/{local_uid}/x.svs", local_uid) is None


def test_write_guard_denies_samples_with_ctrl_aligned_code(app, samples_root, local_uid):
    import json

    from app.core.access import guard_write_path
    from starlette.requests import Request

    (samples_root / "ro.svs").write_bytes(b"x")
    scope = {"type": "http", "method": "POST", "path": "/api/x", "headers": []}
    request = Request(scope)
    request.state.user = {"uid": local_uid}
    abs_path, denied = guard_write_path(request, "samples/ro.svs", "annotate")
    assert abs_path is None and denied is not None
    payload = json.loads(denied.body)
    assert payload["code"] == 403
    assert payload["data"]["error_code"] == "PUBLIC_READ_ONLY_FORBIDDEN"
    assert payload["data"]["access_mode"] == "samples"


def test_write_guard_allows_own_files(app, user_root, local_uid):
    from app.core.access import guard_write_path
    from starlette.requests import Request

    (user_root / "mine.svs").write_bytes(b"x")
    scope = {"type": "http", "method": "POST", "path": "/api/x", "headers": []}
    request = Request(scope)
    request.state.user = {"uid": local_uid}
    abs_path, denied = guard_write_path(request, f"users/{local_uid}/mine.svs", "annotate")
    assert denied is None and abs_path


def test_no_cloud_modules_are_importable_from_the_service():
    """The open edition must not depend on the cloud SDKs."""
    import pkgutil
    import app as app_pkg

    offenders = []
    for mod in pkgutil.walk_packages(app_pkg.__path__, "app."):
        path = os.path.join(os.path.dirname(app_pkg.__file__), *mod.name.split(".")[1:])
        candidates = [path + ".py", os.path.join(path, "__init__.py")]
        for candidate in candidates:
            if os.path.isfile(candidate):
                with open(candidate, encoding="utf-8") as fh:
                    src = fh.read()
                for needle in ("import firebase_admin", "from firebase_admin", "from google.cloud", "import google.cloud"):
                    if needle in src:
                        offenders.append((mod.name, needle))
    assert offenders == []


def test_firebase_shaped_tokens_from_the_original_renderer_are_ignored(client, local_uid):
    """The renderer keeps its original Firebase auth (anonymous by default) and
    sends that ID token to every endpoint; the local service must treat it
    like no token at all rather than trying to verify it."""
    import base64
    import json
    header = base64.urlsafe_b64encode(json.dumps({"alg": "RS256", "kid": "x"}).encode()).rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(json.dumps({
        "iss": "https://securetoken.google.com/tissuelab-2025", "aud": "tissuelab-2025",
        "sub": "qRHachjVIhQIfQh6t3x1bX71BPh1", "provider_id": "anonymous", "exp": 4102444800,
    }).encode()).rstrip(b"=").decode()
    jwt = f"{header}.{payload}.c2ln"
    for path in ("/api/users/v1/me", "/api/fm/v1/config"):
        r = client.get(path, headers={"Authorization": f"Bearer {jwt}"}) if path.endswith("config") else client.post(path, headers={"Authorization": f"Bearer {jwt}"})
        assert r.status_code == 200, (path, r.text[:200])
        body = r.json()
        assert body.get("code", 0) == 0, (path, body)
    me = client.post("/api/users/v1/me", headers={"Authorization": f"Bearer {jwt}"}).json()
    assert me["user_id"] == local_uid
