from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.services.agent.discovery.simple_loop import (
    _apply_panel_review,
    _append_results_row,
    _load_or_init_accepted_panel,
    _load_recent_results_text,
    _load_or_init_state,
    _normalize_candidate_plan,
    _select_best_panel_action,
)


class SimpleLoopStateTests(unittest.TestCase):
    def test_normalize_candidate_plan_builds_default_variation(self) -> None:
        plan = _normalize_candidate_plan(
            {"candidate_id": "candidate_a", "scientific_question": "Question A"},
            candidate_type="candidate",
            round_id=3,
        )
        self.assertEqual(plan["candidate_id"], "candidate_a")
        self.assertEqual(plan["candidate_type"], "candidate")
        self.assertEqual(plan["baseline_variation"], "candidate_a")
        self.assertEqual(len(plan["variations"]), 1)

    def test_normalize_candidate_plan_keeps_twenty_unique_variations(self) -> None:
        plan = _normalize_candidate_plan(
            {
                "candidate_id": "candidate_a",
                "scientific_question": "Question A",
                "baseline_variation": "candidate_variant_m",
                "variations": [
                    {"name": "candidate_variant_a", "description": "A"},
                    {"name": "candidate_variant_b", "description": "B"},
                    {"name": "candidate_variant_c", "description": "C"},
                    {"name": "candidate_variant_d", "description": "D"},
                    {"name": "candidate_variant_e", "description": "E"},
                    {"name": "candidate_variant_f", "description": "F"},
                    {"name": "candidate_variant_g", "description": "G"},
                    {"name": "candidate_variant_h", "description": "H"},
                    {"name": "candidate_variant_i", "description": "I"},
                    {"name": "candidate_variant_j", "description": "J"},
                    {"name": "candidate_variant_k", "description": "K"},
                    {"name": "candidate_variant_l", "description": "L"},
                    {"name": "candidate_variant_m", "description": "M"},
                    {"name": "candidate_variant_n", "description": "N"},
                    {"name": "candidate_variant_o", "description": "O"},
                    {"name": "candidate_variant_p", "description": "P"},
                    {"name": "candidate_variant_q", "description": "Q"},
                    {"name": "candidate_variant_r", "description": "R"},
                    {"name": "candidate_variant_s", "description": "S"},
                    {"name": "candidate_variant_t", "description": "T"},
                    {"name": "candidate_variant_u", "description": "U"},
                    {"name": "candidate_variant_c", "description": "duplicate"},
                ],
            },
            candidate_type="candidate",
            round_id=3,
        )
        self.assertEqual(
            [entry["name"] for entry in plan["variations"]],
            [
                "candidate_variant_a",
                "candidate_variant_b",
                "candidate_variant_c",
                "candidate_variant_d",
                "candidate_variant_e",
                "candidate_variant_f",
                "candidate_variant_g",
                "candidate_variant_h",
                "candidate_variant_i",
                "candidate_variant_j",
                "candidate_variant_k",
                "candidate_variant_l",
                "candidate_variant_m",
                "candidate_variant_n",
                "candidate_variant_o",
                "candidate_variant_p",
                "candidate_variant_q",
                "candidate_variant_r",
                "candidate_variant_s",
                "candidate_variant_t",
            ],
        )
        self.assertEqual(plan["baseline_variation"], "candidate_variant_m")

    def test_load_or_init_accepted_panel_creates_empty_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            accepted = _load_or_init_accepted_panel(root)
            self.assertIsNone(accepted["best_panel_score"])
            self.assertEqual(accepted["members"], [])
            self.assertTrue((root / "accepted_panel.json").exists())

    def test_load_or_init_state_keeps_only_config_and_next_round(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            state = _load_or_init_state(
                run_root=root,
                rounds=10,
                model="gpt-5.4",
                reasoning_effort="high",
                worker_wall_clock_sec=600,
                primary_outcome="slope_zmem0",
            )
            self.assertEqual(set(state.keys()), {"next_round_id", "config"})
            self.assertEqual(state["next_round_id"], 1)
            self.assertEqual(state["config"]["rounds"], 10)

    def test_append_results_row_creates_and_appends_tsv(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            _append_results_row(root, {"round_id": 1, "candidate_id": "a", "status": "completed"})
            _append_results_row(root, {"round_id": 2, "candidate_id": "b", "status": "failed"})
            rows = (root / "results.tsv").read_text(encoding="utf-8").strip().splitlines()
            self.assertEqual(len(rows), 3)
            self.assertIn("candidate_id", rows[0])
            self.assertIn("a", rows[1])
            self.assertIn("b", rows[2])

    def test_select_best_panel_action_requires_improvement(self) -> None:
        accepted_panel = {
            "best_panel_score": 0.55,
            "members": [{"feature_name": "seed_feature", "round_id": 1}],
        }
        review = _select_best_panel_action(
            accepted_panel=accepted_panel,
            action_reviews=[
                {
                    "action": "add",
                    "evaluation": {"results": {"panel_candidate_score": 0.45}},
                }
            ],
        )
        self.assertFalse(review["keep"])
        self.assertEqual(review["reason"], "no_improvement")

    def test_select_best_panel_action_accepts_seed(self) -> None:
        accepted_panel = {"best_panel_score": None, "members": []}
        review = _select_best_panel_action(
            accepted_panel=accepted_panel,
            action_reviews=[
                {
                    "action": "add",
                    "evaluation": {"results": {"panel_candidate_score": 0.12}},
                }
            ],
        )
        self.assertTrue(review["keep"])
        self.assertEqual(review["reason"], "seed_panel")
        self.assertEqual(review["accepted_panel_score"], 0.12)

    def test_select_best_panel_action_prefers_replacement_when_it_wins(self) -> None:
        accepted_panel = {
            "best_panel_score": 0.3172,
            "members": [
                {"feature_name": "feature_a", "round_id": 1},
                {"feature_name": "feature_b", "round_id": 2},
            ],
        }
        review = _select_best_panel_action(
            accepted_panel=accepted_panel,
            action_reviews=[
                {
                    "action": "add",
                    "evaluation": {"results": {"panel_candidate_score": 0.3049}},
                },
                {
                    "action": "replace",
                    "slot": 1,
                    "evaluation": {"results": {"panel_candidate_score": 0.341}},
                },
                {
                    "action": "replace",
                    "slot": 2,
                    "evaluation": {"results": {"panel_candidate_score": 0.319}},
                },
            ],
        )
        self.assertTrue(review["keep"])
        self.assertEqual(review["reason"], "replace_slot_1")
        self.assertEqual(review["chosen_review"]["action"], "replace")
        self.assertEqual(review["chosen_review"]["slot"], 1)
        self.assertEqual(review["accepted_panel_score"], 0.341)
        self.assertAlmostEqual(review["accepted_panel_delta"], 0.341 - 0.3172)

    def test_select_best_panel_action_discard_keeps_incumbent_score(self) -> None:
        accepted_panel = {
            "best_panel_score": 0.55,
            "members": [{"feature_name": "seed_feature", "round_id": 1}],
        }
        review = _select_best_panel_action(
            accepted_panel=accepted_panel,
            action_reviews=[
                {
                    "action": "add",
                    "evaluation": {"results": {"panel_candidate_score": 0.45}},
                }
            ],
        )
        self.assertFalse(review["keep"])
        self.assertEqual(review["accepted_panel_score"], 0.55)
        self.assertEqual(review["accepted_panel_delta"], 0.0)

    def test_apply_panel_review_does_not_truncate_added_members(self) -> None:
        accepted_panel = {
            "best_panel_score": 0.6031,
            "members": [
                {"slot": 1, "feature_name": "feature_1", "round_id": 1},
                {"slot": 2, "feature_name": "feature_2", "round_id": 2},
                {"slot": 3, "feature_name": "feature_3", "round_id": 3},
                {"slot": 4, "feature_name": "feature_4", "round_id": 4},
                {"slot": 5, "feature_name": "feature_5", "round_id": 5},
            ],
        }
        updated = _apply_panel_review(
            accepted_panel=accepted_panel,
            round_id=6,
            plan={"candidate_id": "candidate_6"},
            worker_roundup={
                "results": {
                    "feature_name": "feature_6",
                    "panel_candidate_score": 0.6454,
                    "delta_panel_score": 0.0423,
                },
                "worker_dir": "/tmp/round_0006_worker",
                "results_path": "/tmp/round_0006_worker/results.json",
                "result_path": "/tmp/round_0006_worker/result.py",
            },
            review={"chosen_review": {"action": "add"}},
        )
        self.assertEqual(updated["best_panel_score"], 0.6454)
        self.assertEqual(len(updated["members"]), 6)
        self.assertEqual(updated["members"][-1]["slot"], 6)
        self.assertEqual(updated["members"][-1]["feature_name"], "feature_6")

    def test_load_recent_results_text_includes_description_and_delta(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            _append_results_row(
                root,
                {
                    "round_id": 4,
                    "candidate_id": "candidate_4",
                    "description": "A specific scientific question",
                    "decision": "discard",
                    "review_action": "add",
                    "accepted_panel_score": 0.55,
                    "baseline_panel_score": 0.55,
                    "candidate_panel_score": 0.54,
                    "delta_panel_score": -0.01,
                    "accepted_panel_delta": 0.0,
                    "partial_r": 0.2,
                    "status": "completed",
                },
            )
            text = _load_recent_results_text(root)
            self.assertIn("description=A specific scientific question", text)
            self.assertIn("delta=-0.01", text)


if __name__ == "__main__":
    unittest.main()
