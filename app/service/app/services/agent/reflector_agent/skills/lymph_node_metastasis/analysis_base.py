"""Base downstream analysis for the lymph node metastasis task, before any skill is learned.

The largest predicted tumour region on the slide, measured as the maximum pairwise distance of its
contour vertices and converted to mm with the slide mpp, is mapped to the AJCC category
(> 2.0 mm macro, 0.2-2.0 mm micro, <= 0.2 mm isolated tumour cells; no tumour = negative).
Lymph node contours are not used. It reproduces the pre-skill accuracy of the published experiment and is
the starting point for `learn`; `bootstrap` writes an equivalent script from problem.md with the LLM instead.
"""
import json
import math
from typing import Any, Dict, List, Tuple


def _points(poly: Any) -> List[Tuple[float, float]]:
    pts = []
    if isinstance(poly, dict):
        poly = poly.get("points") or poly.get("contour") or poly.get("coordinates") or []
    for p in poly or []:
        if isinstance(p, dict):
            pts.append((float(p.get("x", 0)), float(p.get("y", 0))))
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            pts.append((float(p[0]), float(p[1])))
    return pts


def _max_pairwise_px(pts: List[Tuple[float, float]], cap: int = 400) -> float:
    if len(pts) < 2:
        return 0.0
    if len(pts) > cap:
        step = len(pts) / cap
        pts = [pts[int(i * step)] for i in range(cap)]
    best = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        for j in range(i + 1, len(pts)):
            d = (x1 - pts[j][0]) ** 2 + (y1 - pts[j][1]) ** 2
            if d > best:
                best = d
    return math.sqrt(best)


def analyze_medical_image(json_path: str) -> Dict[str, Any]:
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)
    mpp = float(data.get("mpp") or 0.25)
    tumors = []
    for i, poly in enumerate(data.get("tumor_contours") or []):
        pts = _points(poly)
        size_mm = _max_pairwise_px(pts) * mpp / 1000.0
        tumors.append({"tumor_index": i, "n_points": len(pts), "max_dimension_mm": round(size_mm, 4)})
    largest = max((t["max_dimension_mm"] for t in tumors), default=None)
    if largest is None or largest <= 0:
        diagnosis = "NEGATIVE"
    elif largest > 2.0:
        diagnosis = "MACROMETASTASIS"
    elif largest > 0.2:
        diagnosis = "MICROMETASTASIS"
    else:
        diagnosis = "ISOLATED_TUMOR_CELLS"
    return {"slide_name": data.get("slide_name"), "mpp": mpp, "diagnosis": diagnosis,
            "largest_tumor_deposit_dimension_mm": largest,
            "counts": {"lymphnode_contours_total": len(data.get("lymphnode_contours") or []),
                       "tumor_contours_total": len(tumors)},
            "tumor_assessments": tumors,
            "rules_applied": {"thresholds_mm": {"macro_gt": 2.0, "micro_gt": 0.2}, "lymph_node_constraint": None}}
