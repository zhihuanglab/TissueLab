from __future__ import annotations

from pathlib import Path

from shared_analysis import load_training_cohort


FEATURE_NAME = "example_biomarker"
FEATURE_COLUMN = "feature_value"


def compute_donor_score(
    *,
    donor_id: str,
    data_root: str | Path,
):
    """
    Return one biomarker score for one donor/slide row.

    The evaluator loops over the cohort, calls this function, builds the donor
    table, joins confounds/outcome, and computes all metrics.

    Keep this function portable:
    - recompute from raw data under data_root
    - do not depend on /shared/cache in the final script
    - if you need learned state, save it next to result.py and load via __file__
    """
    data_root = Path(data_root)
    cohort = load_training_cohort(data_root)
    donor_rows = cohort.loc[cohort["donor_id"] == donor_id]
    if donor_rows.empty:
        return None
    slide_name = str(donor_rows.iloc[0]["slide_name"])
    slide_path = data_root / slide_name
    _ = slide_path

    # TODO:
    # 1. Replace this placeholder with the actual biomarker computation.
    # 2. Return a single float or None/NaN when the donor is not analyzable.
    # 3. Keep the function pure: compute the score and return it.
    return None


if __name__ == "__main__":
    raise SystemExit(
        "This template defines compute_donor_score(...). "
        "The evaluator materializes donor_feature_table.csv and computes metrics."
    )
