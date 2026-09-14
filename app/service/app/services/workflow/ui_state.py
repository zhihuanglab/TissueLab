"""
Per-user workflow UI / SSE status map.

Kept separate from tasks.py so queue / cancel / scheduler can read it without
importing the tasks service monolith (which late-imports cancel).
"""

from __future__ import annotations

from collections import defaultdict
from typing import Dict

# uid -> {status, wf_id, execution_id, node_status, node_progress, ...}
user_workflow_status: Dict[str, Dict] = defaultdict(dict)
