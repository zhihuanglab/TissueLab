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
