# fastapi_complex.spec
# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all, collect_submodules
import imagecodecs
block_cipher = None
# Collect all necessary data files and dependencies
datas = []
binaries = []
hiddenimports = (
    ["imagecodecs." + x for x in imagecodecs._extensions()]
    + [
        "imagecodecs._shared",
        "imagecodecs._imcd",
    ]
)
datas.extend([
   ('.env.prod', '.'),  # Add .env file to root directory
   ("resources\\imagecodecs\\_zlib.cp39-win_amd64.pyd", "imagecodecs"),
   ("resources\\imagecodecs\\_jpeg8.cp39-win_amd64.pyd", "imagecodecs"),
   ("resources\\imagecodecs\\_jpeg2k.cp39-win_amd64.pyd", "imagecodecs"),
   ("resources\\imagecodecs\\_imcd.cp39-win_amd64.pyd", "imagecodecs"),
   ("resources\\imagecodecs\\_shared.cp39-win_amd64.pyd", "imagecodecs"),
   # Add prompt templates
   ("app/services/prompts/*.txt", "app/services/prompts/"),
   # Add JSON configuration files
   ("storage/model_registry.json", "storage/"),
   # Add Firebase credentials
   ("credentials/*.json", "credentials/"),
   # Add storage directory structure
   ("storage/", "storage/"),
])

for pkg in ['PIL', 'numpy', 'pandas', 'zarr', 'bioio', 'shapely', 'scikit-image', 'cv2', 'websockets', 'tiffslide', 'win32com', 'win32api', 'win32con']:
   pkg_imports = collect_submodules(pkg)
   hiddenimports.extend(pkg_imports)
# FastAPI related imports
hiddenimports.extend([
   'uvicorn.logging',
   'uvicorn.protocols',
   'uvicorn.lifespan',
   'uvicorn.protocols.http',
   'uvicorn.protocols.http.auto',
   'uvicorn.protocols.websockets',
   'uvicorn.protocols.websockets.auto',
   'uvicorn.loops',
   'uvicorn.loops.auto',
   'app.api.tasks',
   'app.api.agent',
   'app.api.load',
   'app.api.seg',
   'app.api.data',
   'app.api.feedback',
   'app.api.review',
   'app.api.thumbnail',
   'app.core.settings',
   'app.middlewares.error_handler',
   'app.middlewares.logging_middleware',
   'app.middlewares.auth_middleware',
   'app.websocket',
   'app.services.tasks_service',
   'app.services.thumbnail.thumbnail_task_service',
   'app.services.auto_activation_service',
   'fastapi.middleware.cors',
   'starlette.exceptions',
   'pydantic_settings',
   'python_multipart',
   'pydicom',
   'pylibCZIrw',
   'pyisyntax',
   'czifile',
   'firebase_admin',
   'firebase_admin.credentials',
   'celery',
   'zmq',
   'starlette.middleware',
   'starlette.middleware.cors',
   'starlette.types',
   'starlette.datastructures',
   'starlette.middleware.base'
])
a = Analysis(
   ['main.py'],
   pathex=[],
   binaries=binaries,
   datas=datas,
   hiddenimports=hiddenimports,
   hookspath=[],
   hooksconfig={},
   runtime_hooks=[],
   excludes=[],
   win_no_prefer_redirects=False,
   win_private_assemblies=False,
   cipher=block_cipher,
   noarchive=False
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(
   pyz,
   a.scripts,
   a.binaries,
   a.zipfiles,
   a.datas,
   [],
   name='TissueLab_AI',
   debug=False,
   bootloader_ignore_signals=False,
   strip=False,
   upx=True,
   console=True,
   disable_windowed_traceback=False,
   target_arch=None,
   codesign_identity=None,
   entitlements_file=None,
   icon='TissueLab_logo.ico'
)