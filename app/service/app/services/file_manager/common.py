"""Cross-module file-manager utilities: paths, access control, quota, naming."""
import asyncio
import errno
import os
import shutil
from typing import Dict, Any, Optional
import logging
from app.utils import resolve_path
from app.core.auth import AuthUser
from app.core.errors import AppError, AppErrors
import unicodedata
import re
from datetime import datetime
from app.repos.files import FilesRepo
import hashlib
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Use the same STORAGE_ROOT configuration as the other APIs
from app.config.path_config import (
    PUBLIC_READ_ONLY_PATHS,
    STORAGE_ROOT,
    canonical_rel_path,
    normalize_storage_rel,
    share_mode_of_doc,
    strip_zarr_sidecar,
    zarr_slide_rels,
    is_public_read_only_path,
    is_local_desktop_path,
    resolve_virtual_path,
)

# Quota configuration (default 10GB)
DEFAULT_STORAGE_QUOTA_BYTES = 10 * 1024 * 1024 * 1024


def convert_datetime_for_json(obj):
    """Convert datetime objects to ISO format strings for JSON serialization."""
    # Check if it's a datetime-like object (including DatetimeWithNanoseconds)
    if hasattr(obj, 'isoformat') and callable(getattr(obj, 'isoformat')):
        return obj.isoformat()
    elif isinstance(obj, datetime):
        return obj.isoformat()
    elif isinstance(obj, dict):
        return {key: convert_datetime_for_json(value) for key, value in obj.items()}
    elif isinstance(obj, list):
        return [convert_datetime_for_json(item) for item in obj]
    else:
        return obj


def get_user_root_path(auth_user: AuthUser | None) -> str:
    """Return absolute path of the user's root directory under STORAGE_ROOT.

    If unauthenticated, fall back to samples (no quota enforcement for guests here).
    """
    rel = f"users/{auth_user.uid}" if auth_user and getattr(auth_user, 'uid', None) else "samples"
    return resolve_path(rel)


def normalize_rel_path(rel_path: str) -> str:
    """Normalize a storage-relative path, leaving an absolute one absolute.

    Stripping the leading ``/`` turned ``/Users/me/Downloads/slide.svs`` into
    ``Users/me/Downloads/slide.svs``; callers then resolved that *under the
    storage root*, found it outside ``users/<uid>`` and answered
    USER_FORBIDDEN — a permission error for a file the user owns, on
    ``/fm/v1/files/access``, ``download-link`` and ``delete``.

    POSIX-only damage: a Windows path starts with a drive letter or ``\\``,
    neither of which ``strip('/')`` touches. The ``//`` test keeps a UNC path
    intact on POSIX too, where ``os.path.isabs`` does not recognise one.

    No caller sends a storage-relative path with a leading slash (checked
    across the renderer and the service), so preserving one is unambiguous.
    """
    try:
        rel = (rel_path or '').replace('\\', '/')
        if os.path.isabs(rel_path or '') or rel.startswith('//'):
            return rel.rstrip('/') or rel
        return rel.strip('/')
    except Exception:
        return (rel_path or '').strip('/')


def build_file_id(rel_path: str) -> str:
    # Stable ID derived from relative path (no slashes in Firestore doc id)
    try:
        normalized = normalize_rel_path(rel_path)
        return hashlib.sha1(normalized.encode('utf-8')).hexdigest()
    except Exception:
        return hashlib.md5((rel_path or str(time.time())).encode('utf-8')).hexdigest()


def calculate_directory_size_bytes(directory: str) -> int:
    """Safely calculate total directory size in bytes, skipping temp chunk dir."""
    try:
        total_size = 0
        # Ensure directory exists
        if not os.path.exists(directory):
            return 0
        # Walk directory tree
        for dirpath, dirnames, filenames in os.walk(directory):
            # Skip temp chunk folder anywhere under storage
            if '.temp_chunks' in dirnames:
                dirnames.remove('.temp_chunks')
            for f in filenames:
                try:
                    fp = os.path.join(dirpath, f)
                    if not os.path.islink(fp):
                        total_size += os.path.getsize(fp)
                except Exception:
                    # best-effort; ignore unreadable files
                    pass
        return total_size
    except Exception:
        return 0


def get_user_storage_usage_bytes(uid: str) -> int:
    """Bytes used under the user's storage root.

    Directory-format ``.zarr`` stores are counted as 0, as the hosted file
    table did: walking hundreds of thousands of chunk files on every dashboard
    load is not worth an exact number.
    """
    from app.utils import resolve_path

    root = resolve_path(f"users/{uid}")
    total = 0
    try:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.lower().endswith('.zarr')]
            for name in filenames:
                try:
                    total += os.lstat(os.path.join(dirpath, name)).st_size
                except OSError:
                    continue
    except Exception as e:
        logger.warning(f"[storage_usage] failed to compute usage for uid={uid}: {e}")
        return 0
    return total


def get_user_storage_quota_bytes(auth_user: AuthUser | None) -> int:
    """Quota for the local user: the size of the volume holding the storage root."""
    from app.utils import resolve_path

    try:
        usage = shutil.disk_usage(resolve_path(""))
        return int(usage.total)
    except Exception:
        return DEFAULT_STORAGE_QUOTA_BYTES


def _is_safe_subpath(path: str, allowed_prefix: str) -> bool:
    """Check if a normalized path is safely within the allowed prefix.
    
    Prevents path traversal attacks by normalizing paths before prefix checks.
    For example, 'samples/../users/other' normalizes to 'users/other' and is rejected.
    
    Args:
        path: Relative path to validate
        allowed_prefix: Required directory prefix (e.g., 'samples', 'users/abc123')
    
    Returns:
        True if path is within the allowed prefix after normalization, False otherwise
    """
    # Canonicalize exactly the way resolve_path will — percent-decoding and
    # separator conversion BEFORE '..' is collapsed. Doing it in the other order
    # let `users/<uid>/%2e%2e/other` and `users\\<uid>\\..\\other` through.
    normalized_path = canonical_rel_path(path)
    normalized_prefix = canonical_rel_path(allowed_prefix)
    
    # Exact match or subdirectory match with proper boundary checking
    if normalized_path == normalized_prefix:
        return True
    if normalized_path.startswith(normalized_prefix + '/'):
        return True
    
    return False


def validate_user_access_to_path(auth_user: AuthUser | None, rel_path: str) -> bool:
    """Validate if user has access to the given relative path.

    Args:
        auth_user: The authenticated user (can be None for anonymous users)
        rel_path: Relative path from storage root

    Returns:
        True if user has access, False otherwise
    """
    # Check if path is an absolute path in PUBLIC_READ_ONLY_PATHS (e.g., /data/public)
    # This handles cases where virtual paths resolve to absolute paths
    if os.path.isabs(rel_path):
        # Normalize the path to prevent traversal attacks (resolves symlinks and .. components)
        normalized_path = os.path.realpath(rel_path)
        for public_path in PUBLIC_READ_ONLY_PATHS:
            if public_path.startswith('/'):
                # Normalize public path to prevent traversal attacks
                normalized_public = os.path.realpath(public_path)
                if normalized_path == normalized_public or normalized_path.startswith(f"{normalized_public}/"):
                    return True
        # An absolute form of a managed path: fold it back to the relative one
        # so it meets the same checks as the path a client would normally send.
        folded = normalize_storage_rel(rel_path)
        if folded and not os.path.isabs(folded):
            rel_path = folded
        else:
            # Outside the managed storage roots: the local user's own
            # filesystem. Answer exactly what ``authorize_storage_read_path``
            # answers — the two guards gate the same paths, and letting them
            # drift is how a location one of them allowed became a 403 in the
            # other (docs/local-mode.md).
            return is_local_desktop_path(rel_path)
    
    if not auth_user or auth_user.is_anonymous:
        # Anonymous users can only access samples folder and its subdirectories
        # Use safe subpath check to prevent path traversal attacks
        return _is_safe_subpath(rel_path, 'samples')

    # Authenticated users can access:
    # 1. Their own user folder and subdirectories
    # 2. Samples folder and its subdirectories
    # 3. Files shared with them (checked via FilesRepo)
    # 4. Public files

    user_prefix = f"users/{auth_user.uid}"

    # Check if path is in user's own folder or samples
    # Use safe subpath check to prevent path traversal attacks
    is_user_folder = _is_safe_subpath(rel_path, user_prefix)
    is_samples = _is_safe_subpath(rel_path, 'samples')
    if is_user_folder or is_samples:
        logger.debug(f"[validate_access] Allowed: user_prefix={user_prefix}, rel_path={rel_path}, is_user_folder={is_user_folder}, is_samples={is_samples}")
        return True
    
    logger.debug(f"[validate_access] Checking shared files: user_prefix={user_prefix}, rel_path={rel_path}, is_user_folder={is_user_folder}, is_samples={is_samples}")

    # Check if path is in another user's folder but file is shared or public
    try:
        repo = FilesRepo()
        file_id = build_file_id(rel_path)
        file_doc = repo.get_file(file_id, user_id=auth_user.uid)

        if file_doc and repo.can_access(auth_user.uid, file_doc):
            return True

        # Companion ``slide.svs.zarr`` is not its own share root — grants live
        # on the slide. A sidecar doc with sharedWith=[] (register_zarr_store)
        # must not hide that grant, and must not open parent-folder fallback
        # for an unrelated file that already has a denying doc.
        lookup_rel = strip_zarr_sidecar(rel_path)
        if lookup_rel != rel_path:
            slide_doc = repo.get_file(build_file_id(lookup_rel), user_id=auth_user.uid)
            if slide_doc:
                return repo.can_access(auth_user.uid, slide_doc)
        elif file_doc:
            return False

        # No slide/file document: inherit a parent folder grant if the path exists.
        abs_path = resolve_path(rel_path)
        if os.path.exists(abs_path):
            parent_path = os.path.dirname(lookup_rel.replace('\\', '/')).replace('\\', '/')
            if parent_path and parent_path != lookup_rel:
                parent_file_id = build_file_id(parent_path)
                parent_doc = repo.get_file(parent_file_id, user_id=auth_user.uid)
                if parent_doc and repo.can_access(auth_user.uid, parent_doc):
                    return True

    except Exception as e:
        logger.warning(f"Error validating access to path {rel_path}: {e}")

    return False


def resolve_share_root_doc(auth_user: AuthUser | None, rel_path: str) -> Optional[Dict[str, Any]]:
    """Walk ancestors of *rel_path* looking for a share doc.

    Prefers ``isShareRoot`` / view|collaborate; otherwise returns the first
    share/linkedFrom leaf. Raises on Firestore failures so write guards can
    fail-closed for symlink paths.
    """
    if not auth_user or not getattr(auth_user, 'uid', None):
        return None
    repo = FilesRepo()
    uid = auth_user.uid
    cur = normalize_storage_rel(rel_path)
    seen = set()
    while cur and cur not in seen:
        seen.add(cur)
        for lookup in zarr_slide_rels(cur):
            doc = repo.find_by_owner_and_path(uid, lookup)
            if doc and (doc.get('isShareRoot') or share_mode_of_doc(doc) is not None):
                return doc
        parent = os.path.dirname(cur).replace('\\', '/').strip('/')
        if not parent or parent == cur:
            break
        if parent == f"users/{uid}":
            break
        cur = parent
    return None


def path_involves_symlink(rel_path: str) -> bool:
    try:
        cur = resolve_path(normalize_rel_path(rel_path))
    except Exception:
        return False
    seen = set()
    while cur and cur not in seen:
        seen.add(cur)
        try:
            if os.path.islink(cur):
                return True
        except OSError:
            return False
        parent = os.path.dirname(cur)
        if not parent or parent == cur:
            break
        try:
            if os.path.commonpath([parent, STORAGE_ROOT]) != os.path.normpath(STORAGE_ROOT):
                break
        except ValueError:
            break
        cur = parent
    return False


def get_path_share_mode(auth_user: AuthUser | None, rel_path: str) -> Optional[str]:
    """Return shareMode for *rel_path* if it sits under a shared umbrella."""
    return share_mode_of_doc(resolve_share_root_doc(auth_user, rel_path))


def _permission_error(
    *,
    error_code: str,
    message: str,
    access_mode: str,
    operation: str,
) -> AppError:
    return AppError(
        status_code=403,
        error_code=error_code,
        message=message,
        data={
            "access_mode": access_mode,
            "operation": operation,
        },
    )


def _is_public_read_only_path(path: str) -> bool:
    """Traversal-safe public-path check for aliases, relative and absolute paths."""
    raw = (path or "").replace("\\", "/").strip()
    if not raw:
        return False
    if os.path.isabs(raw):
        candidate = os.path.normcase(os.path.realpath(raw))
        return any(
            os.path.isabs(public_path)
            and (
                candidate == os.path.normcase(os.path.realpath(public_path))
                or candidate.startswith(os.path.normcase(os.path.realpath(public_path)) + os.sep)
            )
            for public_path in PUBLIC_READ_ONLY_PATHS
        )

    normalized = os.path.normpath(raw).replace("\\", "/").strip("/")
    if is_public_read_only_path(normalized):
        return True
    resolved = resolve_virtual_path(normalized)
    return os.path.isabs(resolved) and _is_public_read_only_path(resolved)


def _share_mode_fail_closed(
    auth_user: AuthUser | None,
    rel: str,
    operation: str,
    unavailable_message: str,
) -> Optional[str]:
    """Share mode for *rel*, or fail-closed when a symlink share cannot be verified."""
    try:
        return get_path_share_mode(auth_user, rel)
    except Exception:
        if path_involves_symlink(rel):
            raise _permission_error(
                error_code="VIEW_ACL_UNAVAILABLE",
                message=unavailable_message,
                access_mode="unknown",
                operation=operation,
            )
        return None


def get_restricted_access_mode(
    auth_user: AuthUser | None,
    path: str,
    operation: str,
    unavailable_message: str,
) -> Optional[str]:
    """``"samples"`` | ``"viewer"`` | ``None``. Fail-closed on symlink ACL errors."""
    if _is_public_read_only_path(path):
        return "samples"
    mode = _share_mode_fail_closed(
        auth_user,
        normalize_storage_rel(path),
        operation,
        unavailable_message,
    )
    if mode == "view":
        return "viewer"
    return None


def assert_can_extract_path(
    auth_user: AuthUser | None,
    path: str,
    operation: str,
) -> None:
    """Block byte extraction from Viewer shares and public Samples."""
    if not auth_user or auth_user.is_anonymous:
        raise _permission_error(
            error_code="AUTHENTICATED_DOWNLOAD_REQUIRED",
            message="Sign in with a non-anonymous account to download files.",
            access_mode="anonymous",
            operation=operation,
        )

    mode = get_restricted_access_mode(
        auth_user,
        path,
        operation,
        "Cannot verify share permissions right now. Extraction is blocked.",
    )
    if mode == "samples":
        raise _permission_error(
            error_code="PUBLIC_SAMPLES_EXTRACT_FORBIDDEN",
            message="Downloading files from public Samples is not allowed.",
            access_mode="public_samples",
            operation=operation,
        )
    if mode == "viewer":
        raise _permission_error(
            error_code="VIEW_ONLY_EXTRACT_FORBIDDEN",
            message="Viewer access does not allow downloading or copying this item.",
            access_mode="viewer",
            operation=operation,
        )


def assert_can_access_path(
    auth_user: AuthUser | None,
    path: str,
    operation: str,
) -> None:
    """Convert a read-ACL denial into the standard permission envelope."""
    if not validate_user_access_to_path(auth_user, path):
        logger.warning(
            "[access] denied uid=%s anonymous=%s path=%s operation=%s",
            getattr(auth_user, "uid", None),
            getattr(auth_user, "is_anonymous", True),
            path,
            operation,
        )
        raise _permission_error(
            error_code="USER_FORBIDDEN",
            message="You do not have permission to access this path.",
            access_mode="none",
            operation=operation,
        )


def assert_user_owned_path(
    auth_user: AuthUser | None,
    path: str,
    operation: str,
) -> None:
    """Require a storage-relative path below the caller's own users/<uid> root."""
    rel = os.path.normpath(normalize_rel_path(path)).replace("\\", "/")
    prefix = f"users/{auth_user.uid}" if auth_user and auth_user.uid else ""
    physically_owned = False
    if prefix:
        try:
            owner_root = os.path.realpath(resolve_path(prefix))
            candidate = os.path.realpath(resolve_path(rel))
            physically_owned = os.path.commonpath([candidate, owner_root]) == owner_root
        except (OSError, ValueError):
            physically_owned = False
    if (
        not auth_user
        or auth_user.is_anonymous
        or os.path.isabs(path)
        or not prefix
        or not _is_safe_subpath(rel, prefix)
        or not physically_owned
    ):
        raise _permission_error(
            error_code="PERSONAL_ROOT_REQUIRED",
            message="The candidate must be staged in your Personal workspace.",
            access_mode="personal_only",
            operation=operation,
        )


def assert_can_write_path(
    auth_user: AuthUser | None,
    rel_path: str,
    operation: str = "write",
) -> None:
    """Raise USER_FORBIDDEN when the path is view-only or public read-only.

    Call on every FM mutate entrypoint (create / upload / rename / move /
    compress / write). Public samples are already blocked elsewhere in many
    handlers; this additionally blocks shareMode=view.
    """
    mode = get_restricted_access_mode(
        auth_user,
        rel_path,
        operation,
        (
            "Cannot verify share permissions right now. "
            "Writes through shared links are blocked until access can be confirmed."
        ),
    )
    if mode == "samples":
        raise _permission_error(
            error_code="PUBLIC_READ_ONLY_FORBIDDEN",
            message="Cannot modify the public Samples folder.",
            access_mode="public_samples",
            operation=operation,
        )
    if mode == "viewer":
        raise _permission_error(
            error_code="VIEW_ONLY_FORBIDDEN",
            message="This shared item is Viewer (read-only). Ask the owner for Editor access, or use your Personal workspace.",
            access_mode="viewer",
            operation=operation,
        )


def assert_can_delete_path(auth_user: AuthUser | None, rel_path: str) -> None:
    """Delete rules for view shares.

    Deleting the view umbrella itself (the symlink at the share root) is
    allowed — it only removes the recipient's link. Deleting anything
    *inside* a view tree is forbidden (would mutate the owner's files
    through the symlink).
    """
    rel = normalize_rel_path(rel_path)
    for public_path in PUBLIC_READ_ONLY_PATHS:
        if public_path.startswith('/'):
            continue
        pub = public_path.strip('/')
        if rel == pub or rel.startswith(pub + '/'):
            raise AppErrors.USER_FORBIDDEN()

    try:
        doc = resolve_share_root_doc(auth_user, rel)
    except Exception:
        if path_involves_symlink(rel):
            raise AppError(
                status_code=403,
                error_code="VIEW_ACL_UNAVAILABLE",
                message=(
                    "Cannot verify share permissions right now. "
                    "Deletes through shared links are blocked until access can be confirmed."
                ),
            )
        return
    if not doc:
        return
    mode = (doc.get('shareMode') or '').strip().lower()
    if mode != 'view':
        return
    root = normalize_rel_path(doc.get('localPath') or '')
    if root and rel == root:
        return  # leaving via delete of the umbrella
    raise AppError(
        status_code=403,
        error_code="VIEW_ONLY_FORBIDDEN",
        message="This shared item is Viewer (read-only). You cannot modify it.",
    )


# ── async wrappers ────────────────────────────────────────────────────
#
# Every guard above can reach Firestore, and resolve_share_root_doc climbs the
# ancestor chain with one blocking round trip per level. Called straight from an
# `async def` route they ran ON the event loop, so a ~10-level path froze the
# whole (single-worker) service for the length of ten serial network calls —
# for every other user, not just the caller. Async routes use these.


async def gather_guards(*awaitables) -> None:
    """Run ACL guards concurrently and surface the first failure.

    A bare gather() propagates the first exception but leaves its siblings
    running, and their exceptions are then never retrieved — asyncio logs each
    one as an error. Collect them all, then re-raise the first.
    """
    results = await asyncio.gather(*awaitables, return_exceptions=True)
    for result in results:
        if isinstance(result, BaseException):
            raise result


async def assert_can_access_path_async(
    auth_user: AuthUser | None, path: str, operation: str
) -> None:
    await asyncio.to_thread(assert_can_access_path, auth_user, path, operation)


async def assert_can_write_path_async(
    auth_user: AuthUser | None, rel_path: str, operation: str = "write"
) -> None:
    """Write ACL alone — for a target that does not exist yet.

    Not assert_writable_async: the read guard answers False for a path that is
    not on disk and not under the caller's own root, so pairing it here would
    reject creating a file inside a folder shared with Editor access. The
    parent is what gets the read+write check.
    """
    await asyncio.to_thread(assert_can_write_path, auth_user, rel_path, operation)


async def assert_writable_async(
    auth_user: AuthUser | None, rel_path: str, operation: str = "write"
) -> None:
    """Read ACL then write ACL, in ONE thread hop.

    Every mutate entrypoint needs both, and running them as two awaits paid two
    dispatches to say one thing. The read guard answers an own-folder path from
    string comparison alone (~2us, no Firestore) while the write guard walks the
    ancestor chain over Firestore whatever the path — so the pair belongs in the
    thread the write guard needs anyway.
    """
    def _check() -> None:
        assert_can_access_path(auth_user, rel_path, operation)
        assert_can_write_path(auth_user, rel_path, operation)

    await asyncio.to_thread(_check)


async def assert_deletable_async(auth_user: AuthUser | None, rel_path: str) -> None:
    """Read ACL then delete ACL, in one thread hop. See assert_writable_async."""
    def _check() -> None:
        assert_can_access_path(auth_user, rel_path, "delete")
        assert_can_delete_path(auth_user, rel_path)

    await asyncio.to_thread(_check)


async def assert_can_extract_path_async(
    auth_user: AuthUser | None, path: str, operation: str
) -> None:
    await asyncio.to_thread(assert_can_extract_path, auth_user, path, operation)


async def assert_user_owned_path_async(
    auth_user: AuthUser | None, path: str, operation: str
) -> None:
    """Personal-root guard off the event loop — it realpaths both sides."""
    await asyncio.to_thread(assert_user_owned_path, auth_user, path, operation)


async def validate_user_access_to_path_async(
    auth_user: AuthUser | None, rel_path: str
) -> bool:
    """Boolean read ACL off the event loop.

    Own-folder and samples paths answer from string comparison, but anything
    else walks Firestore — one round trip for the file, one for the slide, one
    for the parent — so an async caller must not run this inline.
    """
    return await asyncio.to_thread(validate_user_access_to_path, auth_user, rel_path)


async def get_path_share_mode_async(
    auth_user: AuthUser | None, rel_path: str
) -> Optional[str]:
    """Share mode off the event loop — resolve_share_root_doc climbs the
    ancestor chain with one blocking Firestore round trip per level."""
    return await asyncio.to_thread(get_path_share_mode, auth_user, rel_path)


async def path_involves_symlink_async(rel_path: str) -> bool:
    """Symlink probe off the event loop — it stats every ancestor."""
    return await asyncio.to_thread(path_involves_symlink, rel_path)


def ensure_quota_or_raise(
    auth_user: AuthUser,
    incoming_bytes: int,
    *,
    inflight_bytes: int = 0,
    staged_on_disk_bytes: int = 0,
):
    """Check user's quota before accepting bytes; raise AppError 429 if exceeded.

    Counts only files under the user's storage root. Server-side staging in
    ``.temp_chunks`` is intentionally excluded from Firestore usage — pass
    ``inflight_bytes`` for open upload sessions so parallel inits cannot over-commit.

    When Firestore is unavailable the fallback directory walk includes pre-allocated
    chunked destinations; pass ``staged_on_disk_bytes`` to avoid double-counting them
    together with ``inflight_bytes``.
    """
    quota = get_user_storage_quota_bytes(auth_user)
    user_root = get_user_root_path(auth_user)
    current_usage = calculate_directory_size_bytes(user_root)
    current_usage = max(0, current_usage - max(0, int(staged_on_disk_bytes)))
    reserved = max(0, int(inflight_bytes)) + max(0, incoming_bytes)
    if current_usage + reserved > quota:
        raise AppErrors.STORAGE_QUOTA_EXCEEDED()


def sanitize_filename(original_name: str) -> str:
    """Sanitize filename to avoid problematic characters across OS/filesystems.
    Preserves the extension and normalizes Unicode to NFKC.
    Preserves Google Drive style " (N)" suffix (e.g. "image (1).png") for keep-both naming.
    """
    try:
        if not original_name:
            return f"file_{int(time.time())}"

        # Normalize Unicode
        name = unicodedata.normalize('NFKC', original_name)

        # Split extension
        base, ext = os.path.splitext(name)
        # If the name starts with a dot and no other chars, treat as base
        if base == '' and ext:
            base = ext
            ext = ''

        # Preserve Google Drive style " (N)" suffix before sanitizing (e.g. "image (1)" -> keep " (1)")
        keep_both_suffix = ""
        _keep_match = re.match(r"^(.+?) \((\d+)\)$", base)
        if _keep_match:
            keep_both_suffix = f" ({_keep_match.group(2)})"
            base = _keep_match.group(1)

        # Replace whitespace (including NBSP-like) with underscore
        whitespace_pattern = re.compile(r"[\s\u00A0\u202F\u2007\u2060\uFEFF]+", re.UNICODE)
        base = whitespace_pattern.sub("_", base)

        # Remove control characters
        base = re.sub(r"[\x00-\x1F\x7F]", "", base)

        # Replace reserved/special characters
        base = re.sub(r"[\\/\:*?\"<>|]", "_", base)  # path/separator + reserved
        base = re.sub(r"[\'`]+", "_", base)
        base = re.sub(r"[\[\]\{\}\#\%\^~\+\=\,;!@]", "_", base)

        # Collapse repeated dots/underscores and trim
        base = re.sub(r"\.+", ".", base)
        base = re.sub(r"_+", "_", base)
        # Preserve leading dot (required for Zarr v2 metadata: .zgroup, .zarray, .zattrs)
        base = base.lstrip("_ ").rstrip("._ ")

        if not base:
            base = "file"

        # Restore Google Drive style " (N)" suffix
        base = base + keep_both_suffix

        # Enforce max length (include extension)
        max_len = 200
        final_name = f"{base}{ext}"
        if len(final_name) > max_len:
            keep = max(1, max_len - len(ext))
            final_name = f"{base[:keep]}{ext}"
        return final_name
    except Exception:
        return f"file_{int(time.time())}"


# Whether another process holds a path open is not answerable up front in a
# portable way: on POSIX an open file can still be renamed and unlinked, so
# there is nothing to detect, and any Windows probe (the old one renamed the
# file to a temp name and back) is both a race and a way to strand a file
# under the wrong name if the process dies mid-probe. Worse, answering it for
# a folder meant walking every file inside it — the cost that made rename,
# move and delete of a .zarr store unusable.
#
# So mutations attempt the operation and classify what the OS reports. These
# two predicates are the single place that mapping lives, and they behave the
# same on every platform.
_WINDOWS_ERROR_ACCESS_DENIED = 5
_WINDOWS_ERROR_SHARING_VIOLATION = 32


def is_path_busy_error(exc: BaseException) -> bool:
    """True when an OS error means another process is holding the path open.

    Windows raises ERROR_SHARING_VIOLATION; POSIX raises EBUSY (a mountpoint,
    or an NFS silly-rename still referenced).
    """
    if not isinstance(exc, OSError):
        return False
    if getattr(exc, 'winerror', None) == _WINDOWS_ERROR_SHARING_VIOLATION:
        return True
    return getattr(exc, 'errno', None) == errno.EBUSY


def is_permission_denied_error(exc: BaseException) -> bool:
    """True when an OS error means the caller may not touch the path.

    Deliberately disjoint from :func:`is_path_busy_error`: CPython raises a
    sharing violation as a ``PermissionError`` with ``errno.EACCES`` and
    ``winerror == 32``, so "in use" has to win over "denied" rather than the
    two overlapping and leaving the answer up to call-site ordering.
    """
    if not isinstance(exc, OSError):
        return False
    if is_path_busy_error(exc):
        return False
    if isinstance(exc, PermissionError):
        return True
    if getattr(exc, 'winerror', None) == _WINDOWS_ERROR_ACCESS_DENIED:
        return True
    return getattr(exc, 'errno', None) in (errno.EACCES, errno.EPERM)
