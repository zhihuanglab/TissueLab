"""Download the official libvips Windows build into app/service/vendor/.

    python scripts/fetch_libvips.py            # pinned version, sha256-verified
    python scripts/fetch_libvips.py --force    # re-download

Unpacks ``vendor/vips-dev-<major.minor>/`` (gitignored); the service and
``main_windows.spec`` find it through ``app/core/libvips.py``. Alternatives:
unpack the same zip anywhere and set ``TL_VIPS_DIR``, or put its ``bin`` on
``PATH``.
"""
import argparse
import hashlib
import os
import sys
import tempfile
import urllib.request
import zipfile

SERVICE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR_DIR = os.path.join(SERVICE_DIR, "vendor")

VERSION = "8.17.3"
# sha256 of vips-dev-w64-all-<version>.zip from github.com/libvips/build-win64-mxe/releases
SHA256 = {
    "8.17.3": "0a57aac04ca723def28ba607ec1ef53b984a52594ee3e13d0e7d8ea89455a357",
}
URL = "https://github.com/libvips/build-win64-mxe/releases/download/v{v}/vips-dev-w64-all-{v}.zip"


def install_dir(version: str) -> str:
    major_minor = ".".join(version.split(".")[:2])
    return os.path.join(VENDOR_DIR, f"vips-dev-{major_minor}")


def fetch(version: str, force: bool = False) -> str:
    dest = install_dir(version)
    stamp = os.path.join(dest, ".tissuelab-libvips-version")
    if not force and os.path.isfile(stamp) and open(stamp, encoding="utf-8").read().strip() == version:
        print(f"libvips {version} already present at {dest}")
        return os.path.join(dest, "bin")

    url = URL.format(v=version)
    expected = SHA256.get(version)
    if expected is None:
        raise SystemExit(f"no pinned sha256 for libvips {version}; add it to SHA256 in {__file__}")

    os.makedirs(VENDOR_DIR, exist_ok=True)
    print(f"downloading {url}")
    digest = hashlib.sha256()
    with tempfile.NamedTemporaryFile(dir=VENDOR_DIR, suffix=".zip", delete=False) as tmp:
        tmp_path = tmp.name
        with urllib.request.urlopen(url, timeout=120) as resp:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                digest.update(chunk)
                tmp.write(chunk)
    try:
        if digest.hexdigest() != expected:
            raise SystemExit(f"sha256 mismatch for {url}: got {digest.hexdigest()}, expected {expected}")
        with zipfile.ZipFile(tmp_path) as zf:
            top = {name.split("/")[0] for name in zf.namelist()}
            if top != {os.path.basename(dest)}:
                raise SystemExit(f"unexpected archive layout {sorted(top)}; expected {os.path.basename(dest)}/")
            print(f"unpacking into {VENDOR_DIR}")
            zf.extractall(VENDOR_DIR)
    finally:
        os.unlink(tmp_path)

    bin_dir = os.path.join(dest, "bin")
    if not os.path.isfile(os.path.join(bin_dir, "libvips-42.dll")):
        raise SystemExit(f"libvips-42.dll missing after unpack under {bin_dir}")
    with open(stamp, "w", encoding="utf-8") as fh:
        fh.write(version + "\n")
    print(f"libvips {version} ready: {bin_dir}")
    return bin_dir


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", default=VERSION)
    parser.add_argument("--force", action="store_true", help="re-download even if present")
    args = parser.parse_args(argv)
    if sys.platform != "win32":
        print("note: this build is for Windows; macOS/Linux use pyvips[binary] or the system libvips")
    fetch(args.version, force=args.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
