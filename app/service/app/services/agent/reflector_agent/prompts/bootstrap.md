No downstream analysis script exists yet. Write the INITIAL one for the task in the Problem Definition:
a straightforward implementation of the task's criteria using only the quantities in the per-case JSON.
Do not add error-correction heuristics; corrective skills are learned later from the errors this script
makes.

## The per-case JSON ({{N_CASES}} training cases; one example, list values abbreviated)
```json
{{SCHEMA}}
```

## Requirements
- Entry point `analyze_medical_image(json_path) -> dict`; the label under the key "{{LABEL_KEY}}" with the
  label vocabulary given in the Problem Definition; plus inspectable details (per-region measurements in
  physical units, which regions were counted, the parameters used).
- Self-contained: standard library plus numpy only. Read no file other than the given JSON. Never
  special-case individual case names.
- Fast: polygons can have tens of thousands of vertices and a case can hold hundreds of them. Use numpy
  vectorisation and bounding-box pre-filtering; never loop over every vertex pair of two polygons in
  pure Python. The whole training set must evaluate in a few minutes.
{{FEEDBACK}}
Output the complete script in ONE ```python block and nothing else.
