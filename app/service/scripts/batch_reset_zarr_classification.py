"""
批量重置文件夹下所有 zarr 的 MuskNode 与 SegmentationNode 相关分类数据。

- MuskNode：删除 patch 分类（tissue_*）及 user_annotation
- SegmentationNode 分类：删除 ClassificationNode（细胞核分类 labels/probabilities）及 user_annotation

只做 zarr 文件内数据删除，不触发运行中服务的 handler 重载。

用法:
  # 在 app/service 目录下:
  python scripts/batch_reset_zarr_classification.py <文件夹路径>
  # 或在项目根目录:
  python app/service/scripts/batch_reset_zarr_classification.py <文件夹路径>

可选:
  --dry-run  只列出将要处理的 zarr，不实际删除
"""
from __future__ import annotations

import argparse
import io
import os
import sys

# Windows 控制台默认 cp1252，无法输出中文时改用 UTF-8
if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
elif sys.platform == "win32" and getattr(sys.stdout, "encoding", "").upper() not in ("UTF-8", "UTF8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# 保证从 app/service 或项目根目录运行时可导入 app
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SERVICE_DIR = os.path.dirname(_SCRIPT_DIR)
if _SERVICE_DIR not in sys.path:
    sys.path.insert(0, _SERVICE_DIR)

import zarr
from app.config.zarr_compat import open_zarr, open_zarr_cm


def find_zarr_paths(root_dir: str) -> list[str]:
    """递归查找 root_dir 下所有 .zarr 目录（直接子目录或任意层级）。"""
    root = os.path.abspath(root_dir)
    if not os.path.isdir(root):
        return []
    out = []
    for dirpath, dirnames, _ in os.walk(root, topdown=True):
        for d in dirnames:
            if d.endswith(".zarr"):
                out.append(os.path.join(dirpath, d))
        # 可选：不进入已发现的 .zarr 内部
        dirnames[:] = [d for d in dirnames if not d.endswith(".zarr")]
    return sorted(out)


def is_zarr(path: str) -> bool:
    """简单判断 path 是否为可打开的 zarr 根（存在 .zgroup 或可 open）。"""
    if not os.path.isdir(path):
        return False
    if os.path.isfile(os.path.join(path, "zarr.json")) or os.path.isfile(os.path.join(path, ".zgroup")):
        return True
    try:
        open_zarr(path, mode="r")
        return True
    except Exception:
        return False


def reset_single_zarr_classification(zarr_path: str, dry_run: bool = False) -> dict:
    """
    对单个 zarr 重置 MuskNode 与 SegmentationNode 相关分类：
    - 删除 user_annotation
    - 删除 ClassificationNode（细胞核分类）
    - 删除 MuskNode 下所有 tissue_* 数据集（保留 embedding/coordinates 等）

    返回 {"status": "success"|"error", "message": str, "removed": list}.
    """
    if not os.path.exists(zarr_path):
        return {"status": "error", "message": f"路径不存在: {zarr_path}", "removed": []}
    if not is_zarr(zarr_path):
        return {"status": "error", "message": f"不是有效 zarr 根: {zarr_path}", "removed": []}

    removed = []

    if dry_run:
        with open_zarr_cm(zarr_path, "r") as zf:
            if "User-Annotations" in zf:
                removed.append("User-Annotations")
            if "Cell-Classification" in zf:
                removed.append("Cell-Classification")
            if "Patch-Classification" in zf:
                removed.append("Patch-Classification")
        return {"status": "success", "message": "[dry-run] 未修改文件", "removed": removed}

    try:
        with open_zarr_cm(zarr_path, "a") as zf:
            if "User-Annotations" in zf:
                del zf["User-Annotations"]
                removed.append("User-Annotations")
            if "Cell-Classification" in zf:
                del zf["Cell-Classification"]
                removed.append("Cell-Classification")
            if "Patch-Classification" in zf:
                del zf["Patch-Classification"]
                removed.append("Patch-Classification")
        return {"status": "success", "message": "已重置分类数据", "removed": removed}
    except Exception as e:
        return {"status": "error", "message": str(e), "removed": removed}


def main():
    parser = argparse.ArgumentParser(
        description="批量重置文件夹下所有 zarr 的 MuskNode 与 SegmentationNode 分类"
    )
    parser.add_argument(
        "folder",
        nargs="?",
        default=".",
        help="要扫描的文件夹路径（默认当前目录）",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只列出将要处理的 zarr 及会删除的项，不实际修改",
    )
    args = parser.parse_args()

    folder = os.path.abspath(args.folder)
    if not os.path.isdir(folder):
        print(f"错误: 不是目录或不存在: {folder}")
        sys.exit(1)

    paths = find_zarr_paths(folder)
    if not paths:
        print(f"在 {folder} 下未找到任何 .zarr 目录。")
        sys.exit(0)

    print(f"找到 {len(paths)} 个 zarr，dry_run={args.dry_run}\n")
    ok = 0
    err = 0
    for zp in paths:
        result = reset_single_zarr_classification(zp, dry_run=args.dry_run)
        if result["status"] == "success":
            ok += 1
            removed = result.get("removed", [])
            if removed:
                print(f"  [OK] {zp}")
                for r in removed:
                    print(f"       - {r}")
            else:
                print(f"  [OK] {zp} (无需删除)")
        else:
            err += 1
            print(f"  [FAIL] {zp}")
            print(f"         {result.get('message', '')}")
    print(f"\n完成: 成功 {ok}, 失败 {err}")
    sys.exit(1 if err else 0)


if __name__ == "__main__":
    main()
