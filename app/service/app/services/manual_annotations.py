"""User-Annotations/manual.json — freeform Annotorious drawings.

On-disk format (v1)::

    {
      "format": "tissuelab.manual",
      "version": 1,
      "<id>": { "shape", "vertices", "style", ... },
      ...
    }
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any, Dict, List

from app.config.zarr_compat import open_zarr_cm, prepare_zarr_for_workflow
from app.config.zarr_config import ZarrGroups

logger = logging.getLogger(__name__)

_MANUAL_SHAPES = frozenset({"rectangle", "polygon", "line"})
_MANUAL_REL = os.path.join(ZarrGroups.USER_ANNOTATIONS, "manual.json")
_MANUAL_FORMAT = "tissuelab.manual"
_MANUAL_VERSION = 1
_RESERVED_KEYS = frozenset({"format", "version"})


def _normalize_zarr_path(zarr_path: str) -> str:
    """Normalize a sidecar path. Absolute paths skip app settings/STORAGE_ROOT."""
    if not zarr_path:
        raise ValueError("No Zarr path available")
    if os.path.isabs(zarr_path):
        return os.path.abspath(zarr_path)
    from app.utils import resolve_path

    return resolve_path(zarr_path)


def _manual_json_path(zarr_path: str) -> str:
    return os.path.join(zarr_path, _MANUAL_REL)


def _parse_manual_file(
    data: Any,
    *,
    preserve_unknown: bool = False,
) -> Dict[str, Any]:
    """Return id→record map from a loaded manual.json document.

    Raises ValueError when the document claims to be ours but is unusable —
    callers that write must not treat that as an empty file.

    When ``preserve_unknown`` is True (write path), entries that are not
    recognized shapes are kept as-is so a later rewrite cannot drop them.
    """
    if not isinstance(data, dict):
        raise ValueError("manual.json root must be an object")
    if data.get("format") != _MANUAL_FORMAT:
        raise ValueError(f"Unexpected format {data.get('format')!r}")
    version = data.get("version")
    if version != _MANUAL_VERSION:
        raise ValueError(f"Unsupported version {version!r}")
    out: Dict[str, Any] = {}
    for key, value in data.items():
        if key in _RESERVED_KEYS:
            continue
        if not isinstance(value, dict):
            raise ValueError(
                f"manual.json entry {key!r} must be an object; refusing load/rewrite"
            )
        shape = str(value.get("shape") or "").strip().lower()
        if shape not in _MANUAL_SHAPES:
            if preserve_unknown:
                out[str(key)] = value
            continue
        out[str(key)] = value
    return out


def _read_manual_dict(
    zarr_path: str,
    *,
    preserve_unknown: bool = False,
) -> Dict[str, Any]:
    """Load id→record map.

    Missing file → {}. Corrupt / unreadable file → raise (callers must not
    treat failure as empty). ``preserve_unknown`` keeps unrecognized shapes
    for save/delete rewrite safety; list/hydrate leave it False.
    """
    path = _manual_json_path(zarr_path)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return _parse_manual_file(data, preserve_unknown=preserve_unknown)
    except Exception as e:
        logger.error("[manual] Failed to read %s: %s", path, e)
        raise


# Collapse indent=2 number-pairs onto one line: [\n  1,\n  2\n] → [1, 2]
_XY_PAIR_RE = re.compile(
    r"\[\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*,\s*"
    r"(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*\]"
)


def _dumps_manual_json(doc: Dict[str, Any]) -> str:
    """Pretty-print manual.json with each vertex ``[x, y]`` on one line."""
    text = json.dumps(doc, ensure_ascii=False, indent=2)
    return _XY_PAIR_RE.sub(r"[\1, \2]", text)


def _write_manual_dict(zarr_path: str, records: Dict[str, Any]) -> None:
    ua_dir = os.path.join(zarr_path, ZarrGroups.USER_ANNOTATIONS)
    os.makedirs(ua_dir, exist_ok=True)
    path = _manual_json_path(zarr_path)
    doc: Dict[str, Any] = {
        "format": _MANUAL_FORMAT,
        "version": _MANUAL_VERSION,
    }
    for ann_id, rec in records.items():
        key = str(ann_id)
        if key in _RESERVED_KEYS:
            raise ValueError(f"Drawing id collides with reserved key: {key}")
        doc[key] = rec
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(_dumps_manual_json(doc))
        f.write("\n")
    os.replace(tmp, path)


def _ensure_manual_zarr(zarr_path: str) -> str:
    zarr_path = _normalize_zarr_path(zarr_path)
    if not os.path.exists(zarr_path):
        prepare_zarr_for_workflow(zarr_path)
    return zarr_path


def load_manual_annotations(zarr_path: str) -> List[Dict[str, Any]]:
    """Load freeform drawings from manual.json.

    Missing file / missing zarr → []. Corrupt file → raise.
    """
    zarr_path = _normalize_zarr_path(zarr_path) if zarr_path else zarr_path
    if not zarr_path or not os.path.exists(zarr_path):
        return []
    # List must not preserve unknown shapes (save/delete rewrite safety only).
    records = _read_manual_dict(zarr_path, preserve_unknown=False)

    out: List[Dict[str, Any]] = []
    for ann_id, rec in records.items():
        item = dict(rec)
        item["id"] = str(ann_id)
        out.append(item)
    return out


def save_manual_annotation(zarr_path: str, item: Dict[str, Any]) -> Dict[str, Any]:
    """Upsert one drawing into User-Annotations/manual.json by id."""
    try:
        ann_id = str(item.get("id") or "").strip()
        if not ann_id:
            return {"success": False, "error": "Missing annotation id"}
        if ann_id in _RESERVED_KEYS:
            return {"success": False, "error": f"Invalid annotation id: {ann_id}"}
        shape = str(item.get("shape") or "").strip().lower()
        if shape not in _MANUAL_SHAPES:
            return {"success": False, "error": f"Unsupported shape: {shape}"}
        vertices = item.get("vertices")
        if not isinstance(vertices, (list, tuple)) or len(vertices) < 2:
            return {"success": False, "error": "vertices must be a list of at least 2 points"}
        normalized_vertices = []
        for p in vertices:
            if not isinstance(p, (list, tuple)) or len(p) < 2:
                return {"success": False, "error": "Each vertex must be [x, y]"}
            normalized_vertices.append([float(p[0]), float(p[1])])

        zarr_path = _ensure_manual_zarr(zarr_path)
        record = {
            "shape": shape,
            "vertices": normalized_vertices,
            "style": str(item.get("style") or "#00ff00"),
            "comment": str(item.get("comment") or ""),
            "annotator": str(item.get("annotator") or "Unknown"),
            "datetime": int(item.get("datetime") or int(time.time() * 1000)),
        }
        with open_zarr_cm(zarr_path, "a") as zf:
            if ZarrGroups.USER_ANNOTATIONS not in zf:
                zf.create_group(ZarrGroups.USER_ANNOTATIONS)
            # Fail closed: corrupt existing file must not be replaced by one record.
            # Keep unrecognized sibling shapes so rewrite cannot drop them.
            records = _read_manual_dict(zarr_path, preserve_unknown=True)
            records[ann_id] = record
            _write_manual_dict(zarr_path, records)
        return {"success": True, "message": "Manual annotation saved", "id": ann_id}
    except TimeoutError as e:
        logger.error("[manual] FileLock timeout saving manual annotation: %s", e)
        return {"success": False, "error": "Zarr file is busy; try again shortly"}
    except Exception as e:
        logger.error("[manual] save_manual_annotation failed: %s", e, exc_info=True)
        return {"success": False, "error": str(e)}


def delete_manual_annotation(zarr_path: str, annotation_id: str) -> Dict[str, Any]:
    """Remove one drawing by id from manual.json. Missing id is success."""
    try:
        ann_id = str(annotation_id or "").strip()
        if not ann_id:
            return {"success": False, "error": "Missing annotation id"}
        zarr_path = _normalize_zarr_path(zarr_path) if zarr_path else zarr_path
        if not zarr_path or not os.path.exists(zarr_path):
            return {"success": True, "message": "Nothing to delete"}
        with open_zarr_cm(zarr_path, "a"):
            # Fail closed: do not rewrite an unreadable file as empty/partial.
            records = _read_manual_dict(zarr_path, preserve_unknown=True)
            if ann_id not in records:
                return {"success": True, "message": "Nothing to delete"}
            del records[ann_id]
            _write_manual_dict(zarr_path, records)
        return {"success": True, "message": "Manual annotation deleted", "id": ann_id}
    except TimeoutError as e:
        logger.error("[manual] FileLock timeout deleting manual annotation: %s", e)
        return {"success": False, "error": "Zarr file is busy; try again shortly"}
    except Exception as e:
        logger.error("[manual] delete_manual_annotation failed: %s", e, exc_info=True)
        return {"success": False, "error": str(e)}
