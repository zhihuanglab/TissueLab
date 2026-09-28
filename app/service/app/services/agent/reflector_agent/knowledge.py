"""The knowledge base of learned skills: knowledge.json (machine-readable, what the agent
reads and appends to) + knowledge.md (the same, for people) + a code snapshot per accepted skill.

Nothing about a skill is fixed in code: a skill is a record in knowledge.json (rule text,
rationale, evidence, effect on the training set) plus the analysis script that implements every
skill accepted so far. A knowledge base can be seeded from a previous run (see skills/)."""
import json
import os
import shutil
from typing import Any, Dict, List, Optional


class KnowledgeBase:
    def __init__(self, kb_dir: str):
        self.dir = kb_dir
        os.makedirs(kb_dir, exist_ok=True)
        self.json_path = os.path.join(kb_dir, "knowledge.json")
        self.md_path = os.path.join(kb_dir, "knowledge.md")
        self.skills: List[Dict[str, Any]] = json.load(open(self.json_path)) if os.path.exists(self.json_path) else []

    def add_skill(self, skill: Dict[str, Any], code_path: Optional[str] = None) -> Dict[str, Any]:
        skill = dict(skill)
        skill["index"] = len(self.skills) + 1
        if code_path:
            snap = os.path.join(self.dir, f"analysis_with_skills_{skill['index']}.py")
            shutil.copy2(code_path, snap)
            skill["code"] = os.path.basename(snap)
        self.skills.append(skill)
        self.save()
        return skill

    def save(self) -> None:
        json.dump(self.skills, open(self.json_path, "w"), indent=1)
        with open(self.md_path, "w", encoding="utf-8") as f:
            f.write("# Learned skills (accepted in order; all active in the current analysis code)\n\n")
            for s in self.skills:
                f.write(f"## Skill {s['index']}: {s.get('name')}\n{s.get('rule')}\n\n")
                if s.get("rationale"):
                    f.write(f"Rationale: {s['rationale']}\n\n")
                if "correct_before" in s:
                    f.write(f"Accepted in round {s.get('round')}: correct {s['correct_before']} -> {s['correct_after']}; "
                            f"fixed {', '.join(s.get('improved', []))}; evidence from {', '.join(s.get('evidence_cases', []))}\n\n")
                if s.get("code"):
                    f.write(f"Code: {s['code']}\n\n")

    @classmethod
    def seeded_from(cls, seed_dir: str, kb_dir: str) -> "KnowledgeBase":
        """Start a run's knowledge base from a shipped one (knowledge.json + code snapshots)."""
        os.makedirs(kb_dir, exist_ok=True)
        for name in os.listdir(seed_dir):
            if name == "knowledge.json" or name.endswith(".py"):
                shutil.copy2(os.path.join(seed_dir, name), os.path.join(kb_dir, name))
        kb = cls(kb_dir)
        kb.save()
        return kb

    @property
    def current_code(self) -> Optional[str]:
        """Path of the code snapshot of the last accepted skill, if any."""
        for s in reversed(self.skills):
            if s.get("code") and os.path.exists(os.path.join(self.dir, s["code"])):
                return os.path.join(self.dir, s["code"])
        return None

    def as_prompt_text(self) -> str:
        return "\n".join(f"- Skill {s['index']} [{s.get('name')}]: {s.get('rule')}" for s in self.skills) or "(none yet)"
