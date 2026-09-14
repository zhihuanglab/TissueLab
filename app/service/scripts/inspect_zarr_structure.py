"""
Inspect zarr file structure - list all groups, arrays, shapes and key attrs.
Usage: python -m app.service.scripts.inspect_zarr_structure <path_to.zarr>
"""
import sys
import os

def inspect_zarr(path: str):
    import zarr
    if not os.path.exists(path):
        print(f"Path does not exist: {path}")
        return
    print(f"Opening: {path}\n")
    root = zarr.open(path, mode='r')
    def visit(name, obj, depth=0):
        indent = "  " * depth
        if hasattr(obj, 'shape'):
            # Array
            print(f"{indent}{name}: array shape={obj.shape} dtype={getattr(obj, 'dtype', '?')}")
        elif hasattr(obj, 'keys'):
            # Group
            print(f"{indent}{name}/ (group)")
            if hasattr(obj, 'attrs') and obj.attrs:
                for k, v in list(obj.attrs.items())[:10]:
                    print(f"{indent}  @{k} = {v!r}")
            for k in sorted(obj.keys()):
                visit(k, obj[k], depth + 1)
        else:
            print(f"{indent}{name}: {type(obj)}")
    for key in sorted(root.keys()):
        visit(key, root[key], 0)

if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else r"E:\experiments\TCGA-COAD\patch_demo\TCGA-AD-5900-01Z-00-DX1.ff1dbf00-d9c5-45a2-9732-07b46f4e1471.svs.zarr"
    inspect_zarr(path)
