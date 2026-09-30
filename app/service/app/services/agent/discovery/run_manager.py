"""Discovery runs: one asyncio task per run folder, events streamed to the panel.

A run is its folder, <data folder>/autoresearch_runs/<run_id>: problem.md,
run_state.json, results.tsv, rounds. Nothing else is stored; the run id is the
folder name.
"""

from __future__ import annotations

import asyncio
import shutil
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from app.services.agent.discovery.loop import DEFAULT_WORKER_WALL_CLOCK, read_run_state, run_discovery, run_folder_busy
from app.services.agent.discovery.problem import ProblemError, parse_problem, validate_against_data
from app.services.agent.discovery.sandbox import RUNS_DIRNAME
from app.services.agent.discovery.scout import GUIDE_NAME
from app.utils import resolve_path

PROBLEM_FILENAME = "problem.md"


def workspace_data_dir(workspace_path: str) -> Path:
    """The folder a run works in: the workspace itself, or a file's parent.

    Accepts storage-relative and absolute paths alike (see resolve_path).
    """
    data_dir = Path(resolve_path(workspace_path)).expanduser()
    if not data_dir.is_dir():
        data_dir = data_dir.parent
    return data_dir


def run_folder(run_root_path: str) -> Path:
    """A run folder path, required to sit in <data folder>/autoresearch_runs/.

    Only that folder is masked in the sandbox; a run anywhere else under the data
    folder would expose its per-donor outputs to the next run's code.
    """
    run_root = Path(resolve_path(run_root_path)).expanduser()
    if run_root.parent.name != RUNS_DIRNAME:
        raise ProblemError(f"A run folder must be inside {RUNS_DIRNAME}/: {run_root}")
    return run_root


def _earlier_guide(data_dir: Path, run_id: str) -> Path:
    """The dataset guide an earlier run in this data folder wrote, found by its run id."""
    if not run_id or run_id != Path(run_id).name or run_id.startswith("."):
        raise ProblemError(f"Not a run id: {run_id!r}")
    guide = data_dir / RUNS_DIRNAME / run_id / "shared" / GUIDE_NAME
    if not guide.is_file():
        raise ProblemError(f"Run {run_id} in this folder has no dataset guide to reuse")
    return guide


class DiscoveryRunManager:
    def __init__(self) -> None:
        self._tasks: Dict[str, asyncio.Task] = {}
        self._queues: Dict[str, asyncio.Queue] = {}
        # Set on cancel/shutdown. task.cancel() only stops the awaiting
        # coroutine; the proposer/worker threads and their containers watch this.
        self._cancel_events: Dict[str, threading.Event] = {}
        self._lock = asyncio.Lock()

    def get_event_queue(self, run_id: str) -> Optional[asyncio.Queue]:
        return self._queues.get(run_id)

    def is_active(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        return bool(task and not task.done())

    async def start_run(
        self, *, task: str, workspace_path: str, rounds: int, reasoning_effort: str, worker_wall_clock_sec: int,
        dataset_scout: bool = True,
        reuse_guide_from: Optional[str] = None,
        workers_per_round: int = 1,
    ) -> str:
        """Start a run; `task` is the full problem.md text. Raises ProblemError when it
        does not parse or does not match the data folder."""
        data_dir = workspace_data_dir(workspace_path)
        spec = parse_problem(task)
        await asyncio.to_thread(validate_against_data, spec, data_dir)
        earlier_guide = _earlier_guide(data_dir, reuse_guide_from) if reuse_guide_from else None
        # The submitted text is the problem: saved to the workspace (the panel
        # pre-fills from it) and into the run folder (resume re-reads it).
        run_id = f"run_{uuid.uuid4().hex[:10]}"
        run_root = data_dir / RUNS_DIRNAME / run_id
        run_root.mkdir(parents=True)
        for path in (data_dir / PROBLEM_FILENAME, run_root / PROBLEM_FILENAME):
            await asyncio.to_thread(path.write_text, task, encoding="utf-8")
        if earlier_guide:
            # In place before the loop starts: it finds a guide and skips the scout.
            (run_root / "shared").mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(shutil.copyfile, earlier_guide, run_root / "shared" / GUIDE_NAME)
        await self._launch(
            run_id, run_root, spec=spec, data_dir=data_dir, rounds=rounds,
            reasoning_effort=reasoning_effort, worker_wall_clock_sec=worker_wall_clock_sec,
            dataset_scout=dataset_scout, guide_from=reuse_guide_from if earlier_guide else None,
            workers_per_round=workers_per_round,
        )
        return run_id

    async def resume_run(self, *, run_root_path: str, additional_rounds: Optional[int]) -> str:
        """Continue the run in run_root_path; returns its run id (the folder name)."""
        run_root = run_folder(run_root_path)
        state = read_run_state(run_root)
        problem_path = run_root / PROBLEM_FILENAME
        if not state or not problem_path.exists():
            raise ProblemError(f"{run_root} is not a resumable discovery run (run_state.json / problem.md missing)")
        data_dir = run_root.parent.parent
        spec = parse_problem(problem_path.read_text(encoding="utf-8"))
        await asyncio.to_thread(validate_against_data, spec, data_dir)
        config = state.get("config") or {}
        next_round_id = int(state.get("next_round_id", 1) or 1)
        remaining = max(1, int(config.get("rounds", 1)) - next_round_id + 1)
        await self._launch(
            run_root.name, run_root, spec=spec, data_dir=data_dir,
            rounds=int(additional_rounds) if additional_rounds else remaining,
            reasoning_effort=str(config.get("reasoning_effort", "high")),
            worker_wall_clock_sec=int(config.get("worker_wall_clock_sec", DEFAULT_WORKER_WALL_CLOCK)),
            model=config.get("model"),
            # the guide is in shared/ already when the run was scouted
            dataset_scout=bool(config.get("dataset_scout", False)),
            workers_per_round=int(config.get("workers_per_round", 1) or 1),
        )
        return run_root.name

    async def _launch(self, run_id: str, run_root: Path, **params: Any) -> None:
        async with self._lock:
            if self.is_active(run_id):
                raise ProblemError(f"Run {run_id} is already running")
            if run_folder_busy(run_root):
                raise ProblemError(f"Run {run_id} is still stopping; try again in a moment")
            self._cancel_events[run_id] = threading.Event()
            self._queues[run_id] = asyncio.Queue()
            self._tasks[run_id] = asyncio.create_task(self._execute(run_id, run_root, **params))

    async def _execute(self, run_id: str, run_root: Path, **params: Any) -> None:
        queue = self._queues[run_id]
        try:
            result = await run_discovery(
                run_root=run_root,
                emit=queue.put,
                cancel_event=self._cancel_events[run_id],
                **params,
            )
            await queue.put({"type": "complete", "result": result})
        except asyncio.CancelledError:
            await queue.put({"type": "error", "message": "Run cancelled"})
        except Exception as exc:
            await queue.put({"type": "error", "message": str(exc)})
        finally:
            await queue.put(None)

    async def cancel_run(self, run_id: str) -> bool:
        if not self.is_active(run_id):
            return False
        self._cancel_events[run_id].set()
        # The task's CancelledError handler reports "Run cancelled" and closes the stream — once.
        self._tasks[run_id].cancel()
        return True

    def request_shutdown(self) -> list[asyncio.Task]:
        """Signal every active run's threads and cancel its task; returns the tasks."""
        active = [(run_id, task) for run_id, task in self._tasks.items() if not task.done()]
        for run_id, task in active:
            self._cancel_events[run_id].set()
            task.cancel()
        return [task for _, task in active]


_run_manager_instance: Optional[DiscoveryRunManager] = None


def get_discovery_run_manager() -> DiscoveryRunManager:
    global _run_manager_instance
    if _run_manager_instance is None:
        _run_manager_instance = DiscoveryRunManager()
    return _run_manager_instance
