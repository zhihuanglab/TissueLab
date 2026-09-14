"""Authorization must never depend on whether the target exists.

The regression this pins down: a workflow's ``<slide>.zarr`` sidecar does not
exist at the moment ``start_workflow`` authorizes it — creating it is the whole
point of the call. A guard that also demanded existence answered 403
READ_ACCESS_DENIED, so a slide opened from ``~/Downloads`` could never be run
on, and the viewer's status polls failed the same way with no path forward.

Every check here uses a path that is *not on disk*. A location-based guard says
yes; only an existence-coupled one says no. Keep new guards in this file.
"""
import os

import pytest
from starlette.requests import Request


def _request(uid: str) -> Request:
    """Minimal request carrying the principal the guards read."""
    return Request({
        "type": "http",
        "method": "POST",
        "path": "/api/test",
        "headers": [],
        "state": {"user": {"uid": uid}},
    })


def _missing(base, *parts) -> str:
    path = os.path.join(str(base), *parts)
    assert not os.path.exists(path), "the point of this test is a path that is not there"
    return path


# --------------------------------------------------------------------------
# Path ACL
# --------------------------------------------------------------------------

def test_desktop_output_paths_are_authorized_before_they_exist(app, tmp_path, local_uid):
    from app.config.path_config import authorize_storage_read_path

    # The incident, reduced: a slide the user opened from their own folder, and
    # the sidecar a workflow is about to write next to it.
    slide = tmp_path / "prostate.tiff"
    slide.write_bytes(b"x")
    assert authorize_storage_read_path(_missing(tmp_path, "prostate.tiff.zarr"), local_uid)
    # Nested output directories that the run creates on the way.
    assert authorize_storage_read_path(_missing(tmp_path, "new", "nested", "out.zarr"), local_uid)


def test_personal_output_paths_are_authorized_before_they_exist(app, user_root, local_uid):
    from app.config.path_config import authorize_storage_read_path

    _missing(user_root, "never-created.svs.zarr")
    assert authorize_storage_read_path(f"users/{local_uid}/never-created.svs.zarr", local_uid)


def test_missing_paths_do_not_widen_the_rules(app, storage_root, local_uid):
    """Absence is not a loophole either: the location rules still decide."""
    from app.config.path_config import authorize_storage_read_path

    with pytest.raises(PermissionError):
        authorize_storage_read_path("users/someone-else/never-created.zarr", local_uid)
    with pytest.raises(PermissionError):
        authorize_storage_read_path(f"users/{local_uid}/../someone-else/gone.zarr", local_uid)


def test_samples_stays_read_only_for_paths_that_do_not_exist(app, samples_root, local_uid):
    """The one thing the open edition does restrict is unaffected by the fix."""
    from app.core.access import guard_write_path
    from app.config.path_config import get_restricted_access_mode

    rel = "samples/never-created.svs.zarr"
    _missing(samples_root, "never-created.svs.zarr")
    assert get_restricted_access_mode(rel, local_uid) == "samples"
    _, denied = guard_write_path(_request(local_uid), rel, "run workflow")
    assert denied is not None


# --------------------------------------------------------------------------
# Route guards, at the call the handlers actually make
# --------------------------------------------------------------------------

def test_run_workflow_guard_allows_a_sidecar_that_is_not_there_yet(app, tmp_path, local_uid):
    """``start_workflow``'s own guard call — the one that returned 403."""
    from app.core.access import guard_write_path

    zarr_path = _missing(tmp_path, "prostate.tiff.zarr")
    resolved, denied = guard_write_path(_request(local_uid), zarr_path, "run workflow")
    assert denied is None
    assert resolved


@pytest.mark.parametrize("operation", ["read", "annotate", "export"])
def test_read_and_write_guards_agree_on_a_missing_desktop_path(app, tmp_path, local_uid, operation):
    from app.core.access import authorize_read_or_response, guard_write_path

    path = _missing(tmp_path, "out", f"{operation}.zarr")
    assert authorize_read_or_response(_request(local_uid), path, operation)[1] is None
    assert guard_write_path(_request(local_uid), path, operation)[1] is None


def test_file_manager_guard_agrees_with_the_path_acl(app, tmp_path, storage_root, local_uid):
    """The two guards gate the same paths; drift between them is a bug source."""
    from app.config.path_config import authorize_storage_read_path
    from app.services.file_manager.common import validate_user_access_to_path
    from app.core.identity import local_user

    for path in (
        _missing(tmp_path, "prostate.tiff.zarr"),
        str(tmp_path),
        str(storage_root / "users" / local_uid / "never-created.zarr"),
    ):
        try:
            authorize_storage_read_path(path, local_uid)
            acl_allows = True
        except PermissionError:
            acl_allows = False
        assert validate_user_access_to_path(local_user(), path) is acl_allows, path


# --------------------------------------------------------------------------
# Through the real routes: a missing sidecar is a 404-shaped answer, not a 403
# --------------------------------------------------------------------------

def _not_a_read_denial(body):
    data = body.get("data") or {}
    assert data.get("error_code") != "READ_ACCESS_DENIED", body
    return body


def test_viewer_polls_on_a_fresh_slide_are_not_permission_denials(client, tmp_path):
    """Every route the incident log showed failing, on a sidecar that is absent."""
    slide = tmp_path / "prostate.tiff"
    slide.write_bytes(b"x")
    zarr_path = _missing(tmp_path, "prostate.tiff.zarr")

    _not_a_read_denial(client.post(
        "/api/tasks/v1/workflow_stage_status",
        json={"zarr_path": zarr_path, "steps": [{"model": "StarDist"}]},
    ).json())

    _not_a_read_denial(client.get(
        "/api/data/v1/structure", params={"file_path": zarr_path}
    ).json())

    _not_a_read_denial(client.get(
        "/api/tasks/v1/list_manual_annotations", params={"path": zarr_path}
    ).json())

    _not_a_read_denial(client.get(
        "/api/seg/v1/user_annotation_indices", params={"file_path": zarr_path}
    ).json())


# --------------------------------------------------------------------------
# The net that keeps working after this file stops being read
#
# Enumerates the path guards in ``app/core/access.py`` instead of listing them,
# so a guard added later is covered the day it lands. A guard that genuinely
# must refuse a path outside the personal root has to say so here, with its
# reason, rather than quietly regrowing the existence check.
# --------------------------------------------------------------------------

def _path_guards():
    """Every ``(request, path, operation)`` guard the access layer exports."""
    import inspect

    from app.core import access

    for name, fn in vars(access).items():
        if name.startswith("_") or not inspect.isfunction(fn):
            continue
        if list(inspect.signature(fn).parameters)[:3] != ["request", "path", "operation"]:
            continue
        yield name.removesuffix("_async"), fn


@pytest.mark.asyncio
async def test_every_path_guard_allows_a_location_that_does_not_exist_yet(app, tmp_path, local_uid):
    import inspect

    checked = set()
    for base_name, fn in _path_guards():
        path = _missing(tmp_path, f"{fn.__name__}-out.zarr")
        result = fn(_request(local_uid), path, "run workflow")
        if inspect.isawaitable(result):
            result = await result
        resolved, denied = result
        assert denied is None, (
            f"{fn.__name__} denied a path only because it is not on disk. "
            "If a new guard must refuse one, the reason has to be something "
            "other than absence — say it here and skip it explicitly."
        )
        assert resolved
        checked.add(base_name)

    # The enumeration itself must keep finding things, or this test passes vacuously.
    assert {
        "authorize_read_or_response",
        "guard_write_path",
        "assert_user_owned_path_or_response",
    } <= checked, checked
