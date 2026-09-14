"""The whole path-gated HTTP surface, driven with a path on the local disk.

The open edition is one person on one machine (``docs/local-mode.md``). A slide
they opened from ``~/Downloads`` — and the ``.zarr`` sidecar beside it, whether
or not it exists yet — must never come back as a permission error from any
route. Business failures are fine and expected here: these fixtures are a
skeleton zarr, not a real analysis. Only a *denial* fails the test.

Two things keep this from passing vacuously:

* every guard is wrapped, so a request whose body was wrong (the guard never
  ran) fails as loudly as one that was denied;
* ``test_every_guarded_route_is_swept`` re-derives the gated surface from the
  source and fails when a new gated route is not listed below.
"""
import json
import os

import pytest

DENIAL_CODES = {
    "READ_ACCESS_DENIED",
    "PATH_ACCESS_DENIED",
    "PUBLIC_READ_ONLY_FORBIDDEN",
    "USER_OWNED_PATH_REQUIRED",
}

GUARD_NAMES = (
    "authorize_read_or_response",
    "authorize_read_or_response_async",
    "guard_write_path",
    "guard_write_path_async",
    "assert_user_owned_path_or_response",
    "assert_user_owned_path_or_response_async",
)

API_MODULES = ("data", "load", "seg", "tasks", "thumbnail", "review", "radiology")


# ---------------------------------------------------------------------------
# Fixtures: a slide and a zarr that live on the user's disk, outside storage
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def desktop(tmp_path_factory, storage_root):
    """A folder standing in for ``~/Downloads/SVS`` — nothing to do with storage."""
    import numpy as np
    import zarr

    root = tmp_path_factory.mktemp("desktop-downloads")
    assert not str(root).startswith(str(storage_root)), "must sit outside the storage root"

    # A real (tiny) pyramidal TIFF: the viewer must be able to open it, because
    # several routes run an instance-ownership check before the path guard and
    # would otherwise never reach the guard at all.
    import pyvips

    slide = root / "prostate.tiff"
    pyvips.Image.black(512, 512, bands=3).copy(interpretation="srgb").tiffsave(
        str(slide), tile=True, pyramid=True, compression="jpeg"
    )

    # The layout a task node produces, so the viewer can actually bind it.
    n = 32
    store = root / "prostate.tiff.zarr"
    grp = zarr.open_group(str(store), mode="w")
    grp.attrs["slide_path"] = str(slide)

    seg = grp.create_group("Cell-Segmentation")
    centroids = np.column_stack([
        np.linspace(20, 480, n, dtype="float32"),
        np.linspace(20, 480, n, dtype="float32"),
    ]).astype("float32")
    seg.create_array("centroids", shape=centroids.shape, dtype="float32")[:] = centroids
    angles = np.linspace(0, 2 * np.pi, 16, endpoint=False)
    contours = np.stack([
        centroids[:, 0, None] + 4 * np.cos(angles),
        centroids[:, 1, None] + 4 * np.sin(angles),
    ], axis=-1).astype("float32")
    seg.create_array("contours", shape=contours.shape, dtype="float32")[:] = contours

    cls = grp.create_group("Cell-Classification")
    cls.attrs["class_names"] = ["tumor", "other"]
    cls.attrs["class_colors"] = ["#ff0000", "#00ff00"]
    cls.create_array("class_indices", shape=(n,), dtype="int32")[:] = (np.arange(n) % 2).astype("int32")
    grp.create_group("User-Annotations")

    return {
        "dir": str(root),
        "slide": str(slide),
        "zarr": str(store),
        # The sidecar of a slide nobody has run yet: the original bug report.
        "missing_zarr": str(root / "not-run-yet.svs.zarr"),
    }


@pytest.fixture(scope="module")
def instance(client, desktop):
    """A viewer session bound to the local slide, as the app would have one."""
    body = client.post("/api/load/v1/create_instance", json={"file_path": desktop["slide"]}).json()
    assert body.get("code") == 0, body
    data = body["data"]
    inst = data.get("instance_id") or data.get("instanceId")
    assert inst, body
    bound = client.post(
        "/api/load/v1/upload_path",
        json={"file_path": desktop["slide"]},
        headers={"X-Instance-ID": inst},
    ).json()
    assert bound.get("code") == 0, bound

    # The segmentation websocket is a gated surface of its own, and it is what
    # creates the handler the /seg routes require. Binding a path on the local
    # disk over it is itself part of what this file claims works.
    with client.websocket_connect("/ws/segment/?token=local&device_id=t") as ws:
        ws.send_text(json.dumps(
            {"type": "set_path", "path": desktop["slide"], "instance_id": inst}
        ))
        for _ in range(5):
            message = ws.receive()
            if message.get("text"):
                ack = json.loads(message["text"])
                if ack.get("type") == "set_path":
                    assert ack.get("success") is not False, ack
                    break
        else:
            raise AssertionError("segmentation websocket never acked set_path")
    return inst


@pytest.fixture
def guard_log(monkeypatch):
    """Record every path each guard is asked about, per request."""
    import asyncio
    import importlib

    seen = []

    def wrap(fn):
        if asyncio.iscoroutinefunction(fn):
            async def awrapper(request, path, operation="read", *a, **kw):
                seen.append((fn.__name__, path, operation))
                return await fn(request, path, operation, *a, **kw)
            return awrapper

        def wrapper(request, path, operation="read", *a, **kw):
            seen.append((fn.__name__, path, operation))
            return fn(request, path, operation, *a, **kw)
        return wrapper

    for name in API_MODULES:
        mod = importlib.import_module(f"app.api.{name}")
        for guard in GUARD_NAMES:
            fn = getattr(mod, guard, None)
            if fn is not None:
                monkeypatch.setattr(mod, guard, wrap(fn))
    return seen


# ---------------------------------------------------------------------------
# The route table. ``Z`` zarr, ``S`` slide, ``M`` a sidecar that is not there.
# ---------------------------------------------------------------------------

def _routes(d):
    Z, S, M, D = d["zarr"], d["slide"], d["missing_zarr"], d["dir"]
    q = lambda p=Z: {"params": {"file_path": p}}

    return [
        # -- data: inspect ------------------------------------------------
        ("GET", "/api/data/v1/info", q()),
        ("GET", "/api/data/v1/structure", q()),
        ("GET", "/api/data/v1/structure", q(M)),
        ("GET", "/api/data/v1/contents", q()),
        ("GET", "/api/data/v1/analyze", q()),
        ("GET", "/api/data/v1/validate", q()),
        ("GET", "/api/data/v1/enhanced/analysis", q()),
        ("GET", "/api/data/v1/groups/Cell-Segmentation", q()),
        ("GET", "/api/data/v1/objects/Cell-Segmentation/attributes", q()),
        ("GET", "/api/data/v1/arrays/Cell-Segmentation%2Fcentroids", q()),
        ("GET", "/api/data/v1/search", {"params": {"file_path": Z, "query": "cent"}}),
        ("GET", "/api/data/v1/enhanced/search_arrays", {"params": {"file_path": Z, "query": "cent"}}),
        # -- data: extract / write ---------------------------------------
        ("GET", "/api/data/v1/arrays/Cell-Segmentation%2Fcentroids/data", q()),
        ("POST", "/api/data/v1/batch/array_info",
         {"params": {"file_path": Z},
          "json": {"array_paths": ["Cell-Segmentation/centroids"], "include_preview": True}}),
        ("PUT", "/api/data/v1/arrays/Cell-Segmentation%2Fclassification/annotations/1",
         {"params": {"file_path": Z}, "json": {"new_class_name": "Tumor"}}),
        ("DELETE", "/api/data/v1/arrays/Cell-Segmentation%2Fclassification/annotations/1", q()),
        ("POST", "/api/data/v1/export/structure",
         {"params": {"file_path": Z}, "json": {"export_path": os.path.join(D, "structure.json")}}),
        ("POST", "/api/data/v1/zarr/validate_replacement",
         {"json": {"candidate_path": os.path.join(D, "staged.zarr"), "target_slide_path": Z}}),
        # -- load ---------------------------------------------------------
        ("POST", "/api/load/v1/create_instance", {"json": {"file_path": S}}),
        ("GET", "/api/load/v1/slide/preview_by_path",
         {"params": {"file_path": S, "preview_type": "thumbnail", "size": 64, "request_id": "t"}}),
        ("POST", "/api/load/v1/upload_folder", {"json": {"folder_path": D}}),
        ("POST", "/api/load/v1/upload_path", {"json": {"file_path": S}}),
        # -- thumbnail ----------------------------------------------------
        ("GET", "/api/thumbnail/v1/overlay_available", {"params": {"file_path": Z}}),
        ("POST", "/api/thumbnail/v1/previews",
         {"json": {"file_path": S, "preview_type": "thumbnail", "size": 64, "request_id": "t"}}),
        ("POST", "/api/thumbnail/v1/batch/previews",
         {"json": {"requests": [{"file_path": S, "preview_type": "thumbnail",
                                 "size": 64, "request_id": "t"}]}}),
        # -- seg: routes that gate the session's slide, not an argument ----
        ("GET", "/api/seg/v1/annotations", {"params": {"offset": 0, "limit": 10}}),
        ("GET", "/api/seg/v1/annotations/user/list", {}),
        ("GET", "/api/seg/v1/patches", {"params": {"offset": 0, "limit": 10}}),
        ("GET", "/api/seg/v1/annotations/export/csv", {}),
        ("GET", "/api/seg/v1/annotations/export/geojson", {}),
        ("GET", "/api/seg/v1/annotations/export/user/csv", {}),
        ("GET", "/api/seg/v1/annotations/export/user/geojson", {}),
        ("GET", "/api/seg/v1/annotations/export/patch/csv", {}),
        ("GET", "/api/seg/v1/annotations/export/patch/geojson", {}),
        ("POST", "/api/seg/v1/export/classifications", {"json": {"format": "csv"}}),
        ("POST", "/api/seg/v1/export/patch_classification", {"json": {"format": "csv"}}),
        # -- seg: read ----------------------------------------------------
        ("GET", "/api/seg/v1/user_annotation_indices", q()),
        ("GET", "/api/seg/v1/query_patches",
         {"params": {"file_path": Z, "x1": 0, "y1": 0, "x2": 10, "y2": 10}}),
        ("GET", "/api/seg/v1/classifier_file/load", {"params": {"file_path": os.path.join(D, "c.tlcls")}}),
        ("POST", "/api/seg/v1/classifier_file/model_names", {"json": {"paths": [os.path.join(D, "c.tlcls")]}}),
        # -- seg: write ---------------------------------------------------
        ("POST", "/api/seg/v1/save_annotation/batch",
         {"json": {"path": Z, "instance_id": "none", "annotations": []}}),
        ("POST", "/api/seg/v1/clear_nuclei_annotations",
         {"json": {"path": Z, "x1": 0, "y1": 0, "x2": 1, "y2": 1}}),
        ("POST", "/api/seg/v1/clear_tissue_annotations",
         {"json": {"path": Z, "x1": 0, "y1": 0, "x2": 1, "y2": 1}}),
        ("POST", "/api/seg/v1/save_patch_annotations",
         {"json": {"path": Z, "patch_indices": [0], "annotator": "t"}}),
        ("POST", "/api/seg/v1/remove_patch_annotations", {"json": {"path": Z, "patch_indices": [0]}}),
        ("POST", "/api/seg/v1/update-class-color",
         {"json": {"file_path": Z, "class_name": "Tumor", "new_color": "#ff0000"}}),
        ("POST", "/api/seg/v1/update-patch-class-color",
         {"json": {"file_path": Z, "class_name": "Tumor", "new_color": "#ff0000"}}),
        ("POST", "/api/seg/v1/delete-class", {"json": {"file_path": Z, "class_name": "Tumor"}}),
        ("POST", "/api/seg/v1/classifier_file/save",
         {"json": {"dest_path": os.path.join(D, "saved.tlcls"), "empty_if_missing_source": True}}),
        # -- tasks --------------------------------------------------------
        ("POST", "/api/tasks/v1/workflow_stage_status",
         {"json": {"zarr_path": M, "steps": [{"model": "StarDist"}]}}),
        ("GET", "/api/tasks/v1/list_manual_annotations", {"params": {"path": Z}}),
        ("POST", "/api/tasks/v1/save_manual_annotation",
         {"json": {"path": Z, "annotation": {"id": "a", "points": [[0, 0]]}}}),
        ("POST", "/api/tasks/v1/delete_manual_annotation", {"json": {"path": Z, "annotation_id": "a"}}),
        ("GET", "/api/tasks/v1/recommend_viewport",
         {"params": {"file_path": Z, "target_class": 1, "selection_mode": "class"}}),
        ("POST", "/api/tasks/v1/get_zarr_structure", {"json": {"zarr_path": Z}}),
        ("POST", "/api/tasks/v1/get_h5_structure", {"json": {"h5_path": os.path.join(D, "x.h5")}}),
        ("POST", "/api/tasks/v1/generate_script", {"json": {"zarr_path": Z, "prompt": "count cells"}}),
        ("POST", "/api/tasks/v1/reset_classification", {"json": {"zarr_path": Z}}),
        ("POST", "/api/tasks/v1/reset_patch_classification", {"json": {"zarr_path": Z}}),
        ("POST", "/api/tasks/v1/reset_tissue_segmentation", {"json": {"zarr_path": Z}}),
        ("POST", "/api/tasks/v1/nuclei_classification/cell_review_tile",
         {"json": {"slide_id": S, "cell_id": 1}}),
        # -- review -------------------------------------------------------
        ("POST", "/api/review/v1/candidates/cell", {"json": {"slide_id": Z, "limit": 1}}),
        ("POST", "/api/review/v1/candidates/patch", {"json": {"slide_id": Z, "limit": 1}}),
        ("POST", "/api/review/v1/patch_tile", {"json": {"slide_id": Z, "patch_id": 0}}),
        # -- radiology ----------------------------------------------------
        ("GET", "/api/radiology/v1/find_mask", {"params": {"base_path": D}}),
        ("GET", "/api/radiology/v1/list_zarr_files", {"params": {"base_path": D}}),
        ("GET", "/api/radiology/v1/load_mask_data", {"params": {"zarr_file_path": Z}}),
        ("GET", "/api/radiology/v1/search_datasets",
         {"params": {"zarr_file_path": Z, "query": "x"}}),
        ("POST", "/api/radiology/v1/auto_find_and_load", {"json": {"base_path": D}}),
    ]


# Gated routes the sweep drives at the guard instead of over HTTP, and why.
NOT_SWEPT = {
    "POST /v1/start_workflow": "starts a real run; guard covered in test_acl_nonexistent_paths",
    "POST /v1/execute_script": "runs user code in the sandbox",
    "POST /v1/classification": "starts a real classifier run",
    "POST /v1/save_annotation": "background task writing a full annotation set",
    "POST /v1/save_patch": "background task writing a full patch set",
    "POST /v1/convert": "long h5→zarr conversion",
    "POST /convert-to-pyramidal-tiff": "long libvips conversion",
    "POST /v1/zarr/replace": "destructive: swaps a zarr store in place",
    "POST /v1/zarr/stage_candidate": "multipart upload staging",
    "POST /v1/s{session_id}/upload_path": "same guard as create_instance, session-scoped",
    "POST /v1/start_batch": "runs a real multi-slide queue; its per-item guard "
                            "(_patch_batch_items) is covered in test_acl_nonexistent_paths",
    "POST /v1/batch/append": "appends to that same running queue",
    "POST /v1/classifier_tasknode_save": "resolves a registered task node before the "
                                         "guard; needs a live node to reach it",
}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def _denial(response):
    """The denial in *response*, or None."""
    if response.status_code == 403:
        return f"HTTP 403 {response.text[:200]}"
    try:
        body = response.json()
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(body, dict):
        return None
    data = body.get("data")
    code = (data or {}).get("error_code") if isinstance(data, dict) else None
    if code in DENIAL_CODES or (body.get("code") == 403 and code):
        return f"{code}: {json.dumps(body)[:200]}"
    return None


def test_no_gated_route_denies_a_path_on_the_local_disk(client, desktop, instance, guard_log):
    denied, never_guarded = [], []

    for method, url, kw in _routes(desktop):
        before = len(guard_log)
        kw = {**kw, "headers": {"X-Instance-ID": instance}}
        response = client.request(method, url, **kw)

        problem = _denial(response)
        if problem:
            denied.append(f"{method} {url} -> {problem}")

        asked = [p for _, p, _ in guard_log[before:]]
        if not any(desktop["dir"] in str(p) for p in asked):
            never_guarded.append(
                f"{method} {url} -> guards saw {asked or 'nothing'} "
                f"(status {response.status_code})"
            )

    assert not denied, "permission denied on the local disk:\n  " + "\n  ".join(denied)
    assert not never_guarded, (
        "these requests never reached their guard, so they prove nothing — "
        "fix the payload:\n  " + "\n  ".join(never_guarded)
    )


def test_every_guarded_route_is_swept(desktop):
    """Re-derive the gated surface from the source; a new gated route lands here."""
    import ast
    import pathlib
    import re
    import urllib.parse

    from app.core import access

    # Path guards only: ``guard_instance_owner`` takes an instance id, not a path.
    guards = {
        name for name in dir(access)
        if name.startswith(("authorize_", "guard_", "assert_")) and "instance" not in name
    }
    api_dir = pathlib.Path(access.__file__).resolve().parents[1] / "api"

    def calls_in(node):
        for sub in ast.walk(node):
            call = sub.value if isinstance(sub, ast.Await) else sub
            if isinstance(call, ast.Call) and isinstance(call.func, ast.Name):
                yield call.func.id

    def route_of(node):
        for dec in node.decorator_list:
            if (isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute)
                    and dec.args and isinstance(dec.args[0], ast.Constant)):
                return f"{dec.func.attr.upper()} {dec.args[0].value}"
        return None

    gated = set()
    for file in sorted(api_dir.rglob("*.py")):
        tree = ast.parse(file.read_text())
        module_functions = [
            n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
        ]

        # A guard reached through a module-level helper counts. ``start_batch``
        # gates every item inside ``_patch_batch_items``; a scan reading only
        # route bodies called it ungated and demanded no coverage for it.
        gating = set()
        while True:
            found = {
                fn.name for fn in module_functions
                if fn.name not in gating and set(calls_in(fn)) & (guards | gating)
            }
            if not found:
                break
            gating |= found

        gated |= {
            route for fn in module_functions
            if (route := route_of(fn)) and set(calls_in(fn)) & (guards | gating)
        }

    assert len(gated) > 50, f"the scan stopped finding routes ({len(gated)}) — fix the scan"

    def swept_key(method, url):
        """The URL the table sends, as the router sees it: ``POST /v1/x``."""
        path = urllib.parse.unquote(url.split("?")[0])
        return f"{method} {re.sub(r'^/api/[a-z_]+', '', path).rstrip('/')}"

    def matcher(declared):
        """A declared route as a pattern: ``GET /v1/arrays/{p:path}/data``.

        ``{p:path}`` spans separators, any other parameter is one segment.
        """
        method, path = declared.split(" ", 1)
        pattern = "".join(
            ((".+" if ":path}" in part else "[^/]+") if part.startswith("{") else re.escape(part))
            for part in re.split(r"(\{[^}]+\})", path)
        )
        return re.compile(f"^{re.escape(method)} {pattern}/?$")

    swept = {swept_key(m, u) for m, u, _ in _routes(desktop)}
    missing = sorted(
        r for r in gated
        if r not in NOT_SWEPT and not any(matcher(r).match(s) for s in swept)
    )
    assert not missing, (
        "gated routes with no local-path coverage — add them to the table above, "
        "or to NOT_SWEPT with a reason:\n  " + "\n  ".join(missing)
    )


def test_the_presence_websocket_accepts_a_local_slide(client, desktop):
    """A denial here is a socket close, not a JSON body — invisible to the HTTP
    sweep above, though it gates the same ``authorize_storage_read_path``.

    The refusal half is not decoration. The endpoint used to skip its own
    ``close()`` (guarded on a state it never reached), so a rejected client
    waited forever — and an earlier version of this test inherited that: it
    *hung* instead of failing, which in CI is a timeout with no diagnosis. The
    alarm makes a hang fail like anything else.
    """
    import signal

    from starlette.websockets import WebSocketDisconnect

    def _connect(path):
        def blocked(signum, frame):
            raise TimeoutError(f"presence never answered for {path}")

        previous = signal.signal(signal.SIGALRM, blocked)
        signal.alarm(15)
        try:
            with client.websocket_connect(
                f"/ws/presence?token=local&device_id=t&file_path={path}"
            ) as ws:
                ws.close()
            return None
        except WebSocketDisconnect as exc:
            return exc.code
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)

    # The user's own slide, and the sidecar that is not written yet.
    assert _connect(desktop["slide"]) is None
    assert _connect(desktop["missing_zarr"]) is None

    # And a path that is still refused gets told so, promptly.
    assert _connect("users/someone-else/x.svs") == 1008
