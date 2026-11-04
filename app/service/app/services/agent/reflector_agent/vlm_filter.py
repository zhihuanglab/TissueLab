"""Inference-time reflector: per-region VLM keep/exclude filter.

Each predicted region is judged on its own crop, with no cross-region context;
excluded regions are removed from the per-case JSON before the downstream
analysis runs. The task is entirely in the prompt file passed by the caller
(see ``skills/<task>/reflector_prompt.json``), which holds:

    system        the system message
    user          the user message; ``{index}`` is replaced by the region index,
                  ``{context}`` by the context sentence (both optional)
    context       the context sentence
    contours_key  which list in the case JSON holds the regions
    crops_subdir  where a case folder keeps the crops: <case>/<crops_subdir>/<i>/image.png

Decisions are parsed from a leading KEEP/EXCLUDE on a line; anything
unparseable counts as KEEP.

    judge_region(llm, image_path, index, prompt)                 -> (exclude, reason, raw)
    filter_case(llm, case_json, crops, out_json, prompt, ...)   -> summary dict
    filter_training_dir(make_llm, training_dir, out_dir, prompt, ...) -> run summary
        every case of an experiment folder -> a filtered copy of the folder
        (what the published lymph node runs did before the analysis code ran)
"""
import json
import os
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .llm import LLM, is_reasoning_model


def load_prompt(path: str) -> Dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        p = json.load(f)
    for k in ("system", "user"):
        if k not in p:
            raise ValueError(f"{path}: reflector prompt needs a '{k}' entry")
    return p


def user_message(prompt: Dict[str, Any], index: int, context: Optional[str] = None) -> str:
    ctx = prompt.get("context") if context is None else context
    text = prompt["user"].replace("{index}", str(index)).replace("{context}", ctx or "")
    if ctx and "{context}" not in prompt["user"]:
        text = f"Context: {ctx}\n\n" + text
    return text


def parse_decision(text: str) -> Tuple[bool, str, bool]:
    """(exclude, reason, parse_ok). Only a KEEP/EXCLUDE at the start of a line counts;
    unparseable -> KEEP."""
    for line in (text or "").strip().splitlines():
        m = re.match(r"^\s*\**\s*(KEEP|EXCLUDE)\b\**\s*:?\s*(.*)$", line.strip(), re.IGNORECASE)
        if m:
            return m.group(1).upper() == "EXCLUDE", m.group(2).strip(), True
    return False, (text or "").strip()[:200], False


def judge_region(llm: LLM, image_path: str, index: int, prompt: Dict[str, Any],
                 context: Optional[str] = None) -> Tuple[bool, str, str]:
    """One region crop -> (exclude, reason, raw_reply). Image first, then text."""
    # reasoning tokens count against the completion budget, so reasoning models get the
    # budget the published runs used; a one-line KEEP/EXCLUDE needs far less otherwise
    budget = 8000 if is_reasoning_model(llm.model) else 200
    raw = llm.chat(prompt["system"], user_message(prompt, index, context), image_paths=[image_path],
                   max_tokens=budget, image_max_side=None, images_first=True)
    exclude, reason, _ = parse_decision(raw)
    return exclude, reason, raw


def filter_case(llm: LLM, case_json: str, crops: Sequence[Optional[str]], out_json: str,
                prompt: Dict[str, Any], contours_key: Optional[str] = None, context: Optional[str] = None,
                history_path: Optional[str] = None, log=print) -> Dict[str, Any]:
    """Judge every region of ``case_json[contours_key]`` (default: prompt["contours_key"]);
    ``crops[i]`` is the crop of region i (None = no crop, kept). Writes the filtered JSON."""
    key = contours_key or prompt.get("contours_key")
    if not key:
        raise ValueError("contours_key not given and not in the prompt file")
    with open(case_json, encoding="utf-8") as f:
        data = json.load(f)
    regions = data.get(key) or []
    decisions: List[Dict[str, Any]] = []
    for i, _ in enumerate(regions):
        crop = crops[i] if i < len(crops) else None
        if not crop or not os.path.isfile(crop):
            decisions.append({"index": i, "exclude": False, "reason": "no crop; kept", "raw": None})
            continue
        exclude, reason, raw = judge_region(llm, crop, i, prompt, context)
        decisions.append({"index": i, "exclude": exclude, "reason": reason, "raw": raw})
        log(f"  region {i}: {'EXCLUDE' if exclude else 'KEEP'} — {reason}")
    excluded = {d["index"] for d in decisions if d["exclude"]}
    data[key] = [r for i, r in enumerate(regions) if i not in excluded]
    os.makedirs(os.path.dirname(os.path.abspath(out_json)), exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(data, f)
    summary = {"case_json": case_json, "out_json": out_json, "contours_key": key,
               "total": len(regions), "excluded": sorted(excluded), "decisions": decisions, "model": llm.model}
    if history_path:
        os.makedirs(os.path.dirname(os.path.abspath(history_path)), exist_ok=True)
        with open(history_path, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=1)
    return summary


def crops_from_folder(case_folder: str, subdir: str, n: Optional[int] = None) -> List[Optional[str]]:
    """Crop paths laid out as <case_folder>/<subdir>/<i>/image.png (what patch_regions writes)."""
    base = os.path.join(case_folder, subdir)
    idx = []
    if os.path.isdir(base):
        idx = sorted(int(d) for d in os.listdir(base) if d.isdigit() and os.path.isfile(os.path.join(base, d, "image.png")))
    count = n if n is not None else ((max(idx) + 1) if idx else 0)
    return [os.path.join(base, str(i), "image.png") if i in idx else None for i in range(count)]


def filter_training_dir(make_llm: Callable[[], LLM], training_dir: str, out_dir: str, prompt: Dict[str, Any],
                        crops_root: Optional[str] = None, contours_key: Optional[str] = None,
                        context: Optional[str] = None, workers: int = 4, cases: Optional[Sequence[str]] = None,
                        log=print) -> Dict[str, Any]:
    """Filter every case of an experiment folder (see data.Cases for the layout) and write a
    filtered copy to ``out_dir``: GT.csv/problem.md copied, ``cases/<case>/<case>.json`` with the
    excluded regions removed (everything else in the JSON untouched), ``history/<case>.json`` with
    the per-region decisions, ``decisions.jsonl`` and ``run_meta.json``. The crops of case ``c``
    are read from ``<crops_root>/<c>/<crops_subdir>/<i>/image.png`` (``crops_root`` defaults to
    ``<training_dir>/cases``, the layout ``patch_regions.build_case`` writes). A case whose history
    file exists is skipped, so an interrupted run continues where it stopped. ``make_llm`` is
    called once per worker thread."""
    key = contours_key or prompt.get("contours_key")
    subdir = prompt.get("crops_subdir")
    if not key or not subdir:
        raise ValueError("the prompt file needs contours_key and crops_subdir")
    cases_dir = os.path.join(os.path.abspath(training_dir), "cases")
    crops_root = os.path.abspath(crops_root) if crops_root else cases_dir
    out_dir = os.path.abspath(out_dir)
    all_cases = sorted(c for c in os.listdir(cases_dir)
                       if any(f.endswith(".json") for f in os.listdir(os.path.join(cases_dir, c))))
    todo = [c for c in all_cases if cases is None or c in set(cases)]
    os.makedirs(os.path.join(out_dir, "cases"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "history"), exist_ok=True)
    for name in ("GT.csv", "ground_truth.csv", "gt.csv", "problem.md"):
        src = os.path.join(training_dir, name)
        if os.path.isfile(src) and not os.path.exists(os.path.join(out_dir, name)):
            shutil.copy2(src, os.path.join(out_dir, name))
    dec_path = os.path.join(out_dir, "decisions.jsonl")
    lock = threading.Lock()
    local = threading.local()

    def llm() -> LLM:
        if not hasattr(local, "llm"):
            local.llm = make_llm()
        return local.llm

    def one(case: str):
        hist = os.path.join(out_dir, "history", case + ".json")
        if os.path.isfile(hist):
            return case, None
        cd = os.path.join(cases_dir, case)
        src = os.path.join(cd, sorted(f for f in os.listdir(cd) if f.endswith(".json"))[0])
        out_json = os.path.join(out_dir, "cases", case, os.path.basename(src))
        with open(src, encoding="utf-8") as f:
            n = len(json.load(f).get(key) or [])
        crops = crops_from_folder(os.path.join(crops_root, case), subdir, n)
        t = time.time()
        s = filter_case(llm(), src, crops, out_json, prompt, key, context, None, log=lambda m: None)
        s["elapsed_sec"] = round(time.time() - t, 1)
        with lock:
            with open(dec_path, "a", encoding="utf-8") as f:
                for d in s["decisions"]:
                    f.write(json.dumps({"case": case, **d}) + "\n")
            with open(hist, "w", encoding="utf-8") as f:
                json.dump(s, f, indent=1)
        return case, s

    t0 = time.time()
    n_dec = n_ex = n_empty = 0
    errors: List[Dict[str, str]] = []
    model = None
    with ThreadPoolExecutor(max(1, workers)) as ex:
        futs = {ex.submit(one, c): c for c in todo}
        for i, fu in enumerate(as_completed(futs), 1):
            c = futs[fu]
            try:
                _, s = fu.result()
            except Exception as e:  # one failed case must not stop the run; re-run to retry it
                errors.append({"case": c, "error": repr(e)[:500]})
                log(f"[{i}/{len(todo)}] {c} ERROR {e!r}")
                continue
            if s is None:
                log(f"[{i}/{len(todo)}] {c} already done")
                continue
            model = s.get("model")
            n_dec += s["total"]
            n_ex += len(s["excluded"])
            n_empty += sum(1 for d in s["decisions"] if d["raw"] is not None and not (d["raw"] or "").strip())
            log(f"[{i}/{len(todo)}] {c} {s['total']} regions, excluded {s['excluded']} ({s['elapsed_sec']}s)")
    meta = {"model": model, "prompt": prompt, "context": context if context is not None else prompt.get("context"),
            "training_dir": os.path.abspath(training_dir), "crops_root": crops_root, "out_dir": out_dir,
            "n_cases": len(todo), "n_decisions_this_run": n_dec, "n_excluded_this_run": n_ex,
            "n_empty_replies": n_empty, "errors": errors, "elapsed_sec": round(time.time() - t0, 1),
            "timestamp": datetime.now(timezone.utc).isoformat()}
    with open(os.path.join(out_dir, "run_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    return meta
