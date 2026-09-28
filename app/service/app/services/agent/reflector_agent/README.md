# reflector_agent

Learns corrective skills from training-set errors (`learn`) and filters predicted regions with a VLM
before analysis (`filter`). Task-agnostic; a ready-made knowledge base for lymph node metastasis is in
`skills/lymph_node_metastasis/`.

## Experiment folder

```
<training-dir>/
  GT.csv              case_id,label   (first two columns)
  problem.md          task, label set, meaning of the per-case JSON, criteria, thumbnail legend
  cases/<case>/
      <case>.json     the per-case input the analysis code reads (upstream predictions)
      overview.png    thumbnail with the upstream predictions drawn on it
```
plus an analysis script defining `analyze_medical_image(json_path) -> dict` that returns the label
under `--label-key` (default `diagnosis`). Labels are compared ignoring case, spaces and underscores.

To make a case folder from a slide's patch classification in the app (contours JSON, overview and
per-region crops for the reflector):
```bash
python -m app.services.patch_regions --zarr slide.svs.zarr --slide slide.svs --out-dir cases/<case> \
    --classes "lymphnode_contours=Lymph node,tumor_contours=Tumor" --crop lymphnode_contours
```

## Commands

```bash
cd app/service

# score an analysis script on the training cases (no LLM call)
python -m app.services.agent.reflector_agent evaluate --training-dir /data/ln --analysis base.py

# learn skills: evaluate -> reflect on errors -> propose one skill + code -> verify -> record, N rounds
python -m app.services.agent.reflector_agent learn --training-dir /data/ln --analysis base.py --name r1 --rounds 5

# start from the shipped knowledge base and keep learning
python -m app.services.agent.reflector_agent learn --training-dir /data/ln --name r2 \
        --seed-knowledge app/services/agent/reflector_agent/skills/lymph_node_metastasis

# VLM reflector: keep/exclude every predicted region of one case, write the filtered JSON
python -m app.services.agent.reflector_agent filter --case-json case.json --crops-dir <case_folder> \
        --prompt app/services/agent/reflector_agent/skills/lymph_node_metastasis/reflector_prompt.json --out filtered.json
```

`learn` options: `--max-errors` thumbnails shown per round (6), `--max-rejections` consecutive rejected
proposals before stopping (3), `--model`. A skill is accepted only if it fixes at least one training error
and breaks none. Re-running the same `--name` continues from its knowledge base.

`filter` needs a prompt JSON (`system`, `user` with `{index}`/`{context}` placeholders, `context`,
`contours_key`, `crops_subdir`) and crops at `<case_folder>/<crops_subdir>/<i>/image.png`, one per region
`i` of `contours_key`; `--subdir`, `--contours-key`, `--context` override the file.

## Run directory `<training-dir>/<name>/`

```
prompts/                         frozen prompts + problem.md
analysis_initial.py              the starting script
analysis_current.py              the script with every accepted skill
knowledge_base/knowledge.json    the skills (rule, rationale, evidence, effect); knowledge.md is the readable copy
knowledge_base/analysis_with_skills_N.py   code snapshot after skill N
rounds/roundN/                   errors.json, reflections.json, proposal.json, analysis.py, verify.json
log.txt
```

## As a library

```python
from app.services.agent.reflector_agent import (
    Cases, LLM, evaluate, score, compare,        # data + scoring
    reflect_errors, distil_skill, fix_code,      # the steps
    KnowledgeBase, learn_skills,                 # knowledge base + the loop
    judge_region, filter_case, crops_from_folder, load_prompt   # VLM reflector
)
llm = LLM()                                       # model/key from the service config
cases = Cases("/data/ln")
results, err = evaluate("base.py", cases, "diagnosis", "/tmp/eval")
print(score(results, cases))
prompt = load_prompt("app/services/agent/reflector_agent/skills/lymph_node_metastasis/reflector_prompt.json")
exclude, reason, raw = judge_region(llm, "<case>/lymphnode/3/image.png", 3, prompt)
```

## Configuration

`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODE_MODEL` / `LLM_MODEL` from the environment or
`app/service/.env.local`. Default model `gpt-5.4`. Any interpreter with `openai`, `numpy` and `Pillow`
works; the service environment has them.
