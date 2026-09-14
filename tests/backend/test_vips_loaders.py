"""libvips in the service environment is the full build: slide loaders are present.

The pyvips[binary] wheel bundles a cut-down libvips without OpenSlide /
JPEG-2000 / HEIF / JXL support, which silently breaks .svs/.ndpi/.mrxs slides
and JPEG-2000 compressed TIFFs. On Windows the service must use the
vips-dev-w64-all build (see app/core/libvips.py); this test fails when the
environment fell back to the wheel.
"""
import os
import sys

import pytest
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parents[2] / "app" / "service"

SLIDE = os.environ.get("TL_TEST_SLIDE", "")


def _has(op: str) -> bool:
    import pyvips
    return pyvips.type_find("VipsOperation", op) != 0


def test_required_loaders_are_available(app):
    missing = [op for op in ("openslideload", "jp2kload", "tiffload", "jpegload", "pngload", "webpload") if not _has(op)]
    assert missing == [], f"libvips lacks loaders {missing}: the pyvips[binary] wheel is being used instead of the full build"


@pytest.mark.skipif(sys.platform != "win32", reason="Windows uses the vips-dev-w64-all build")
def test_windows_uses_the_full_build_not_the_wheel(app):
    import importlib.util
    assert importlib.util.find_spec("pyvips_binary") is None, "pyvips-binary is installed; it shadows the full libvips build"
    import pyvips
    assert (pyvips.version(0), pyvips.version(1)) >= (8, 17)


@pytest.mark.skipif(not os.path.isfile(SLIDE), reason="set TL_TEST_SLIDE to a local whole-slide image")
def test_openslide_loader_opens_a_slide(app):
    import pyvips
    img = pyvips.Image.new_from_file(SLIDE, access="sequential")
    assert img.width > 1000 and img.height > 1000
    assert img.get("vips-loader") == "openslideload"


# --- discovery (app/core/libvips.py): pure path logic, runs on every platform ---

def _fake_vips_dev(tmp_path, name="vips-dev-9.99"):
    bin_dir = tmp_path / name / "bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / "libvips-42.dll").write_bytes(b"")
    return bin_dir


def test_tl_vips_dir_accepts_root_or_bin(tmp_path, monkeypatch):
    from app.core import libvips
    bin_dir = _fake_vips_dev(tmp_path)
    monkeypatch.setenv("TL_VIPS_DIR", str(bin_dir.parent))
    assert libvips.find_libvips_bin(use_path=False) == str(bin_dir)
    monkeypatch.setenv("TL_VIPS_DIR", str(bin_dir))
    assert libvips.find_libvips_bin(use_path=False) == str(bin_dir)


def test_wrong_tl_vips_dir_does_not_fall_back(tmp_path, monkeypatch):
    from app.core import libvips
    monkeypatch.setenv("TL_VIPS_DIR", str(tmp_path / "nowhere"))
    monkeypatch.setattr(libvips, "VENDOR_DIR", str(tmp_path / "vendor"))
    _fake_vips_dev(tmp_path / "vendor")
    assert libvips.find_libvips_bin() is None


def test_vendor_dir_is_used_before_path(tmp_path, monkeypatch):
    from app.core import libvips
    monkeypatch.delenv("TL_VIPS_DIR", raising=False)
    monkeypatch.setattr(libvips, "VENDOR_DIR", str(tmp_path / "vendor"))
    old = _fake_vips_dev(tmp_path / "vendor", "vips-dev-8.16")
    new = _fake_vips_dev(tmp_path / "vendor", "vips-dev-8.17")
    assert libvips.find_libvips_bin() == str(new) != str(old)


def test_path_lookup_is_last_resort(tmp_path, monkeypatch):
    from app.core import libvips
    monkeypatch.delenv("TL_VIPS_DIR", raising=False)
    monkeypatch.setattr(libvips, "VENDOR_DIR", str(tmp_path / "empty"))
    assert libvips.find_libvips_bin(use_path=False) is None
    on_path = _fake_vips_dev(tmp_path / "system")
    monkeypatch.setenv("PATH", str(on_path) + os.pathsep + os.environ.get("PATH", ""))
    assert libvips.find_libvips_bin() == str(on_path)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows source checkouts configure the DLL path")
def test_configure_prepends_discovered_dir(monkeypatch):
    from app.core import libvips
    monkeypatch.delenv("TL_VIPS_DIR", raising=False)
    used = libvips.configure()
    assert used and os.path.isfile(os.path.join(used, "libvips-42.dll"))
    assert os.environ["PATH"].split(os.pathsep)[0] == used


def test_fetch_script_pins_a_checksum():
    import importlib.util
    path = SERVICE_DIR / "scripts" / "fetch_libvips.py"
    spec = importlib.util.spec_from_file_location("fetch_libvips", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.VERSION in mod.SHA256 and len(mod.SHA256[mod.VERSION]) == 64
    assert mod.install_dir(mod.VERSION).endswith("vips-dev-" + ".".join(mod.VERSION.split(".")[:2]))
