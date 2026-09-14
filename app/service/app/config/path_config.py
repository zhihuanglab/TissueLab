import os
from urllib.parse import unquote
from app.core.settings import settings

# derive from settings to ensure single source of truth
SERVICE_ROOT_DIR = os.path.abspath(settings.TL_SERVICE_ROOT)
# Everything the service writes (uploads, model registry, task node bundles and
# logs) lives under this directory, never next to the code.
SERVICE_STORAGE_DIR = os.path.join(SERVICE_ROOT_DIR, 'storage')
STORAGE_ROOT = os.path.join(SERVICE_STORAGE_DIR, 'uploads')
os.makedirs(STORAGE_ROOT, exist_ok=True)

try:
    print(f"[PATH CONFIG] SERVICE_ROOT_DIR: {SERVICE_ROOT_DIR}")
    print(f"[PATH CONFIG] STORAGE_ROOT: {STORAGE_ROOT}")
except Exception:
    pass

# Absolute path to the public read-only data root on disk.
# Optional extra read-only data root exposed as the virtual folder
# ``samples/Data`` (PUBLIC_DATA_PATH). Unset or missing on disk = not shown.
PUBLIC_DATA_PATH = os.getenv('PUBLIC_DATA_PATH', '/tissuelab/data')

# Public paths that are accessible to all users but read-only
# These paths are visible to everyone but operations are restricted
PUBLIC_READ_ONLY_PATHS = [
    'samples',
    PUBLIC_DATA_PATH,
]

# Virtual links configuration: Allow linking paths into other directories
# Each entry creates a virtual folder that appears in a parent directory but maps to a different real path
PUBLIC_VIRTUAL_LINKS = [
    {
        'alias': 'samples/Data',      # Virtual path shown to users
        'target': PUBLIC_DATA_PATH,    # Absolute system path (not under STORAGE_ROOT)
        'display_name': 'Data',        # Display name in UI
        'read_only': True,             # Whether this link should be read-only
    },
    # Add more virtual links here as needed in the future
    # Example:
    # {
    #     'alias': 'samples/Examples',
    #     'target': 'examples',
    #     'display_name': 'Examples',
    #     'read_only': True,
    # },
]


def _posix_slashes(path: str) -> str:
    """Normalize separators so Windows ``\\`` compares like POSIX ``/``."""
    return (path or '').replace('\\', '/').strip()


def _looks_absolute(path: str) -> bool:
    """True for POSIX abs (``/foo``), UNC (``//server/share``), or Windows drive (``C:/foo``)."""
    p = _posix_slashes(path)
    if not p:
        return False
    if p.startswith('/'):
        return True
    return len(p) >= 3 and p[1] == ':' and p[0].isalpha() and p[2] == '/'


def _same_or_under(path: str, root: str) -> bool:
    """True when *path* is *root* or a descendant. Slash-normalized; case-insensitive on Windows.

    Case folding is ``lower()``, NOT ``os.path.normcase`` — normcase also
    rewrites ``/`` into ``\\`` on Windows, undoing the normalization above and
    leaving the descendant test comparing against a prefix that could never
    match. Only exact matches worked there, and since this backs
    ``is_public_read_only_path``, nothing inside ``samples`` counted as read-only.
    """
    p = _posix_slashes(path).rstrip('/')
    r = _posix_slashes(root).rstrip('/')
    if not p or not r:
        return False
    if os.name == 'nt':
        p, r = p.lower(), r.lower()
    return p == r or p.startswith(r + '/')


def resolve_virtual_path(path: str) -> str:
    """
    Resolve a virtual path alias to its real storage path.
    If the path is not a virtual alias, returns the original path.
    
    Args:
        path: Relative path that might be a virtual alias (e.g., 'samples/Data')
    
    Returns:
        Real storage path (e.g., 'data') or original path if not virtual
    """
    if not path:
        return path
    
    # Normalize path (remove leading/trailing slashes)
    normalized = _posix_slashes(path).strip('/')
    
    # Check each virtual link
    for link in PUBLIC_VIRTUAL_LINKS:
        alias = _posix_slashes(link['alias']).strip('/')
        target = link['target']  # Don't strip leading slash for absolute paths
        
        # Exact match or subdirectory
        if normalized == alias:
            return target
        elif normalized.startswith(f"{alias}/"):
            # Replace alias prefix with target
            relative_subpath = normalized[len(alias)+1:]
            t = _posix_slashes(target).rstrip('/')
            return f"{t}/{relative_subpath}"
    
    return path


def is_public_read_only_path(path: str) -> bool:
    """
    Check if a path is in a public read-only directory.
    This now includes both real paths and virtual alias paths.
    
    Args:
        path: Relative path from storage root (e.g., 'samples', '/data', 'samples/Data')
    
    Returns:
        True if the path is in a public read-only directory, False otherwise
    """
    if not path:
        return False
    
    # Canonicalize first — a path that only *resolves* into samples would
    # otherwise slip past the read-only gate.
    posix = canonical_rel_path(path) or _posix_slashes(path)
    # Routes often guard the already-resolved absolute path; map it back under
    # STORAGE_ROOT so ``<storage>/samples/x.svs`` is read-only like ``samples/x.svs``.
    if _looks_absolute(posix):
        rel = normalize_storage_rel(posix)
        if rel and not _looks_absolute(rel):
            posix = rel
    normalized = posix.strip('/')

    for public_path in PUBLIC_READ_ONLY_PATHS:
        if _same_or_under(posix, public_path) or _same_or_under(normalized, public_path.strip('/')):
            return True

    return False


def canonical_rel_path(path: str) -> str:
    """Canonicalize a client-supplied path the way ``resolve_path`` will.

    The ORDER is the point: decode and convert ``\\`` to ``/`` BEFORE collapsing
    ``.``/``..``, because that is what ``resolve_path`` does. A check that
    collapses first inspects a different string than the resolver acts on, which
    is a traversal hole — ``users/<uid>/%2e%2e/other`` and
    ``users\\<uid>\\..\\other`` both passed the prefix check that way.
    """
    p = unquote(path or '').strip().replace('\\', '/')
    if not p:
        return ''
    return os.path.normpath(p).replace('\\', '/')


def _collapse(path: str) -> str:
    """Collapse ``.``/``..`` and unify separators, without touching the CWD.

    Containment below is a string prefix test, so both sides must be free of
    ``..`` first. Do NOT merge with ``canonical_rel_path``: that one also
    percent-decodes, which is right for a path a client sent and wrong for one
    read off disk — a real file named ``100%2e5.svs`` must keep its name here.
    """
    p = _posix_slashes(path)
    if not p:
        return ''
    return _posix_slashes(os.path.normpath(p)).rstrip('/')


def abs_to_client_path(absolute_path: str) -> str:
    """The path a client can address, for an absolute location on disk.

    * under ``STORAGE_ROOT`` — the storage-relative path.
    * inside a virtual link target — the alias form (``samples/Data/x.svs``);
      the target may sit anywhere, and only the alias is navigable.
    * anywhere else — ``''``, because inventing a path is worse than saying so.

    ``os.path.relpath`` cannot serve the second case on either platform: it
    returns an unusable ``../../../`` string on POSIX and raises on Windows the
    moment the two paths are on different drives.
    """
    p = _collapse(absolute_path)
    if not p:
        return ''

    storage = _collapse(STORAGE_ROOT)
    if storage and _same_or_under(p, storage):
        return p[len(storage):].strip('/')

    for link in PUBLIC_VIRTUAL_LINKS:
        target = _collapse(link.get('target') or '')
        if not target or not _same_or_under(p, target):
            continue
        alias = _posix_slashes(link.get('alias') or '').strip('/')
        remainder = p[len(target):].strip('/')
        return f"{alias}/{remainder}" if remainder else alias

    return ''


def is_virtual_path(path: str) -> bool:
    """
    Check if a path is a virtual alias or under a virtual alias.
    
    Args:
        path: Relative path to check
    
    Returns:
        True if path is virtual, False otherwise
    """
    if not path:
        return False
    
    normalized = _posix_slashes(path).strip('/')
    
    for link in PUBLIC_VIRTUAL_LINKS:
        alias = _posix_slashes(link['alias']).strip('/')
        if normalized == alias or normalized.startswith(f"{alias}/"):
            return True
    
    return False


def get_virtual_children(parent_path: str) -> list[dict]:
    """
    Get list of virtual child entries that should appear under a parent directory.
    
    Args:
        parent_path: Parent directory path (e.g., 'samples')
    
    Returns:
        List of virtual entry metadata dicts with 'alias', 'display_name', 'target', 'read_only'
    """
    if not parent_path:
        parent_path = ''
    
    normalized_parent = _posix_slashes(parent_path).strip('/')
    children = []
    
    for link in PUBLIC_VIRTUAL_LINKS:
        alias = _posix_slashes(link['alias']).strip('/')
        
        # Check if this virtual link is a direct child of parent_path
        if '/' in alias:
            alias_parent = alias.rsplit('/', 1)[0]
            if alias_parent == normalized_parent:
                children.append(link)
    
    return children


def get_public_virtual_links() -> list[dict]:
    """
    Get list of all public virtual links configuration.
    
    Returns:
        List of virtual link configurations
    """
    return PUBLIC_VIRTUAL_LINKS.copy()


def normalize_storage_rel(path: str) -> str:
    """Best-effort relative path under STORAGE_ROOT, without following dest symlinks.

    Use abspath, not realpath: Viewer dest symlinks must stay in the recipient
    tree so shareMode=view is found on the dest doc.
    """
    if not path:
        return ''
    p = _posix_slashes(path)
    if p.startswith('file://'):
        p = p[7:]
        if len(p) > 3 and p.startswith('/') and p[2] == ':' and p[1].isalpha():
            p = p[1:]
    try:
        abs_storage = os.path.abspath(STORAGE_ROOT)
        if _looks_absolute(p):
            abs_p = os.path.abspath(os.path.normpath(p.replace('/', os.sep)))
            if abs_p == abs_storage or abs_p.startswith(abs_storage + os.sep):
                return os.path.relpath(abs_p, abs_storage).replace('\\', '/').strip('/')
            return abs_p.replace('\\', '/')
    except Exception:
        pass
    return p.strip('/')


def _abs_under_storage(rel: str) -> str:
    rel_n = _posix_slashes(rel).strip('/')
    return os.path.normpath(os.path.join(STORAGE_ROOT, rel_n.replace('/', os.sep)))


def path_involves_symlink(path: str) -> bool:
    """True when *path* is a symlink or sits under one (view / collab / private-copy WSI)."""
    try:
        rel = normalize_storage_rel(path)
        if not rel or _looks_absolute(rel) or _looks_absolute(path):
            cur = os.path.normpath(path)
        else:
            cur = _abs_under_storage(rel)
        storage_root = os.path.normpath(os.path.realpath(STORAGE_ROOT))
        seen = set()
        while cur and cur not in seen:
            seen.add(cur)
            try:
                if os.path.islink(cur):
                    return True
            except OSError:
                break
            parent = os.path.dirname(cur)
            if not parent or parent == cur:
                break
            # Don't walk above storage root when path was relative.
            try:
                if os.path.commonpath([parent, storage_root]) != storage_root:
                    break
            except ValueError:
                break
            cur = parent
    except Exception:
        return False
    return False


class ShareAclUnavailable(Exception):
    """Share-ACL lookup failed; callers should fail-closed for symlink paths."""


def strip_zarr_sidecar(rel: str) -> str:
    """Map companion ``slide.svs.zarr`` / ``.zarr.zip`` back to the slide."""
    rel = (rel or "").replace("\\", "/").strip("/")
    lower = rel.lower()
    if lower.endswith(".zarr.zip"):
        return rel[:-9]
    if lower.endswith(".zarr"):
        return rel[:-5]
    return rel


def zarr_slide_rels(rel: str):
    """Lookup *rel* first, then the companion slide if *rel* is a zarr store."""
    rel = (rel or "").replace("\\", "/").strip("/")
    stripped = strip_zarr_sidecar(rel)
    if stripped != rel:
        return (rel, stripped)
    return (rel,)


def share_mode_of_doc(data):
    """Share umbrella mode if *data* is a share root/link, else None."""
    if not data:
        return None
    mode = (data.get("shareMode") or "").strip().lower()
    if data.get("isShareRoot") or mode in ("view", "collaborate"):
        return mode or None
    if mode == "share" or data.get("linkedFrom"):
        return mode or "share"
    return None


def get_path_share_mode(path: str, uid: str = ""):
    """Share mode for *path* as seen by *uid*.

    The open edition has one local user and no cross-user shares, so no path
    is ever under a share umbrella. Kept for signature compatibility with the
    guards in ``app/core/access.py`` and the file manager.
    """
    return None


def _inside_root(candidate: str, root: str) -> bool:
    """True when *candidate* is *root* or a descendant of it."""
    try:
        return os.path.commonpath([candidate, root]) == root
    except (TypeError, ValueError):
        return False


def is_local_desktop_path(path: str) -> bool:
    """True when *path* names a location outside the managed storage roots.

    The open edition runs as the person sitting at the machine (one principal,
    no accounts — see ``docs/local-mode.md``), so such a path is simply one of
    their own files: a slide in ``~/Downloads``, the ``.zarr`` sidecar a
    workflow is about to write next to it, a folder they picked in a native
    dialog. Nothing about it is gated.

    Deliberately a question about *location only*. It must never consult the
    filesystem for whether the target exists — see the invariant on
    ``authorize_storage_read_path``.
    """
    if not path:
        return False
    real = os.path.realpath(os.path.abspath(path))
    storage = os.path.realpath(os.path.abspath(STORAGE_ROOT))
    public = os.path.realpath(os.path.abspath(PUBLIC_DATA_PATH))
    return not (_inside_root(real, storage) or _inside_root(real, public))


def get_restricted_access_mode(path: str, uid: str = ""):
    """``"samples"`` for the public read-only area, else ``None`` (writable)."""
    if is_public_read_only_path(path):
        return "samples"
    if get_path_share_mode(path, uid) == "view":
        return "viewer"
    return None


def authorize_storage_read_path(path: str, uid: str) -> str:
    """Authorize a read and return the resolved absolute path.

    ``resolve_path`` first: absolute client paths stay as-is; relative paths are
    joined under ``STORAGE_ROOT``. Then:

    * Outside the managed storage roots → the local user's own filesystem
      (``is_local_desktop_path``); allow.
    * Under public Samples → allow.
    * Under ``users/<uid>/...`` → allow for that user.
    * Under another user's tree → denied (no share grants in the open edition).

    **Invariant: authorization answers "is this location allowed?", never "is
    this file there?".** A guard that also demanded existence denies every
    not-yet-created output path — including the ``<slide>.zarr`` sidecar that
    ``start_workflow`` exists to produce, which turned "run a workflow on a
    slide opened from ``~/Downloads``" into a 403 with no way forward. A
    missing file is the handler's business and must surface as 404 / ENOENT.

    Raises ``PermissionError`` when access is denied.
    """
    if not path or not uid:
        raise PermissionError("Path access denied")

    from app.utils import resolve_path

    absolute = os.path.abspath(resolve_path(path))
    storage_abs = os.path.abspath(STORAGE_ROOT)
    public_abs = os.path.abspath(PUBLIC_DATA_PATH)
    public = os.path.realpath(public_abs)
    real = os.path.realpath(absolute)

    # The local user's own filesystem — whether or not the target exists yet.
    if is_local_desktop_path(absolute):
        return absolute

    if _inside_root(real, public) or is_public_read_only_path(path) or is_public_read_only_path(absolute):
        return absolute

    if not _inside_root(absolute, storage_abs):
        raise PermissionError("Path access denied")
    rel = os.path.relpath(absolute, storage_abs).replace("\\", "/").strip("/")
    # Absolute form of the public Samples area (callers re-authorize the
    # already-resolved path): read-only, readable by everyone.
    if is_public_read_only_path(rel):
        return absolute
    parts = rel.split("/")
    if len(parts) >= 2 and parts[0] == "users" and parts[1] == uid:
        return absolute

    # Another user's tree: there are no share grants in the open edition.
    raise PermissionError("Path access denied")
