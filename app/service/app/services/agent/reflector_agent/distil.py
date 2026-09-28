"""Distil one skill from the reflections and implement it in the analysis code."""
import json
import re
from typing import Any, Dict, List, Optional, Tuple

from .llm import LLM
from .reflect import extract_json, fill, load_prompt

MAX_TOKENS_DISTIL = 24000


def extract_code(text: str) -> str:
    m = re.findall(r"```python\s*\n(.*?)```", text, re.DOTALL)
    if m:
        return max(m, key=len)
    m2 = re.search(r"```python\s*\n(.*)", text, re.DOTALL)
    if m2:
        return re.sub(r"`{1,3}\s*$", "", m2.group(1)).rstrip()
    return text.strip()


def distil_skill(llm: LLM, system_prompt: str, reflections: List[Dict[str, Any]],
                 skills: List[Dict[str, Any]], rejected_notes: List[str], current_code: str,
                 label_key: str, n_errors: int, n_cases: int,
                 prompts_dir: Optional[str] = None) -> Tuple[Dict[str, Any], str, str]:
    """Returns (proposal dict, candidate code, raw model output)."""
    template = load_prompt("distil.md", prompts_dir)
    skills_text = "\n".join(f"- Skill {i + 1} [{s.get('name')}]: {s.get('rule')}" for i, s in enumerate(skills)) or "(none yet)"
    user = fill(template,
                reflections=json.dumps([{k: v for k, v in r.items() if k != "raw"} for r in reflections], indent=1, default=str),
                skills=skills_text,
                rejected="\n".join(rejected_notes[-3:]) or "(none)",
                code=current_code, label_key=label_key, n_errors=n_errors, n_cases=n_cases)
    out = llm.chat(system_prompt, user, max_tokens=MAX_TOKENS_DISTIL)
    proposal = extract_json(out.split("```python")[0]) or {}
    return proposal, extract_code(out), out


def fix_code(llm: LLM, system_prompt: str, code: str, problem: str) -> str:
    """Ask for a corrected script when the candidate crashes; the rule must stay the same."""
    out = llm.chat(system_prompt,
                   f"The analysis script below fails when run:\n```\n{problem}\n```\n\n"
                   f"Fix it without changing the rule it implements. Output ONLY the complete corrected "
                   f"script in one ```python block.\n\n```python\n{code}\n```",
                   max_tokens=MAX_TOKENS_DISTIL)
    return extract_code(out)
