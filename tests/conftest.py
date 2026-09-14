"""Shared fixtures for the TissueLab test-suite (repo-root ``tests/``).

The Python service lives in ``app/service``; it keeps module-level singletons
(storage root, model registry, thumbnail worker), so the app is imported once
per session against a temporary service root. Every test that writes files
does so under that root.
"""
import os
import sys
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SERVICE_DIR = REPO_ROOT / "app" / "service"
SMOKE_DIR = REPO_ROOT / "tests" / "smoke"
for _p in (SERVICE_DIR, SMOKE_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

# Configure the environment BEFORE any app module is imported.
_TMP_ROOT = tempfile.mkdtemp(prefix="tissuelab-test-root-")
os.environ["ENV"] = "test"
os.environ["ENVIRONMENT"] = "test"
os.environ["TL_SERVICE_ROOT"] = _TMP_ROOT
os.environ["AUTO_ACTIVATE_TASKNODES"] = "false"
os.environ["CODEEXEC_DOCKER"] = "0"
os.environ.pop("OPENAI_API_KEY", None)
os.environ["LOG_DIR_OVERRIDE"] = os.path.join(_TMP_ROOT, "logs")


@pytest.fixture(scope="session")
def service_root() -> Path:
    return Path(_TMP_ROOT)


@pytest.fixture(scope="session")
def app():
    import main  # noqa: WPS433 — imported here so env vars above apply
    return main.app


@pytest.fixture(scope="session")
def client(app):
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def storage_root(service_root) -> Path:
    from app.config.path_config import STORAGE_ROOT
    assert Path(STORAGE_ROOT).resolve() == (service_root / "storage" / "uploads").resolve()
    return Path(STORAGE_ROOT)


@pytest.fixture(scope="session")
def local_uid() -> str:
    from app.core.settings import settings
    return settings.LOCAL_USER_ID


@pytest.fixture(scope="session")
def user_root(storage_root, local_uid) -> Path:
    root = storage_root / "users" / local_uid
    root.mkdir(parents=True, exist_ok=True)
    return root


@pytest.fixture(scope="session")
def samples_root(storage_root) -> Path:
    root = storage_root / "samples"
    root.mkdir(parents=True, exist_ok=True)
    return root
