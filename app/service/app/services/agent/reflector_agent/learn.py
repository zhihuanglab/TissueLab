"""The skill-learning loop (training time), built from the separately callable steps:

    evaluate.evaluate / score      run the current analysis code, find the errors
    reflect.reflect_errors         thumbnail + text -> failure pattern per error
    distil.distil_skill            reflections + code + knowledge -> one new skill + code
    evaluate.compare               accept only if it fixes >= 1 error and breaks none
    knowledge.KnowledgeBase        append the accepted skill to knowledge.json

Each round is kept under <run-dir>/rounds/round{N}/ so the trajectory is inspectable.
"""
import json
import os
import re
import shutil
from typing import Any, Dict, List, Optional

from .data import Cases
from .distil import distil_skill, fix_code
from .evaluate import compare, evaluate, score
from .knowledge import KnowledgeBase
from .llm import LLM
from .reflect import load_prompt, reflect_errors

PROMPTS_TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompts")
CODE_FIX_RETRIES = 2


def setup_run(training_dir: str, name: str, initial_analysis: Optional[str] = None,
              seed_knowledge: Optional[str] = None) -> Dict[str, str]:
    """Create <training-dir>/<name>/ with frozen prompts, the initial code and the knowledge base."""
    cases_dir = os.path.abspath(training_dir)
    run_dir = os.path.join(cases_dir, name)
    prompts_dir = os.path.join(run_dir, "prompts")
    kb_dir = os.path.join(run_dir, "knowledge_base")
    current = os.path.join(run_dir, "analysis_current.py")
    os.makedirs(os.path.join(run_dir, "rounds"), exist_ok=True)
    if not os.path.isdir(prompts_dir):
        shutil.copytree(PROMPTS_TEMPLATE, prompts_dir)
        pm = os.path.join(cases_dir, "problem.md")
        if os.path.isfile(pm):
            shutil.copy2(pm, os.path.join(prompts_dir, "problem.md"))
    if not os.path.isdir(kb_dir):
        if seed_knowledge:
            kb = KnowledgeBase.seeded_from(seed_knowledge, kb_dir)
            if not initial_analysis and kb.current_code:
                initial_analysis = kb.current_code
        else:
            KnowledgeBase(kb_dir)
    if not os.path.exists(current):
        if not initial_analysis:
            raise SystemExit("ERROR: an initial analysis script is required (--analysis), "
                             "or seed a knowledge base that carries one (--seed-knowledge)")
        shutil.copy2(initial_analysis, current)
        shutil.copy2(initial_analysis, os.path.join(run_dir, "analysis_initial.py"))
    return {"run_dir": run_dir, "prompts_dir": prompts_dir, "kb_dir": kb_dir, "current_code": current,
            "log": os.path.join(run_dir, "log.txt")}


def learn_skills(training_dir: str, name: str = "reflector", initial_analysis: Optional[str] = None,
                 seed_knowledge: Optional[str] = None, rounds: int = 5, max_errors: int = 6,
                 label_key: str = "diagnosis", model: Optional[str] = None, max_rejections: int = 3,
                 llm: Optional[LLM] = None) -> Dict[str, Any]:
    """Run up to ``rounds`` rounds of evaluate -> reflect -> distil -> verify -> record.

    Returns a summary dict (skills learned, final accuracy, paths). Re-running the same
    ``name`` continues from the existing knowledge base and analysis_current.py.
    """
    cases = Cases(training_dir)
    paths = setup_run(training_dir, name, initial_analysis, seed_knowledge)
    run_dir, prompts_dir, current_code = paths["run_dir"], paths["prompts_dir"], paths["current_code"]
    kb = KnowledgeBase(paths["kb_dir"])
    rounds_dir = os.path.join(run_dir, "rounds")

    def log(msg: str):
        print(msg, flush=True)
        with open(paths["log"], "a", encoding="utf-8") as f:
            f.write(msg + "\n")

    system_prompt = (load_prompt("system.md", prompts_dir) + "\n\n## PROBLEM DEFINITION\n"
                     + (open(os.path.join(prompts_dir, "problem.md"), encoding="utf-8").read()
                        if os.path.exists(os.path.join(prompts_dir, "problem.md")) else "(no problem.md provided)"))
    llm = llm or LLM(model)
    log("=" * 60 + f"\nREFLECTOR AGENT: skill learning\nmodel: {llm.model}\ncases: {len(cases)}\n"
        f"run dir: {run_dir}\nknowledge base: {len(kb.skills)} skill(s) to start\n" + "=" * 60)

    existing = sorted(int(m.group(1)) for m in (re.match(r"round(\d+)$", d) for d in os.listdir(rounds_dir)) if m)
    round_num = (existing[-1] + 1) if existing else 1
    rejected_notes: List[str] = []
    rejections = 0
    final_score: Dict[str, Any] = {}

    for _ in range(rounds):
        rd = os.path.join(rounds_dir, f"round{round_num}")
        os.makedirs(rd, exist_ok=True)
        log(f"\n{'#' * 60}\n# ROUND {round_num}\n{'#' * 60}")

        # 1. evaluate
        before, fatal = evaluate(current_code, cases, label_key, os.path.join(rd, "eval_before"))
        if fatal:
            log(f"FATAL: current analysis code cannot be evaluated:\n{fatal}")
            break
        sc = score(before, cases)
        final_score = sc
        log(f"[evaluate] correct {sc['correct']}/{sc['n']} (acc {sc['accuracy']:.4f}); errors: {len(sc['errors'])}"
            + (f"; crashed: {len(sc['crashed'])}" if sc['crashed'] else ""))
        json.dump({"score": sc, "errors": {c: {"gt": cases.gt[c], "pred": before[c].get("pred"), "error": before[c].get("error")}
                                            for c in sc["errors"]}}, open(os.path.join(rd, "errors.json"), "w"), indent=1, default=str)
        if not sc["errors"]:
            log("No errors left on the training set; stopping.")
            break

        # 2. reflect
        reflections = reflect_errors(llm, system_prompt, cases, before, sc["errors"][:max_errors], prompts_dir, log)
        json.dump(reflections, open(os.path.join(rd, "reflections.json"), "w"), indent=1, default=str)

        # 3. distil
        proposal, code, raw = distil_skill(llm, system_prompt, reflections, kb.skills, rejected_notes,
                                           open(current_code, encoding="utf-8").read(), label_key,
                                           len(sc["errors"]), sc["n"], prompts_dir)
        cand = os.path.join(rd, "analysis.py")
        open(cand, "w", encoding="utf-8").write(code)
        json.dump({"proposal": proposal, "raw": raw[:6000]}, open(os.path.join(rd, "proposal.json"), "w"), indent=1)
        log(f"[distil] proposed: {proposal.get('name')} — {str(proposal.get('rule'))[:200]}")

        # 4. verify (with fix retries when the candidate crashes)
        after: Dict[str, Dict[str, Any]] = {}
        fatal = None
        for attempt in range(1 + CODE_FIX_RETRIES):
            after, fatal = evaluate(cand, cases, label_key, os.path.join(rd, f"eval_after{attempt or ''}"))
            crashed = [c for c, r in after.items() if r.get("error")]
            if not fatal and not crashed:
                break
            problem = fatal or f"{len(crashed)} cases crashed, e.g. {crashed[0]}: {after[crashed[0]]['error'][-800:]}"
            log(f"[verify] candidate failed (attempt {attempt + 1}): {problem[:200]}")
            if attempt == CODE_FIX_RETRIES:
                break
            code = fix_code(llm, system_prompt, code, problem)
            open(cand, "w", encoding="utf-8").write(code)
        if fatal or any(r.get("error") for r in after.values()):
            verdict: Dict[str, Any] = {"accepted": False, "reason": "candidate code does not run on all cases"}
        else:
            cmp = compare(before, after, cases)
            accepted = len(cmp["improved"]) >= 1 and len(cmp["regressed"]) == 0
            verdict = {"accepted": accepted, **cmp,
                       "reason": "fixes errors and introduces none" if accepted
                       else f"improved {len(cmp['improved'])}, regressed {len(cmp['regressed'])}"}
        json.dump(verdict, open(os.path.join(rd, "verify.json"), "w"), indent=1)
        log(f"[verify] {'ACCEPTED' if verdict['accepted'] else 'REJECTED'}: {verdict['reason']}"
            + (f" (correct {verdict['correct_before']} -> {verdict['correct_after']})" if "correct_after" in verdict else ""))

        # 5. record
        if verdict["accepted"]:
            rejections = 0
            kb.add_skill({"name": proposal.get("name", f"skill_{len(kb.skills) + 1}"),
                          "rule": proposal.get("rule", ""), "rationale": proposal.get("rationale", ""),
                          "evidence_cases": [r["case"] for r in reflections], "round": round_num,
                          "improved": verdict["improved"], "correct_before": verdict["correct_before"],
                          "correct_after": verdict["correct_after"]}, code_path=cand)
            shutil.copy2(cand, current_code)
            log(f"[record] knowledge base now has {len(kb.skills)} skill(s): {kb.json_path}")
        else:
            rejections += 1
            rejected_notes.append(f"Round {round_num}: '{proposal.get('name')}' — {proposal.get('rule')} => REJECTED: {verdict['reason']}")
            if rejections >= max_rejections:
                log(f"{rejections} consecutive rejected skills; stopping.")
                break
        round_num += 1

    log(f"\nDone. LLM calls: {llm.calls}. Skills: {len(kb.skills)}. Current code: {current_code}")
    return {"skills": kb.skills, "score": final_score, "run_dir": run_dir, "knowledge": kb.json_path,
            "current_code": current_code, "llm_calls": llm.calls}
