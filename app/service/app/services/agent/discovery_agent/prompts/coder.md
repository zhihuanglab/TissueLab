# Code Generator

You are generating a Python script for one round of experiments. Refer to the **Problem Definition** for the target variable, dataset, available data, and evaluation criteria.

## Plan for This Round
```
{{PLAN}}
```

## Previous Round Code (reference)
```python
{{PREV_CODE}}
```

## Requirements
1. The script must be **self-contained** and runnable as `python roundN.py`
2. Report **in-sample and LOO (leave-one-out)** metrics:
   - In-sample: fit on all N, predict all N (shows feature relevance)
   - LOO: for each case, fit on N-1, predict the held-out 1. StandardScaler and PCA fitted inside each LOO fold.
   - The **LOO Pearson r** is the PRIMARY evaluation metric (continuous, stable).
   - Also compute IS-LOO gap (in r) and apply gap penalty. Report QWK, F1, Accuracy as reference only.
3. Use continuous predictions clipped to valid range, optimize classification thresholds on in-sample predictions
4. Only access training data. NEVER access testing data.

## Script Structure (MUST FOLLOW)

```python
#!/usr/bin/env python3
"""Round N: [brief description]"""
import os, sys, json, warnings
import numpy as np
import pandas as pd
from scipy.stats import pearsonr, spearmanr
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import (f1_score, cohen_kappa_score, mean_absolute_error,
                             roc_auc_score, accuracy_score)
warnings.filterwarnings("ignore")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.dirname(SCRIPT_DIR)
TRAINING_DIR = os.path.dirname(AGENT_DIR)
RESULTS_DIR = os.path.join(AGENT_DIR, "results")
os.makedirs(RESULTS_DIR, exist_ok=True)

# Discover data directories dynamically
data_dirs = {d: os.path.join(TRAINING_DIR, d)
             for d in os.listdir(TRAINING_DIR)
             if os.path.isdir(os.path.join(TRAINING_DIR, d)) and d != 'agent'}

# Helper functions
# Feature extraction functions
# LOO + IS-LOO gap evaluation

def main():
    # 1. Load GT
    # 2. Extract features (print progress)
    # 3. Print feature-GT correlations (in-sample)
    # 4. In-sample evaluation
    # 5. LOO evaluation
    # 6. LOO metrics + IS-LOO gap penalty
    # 7. Print per-case predictions (LOO)
    # 8. Print per-class accuracy

if __name__ == "__main__":
    main()
```

## Required Output Format
The script MUST print these sections:

```
FEATURE-GT CORRELATIONS:
  feature_name: r=+0.XXX (class_means)

ALL CONFIGURATIONS (sorted by adjusted score):
  config_name: adjusted=X.XXXX (LOO r=X.XXX, gap=X.XXX) [F1=X.XXX QWK=X.XXX]
  ...

BEST MODEL: [name]
  Pearson r:         IS=X.XXXX  LOO=X.XXXX  *** PRIMARY ***
  IS-LOO Gap:        X.XXXX  (penalty=X.XXXX)
  Adjusted Score:    X.XXXX
  --- reference ---
  Macro F1 (LOO):    X.XXXX
  QWK (LOO):         X.XXXX
  Accuracy (LOO):    X.XXXX

PER-CASE (LOO):
  case_id  GT  Pred  Cls  feat1  feat2  ...

PER-CLASS ACCURACY (LOO):
  class=X: N/M correct
  ...
```

## Saving Details
After evaluation, save a details file with ALL configs tested:
```python
details_path = os.path.join(RESULTS_DIR, f"round{ROUND_NUM}_details.txt")
```

## Code Quality
- Use `encoding='utf-8'` for JSON files
- Handle missing data gracefully (return 0.0 if file not found)
- Keep feature extraction modular (one function per feature)
- **CRITICAL: Keep scripts under 800 lines.**
- **CRITICAL: Extract ALL features ONCE (outside the LOO loop).** Build the full feature matrix first. Inside LOO, only do scaling, PCA, and model fitting.
- **With small n, keep total feature count reasonable (aim for <=12).**

## Output
Output ONLY the Python code wrapped in ```python ... ```. No explanation needed.
