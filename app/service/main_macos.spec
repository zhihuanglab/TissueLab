# fastapi_complex_macos.spec
# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all, collect_submodules
import imagecodecs

block_cipher = None

datas = []
binaries = []
hiddenimports = []

# Collect imagecodecs resources
ic_datas, ic_binaries, ic_hiddenimports = collect_all("imagecodecs")
datas.extend(ic_datas)
binaries.extend(ic_binaries)
hiddenimports.extend(ic_hiddenimports)

hiddenimports.extend(
    ["imagecodecs." + x for x in imagecodecs._extensions()]
    + [
        "imagecodecs._shared",
        "imagecodecs._imcd",
    ]
)

datas.extend([
   ('.env.local', '.'),  # Add .env file to root directory
   # Add prompt templates
   ("app/services/prompts/*.txt", "app/services/prompts/"),
   # Add JSON configuration files
   ("storage/model_registry.json", "storage/"),
   # Add storage directory structure
   ("storage/", "storage/"),
   # Add logo file
   ("TissueLab_logo.ico", "."),
])

for pkg in [
    "PIL",
    "numpy",
    "zarr",
    "numcodecs",  # zarr dependency
    "cv2",
    "websockets",
    "tiffslide",
    "uvicorn",
    "celery",
    "zmq",
    "pydicom",
    "pylibCZIrw",
    "pyisyntax",
    "czifile",
    "aiohttp",  # Used in tasks_service
    "scipy",  # Used in seg_service
    "openai",  # Used in agent_service
    "orjson",  # Used in segmentation_consumer for fast JSON serialization
    "h5py",
    "nibabel",
    "numba",
    "ome_zarr",  # ome-zarr package
    "ome_types",  # ome-types package
    "pyvips",
]:
    hiddenimports.extend(collect_submodules(pkg))

hiddenimports.extend(
    [
        "uvicorn.logging",
        "uvicorn.protocols",
        "uvicorn.lifespan",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        # App API modules - auto-collect all submodules
        *collect_submodules("app.api"),
        # App core modules - auto-collect all submodules
        *collect_submodules("app.core"),
        # App config modules - auto-collect all submodules
        *collect_submodules("app.config"),
        # App middleware modules - auto-collect all submodules
        *collect_submodules("app.middlewares"),
        # App websocket modules - auto-collect all submodules
        *collect_submodules("app.websocket"),
        # App service modules - auto-collect all submodules (includes factory, tasks, etc.)
        *collect_submodules("app.services"),
        # App repository modules - auto-collect all submodules
        *collect_submodules("app.repos"),
        # App SDK modules - auto-collect all submodules
        *collect_submodules("app.sdks"),
        # App utility modules - auto-collect all submodules
        *collect_submodules("app.utils"),
        # FastAPI and Starlette modules
        "fastapi.middleware.cors",
        "starlette.exceptions",
        "pydantic_settings",
        "python_multipart",
        "starlette.middleware",
        "starlette.middleware.cors",
        "starlette.types",
        "starlette.datastructures",
        "starlette.middleware.base",
    ]
)

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', '_tkinter', 'tcl', 'tk', 'Tkinter', 'tzdata', 'pytz'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

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
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="TissueLab_AI",
)
