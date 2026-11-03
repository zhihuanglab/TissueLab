"""Pre-run check that every classifier attached in One-vs-Rest mode is binary.

One-vs-Rest runs each attached .tlcls as "this class vs the rest". A multiclass
classifier attached to a class used to be skipped inside the tasknode with only
a log line, so the class silently fell back to zero-shot; the run is refused up
front instead, naming the classifiers to replace.
"""

import json
import os
import re

from app.utils.workflow.path_fields import parse_classifier_paths

OVR_NON_BINARY_ERROR_CODE = "ovr_non_binary_classifier"


# The model's own `num_class` (objective-derived, unlike the stamped class_names,
# which keep classes a multiclass head was not trained on) is one of the last
# keys of a UBJSON/JSON model, after the embedded training data and the trees:
# "num_class" + string marker/length + digits ("0" for binary:logistic).
_NUM_CLASS = re.compile(rb'num_class[^0-9]{1,12}?([0-9]+)')
_TAIL_BYTES = 4096


def _num_classes(path):
    """XGBoost `num_class` of the .tlcls at `path` (0 for a binary:logistic
    model, K for a K-class head); None when it can't be read (an
    empty placeholder, missing or unreadable file — the tasknode skips those)."""
    try:
        with open(path, "rb") as f:
            size = f.seek(0, os.SEEK_END)
            if not size:
                return None
            f.seek(max(0, size - _TAIL_BYTES))
            match = _NUM_CLASS.search(f.read())
    except OSError:
        return None
    if match:
        return int(match.group(1))
    # Legacy binary ("binf") models keep it elsewhere: load the whole model.
    try:
        import xgboost as xgb
        booster = xgb.Booster()  # XGBClassifier needs scikit-learn, which the service does not ship
        booster.load_model(path)
        learner = json.loads(booster.save_config())["learner"]
    except Exception:
        return None
    return int(learner["learner_model_param"].get("num_class", 0) or 0)


def non_binary_ovr_classifiers(payloads):
    """Every non-binary classifier attached to a One-vs-Rest step across
    `payloads` (start_workflow bodies with resolved paths), as
    [{"class_name", "path", "num_classes"}]; empty when all are binary."""
    problems = {}
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        for key, step in payload.items():
            inp = step.get("input") if key.startswith("step") and isinstance(step, dict) else None
            if not isinstance(inp, dict) or inp.get("classifier_mode") != "one-vs-rest":
                continue
            for cls, path in (parse_classifier_paths(inp.get("classifier_paths")) or {}).items():
                if cls.strip().lower() == "negative control" or not isinstance(path, str) or not path.strip():
                    continue
                n = _num_classes(path)
                if n is not None and n > 2:
                    problems[(cls, path)] = {"class_name": cls, "path": path, "num_classes": n}
    return list(problems.values())


def non_binary_ovr_message(problems):
    return (
        "One-vs-Rest needs a binary classifier for each class. Replace the multiclass classifier attached to: "
        + "; ".join(f'"{p["class_name"]}" ({os.path.basename(p["path"])}, {p["num_classes"]} classes)' for p in problems)
        + "."
    )
