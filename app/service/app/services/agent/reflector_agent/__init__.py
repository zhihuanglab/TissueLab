"""reflector_agent — strategy-level co-evolution (paper Section 2.6).

Two parts, both task-agnostic and separately callable:

Training time — learn corrective skills from errors (``learn.learn_skills`` and its steps):
    data.Cases                 the experiment folder (GT.csv, cases/<case>/{json, thumbnail}, problem.md)
    evaluate.evaluate/score    run an analysis script on every case, list the errors
    reflect.reflect_errors     thumbnail + text -> the failure pattern per error
    distil.distil_skill        reflections + code + knowledge -> one new skill and the code that adds it
    evaluate.compare           accept only if it fixes >= 1 error and breaks none
    knowledge.KnowledgeBase    knowledge.json / knowledge.md + a code snapshot per accepted skill

Inference time — the VLM reflector (``vlm_filter``):
    vlm_filter.judge_region    one region crop -> KEEP / EXCLUDE
    vlm_filter.filter_case     drop excluded regions from a case JSON before the analysis runs

``skills/`` ships knowledge bases learned in the published experiments (seed a run with them).
"""
from .data import Cases, norm_label  # noqa: F401
from .distil import distil_skill, fix_code  # noqa: F401
from .evaluate import compare, evaluate, is_correct, score  # noqa: F401
from .knowledge import KnowledgeBase  # noqa: F401
from .learn import learn_skills, setup_run  # noqa: F401
from .llm import LLM  # noqa: F401
from .reflect import reflect_error, reflect_errors  # noqa: F401
from .vlm_filter import crops_from_folder, filter_case, judge_region, load_prompt, parse_decision  # noqa: F401
