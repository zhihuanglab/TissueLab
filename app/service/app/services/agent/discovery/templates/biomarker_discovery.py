"""
Biomarker discovery orchestration template for the Discovery agent.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional

from app.services.agent.discovery_agent import DiscoveryAgent
from app.services.agent.scientific_reflection_agent import get_scientific_reflection_agent
from app.services.agent.workflow_agent import get_workflow_agent
from app.services.agent.discovery.models import DiscoveryRun, DiscoverySession


async def run_biomarker_discovery(
    *,
    session: DiscoverySession,
    run: DiscoveryRun,
    emit: Callable[[Dict[str, Any]], Awaitable[None]],
    auth_user: Optional[Any] = None,
) -> Dict[str, Any]:
    """
    Execute a structured biomarker discovery loop.
    """
    sci_agent = get_scientific_reflection_agent()
    workflow_agent = get_workflow_agent()
    agent = DiscoveryAgent(
        max_iterations=run.max_iterations,
        reasoning_effort=run.reasoning_effort,
        auth_user=auth_user,
    )

    context = session.context or {}
    dataset_metadata = context.get("dataset_metadata") or {
        "dataset_id": session.dataset_id or "unknown",
        "outcome_variable": context.get("outcome_variable", "OS"),
        "available_markers": context.get("stains", []),
    }

    session_history = _summarize_session(session)

    results: List[Dict[str, Any]] = []
    execution_log: List[Dict[str, Any]] = []

    # Visual analysis (best-effort)
    current_image = context.get("current_image")
    if current_image:
        await emit({"type": "tool_call", "tool": "get_wsi_preview", "arguments": {"file_path": current_image}})
        execution_log.append({"tool": "get_wsi_preview", "arguments": {"file_path": current_image}})
        preview_result = await agent._tool_get_wsi_preview(file_path=current_image)
        await emit({
            "type": "tool_result",
            "tool": "get_wsi_preview",
            "success": not bool(preview_result.get("error")),
            "preview": preview_result.get("preview_path") or preview_result.get("message")
        })

        if preview_result.get("preview_path"):
            await emit({
                "type": "tool_call",
                "tool": "view_slide_region",
                "arguments": {"file_path": current_image, "x": 0.45, "y": 0.45, "width": 0.1, "height": 0.1},
            })
            execution_log.append({"tool": "view_slide_region", "arguments": {"file_path": current_image, "x": 0.45, "y": 0.45, "width": 0.1, "height": 0.1}})
            region_result = await agent._tool_view_slide_region(
                file_path=current_image,
                x=0.45,
                y=0.45,
                width=0.1,
                height=0.1,
                normalized=True,
                output_size=1024,
            )
            await emit({
                "type": "tool_result",
                "tool": "view_slide_region",
                "success": not bool(region_result.get("error")),
                "preview": region_result.get("region_path") or region_result.get("message"),
            })
            await emit({
                "type": "tool_call",
                "tool": "analyze_image",
                "arguments": {"image_path": preview_result["preview_path"], "question": "Summarize visible tissue architecture and notable patterns."},
            })
            execution_log.append({"tool": "analyze_image", "arguments": {"image_path": preview_result["preview_path"]}})
            analysis = await agent._tool_analyze_image(
                image_path=preview_result["preview_path"],
                question="Summarize visible tissue architecture and notable patterns.",
                suggest_workflow=True,
            )
            await emit({
                "type": "tool_result",
                "tool": "analyze_image",
                "success": not bool(analysis.get("error")) if isinstance(analysis, dict) else True,
                "preview": str(analysis)[:120],
            })

    for iteration in range(run.max_iterations):
        await emit({"type": "iteration", "number": iteration + 1})

        await emit({"type": "tool_call", "tool": "generate_hypothesis", "arguments": {"iteration": iteration + 1}})
        execution_log.append({"tool": "generate_hypothesis", "arguments": {"iteration": iteration + 1}})
        hypothesis = await sci_agent.generate_hypothesis(
            dataset_metadata=dataset_metadata,
            session_history=session_history,
            domain_knowledge=context.get("domain_knowledge"),
            exploration_mode=context.get("exploration_mode", "balanced"),
        )
        await emit({
            "type": "tool_result",
            "tool": "generate_hypothesis",
            "success": True,
            "preview": hypothesis.get("hypothesis", "")[:140],
        })

        hypothesis_text = hypothesis.get("hypothesis", "")
        hypothesis_structured = hypothesis.get("hypothesis_structured", {})

        await emit({"type": "tool_call", "tool": "plan_workflow", "arguments": {"task_description": hypothesis_text}})
        execution_log.append({"tool": "plan_workflow", "arguments": {"task_description": hypothesis_text}})
        steps_payload = None
        try:
            steps_str = await workflow_agent.get_processing_steps(
                hypothesis_text,
                history=None,
                data_context={"dataset_metadata": dataset_metadata},
                user_id=session.user_id,
            )
            steps_payload = json.loads(steps_str)
            steps = steps_payload.get("steps", [])
        except Exception:
            steps = []
        if steps:
            await emit({"type": "workflow_steps", "steps": steps, "task": hypothesis_text})
        await emit({
            "type": "tool_result",
            "tool": "plan_workflow",
            "success": True,
            "preview": f"{len(steps)} steps" if steps else "No steps",
        })

        await emit({"type": "tool_call", "tool": "execute_code", "arguments": {"mode": "run"}})
        execution_log.append({"tool": "execute_code", "arguments": {"mode": "run"}})
        script_prompt = (
            f"Generate Python code to test this biomarker hypothesis using the dataset metadata. "
            f"Hypothesis: {hypothesis_text}\n"
            f"Structured: {json.dumps(hypothesis_structured, indent=2)}"
        )
        script = await workflow_agent.get_script(
            script_task=script_prompt,
            zarr_structure=None,
            original_question=hypothesis_text,
            web_search_enabled=False,
        )

        exec_result = await agent._tool_execute_code(
            code=script,
            description="Execute biomarker discovery hypothesis test",
            mode="run",
            artifact_dir=_artifact_dir(session.session_id, run.run_id),
        )
        await emit({
            "type": "tool_result",
            "tool": "execute_code",
            "success": not bool(exec_result.get("error")),
            "preview": (exec_result.get("output") or exec_result.get("error") or "")[:140],
        })

        experiment = {
            "hypothesis": hypothesis_text,
            "hypothesis_structured": hypothesis_structured,
            "execution_result": exec_result,
        }
        await emit({"type": "tool_call", "tool": "evaluate_experiment", "arguments": {"iteration": iteration + 1}})
        execution_log.append({"tool": "evaluate_experiment", "arguments": {"iteration": iteration + 1}})
        evaluation = await sci_agent.evaluate_experiment(
            experiment=experiment,
            dataset_metadata=dataset_metadata,
            session_history=session_history,
        )
        await emit({
            "type": "tool_result",
            "tool": "evaluate_experiment",
            "success": True,
            "preview": evaluation.get("verdict", "")
        })

        results.append({
            "hypothesis": hypothesis,
            "execution_result": exec_result,
            "evaluation": evaluation,
        })

        session_history = _summarize_runs(results)

        if evaluation.get("termination_recommended"):
            break

        if evaluation.get("should_refine"):
            await emit({"type": "tool_call", "tool": "refine_hypothesis", "arguments": {"iteration": iteration + 1}})
            execution_log.append({"tool": "refine_hypothesis", "arguments": {"iteration": iteration + 1}})
            hypothesis = await sci_agent.refine_hypothesis(
                prior_hypothesis=hypothesis,
                evaluation=evaluation,
                dataset_metadata=dataset_metadata,
            )
            await emit({
                "type": "tool_result",
                "tool": "refine_hypothesis",
                "success": True,
                "preview": hypothesis.get("hypothesis", "")[:140]
            })

    summary_text = _build_summary(results)
    await emit({"type": "response_start"})
    if summary_text:
        for chunk in _chunk_text(summary_text):
            await emit({"type": "response_chunk", "content": chunk})
    await emit({"type": "response_end"})

    artifacts = _collect_artifacts(_artifact_dir(session.session_id, run.run_id))

    return {
        "answer": summary_text or "Biomarker discovery run completed.",
        "status": "completed",
        "iterations": len(results),
        "execution_log": execution_log,
        "results": results,
        "artifacts": artifacts,
    }


def _artifact_dir(session_id: str, run_id: str) -> str:
    base = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "storage", "discovery_sessions")
    path = os.path.join(base, session_id, "runs", run_id, "artifacts")
    os.makedirs(path, exist_ok=True)
    return path


def _collect_artifacts(root: str) -> List[Dict[str, Any]]:
    artifacts: List[Dict[str, Any]] = []
    if not root or not os.path.isdir(root):
        return artifacts
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            full_path = os.path.join(dirpath, name)
            try:
                stat = os.stat(full_path)
                artifacts.append({
                    "path": full_path,
                    "name": name,
                    "size_bytes": stat.st_size,
                    "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                })
            except Exception:
                artifacts.append({"path": full_path, "name": name})
    return artifacts


def _summarize_session(session: DiscoverySession) -> str:
    if not session.runs:
        return "No prior runs."
    lines = ["Prior run summaries:"]
    for run in session.runs[-5:]:
        summary = run.summary or {}
        lines.append(f"- {run.run_id}: status={run.status} iterations={summary.get('iterations')} answer={str(summary.get('answer',''))[:120]}")
    return "\n".join(lines)


def _summarize_runs(results: List[Dict[str, Any]]) -> str:
    if not results:
        return "No experiments yet."
    lines = ["Recent experiment outcomes:"]
    for idx, item in enumerate(results[-5:], 1):
        hyp = item.get("hypothesis", {}).get("hypothesis", "")
        eval_info = item.get("evaluation", {})
        lines.append(f"{idx}. {hyp[:80]} | verdict={eval_info.get('verdict')} score={eval_info.get('score')}")
    return "\n".join(lines)


def _build_summary(results: List[Dict[str, Any]]) -> str:
    if not results:
        return "No hypotheses were completed in this run."
    best = None
    best_score = -1
    for item in results:
        eval_info = item.get("evaluation", {})
        score = eval_info.get("score") or 0
        if score > best_score:
            best_score = score
            best = item
    if not best:
        return "No evaluation results available."
    hypothesis = best.get("hypothesis", {}).get("hypothesis", "")
    verdict = best.get("evaluation", {}).get("verdict", "unknown")
    score = best.get("evaluation", {}).get("score", "N/A")
    suggestions = best.get("evaluation", {}).get("improvement_suggestions", [])
    summary_lines = [
        "Biomarker discovery summary:",
        f"- Best hypothesis: {hypothesis}",
        f"- Verdict: {verdict} (score {score})",
    ]
    if suggestions:
        summary_lines.append("- Next improvements: " + "; ".join(suggestions[:3]))
    return "\n".join(summary_lines)


def _chunk_text(text: str, chunk_size: int = 40) -> List[str]:
    words = text.split(" ")
    chunks: List[str] = []
    current: List[str] = []
    for word in words:
        current.append(word)
        if len(current) >= chunk_size:
            chunks.append(" ".join(current) + " ")
            current = []
    if current:
        chunks.append(" ".join(current))
    return chunks
