"""
Discovery: an iterative, outcome-blind biomarker discovery loop (protocol v2.3).

The user points it at a data folder (slides + a cohort file) and writes
problem.md: a YAML header naming the outcome, covariates and class rules, and
the research question in prose. Each round a proposer inspects the slides and
proposes one hypothesis with pre-specified variations, a worker implements it
as result.py, the controller materializes and checks the donor table in a
Docker sandbox, and a judge admits the best variation that improves the panel
under paired repeated nested cross-validation.

Layout:
- problem — problem.md parsing and validation (all dataset specifics live here)
- loop — the round loop; proposer, worker, judge (+ panel_cv), data_intuition
  are its stages; sandbox runs every piece of model-written code
- run_manager — one task per run folder and its event stream
- shared_lib_source — loaders copied into each run's /shared/lib
"""

from app.services.agent.discovery.problem import ProblemError, ProblemSpec, parse_problem
from app.services.agent.discovery.run_manager import (
    DiscoveryRunManager,
    get_discovery_run_manager,
    run_folder,
    workspace_data_dir,
)

__all__ = [
    "DiscoveryRunManager",
    "ProblemError",
    "ProblemSpec",
    "get_discovery_run_manager",
    "parse_problem",
    "run_folder",
    "workspace_data_dir",
]
