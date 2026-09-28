"""
Discovery (autoresearch): an iterative biomarker research loop.

Users provide a research directive (program.md) and a data folder.
Each round runs: propose one candidate → run one worker → evaluate panel gain
→ keep or discard → append one row to results.tsv.

Layout:
- models / session_store / run_manager — sessions, runs, and the event stream
  the API serves (orchestration)
- simple_loop — the round loop; scout, worker, deterministic_evaluator,
  sandbox and shared_runtime are its stages
- shared_lib_source — helper library copied into each run's /shared and
  imported by worker scripts inside the Docker sandbox
"""

from app.services.agent.discovery.models import DiscoveryRun, DiscoverySession
from app.services.agent.discovery.run_manager import (
    DiscoveryRunManager,
    get_discovery_run_manager,
    workspace_data_dir,
)
from app.services.agent.discovery.session_store import (
    DiscoverySessionStore,
    get_discovery_session_store,
)
from app.services.agent.discovery.simple_loop import run_autoresearch

__all__ = [
    "DiscoveryRun",
    "DiscoveryRunManager",
    "DiscoverySession",
    "DiscoverySessionStore",
    "get_discovery_run_manager",
    "get_discovery_session_store",
    "run_autoresearch",
    "workspace_data_dir",
]
