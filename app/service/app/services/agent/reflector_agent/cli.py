"""Command line for the reflector agent.

    python -m app.services.agent.reflector_agent bootstrap --training-dir <dir> --out <dir>/analysis_base.py
    python -m app.services.agent.reflector_agent learn  --training-dir <dir> --analysis <dir>/analysis_base.py --name r1 --rounds 5
    python -m app.services.agent.reflector_agent learn  --training-dir <dir> --seed-knowledge skills/lymph_node_metastasis
    python -m app.services.agent.reflector_agent filter --case-json c.json --crops-dir <case>/ \
        --prompt skills/lymph_node_metastasis/reflector_prompt.json --out filtered.json
    python -m app.services.agent.reflector_agent filter-all --training-dir <dir> --out <dir>_filtered \
        --prompt skills/lymph_node_metastasis/reflector_prompt.json [--crops-root <dir with crops>]
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

    p = sub.add_parser("bootstrap", help="write the initial (skill-free) analysis script from problem.md with the LLM")
    p.add_argument("--training-dir", required=True)
    p.add_argument("--out", required=True, help="where to put the script that runs on every case")
    p.add_argument("--attempts", type=int, default=3, help="regenerate after a crash or timeout, up to this many times")
    p.add_argument("--label-key", default="diagnosis")
    p.add_argument("--model", default="")
    p.add_argument("--timeout", type=int, default=1800, help="seconds allowed for one evaluation of the training set")

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

    p = sub.add_parser("filter-all", help="VLM reflector over every case of an experiment folder -> filtered copy of the folder")
    p.add_argument("--training-dir", required=True, help="experiment folder (GT.csv, problem.md, cases/<case>/<case>.json)")
    p.add_argument("--out", required=True, help="the filtered copy; evaluate/learn can run on it directly")
    p.add_argument("--prompt", required=True, help="reflector prompt JSON")
    p.add_argument("--crops-root", default="", help="<root>/<case>/<crops_subdir>/<i>/image.png (default: <training-dir>/cases)")
    p.add_argument("--contours-key", default="")
    p.add_argument("--context", default=None)
    p.add_argument("--cases", default="", help="comma-separated subset")
    p.add_argument("--workers", type=int, default=4, help="parallel API calls")
    p.add_argument("--model", default="")
    p.add_argument("--reasoning-effort", default="high")
    return ap


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "bootstrap":
        from .bootstrap import bootstrap_analysis
        rec = bootstrap_analysis(args.training_dir, args.out, args.model or None, args.attempts, args.label_key, args.timeout)
        print(json.dumps(rec, indent=1, default=str))
        return 0 if rec["accepted"] else 1
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
    if args.cmd == "filter-all":
        from .llm import LLM
        from .vlm_filter import filter_training_dir, load_prompt
        prompt = load_prompt(args.prompt)
        meta = filter_training_dir(lambda: LLM(args.model or None, reasoning_effort=args.reasoning_effort),
                                   args.training_dir, args.out, prompt, args.crops_root or None,
                                   args.contours_key or None, args.context, args.workers,
                                   args.cases.split(",") if args.cases else None)
        print(json.dumps({k: v for k, v in meta.items() if k != "prompt"}, indent=1))
        return 1 if meta["errors"] else 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
