from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from app.services.agent.discovery.deterministic_evaluator import (
    _panel_score_from_feature_table,
    evaluate_worker_artifacts,
)
from app.services.agent.discovery.worker import _persist_scratch_artifacts
from app.services.agent.discovery.shared_lib_source.shared_analysis.stats import (
    multifeature_residualized_correlation,
    multifeature_loo_predictive_correlation,
)


class PanelStatsTests(unittest.TestCase):
    def test_multifeature_residualized_correlation_returns_finite_signal(self) -> None:
        frame = pd.DataFrame(
            {
                "f1": [0, 1, 2, 3, 4, 5],
                "f2": [0, 1, 0, 1, 0, 1],
                "outcome": [0.1, 0.9, 2.1, 2.9, 4.1, 4.9],
                "age": [70, 71, 72, 73, 74, 75],
                "sex_binary": [0, 1, 0, 1, 0, 1],
            }
        )
        score = multifeature_residualized_correlation(
            frame,
            feature_cols=["f1", "f2"],
            outcome_col="outcome",
            confounds=["age", "sex_binary"],
        )
        self.assertTrue(score == score)
        self.assertGreater(score, 0.7)

    def test_multifeature_loo_predictive_correlation_returns_finite_signal(self) -> None:
        frame = pd.DataFrame(
            {
                "f1": [0, 1, 2, 3, 4, 5],
                "f2": [0, 1, 0, 1, 0, 1],
                "outcome": [0.1, 0.9, 2.1, 2.9, 4.1, 4.9],
                "age": [70, 71, 72, 73, 74, 75],
                "sex_binary": [0, 1, 0, 1, 0, 1],
            }
        )
        score = multifeature_loo_predictive_correlation(
            frame,
            feature_cols=["f1", "f2"],
            outcome_col="outcome",
            confounds=["age", "sex_binary"],
        )
        self.assertTrue(score == score)
        self.assertGreater(score, 0.5)


class PanelEvaluatorTests(unittest.TestCase):
    def test_panel_score_from_feature_table_reports_positive_delta(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            candidate_table = pd.DataFrame(
                {
                    "donor_id": [f"d{i}" for i in range(8)],
                    "candidate_feature": [0, 1, 2, 3, 4, 5, 6, 7],
                }
            )
            candidate_path = root / "candidate.csv"
            candidate_table.to_csv(candidate_path, index=False)

            cohort = pd.DataFrame(
                {
                    "donor_id": [f"d{i}" for i in range(8)],
                    "slope_zmem0": [0.0, 0.9, 2.1, 2.8, 4.2, 5.1, 5.9, 7.2],
                    "max_age_vis": [70, 71, 72, 73, 74, 75, 76, 77],
                    "braak_numeric": [1, 1, 2, 2, 3, 3, 4, 4],
                    "cerad_ordinal": [1, 1, 2, 2, 3, 3, 4, 4],
                    "sex_binary": [0, 1, 0, 1, 0, 1, 0, 1],
                }
            )
            (root / "training_cohort.csv").write_text(cohort.to_csv(index=False), encoding="utf-8")

            panel_frame = pd.DataFrame(
                {
                    "donor_id": [f"d{i}" for i in range(8)],
                    "panel_feature": [0, 0, 1, 1, 2, 2, 3, 3],
                }
            )
            panel_state = {
                "members": [
                    {
                        "feature_name": "panel_feature",
                        "worker_dir": str(root / "dummy_worker"),
                        "results_path": str(root / "dummy_results.json"),
                        "status": "active",
                    }
                ]
            }
            results = {
                "feature_name": "candidate_feature",
                "feature_column": "candidate_feature",
                "outcome": "slope_zmem0",
                "covariates": ["max_age_vis", "braak_numeric", "cerad_ordinal", "sex_binary"],
            }

            with patch(
                "app.services.agent.discovery.deterministic_evaluator._panel_member_feature_frame",
                return_value=(panel_frame, "panel_feature"),
            ):
                metrics = _panel_score_from_feature_table(
                    donor_feature_table_path=candidate_path,
                    data_dir=root,
                    results=results,
                    panel_state=panel_state,
                )

        self.assertIsNotNone(metrics)
        assert metrics is not None
        self.assertEqual(metrics["panel_member_count"], 1)
        self.assertIsNotNone(metrics["panel_candidate_score"])
        self.assertIsNotNone(metrics["panel_candidate_loo_score"])
        self.assertIsNotNone(metrics["candidate_redundancy"])
        self.assertGreater(metrics["delta_panel_score"], 0)

    def test_panel_score_counts_refinement_baseline_even_if_feature_name_matches(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            candidate_table = pd.DataFrame(
                {
                    "donor_id": [f"d{i}" for i in range(8)],
                    "candidate_feature": [0, 1, 2, 3, 4, 5, 6, 7],
                }
            )
            candidate_path = root / "candidate.csv"
            candidate_table.to_csv(candidate_path, index=False)

            cohort = pd.DataFrame(
                {
                    "donor_id": [f"d{i}" for i in range(8)],
                    "slope_zmem0": [0.0, 0.9, 2.1, 2.8, 4.2, 5.1, 5.9, 7.2],
                    "max_age_vis": [70, 71, 72, 73, 74, 75, 76, 77],
                    "braak_numeric": [1, 1, 2, 2, 3, 3, 4, 4],
                    "cerad_ordinal": [1, 1, 2, 2, 3, 3, 4, 4],
                    "sex_binary": [0, 1, 0, 1, 0, 1, 0, 1],
                }
            )
            (root / "training_cohort.csv").write_text(cohort.to_csv(index=False), encoding="utf-8")

            prior_variant_frame = pd.DataFrame(
                {
                    "donor_id": [f"d{i}" for i in range(8)],
                    "prior_variant": [0, 0, 1, 1, 2, 2, 3, 3],
                }
            )
            panel_state = {
                "members": [
                    {
                        "feature_name": "candidate_feature",
                        "worker_dir": str(root / "dummy_worker"),
                        "results_path": str(root / "dummy_results.json"),
                        "status": "active",
                    }
                ]
            }
            results = {
                "feature_name": "candidate_feature",
                "feature_column": "candidate_feature",
                "outcome": "slope_zmem0",
                "covariates": ["max_age_vis", "braak_numeric", "cerad_ordinal", "sex_binary"],
            }

            with patch(
                "app.services.agent.discovery.deterministic_evaluator._panel_member_feature_frame",
                return_value=(prior_variant_frame, "prior_variant"),
            ):
                metrics = _panel_score_from_feature_table(
                    donor_feature_table_path=candidate_path,
                    data_dir=root,
                    results=results,
                    panel_state=panel_state,
                )

        self.assertIsNotNone(metrics)
        assert metrics is not None
        self.assertEqual(metrics["panel_member_count"], 1)
        self.assertIsNotNone(metrics["panel_baseline_score"])
        self.assertIsNotNone(metrics["delta_panel_score"])

    def test_evaluate_worker_artifacts_hard_rejects_ineligible_candidate_from_panel(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            worker_dir = root / "round_0001_worker"
            sandbox_dir = worker_dir / "sandbox"
            sandbox_dir.mkdir(parents=True, exist_ok=True)

            (sandbox_dir / "results.json").write_text(
                '{"status":"ok","feature_name":"candidate_feature","feature_column":"candidate_feature"}\n',
                encoding="utf-8",
            )
            (sandbox_dir / "donor_feature_table.csv").write_text(
                "donor_id,candidate_feature\nA,1\n",
                encoding="utf-8",
            )

            with patch(
                "app.services.agent.discovery.deterministic_evaluator._objective_metrics_from_feature_table",
                return_value=(
                    {
                        "feature_column": "candidate_feature",
                        "partial_r": 1.0,
                        "p_value": 0.0,
                        "ci_lo": 1.0,
                        "ci_hi": 1.0,
                        "loo_predictive_r": 0.8,
                        "selection_score": 1.0,
                        "incumbent_score": None,
                        "coverage_ratio": 0.1714,
                        "coverage_gate_passed": False,
                        "bootstrap_stability_passed": True,
                        "incumbent_eligible": False,
                        "bootstrap_sign_consistency": 1.0,
                        "bootstrap_median_partial_r": 1.0,
                        "loo_unstable_count": 0,
                        "loo_max_shift": 0.0,
                        "n_total": 35,
                        "n_analyzable": 6,
                    },
                    [],
                ),
            ), patch(
                "app.services.agent.discovery.deterministic_evaluator._panel_score_from_feature_table",
                return_value={
                    "panel_member_count": 1,
                    "panel_baseline_score": 0.75,
                    "panel_candidate_score": 1.0,
                    "delta_panel_score": 0.25,
                    "panel_baseline_loo_score": 0.3,
                    "panel_candidate_loo_score": 0.4,
                    "candidate_redundancy": 0.1,
                },
            ):
                evaluation = evaluate_worker_artifacts(
                    worker_name="round_0001_worker",
                    worker_dir=worker_dir,
                    data_dir=root,
                    results_path=sandbox_dir / "results.json",
                    primary_outcome="slope_zmem0",
                    panel_state={"members": []},
                )

        self.assertIsNone(evaluation["results"]["panel_candidate_score"])
        self.assertIsNone(evaluation["results"]["delta_panel_score"])
        self.assertFalse(evaluation["derived"]["incumbent_eligible"])


class WorkerArtifactPersistenceTests(unittest.TestCase):
    def test_persist_scratch_artifacts_copies_sidecars_into_worker_sandbox(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            worker_dir = root / "worker"
            scratch_dir = root / "scratch"
            worker_dir.mkdir(parents=True, exist_ok=True)
            scratch_dir.mkdir(parents=True, exist_ok=True)

            donor_table = scratch_dir / "donor_feature_table.csv"
            donor_table.write_text("donor_id,feature\nA,1\n", encoding="utf-8")
            best_variation = scratch_dir / "best_variation.json"
            best_variation.write_text('{"best_variation":"var_a"}\n', encoding="utf-8")

            results = {
                "artifacts": {
                    "donor_feature_table": "/scratch/donor_feature_table.csv",
                    "best_variation_sidecar": "/scratch/best_variation.json",
                }
            }

            persisted = _persist_scratch_artifacts(
                worker_dir=worker_dir,
                scratch_dir=scratch_dir,
                results=results,
            )

            self.assertEqual(
                persisted["artifacts"]["best_variation_sidecar"],
                "/scratch/best_variation.json",
            )
            self.assertTrue((worker_dir / "sandbox" / "donor_feature_table.csv").exists())
            self.assertTrue((worker_dir / "sandbox" / "best_variation.json").exists())

    def test_persist_scratch_artifacts_skips_copy_when_source_is_already_in_sandbox(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            worker_dir = root / "worker"
            scratch_dir = worker_dir / "sandbox"
            scratch_dir.mkdir(parents=True, exist_ok=True)

            donor_table = scratch_dir / "donor_feature_table.csv"
            donor_table.write_text("donor_id,feature\nA,1\n", encoding="utf-8")

            results = {
                "artifacts": {
                    "donor_feature_table": "/scratch/donor_feature_table.csv",
                }
            }

            persisted = _persist_scratch_artifacts(
                worker_dir=worker_dir,
                scratch_dir=scratch_dir,
                results=results,
            )

            self.assertEqual(
                persisted["artifacts"]["donor_feature_table"],
                "/scratch/donor_feature_table.csv",
            )
            self.assertTrue(donor_table.exists())


if __name__ == "__main__":
    unittest.main()
