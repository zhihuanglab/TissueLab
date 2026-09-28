"""Write a small synthetic discovery cohort into a workspace folder.

    python make_discovery_dataset.py <workspace>

Creates <workspace>/discovery_slides/sNN.zarr (TissueLab schema: Cell-Segmentation
centroids, Cell-Classification with classes Alpha / Beta, one CustomAnnotations
region "Inner") and <workspace>/cases.csv with case ids "001".. (numeric-looking
on purpose), slide paths, mpp, and an outcome `score` that tracks the fraction of
Alpha cells in Inner, plus covariates `age` and `sex`. The scripted discovery
LLM (tests/smoke/mock_discovery_llm.py) proposes exactly that measurement.
"""
import json
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import zarr

N_DONORS = 14
CELLS = 400


def write_slide(path: Path, rng: np.random.Generator, alpha_fraction: float) -> None:
    pts = rng.uniform(0, 1000, size=(CELLS, 2)).astype(np.float32)
    inner = pts[:, 0] < 500
    classes = np.where(inner & (rng.uniform(size=CELLS) < alpha_fraction), 0, 1).astype(np.int32)
    root = zarr.open_group(str(path), mode="w")
    root.create_group("Cell-Segmentation").create_array("centroids", data=pts)
    cls = root.create_group("Cell-Classification")
    cls.create_array("class_indices", data=classes)
    cls.create_group("classes").create_array("name", data=np.array([b"Alpha", b"Beta"], dtype="S16"))
    region = root.create_group("CustomAnnotations").create_group("a1")
    geometry = {"target": {"selector": {"geometry": {"points": [[0, 0], [500, 0], [500, 1000], [0, 1000]]}}}}
    annotation = region.create_array("annotation_json", shape=(), dtype=str)
    annotation[()] = json.dumps(geometry)
    comment = region.create_array("comment", shape=(), dtype=str)
    comment[()] = "Inner"


def main(workspace: Path) -> None:
    warnings.simplefilter("ignore")
    rng = np.random.default_rng(7)
    slides = workspace / "discovery_slides"
    slides.mkdir(parents=True, exist_ok=True)
    rows = []
    for i in range(1, N_DONORS + 1):
        fraction = float(rng.uniform(0.1, 0.9))
        name = f"discovery_slides/s{i:02d}.zarr"
        write_slide(workspace / name, rng, fraction)
        rows.append({
            "case": f"{i:03d}",
            "slide": name,
            "mpp": 0.5,
            "score": round(2.0 * fraction + float(rng.normal(scale=0.05)), 4),
            "age": 60 + i,
            "sex": "F" if i % 2 else "M",
        })
    pd.DataFrame(rows).to_csv(workspace / "cases.csv", index=False)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
