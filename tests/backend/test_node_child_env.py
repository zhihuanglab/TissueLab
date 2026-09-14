"""The environment a task node is spawned with.

A node must resolve packages and shared libraries from its own conda env only.
The service therefore never leaves its own configuration in ``os.environ``:
``libvips.configure()`` needs ``VIPSHOME`` only while pyvips initialises, and
never sets ``DYLD_LIBRARY_PATH`` (dyld would not honour it for this process
anyway). In the frozen build that directory is ``_internal`` - every dylib the
service ships - and a node inheriting it bound its ``pyexpat`` to the app's
older libexpat and died at ``import matplotlib`` with "Symbol not found".
"""
import os
import sys

import pytest

from app.core import libvips
from app.utils.workflow import register


@pytest.mark.skipif(sys.platform != "darwin", reason="configure() only touches the environment on macOS")
def test_configure_leaves_the_environment_untouched(monkeypatch):
    monkeypatch.delenv("VIPSHOME", raising=False)
    monkeypatch.delenv("DYLD_LIBRARY_PATH", raising=False)
    before = dict(os.environ)
    lib_dir = libvips.configure()
    assert lib_dir is not None, "a full libvips build is a test prerequisite (brew install vips)"
    assert dict(os.environ) == before


@pytest.mark.skipif(sys.platform != "darwin", reason="configure() only touches the environment on macOS")
def test_configure_restores_a_preexisting_vipshome(monkeypatch):
    monkeypatch.setenv("VIPSHOME", "/somewhere/the/user/chose")
    libvips.configure()
    assert os.environ["VIPSHOME"] == "/somewhere/the/user/chose"


def test_node_env_has_no_python_leaks(monkeypatch):
    monkeypatch.setenv("PYTHONPATH", "/somewhere/else")
    monkeypatch.setenv("PYTHONHOME", "/another/python")
    env = register._isolated_child_env()
    assert "PYTHONPATH" not in env
    assert "PYTHONHOME" not in env
    assert env["PYTHONNOUSERSITE"] == "1"


def test_node_env_otherwise_inherits(monkeypatch):
    """Proxies, HF_ENDPOINT, CUDA settings and the like must reach the node."""
    monkeypatch.setenv("HF_ENDPOINT", "https://hf-mirror.example")
    assert register._isolated_child_env()["HF_ENDPOINT"] == "https://hf-mirror.example"


@pytest.mark.skipif(sys.platform != "darwin", reason="libvips binding via configure() is a macOS concern")
def test_codeexec_worker_can_import_pyvips(tmp_path):
    """The sandbox child is a fresh interpreter (under PyInstaller, the frozen
    service re-launched) that must bind libvips itself rather than through an
    inherited DYLD_LIBRARY_PATH - which this service no longer exports."""
    from app.services.codeexec.sandbox import run_subprocess
    from app.services.codeexec.schema import ExecRequest
    res = run_subprocess(ExecRequest(
        code="import pyvips\nresult = {'vips_major': pyvips.version(0)}",
        zarr_path=str(tmp_path / "x.zarr"), uid="test", timeout_seconds=120))
    assert res.ok, res.error
    assert res.result["vips_major"] == 8


def test_rosetta_detection_resolves_the_conda_symlink(monkeypatch, tmp_path):
    """conda's bin/python is a symlink; `file -b` on the link itself never says x86_64."""
    real = tmp_path / "python3.11"
    real.write_bytes(b"\x00")
    link = tmp_path / "python"
    link.symlink_to(real)
    seen = {}

    def fake_run(cmd, **kw):
        seen["path"] = cmd[-1]
        class R:
            stdout = "Mach-O 64-bit executable x86_64"
        return R()
    monkeypatch.setattr(register.subprocess, "run", fake_run)
    assert register._rosetta_prefix(str(link)) == ["/usr/bin/arch", "-x86_64"]
    assert seen["path"] == str(real)
