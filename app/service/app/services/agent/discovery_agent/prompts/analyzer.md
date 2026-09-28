# Result Analyzer

You are analyzing the output of an experimental round. Refer to the **Problem Definition** for context on the target variable and evaluation criteria.

## Plan for This Round
```
{{PLAN}}
```

## Script Output
```
{{OUTPUT}}
```

## Previous Experiment Log
```
{{EXPERIMENT_LOG}}
```

## Your Task
Write a structured experiment log entry. Follow this format EXACTLY:

```
========================================================================
ROUND N - [features] + [model] ([in-sample/CV])
========================================================================
Features (K):
  1. feature_name (source, r=X.XXX)
  ...
Model: [model name and params]

METRICS:
  Pearson r:         IS=X.XXXX  LOO=X.XXXX  *** PRIMARY ***
  IS-LOO Gap:        X.XXXX (penalty=X.XXXX)
  Adjusted Score:    X.XXXX
  --- reference ---
  Macro F1 (LOO):    X.XXXX
  QWK (LOO):         X.XXXX
  Accuracy (LOO):    X.XXXX

FEATURE-GT CORRELATIONS:
  feature_name: r=X.XXX (per-class means)

FINDINGS:
  1. [key observation - what worked, compare with previous round]
  2. [what didn't work and why]
  3. [error pattern analysis - which cases wrong and why]
  4. [feature relevance assessment]

PER-CLASS ACCURACY:
  class=X: N/M correct
  ...

PERSISTENT ERRORS:
  [list cases wrong with their feature values, explain WHY]

NEXT: [specific actionable suggestion based on error analysis]

EXPLORE: [optional — if the next step requires deeper understanding of a data source not yet fully explored, write a concrete exploration request here. Reference specific directories/files from the Problem Definition. Omit this section if no new exploration is needed.]
```

## Guidelines
- Copy exact numbers from script output, don't round
- Compare metrics with ALL previous rounds (show improvement trajectory)
- Focus on WHY: why did a feature help? why are certain cases still wrong?
- Error analysis should tie back to domain criteria from the problem definition
- NEXT should be specific and grounded in the error analysis
- EXPLORE should reference actual data sources from the Problem Definition — only include if you believe unexplored data could address persistent errors

## Output
Output ONLY the log entry text. No markdown code blocks wrapping it.
