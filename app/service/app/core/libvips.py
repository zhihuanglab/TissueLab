"""Locate the full libvips build on Windows and macOS.

pyvips is only a wrapper: in ABI mode it dlopens ``libvips-42.dll`` /
``libvips.42.dylib`` by leaf name. The ``pyvips[binary]`` wheel would supply
one, but that build lacks the OpenSlide / JPEG-2000 / HEIF / JXL loaders, so
``.svs``, ``.ndpi``, ``.mrxs`` and JPEG-2000 TIFFs would not open. Both
platforms therefore use a full build, looked up in this order:

1. ``TL_VIPS_DIR`` - an unpacked vips-dev directory (or its ``bin``) on
   Windows, an install prefix (or its ``lib``) on macOS;
2. ``app/service/vendor/vips-*`` - what ``scripts/fetch_libvips.py`` unpacks;
3. Homebrew's ``vips`` prefix (macOS only);
4. the process ``PATH`` (Windows) / ``DYLD_LIBRARY_PATH`` (macOS) - a
   system-wide install.

Windows source checkouts only need the search path fixed up, which is all
``configure()`` does there; ``main_windows.spec`` copies the discovered DLLs
next to the executable and the frozen build finds them by itself.

macOS needs more: dyld resolves a leaf name against DYLD_LIBRARY_PATH, which
is frozen at process start, so neither ``_internal/lib`` nor
``/opt/homebrew/lib`` is ever searched. ``configure()`` therefore imports
pyvips itself, bound to the absolute path it found - see ``_import_pyvips``.

``configure()`` leaves ``os.environ`` exactly as it found it. Task nodes
inherit this process's environment, and in the frozen build the libvips
directory is ``_internal`` - every dylib the service ships. A node whose
loader search path pointed there would bind its own ``pyexpat`` to the app's
libexpat and die at ``import matplotlib`` with "Symbol not found".

Standard library only, because the spec files import this module at build time.
"""
import glob
import os
import sys

LIBVIPS_DLL = "libvips-42.dll"
LIBVIPS_DYLIB = "libvips.42.dylib"
SERVICE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VENDOR_DIR = os.path.join(SERVICE_DIR, "vendor")

# Homebrew's own prefix first (`brew install vips`), then the plain lib dirs, so
# a keg-only or manually built libvips under /usr/local still gets picked up.
BREW_PREFIXES = ("/opt/homebrew/opt/vips", "/usr/local/opt/vips", "/opt/homebrew", "/usr/local")


def _dir_with(candidate: str, libname: str, subdirs):
    for sub in subdirs:
        d = os.path.join(candidate, sub) if sub else candidate
        if os.path.isfile(os.path.join(d, libname)):
            return os.path.abspath(d)
    return None


def _bin_dir(candidate: str):
    return _dir_with(candidate, LIBVIPS_DLL, ("", "bin"))


def find_libvips_bin(use_path: bool = True):
    """Directory holding ``libvips-42.dll`` (and ``vips-modules-*/``), or None.

    An explicit but wrong ``TL_VIPS_DIR`` yields None rather than silently
    falling back to another copy.
    """
    explicit = os.environ.get("TL_VIPS_DIR")
    if explicit:
        return _bin_dir(explicit)
    for d in sorted(glob.glob(os.path.join(VENDOR_DIR, "vips-dev-*")), reverse=True):
        found = _bin_dir(d)
        if found:
            return found
    if use_path:
        # not shutil.which(): on Windows it only honours PATHEXT extensions
        for entry in os.environ.get("PATH", "").split(os.pathsep):
            if entry and os.path.isfile(os.path.join(entry, LIBVIPS_DLL)):
                return os.path.abspath(entry)
    return None


def find_libvips_lib(use_path: bool = True):
    """macOS: directory holding ``libvips.42.dylib``, or None.

    Its parent is the libvips prefix — ``<prefix>/lib/vips-modules-<x>.<y>/``
    is where libvips loads the OpenSlide / HEIF / JXL / Magick / Poppler
    modules from, which is why ``configure()`` exports it as ``VIPSHOME``.
    """
    explicit = os.environ.get("TL_VIPS_DIR")
    if explicit:
        return _dir_with(explicit, LIBVIPS_DYLIB, ("", "lib"))
    if getattr(sys, "frozen", False):
        # main_macos.spec ships the dylib at the top of _internal (where the
        # modules' @rpath resolves) and the modules under _internal/lib;
        # _MEIPASS is that _internal directory.
        meipass = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(sys.executable)))
        return _dir_with(meipass, LIBVIPS_DYLIB, ("", "lib"))
    for d in sorted(glob.glob(os.path.join(VENDOR_DIR, "vips-*")), reverse=True):
        found = _dir_with(d, LIBVIPS_DYLIB, ("", "lib"))
        if found:
            return found
    for prefix in BREW_PREFIXES:
        found = _dir_with(prefix, LIBVIPS_DYLIB, ("lib",))
        if found:
            return found
    if use_path:
        for entry in os.environ.get("DYLD_LIBRARY_PATH", "").split(os.pathsep):
            if entry and os.path.isfile(os.path.join(entry, LIBVIPS_DYLIB)):
                return os.path.abspath(entry)
    return None


def find_vipshome(lib_dir: str):
    """The prefix to hand libvips as ``VIPSHOME``: the one whose
    ``lib/vips-modules-<x>.<y>/`` holds the loadable modules.

    That is the parent of the library directory for a normal install prefix
    (``<prefix>/lib/libvips.42.dylib``) but the library directory itself in the
    frozen bundle, where the dylib sits at the top of ``_internal`` and only the
    modules live under ``_internal/lib``.
    """
    for prefix in (os.path.dirname(lib_dir), lib_dir):
        if glob.glob(os.path.join(prefix, "lib", "vips-modules-*")):
            return prefix
    return os.path.dirname(lib_dir)


def _import_pyvips(dylib: str):
    """Import pyvips bound to ``dylib``.

    pyvips offers no way to say where libvips is: in ABI mode it calls
    ``ffi.dlopen("libvips.42.dylib")``, and dyld resolves that leaf name only
    against DYLD_LIBRARY_PATH — read once at process start, so setting it from
    here reaches child processes but not this dlopen. Redirect that one name to
    the absolute path for the duration of the import and leave every other
    dlopen alone.

    ``_libvips`` is the compiled extension of the ``pyvips[binary]`` wheel; when
    it imports, pyvips uses it (API mode) and never reaches the ABI branch —
    and it is linked against the cut-down libvips we are trying to get away
    from. ``None`` in ``sys.modules`` is the documented way to make that import
    fail.
    """
    import cffi

    original_dlopen = cffi.FFI.dlopen
    missing = object()
    saved = sys.modules.get("_libvips", missing)
    sys.modules["_libvips"] = None

    def dlopen(self, name, *args, **kwargs):
        return original_dlopen(self, dylib if name == LIBVIPS_DYLIB else name, *args, **kwargs)

    cffi.FFI.dlopen = dlopen
    try:
        import pyvips  # noqa: F401 - binds the library while the redirect is up
    finally:
        cffi.FFI.dlopen = original_dlopen
        if saved is missing:
            del sys.modules["_libvips"]
        else:
            sys.modules["_libvips"] = saved


def configure():
    """Make pyvips use the full libvips build. Returns the directory used, or None.

    Windows source checkouts: put the discovered ``bin`` first on the DLL search
    path. The frozen build needs nothing — the DLLs sit next to the executable.

    macOS (source checkout and frozen build alike): import pyvips against the
    absolute path, with ``VIPSHOME`` set for just that import so libvips finds
    its loadable modules. libvips loads every module during initialisation,
    which happens inside the import, so the variable is put back right after -
    it is not left behind for child processes to inherit.

    Linux is left alone: the system libvips is on the normal loader path.
    """
    if sys.platform == "darwin":
        lib_dir = find_libvips_lib()
        if lib_dir is None:
            return None
        saved = os.environ.get("VIPSHOME")
        os.environ["VIPSHOME"] = find_vipshome(lib_dir)
        try:
            _import_pyvips(os.path.join(lib_dir, LIBVIPS_DYLIB))
        finally:
            if saved is None:
                del os.environ["VIPSHOME"]
            else:
                os.environ["VIPSHOME"] = saved
        return lib_dir

    if sys.platform != "win32" or getattr(sys, "frozen", False):
        return None
    bin_dir = find_libvips_bin()
    if bin_dir is None:
        return None
    os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
    try:
        os.add_dll_directory(bin_dir)
    except (AttributeError, OSError):
        pass
    return bin_dir
