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
"""
import json
import os
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .llm import LLM


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
    raw = llm.chat(prompt["system"], user_message(prompt, index, context), image_paths=[image_path],
                   max_tokens=200, image_max_side=None, images_first=True)
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
