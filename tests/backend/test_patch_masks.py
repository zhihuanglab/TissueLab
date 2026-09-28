"""Patch classification -> Tissue-Segmentation masks (services/patch_masks.py).

Builds a store the way a patch-classification task node leaves it, derives
the per-class masks, and checks the pieces that consume them: the mask menu,
the viewport mask reader (grid <-> level-0 transform), idempotence, coexistence
with a VISTA mask, and the reset path.
"""
import numpy as np
import pytest
import zarr

PATCH = 224
GRID_H, GRID_W = 8, 10
CLASSES = ["Negative control", "Tumor", "Lymph node"]
COLORS = ["#cccccc", "#ff0000", "#0000ff"]


def _build_store(path, *, with_vista=True):
    """Patch grid GRID_H x GRID_W; row r / col c labelled by a fixed rule, one
    patch left unclassified (-1)."""
    root = zarr.open_group(str(path), mode="w")
    rows, cols = np.mgrid[0:GRID_H, 0:GRID_W]
    rows, cols = rows.ravel(), cols.ravel()
    coords = np.stack([cols * PATCH, rows * PATCH, (cols + 1) * PATCH, (rows + 1) * PATCH], axis=1).astype(np.int64)
    labels = np.zeros(len(rows), dtype=np.int32)
    labels[(rows == cols)] = 1                      # Tumor on the diagonal
    labels[(rows == 0) & (cols >= 5)] = 2           # Lymph node in the top-right
    labels[(rows == 7) & (cols == 9)] = -1          # unclassified
    pc = root.create_group("Patch-Classification")
    pc.create_array("coordinates", data=coords)
    pc.create_array("class_indices", data=labels)
    cls = pc.create_group("classes")
    cls.create_array("index", data=np.arange(3, dtype=np.int32))
    cls.create_array("name", data=np.array([n.encode() for n in CLASSES], dtype="S256"))
    cls.create_array("color", data=np.array([c.encode() for c in COLORS], dtype="S256"))
    pc.create_group("metadata").attrs.update({"patch_size": str(PATCH), "model": "MUSK-Classification"})
    if with_vista:
        ts = root.create_group("Tissue-Segmentation")
        masks = ts.create_group("masks")
        stroma = masks.create_group("Stroma")
        stroma.create_array("mask", data=np.ones((GRID_H * PATCH, GRID_W * PATCH), dtype=bool))
        tcls = ts.create_group("classes")
        tcls.create_array("name", data=np.array([b"Stroma"], dtype="S256"))
        tcls.create_array("color", data=np.array([b"#00ff00"], dtype="S256"))
    return labels


def _names(group):
    return [n.decode() if isinstance(n, bytes) else str(n) for n in group["classes"]["name"][:]]


@pytest.fixture
def store(tmp_path):
    p = tmp_path / "slide.svs.zarr"
    labels = _build_store(p)
    return p, labels


def test_masks_written_on_patch_grid_next_to_vista(store):
    from app.services.patch_masks import ensure_patch_masks, MASK_SOURCE

    path, labels = store
    res = ensure_patch_masks(str(path))
    assert res["status"] == "written"
    assert res["classes"] == CLASSES
    assert res["shape"] == [GRID_H, GRID_W] and res["scale"] == PATCH

    zf = zarr.open_group(str(path), mode="r")
    masks = zf["Tissue-Segmentation"]["masks"]
    assert set(masks.keys()) == {"Stroma", "Negative_control", "Tumor", "Lymph_node"}

    tumor = masks["Tumor"]
    assert tumor.attrs["source"] == MASK_SOURCE
    assert tumor.attrs["scale"] == PATCH and tumor.attrs["origin"] == [0, 0]
    assert tumor.attrs["class_name"] == "Tumor" and tumor.attrs["color"] == "#ff0000"
    m = tumor["mask"][:]
    assert m.shape == (GRID_H, GRID_W) and m.dtype == bool
    assert m.sum() == GRID_H and all(m[i, i] for i in range(GRID_H))

    ln = masks["Lymph_node"]["mask"][:]
    assert ln.sum() == 5 and ln[0, 5:].all()

    # Unclassified patch is in no mask; the three masks are disjoint.
    neg = masks["Negative_control"]["mask"][:]
    assert not (neg | m | ln)[7, 9]
    assert (neg.astype(int) + m + ln).max() == 1

    # VISTA's mask and class entry survive; ours are appended.
    assert "source" not in masks["Stroma"].attrs
    assert masks["Stroma"]["mask"].shape == (GRID_H * PATCH, GRID_W * PATCH)
    assert _names(zf["Tissue-Segmentation"]) == ["Stroma"] + CLASSES


def test_idempotent_until_labels_change(store):
    from app.services.patch_masks import ensure_patch_masks

    path, _ = store
    assert ensure_patch_masks(str(path))["status"] == "written"
    assert ensure_patch_masks(str(path))["status"] == "unchanged"

    zf = zarr.open_group(str(path), mode="a")
    ci = zf["Patch-Classification"]["class_indices"]
    ci[3] = 1  # row 0, col 3 becomes Tumor
    assert ensure_patch_masks(str(path))["status"] == "written"
    zf = zarr.open_group(str(path), mode="r")
    assert zf["Tissue-Segmentation"]["masks"]["Tumor"]["mask"][0, 3]
    # Re-derivation did not duplicate our class entries.
    assert _names(zf["Tissue-Segmentation"]) == ["Stroma"] + CLASSES


def _write_run(path, names, colors, labels):
    """Overwrite Patch-Classification the way a later classifier run does."""
    zf = zarr.open_group(str(path), mode="a")
    pc = zf["Patch-Classification"]
    pc["class_indices"][:] = labels.astype(np.int32)
    cls = pc["classes"]
    cls.create_array("index", data=np.arange(len(names), dtype=np.int32), overwrite=True)
    cls.create_array("name", data=np.array([n.encode() for n in names], dtype="S256"), overwrite=True)
    cls.create_array("color", data=np.array([c.encode() for c in colors], dtype="S256"), overwrite=True)
    pc["metadata"].attrs["classifier"] = names[-1].lower()


def test_masks_accumulate_across_classifier_runs(store):
    """Two independent binary classifiers run one after the other: the second
    run overwrites Patch-Classification, but the first run's masks stay, so
    both results (which may overlap) are available together."""
    from app.services.patch_masks import ensure_patch_masks

    path, labels = store
    # Run A: tumor classifier -> Negative control / Tumor
    run_a = np.where(labels == 1, 1, 0); run_a[labels == -1] = -1
    _write_run(path, ["Negative control", "Tumor"], ["#cccccc", "#ff0000"], run_a)
    res_a = ensure_patch_masks(str(path))
    assert res_a["status"] == "written" and res_a["classes"] == ["Negative control", "Tumor"]

    # Run B: epithelium classifier fires on tumour patches too (overlap)
    run_b = np.where((labels == 1) | (labels == 2), 1, 0); run_b[labels == -1] = -1
    _write_run(path, ["Negative control", "Epithelial"], ["#dddddd", "#0000ff"], run_b)
    res_b = ensure_patch_masks(str(path))
    assert res_b["status"] == "written" and res_b["classes"] == ["Negative control", "Epithelial"]
    assert res_b["all_classes"] == ["Negative control", "Tumor", "Epithelial"]

    zf = zarr.open_group(str(path), mode="r")
    ts = zf["Tissue-Segmentation"]
    masks = ts["masks"]
    assert set(masks.keys()) == {"Stroma", "Negative_control", "Tumor", "Epithelial"}
    tumor = masks["Tumor"]["mask"][:]
    epi = masks["Epithelial"]["mask"][:]
    assert tumor.sum() == GRID_H                      # run A's result survived run B
    assert (tumor & epi).sum() == GRID_H              # overlap is kept, not resolved
    assert epi.sum() == GRID_H + 5
    # Negative control came from run B (latest wins for a shared name)
    assert masks["Negative_control"]["mask"][:].sum() == (run_b == 0).sum()
    assert masks["Negative_control"].attrs["classifier"] == "epithelial"
    assert masks["Tumor"].attrs["classifier"] == "tumor"
    assert masks["Tumor"].attrs["run_digest"] != masks["Epithelial"].attrs["run_digest"]
    # classes/name: VISTA's entry, then run A's, then run B's new name; colour refreshed for the shared name
    assert _names(ts) == ["Stroma", "Negative control", "Tumor", "Epithelial"]
    colors = [c.decode() for c in ts["classes"]["color"][:]]
    assert colors == ["#00ff00", "#dddddd", "#ff0000", "#0000ff"]

    # Repeating run B is a no-op; re-running A again just refreshes Tumor
    assert ensure_patch_masks(str(path))["status"] == "unchanged"
    _write_run(path, ["Negative control", "Tumor"], ["#cccccc", "#ff0000"], run_a)
    assert ensure_patch_masks(str(path))["status"] == "written"
    assert set(zarr.open_group(str(path), mode="r")["Tissue-Segmentation"]["masks"].keys()) == {"Stroma", "Negative_control", "Tumor", "Epithelial"}


def test_clear_removes_masks_from_every_run(store):
    from app.config.zarr_compat import open_zarr_cm
    from app.services.patch_masks import clear_patch_masks, ensure_patch_masks

    path, labels = store
    ensure_patch_masks(str(path))
    run_b = np.where(labels == 2, 1, 0)
    _write_run(path, ["Other", "Lymph node"], ["#000000", "#0000ff"], run_b)
    ensure_patch_masks(str(path))
    with open_zarr_cm(str(path), "a") as zf:
        removed = clear_patch_masks(zf)
    assert len(removed) == 4  # run A: Negative control/Tumor/Lymph node, run B adds Other; Lymph node is shared
    zf = zarr.open_group(str(path), mode="r")
    assert list(zf["Tissue-Segmentation"]["masks"].keys()) == ["Stroma"]
    assert _names(zf["Tissue-Segmentation"]) == ["Stroma"]


def test_mask_menu_and_viewport_reader_use_level0_coordinates(store):
    from app.services.patch_masks import ensure_patch_masks
    from app.services.seg import get_segmentation_mask, list_mask_options

    path, _ = store
    ensure_patch_masks(str(path))

    opts = list_mask_options(str(path))
    assert opts["success"]
    by_key = {o["key"]: o["label"] for o in opts["options"]}
    assert by_key["Tumor"] == "Tumor"
    assert by_key["Lymph_node"] == "Lymph node"
    assert by_key["Stroma"] == "Stroma"

    # Viewport in level-0 pixels covering the top-left 2x2 patches.
    res = get_segmentation_mask(None, 0, 0, 2 * PATCH, 2 * PATCH, file_path=str(path), mask_key="Tumor")
    assert res["success"], res
    assert res["shape"] == [2, 2]
    data = np.frombuffer(res["data"], dtype=np.uint8).reshape(2, 2)
    assert data.tolist() == [[255, 0], [0, 255]]
    assert res["offset"] == [0, 0]
    assert res["region_size"] == [2 * PATCH, 2 * PATCH]
    assert res["full_shape"] == [GRID_H * PATCH, GRID_W * PATCH]
    assert res["class"] == "Tumor"

    # A viewport that starts mid-patch and runs past the grid: the padded
    # region reflects only the cells that exist, in level-0 units.
    res = get_segmentation_mask(None, 9 * PATCH + 10, 7 * PATCH + 10, 12 * PATCH, 9 * PATCH,
                                file_path=str(path), mask_key="Lymph_node")
    assert res["success"], res
    assert res["offset"] == [9 * PATCH + 10, 7 * PATCH + 10]
    assert res["region_size"][0] <= 1 * PATCH and res["region_size"][1] <= 1 * PATCH

    # VISTA's slide-resolution mask is unaffected by the transform.
    res = get_segmentation_mask(None, 0, 0, 4, 4, file_path=str(path), mask_key="Stroma")
    assert res["success"] and res["shape"] == [4, 4] and res["region_size"] == [4, 4]


def test_clear_removes_only_derived_masks(store):
    from app.config.zarr_compat import open_zarr_cm
    from app.services.patch_masks import clear_patch_masks, ensure_patch_masks

    path, _ = store
    ensure_patch_masks(str(path))
    with open_zarr_cm(str(path), "a") as zf:
        removed = clear_patch_masks(zf)
    assert sorted(removed) == sorted(
        f"Tissue-Segmentation/masks/{s}" for s in ("Negative_control", "Tumor", "Lymph_node"))
    zf = zarr.open_group(str(path), mode="r")
    assert list(zf["Tissue-Segmentation"]["masks"].keys()) == ["Stroma"]
    assert _names(zf["Tissue-Segmentation"]) == ["Stroma"]
    assert "patch_masks_digest" not in zf["Tissue-Segmentation"].attrs


def test_clear_drops_group_when_nothing_else_remains(tmp_path):
    from app.config.zarr_compat import open_zarr_cm
    from app.services.patch_masks import clear_patch_masks, ensure_patch_masks

    path = tmp_path / "solo.zarr"
    _build_store(path, with_vista=False)
    ensure_patch_masks(str(path))
    with open_zarr_cm(str(path), "a") as zf:
        clear_patch_masks(zf)
    assert "Tissue-Segmentation" not in zarr.open_group(str(path), mode="r")


def test_reset_patch_classification_clears_derived_masks(store):
    from app.services.patch_masks import ensure_patch_masks
    from app.services.tasks import reset_patch_classification_data

    path, _ = store
    ensure_patch_masks(str(path))
    out = reset_patch_classification_data(str(path))
    assert out["status"] == "success", out
    assert "Patch-Classification" in out["removed"]
    assert "Tissue-Segmentation/masks/Tumor" in out["removed"]
    zf = zarr.open_group(str(path), mode="r")
    assert "Patch-Classification" not in zf
    assert list(zf["Tissue-Segmentation"]["masks"].keys()) == ["Stroma"]


def test_skipped_without_classification(tmp_path):
    from app.services.patch_masks import ensure_patch_masks

    path = tmp_path / "empty.zarr"
    root = zarr.open_group(str(path), mode="w")
    root.create_group("Patch-Segmentation")
    res = ensure_patch_masks(str(path))
    assert res["status"] == "skipped"
    assert "Tissue-Segmentation" not in zarr.open_group(str(path), mode="r")


def test_grid_origin_for_bbox_runs(tmp_path):
    """A run restricted to a bbox starts its grid off the slide origin; the
    transform records that offset so level-0 mapping stays exact."""
    from app.services.patch_masks import ensure_patch_masks

    path = tmp_path / "bbox.zarr"
    root = zarr.open_group(str(path), mode="w")
    ox, oy = 1000, 500
    coords = np.array([[ox, oy, ox + PATCH, oy + PATCH],
                       [ox + PATCH, oy, ox + 2 * PATCH, oy + PATCH]], dtype=np.int64)
    pc = root.create_group("Patch-Classification")
    pc.create_array("coordinates", data=coords)
    pc.create_array("class_indices", data=np.array([1, 0], dtype=np.int32))
    pc.attrs["class_names"] = ["Other", "Tumor"]
    pc.attrs["class_colors"] = ["#000000", "#ff0000"]
    res = ensure_patch_masks(str(path))
    assert res["status"] == "written" and res["shape"] == [1, 2]
    grp = zarr.open_group(str(path), mode="r")["Tissue-Segmentation"]["masks"]["Tumor"]
    assert grp.attrs["origin"] == [ox, oy]
    assert grp["mask"][:].tolist() == [[True, False]]
