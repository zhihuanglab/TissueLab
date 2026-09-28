# Knowledge base: lymph node metastasis (LNCO2)

- `knowledge.json` / `knowledge.md` — Skill 1 (tumour must overlap a valid lymph node) and Skill 2 (lymph node size validation)
- `analysis_with_skills_2.py` — the analysis code with both skills (`analyze_medical_image(json_path)`)
- `problem.md` — task definition; copy it into the training folder
- `reflector_prompt.json` — the VLM reflector prompt for lymph node regions (`filter --prompt`)

Use the code directly on a case JSON with `lymphnode_contours`, `tumor_contours`, `mpp`:
```python
import importlib.util
spec = importlib.util.spec_from_file_location("m", "analysis_with_skills_2.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.analyze_medical_image("case.json")["diagnosis"]
```
Or keep learning on top of it:
```bash
python -m app.services.agent.reflector_agent learn --training-dir <dir> --seed-knowledge <this folder> --rounds 5
```
Run the VLM reflector first if per-region crops are available:
```bash
python -m app.services.agent.reflector_agent filter --case-json case.json --crops-dir <case_folder> --prompt <this folder>/reflector_prompt.json --out filtered.json
```
