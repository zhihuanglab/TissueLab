"""
Migrate User-Annotations class palettes to the prefixed-key layout.

Background — the storage format evolved through three layouts:
  v1 (oldest): one palette shared by cell + patch at parent-group attrs,
      keys `class_names` / `class_colors`.
  v2 (intermediate): patches also pinned their own palette on the patch
      SUBARRAY attrs (`User-Annotations/patch/.attrs.class_names`).
  v3 (current, target of this script): both palettes live on the PARENT
      group attrs under prefixed keys `cell_class_names` /
      `cell_class_colors` and `patch_class_names` / `patch_class_colors`.

Runtime code only reads v3, so any zarr that still has v1 / v2 data needs
this script before it can be used by the new API.

What this script does for each zarr:
  - Resolve cell palette from the existing layout (v3 → v1) and write to v3.
  - Resolve patch palette (v3 → v2 patch subarray → v1 bare keys) and write to v3.
  - Remove the now-redundant legacy keys (bare parent + patch subarray).
  - Skip files that are already fully v3.

Usage (from `app/service` or project root):

    python scripts/migrate_user_anno_class_palette.py <folder>
    python scripts/migrate_user_anno_class_palette.py <folder> --dry-run

Folder is walked recursively for `*.zarr` directories. Single-zarr paths
also accepted.
"""
from __future__ import annotations

import argparse
import io
import os
import sys

if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

import zarr

try:
    # Auto-converts legacy v2 stores to v3 on open when run inside the service env.
    from app.config.zarr_compat import open_zarr as _open_zarr
except Exception:
    def _open_zarr(p, mode="r", **k):
        k.pop("synchronizer", None)
        return zarr.open(p, mode=mode, **k)


def _decode_list(value):
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [str(v) for v in value]
    return [
        v.decode("utf-8") if isinstance(v, (bytes, bytearray)) else str(v)
        for v in value
    ]


def find_zarr_paths(root: str) -> list[str]:
    """Walk `root` for `.zarr` directories (or return [root] if root itself
    is one)."""
    root = os.path.abspath(root)
    if root.endswith(".zarr") and os.path.isdir(root):
        return [root]
    if not os.path.isdir(root):
        return []
    out = []
    for dirpath, dirnames, _ in os.walk(root, topdown=True):
        for d in dirnames:
            if d.endswith(".zarr"):
                out.append(os.path.join(dirpath, d))
        # Don't descend into found zarrs
        dirnames[:] = [d for d in dirnames if not d.endswith(".zarr")]
    return sorted(out)


def _resolve_cell_palette(group):
    """Return (names, colors, source_tag) for the cell palette, looking at
    v3 → v1. source_tag describes where they came from."""
    attrs = group.attrs
    if "cell_class_names" in attrs:
        return (
            _decode_list(attrs["cell_class_names"]),
            _decode_list(attrs.get("cell_class_colors")),
            "v3",
        )
    if "class_names" in attrs:
        return (
            _decode_list(attrs["class_names"]),
            _decode_list(attrs.get("class_colors")),
            "v1-bare-keys",
        )
    return [], [], "missing"


def _resolve_patch_palette(group):
    """Return (names, colors, source_tag) for the patch palette, looking at
    v3 → v2 (patch subarray attrs) → v1 (bare parent keys, shared with cell
    historically)."""
    attrs = group.attrs
    if "patch_class_names" in attrs:
        return (
            _decode_list(attrs["patch_class_names"]),
            _decode_list(attrs.get("patch_class_colors")),
            "v3",
        )
    if "patch" in group:
        sub_attrs = group["patch"].attrs
        if "class_names" in sub_attrs:
            return (
                _decode_list(sub_attrs["class_names"]),
                _decode_list(sub_attrs.get("class_colors")),
                "v2-patch-subarray",
            )
    if "class_names" in attrs:
        return (
            _decode_list(attrs["class_names"]),
            _decode_list(attrs.get("class_colors")),
            "v1-bare-keys-shared-with-cell",
        )
    return [], [], "missing"


def migrate_one(zarr_path: str, dry_run: bool) -> dict:
    """Returns a small status dict; never raises (caller logs)."""
    status = {
        "path": zarr_path,
        "skipped": None,
        "cell_source": None,
        "cell_count": 0,
        "patch_source": None,
        "patch_count": 0,
        "deleted_legacy": [],
    }
    mode = "r" if dry_run else "a"
    try:
        zf = _open_zarr(zarr_path, mode=mode)
    except Exception as e:
        status["skipped"] = f"open-failed: {e}"
        return status

    if "User-Annotations" not in zf:
        status["skipped"] = "no User-Annotations group"
        return status
    group = zf["User-Annotations"]

    cell_names, cell_colors, cell_src = _resolve_cell_palette(group)
    patch_names, patch_colors, patch_src = _resolve_patch_palette(group)

    status["cell_source"] = cell_src
    status["cell_count"] = len(cell_names)
    status["patch_source"] = patch_src
    status["patch_count"] = len(patch_names)

    # Already-migrated short-circuit. Even when v3 keys are present we still
    # do a cleanup pass on the legacy keys below, so don't return here.
    already_v3 = cell_src == "v3" and patch_src == "v3"

    if dry_run:
        status["skipped"] = "dry-run"
        return status

    # Write v3 keys (idempotent when src=='v3').
    if cell_names:
        group.attrs["cell_class_names"] = list(cell_names)
        group.attrs["cell_class_colors"] = list(cell_colors)
    if patch_names:
        group.attrs["patch_class_names"] = list(patch_names)
        group.attrs["patch_class_colors"] = list(patch_colors)

    # Strip legacy bare keys on parent group.
    for legacy_key in ("class_names", "class_colors"):
        if legacy_key in group.attrs:
            try:
                del group.attrs[legacy_key]
                status["deleted_legacy"].append(f"parent/{legacy_key}")
            except Exception as e:
                status["deleted_legacy"].append(f"parent/{legacy_key}: del-failed: {e}")

    # Strip v2 patch subarray attrs.
    if "patch" in group:
        sub_attrs = group["patch"].attrs
        for legacy_key in ("class_names", "class_colors"):
            if legacy_key in sub_attrs:
                try:
                    del sub_attrs[legacy_key]
                    status["deleted_legacy"].append(f"patch/{legacy_key}")
                except Exception as e:
                    status["deleted_legacy"].append(f"patch/{legacy_key}: del-failed: {e}")

    if already_v3 and not status["deleted_legacy"]:
        status["skipped"] = "already v3 (no legacy to clean)"
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root", help="folder to walk (or a single .zarr path)")
    parser.add_argument("--dry-run", action="store_true", help="report what would change without writing")
    args = parser.parse_args()

    paths = find_zarr_paths(args.root)
    if not paths:
        print(f"No .zarr directories found under {args.root}")
        return 1

    print(f"Found {len(paths)} zarr(s) under {args.root}")
    total_skipped = total_migrated = total_legacy_deleted = 0
    for p in paths:
        s = migrate_one(p, dry_run=args.dry_run)
        if s.get("skipped"):
            total_skipped += 1
            print(
                f"  SKIP  {p}  ({s['skipped']})  cell={s['cell_source']}/{s['cell_count']}  patch={s['patch_source']}/{s['patch_count']}"
            )
        else:
            total_migrated += 1
            total_legacy_deleted += len(s["deleted_legacy"])
            legacy_str = ",".join(s["deleted_legacy"]) if s["deleted_legacy"] else "none"
            print(
                f"  OK    {p}  cell={s['cell_source']}/{s['cell_count']}  patch={s['patch_source']}/{s['patch_count']}  deleted=[{legacy_str}]"
            )

    print()
    print(f"Done. migrated={total_migrated}  skipped={total_skipped}  legacy-keys-deleted={total_legacy_deleted}")
    if args.dry_run:
        print("(dry-run — nothing was written)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
