"""Path conversion for scalar fields and per-class classifier maps."""

import json


PATH_FIELDS = {"zarr_path", "file_path", "path", "classifier_path", "save_classifier_path"}
CLASSIFIER_PATH_MAP_FIELDS = {"classifier_paths", "save_classifier_paths"}


def parse_classifier_paths(value):
    """{class_name: path} from a dict or its JSON string; None if neither."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return None
    return value if isinstance(value, dict) else None


def map_classifier_paths(value, convert):
    """Convert map values, preserving dict versus JSON-string representation."""
    paths = parse_classifier_paths(value)
    if paths is None:
        return value
    encoded = isinstance(value, str)
    converted = {
        name: convert(path) if isinstance(path, str) and path.strip() else path
        for name, path in paths.items()
    }
    return json.dumps(converted) if encoded else converted


def convert_paths_recursive(obj, convert):
    """Patch workflow paths in place without interpreting class names as keys."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in PATH_FIELDS and isinstance(value, str):
                obj[key] = convert(value)
            elif key in CLASSIFIER_PATH_MAP_FIELDS:
                obj[key] = map_classifier_paths(value, convert)
            else:
                convert_paths_recursive(value, convert)
    elif isinstance(obj, list):
        for value in obj:
            convert_paths_recursive(value, convert)
    return obj
