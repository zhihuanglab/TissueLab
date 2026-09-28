"""Training cases for skill learning: ground truth + per-case JSON and thumbnail.

Layout the experiment supplies:

  <training-dir>/
    GT.csv (or ground_truth.csv)   first column case id, second column label
    problem.md                     task definition (see README)
    cases/<case>/                  *.json = the per-case input the analysis code reads
                                   *.png|*.jpg = thumbnail with the upstream predictions drawn on it
"""
import csv
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional


def norm_label(s: Any) -> str:
    """Labels compare case-insensitively and ignore spaces, underscores and hyphens."""
    return re.sub(r"[\s_\-]+", "", str(s or "")).lower()


class Cases:
    def __init__(self, training_dir: str):
        self.dir = os.path.abspath(training_dir)
        gt_path = next((os.path.join(self.dir, n) for n in ("GT.csv", "ground_truth.csv", "gt.csv")
                        if os.path.isfile(os.path.join(self.dir, n))), None)
        if not gt_path:
            sys.exit(f"ERROR: no GT.csv in {self.dir}")
        self.gt: Dict[str, str] = {}
        with open(gt_path, encoding="utf-8") as f:
            for row in csv.reader(f):
                if not row or row[0].strip().lower() in ("case_id", "slide_name", "case", "id"):
                    continue
                self.gt[row[0].strip()] = row[1].strip()
        cases_dir = os.path.join(self.dir, "cases")
        if not os.path.isdir(cases_dir):
            sys.exit(f"ERROR: {cases_dir} not found")
        self.json: Dict[str, str] = {}
        self.image: Dict[str, Optional[str]] = {}
        for case in sorted(os.listdir(cases_dir)):
            cd = os.path.join(cases_dir, case)
            if not os.path.isdir(cd) or case not in self.gt:
                continue
            files = sorted(os.listdir(cd))
            js = [f for f in files if f.endswith(".json")]
            im = [f for f in files if f.lower().endswith((".png", ".jpg", ".jpeg"))]
            if not js:
                continue
            self.json[case] = os.path.join(cd, js[0])
            self.image[case] = os.path.join(cd, im[0]) if im else None
        self.ids: List[str] = sorted(self.json)
        missing = sorted(set(self.gt) - set(self.json))
        if missing:
            print(f"[data] {len(missing)} GT cases without cases/<case>/ folder are ignored: {missing[:5]}...")

    def __len__(self):
        return len(self.ids)

    def case_text(self, case: str, result: Dict[str, Any], max_chars: int = 6000) -> str:
        """What the reflector reads for one error: labels, the analysis details, an input summary."""
        with open(self.json[case]) as f:
            inp = json.load(f)
        summary = ({k: (f"<{type(v).__name__} len {len(v)}>" if isinstance(v, (list, dict)) else v)
                    for k, v in inp.items()} if isinstance(inp, dict) else str(inp)[:500])
        details = json.dumps(result.get("details"), default=str, indent=1)
        if len(details) > max_chars:
            details = details[:max_chars] + "\n... (truncated)"
        err = result.get("error")
        return (f"Case: {case}\nGround truth: {self.gt[case]}\nPrediction: {result.get('pred')}\n"
                + (f"Analysis code CRASHED: {err}\n" if err else "")
                + f"Input JSON summary: {json.dumps(summary, default=str)}\nAnalysis details:\n{details}\n")
