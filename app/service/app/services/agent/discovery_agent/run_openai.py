#!/usr/bin/env python3
"""
Experiment Agent
================
Generic agent for iterative feature engineering & model evaluation.
Problem-specific details are defined in prompts/problem.md.

Workflow:
  Phase 0: Read problem definition & data docs
  Phase 1: Explore data (auto-discover directories, run explorer scripts)
  Phase 2: Round-by-round feature engineering & CV evaluation
    - Each round: Plan -> Code -> Execute -> Analyze
    - Analyzer can request mini-explorations for deeper data understanding

Usage:
    python run.py              # interactive (confirms each step)
    python run.py --auto N     # run N rounds automatically
"""
import os
import sys
import io
import re
import argparse
import subprocess
from openai import OpenAI

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True)

# ===================== CONFIG =====================
MODEL = "gpt-5.4"
MAX_TOKENS_EXPLORE = 4000
MAX_TOKENS_PLAN = 2000
MAX_TOKENS_CODE = 32000
MAX_TOKENS_ANALYSIS = 4000
MAX_TOKENS_KB_SUMMARY = 4000
MAX_CODE_RETRIES = 2
KB_SUMMARY_INTERVAL = 10  # summarize findings to knowledge_base.md every N rounds

# --- CLI additions (the only edits to the as-run file): run dir = <training-dir>/<name>;
#     on first use the generic prompts are copied there from this package, together with
#     problem.md / human_insights.md taken from the training directory.
PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
_pre = argparse.ArgumentParser(add_help=False)
_pre.add_argument("--training-dir", required=True)
_pre.add_argument("--name", default="agent")
_pre_args, _ = _pre.parse_known_args()
TRAINING_DIR = os.path.abspath(_pre_args.training_dir)
AGENT_DIR = os.path.join(TRAINING_DIR, _pre_args.name)
if not os.path.isdir(os.path.join(AGENT_DIR, "prompts")):
    import shutil
    os.makedirs(AGENT_DIR, exist_ok=True)
    shutil.copytree(os.path.join(PACKAGE_DIR, "prompts"), os.path.join(AGENT_DIR, "prompts"))
    for _f in ("problem.md", "human_insights.md"):
        _src = os.path.join(TRAINING_DIR, _f)
        if os.path.isfile(_src):
            shutil.copy2(_src, os.path.join(AGENT_DIR, "prompts", _f))
    print(f"Run dir created: {AGENT_DIR} (prompts copied; problem.md/human_insights.md from {TRAINING_DIR})")
PROMPTS_DIR = os.path.join(AGENT_DIR, "prompts")
ROUNDS_DIR = os.path.join(AGENT_DIR, "rounds")
RESULTS_DIR = os.path.join(AGENT_DIR, "results")
WORKSPACE_DIR = os.path.join(AGENT_DIR, "workspace")
LOG_PATH = os.path.join(AGENT_DIR, "experiment_log.txt")
EXPLORATION_LOG = os.path.join(WORKSPACE_DIR, "exploration_notes.md")
API_KEY_FILE = os.path.join(AGENT_DIR, "api_key.txt")

# Context files
DATA_PROBLEM_PATH = os.path.join(TRAINING_DIR, "scripts", "DATA_AND_PROBLEM.md")
PROBLEM_MD_PATH = os.path.join(PROMPTS_DIR, "problem.md")
FOLDER_STRUCTURE_PATH = os.path.join(TRAINING_DIR, "FOLDER_STRUCTURE.md")


def load_file(path, default=""):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return f.read()
    return default


def load_prompt(name):
    return load_file(os.path.join(PROMPTS_DIR, name))


def fill_template(template, **kwargs):
    for key, value in kwargs.items():
        template = template.replace("{{" + key.upper() + "}}", str(value))
    return template


def get_api_key():
    if os.path.exists(API_KEY_FILE):
        with open(API_KEY_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    return line
    key = os.environ.get("OPENAI_API_KEY", "")
    if key:
        return key
    env_local = os.path.join(os.getenv("TL_SERVICE_ROOT", os.path.join(PACKAGE_DIR, "..", "..", "..", "..")), ".env.local")  # app/service/.env.local
    if os.path.exists(env_local):
        with open(env_local, encoding="utf-8") as f:
            for line in f:
                if line.strip().startswith("OPENAI_API_KEY="):
                    key = line.strip().split("=", 1)[1].strip().strip('"').strip("'")
                    if key:
                        return key
    print(f"ERROR: No API key found.")
    print(f"Create {API_KEY_FILE} with your OpenAI API key (one line).")
    print(f"Get your key at: https://platform.openai.com/api-keys")
    sys.exit(1)


def call_claude(system, user, max_tokens=4000):
    import time
    client = OpenAI(api_key=get_api_key())
    for attempt in range(5):
        try:
            result_text = ""
            stream = client.chat.completions.create(
                model=MODEL,
                max_completion_tokens=max_tokens,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                stream=True,
            )
            for chunk in stream:
                if chunk.choices[0].delta.content:
                    result_text += chunk.choices[0].delta.content
            return result_text
        except Exception as e:
            err_str = str(e).lower()
            if ("overloaded" in err_str or "server_error" in err_str or "rate_limit" in err_str) and attempt < 4:
                wait = 30 * (attempt + 1)
                print(f"  API error, retrying in {wait}s (attempt {attempt+1}/5): {str(e)[:100]}")
                sys.stdout.flush()
                time.sleep(wait)
            else:
                raise


def extract_python_code(response):
    # Try to find complete code blocks first
    pattern = r"```python\s*\n(.*?)```"
    matches = re.findall(pattern, response, re.DOTALL)
    if matches:
        return max(matches, key=len)
    # Handle truncated response: opening ```python but no closing ```
    trunc_match = re.search(r"```python\s*\n(.*)", response, re.DOTALL)
    if trunc_match:
        code = trunc_match.group(1).rstrip()
        # Remove trailing ``` if partially present
        code = re.sub(r"`{1,2}$", "", code).rstrip()
        print("WARNING: Code block appears truncated (no closing ```). Extracted anyway.")
        sys.stdout.flush()
        return code
    return response.strip()


def get_current_round(log_text):
    rounds = re.findall(r"ROUND\s+(\d+)", log_text)
    # Also parse truncation header like "[Rounds 1-19 summarized in ...]"
    summarized = re.findall(r"\[Rounds\s+\d+-(\d+)\s+summarized", log_text)
    all_nums = [int(r) for r in rounds] + [int(r) for r in summarized]
    if all_nums:
        return max(all_nums)
    # Fallback: count existing round scripts
    if os.path.exists(ROUNDS_DIR):
        scripts = [f for f in os.listdir(ROUNDS_DIR) if re.match(r"round(\d+)\.py", f)]
        if scripts:
            return max(int(re.match(r"round(\d+)\.py", f).group(1)) for f in scripts)
    return 0


def get_prev_round_code(round_num):
    if round_num <= 1:
        return "(no previous round)"
    prev_path = os.path.join(ROUNDS_DIR, f"round{round_num - 1}.py")
    return load_file(prev_path, "(not found)")


def get_best_round_code(best_round_num):
    """Load the code from the best-performing round."""
    if best_round_num is None or best_round_num < 1:
        return None
    best_path = os.path.join(ROUNDS_DIR, f"round{best_round_num}.py")
    code = load_file(best_path, "")
    return code if code else None


def run_script(script_path, timeout=1800):
    try:
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        result = subprocess.run(
            [sys.executable, "-u", script_path],
            capture_output=True, text=True, timeout=timeout,
            cwd=os.path.dirname(script_path),
            encoding="utf-8", errors="replace",
            env=env,
        )
        output = result.stdout
        if result.returncode != 0:
            output += f"\n\nSTDERR:\n{result.stderr}"
        return result.returncode, output
    except subprocess.TimeoutExpired:
        return -1, f"ERROR: Script timed out after {timeout} seconds"
    except Exception as e:
        return -1, f"ERROR: {e}"


# ===================== PHASE 0: READ DOCS =====================

def phase0_read_docs():
    """Load and display problem definition."""
    print(f"\n{'='*60}")
    print("PHASE 0: READING PROBLEM DEFINITION")
    print(f"{'='*60}")

    data_problem = load_file(DATA_PROBLEM_PATH, "")
    folder_structure = load_file(FOLDER_STRUCTURE_PATH, "")

    if not data_problem:
        print("WARNING: DATA_AND_PROBLEM.md not found")
    else:
        print(f"Loaded DATA_AND_PROBLEM.md ({len(data_problem)} chars)")

    if not folder_structure:
        print("WARNING: FOLDER_STRUCTURE.md not found")
    else:
        print(f"Loaded FOLDER_STRUCTURE.md ({len(folder_structure)} chars)")

    return data_problem, folder_structure


# ===================== PHASE 1: EXPLORE DATA =====================

def _generate_exploration_targets():
    """Auto-generate exploration targets from available data directories."""
    import zarr

    targets = []
    idx = 1

    # Always start with GT
    gt_path = os.path.join(TRAINING_DIR, "GT.csv")
    if os.path.exists(gt_path):
        targets.append({
            "name": f"{idx:02d}_gt_distribution",
            "target": "Explore GT.csv: load the ground truth, show target variable distribution, "
                      "list all case_ids grouped by class."
        })
        idx += 1

    # Scan data directories
    data_dirs = sorted([
        d for d in os.listdir(TRAINING_DIR)
        if os.path.isdir(os.path.join(TRAINING_DIR, d)) and not d.startswith('agent')
    ])

    for dname in data_dirs:
        dpath = os.path.join(TRAINING_DIR, dname)
        files = os.listdir(dpath)
        sample = files[0] if files else ""

        if any(f.endswith('.zarr') for f in files):
            # Zarr directory - inspect structure
            zarr_file = next(f for f in files if f.endswith('.zarr'))
            try:
                z = zarr.open(os.path.join(dpath, zarr_file), 'r')
                nodes = list(z.keys())
                node_desc = ", ".join(nodes)
            except Exception:
                node_desc = "unknown structure"
            targets.append({
                "name": f"{idx:02d}_{dname}",
                "target": f"Explore {dname}/ zarr files (nodes: {node_desc}): "
                          f"open one file, list all arrays with shapes/dtypes/value ranges. "
                          f"For a few cases, compute summary statistics and compare across GT classes."
            })
            idx += 1
        elif any(f.endswith('.npy') for f in files):
            targets.append({
                "name": f"{idx:02d}_{dname}",
                "target": f"Explore {dname}/ npy files: load a few samples, "
                          f"show shapes, dtypes, value ranges. Compare across GT classes."
            })
            idx += 1
        elif any(f.endswith('.json') for f in files):
            targets.append({
                "name": f"{idx:02d}_{dname}",
                "target": f"Explore {dname}/ JSON files: load a sample, show structure and keys. "
                          f"Summarize contents across cases."
            })
            idx += 1
        elif os.path.isdir(os.path.join(dpath, sample)):
            # Subdirectories per case (like rois/)
            sub_files = os.listdir(os.path.join(dpath, sample))
            targets.append({
                "name": f"{idx:02d}_{dname}",
                "target": f"Explore {dname}/: each case has a subdirectory with files like {sub_files[:5]}. "
                          f"Load a few cases, show file contents/metadata. Compare across GT classes."
            })
            idx += 1

    return targets


def phase1_explore(system_prompt):
    """Use Claude to generate & run data exploration scripts."""
    print(f"\n{'='*60}")
    print("PHASE 1: EXPLORING DATA")
    print(f"{'='*60}")

    explorer_template = load_prompt("explorer.md")

    # Define exploration targets (sequential - each builds on previous)
    # Auto-generate exploration targets from available data
    targets = _generate_exploration_targets()

    exploration_notes = "# Data Exploration Notes\n\n"

    for step in targets:
        print(f"\n--- Exploring: {step['name']} ---")

        user_msg = fill_template(explorer_template, target=step["target"])
        response = call_claude(system_prompt, user_msg, max_tokens=MAX_TOKENS_EXPLORE)
        code = extract_python_code(response)

        script_path = os.path.join(WORKSPACE_DIR, f"{step['name']}.py")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(code)

        returncode, output = run_script(script_path, timeout=300)

        if returncode != 0:
            print(f"  FAILED: {output[-500:]}")
            # Try to fix
            fix_msg = (f"This exploration script failed:\n```python\n{code}\n```\n"
                       f"Error:\n```\n{output[-2000:]}\n```\n"
                       f"Fix it. Output ONLY corrected ```python ... ```.")
            response2 = call_claude(system_prompt, fix_msg, max_tokens=MAX_TOKENS_EXPLORE)
            code2 = extract_python_code(response2)
            with open(script_path, "w", encoding="utf-8") as f:
                f.write(code2)
            returncode, output = run_script(script_path, timeout=300)

        if returncode == 0:
            # Truncate long output
            if len(output) > 3000:
                output = output[:3000] + "\n... (truncated)"
            print(output)
            exploration_notes += f"## {step['name']}\n```\n{output}\n```\n\n"
        else:
            print(f"  Still failed after retry. Skipping.")
            exploration_notes += f"## {step['name']}\nFAILED\n\n"

    # Save exploration notes
    with open(EXPLORATION_LOG, "w", encoding="utf-8") as f:
        f.write(exploration_notes)
    print(f"\nExploration notes saved to {EXPLORATION_LOG}")
    return exploration_notes


# ===================== PHASE 2: EXPERIMENT ROUNDS =====================

def step_plan(system_prompt, experiment_log, exploration_notes, round_num):
    print(f"\n{'='*60}")
    print(f"STEP 1: PLANNING ROUND {round_num}")
    print(f"{'='*60}")

    planner_template = load_prompt("planner.md")
    log_text = experiment_log if experiment_log.strip() else "(first round)"
    user_msg = fill_template(planner_template, experiment_log=log_text)
    # Add exploration notes as context
    user_msg += f"\n\n## Data Exploration Notes\n{exploration_notes[-4000:]}"

    plan = call_claude(system_prompt, user_msg, max_tokens=MAX_TOKENS_PLAN)
    print(plan)
    return plan


def step_code(system_prompt, plan, round_num, best_round_num=None):
    print(f"\n{'='*60}")
    print(f"STEP 2: GENERATING CODE FOR ROUND {round_num}")
    print(f"{'='*60}")

    coder_template = load_prompt("coder.md")
    prev_code = get_prev_round_code(round_num)

    # Also provide best round code if different from prev
    best_code = get_best_round_code(best_round_num)
    if best_code and best_round_num != round_num - 1:
        prev_code += (f"\n\n# === BEST PERFORMING CODE (Round {best_round_num}) ===\n"
                      f"# Use this as a strong baseline to build upon.\n\n"
                      f"{best_code}")
        print(f"  Including best round code (Round {best_round_num}) as reference")

    user_msg = fill_template(coder_template, plan=plan, prev_code=prev_code)

    response = call_claude(system_prompt, user_msg, max_tokens=MAX_TOKENS_CODE)
    code = extract_python_code(response)

    script_path = os.path.join(ROUNDS_DIR, f"round{round_num}.py")
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(code)
    print(f"Saved to {script_path} ({len(code.splitlines())} lines)")
    return script_path, code


def step_fix_code(system_prompt, code, error_output, plan, round_num):
    print(f"\n--- FIXING CODE ---")
    fix_msg = (f"Round {round_num} script failed.\n\n## Plan\n```\n{plan}\n```\n\n"
               f"## Code\n```python\n{code}\n```\n\n"
               f"## Error\n```\n{error_output[-3000:]}\n```\n\n"
               f"Fix it. Output ONLY ```python ... ```.")
    response = call_claude(system_prompt, fix_msg, max_tokens=MAX_TOKENS_CODE)
    fixed = extract_python_code(response)
    script_path = os.path.join(ROUNDS_DIR, f"round{round_num}.py")
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(fixed)
    print(f"Fixed code saved ({len(fixed.splitlines())} lines)")
    return script_path, fixed


def step_execute(script_path, plan, system_prompt, code, round_num):
    print(f"\n{'='*60}")
    print(f"STEP 3: EXECUTING ROUND {round_num}")
    print(f"{'='*60}")

    for attempt in range(1 + MAX_CODE_RETRIES):
        returncode, output = run_script(script_path, timeout=1800)
        if returncode == 0:
            lines = output.strip().split("\n")
            if len(lines) > 120:
                print(f"... ({len(lines) - 120} lines omitted) ...")
                print("\n".join(lines[-120:]))
            else:
                print(output)
            return output

        print(f"FAILED (attempt {attempt + 1}/{1 + MAX_CODE_RETRIES})")
        print(output[-2000:])

        if attempt < MAX_CODE_RETRIES:
            script_path, code = step_fix_code(
                system_prompt, code, output, plan, round_num)

    print("Max retries reached.")
    return None


def step_analyze(system_prompt, plan, output, experiment_log):
    print(f"\n{'='*60}")
    print("STEP 4: ANALYZING RESULTS")
    print(f"{'='*60}")

    analyzer_template = load_prompt("analyzer.md")
    user_msg = fill_template(
        analyzer_template,
        plan=plan,
        output=output[-6000:],
        experiment_log=experiment_log[-4000:] if experiment_log.strip() else "(first round)",
    )

    analysis = call_claude(system_prompt, user_msg, max_tokens=MAX_TOKENS_ANALYSIS)
    print(analysis)
    return analysis


def step_mini_explore(system_prompt, analysis, exploration_notes):
    """Run a mini-exploration if the analyzer requested one."""
    match = re.search(r"EXPLORE:\s*(.+?)(?:\n\n|\n[A-Z]|\Z)", analysis, re.DOTALL)
    if not match:
        return exploration_notes
    explore_request = match.group(1).strip()
    if not explore_request or explore_request.lower() in ("none", "n/a", ""):
        return exploration_notes

    print(f"\n{'='*60}")
    print("MINI-EXPLORE: Running targeted exploration")
    print(f"{'='*60}")
    print(f"Request: {explore_request}")

    explorer_template = load_prompt("explorer.md")
    user_msg = fill_template(explorer_template, target=explore_request)
    response = call_claude(system_prompt, user_msg, max_tokens=MAX_TOKENS_EXPLORE)
    code = extract_python_code(response)

    script_path = os.path.join(WORKSPACE_DIR, "mini_explore.py")
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(code)

    returncode, output = run_script(script_path, timeout=300)

    if returncode != 0:
        print(f"  FAILED: {output[-500:]}")
        fix_msg = (f"This exploration script failed:\n```python\n{code}\n```\n"
                   f"Error:\n```\n{output[-2000:]}\n```\n"
                   f"Fix it. Output ONLY corrected ```python ... ```.")
        response2 = call_claude(system_prompt, fix_msg, max_tokens=MAX_TOKENS_EXPLORE)
        code2 = extract_python_code(response2)
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(code2)
        returncode, output = run_script(script_path, timeout=300)

    if returncode == 0:
        if len(output) > 3000:
            output = output[:3000] + "\n... (truncated)"
        print(output)
        new_note = f"\n\n## Mini-explore\nRequest: {explore_request}\n```\n{output}\n```\n"
        exploration_notes += new_note
        # Append to file
        with open(EXPLORATION_LOG, "a", encoding="utf-8") as f:
            f.write(new_note)
        print(f"Exploration notes updated.")
    else:
        print(f"  Still failed after retry. Skipping.")

    return exploration_notes


def step_kb_summary(system_prompt, experiment_log, round_num):
    """Summarize findings from experiment log into knowledge_base.md."""
    print(f"\n{'='*60}")
    print(f"KB SUMMARY: Distilling findings after Round {round_num}")
    print(f"{'='*60}")

    kb_path = os.path.join(PROMPTS_DIR, "knowledge_base.md")
    existing_kb = load_file(kb_path, "")

    user_msg = (
        "You are summarizing experimental findings for the current prediction project.\n\n"
        "## Experiment Log (all rounds so far)\n"
        f"```\n{experiment_log[-8000:]}\n```\n\n"
    )
    if existing_kb:
        user_msg += f"## Existing Knowledge Base\n```\n{existing_kb}\n```\n\n"

    user_msg += (
        "## Task\n"
        "Distill the key learnings into a concise knowledge base that will help future rounds.\n\n"
        "Include:\n"
        "1. **Best features found** - which features work, their correlations, why they help\n"
        "2. **Best models/configs** - which model types + hyperparams gave best .632+ composite\n"
        "3. **What does NOT work** - failed approaches so they aren't retried\n"
        "4. **Persistent hard cases** - which case_ids are consistently misclassified and why\n"
        "5. **Recommended next directions** - promising unexplored ideas\n\n"
        "Format as a markdown document with clear sections. Be concise but specific "
        "(include actual metric numbers, feature names, model params). "
        "This will be injected into the system prompt for future rounds.\n\n"
        "Output ONLY the knowledge base markdown content."
    )

    kb_text = call_claude(system_prompt, user_msg, max_tokens=MAX_TOKENS_KB_SUMMARY)

    # Wrap with header
    kb_content = f"# Knowledge Base (auto-generated after Round {round_num})\n\n{kb_text}"
    with open(kb_path, "w", encoding="utf-8") as f:
        f.write(kb_content)
    print(f"Saved to {kb_path} ({len(kb_content)} chars)")
    return kb_content


# ===================== MAIN =====================

def main():
    parser = argparse.ArgumentParser(description="Experiment Agent")
    parser.add_argument("--auto", type=int, default=0,
                        help="Run N rounds automatically")
    parser.add_argument("--skip-explore", action="store_true",
                        help="Skip Phase 1 if exploration notes already exist")
    parser.add_argument("--training-dir", required=True,
                        help="Training data directory: GT.csv, data sub-dirs, problem.md (+ human_insights.md)")
    parser.add_argument("--name", default="agent",
                        help="Run directory name, created under --training-dir")
    args = parser.parse_args()

    # Ensure directories
    for d in [ROUNDS_DIR, RESULTS_DIR, WORKSPACE_DIR]:
        os.makedirs(d, exist_ok=True)

    # Build system prompt
    system_md = load_prompt("system.md")
    problem_md = load_file(PROBLEM_MD_PATH, "(not found)")
    data_problem = load_file(DATA_PROBLEM_PATH, "(not found)")
    folder_structure = load_file(FOLDER_STRUCTURE_PATH, "(not found)")
    knowledge_base = load_file(os.path.join(PROMPTS_DIR, "knowledge_base.md"), "")
    human_insights = load_file(os.path.join(PROMPTS_DIR, "human_insights.md"), "")
    system_prompt = (
        system_md
        + "\n\n" + problem_md
        + "\n\n## DATA_AND_PROBLEM.md\n" + data_problem
        + "\n\n## FOLDER_STRUCTURE.md\n" + folder_structure
    )
    if human_insights.strip():
        # Human insights take priority over KB — only use one
        system_prompt += "\n\n## HUMAN INSIGHTS (from domain expert — these override any conflicting KB advice)\n" + human_insights
    elif knowledge_base.strip():
        system_prompt += "\n\n## KNOWLEDGE BASE (from prior experiments)\n" + knowledge_base

    print("=" * 60)
    print("EXPERIMENT AGENT")
    print("=" * 60)
    print(f"Model:    {MODEL}")
    print(f"Training: {TRAINING_DIR}")

    # ===== PHASE 0: Read docs =====
    data_problem, folder_structure = phase0_read_docs()

    # ===== PHASE 1: Explore data =====
    exploration_notes = load_file(EXPLORATION_LOG, "")
    if exploration_notes and args.skip_explore:
        print(f"\nSkipping exploration (--skip-explore, notes exist)")
    else:
        if args.auto == 0:
            resp = input("\nRun data exploration? [y/n]: ").strip().lower()
            if resp != "y":
                exploration_notes = "(exploration skipped)"
            else:
                exploration_notes = phase1_explore(system_prompt)
        else:
            exploration_notes = phase1_explore(system_prompt)

    # ===== PHASE 2: Experiment rounds =====
    experiment_log = load_file(LOG_PATH, "")
    round_num = get_current_round(experiment_log) + 1
    max_rounds = args.auto if args.auto > 0 else 30  # up to 30 rounds
    rounds_done = 0
    no_improve_count = 0

    # Convergence tracking: LOO Pearson r with gap penalty
    best_adjusted = -999.0
    best_round_num = None
    THRESH_IMPROVE = 0.02
    kb_injected = False

    print(f"\nStarting experiments from Round {round_num}")
    if args.auto > 0:
        print(f"Auto mode: up to {max_rounds} rounds, LOO Pearson r convergence")

    while rounds_done < max_rounds:
        print(f"\n{'#'*60}")
        print(f"# ROUND {round_num}")
        print(f"{'#'*60}")

        plan = step_plan(system_prompt, experiment_log, exploration_notes, round_num)

        if args.auto == 0:
            resp = input("\nProceed to code generation? [y/n]: ").strip().lower()
            if resp == "n":
                break

        script_path, code = step_code(system_prompt, plan, round_num, best_round_num)

        if args.auto == 0:
            resp = input("\nExecute? [y/n]: ").strip().lower()
            if resp == "n":
                print(f"Saved at {script_path}")
                break

        output = step_execute(script_path, plan, system_prompt, code, round_num)
        if output is None:
            break

        analysis = step_analyze(system_prompt, plan, output, experiment_log)

        # Mini-explore if analyzer requested it
        exploration_notes = step_mini_explore(system_prompt, analysis, exploration_notes)

        sep = "\n\n" if experiment_log.strip() else ""
        experiment_log += sep + analysis
        with open(LOG_PATH, "w", encoding="utf-8") as f:
            f.write(experiment_log)
        print(f"\nLog updated: {LOG_PATH}")

        # --- Adjusted composite convergence check (auto mode only) ---
        if args.auto > 0:
            def parse_metric(pattern, text, fallback=0.0):
                m = re.search(pattern, text)
                return float(m.group(1)) if m else fallback

            # Parse adjusted score (LOO r - gap penalty)
            adj_matches = re.findall(r"Adjusted Score:\s*([-\d.]+)", analysis)
            adjusted = float(adj_matches[-1]) if adj_matches else 0.0

            if adjusted == 0.0:
                # Fallback: parse LOO r and gap, compute adjusted
                r_is = parse_metric(r"Pearson r:.*?IS=([\d.]+)", analysis)
                r_loo = parse_metric(r"Pearson r:.*?LOO=([\d.]+)", analysis)
                gap = parse_metric(r"IS-LOO Gap:\s*([\d.]+)", analysis)

                if r_loo == 0.0:
                    r_loo = parse_metric(r"LOO.*?r[=:]\s*([\d.]+)", analysis)
                if gap == 0.0 and r_is > 0 and r_loo > 0:
                    gap = r_is - r_loo

                if gap > 0.30:
                    adjusted = -1.0
                else:
                    gap_penalty = max(0.0, gap - 0.15) * 0.5
                    adjusted = r_loo - gap_penalty

            print(f"  >> Adjusted Score = {adjusted:.4f} (best={best_adjusted:.4f})")

            if adjusted > best_adjusted + THRESH_IMPROVE:
                no_improve_count = 0
                best_adjusted = adjusted
                best_round_num = round_num
                print(f"  >> IMPROVED: adjusted={adjusted:.4f} (Round {round_num})")
            else:
                no_improve_count += 1
                print(f"  >> No improvement ({no_improve_count}/4, best=Round {best_round_num})")

            if best_adjusted >= 0.85 and rounds_done >= 10:
                print(f"\n** TARGET REACHED: adjusted={best_adjusted:.4f} >= 0.85 (after {rounds_done+1} rounds) **")
                break
            if no_improve_count >= 4 and rounds_done >= 10:
                print(f"\n** STAGNATION: no improvement for 4 rounds (after {rounds_done+1} rounds), stopping **")
                break
            elif no_improve_count >= 4 and rounds_done < 10:
                no_improve_count = 0
                print(f"  >> Resetting stagnation counter (minimum 10 rounds not reached yet, round {rounds_done+1})")

            # Rollback hint: when stagnating, inject reminder about best round
            if no_improve_count >= 2 and best_round_num is not None:
                rollback_hint = (f"\n\n** WARNING: No improvement for {no_improve_count} rounds. "
                                 f"Best result was Round {best_round_num} (adjusted={best_adjusted:.4f}). "
                                 f"Consider building upon Round {best_round_num}'s approach rather than "
                                 f"continuing the current direction. **")
                # Append hint to experiment_log so planner sees it
                experiment_log += rollback_hint
                with open(LOG_PATH, "w", encoding="utf-8") as f:
                    f.write(experiment_log)
                print(f"  >> Rollback hint added to experiment log")

        round_num += 1
        rounds_done += 1

        # Auto-summarize findings to knowledge_base.md every KB_SUMMARY_INTERVAL rounds
        if rounds_done > 0 and rounds_done % KB_SUMMARY_INTERVAL == 0:
            kb_content = step_kb_summary(system_prompt, experiment_log, round_num - 1)
            # Re-inject updated KB into system prompt
            kb_path = os.path.join(PROMPTS_DIR, "knowledge_base.md")
            # Strip old KB from system_prompt if previously injected
            if kb_injected:
                # Replace by rebuilding system prompt + new KB
                system_md = load_prompt("system.md")
                problem_md = load_file(PROBLEM_MD_PATH, "(not found)")
                data_problem_text = load_file(DATA_PROBLEM_PATH, "(not found)")
                folder_structure_text = load_file(FOLDER_STRUCTURE_PATH, "(not found)")
                system_prompt = (
                    system_md
                    + "\n\n" + problem_md
                    + "\n\n## DATA_AND_PROBLEM.md\n" + data_problem_text
                    + "\n\n## FOLDER_STRUCTURE.md\n" + folder_structure_text
                    + "\n\n" + kb_content
                )
            else:
                system_prompt += "\n\n" + kb_content
            kb_injected = True
            # Append current experiment log to full log before truncating
            full_log_path = LOG_PATH.replace(".txt", "_full.txt")
            existing_full = load_file(full_log_path, "")
            with open(full_log_path, "w", encoding="utf-8") as f:
                if existing_full.strip():
                    f.write(existing_full.rstrip() + "\n\n" + experiment_log)
                else:
                    f.write(experiment_log)
            print(f"  Full log backed up to {full_log_path}")
            # Truncate working log -- future rounds use KB instead of full history
            experiment_log = f"[Rounds 1-{round_num - 1} summarized in knowledge_base.md]\n"
            with open(LOG_PATH, "w", encoding="utf-8") as f:
                f.write(experiment_log)
            print(f"\n** KB updated and re-injected into system prompt **")
            print(f"** Experiment log truncated -- future rounds rely on KB **")

        # After Round 1 completes, inject knowledge base for Phase 2
        if not kb_injected and rounds_done >= 1:
            kb_path = os.path.join(PROMPTS_DIR, "knowledge_base.md")
            if os.path.exists(kb_path):
                kb_text = load_file(kb_path, "")
                system_prompt += "\n\n" + kb_text
                kb_injected = True
                print(f"\n** PHASE 2: Injected knowledge_base.md -- try reproducing prior results **")

        if args.auto == 0 and rounds_done < max_rounds:
            resp = input("\nContinue to next round? [y/n]: ").strip().lower()
            if resp != "y":
                break

    # Always update KB before exiting
    if rounds_done > 0:
        full_log = load_file(LOG_PATH.replace(".txt", "_full.txt"), "")
        current_log = load_file(LOG_PATH, "")
        combined_log = (full_log + "\n" + current_log) if full_log.strip() else current_log
        if combined_log.strip():
            step_kb_summary(system_prompt, combined_log, round_num - 1)

    print(f"\n{'='*60}")
    print(f"DONE: {rounds_done + 1} rounds")
    print(f"  Best adjusted (LOO r): {best_adjusted:.4f} (Round {best_round_num})")
    print(f"  Log:     {LOG_PATH}")
    print(f"  Scripts: {ROUNDS_DIR}/")
    print(f"  Results: {RESULTS_DIR}/")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
