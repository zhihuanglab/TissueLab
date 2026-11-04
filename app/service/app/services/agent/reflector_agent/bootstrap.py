"""Write the initial (skill-free) analysis script from the problem definition alone.

The LLM gets the same system prompt + problem.md as the learning loop, the field structure of one
case JSON and the entry-point contract, and returns a complete script. The script is evaluated on the
training cases; a crash, a per-case exception or a timeout is fed back and the model tries again.
Only the first script that runs on every case is kept — accuracy is not a criterion here, the
skills learned afterwards are what improve it.
"""
import json
import os
import shutil
from typing import Any, Callable, Dict, List, Optional

from .data import Cases
from .distil import extract_code
from .evaluate import EVAL_TIMEOUT, evaluate, score
from .llm import LLM
from .reflect import fill, load_prompt

MAX_TOKENS_BOOTSTRAP = 24000


def _print(msg: str) -> None:
    print(msg, flush=True)


def json_schema_example(path: str, max_items: int = 1, max_points: int = 3) -> Dict[str, Any]:
    """One case JSON with every list shortened to its first element(s) and a note on the length."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    def shorten(v: Any, depth: int = 0) -> Any:
        if isinstance(v, list):
            if not v:
                return []
            head = [shorten(x, depth + 1) for x in v[: (max_points if depth else max_items)]]
            return head + ([f"... {len(v)} items in total"] if len(v) > len(head) else [])
        if isinstance(v, dict):
            return {k: shorten(x, depth + 1) for k, x in v.items()}
        return v

    return shorten(data)


def system_prompt_for(training_dir: str) -> str:
    pm = os.path.join(os.path.abspath(training_dir), "problem.md")
    problem = open(pm, encoding="utf-8").read() if os.path.isfile(pm) else "(no problem.md provided)"
    return load_prompt("system.md") + "\n\n## PROBLEM DEFINITION\n" + problem


def bootstrap_analysis(training_dir: str, out_path: str, model: Optional[str] = None, attempts: int = 3,
                       label_key: str = "diagnosis", timeout: int = EVAL_TIMEOUT, llm: Optional[LLM] = None,
                       log: Callable[[str], None] = _print) -> Dict[str, Any]:
    """Generate, evaluate and (on failure) regenerate the initial script; copy the first working one to out_path.

    Every attempt is kept next to out_path as ``<stem>_attempt<k>.py`` / ``.md`` (the raw reply), and
    ``<stem>_bootstrap.json`` records model, attempts and the score of the accepted script.
    Returns that record; ``accepted`` is False when no attempt ran on all cases.
    """
    cases = Cases(training_dir)
    out_path = os.path.abspath(out_path)
    out_dir, stem = os.path.dirname(out_path), os.path.splitext(os.path.basename(out_path))[0]
    os.makedirs(out_dir, exist_ok=True)
    llm = llm or LLM(model)
    system = system_prompt_for(training_dir)
    schema = json.dumps(json_schema_example(cases.json[cases.ids[0]]), indent=1)
    template = load_prompt("bootstrap.md")
    feedback = ""
    record: Dict[str, Any] = {"model": llm.model, "n_cases": len(cases), "attempts": [], "accepted": False,
                              "out": out_path}
    log(f"[bootstrap] model {llm.model}, {len(cases)} cases, up to {attempts} attempt(s)")
    for k in range(1, attempts + 1):
        user = fill(template, schema=schema, n_cases=len(cases), label_key=label_key, feedback=feedback)
        raw = llm.chat(system, user, max_tokens=MAX_TOKENS_BOOTSTRAP)
        code = extract_code(raw)
        cand = os.path.join(out_dir, f"{stem}_attempt{k}.py")
        open(cand, "w", encoding="utf-8").write(code)
        open(os.path.join(out_dir, f"{stem}_attempt{k}.md"), "w", encoding="utf-8").write(raw)
        log(f"[bootstrap] attempt {k}: {len(code)} chars of code, evaluating (timeout {timeout}s)...")
        results, fatal = evaluate(cand, cases, label_key, os.path.join(out_dir, f"_bootstrap_eval{k}"), timeout)
        crashed: List[str] = [c for c, r in results.items() if r.get("error")]
        entry: Dict[str, Any] = {"attempt": k, "code": cand, "fatal": fatal, "n_crashed": len(crashed)}
        if fatal or crashed:
            problem = fatal or f"{len(crashed)} of {len(cases)} cases raised an exception, e.g. {crashed[0]}:\n{results[crashed[0]]['error'][-800:]}"
            log(f"[bootstrap] attempt {k} failed: {problem[:300]}")
            feedback = ("\n## Previous attempt\nYour previous script failed when run on the training cases:\n```\n"
                        + problem[-2000:] + "\n```\nWrite a new script that avoids this"
                        + (" (it is far too slow: vectorise with numpy and pre-filter with bounding boxes)."
                           if fatal and "timed out" in fatal else ".") + "\n")
            record["attempts"].append(entry)
            continue
        sc = score(results, cases)
        entry["score"] = {"correct": sc["correct"], "n": sc["n"], "accuracy": sc["accuracy"]}
        record["attempts"].append(entry)
        record["accepted"] = True
        shutil.copy2(cand, out_path)
        log(f"[bootstrap] attempt {k} runs on all cases: {sc['correct']}/{sc['n']} correct -> {out_path}")
        break
    with open(os.path.join(out_dir, f"{stem}_bootstrap.json"), "w", encoding="utf-8") as f:
        json.dump(record, f, indent=1, default=str)
    if not record["accepted"]:
        log(f"[bootstrap] no attempt ran on all cases after {attempts} tries")
    return record
