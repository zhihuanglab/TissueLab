"""Discovery run orchestration for long-running autoresearch sessions."""

from __future__ import annotations

import asyncio
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.services.autoresearch import run_autoresearch
from app.services.agent.discovery.models import DiscoveryRun, DiscoverySession, new_run
from app.services.agent.discovery.session_store import DiscoverySessionStore, get_discovery_session_store


class DiscoveryRunManager:
    def __init__(self, store: DiscoverySessionStore) -> None:
        self.store = store
        self._tasks: Dict[str, asyncio.Task] = {}
        self._queues: Dict[str, asyncio.Queue] = {}
        self._lock = asyncio.Lock()

    async def start_run(
        self,
        *,
        session_id: str,
        task: str,
        reasoning_effort: Optional[str],
        max_iterations: int,
        template_type: Optional[str],
        history: Optional[List[Dict[str, str]]],
        context: Optional[Dict[str, Any]],
        auth_user: Optional[Any],
    ) -> DiscoveryRun:
        run = new_run(task=task, reasoning_effort=reasoning_effort, max_iterations=max_iterations)
        run.started_at = datetime.now(timezone.utc).isoformat()

        await asyncio.to_thread(self.store.add_run, session_id, run)
        await asyncio.to_thread(
            self.store.append_message,
            session_id,
            {
                "role": "user",
                "content": task,
                "timestamp": run.started_at,
                "run_id": run.run_id,
            },
        )

        async with self._lock:
            if run.run_id not in self._queues:
                self._queues[run.run_id] = asyncio.Queue()
            self._tasks[run.run_id] = asyncio.create_task(
                self._run_task(
                    session_id=session_id,
                    run=run,
                    template_type=template_type,
                    history=history,
                    context=context,
                    auth_user=auth_user,
                )
            )
        return run

    def get_event_queue(self, run_id: str) -> Optional[asyncio.Queue]:
        return self._queues.get(run_id)

    async def resume_run(
        self,
        *,
        session_id: str,
        original_run_id: str,
        additional_rounds: Optional[int],
        auth_user: Optional[Any],
    ) -> DiscoveryRun:
        """
        Resume a previously started (and incomplete) autoresearch run.

        Creates a new DiscoveryRun in the same session but points
        run_autoresearch() at the original run's directory so it picks up
        from next_round_id in run_state.json.
        """
        import json as _json
        from pathlib import Path as _Path

        # Load session to get workspace_path and original program text
        session = await asyncio.to_thread(self.store.get_session, session_id)
        if session is None:
            raise ValueError(f"Session {session_id} not found")

        workspace_path = (session.context or {}).get("workspace_path", "")
        if not workspace_path:
            raise ValueError("workspace_path not found in session context")

        data_dir = _Path(workspace_path)
        if not data_dir.is_dir():
            data_dir = data_dir.parent

        # Reconstruct the original run root
        resume_run_root = data_dir / "autoresearch_runs" / original_run_id
        state_path = resume_run_root / "run_state.json"
        if not state_path.exists():
            raise ValueError(f"run_state.json not found in {resume_run_root}; run may not be an autoresearch run")

        saved_state = _json.loads(state_path.read_text())
        saved_config = saved_state.get("config", {})
        next_round_id = saved_state.get("next_round_id", 1)

        # Determine how many additional rounds to run
        orig_rounds = saved_config.get("rounds", 3)
        rounds_to_run = additional_rounds if additional_rounds is not None else max(1, orig_rounds - next_round_id + 1)

        # Read program text from the original run directory
        program_path = resume_run_root / "program.md"
        if not program_path.exists():
            program_path = data_dir / "program.md"
        program_text = program_path.read_text() if program_path.exists() else ""

        run = new_run(
            task=program_text[:200] or f"Resume of {original_run_id}",
            reasoning_effort=saved_config.get("reasoning_effort", "high"),
            max_iterations=rounds_to_run * 10,
        )
        run.started_at = datetime.now(timezone.utc).isoformat()

        await asyncio.to_thread(self.store.add_run, session_id, run)

        async with self._lock:
            if run.run_id not in self._queues:
                self._queues[run.run_id] = asyncio.Queue()
            self._tasks[run.run_id] = asyncio.create_task(
                self._resume_task(
                    session_id=session_id,
                    run=run,
                    resume_run_root=resume_run_root,
                    program_text=program_text,
                    saved_config=saved_config,
                    rounds_to_run=rounds_to_run,
                )
            )
        return run

    async def _resume_task(
        self,
        *,
        session_id: str,
        run: DiscoveryRun,
        resume_run_root,
        program_text: str,
        saved_config: dict,
        rounds_to_run: int,
    ) -> None:
        from pathlib import Path as _Path
        from app.services.autoresearch import run_autoresearch

        try:
            await asyncio.to_thread(
                self.store.update_run_status, session_id, run.run_id, status="running"
            )

            workspace_path = resume_run_root.parent.parent  # run_root is data_dir/autoresearch_runs/<id>
            data_dir = _Path(workspace_path)

            result = await run_autoresearch(
                program_text=program_text,
                data_dir=str(data_dir),
                run_root=str(resume_run_root),
                emit=lambda event: self._emit(session_id, run.run_id, event),
                rounds=max(1, rounds_to_run),
                reasoning_effort=str(saved_config.get("reasoning_effort", "high")),
                worker_wall_clock_sec=int(saved_config.get("worker_wall_clock_sec", 900)),
                dataset_scout_enabled=False,  # already scouted on original run
                primary_outcome=str(saved_config.get("primary_outcome", "slope_zmem0")),
            )

            if isinstance(result, dict) and "artifacts" not in result:
                result["artifacts"] = []

            summary = {
                "answer": result.get("answer"),
                "status": result.get("status"),
                "iterations": result.get("iterations"),
                "resumed_from": str(resume_run_root),
            }
            await asyncio.to_thread(
                self.store.update_run_status,
                session_id,
                run.run_id,
                status="completed",
                summary=summary,
                artifacts=result.get("artifacts", []),
                ended_at=datetime.now(timezone.utc).isoformat(),
            )
            await self._emit(session_id, run.run_id, {"type": "complete", "result": result})
        except asyncio.CancelledError:
            await asyncio.to_thread(
                self.store.update_run_status, session_id, run.run_id,
                status="cancelled", ended_at=datetime.now(timezone.utc).isoformat()
            )
            await self._emit(session_id, run.run_id, {"type": "error", "message": "Run cancelled"})
        except Exception as exc:
            await asyncio.to_thread(
                self.store.update_run_status, session_id, run.run_id,
                status="failed", summary={"error": str(exc)},
                ended_at=datetime.now(timezone.utc).isoformat()
            )
            await self._emit(session_id, run.run_id, {"type": "error", "message": str(exc)})
        finally:
            await self._close_queue(run.run_id)

    async def resume_run_from_path(
        self,
        *,
        session_id: str,
        run_root_path: str,
        additional_rounds: Optional[int],
        auth_user: Optional[Any],
    ) -> DiscoveryRun:
        """
        Resume an autoresearch run given its absolute folder path on disk.

        Useful when the original session record is missing from the store
        (e.g. the run crashed before Firestore could persist the session).
        """
        import json as _json

        resume_run_root = Path(run_root_path)
        state_path = resume_run_root / "run_state.json"
        if not state_path.exists():
            raise ValueError(f"run_state.json not found in {resume_run_root}")

        saved_state = _json.loads(state_path.read_text())
        saved_config = saved_state.get("config", {})
        next_round_id = saved_state.get("next_round_id", 1)

        orig_rounds = saved_config.get("rounds", 3)
        rounds_to_run = additional_rounds if additional_rounds is not None else max(1, orig_rounds - next_round_id + 1)

        program_path = resume_run_root / "program.md"
        program_text = program_path.read_text() if program_path.exists() else ""

        run = new_run(
            task=program_text[:200] or f"Resume of {resume_run_root.name}",
            reasoning_effort=saved_config.get("reasoning_effort", "high"),
            max_iterations=rounds_to_run * 10,
        )
        run.started_at = datetime.now(timezone.utc).isoformat()

        await asyncio.to_thread(self.store.add_run, session_id, run)

        async with self._lock:
            if run.run_id not in self._queues:
                self._queues[run.run_id] = asyncio.Queue()
            self._tasks[run.run_id] = asyncio.create_task(
                self._resume_task(
                    session_id=session_id,
                    run=run,
                    resume_run_root=resume_run_root,
                    program_text=program_text,
                    saved_config=saved_config,
                    rounds_to_run=rounds_to_run,
                )
            )
        return run

    async def cancel_run(self, session_id: str, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        if task and not task.done():
            task.cancel()
            await asyncio.to_thread(
                self.store.update_run_status,
                session_id,
                run_id,
                status="cancelled",
                ended_at=datetime.now(timezone.utc).isoformat(),
            )
            await self._emit(session_id, run_id, {"type": "error", "message": "Run cancelled"})
            await self._close_queue(run_id)
            return True
        return False

    async def _emit(self, session_id: str, run_id: str, event: Dict[str, Any]) -> None:
        queue = self._queues.get(run_id)
        if queue:
            await queue.put(event)
        try:
            await asyncio.to_thread(self.store.append_run_event, session_id, run_id, event)
        except Exception:
            pass

    async def _close_queue(self, run_id: str) -> None:
        queue = self._queues.get(run_id)
        if queue:
            await queue.put(None)

    async def _run_task(
        self,
        *,
        session_id: str,
        run: DiscoveryRun,
        template_type: Optional[str],
        history: Optional[List[Dict[str, str]]],
        context: Optional[Dict[str, Any]],
        auth_user: Optional[Any],
    ) -> None:
        try:
            await asyncio.to_thread(
                self.store.update_run_status,
                session_id,
                run.run_id,
                status="running",
            )
            await self._emit(session_id, run.run_id, {"type": "start", "task": run.task})

            # Load session for context
            session = await asyncio.to_thread(self.store.get_session, session_id)
            if session is None:
                raise ValueError(f"Session {session_id} not found")

            # Merge context into session context
            if context:
                session.context = {**(session.context or {}), **context}
                await asyncio.to_thread(self.store.update_session, session)

            if template_type not in (None, "", "autoresearch"):
                raise ValueError(f"unsupported template_type: {template_type}")

            result = await self._run_autoresearch(
                session=session,
                run=run,
                run_context=context,
            )

            summary = {
                "answer": result.get("answer"),
                "status": result.get("status"),
                "iterations": result.get("iterations"),
            }
            artifacts = result.get("artifacts", [])

            await asyncio.to_thread(
                self.store.update_run_status,
                session_id,
                run.run_id,
                status="completed",
                summary=summary,
                artifacts=artifacts,
                ended_at=datetime.now(timezone.utc).isoformat(),
            )

            try:
                await asyncio.to_thread(
                    self.store.append_message,
                    session_id,
                    {
                        "role": "assistant",
                        "content": result.get("answer") or "",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "run_id": run.run_id,
                    },
                )
            except Exception:
                pass

            await self._emit(session_id, run.run_id, {"type": "complete", "result": result})
        except asyncio.CancelledError:
            await asyncio.to_thread(
                self.store.update_run_status,
                session_id,
                run.run_id,
                status="cancelled",
                ended_at=datetime.now(timezone.utc).isoformat(),
            )
            await self._emit(session_id, run.run_id, {"type": "error", "message": "Run cancelled"})
        except Exception as exc:
            await asyncio.to_thread(
                self.store.update_run_status,
                session_id,
                run.run_id,
                status="failed",
                summary={"error": str(exc)},
                ended_at=datetime.now(timezone.utc).isoformat(),
            )
            await self._emit(session_id, run.run_id, {"type": "error", "message": str(exc)})
        finally:
            await self._close_queue(run.run_id)

    async def _run_autoresearch(
        self,
        *,
        session: DiscoverySession,
        run: DiscoveryRun,
        run_context: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Run the sequential autoresearch loop."""
        ctx = {**(session.context or {}), **(run_context or {})}
        workspace_path = ctx.get("workspace_path", "")
        if not workspace_path:
            raise ValueError("workspace_path is required for autoresearch")

        data_dir = Path(workspace_path)
        if not data_dir.is_dir():
            # workspace_path might be a file; use its parent
            data_dir = data_dir.parent

        # Save the user's task as program.md if one doesn't exist yet
        program_path = data_dir / "program.md"
        if not program_path.exists() and run.task:
            await asyncio.to_thread(program_path.write_text, run.task)
        program_text = await asyncio.to_thread(program_path.read_text) if program_path.exists() else run.task

        # Create a run directory inside the workspace
        run_root = data_dir / "autoresearch_runs" / run.run_id
        run_root.mkdir(parents=True, exist_ok=True)

        rounds = int(ctx.get("rounds", 3))
        dataset_scout_enabled = bool(ctx.get("dataset_scout_enabled", True))
        seed_guide_path = ctx.get("seed_guide_path") or ctx.get("seedGuidePath")
        reasoning_effort = str(ctx.get("reasoning_effort", run.reasoning_effort or "high"))
        worker_wall_clock_sec = int(ctx.get("worker_wall_clock_sec", 900))
        if seed_guide_path:
            shared_dir = run_root / "shared"
            shared_dir.mkdir(parents=True, exist_ok=True)
            seed_src = Path(str(seed_guide_path)).expanduser()
            if seed_src.is_dir():
                seed_src = seed_src / "dataset_guide.md"
            if not seed_src.exists():
                raise ValueError(f"seed_guide_path not found: {seed_src}")
            await asyncio.to_thread(shutil.copy2, seed_src, shared_dir / "dataset_guide.md")
            dataset_scout_enabled = False

        result = await run_autoresearch(
            program_text=program_text,
            data_dir=str(data_dir),
            run_root=str(run_root),
            emit=lambda event: self._emit(session.session_id, run.run_id, event),
            rounds=max(1, rounds),
            reasoning_effort=reasoning_effort,
            worker_wall_clock_sec=max(60, worker_wall_clock_sec),
            dataset_scout_enabled=dataset_scout_enabled,
        )

        if isinstance(result, dict) and "artifacts" not in result:
            result["artifacts"] = []
        return result

_run_manager_instance: Optional[DiscoveryRunManager] = None


def get_discovery_run_manager() -> DiscoveryRunManager:
    global _run_manager_instance
    if _run_manager_instance is None:
        _run_manager_instance = DiscoveryRunManager(get_discovery_session_store())
    return _run_manager_instance
