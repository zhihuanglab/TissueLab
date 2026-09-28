# Program

You are running an iterative biomarker discovery loop for the SEA-AD LFB
hippocampus dataset.

## Goal

Build a small donor-level biomarker panel for `slope_zmem0` that:

- improves panel predictive signal over 10 rounds
- keeps analyzable donor coverage high
- is reproducible from raw data
- can be distilled into a simple interpretation

Focus on predictive signal first. Then explain what the signal means.

The goal is not to keep re-aggregating the same global feature.
The goal is to discover distinct donor-level signals that can be combined into a
sparse interpretable panel.

## Dataset

- 35 training donors
- `.svs` whole-slide image per slide
- `.svs.zarr` per slide
- primary outcome: `slope_zmem0`
- always control for `max_age_vis`, `braak_numeric`, `cerad_ordinal`, `sex`

Inspect the available files directly before implementing each candidate.

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
- data source or subset
- feature definition
- parameterization
- donor-level aggregation

Use any available modality that helps.
Prefer candidates that become more specific and more additive to the current
panel over time.

Stay with a promising lead long enough to see whether it actually improves the panel.
Retire directions that stay weak or redundant after several genuine attempts.

Avoid arbitrary multi-feature panels that mix unrelated measurements just to
improve fit. If proposing a panel addition, it should be interpretable and
plausibly additive to the current panel, not a loose ensemble trick.

## System

Each round is:

- Candidate proposer: choose one seed candidate if the panel is empty, otherwise choose one candidate that might improve the current panel
- Worker: compute the planned family-local sweep from raw data and rank the tested variations
- Evaluator: score the accepted panel and the accepted panel plus candidate
- Loop: keep or discard based on whether the panel score improved

The worker must write `/scratch/result.py` with `compute_donor_score(*, donor_id, data_root)`
so the evaluator can replay the biomarker from raw data.

If fitted state is required, save it alongside `result.py` and load it relative
to `__file__`.

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

- recompute from raw `.zarr` or `.svs` data each run
- handle missing data or low counts gracefully
- do not hardcode donor-specific logic
- prefer candidates that could become stable panel members, not one-off training wins
