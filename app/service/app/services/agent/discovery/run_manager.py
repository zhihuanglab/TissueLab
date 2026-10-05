"""Discovery runs: one asyncio task per run folder, events streamed to the panel.

A run is its folder, <data folder>/autoresearch_runs/<run_id>: program.md, run_config.json,
run_state.json, results.tsv, rounds. Nothing else is stored; the run id is the
folder name.
"""

from __future__ import annotations

import asyncio
import shutil
import threading
import uuid
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Optional, Tuple

from app.services.agent.discovery.loop import (
    DEFAULT_WORKER_WALL_CLOCK, guide_recorded, mark_run_cancelled, read_run_state, run_discovery,
    run_folder_busy,
)
from app.services.agent.discovery.problem import (
    PROGRAM_FILENAME, ProblemError, read_run_config, write_run_config, validate_against_data,
)
from app.services.agent.discovery.sandbox import RUNS_DIRNAME
from app.services.agent.discovery.scout import GUIDE_NAME
from app.services.agent.discovery.workspace_scan import program_spec
from app.utils import resolve_path

# Events kept for a stream that is not reading; past this the oldest are dropped.
EVENT_BACKLOG = 1000
# How long a finished run's events wait for a stream to collect them.
FINISHED_RUN_GRACE_SEC = 60
# A silent stream yields a heartbeat this often: the server only notices a
# dropped connection when it sends, and a worker can be silent for minutes.
STREAM_HEARTBEAT_SEC = 15
# Finished runs whose folder the process still remembers (for a late stream).
REMEMBERED_RUNS = 256
FOLDER_BUSY_MESSAGE = "A research run is already in progress in this folder."


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
    # only a guide its scout recorded: a worker could have written that file too
    if not guide.is_file() or not guide_recorded(read_run_state(guide.parent.parent)):
        raise ProblemError(f"Run {run_id} in this folder has no dataset guide to reuse")
    return guide


def _put(queue: asyncio.Queue, event: Optional[dict]) -> None:
    """Never blocks the run: with no one reading, the oldest event goes."""
    if queue.full():
        queue.get_nowait()
    queue.put_nowait(event)


class DiscoveryRunManager:
    def __init__(self) -> None:
        self._tasks: Dict[str, asyncio.Task] = {}
        self._queues: Dict[str, asyncio.Queue] = {}
        # Set on cancel/shutdown. task.cancel() only stops the awaiting
        # coroutine; the proposer/worker threads and their containers watch this.
        self._cancel_events: Dict[str, threading.Event] = {}
        self._run_roots: Dict[str, Path] = {}
        # The queue a stream is reading and its stop flag, per run: one reader, or
        # they would split the events.
        self._streaming: Dict[str, Tuple[asyncio.Queue, asyncio.Event]] = {}
        self._lock = asyncio.Lock()
        # Runs the user stopped (vs. a shutdown), data folders a start is setting up,
        # and the folders of finished runs this process has forgotten.
        self._user_cancelled: set[str] = set()
        self._starting: set[Path] = set()
        self._past_roots: Dict[str, Path] = {}

    def run_root(self, run_id: str) -> Optional[Path]:
        """The folder of a run this process is running or still holds events for."""
        return self._run_roots.get(run_id)

    def past_run_root(self, run_id: str) -> Optional[Path]:
        """The folder of a run this process ran and has since forgotten."""
        return self._past_roots.get(run_id)

    def _folder_in_use(self, data_dir: Path) -> bool:
        key = data_dir.resolve()
        return key in self._starting or any(
            self.is_active(run_id) and root.parent.parent.resolve() == key
            for run_id, root in self._run_roots.items()
        )

    async def read_stream(self, run_id: str) -> AsyncIterator[Optional[dict]]:
        """The run's events for its one reader, and None after each
        STREAM_HEARTBEAT_SEC of silence. A newer reader takes over (a reattach
        whose old connection dropped unnoticed); this one then stops, handing
        back an event it had already taken."""
        queue = self._queues.get(run_id)
        if queue is None:
            raise ProblemError("Run not found")
        previous = self._streaming.get(run_id)
        if previous is not None:
            previous[1].set()
        entry = (queue, asyncio.Event())
        self._streaming[run_id] = entry
        stop = entry[1]
        try:
            while True:
                get = asyncio.ensure_future(queue.get())
                halt = asyncio.ensure_future(stop.wait())
                try:
                    done, _ = await asyncio.wait(
                        {get, halt}, timeout=STREAM_HEARTBEAT_SEC, return_when=asyncio.FIRST_COMPLETED)
                except BaseException:
                    if get.done() and not get.cancelled():
                        _put(queue, get.result())
                    get.cancel()
                    raise
                finally:
                    halt.cancel()
                if get not in done:
                    get.cancel()   # it has taken nothing: Queue.get leaves the item on cancel
                    if stop.is_set():
                        return
                    yield None
                    continue
                event = get.result()
                if stop.is_set():
                    _put(queue, event)
                    return
                if event is None:
                    return
                yield event
        finally:
            if self._streaming.get(run_id) is entry:
                del self._streaming[run_id]
            task = self._tasks.get(run_id)
            if task is not None and task.done():
                self._drop(run_id, task)

    def _drop(self, run_id: str, task: asyncio.Task) -> None:
        """Forget a finished run, unless it was relaunched or a stream is reading it."""
        reading = self._streaming.get(run_id)
        if self._tasks.get(run_id) is not task or (reading is not None and reading[0] is self._queues.get(run_id)):
            return
        root = self._run_roots.get(run_id)
        if root is not None:
            self._past_roots.pop(run_id, None)
            self._past_roots[run_id] = root
            while len(self._past_roots) > REMEMBERED_RUNS:
                self._past_roots.pop(next(iter(self._past_roots)))
        for table in (self._tasks, self._queues, self._cancel_events, self._run_roots):
            table.pop(run_id, None)
        self._user_cancelled.discard(run_id)

    def is_active(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        return bool(task and not task.done())

    async def start_run(
        self, *, task: str, workspace_path: str, rounds: int, reasoning_effort: str, worker_wall_clock_sec: int,
        dataset_scout: bool = True,
        reuse_guide_from: Optional[str] = None,
        workers_per_round: int = 1,
    ) -> str:
        """Start a run. `task` is program.md itself when it starts with a `---` header,
        else the program in plain words, whose header is worked out from the cohort
        table. Raises ProblemError when it does not parse or does not match the data folder,
        or when another run is in progress in the folder (both would rewrite its program.md)."""
        data_dir = workspace_data_dir(workspace_path)
        # Claimed before the first await: two Starts at once cannot both pass.
        if self._folder_in_use(data_dir):
            raise ProblemError(FOLDER_BUSY_MESSAGE)
        key = data_dir.resolve()
        self._starting.add(key)
        try:
            return await self._start(
                task=task, data_dir=data_dir, rounds=rounds, reasoning_effort=reasoning_effort,
                worker_wall_clock_sec=worker_wall_clock_sec, dataset_scout=dataset_scout,
                reuse_guide_from=reuse_guide_from, workers_per_round=workers_per_round,
            )
        finally:
            self._starting.discard(key)

    async def _start(
        self, *, task: str, data_dir: Path, rounds: int, reasoning_effort: str, worker_wall_clock_sec: int,
        dataset_scout: bool, reuse_guide_from: Optional[str], workers_per_round: int,
    ) -> str:
        program = task
        spec = await asyncio.to_thread(program_spec, task, data_dir)
        await asyncio.to_thread(validate_against_data, spec, data_dir)
        earlier_guide = _earlier_guide(data_dir, reuse_guide_from) if reuse_guide_from else None
        # Keep the editable workspace program and immutable per-run snapshots.
        run_id = f"run_{uuid.uuid4().hex[:10]}"
        run_root = data_dir / RUNS_DIRNAME / run_id
        run_root.mkdir(parents=True)
        await asyncio.to_thread((data_dir / PROGRAM_FILENAME).write_text, program, encoding="utf-8")
        await asyncio.to_thread((run_root / PROGRAM_FILENAME).write_text, program, encoding="utf-8")
        await asyncio.to_thread(write_run_config, spec, run_root)
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
        if not state:
            raise ProblemError(f"{run_root} is not a resumable discovery run (run_state.json missing)")
        data_dir = run_root.parent.parent
        try:
            spec = read_run_config(run_root)
        except OSError as exc:
            raise ProblemError(f"{run_root} has no readable research configuration") from exc
        await asyncio.to_thread(validate_against_data, spec, data_dir)
        config = state.get("config") or {}
        next_round_id = int(state.get("next_round_id", 1) or 1)
        remaining = int(config.get("rounds", 1) or 1) - next_round_id + 1
        if remaining < 1 and not additional_rounds:
            raise ProblemError("This run has finished all its rounds; choose how many more rounds to run")
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
            self._user_cancelled.discard(run_id)
            queue = self._queues[run_id] = asyncio.Queue(maxsize=EVENT_BACKLOG)
            self._run_roots[run_id] = run_root
            task = self._tasks[run_id] = asyncio.create_task(self._execute(run_id, run_root, **params))
            task.add_done_callback(lambda done: self._finished(run_id, queue, done))

    def _report_cancelled(self, run_id: str, run_root: Path, queue: asyncio.Queue) -> None:
        """The user stopped the run: say so on disk and to the stream, once."""
        self._user_cancelled.discard(run_id)
        try:
            mark_run_cancelled(run_root)
        except OSError:
            pass
        _put(queue, {"type": "run_cancelled", "run_id": run_id})

    def _finished(self, run_id: str, queue: asyncio.Queue, task: asyncio.Task) -> None:
        """Close the stream however the task ended (even cancelled before it ever ran)."""
        if run_id in self._user_cancelled and self._tasks.get(run_id) is task:
            self._report_cancelled(run_id, self._run_roots[run_id], queue)
        _put(queue, None)
        # A stream that comes later still gets the ending; then the run is forgotten.
        task.get_loop().call_later(FINISHED_RUN_GRACE_SEC, self._drop, run_id, task)

    async def _execute(self, run_id: str, run_root: Path, **params: Any) -> None:
        queue = self._queues[run_id]

        async def emit(event: dict) -> None:
            _put(queue, event)

        try:
            result = await run_discovery(
                run_root=run_root,
                emit=emit,
                cancel_event=self._cancel_events[run_id],
                **params,
            )
            await emit({"type": "complete", "result": result})
        except asyncio.CancelledError:
            if run_id in self._user_cancelled:
                # no await before the event: a second cancel() must not interrupt this handler
                self._report_cancelled(run_id, run_root, queue)
            else:
                await emit({"type": "error", "message": "Run stopped: the backend is shutting down"})
        except Exception as exc:
            await emit({"type": "error", "message": str(exc)})

    async def cancel_run(self, run_id: str) -> bool:
        if not self.is_active(run_id):
            return False
        self._user_cancelled.add(run_id)
        self._cancel_events[run_id].set()
        # The task's CancelledError handler reports "Run cancelled" once; _finished closes the stream.
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
