"""
Skill 1 + Skill 2 combined.
Skill 1: count tumor only when overlapping a valid lymph node polygon.
Skill 2: size threshold via ellipse fit to the deposit.
Classification: macro / micro / ITC / negative per AJCC thresholds.
"""

from typing import Dict, Any, List, Tuple, Optional
import json
import math
import os


def analyze_medical_image(json_path: str) -> Dict[str, Any]:
    """
    Diagnose LN metastasis category based on tumor contours overlapping valid lymph node contours.

    Input JSON schema:
      {
        "slide_name": str,
        "mpp": float,  # microns per pixel
        "lymphnode_contours": [ [ [x,y], ... ], ... ],
        "tumor_contours":     [ [ [x,y], ... ], ... ]
      }

    Rules:
      - rule3: LN contour valid if polygon has >=3 points, positive area,
               and ellipse-fit size in mm: short in [1,15], long in [2,25]
      - rule1: Tumor counted as metastasis only if it intersects/within ANY valid LN polygon
      - Diagnosis based on largest dimension (mm) among counted tumor deposits:
          >2.0 macro
          (0.2,2.0] micro
          <=0.2 ITC (but at least one counted)
          none counted -> negative
    """
    # -----------------------------
    # Basic IO / validation
    # -----------------------------
    if not os.path.isfile(json_path):
        raise FileNotFoundError(f"JSON path does not exist: {json_path}")

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    slide_name = data.get("slide_name", None)
    mpp = data.get("mpp", None)
    ln_contours = data.get("lymphnode_contours", []) or []
    tumor_contours = data.get("tumor_contours", []) or []

    notes: List[str] = []
    if slide_name is None:
        slide_name = os.path.basename(json_path)
        notes.append("slide_name missing in JSON; used filename as fallback.")
    if mpp is None or not isinstance(mpp, (int, float)) or mpp <= 0:
        # Without mpp we cannot do mm thresholds; but task requires.
        raise ValueError("Missing/invalid mpp in JSON; cannot compute mm measurements.")

    # -----------------------------
    # Geometry helpers (no shapely)
    # -----------------------------
    EPS = 1e-12

    def _as_points(poly: Any) -> List[Tuple[float, float]]:
        pts: List[Tuple[float, float]] = []
        if not isinstance(poly, list):
            return pts
        for p in poly:
            if (isinstance(p, (list, tuple)) and len(p) >= 2
                    and isinstance(p[0], (int, float)) and isinstance(p[1], (int, float))):
                pts.append((float(p[0]), float(p[1])))
        # Remove last point if it repeats first (common in closed contours)
        if len(pts) >= 2 and (abs(pts[0][0] - pts[-1][0]) < EPS and abs(pts[0][1] - pts[-1][1]) < EPS):
            pts = pts[:-1]
        return pts

    def polygon_area_signed(pts: List[Tuple[float, float]]) -> float:
        # Shoelace formula; positive if CCW
        n = len(pts)
        if n < 3:
            return 0.0
        s = 0.0
        for i in range(n):
            x1, y1 = pts[i]
            x2, y2 = pts[(i + 1) % n]
            s += x1 * y2 - x2 * y1
        return 0.5 * s

    def polygon_area(pts: List[Tuple[float, float]]) -> float:
        return abs(polygon_area_signed(pts))

    def point_on_segment(px, py, ax, ay, bx, by) -> bool:
        # colinear and within bounding box
        cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
        if abs(cross) > 1e-9:
            return False
        dot = (px - ax) * (px - bx) + (py - ay) * (py - by)
        return dot <= 1e-9

    def point_in_polygon(pt: Tuple[float, float], poly: List[Tuple[float, float]]) -> bool:
        # Ray casting; boundary treated as inside
        x, y = pt
        n = len(poly)
        if n < 3:
            return False

        inside = False
        for i in range(n):
            x1, y1 = poly[i]
            x2, y2 = poly[(i + 1) % n]

            # boundary check
            if point_on_segment(x, y, x1, y1, x2, y2):
                return True

            # Ray casting on y
            intersects = ((y1 > y) != (y2 > y))
            if intersects:
                x_at_y = x1 + (y - y1) * (x2 - x1) / (y2 - y1 + 0.0)
                if x_at_y >= x - 1e-15:
                    inside = not inside
        return inside

    def seg_intersect(a, b, c, d) -> bool:
        # Proper segment intersection including colinear overlaps
        ax, ay = a
        bx, by = b
        cx, cy = c
        dx, dy = d

        def orient(p, q, r) -> float:
            return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

        def on_seg(p, q, r) -> bool:
            # q on pr
            return (min(p[0], r[0]) - 1e-9 <= q[0] <= max(p[0], r[0]) + 1e-9 and
                    min(p[1], r[1]) - 1e-9 <= q[1] <= max(p[1], r[1]) + 1e-9 and
                    abs(orient(p, q, r)) <= 1e-9)

        o1 = orient((ax, ay), (bx, by), (cx, cy))
        o2 = orient((ax, ay), (bx, by), (dx, dy))
        o3 = orient((cx, cy), (dx, dy), (ax, ay))
        o4 = orient((cx, cy), (dx, dy), (bx, by))

        # General case
        if (o1 > 0) != (o2 > 0) and (o3 > 0) != (o4 > 0):
            return True

        # Colinear / touching
        if abs(o1) <= 1e-9 and on_seg((ax, ay), (cx, cy), (bx, by)):
            return True
        if abs(o2) <= 1e-9 and on_seg((ax, ay), (dx, dy), (bx, by)):
            return True
        if abs(o3) <= 1e-9 and on_seg((cx, cy), (ax, ay), (dx, dy)):
            return True
        if abs(o4) <= 1e-9 and on_seg((cx, cy), (bx, by), (dx, dy)):
            return True

        return False

    def polygons_intersect(poly_a: List[Tuple[float, float]], poly_b: List[Tuple[float, float]]) -> bool:
        # 1) any edge intersects
        na = len(poly_a)
        nb = len(poly_b)
        if na < 3 or nb < 3:
            return False

        for i in range(na):
            a1 = poly_a[i]
            a2 = poly_a[(i + 1) % na]
            for j in range(nb):
                b1 = poly_b[j]
                b2 = poly_b[(j + 1) % nb]
                if seg_intersect(a1, a2, b1, b2):
                    return True

        # 2) containment: one polygon vertex inside the other
        if point_in_polygon(poly_a[0], poly_b):
            return True
        if point_in_polygon(poly_b[0], poly_a):
            return True
        return False

    def bbox_from_poly(pts: List[Tuple[float, float]]) -> Optional[Tuple[float, float, float, float]]:
        if not pts:
            return None
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return (min(xs), min(ys), max(xs), max(ys))

    def bbox_intersects(b1, b2) -> bool:
        x1min, y1min, x1max, y1max = b1
        x2min, y2min, x2max, y2max = b2
        return not (x1max < x2min or x2max < x1min or y1max < y2min or y2max < y1min)

    def polygon_max_pairwise_distance_px(pts: List[Tuple[float, float]]) -> float:
        # Largest dimension as maximum Euclidean distance between vertices (O(n^2))
        # Adequate for typical contour sizes; if extremely large, could subsample.
        n = len(pts)
        if n < 2:
            return 0.0
        maxd2 = 0.0
        for i in range(n):
            xi, yi = pts[i]
            for j in range(i + 1, n):
                xj, yj = pts[j]
                dx = xi - xj
                dy = yi - yj
                d2 = dx * dx + dy * dy
                if d2 > maxd2:
                    maxd2 = d2
        return math.sqrt(maxd2)

    # Ellipse-fit approximation via PCA of polygon vertices.
    # We interpret long/short axes as 2*sqrt(eigenvalue) (covers ~1 stddev);
    # used only for LN validity ranges; we document this assumption.
    notes.append(
        "LN size validation uses PCA-based ellipse approximation from contour vertices "
        "(axes ~= 2*sqrt(eigenvalues) in pixels). This is an approximation to an ellipse-fit."
    )

    def pca_axes_px(pts: List[Tuple[float, float]]) -> Tuple[float, float]:
        n = len(pts)
        if n < 3:
            return (0.0, 0.0)
        mx = sum(p[0] for p in pts) / n
        my = sum(p[1] for p in pts) / n
        sxx = 0.0
        syy = 0.0
        sxy = 0.0
        for x, y in pts:
            dx = x - mx
            dy = y - my
            sxx += dx * dx
            syy += dy * dy
            sxy += dx * dy
        sxx /= max(n - 1, 1)
        syy /= max(n - 1, 1)
        sxy /= max(n - 1, 1)

        # eigenvalues of 2x2 covariance
        tr = sxx + syy
        det = sxx * syy - sxy * sxy
        disc = tr * tr - 4.0 * det
        disc = max(disc, 0.0)
        lam1 = 0.5 * (tr + math.sqrt(disc))
        lam2 = 0.5 * (tr - math.sqrt(disc))
        lam1 = max(lam1, 0.0)
        lam2 = max(lam2, 0.0)

        # axis lengths proxy
        long_axis = 2.0 * math.sqrt(max(lam1, lam2))
        short_axis = 2.0 * math.sqrt(min(lam1, lam2))
        return (short_axis, long_axis)

    # -----------------------------
    # Validate lymph node contours (rule3)
    # -----------------------------
    ln_validation: List[Dict[str, Any]] = []
    valid_ln_polys: List[List[Tuple[float, float]]] = []
    valid_ln_bboxes: List[Tuple[float, float, float, float]] = []

    for idx, raw in enumerate(ln_contours):
        pts = _as_points(raw)
        entry: Dict[str, Any] = {"ln_index": idx, "n_points": len(pts)}
        if len(pts) < 3:
            entry["valid"] = False
            entry["reason"] = "too_few_points"
            ln_validation.append(entry)
            continue

        area = polygon_area(pts)
        entry["area_px2"] = area
        if not (area > 0.0):
            entry["valid"] = False
            entry["reason"] = "non_positive_area"
            ln_validation.append(entry)
            continue

        short_px, long_px = pca_axes_px(pts)
        short_mm = short_px * float(mpp) / 1000.0
        long_mm = long_px * float(mpp) / 1000.0
        entry.update({
            "ellipse_short_axis_px": short_px,
            "ellipse_long_axis_px": long_px,
            "short_axis_mm": short_mm,
            "long_axis_mm": long_mm
        })

        # rule3 size bounds
        size_ok = (1.0 <= short_mm <= 15.0) and (2.0 <= long_mm <= 25.0)
        entry["valid"] = bool(size_ok)
        if not size_ok:
            entry["reason"] = "size_out_of_typical_range"
        else:
            entry["reason"] = None
            valid_ln_polys.append(pts)
            bb = bbox_from_poly(pts)
            if bb is None:
                # should not happen given pts non-empty
                entry["valid"] = False
                entry["reason"] = "bbox_failed"
            else:
                valid_ln_bboxes.append(bb)

        ln_validation.append(entry)

    # -----------------------------
    # Assess tumor contours; count as metastasis if overlaps any valid LN (rule1)
    # -----------------------------
    tumor_assessments: List[Dict[str, Any]] = []
    counted_tumor_indices: List[int] = []
    deposit_dims_mm: List[float] = []

    for tidx, raw in enumerate(tumor_contours):
        tpts = _as_points(raw)
        t_entry: Dict[str, Any] = {"tumor_index": tidx, "n_points": len(tpts)}
        if len(tpts) < 3:
            t_entry["counted_as_metastasis"] = False
            t_entry["reason"] = "too_few_points"
            tumor_assessments.append(t_entry)
            continue

        t_area = polygon_area(tpts)
        t_entry["area_px2"] = t_area
        if not (t_area > 0.0):
            t_entry["counted_as_metastasis"] = False
            t_entry["reason"] = "non_positive_area"
            tumor_assessments.append(t_entry)
            continue

        # Largest dimension for diagnostic criteria
        t_dim_px = polygon_max_pairwise_distance_px(tpts)
        t_dim_mm = t_dim_px * float(mpp) / 1000.0
        t_entry["largest_dimension_px"] = t_dim_px
        t_entry["largest_dimension_mm"] = t_dim_mm

        # Overlap with any valid LN
        overlaps = False
        overlap_ln_index: Optional[int] = None
        tbb = bbox_from_poly(tpts)
        if tbb is None:
            overlaps = False
        else:
            for ln_i, (ln_poly, lnbb) in enumerate(zip(valid_ln_polys, valid_ln_bboxes)):
                # quick reject by bbox
                if not bbox_intersects(tbb, lnbb):
                    continue
                if polygons_intersect(tpts, ln_poly):
                    overlaps = True
                    overlap_ln_index = ln_i
                    break

        if overlaps:
            t_entry["counted_as_metastasis"] = True
            t_entry["overlaps_valid_ln"] = True
            t_entry["overlap_valid_ln_list_index"] = overlap_ln_index
            t_entry["reason"] = None
            counted_tumor_indices.append(tidx)
            deposit_dims_mm.append(t_dim_mm)
        else:
            t_entry["counted_as_metastasis"] = False
            t_entry["overlaps_valid_ln"] = False
            t_entry["reason"] = "no_overlap_with_any_valid_ln"

        tumor_assessments.append(t_entry)

    # -----------------------------
    # Diagnosis
    # -----------------------------
    tumor_count_total = len(tumor_contours)
    tumor_count_counted = len(counted_tumor_indices)
    ln_total = len(ln_contours)
    ln_valid = len(valid_ln_polys)

    if tumor_count_counted == 0:
        diagnosis = "NEGATIVE"
        largest_mm = None
    else:
        largest_mm = max(deposit_dims_mm) if deposit_dims_mm else None
        if largest_mm is None:
            diagnosis = "NEGATIVE"
        elif largest_mm > 2.0:
            diagnosis = "MACROMETASTASIS"
        elif largest_mm > 0.2:
            diagnosis = "MICROMETASTASIS"
        else:
            diagnosis = "ISOLATED_TUMOR_CELLS"

    result: Dict[str, Any] = {
        "slide_name": slide_name,
        "mpp": float(mpp),
        "diagnosis": diagnosis,
        "largest_tumor_deposit_dimension_mm": largest_mm,
        "counts": {
            "lymphnode_contours_total": ln_total,
            "lymphnode_contours_valid": ln_valid,
            "tumor_contours_total": tumor_count_total,
            "tumor_contours_counted_as_metastasis": tumor_count_counted,
        },
        "lymph_node_validation": ln_validation,
        "tumor_assessments": tumor_assessments,
        "notes": notes,
        "rules_applied": {
            "rule1_tumor_must_overlap_valid_ln": True,
            "rule3_ln_size_validation_mm_ranges": {
                "short_axis_mm_min": 1.0,
                "short_axis_mm_max": 15.0,
                "long_axis_mm_min": 2.0,
                "long_axis_mm_max": 25.0
            },
            "diagnostic_thresholds_mm": {
                "macrometastasis_gt": 2.0,
                "micrometastasis_gt": 0.2,
                "itc_leq": 0.2
            }
        }
    }
    return result