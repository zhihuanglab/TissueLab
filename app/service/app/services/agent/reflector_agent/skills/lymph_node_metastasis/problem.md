# Problem: lymph node metastasis classification (LNCO2, colon adenocarcinoma)

Each case is one H&E whole-slide image of regional lymph node tissue. The final label is one of
`negative`, `isolated_tumor_cells`, `micro_metastasis`, `macro_metastasis` (AJCC, on the largest
metastatic deposit WITHIN a lymph node: > 2.0 mm macro, 0.2-2.0 mm micro, <= 0.2 mm isolated
tumour cells; no deposit within a lymph node = negative).

## Upstream predictions (fixed) — per-case JSON
- `slide_name`, `mpp` (microns per level-0 pixel)
- `lymphnode_contours`: polygons ([x, y], level-0 pixels) predicted as lymph node by a patch
  classifier on MUSK embeddings. Can be wrong: colon wall, fat, capsule or stroma with lymph-node-like
  image features are sometimes predicted as lymph node; some polygons are far too small or too large
  for a lymph node.
- `tumor_contours`: polygons predicted as tumour by a patch classifier. Can be wrong, and some lie
  outside any lymph node, where they are not evidence of nodal metastasis.
- `rois`: regions of interest (informational).

## Thumbnail
`overview.png`: the slide overview with predicted lymph node and tumour contours drawn on it.

## Downstream analysis script
`analyze_medical_image(json_path) -> dict`, label under `"diagnosis"` (NEGATIVE /
ISOLATED_TUMOR_CELLS / MICROMETASTASIS / MACROMETASTASIS; case and underscores ignored when scoring),
plus inspectable details (per-contour measurements, which deposits were counted, rules applied).
