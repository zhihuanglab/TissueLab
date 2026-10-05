# main_windows.spec — PyInstaller spec for the TissueLab AI Service (Windows)
# -*- mode: python ; coding: utf-8 -*-
#
# Build:  pyinstaller main_windows.spec
# Output: dist/TissueLab_AI/  -> copy into app/electron/assets/TissueLab_AI/
#
# Keep this file in sync with main_macos.spec; the only intended differences
# are the Windows-only slide backends (pylibCZIrw, pythoncom) collected here.

from PyInstaller.utils.hooks import collect_all, collect_submodules
import imagecodecs

import os
import sys

datas = []
binaries = []
hiddenimports = []

# ---------------------------------------------------------------------------
# Runtime DLLs of a conda interpreter live in <env>/Library/bin. PyInstaller's
# dependency walk resolves DLL names through PATH, so on a machine where Git's
# mingw (or any other OpenSSL) comes first it bundles a *foreign*
# libcrypto/libssl — and the frozen service dies at import time with
# "DLL load failed while importing _ssl: The specified procedure could not be
# found". Naming the conda copies here makes them win over the scan.
# ---------------------------------------------------------------------------
_conda_bin = os.path.join(sys.prefix, "Library", "bin")


def _prefer_conda_dlls(toc):
    """Rewrite every bundled DLL that also exists in <env>/Library/bin to that copy."""
    if not os.path.isdir(_conda_bin):
        return toc
    fixed = []
    for name, src, kind in toc:
        base = os.path.basename(name)
        cand = os.path.join(_conda_bin, base)
        if (
            kind == "BINARY"
            and base.lower().endswith(".dll")
            and os.path.exists(cand)
            and os.path.normcase(os.path.abspath(src)) != os.path.normcase(cand)
        ):
            print(f"[spec] {base}: {src} -> {cand}")
            fixed.append((name, cand, kind))
        else:
            fixed.append((name, src, kind))
    return fixed

# ---------------------------------------------------------------------------
# imagecodecs ships one compiled extension per codec, all loaded dynamically.
# ---------------------------------------------------------------------------
ic_datas, ic_binaries, ic_hiddenimports = collect_all("imagecodecs")
datas.extend(ic_datas)
binaries.extend(ic_binaries)
hiddenimports.extend(ic_hiddenimports)
hiddenimports.extend(
    ["imagecodecs." + x for x in imagecodecs._extensions()]
    + ["imagecodecs._shared", "imagecodecs._imcd"]
)

# ---------------------------------------------------------------------------
# libvips. The service runs on the full "vips-dev-w64-all" build (OpenSlide,
# JPEG-2000, HEIF, JXL, Magick, Poppler loaders), not on the pyvips[binary]
# wheel. Ship its bin/ DLLs next to the executable's _internal/ and the
# loadable modules directory beside them, exactly the layout of the vips-dev bin directory.
# ---------------------------------------------------------------------------
import glob

import importlib.util

_libvips_spec = importlib.util.spec_from_file_location(
    "tl_libvips", os.path.join(SPECPATH, "app", "core", "libvips.py"))
_libvips = importlib.util.module_from_spec(_libvips_spec)
_libvips_spec.loader.exec_module(_libvips)
_vips_bin = _libvips.find_libvips_bin()
if not _vips_bin:
    raise SystemExit(
        "full libvips build not found: run `python scripts/fetch_libvips.py` "
        "(unpacks it under vendor/), or set TL_VIPS_DIR / put its bin on PATH."
    )
print(f"[spec] bundling libvips from {_vips_bin}")
# ... and make it importable in this process too: the collect_submodules() sweeps
# below import pyvips and every app.* module that uses it.
_libvips.configure()
for _dll in glob.glob(os.path.join(_vips_bin, "*.dll")):
    binaries.append((_dll, "."))
for _mod_dir in glob.glob(os.path.join(_vips_bin, "vips-modules-*")):
    for _mod in glob.glob(os.path.join(_mod_dir, "*.dll")):
        binaries.append((_mod, os.path.basename(_mod_dir)))

# ---------------------------------------------------------------------------
# Data files.
#
# Everything here is read at runtime via `Path(__file__).parent / ...`, which
# under PyInstaller resolves inside _internal/ — so it must be shipped or the
# corresponding feature dies with FileNotFoundError.
# ---------------------------------------------------------------------------
datas.extend([
    # Environment template. Never bundle .env.local — it may carry a live
    # OPENAI_API_KEY. The desktop app reads the user's own .env.local from
    # its service root (see docs/local-mode.md).
    (".env.example", "."),

    # Agent / coding-agent system prompts
    ("app/services/prompts/*.txt", "app/services/prompts/"),

    # Discovery system prompts, and the loader library each run copies into the
    # sandbox's /shared/lib as source (so it must exist as .py files)
    ("app/services/agent/discovery/prompts/*.md", "app/services/agent/discovery/prompts/"),
    ("app/services/agent/discovery/shared_lib_source/shared_analysis/*.py",
     "app/services/agent/discovery/shared_lib_source/shared_analysis/"),

    # Model registry. Ship only the registries — storage/ also holds logs/,
    # tasknode_logs/ and uploads/, which are dev artifacts (~4 MB) and must
    # not go into the bundle.
    # The live registry is created under TL_SERVICE_ROOT/storage at runtime;
    # only the preset ships with the binary.
    ("storage/model_registry_preset.json", "storage/"),

    ("TissueLab_logo.ico", "."),
])

# ---------------------------------------------------------------------------
# Packages whose submodules are resolved dynamically (plugin registries,
# compiled extensions, lazy backends) and therefore need a full sweep.
# ---------------------------------------------------------------------------
for pkg in [
    # --- imaging / arrays ---
    "PIL",
    "numpy",
    "zarr",
    "numcodecs",        # zarr codec plugins, registered dynamically
    "cv2",
    "scipy",            # app/services/seg.py
    "h5py",
    "tifffile",         # imported directly and via tiffslide
    "tiffslide",
    "fastslide",        # app/services/load.py (replaced pyisyntax in #940)
    "pyvips",
    "imagecodecs",

    # --- slide/volume backends reached through tissuelab_sdk.wrapper ---
    "tissuelab_sdk",
    "czifile",
    "nibabel",
    "pydicom",
    # Windows-only: pyproject marks pylibCZIrw as sys_platform == 'win32',
    # and tissuelab_sdk.wrapper imports pythoncom (pywin32) on this platform.
    "pylibCZIrw",
    "pythoncom",

    # --- web stack ---
    "uvicorn",
    "websockets",
    "aiohttp",
    "requests",

    # --- misc runtime ---
    "openai",
    "orjson",           # app/websocket/segmentation_consumer.py
    "filelock",         # zarr v3 write locking
    "zstandard",        # app/api/radiology.py
]:
    hiddenimports.extend(collect_submodules(pkg))

# ---------------------------------------------------------------------------
# Individually named modules. These are imported by string or from inside a
# function, so the analyzer cannot see them — but a full collect_submodules()
# sweep would drag in far more than we use (matplotlib in particular: only
# matplotlib.path is used, never pyplot or any GUI backend).
# ---------------------------------------------------------------------------
hiddenimports.extend([
    # uvicorn resolves its protocol/loop implementations at startup
    "uvicorn.logging",
    "uvicorn.protocols",
    "uvicorn.lifespan",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.loops",
    "uvicorn.loops.auto",

    # FastAPI / Starlette
    "fastapi.middleware.cors",
    "starlette.exceptions",
    "starlette.middleware",
    "starlette.middleware.cors",
    "starlette.middleware.base",
    "starlette.types",
    "starlette.datastructures",
    "pydantic_settings",
    "python_multipart",

    # geometry only — do NOT collect_submodules(matplotlib)
    "matplotlib",
    "matplotlib.path",

    # xgboost: lazy import in app/api/seg.py. A full sweep walks into
    # xgboost.testing, which imports pytest/joblib and aborts the build.
    # xgboost/__init__.py statically imports everything XGBClassifier needs.
    "xgboost",

    "dotenv",           # app/core/settings.py
    "psutil",           # process supervision
    "yaml",

    # First-party packages, swept so late/conditional imports survive
    *collect_submodules("app.api"),
    *collect_submodules("app.core"),
    *collect_submodules("app.config"),
    *collect_submodules("app.middlewares"),
    *collect_submodules("app.websocket"),
    *collect_submodules("app.services"),
    *collect_submodules("app.repos"),
    *collect_submodules("app.sdks"),
    *collect_submodules("app.utils"),
    *collect_submodules("app.wrapper"),
])

# Model inference never runs inside this service — every task node has its own
# conda environment — so the deep-learning / data-science stack must not end up
# in the bundle even when the build machine has it installed. Neither may the
# hosted platform's cloud stack: the open edition has no accounts, no database
# and no telemetry, so a build machine that also carries the control plane's
# dependencies must not leak firebase/google-cloud into the bundle. Build from a
# clean environment (requirements-packaging.txt); this list is the safety net.
INFERENCE_STACK_EXCLUDES = [
    "torch", "torchvision", "torchaudio", "transformers", "tokenizers", "safetensors",
    "huggingface_hub", "accelerate", "timm", "open_clip", "clip", "clip_interrogator",
    "tensorflow", "keras", "jax", "jaxlib", "numba",
    "llvmlite", "dask", "xarray", "csbdeep", "instanseg", "datasets", "einops", "fairscale",
    "shapely", "rasterio", "slideio", "s3fs", "IPython", "jupyter", "notebook", "pytest",
    # hosted-platform cloud stack — see tests/smoke/smoke_test.py, which fails the bundle on these.
    # NOT google_crc32c: despite the name it is a plain checksum library, and zarr's crc32c codec
    # imports it unconditionally.
    "google", "firebase_admin",
    # the cut-down libvips of the pyvips[binary] wheel must never shadow the full build
    "pyvips_binary", "_libvips",
]

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "_tkinter", "tcl", "tk", "Tkinter", "tzdata", "pytz"] + INFERENCE_STACK_EXCLUDES,
    noarchive=False,
)

# PyInstaller's matplotlib hook points MPLCONFIGDIR at a temporary directory it
# deletes at exit. The service only uses matplotlib.path, which never touches
# that directory - but task nodes inherit the variable, so every node's
# matplotlib would rebuild its font cache into the app's temp dir on each
# launch. Drop the hook; nothing else reads MPLCONFIGDIR.
a.scripts = [entry for entry in a.scripts if entry[0] != "pyi_rth_mplconfig"]
a.binaries = _prefer_conda_dlls(a.binaries)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="TissueLab_AI",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon="TissueLab_logo.ico",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="TissueLab_AI",
)
