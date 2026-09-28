"""Every third-party import in the service is declared in requirements-*.txt.

Guards against the class of packaging failure where the dev environment
happens to have a package installed that the clean packaging environment (and
a user's fresh install) does not.
"""
import ast
import importlib.metadata as md
import os
import re
import sys
from pathlib import Path

import pytest

SERVICE_DIR = Path(__file__).resolve().parents[2] / "app" / "service"

# Imports that are optional at runtime (guarded by try/except or platform checks).
OPTIONAL = {"resource", "docker", "pylibCZIrw", "pythoncom", "pywintypes", "win32api", "czifile", "isyntax", "pyisyntax"}
# Module → distribution names that importlib.metadata cannot map (namespace / legacy layouts).
ALIASES = {"cv2": {"opencv-python", "opencv-python-headless"}, "PIL": {"pillow"}, "yaml": {"pyyaml"},
           "dotenv": {"python-dotenv"}, "multipart": {"python-multipart"}, "dateutil": {"python-dateutil"},
           "tissuelab_sdk": {"tissuelab-sdk", "tissuelab_sdk"}, "sklearn": {"scikit-learn"}}
# Source copied into the discovery worker's Docker sandbox and imported there,
# against the image's own packages (scikit-learn, …). The service process loads
# only its artifacts/stats/sea_ad_lfb modules; their imports (pandas, numpy,
# scipy, zarr, matplotlib) are declared, which test_discovery_host_imports checks.
SANDBOX_ONLY = SERVICE_DIR / "app" / "services" / "agent" / "discovery" / "shared_lib_source"
# Modules imported directly but installed as hard dependencies of a declared package.
TRANSITIVE = {"starlette": "fastapi", "anyio": "fastapi", "httpx": "openai", "numcodecs": "zarr",
              "cffi": "pyvips"}


def _third_party_imports():
    stdlib = set(sys.stdlib_module_names)
    found = {}
    for path in (SERVICE_DIR / "app").rglob("*.py"):
        if SANDBOX_ONLY in path.parents:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names = [node.module]
            for name in names:
                top = name.split(".")[0]
                if top in stdlib or top in ("app", "main"):
                    continue
                found.setdefault(top, set()).add(str(path.relative_to(SERVICE_DIR)))
    return found


def _declared():
    names = set()
    for req in SERVICE_DIR.glob("requirements-*.txt"):
        for line in req.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            names.add(re.split(r"[\[=<>;\s]", line)[0].lower().replace("_", "-"))
    return names


@pytest.mark.parametrize("requirements", sorted(p.name for p in SERVICE_DIR.glob("requirements-*.txt")))
def test_requirements_files_agree_on_core_packages(requirements):
    text = (SERVICE_DIR / requirements).read_text(encoding="utf-8")
    for pkg in ("fastapi", "uvicorn", "zarr", "tiffslide", "openai", "schedule", "filelock", "xgboost", "tissuelab_sdk"):
        assert re.search(rf"^{pkg}\b", text, re.M), f"{requirements} lacks {pkg}"
    assert "firebase" not in text and "google-cloud" not in text


def test_every_third_party_import_is_declared():
    declared = _declared()
    dist_of = md.packages_distributions()
    undeclared = {}
    for module, files in _third_party_imports().items():
        if module in OPTIONAL:
            continue
        if module in TRANSITIVE:
            assert TRANSITIVE[module] in declared, f"{module} relies on {TRANSITIVE[module]} being declared"
            continue
        dists = {d.lower().replace("_", "-") for d in dist_of.get(module, [])} | {a.lower() for a in ALIASES.get(module, set())}
        if not dists:
            dists = {module.lower().replace("_", "-")}
        if not dists & declared:
            undeclared[module] = sorted(files)[:3]
    assert undeclared == {}, f"imports without a requirements entry: {undeclared}"
