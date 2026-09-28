"""Reflect on one training error: thumbnail + text -> the failure pattern the model sees."""
import json
import os
import re
from typing import Any, Dict, List, Optional

from .data import Cases
from .llm import LLM

PROMPTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompts")
MAX_TOKENS_REFLECT = 1500


def load_prompt(name: str, prompts_dir: Optional[str] = None) -> str:
    with open(os.path.join(prompts_dir or PROMPTS_DIR, name), encoding="utf-8") as f:
        return f.read()


def fill(template: str, **kw) -> str:
    for k, v in kw.items():
        template = template.replace("{{" + k.upper() + "}}", str(v))
    return template


def extract_json(text: str) -> Optional[Any]:
    cands = re.findall(r"```json\s*\n(.*?)```", text, re.DOTALL) + [text]
    for c in cands:
        c = c.strip()
        try:
            return json.loads(c)
        except Exception:
            pass
        i, j = c.find("{"), c.rfind("}")
        if i >= 0 and j > i:
            try:
                return json.loads(c[i:j + 1])
            except Exception:
                continue
    return None


def reflect_error(llm: LLM, system_prompt: str, case_text: str, image_path: Optional[str],
                  prompts_dir: Optional[str] = None) -> Dict[str, Any]:
    """One error -> {failure_pattern, evidence, fixable_downstream, candidate_rule, confidence, raw}."""
    template = load_prompt("reflect.md", prompts_dir)
    user = fill(template, case_text=case_text, has_image="yes" if image_path else "no (no thumbnail available)")
    out = llm.chat(system_prompt, user, image_paths=[image_path] if image_path else None,
                   max_tokens=MAX_TOKENS_REFLECT)
    parsed = extract_json(out) or {"failure_pattern": out.strip()}
    parsed["raw"] = out
    return parsed


def reflect_errors(llm: LLM, system_prompt: str, cases: Cases, results: Dict[str, Dict[str, Any]],
                   error_cases: List[str], prompts_dir: Optional[str] = None,
                   log=print) -> List[Dict[str, Any]]:
    """Reflect on each listed error case; returns one dict per case (with "case" filled in)."""
    out = []
    for c in error_cases:
        r = reflect_error(llm, system_prompt, cases.case_text(c, results[c]), cases.image.get(c), prompts_dir)
        r["case"] = c
        out.append(r)
        log(f"[reflect] {c}: GT={cases.gt[c]} pred={results[c].get('pred')} -> {str(r.get('failure_pattern'))[:160]}")
    return out
