# main_macos.spec — PyInstaller spec for the TissueLab AI Service (macOS / Linux)
# -*- mode: python ; coding: utf-8 -*-
#
# Build:  pyinstaller main_macos.spec
# Output: dist/TissueLab_AI/  -> copy into app/electron/assets/TissueLab_AI/
#
# Keep this file in sync with main_windows.spec; the only intended differences
# are the Windows-only slide backends (pylibCZIrw, pythoncom) collected there.

from PyInstaller.utils.hooks import collect_all, collect_submodules
import glob
import importlib.util
import os
import subprocess

import imagecodecs

datas = []
binaries = []
hiddenimports = []

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
# libvips. Same story as Windows: the libvips of the pyvips[binary] wheel has no
# OpenSlide / JPEG-2000 / HEIF / JXL loaders, so ship a full build - Homebrew's
# `brew install vips`, or any prefix in TL_VIPS_DIR (see app/core/libvips.py).
#
# Layout matters: libvips loads its modules from <VIPSHOME>/lib/vips-modules-x.y,
# so the modules go under _internal/lib/ and app/core/libvips.py points VIPSHOME
# at _internal at startup. The dylib itself stays at the top of _internal/, which
# is where the modules' own @rpath resolves - a second copy beside them would be
# loaded twice and abort in glib ("cannot register existing type VipsObject").
# PyInstaller pulls in the transitive dependencies (glib, openslide, openjpeg,
# libheif, ...) and rewrites the load commands to stay inside the bundle.
# ---------------------------------------------------------------------------
_libvips_spec = importlib.util.spec_from_file_location(
    "tl_libvips", os.path.join(SPECPATH, "app", "core", "libvips.py"))
_libvips = importlib.util.module_from_spec(_libvips_spec)
_libvips_spec.loader.exec_module(_libvips)
_vips_lib = _libvips.find_libvips_lib()
if not _vips_lib:
    raise SystemExit(
        "full libvips build not found: run `brew install vips`, or set TL_VIPS_DIR "
        "to a prefix whose lib/ holds libvips.42.dylib."
    )
print(f"[spec] bundling libvips from {_vips_lib}")
# ... and make it importable in this process too: the collect_submodules() sweeps
# below import pyvips and every app.* module that uses it.
_libvips.configure()


def _dylib_closure(roots):
    """Every non-system dylib the given Mach-O files pull in, transitively."""
    seen = {}
    queue = list(roots)
    while queue:
        path = os.path.realpath(queue.pop())
        if path in seen or not os.path.isfile(path):
            continue
        seen[path] = True
        out = subprocess.run(["otool", "-L", path], capture_output=True, text=True).stdout
        for line in out.splitlines()[1:]:
            dep = line.strip().split(" (compatibility")[0]
            # @rpath/@loader_path entries are Homebrew-internal only in rare cases;
            # everything under /usr/lib and /System is provided by macOS itself.
            if dep.startswith(("@", "/usr/lib/", "/System/")):
                continue
            queue.append(dep)
    return sorted(seen)


_vips_modules = [m for d in glob.glob(os.path.join(_vips_lib, "vips-modules-*"))
                 for m in glob.glob(os.path.join(d, "*.dylib"))]
for _mod in _vips_modules:
    binaries.append((_mod, os.path.join("lib", os.path.basename(os.path.dirname(_mod)))))

# The dylib and everything under it go to the top of _internal/, where every
# @rpath in the bundle resolves - see _use_homebrew_libvips_stack() below for why
# the whole closure is shipped and not just libvips itself.
VIPS_STACK = {os.path.basename(p): p
              for p in _dylib_closure([os.path.join(_vips_lib, _libvips.LIBVIPS_DYLIB)] + _vips_modules)}
for _dep in VIPS_STACK.values():
    binaries.append((_dep, "."))


def _use_homebrew_libvips_stack(analysis):
    """Make Homebrew's copy of each libvips dependency the one at the top of _internal/.

    PyInstaller flattens every shared library into that one directory keyed by
    basename, and the first one collected wins - which for glib, libpng, libtiff
    and friends is the copy vendored by opencv-python / Pillow / imagecodecs
    (collected as `cv2/.dylibs/...`, with a symlink from the top level), not the
    newer Homebrew build libvips is linked against. That is fatal rather than
    cosmetic: cv2 ships glib 2.84, which has no `g_string_copy`, so libvips 8.17
    fails to load with "Symbol not found". Since every one of these libraries is
    soname-versioned, the newer Homebrew copy satisfies the wheels too, but not
    the other way round - so it is the one that gets to sit at the top level.

    Analysis normalises `datas` and `binaries` together and splits them back by
    typecode, which puts those top-level symlinks in `datas`; hence both lists.
    """
    analysis.datas = [entry for entry in analysis.datas if entry[0] not in VIPS_STACK]
    analysis.binaries = [
        (dest, VIPS_STACK[dest], "BINARY") if dest in VIPS_STACK else (dest, src, typecode)
        for dest, src, typecode in analysis.binaries
    ]
    collected = {dest for dest, _, _ in analysis.binaries}
    analysis.binaries += [(name, path, "BINARY")
                          for name, path in VIPS_STACK.items() if name not in collected]


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
    "nibabel",
    "pydicom",
    # czifile is NOT collected: it is imported only by wrapper/windows.py, and
    # czifile 2019.7.2.1 needs tifffile.stripnull, removed in modern tifffile.

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
    "tensorflow", "keras", "jax", "jaxlib", "sklearn", "scikit_learn", "pandas", "numba",
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

_use_homebrew_libvips_stack(a)

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
