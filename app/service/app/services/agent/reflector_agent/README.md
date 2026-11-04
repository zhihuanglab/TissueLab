# reflector_agent

Writes the initial analysis script from the problem definition (`bootstrap`), learns corrective skills
from training-set errors (`learn`) and filters predicted regions with a VLM before analysis (`filter`). Task-agnostic; a ready-made knowledge base for lymph node metastasis is in
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
per-region crops for the reflector), see *From slides to the experiment folder* below.

## Commands

```bash
cd app/service

# score an analysis script on the training cases (no LLM call)
python -m app.services.agent.reflector_agent evaluate --training-dir /data/ln --analysis base.py

# write the initial, skill-free analysis script from problem.md + the JSON layout (LLM; regenerated on crash/timeout)
python -m app.services.agent.reflector_agent bootstrap --training-dir /data/ln --out /data/ln/analysis_base.py

# learn skills: evaluate -> reflect on errors -> propose one skill + code -> verify -> record, N rounds
python -m app.services.agent.reflector_agent learn --training-dir /data/ln --analysis /data/ln/analysis_base.py --name r1 --rounds 5

# start from the shipped knowledge base and keep learning
python -m app.services.agent.reflector_agent learn --training-dir /data/ln --name r2 \
        --seed-knowledge app/services/agent/reflector_agent/skills/lymph_node_metastasis

# VLM reflector: keep/exclude every predicted region of one case, write the filtered JSON
python -m app.services.agent.reflector_agent filter --case-json case.json --crops-dir <case_folder> \
        --prompt app/services/agent/reflector_agent/skills/lymph_node_metastasis/reflector_prompt.json --out filtered.json

# the same for every case of the experiment folder -> a filtered copy of the folder (resumable)
python -m app.services.agent.reflector_agent filter-all --training-dir /data/ln --out /data/ln_filtered \
        --prompt app/services/agent/reflector_agent/skills/lymph_node_metastasis/reflector_prompt.json --workers 8
python -m app.services.agent.reflector_agent evaluate --training-dir /data/ln_filtered \
        --analysis app/services/agent/reflector_agent/skills/lymph_node_metastasis/analysis_with_skills_2.py
```

`bootstrap` gives the model the system prompt, `problem.md`, the field structure of one case JSON and
the entry-point contract, and keeps the first script that runs on every training case (`--attempts`,
default 3; `--timeout` per evaluation, default 1800 s). Accuracy is not a criterion at this step: the
script implements the task's criteria as stated, and the skills are learned from its errors. The
attempts and their scores are kept next to `--out`.

`learn` options: `--max-errors` thumbnails shown per round (6), `--max-rejections` consecutive rejected
proposals before stopping (3), `--model`. A skill is accepted only if it fixes at least one training error
and breaks none. Re-running the same `--name` continues from its knowledge base.

`filter` needs a prompt JSON (`system`, `user` with `{index}`/`{context}` placeholders, `context`,
`contours_key`, `crops_subdir`) and crops at `<case_folder>/<crops_subdir>/<i>/image.png`, one per region
`i` of `contours_key`; `--subdir`, `--contours-key`, `--context` override the file.

`filter-all` reads the crops of case `c` from `<crops-root>/<c>/<crops_subdir>/<i>/image.png`
(`--crops-root` defaults to `<training-dir>/cases`, i.e. crops next to the case JSON) and writes
`<out>/cases/<c>/<c>.json` with the excluded regions removed, `<out>/history/<c>.json` with every
decision and reply, `decisions.jsonl` and `run_meta.json`; `GT.csv` and `problem.md` are copied, so
`evaluate` and `learn` run on `<out>` as on any experiment folder. Cases with a history file are
skipped, so an interrupted run is continued by running the same command again. `--model` and
`--reasoning-effort` (default `high`) select the reflector backbone.

## From slides to the experiment folder

The experiment folder is built from the app's per-slide output; nothing in it is hand-made.

1. **Classify the slides in the app.** Open each slide, run MUSK embedding and patch classification
   with the lymph node and tumour classifiers (ask the question in the Agent chat and the planner
   assembles exactly these steps, or add them in the Workflow graph; the classifiers come from active
   learning on a few annotated patches, or load the trained `.tlcls` files). The app writes the
   predictions into the slide's companion zarr store, `<slide>.ndpi.zarr` next to the slide, under
   `Tissue-Segmentation/masks/<class>/mask`, one mask per class as named in the classifier.

2. **Export one case folder per slide** with `patch_regions`. `--classes` maps the JSON keys the
   analysis code reads to the class names used in the app; `--crop` names the keys whose regions
   the reflector will look at (one crop per polygon, at `<subdir>/<i>/image.png`, `subdir` = key
   without `_contours`, which is what `reflector_prompt.json` expects: `crops_subdir: lymphnode`):
   ```bash
   cd app/service
   for slide in /data/LNCO2/*.ndpi; do
       case=$(basename "$slide" .ndpi)
       python -m app.services.patch_regions --zarr "$slide.zarr" --slide "$slide" --name "$case" \
           --out-dir /data/ln/cases/$case \
           --classes "lymphnode_contours=Lymph node,tumor_contours=Tumor" --crop lymphnode_contours
   done
   ```
   Each call writes `cases/<case>/<case>.json` (`slide_name`, `mpp`, `lymphnode_contours`,
   `tumor_contours`, `_meta`), `overview.png`, and `lymphnode/<i>/image.png`. Without `--slide`
   only the JSON is written (enough for `evaluate`/`learn`, not for the reflector).
   `--connect-patches` (default 3) is the patch kernel of the close/open step before contour tracing.

3. **Add the ground truth and the problem definition:**
   ```bash
   cp app/services/agent/reflector_agent/skills/lymph_node_metastasis/problem.md /data/ln/
   # GT.csv: header + one line per slide, first column = case folder name, second = label
   printf 'slide_name,ground_truth\nAI-LNCO2-0004_G_HE,negative\nAI-LNCO2-0049_N_HE,macro_metastasis\n' > /data/ln/GT.csv
   ```
   Labels are `negative`, `isolated_tumor_cells`, `micro_metastasis`, `macro_metastasis` (case,
   spaces and underscores are ignored). Cases listed in `GT.csv` without a folder are skipped with a
   notice; folders without a GT line are ignored.

The folder is then ready for every command below. The published folder itself (case JSONs, crops,
GT.csv) is distributed as a reproducibility bundle linked from the
[TissueLab-Experiment](https://github.com/zhihuanglab/TissueLab-Experiment) README (Google Drive).

## Reproducing the lymph node metastasis experiment (paper Section 2.6)

The published run is: analysis code with Skills 1+2 on the upstream predictions, then the same code
after the VLM reflector has removed predicted lymph node regions that are not lymph node. With the
experiment folder built as in the previous section (one `cases/<case>/<case>.json` per slide holding
`lymphnode_contours`, `tumor_contours`, `mpp`, plus the per-region crops), the whole chain is:

```bash
cd app/service
S=app/services/agent/reflector_agent/skills/lymph_node_metastasis
# 1. without the reflector
python -m app.services.agent.reflector_agent evaluate --training-dir /data/ln --analysis $S/analysis_with_skills_2.py
# 2. reflector on every predicted lymph node region, then the same code on the filtered folder
python -m app.services.agent.reflector_agent filter-all --training-dir /data/ln --out /data/ln_filtered --prompt $S/reflector_prompt.json --workers 8
python -m app.services.agent.reflector_agent evaluate --training-dir /data/ln_filtered --analysis $S/analysis_with_skills_2.py
# 3. learn the skills again from scratch instead of using the shipped ones: start from the shipped
#    skill-free base script, or from one the LLM writes from problem.md
python -m app.services.agent.reflector_agent learn --training-dir /data/ln --analysis $S/analysis_base.py --name relearn --rounds 5
python -m app.services.agent.reflector_agent bootstrap --training-dir /data/ln --out /data/ln/analysis_base.py
python -m app.services.agent.reflector_agent learn --training-dir /data/ln --analysis /data/ln/analysis_base.py --name relearn_llm --rounds 5
# 4. score what was learned (the code with every accepted skill is analysis_current.py)
python -m app.services.agent.reflector_agent evaluate --training-dir /data/ln --analysis /data/ln/relearn/analysis_current.py
```
`evaluate` prints correct/total and lists the misclassified slides; `filter-all` prints the number of
regions excluded per slide; `learn` prints each round's proposal and verdict and writes the accepted
skills with rule, rationale, evidence cases and code snapshot to `knowledge_base/knowledge.md`. The
base script scores lower than the shipped Skills 1+2 code; the learned skills close part of that gap
(the paper's Skill 1, tumour must overlap a lymph node, and Skill 2, lymph node size validation, were
learned in that order from this base; the remaining errors are upstream misdetections the downstream
code cannot repair). Because the problem definition states the "within a lymph node" criterion, a
script written by `bootstrap` may already implement Skill 1; the learning then starts from there. The deployed reflector in the paper is Gemini-3-Pro; the module calls an
OpenAI-compatible endpoint (default `gpt-5.4`, the backbone in the paper's sensitivity analysis),
so set `OPENAI_BASE_URL`/`CODE_MODEL` to use another one.

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
    bootstrap_analysis,                          # the initial script from problem.md
    reflect_errors, distil_skill, fix_code,      # the steps
    KnowledgeBase, learn_skills,                 # knowledge base + the loop
    judge_region, filter_case, filter_training_dir, crops_from_folder, load_prompt   # VLM reflector
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
