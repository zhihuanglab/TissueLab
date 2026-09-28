"""Command line for the reflector agent.

    python -m app.services.agent.reflector_agent learn  --training-dir <dir> --analysis base.py --name r1 --rounds 5
    python -m app.services.agent.reflector_agent learn  --training-dir <dir> --seed-knowledge skills/lymph_node_metastasis
    python -m app.services.agent.reflector_agent filter --case-json c.json --crops-dir <case>/ \
        --prompt skills/lymph_node_metastasis/reflector_prompt.json --out filtered.json
    python -m app.services.agent.reflector_agent evaluate --training-dir <dir> --analysis code.py
"""
import argparse
import json
import os
import sys


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m app.services.agent.reflector_agent",
                                 description="Strategy-level co-evolution: learn corrective skills from errors; VLM reflector filter")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("learn", help="evaluate -> reflect -> distil -> verify -> record, for N rounds")
    p.add_argument("--training-dir", required=True)
    p.add_argument("--name", default="reflector")
    p.add_argument("--analysis", default="", help="initial analysis script (analyze_medical_image)")
    p.add_argument("--seed-knowledge", default="", help="directory with knowledge.json + code to start from")
    p.add_argument("--rounds", type=int, default=5)
    p.add_argument("--max-errors", type=int, default=6)
    p.add_argument("--label-key", default="diagnosis")
    p.add_argument("--model", default="")
    p.add_argument("--max-rejections", type=int, default=3)

    p = sub.add_parser("evaluate", help="score an analysis script on the training cases (no LLM)")
    p.add_argument("--training-dir", required=True)
    p.add_argument("--analysis", required=True)
    p.add_argument("--label-key", default="diagnosis")
    p.add_argument("--out", default="", help="write per-case results JSON here")

    p = sub.add_parser("filter", help="VLM reflector: keep/exclude each predicted region of one case")
    p.add_argument("--case-json", required=True)
    p.add_argument("--crops-dir", required=True, help="case folder with <crops_subdir>/<i>/image.png crops")
    p.add_argument("--prompt", required=True, help="reflector prompt JSON (system, user, context, contours_key, crops_subdir)")
    p.add_argument("--subdir", default="", help="override the prompt file's crops_subdir")
    p.add_argument("--contours-key", default="", help="override the prompt file's contours_key")
    p.add_argument("--context", default=None, help="override the prompt file's context sentence")
    p.add_argument("--out", required=True)
    p.add_argument("--history", default="")
    p.add_argument("--model", default="")
    p.add_argument("--reasoning-effort", default="high")
    return ap


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "learn":
        from .learn import learn_skills
        res = learn_skills(args.training_dir, args.name, args.analysis or None, args.seed_knowledge or None,
                           args.rounds, args.max_errors, args.label_key, args.model or None, args.max_rejections)
        print(json.dumps({k: v for k, v in res.items() if k != "skills"}, indent=1, default=str))
        return 0
    if args.cmd == "evaluate":
        from .data import Cases
        from .evaluate import evaluate, score
        cases = Cases(args.training_dir)
        workdir = args.out and os.path.dirname(os.path.abspath(args.out)) or os.path.join(cases.dir, "_evaluate")
        results, fatal = evaluate(os.path.abspath(args.analysis), cases, args.label_key, workdir)
        if fatal:
            print(fatal)
            return 1
        sc = score(results, cases)
        print(f"correct {sc['correct']}/{sc['n']}  accuracy {sc['accuracy']:.4f}  errors {len(sc['errors'])}  crashed {len(sc['crashed'])}")
        for c in sc["errors"]:
            print(f"  {c}: GT={cases.gt[c]} pred={results[c].get('pred')}" + (" (crashed)" if results[c].get("error") else ""))
        if args.out:
            json.dump(results, open(args.out, "w"), indent=1, default=str)
        return 0
    if args.cmd == "filter":
        from .llm import LLM
        from .vlm_filter import crops_from_folder, filter_case, load_prompt
        prompt = load_prompt(args.prompt)
        key = args.contours_key or prompt.get("contours_key")
        subdir = args.subdir or prompt.get("crops_subdir")
        if not key or not subdir:
            print("contours_key and crops_subdir must come from the prompt file or --contours-key/--subdir")
            return 2
        llm = LLM(args.model or None, reasoning_effort=args.reasoning_effort)
        with open(args.case_json) as f:
            n = len((json.load(f)).get(key) or [])
        crops = crops_from_folder(args.crops_dir, subdir, n)
        s = filter_case(llm, args.case_json, crops, args.out, prompt, key, args.context, args.history or None)
        print(f"{s['total']} regions, excluded {len(s['excluded'])}: {s['excluded']} -> {args.out}")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
