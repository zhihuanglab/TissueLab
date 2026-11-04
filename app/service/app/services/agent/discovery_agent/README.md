# discovery_agent — slide-level co-evolution

The slide-level co-evolution mechanism of the paper (Section 2.7), copied verbatim from the
published tubule-score runs: `run.py` and `prompts/{system,planner,coder,analyzer,explorer}.md`
are the files of `experiment/data/TCGA-BRCA/optimal/train/agent_1/` (agent_2..5 identical).
The only edits are in `run.py`, marked `CLI additions`: `--training-dir` / `--name` so the run
directory can be anywhere, and reading `ANTHROPIC_API_KEY` from the service `.env.local` when it
is not in the environment or in `api_key.txt`. Nothing else is changed.

The experiment supplies a folder:
```
<training-dir>/
  GT.csv, <data dirs>/          ground truth and per-case data
  problem.md                    task definition (required by the prompts)
  human_insights.md             optional expert constraints
```
On first use `<training-dir>/<name>/prompts/` is created with the five generic prompts plus the
two files above, and that frozen copy is what the run reads (the same layout as the published runs).

```bash
cd app/service
python -m app.services.agent.discovery_agent --training-dir /data/train --name agent_1 --auto 20
python -m app.services.agent.discovery_agent --training-dir /data/train --name agent_1        # interactive
# or run the file directly with any interpreter that has the anthropic SDK (skips the service imports):
python app/services/agent/discovery_agent/run.py --training-dir /data/train --name agent_1 --auto 20
```
The `-m` form imports the `app.services.agent` package and therefore needs the service environment
plus `pip install anthropic` (the service env does not ship it); the direct-file form needs only
`anthropic`, numpy, pandas, scipy, scikit-learn, joblib and zarr. Either way the same interpreter
runs the generated round scripts.
Model: `claude-opus-4-6` via the `anthropic` SDK, as in the paper. The run directory must be inside
the training directory (generated scripts use its parent as the data root).

## Reproducing the tubule score experiment (paper Section 2.7)

The task-specific files are in the
[TissueLab-Experiment](https://github.com/zhihuanglab/TissueLab-Experiment) repository under
`Tubule Score/agent/`: `problem.md` (task, data layout, zarr keys, case-id matching, evaluation),
`human_insights.md` (expert constraints of the with-insights condition), the exact prompts of the
published `agent_1` run and the evaluation scripts; `Tubule Score/data/agent_1 … agent_5` hold the
per-round predictions of the five published runs, `data/human` and `data/baselines` the comparison
arms.

The training folder is the app's per-slide output for the 30 training slides (TCGA-BRCA), as
described in `problem.md`: MUSK patch embeddings with the tumour and gland classifiers
(`musk_tumor/`, `musk_gland/`, one `<slide>.svs.zarr` each), StarDist nuclei with and without the
tumour classifier (`stardist_tumor/`, `stardist/`), BiomedParse gland masks (`biomedparse/`),
`rois/`, `tissue_region/`, `tumor_contours/`, the slide metadata JSONs of `wsi/` (the slides
themselves are not read) and `GT.csv` (`case_id`, `tubule_score`). Producing these from the slides
is the expensive part (hours of GPU time per cohort), so the preprocessed folder is distributed as a
reproducibility bundle, linked from the TissueLab-Experiment README (Google Drive), together with
the LNCO2 bundle of the strategy-level experiment.

```bash
cd app/service
pip install anthropic                      # not in the service environment
TRAIN=/data/tubule/train                   # the bundle's training folder
cp "<TissueLab-Experiment>/Tubule Score/agent/problem.md" "$TRAIN"/
cp "<TissueLab-Experiment>/Tubule Score/agent/human_insights.md" "$TRAIN"/   # omit for the no-insights ablation
# ANTHROPIC_API_KEY in the environment or in app/service/.env.local
python -m app.services.agent.discovery_agent --training-dir "$TRAIN" --name agent_6 --auto 20
```
Each round the planner proposes a workflow, the coder writes `rounds/roundN.py`, the script runs on
the training folder and reports in-sample and leave-one-out metrics, and the analyzer records what
was learned; every 10 rounds the log is distilled into `prompts/knowledge_base.md`, which is
injected into later rounds. Everything lands in `<training-dir>/<name>/`:
```
prompts/              frozen prompts, problem.md, human_insights.md, knowledge_base.md
rounds/roundN.py      the workflow of round N (a self-contained script over the training folder)
results/              what the round scripts save (predictions, metrics, figures)
workspace/            exploration notes and scratch files
experiment_log.txt    the full trajectory (plans, code, results, analyses)
```
To score a round's workflow on the held-out TCGA test split and the external histAI cohort, use
`Tubule Score/agent/eval_reference_agent_1/` from TissueLab-Experiment as the template (it imports a
run's `rounds/round20.py` and evaluates it on folders with the same layout). The LLM is not
deterministic; the paper reports five independent runs, whose trajectories are in `data/agent_1 …
agent_5`.
