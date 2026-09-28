# Learned skills — lymph node metastasis classification (LNCO2)

## Skill 1: tumor_must_overlap_valid_lymph_node
A predicted tumour region counts as evidence of nodal metastasis only if its polygon intersects or lies within a valid predicted lymph node polygon; tumour regions outside every lymph node are ignored.

Rationale: Tumour prediction is not perfectly accurate and some predicted tumour regions fall outside the lymph node area; such regions cannot represent metastatic deposits within the node and are inconsistent with the task.

Source: published experiment (TissueLab paper, Section 2.6, Skill 1)

Reported effect: {"weighted_f1": 0.942, "accuracy": 0.938, "pearson_r": 0.833, "note": "Skill 1 alone, 321 LNCO2 slides; corrected 1 of the 21 base errors"}

Code: analysis_with_skills_2.py

## Skill 2: lymph_node_size_validation
A predicted lymph node polygon is valid only if its ellipse-fit size (PCA of the contour vertices, axes = 2*sqrt(eigenvalues)) is within 1-15 mm short axis and 2-25 mm long axis (converted with the slide mpp); tumour is only counted inside valid lymph nodes.

Rationale: Patch-embedding similarity alone misidentified some large colon-wall regions as lymph node; a size constraint on plausible lymph nodes removes these false positives.

Source: published experiment (TissueLab paper, Section 2.6, Skill 2)

Reported effect: {"weighted_f1": 0.944, "accuracy": 0.941, "pearson_r": 0.85, "note": "Skill 2 alone; corrected 3 base errors, introduced 1. Skills 1+2 together: F1 0.948, acc 0.947, r 0.852; corrected 4, introduced 0 (300 -> 304 of 321). With the VLM reflector on top: F1 0.968, acc 0.969, r 0.933."}

Code: analysis_with_skills_2.py

