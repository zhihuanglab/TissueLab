"""Filtering, zarr-grouping, sorting and pagination for a directory listing.

Mirrors the client helpers it took this work over from — ``fileType.utils.ts``
for the predicates, ``fileManager.utils.ts`` for grouping and sorting. Keep them
in sync: the client renders exactly the page produced here, so a divergence
surfaces as rows in the wrong order or a wrong total, not as an error.
"""
from typing import Any, Dict, List, Optional, Tuple

# Mirrors WSI_EXTENSIONS in fileType.utils.ts.
WSI_EXTENSIONS: Tuple[str, ...] = (
    '.svs', '.qptiff', '.tif', '.ndpi', '.tiff', '.jpeg', '.png', '.jpg',
    '.dcm', '.bmp', '.czi', '.nii', '.nii.gz', '.btf', '.isyntax',
)

SORT_KEYS = ('name', 'mtime', 'size', 'type')
SORT_DIRECTIONS = ('asc', 'desc')


def is_wsi(name: str) -> bool:
    return (name or '').lower().endswith(WSI_EXTENSIONS)


def is_zarr_dir(name: str) -> bool:
    return (name or '').lower().endswith('.zarr')


def is_zarr_zip(name: str) -> bool:
    return (name or '').lower().endswith('.zarr.zip')


def is_zarr(name: str) -> bool:
    lower = (name or '').lower()
    return lower.endswith('.zarr') or lower.endswith('.zarr.zip')


def wsi_base_name(name: str) -> str:
    """Strip a trailing ``.zarr`` / ``.zarr.zip`` — mirrors getWSIBaseName."""
    if is_zarr_zip(name):
        return name[: -len('.zarr.zip')]
    if is_zarr_dir(name):
        return name[: -len('.zarr')]
    return name


def format_file_type(name: str) -> str:
    """Value shown in the Type column — mirrors formatFileType.

    Note the JS uses ``split('.').pop()``, which yields the whole name for a
    dotless file (so ``README`` types as ``README``, not ``File``); only an
    empty trailing segment falls through to ``File``. Reproduce that exactly,
    since the Type column is also a sort key.
    """
    extension = (name or '').split('.')[-1]
    if not extension:
        return 'File'
    if is_wsi(name):
        return 'WSI'
    if is_zarr_zip(name):
        return 'zip'
    if is_zarr_dir(name):
        return 'Zarr'
    return extension.upper()


def _text_key(value: str) -> bytes:
    """Sort key that orders text the way JavaScript's ``<`` does.

    JS compares UTF-16 code units, Python code points; they agree across the BMP
    and disagree above it, so an emoji in a filename sorts before U+E000 there
    and after U+FFFD here. UTF-16-BE bytes reproduce the code-unit order exactly.
    Encoded once per row, not once per comparison.
    """
    return value.encode('utf-16-be', 'surrogatepass')


def _is_dir(item: Dict[str, Any]) -> bool:
    return bool(item.get('is_dir'))


def is_folder_row(item: Dict[str, Any]) -> bool:
    """A row the UI treats as a folder. ``.zarr`` stores are directories on
    disk but render (and sort) as files, same as in sortFileTreeData."""
    return _is_dir(item) and not is_zarr(str(item.get('name') or ''))


def filter_dirs_only(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Navigable folders only — used for the "move to" destination picker,
    which must see every folder in the directory, not just the current page."""
    return [item for item in items if is_folder_row(item)]


def filter_image_only(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Drop non-image files — mirrors filterVisibleFiles(showNonImageFiles=false)."""
    return [
        item for item in items
        if _is_dir(item) or is_wsi(str(item.get('name') or '')) or is_zarr(str(item.get('name') or ''))
    ]


def group_wsi_and_zarr(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fold each ``.zarr`` store into its WSI row as ``attachedZarrPath``.

    Mirrors groupWSIAndZarrFiles, and has to run server-side: a slide on page 1
    and its store on page 2 would otherwise surface the store as its own row.
    Matching is by exact base name, then by longest WSI name prefixing the zarr
    name; a store with no match stays a standalone row.
    """
    wsi_by_name: Dict[str, Dict[str, Any]] = {}
    grouped: List[Dict[str, Any]] = []
    zarr_items: List[Dict[str, Any]] = []
    others: List[Dict[str, Any]] = []

    for item in items:
        name = str(item.get('name') or '')
        if is_zarr(name):
            zarr_items.append(item)
        elif not _is_dir(item) and is_wsi(name):
            copy = dict(item)
            wsi_by_name[name] = copy
            grouped.append(copy)
        else:
            others.append(item)

    for zarr in zarr_items:
        zarr_name = str(zarr.get('name') or '')
        parent = wsi_by_name.get(wsi_base_name(zarr_name))
        if parent is None:
            # Bounded by the filename length rather than by how many slides are
            # in the folder; longest prefix wins.
            for end in range(len(zarr_name) - 1, 0, -1):
                candidate = wsi_by_name.get(zarr_name[:end])
                if candidate is not None:
                    parent = candidate
                    break
        if parent is None:
            others.append(zarr)
            continue
        if not parent.get('attachedZarrPath'):
            parent['attachedZarrPath'] = zarr.get('path')

    grouped.extend(others)
    return grouped


def _sort_value(item: Dict[str, Any], sort_by: str):
    name = str(item.get('name') or '')
    if sort_by == 'type':
        return _text_key('folder' if is_folder_row(item) else format_file_type(name))
    if sort_by == 'mtime':
        # Shared listings show "Shared At" in the mtime column.
        shared_at = item.get('sharedAt')
        value = shared_at if shared_at is not None else item.get('mtime')
        try:
            return float(value or 0)
        except (TypeError, ValueError):
            return 0.0
    if sort_by == 'size':
        try:
            return float(item.get('size') or 0)
        except (TypeError, ValueError):
            return 0.0
    return _text_key(name)


def _base_order_key(item: Dict[str, Any]):
    """Total, filesystem-independent order the requested sort then refines.

    Ties are the norm, not an edge case — every folder has size 0, and a Type
    sort puts every slide in one bucket — so what breaks them matters twice
    over. It must match what groupWSIAndZarrFiles left behind (folders first
    with ``.zarr`` counted as files, then mtime descending) or rows move; and it
    must be total, because pages are separate requests and ties falling through
    to readdir order would drop or repeat rows across them. ``name`` is that
    final tiebreak, applied only where the client's own order was arbitrary.
    """
    try:
        mtime = float(item.get('mtime') or 0)
    except (TypeError, ValueError):
        mtime = 0.0
    return (0 if is_folder_row(item) else 1, -mtime, _text_key(str(item.get('name') or '')))


def sort_items(items: List[Dict[str, Any]], sort_by: str, sort_dir: str) -> List[Dict[str, Any]]:
    """Folders first, then the requested key — mirrors sortFileTreeData.

    Three stable passes over a deterministic base order, so ties resolve the way
    the client resolved them. Case-sensitive, like the JS comparator.
    """
    if sort_by not in SORT_KEYS:
        sort_by = 'mtime'
    if sort_dir not in SORT_DIRECTIONS:
        sort_dir = 'desc'
    ordered = sorted(items, key=_base_order_key)
    ordered.sort(key=lambda item: _sort_value(item, sort_by), reverse=(sort_dir == 'desc'))  # noqa: E501
    ordered.sort(key=lambda item: 0 if is_folder_row(item) else 1)
    return ordered


def build_listing_view(
    items: List[Dict[str, Any]],
    *,
    offset: int = 0,
    limit: Optional[int] = None,
    sort_by: str = 'mtime',
    sort_dir: str = 'desc',
    include_non_image: bool = True,
    group_zarr: bool = False,
    dirs_only: bool = False,
) -> Dict[str, Any]:
    """Apply the whole pipeline and return one page plus its pagination block.

    ``total`` counts rows AFTER filtering and grouping, because that is what the
    pager in the UI is counting through. ``limit=0`` means "every row" and still
    answers in the paginated shape.
    """
    rows = items
    if dirs_only:
        rows = filter_dirs_only(rows)
    else:
        if group_zarr:
            rows = group_wsi_and_zarr(rows)
        if not include_non_image:
            rows = filter_image_only(rows)

    rows = sort_items(rows, sort_by, sort_dir)
    total = len(rows)

    # `limit=0` is the explicit "no page limit" request (the pager's "All"):
    # still the paginated shape, still filtered/grouped/sorted here, just not
    # sliced. `limit=None` never reaches this function for a real listing — the
    # caller answers those with the bare whole-directory array instead.
    if limit is None or int(limit) <= 0:
        return {
            'items': rows,
            'pagination': {'offset': 0, 'limit': None, 'total': total, 'has_more': False},
        }

    limit = int(limit)
    # Clamp a stale offset (the directory shrank under the client) onto the last
    # page instead of answering with an empty listing.
    max_offset = ((total - 1) // limit) * limit if total > 0 and limit > 0 else 0
    safe_offset = min(max(0, int(offset)), max_offset)
    end = min(total, safe_offset + limit) if limit > 0 else safe_offset
    return {
        'items': rows[safe_offset:end],
        'pagination': {
            'offset': safe_offset,
            'limit': limit,
            'total': total,
            'has_more': end < total,
        },
    }
