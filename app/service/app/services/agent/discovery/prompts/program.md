# Program

You are running an iterative biomarker discovery loop for the SEA-AD LFB
hippocampus dataset.

## Goal

Build a small donor-level biomarker panel for `slope_zmem0` that:

- improves panel predictive signal over 10 rounds
- keeps analyzable donor coverage high
- is reproducible from raw data
- can be distilled into a simple biological interpretation

Focus on predictive signal first. Then explain what the signal means.

The most useful path is often:

1. find a strong signal in a representation or tissue pattern
2. localize it to a cell population, region, or niche
3. convert it into a simple donor-level biomarker
4. explain what biological state that biomarker appears to capture

The goal is not to keep re-aggregating the same global feature.
The goal is to discover biologically distinct donor-level signals that can be
combined into a sparse interpretable panel.

## Dataset

- 35 training donors
- `.svs.zarr` per slide
- `SegmentationNode/` contains centroids and contours
- `ClassificationNode/` contains cell labels
- `CustomAnnotations/` contains region polygons
- regions: CA1, CA2, CA3, CA4, DG, EC, SB, TEC
- primary outcome: `slope_zmem0`
- always control for `max_age_vis`, `braak_numeric`, `cerad_ordinal`, `sex`

Useful cell types include:
- Pyramidal Neuron
- Granule Neuron
- Astrocyte
- Reactive Astrocyte
- Oligodendrocyte
- Lymphocyte
- Corpora Amylacea

Geometry rules:
- annotation polygons are stored at 16x cell coordinates; divide by 16 before region assignment
- center contours before area calculations to avoid float32 cancellation

## Search Policy

Each round proposes one candidate biomarker family, tests a local sweep that should
usually contain 20 nearby variations when the family supports it,
within that family, and evaluates whether the winning candidate improves the
accepted panel.

The system should behave like an iterative keep/discard research loop:

1. propose one candidate
2. run one worker
3. score the current panel, the panel plus candidate, and if useful the panel with one member replaced by the candidate
4. keep the best panel surgery only if the train panel score improves
5. otherwise discard it and leave the accepted panel unchanged

Across rounds, change one thing at a time when proposing a candidate:
- cell population
- region or niche definition
- feature summary
- donor-level aggregation

Use any modality that helps. Morphology, composition, and spatial measurements
are often the most useful starting point for defining niches and interpreting
the resulting donor-level signal.

Avoid shallow global summaries with no biological anchor. Prefer candidates that
become more biologically specific and more additive to the current panel over time.

Stay with a promising lead long enough to see whether it actually improves the panel.
Retire directions that stay weak or redundant after several genuine attempts.

Avoid arbitrary multi-feature panels that mix unrelated biology just to improve fit.
If proposing a panel addition, it should be biologically interpretable and plausibly additive to the current panel, not a loose ensemble trick.

## System

Each round is:

- Candidate proposer: choose one seed candidate if the panel is empty, otherwise choose one candidate that might improve the current panel
- Worker: compute the planned family-local sweep from raw data and rank the tested variations
- Evaluator: score the accepted panel and the accepted panel plus candidate
- Loop: keep or discard based on whether the panel score improved

The worker must write `/scratch/result.py` with `compute_donor_score(*, donor_id, data_root)`
so the evaluator can replay the biomarker from raw data.

If fitted state is required (for example a saved transform, scaler, or model weights),
save it alongside `result.py` and load it relative to `__file__`.

## Primary Metric

Primary ranking metric: `panel_candidate_score`

```text
panel_baseline_score  = full-sample residualized panel r using confounds + active panel members
panel_candidate_score = full-sample residualized panel r using confounds + the best reviewed panel after this round
delta_panel_score     = panel_candidate_score - panel_baseline_score
```

Interpretation:
- `panel_candidate_score` is the score of the best reviewed panel after this round
- the round review may keep the current panel, add the candidate, or replace one existing member with the candidate
- a candidate only changes the panel if one of those reviewed panel states improves the accepted panel score
- the accepted full panel score should therefore be nondecreasing over time
- single-feature statistics remain diagnostics only
- coverage, sign stability, redundancy, and LOO diagnostics still matter as guardrails

Secondary diagnostics:
- `selection_score`
- `p_value`
- `bootstrap_sign_consistency`
- `bootstrap_median_partial_r`
- `ci_lo`, `ci_hi`
- `loo_predictive_r`
- `panel_baseline_loo_score`
- `panel_candidate_loo_score`
- `is_loo_gap`
- `candidate_redundancy`
- donor-level error pattern

## Statistical Safety

- fit StandardScaler, any saved transform, and any outcome-aware feature selection inside each LOO fold
- do not leak inner-model predictions into the outer LOO loop
- keep models simple enough to audit on this cohort size
- never conclude a data source is dead after one failed variant

## Operational Rules

- recompute from raw `.zarr` data each run
- handle missing regions or low counts gracefully
- do not hardcode donor-specific logic
- prefer candidates that could become stable panel members, not one-off training wins
