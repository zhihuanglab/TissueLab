import { usePathWriteAccess } from "@/hooks/usePathWriteAccess"
import React, { useState, useRef, useEffect, useCallback } from "react"
import {
  Loader2, Play, Square, ChevronDown, ChevronRight,
  FlaskConical, Users, History, Plus, FolderOpen, FileText, RotateCcw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/utils/common/twMerge"
import { useDispatch, useSelector } from "react-redux"
import { useActiveSlidePath } from "@/utils/viewer/slidePath";
import { RootState, AppDispatch } from "@/store"
import { setSelectedAgent, type AgentName } from "@/store/slices/chat/agentSlice"
import { formatPath } from "@/utils/common/path.utils"
import { CTRL_SERVICE_API_ENDPOINT } from "@/config/api.config"
import { getAuthToken } from "@/utils/common/authToken"
import {
  isResearchCancelling,
  isResearchRunning,
  transitionResearchPhase,
  type ResearchPhase,
} from "@/utils/agent/research/phaseStateMachine"
import {
  appendJournalEntry,
  failPendingProposer,
  stopRunningRows,
  stopRunningScout,
  type JournalEntry,
  type RoundState,
  type ScoutState,
} from "./researchRunState"

// ─── Types ───────────────────────────────────────────────────────────────────

const SCOUT_IDLE: ScoutState = { status: "idle", calls: [] }
const CANCEL_TIMEOUT_MS = 15_000
const BUSY_TITLE = "Stop the running research first"

type WorkspaceRun = {
  run_id: string
  run_root_path: string
  status: "running" | "completed" | "incomplete"
  updated_at?: string
  rounds: number
  next_round_id: number
}

type ResumeInfo = {
  runId: string
  runRootPath: string
  nextRoundId: number
}

// ─── Lightweight markdown renderer ───────────────────────────────────────────

function renderMarkdown(text: string): React.ReactNode[] {
  const elements: React.ReactNode[] = []
  const lines = text.split("\n")
  let bullets: string[] = []
  let key = 0

  const flush = () => {
    if (bullets.length === 0) return
    elements.push(
      <ul key={key++} className="list-disc list-outside pl-4 space-y-0.5 my-1">
        {bullets.map((b, i) => <li key={i}>{inlineFormat(b)}</li>)}
      </ul>
    )
    bullets = []
  }

  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith("## ")) {
      flush()
      elements.push(<h2 key={key++} className="text-sm font-bold text-foreground mt-3 mb-1 first:mt-0">{inlineFormat(t.slice(3))}</h2>)
    } else if (t.startsWith("# ")) {
      flush()
      elements.push(<h1 key={key++} className="text-base font-bold text-foreground mt-3 mb-1 first:mt-0">{inlineFormat(t.slice(2))}</h1>)
    } else if (t.startsWith("### ")) {
      flush()
      elements.push(<h3 key={key++} className="text-xs font-semibold text-foreground mt-2 mb-0.5">{inlineFormat(t.slice(4))}</h3>)
    } else if (t.startsWith("- ") || t.startsWith("* ")) {
      bullets.push(t.slice(2))
    } else if (t === "---") {
      flush()
      elements.push(<hr key={key++} className="my-2 border-border" />)
    } else if (t.length > 0) {
      flush()
      elements.push(<p key={key++} className="my-0.5">{inlineFormat(line)}</p>)
    } else {
      flush()
    }
  }
  flush()
  return elements
}

function inlineFormat(text: string): React.ReactNode {
  // Split on inline patterns: **bold**, *italic*, `code`
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g)
  return parts.map((seg, i) => {
    if (seg.startsWith("**") && seg.endsWith("**"))
      return <strong key={i} className="font-semibold">{seg.slice(2, -2)}</strong>
    if (seg.startsWith("*") && seg.endsWith("*") && seg.length >= 3)
      return <em key={i}>{seg.slice(1, -1)}</em>
    if (seg.startsWith("`") && seg.endsWith("`"))
      return <code key={i} className="px-1 py-0.5 rounded bg-muted text-foreground font-mono text-[10px]">{seg.slice(1, -1)}</code>
    return seg
  })
}

// ─── Component ───────────────────────────────────────────────────────────────

export const CoscientistPanel: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>()
  const currentPath = useActiveSlidePath();
  const { allowed: pathWritable, tooltip: writeBlockTitle } = usePathWriteAccess(currentPath);
  const selectedAgent = useSelector((state: RootState) => state.agent.selectedAgent)

  // Phase state machine: input → running → cancelling → complete
  const [phase, setPhase] = useState<ResearchPhase>("input")

  // Input state
  // The research program in plain words (or problem.md with its header); the service works out the rest.
  const [program, setProgram] = useState("")
  const [formResetKey, setFormResetKey] = useState(0)
  const [rounds, setRounds] = useState(3)
  // Hypotheses (and parallel workers, one sandbox each) per round; at most one is admitted.
  const [workersPerRound, setWorkersPerRound] = useState(1)
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high">("high")
  const [workerTimeLimitMin, setWorkerTimeLimitMin] = useState(30)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [datasetScout, setDatasetScout] = useState(true)

  // Workspace run state
  const [workspaceRuns, setWorkspaceRuns] = useState<WorkspaceRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [resumeInfo, setResumeInfo] = useState<ResumeInfo | null>(null)
  const [resumeRounds, setResumeRounds] = useState(3)

  // Run state
  const [currentRound, setCurrentRound] = useState<RoundState | null>(null)
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selectedWorker, setSelectedWorker] = useState<string | null>(null)
  const [roundPhase, setRoundPhase] = useState<"proposing" | "workers" | "materializing" | "evaluating" | "done" | null>(null)
  const [scout, setScout] = useState<ScoutState>(SCOUT_IDLE)
  const [finalSummary, setFinalSummary] = useState<string | null>(null)
  const [expandedJournalIdx, setExpandedJournalIdx] = useState<number | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Bumped whenever the view changes run (start, resume, history, new task, unmount):
  // a stream or request begun under an older token must not write state.
  const runTokenRef = useRef(0)
  // The token Stop was pressed under: the aborted stream then rejects, and that is not an error.
  const stoppedTokenRef = useRef(-1)
  const roundSummaryRef = useRef<string>("")
  const runsSeqRef = useRef(0)
  // The program box: typed into since the last reset (a slow pre-fill must not overwrite
  // it), and the newest pre-fill request (only it may write).
  const programTypedRef = useRef(false)
  const programSeqRef = useRef(0)

  const workspacePath = formatPath(currentPath ?? "")
  // The open slide's folder; formatPath yields "\\" separators on Windows.
  const workspaceDir = workspacePath ? workspacePath.replace(/[\\/][^\\/]+$/, "") || workspacePath : ""

  // A new run in view: drop the old stream (if any) and hand out a fresh token.
  const beginRun = () => {
    abortRef.current?.abort()
    abortRef.current = null
    roundSummaryRef.current = ""
    return ++runTokenRef.current
  }
  const isStale = (token: number) => token !== runTokenRef.current || stoppedTokenRef.current === token

  // Unmounted (e.g. the header switched to Agent): stop listening; the run itself
  // goes on and can be reopened from the history.
  useEffect(() => () => {
    runTokenRef.current++
    abortRef.current?.abort()
  }, [])

  // ─── API helpers ─────────────────────────────────────────────────────────

  const authedFetch = useCallback(async (url: string, options: RequestInit) => {
    const authToken = await getAuthToken().catch(() => null)
    const headers = new Headers(options.headers || {})
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
    if (authToken) headers.set("Authorization", `Bearer ${authToken}`)
    const res = await fetch(url, { ...options, headers })
    let data: any = null
    try { data = await res.json() } catch { data = null }
    return { ok: res.ok, status: res.status, data }
  }, [])

  // ─── Runs ────────────────────────────────────────────────────────────────

  const fetchWorkspaceRuns = useCallback(async () => {
    // Only the newest request (this folder) may write the list.
    const seq = ++runsSeqRef.current
    if (!workspaceDir) {
      setWorkspaceRuns([])
      setRunsLoading(false)
      return
    }
    setRunsLoading(true)
    let runs: WorkspaceRun[] = []
    try {
      const res = await authedFetch(
        `${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery/runs?workspace_path=${encodeURIComponent(workspaceDir)}`,
        { method: "GET" }
      )
      if (res.ok && res.data?.code === 0) runs = (res.data.data?.runs || []) as WorkspaceRun[]
    } catch {}
    if (seq !== runsSeqRef.current) return
    setWorkspaceRuns(runs)
    setRunsLoading(false)
  }, [authedFetch, workspaceDir])
  // For callbacks that outlive a render (a run's stream, Stop): always this folder's.
  const fetchRunsRef = useRef(fetchWorkspaceRuns)
  fetchRunsRef.current = fetchWorkspaceRuns

  const loadWorkspaceRun = async (runRootPath: string, token: number) => {
    let payload: any
    try {
      const res = await authedFetch(
        `${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery/runs/load?run_root_path=${encodeURIComponent(runRootPath)}`,
        { method: "GET" }
      )
      if (!res.ok || res.data?.code !== 0) return
      payload = res.data.data || {}
    } catch {
      return
    }
    if (isStale(token)) return
    setJournal((payload.journal || []) as JournalEntry[])
    setFinalSummary(payload.final_summary || null)
    setCurrentRound(null)
    setActiveRunId(null)
    setRoundPhase(null)
    setResumeInfo(payload.status === "incomplete"
      ? { runId: payload.run_id, runRootPath: payload.run_root_path, nextRoundId: payload.next_round_id }
      : null)
    // offer the rounds the run still had planned
    setResumeRounds(Math.max(1, (payload.rounds || 1) - (payload.next_round_id || 1) + 1))
    if (payload.status !== "running" || !payload.run_id) {
      setPhase("complete")
      return
    }
    // Still running (e.g. the panel was closed meanwhile): watch it again, so it can be stopped.
    setActiveRunId(payload.run_id)
    setPhase("running")
    try {
      await consumeStream(payload.run_id, token, true)
    } catch {
      if (isStale(token)) return
      // Gone after all: what was loaded stays.
      setActiveRunId(null)
      setCurrentRound(stopRunningRows)
      setPhase("complete")
    }
  }

  const resumeResearch = async () => {
    if (!resumeInfo) return
    if (!pathWritable) {
      setError(writeBlockTitle || 'Not allowed here.')
      return
    }
    const token = beginRun()
    const { runRootPath, nextRoundId } = resumeInfo
    setError(null)
    setPhase("running")
    // The rounds done so far stay in the journal; the resumed run adds to them.
    setJournal(prev => prev.filter(j => j.roundId < nextRoundId))
    setCurrentRound(null)
    setScout(SCOUT_IDLE)
    setFinalSummary(null)
    setActiveRunId(null)

    try {
      const res = await authedFetch(`${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery/runs/resume`, {
        method: "POST",
        body: JSON.stringify({ run_root_path: runRootPath, additional_rounds: resumeRounds }),
      })
      if (!res.ok || res.data?.code !== 0) throw new Error(res.data?.message || "Failed to resume run")
      const runId = res.data.data?.run_id
      if (!runId) throw new Error("Run ID missing")
      if (cancelIfStopped(runId, token)) return
      setResumeInfo(null)
      setActiveRunId(runId)
      await consumeStream(runId, token)
    } catch (err: any) {
      if (isStale(token)) return
      setError(err.message)
      setCurrentRound(stopRunningRows)
      setScout(stopRunningScout)
      setPhase("complete")
    }
  }

  useEffect(() => { fetchWorkspaceRuns() }, [fetchWorkspaceRuns])

  // Pre-fill the program from the workspace's problem.md (the last run's), on a new
  // workspace and on "+".
  useEffect(() => {
    programTypedRef.current = false
    const seq = ++programSeqRef.current
    if (!workspaceDir) return
    void (async () => {
      let text = ""
      try {
        const res = await authedFetch(
          `${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery/program?data_dir=${encodeURIComponent(workspaceDir)}`,
          { method: "GET" }
        )
        if (res.ok && res.data?.code === 0) text = String(res.data.data?.text ?? "")
      } catch {}
      if (seq !== programSeqRef.current || programTypedRef.current) return
      setProgram(text)
    })()
  }, [authedFetch, workspaceDir, formResetKey])

  const canStart = Boolean(workspaceDir && program.trim() && pathWritable)

  // ─── Start research ──────────────────────────────────────────────────────

  const startResearch = async () => {
    if (!workspaceDir || !program.trim()) return
    if (!pathWritable) {
      setError(writeBlockTitle || 'Not allowed here.')
      return
    }
    const token = beginRun()
    setError(null)
    setPhase("running")
    setJournal([])
    setCurrentRound(null)
    setScout(SCOUT_IDLE)
    setFinalSummary(null)
    setActiveRunId(null)

    try {
      const res = await authedFetch(`${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery/runs`, {
        method: "POST",
        body: JSON.stringify({
          task: program,
          workspace_path: workspacePath,
          rounds,
          workers_per_round: workersPerRound,
          reasoning_effort: reasoningEffort,
          worker_wall_clock_sec: workerTimeLimitMin * 60,
          dataset_scout: datasetScout,
        }),
      })
      if (!res.ok || res.data?.code !== 0) throw new Error(res.data?.message || "Failed to start run")

      const runId = res.data.data?.run_id
      if (!runId) throw new Error("Run ID missing")
      if (cancelIfStopped(runId, token)) return
      setActiveRunId(runId)
      await consumeStream(runId, token)
    } catch (err: any) {
      if (isStale(token)) return
      setError(err.message)
      setCurrentRound(stopRunningRows)
      setScout(stopRunningScout)
      setPhase("complete")
    }
  }

  // The start / resume request came back after the view moved on: Stop was pressed
  // before the run had an id (cancel it now), or the panel left it (leave it running,
  // it is in the history). Either way its stream is not ours to read.
  const cancelIfStopped = (runId: string, token: number) => {
    if (stoppedTokenRef.current === token) {
      void authedFetch(`${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery/runs/${runId}/cancel`, { method: "POST" })
        .catch(() => { /* best effort */ })
        .finally(() => { void fetchRunsRef.current() })
      return true
    }
    return token !== runTokenRef.current
  }

  // ─── SSE stream consumer ─────────────────────────────────────────────────

  // reattach: a run listed as running may have just ended; then its "not found" is no error.
  const consumeStream = async (runId: string, token: number, reattach = false) => {
    const authToken = await getAuthToken().catch(() => null)
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`
    if (token !== runTokenRef.current) return

    const controller = new AbortController()
    abortRef.current = controller

    const response = await fetch(
      `${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery/runs/${runId}/stream`,
      { method: "GET", headers, signal: controller.signal },
    )
    if (!response.ok) throw new Error(`Stream failed: ${response.status}`)

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let seen = false

    read: while (reader) {
      const { done, value } = await reader.read()
      // Another run (or none) is in view now: this stream may not write anything.
      if (token !== runTokenRef.current) {
        controller.abort()
        return
      }
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        try {
          const event = JSON.parse(line.substring(6))
          // the run is gone (finished and forgotten): stay on the loaded snapshot
          if (reattach && !seen && event.type === "error" && event.message === "Run not found") {
            controller.abort()
            break read
          }
          seen = true
          handleEvent(event)
        } catch {}
      }
    }
    if (token !== runTokenRef.current) return
    setActiveRunId(null)
    setCurrentRound(stopRunningRows)
    setScout(stopRunningScout)
    setPhase("complete")
    void fetchRunsRef.current()
  }

  const handleEvent = (event: any) => {
    switch (event.type) {
      case "scout_started":
        setScout({ status: "running", calls: [] })
        break

      case "scout_tool_call":
        setScout(prev => ({ ...prev, calls: [...prev.calls, { turnId: event.turn_id, thought: "", command: event.command_preview || "", status: "running" }] }))
        break

      case "scout_tool_result":
        setScout(prev => ({
          ...prev,
          calls: prev.calls.map((c, i) => i === prev.calls.length - 1
            ? { ...c, status: event.exit_code === 0 ? "done" : "error", exitCode: event.exit_code } : c),
        }))
        break

      case "scout_done":
        if (event.status === "reused") {
          setScout({ status: "done", calls: [], reusedFrom: event.from })
          break
        }
        setScout(prev => event.status === "completed"
          ? { ...prev, status: "done" }
          : { ...prev, status: "failed", note: event.error || "it finished without writing a guide" })
        break

      case "round_started":
        setRoundPhase("proposing")
        setCurrentRound({
          roundId: event.round_id,
          totalRounds: event.total_rounds || rounds,
          focus: "",
          // The proposer inspects the data first; it is listed with the worker.
          workers: [{ name: "proposer", question: event.workers > 1 ? `Proposing ${event.workers} different hypotheses` : "Proposing a hypothesis", status: "running", toolCalls: [] }],
        })
        break

      case "candidate_proposed":
        // One per worker; the proposer is done once the workers start.
        setCurrentRound(prev => prev ? {
          ...prev,
          focus: prev.focus || event.scientific_question || event.candidate_id || "",
          workers: prev.workers.map(w => w.name === "proposer"
            ? { ...w, summary: [w.summary, event.candidate_id].filter(Boolean).join(", ") } : w),
        } : prev)
        break

      case "proposer_failed":
        setCurrentRound(prev => prev ? {
          ...prev,
          workers: prev.workers.map(w => w.name === "proposer" ? { ...w, summary: [w.summary, event.error].filter(Boolean).join("; ") } : w),
        } : prev)
        break

      case "worker_materialize":
        setRoundPhase("materializing")
        break

      case "judging":
        setRoundPhase("evaluating")
        break

      case "worker_started":
        setRoundPhase("workers")
        setCurrentRound(prev => {
          if (!prev) return prev
          return {
            ...prev,
            workers: [...prev.workers.map(w => w.name === "proposer" && w.status === "running" ? { ...w, status: "completed" as const } : w), {
              name: event.worker_name,
              question: event.scientific_question || "",
              status: "running",
              toolCalls: [],
            }],
          }
        })
        break

      case "worker_completed":
        setCurrentRound(prev => {
          if (!prev) return prev
          return {
            ...prev,
            workers: prev.workers.map(w =>
              w.name === event.worker_name ? { ...w, status: "completed", summary: event.summary } : w
            ),
          }
        })
        break

      case "worker_failed":
        setCurrentRound(prev => {
          if (!prev) return prev
          return {
            ...prev,
            workers: prev.workers.map(w =>
              w.name === event.worker_name ? { ...w, status: "failed", summary: event.summary } : w
            ),
          }
        })
        break

      case "worker_tool_call":
        setCurrentRound(prev => {
          if (!prev) return prev
          return {
            ...prev,
            workers: prev.workers.map(w =>
              w.name === event.worker_name
                ? { ...w, toolCalls: [...w.toolCalls, { turnId: event.turn_id, thought: event.thought || "", command: event.command_preview || "", status: "running" as "running" }] }
                : w
            ),
          }
        })
        break

      case "worker_tool_result":
        setCurrentRound(prev => {
          if (!prev) return prev
          return {
            ...prev,
            workers: prev.workers.map(w =>
              w.name === event.worker_name
                ? {
                    ...w,
                    toolCalls: w.toolCalls.map((tc, i) =>
                      i === w.toolCalls.length - 1
                        ? { ...tc, exitCode: event.exit_code, status: (event.exit_code === 0 ? "done" : "error") as "done" | "error" }
                        : tc
                    ),
                  }
                : w
            ),
          }
        })
        break

      case "round_summary":
        roundSummaryRef.current = event.summary || ""
        setRoundPhase("done")
        setCurrentRound(failPendingProposer)
        break

      case "round_completed":
        setRoundPhase(null)
        {
          const savedSummary = roundSummaryRef.current
          roundSummaryRef.current = ""
          setCurrentRound(prev => {
            setJournal(jPrev => appendJournalEntry(jPrev, {
              roundId: prev?.roundId || event.round_id,
              focus: prev?.focus || "",
              summary: savedSummary,
            }))
            return prev
          })
        }
        break

      case "complete":
        setActiveRunId(null)
        if (event.result?.answer) setFinalSummary(event.result.answer)
        break

      case "error":
        setActiveRunId(null)
        setError(event.message)
        setPhase("complete")
        break
    }

    // Auto-scroll
    setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }), 50)
  }

  const stopResearch = () => {
    if (phase === "cancelling") return
    const runId = activeRunId
    const token = runTokenRef.current
    setPhase(transitionResearchPhase(phase, "STOP"))
    stoppedTokenRef.current = token
    abortRef.current?.abort()
    setCurrentRound(stopRunningRows)
    setScout(stopRunningScout)
    if (runId) {
      void authedFetch(
        `${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery/runs/${runId}/cancel`,
        // a hung request must not hold the panel in "cancelling"
        { method: "POST", signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS) },
      )
        .catch(() => { /* best effort */ })
        .finally(() => {
          void fetchRunsRef.current()   // the stopped run is now resumable from the history
          if (token !== runTokenRef.current) return   // the view moved on meanwhile
          setActiveRunId(null)
          setPhase(transitionResearchPhase("cancelling", "CANCEL_ACK"))
        })
      return
    }
    // No run id yet: the start / resume request cancels the run when it returns.
    setActiveRunId(null)
    setPhase(transitionResearchPhase("cancelling", "CANCEL_ACK"))
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  const formatRelativeTime = (iso?: string) => {
    if (!iso) return "just now"
    const diffMs = Date.now() - Date.parse(iso)
    if (diffMs < 60000) return "just now"
    const mins = Math.floor(diffMs / 60000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  const progressPercent = currentRound
    ? ((currentRound.roundId - 1 + currentRound.workers.filter(w => w.status !== "running").length / Math.max(currentRound.workers.length, 1)) / currentRound.totalRounds) * 100
    : 0

  // Continue an incomplete run: offered on the input page and under a loaded run.
  const resumeCard = resumeInfo && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2.5">
                <div className="flex items-start gap-2">
                  <RotateCcw className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-primary">Incomplete run detected</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      Run <span className="font-mono">{resumeInfo.runId.slice(-8)}</span> stopped at round {resumeInfo.nextRoundId - 1}.
                      Resume from round {resumeInfo.nextRoundId}.
                    </div>
                  </div>
                  <button
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={() => setResumeInfo(null)}
                  >✕</button>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Additional rounds</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={resumeRounds}
                    onChange={e => setResumeRounds(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                    className="w-16 h-7 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/20 focus:outline-none"
                  />
                </div>
                <Button
                  onClick={resumeResearch}
                  disabled={!pathWritable}
                  title={writeBlockTitle}
                  className="w-full h-8 bg-primary hover:bg-primary/90 text-primary-foreground font-medium text-xs"
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                  Resume Run
                </Button>
              </div>
  )

  const isRunning = isResearchRunning(phase)
  const isCancelling = isResearchCancelling(phase)
  // A run is live: switching the view away is disabled until it ends or is stopped.
  const busy = isRunning || isCancelling
  // Each worker's own end does not end the stage: the judge starts once none is left running.
  const stage = (roundPhase === "workers" || roundPhase === "materializing") && currentRound && !currentRound.workers.some(w => w.status === "running")
    ? "evaluating" : roundPhase

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center">
              <FlaskConical className="h-4 w-4 text-primary" />
            </div>
            <Select value={selectedAgent} onValueChange={(value: AgentName) => { if (value !== selectedAgent) dispatch(setSelectedAgent(value)) }}>
              <SelectTrigger className="h-7 w-[150px] border border-border/50 shadow-sm bg-background text-sm font-medium text-foreground hover:bg-muted/50 focus:ring-1 focus:ring-primary/30">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="TLAgent">Agent</SelectItem>
                <SelectItem value="TL Coscientist">Research</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1.5">
            {(isRunning || isCancelling) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-red-500 hover:text-red-600 hover:bg-red-50"
                onClick={stopResearch}
                disabled={isCancelling}
              >
                <Square className="h-3.5 w-3.5 mr-1" />
                <span className="text-xs">{isCancelling ? "Stopping..." : "Stop"}</span>
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Run history" onClick={() => { if (!showHistory) void fetchWorkspaceRuns(); setShowHistory(!showHistory) }}>
              <History className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="New research task" disabled={busy} title={busy ? BUSY_TITLE : undefined} onClick={() => { beginRun(); setPhase("input"); setFormResetKey(k => k + 1); setCurrentRound(null); setJournal([]); setError(null); setResumeInfo(null); setActiveRunId(null); setScout(SCOUT_IDLE); setFinalSummary(null); }}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Progress bar during run */}
        {isRunning && currentRound && (
          <div className="mt-2.5 space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Round {currentRound.roundId}/{currentRound.totalRounds}</span>
            </div>
            <Progress value={progressPercent} className="h-1.5 bg-primary/10 [&>div]:bg-primary" />
          </div>
        )}
      </div>

      {/* Main content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-hide">
        {/* Workspace runs dropdown */}
        {showHistory && (
          <div className="border-b border-border bg-muted/30 px-4 py-2">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Workspace Runs</div>
            {runsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            {!runsLoading && workspaceRuns.length === 0 && (
              <div className="text-xs text-muted-foreground py-1">No autoresearch runs found in this workspace</div>
            )}
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {workspaceRuns.map(run => (
                <button
                  key={run.run_root_path}
                  className={cn(
                    "w-full text-left px-2 py-1 rounded text-xs hover:bg-muted transition-colors disabled:opacity-50 disabled:hover:bg-transparent",
                    run.run_id === activeRunId ? "bg-primary/10 text-primary" : "text-muted-foreground"
                  )}
                  disabled={busy}
                  title={busy ? BUSY_TITLE : undefined}
                  onClick={() => {
                    const token = beginRun()
                    setShowHistory(false)
                    setCurrentRound(null)
                    setJournal([])
                    setFinalSummary(null)
                    setError(null)
                    setScout(SCOUT_IDLE)
                    setResumeInfo(null)
                    void loadWorkspaceRun(run.run_root_path, token)
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{run.run_id}</span>
                    <span className="text-[10px] uppercase tracking-wider">{run.status}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {formatRelativeTime(run.updated_at)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ─── PHASE 1: Program Input ─────────────────────────────────── */}
        {phase === "input" && (
          <div className="p-4 space-y-4">
            {/* Workspace context */}
            {workspaceDir && (
              <div className="flex items-start gap-2.5 p-3 rounded-lg bg-muted/40 border border-border/50">
                <FolderOpen className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground">Workspace</div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate" title={workspaceDir}>{workspaceDir}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">Workers will have read-only access to all files in this folder.</div>
                </div>
              </div>
            )}

            {/* Research program */}
            <div>
              <label htmlFor="research-program" className="text-xs font-semibold text-foreground mb-1.5 block">Research Program</label>
              <Textarea
                id="research-program"
                value={program}
                onChange={e => { programTypedRef.current = true; setProgram(e.target.value) }}
                placeholder="Describe the research program: what to look for in these slides."
                className="min-h-[150px] text-[13px] leading-relaxed resize-none border-border/60 focus:border-primary/50 focus:ring-primary/20 bg-background"
              />
              <div className="text-[10px] text-muted-foreground mt-1">
                This will be saved as <span className="font-mono">problem.md</span> in your workspace.
              </div>
            </div>

            {/* Config */}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 block">Rounds</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={rounds}
                  onChange={e => setRounds(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                  className="w-full h-8 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/20 focus:outline-none"
                />
              </div>
              <div className="flex-1">
                <label htmlFor="workers-per-round" className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 block">Workers</label>
                <input
                  id="workers-per-round"
                  type="number"
                  min={1}
                  max={5}
                  title="Hypotheses tested side by side each round, each in its own sandbox; the best one is kept"
                  value={workersPerRound}
                  onChange={e => setWorkersPerRound(Math.max(1, Math.min(5, parseInt(e.target.value) || 1)))}
                  className="w-full h-8 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/20 focus:outline-none"
                />
              </div>
            </div>

            {/* Advanced parameters (collapsible) */}
            <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
              <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full">
                {showAdvanced ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span className="font-medium">Advanced Parameters</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2.5 space-y-3 pl-1">
                  {/* Reasoning effort */}
                  <div>
                    <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 block">Reasoning Effort</label>
                    <div className="flex gap-1.5">
                      {([["low", "Low", "Fastest"], ["medium", "Medium", "Balanced"], ["high", "High", "Deepest"]] as const).map(([id, label, desc]) => (
                        <button
                          key={id}
                          onClick={() => setReasoningEffort(id)}
                          className={cn(
                            "flex-1 py-1.5 rounded-md text-center border transition-colors",
                            reasoningEffort === id
                              ? "bg-primary/10 border-primary/30 text-primary"
                              : "bg-background border-border text-muted-foreground hover:bg-muted"
                          )}
                        >
                          <div className="text-xs font-medium">{label}</div>
                          <div className="text-[9px] text-muted-foreground">{desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Worker time limit */}
                  <div>
                    <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 block">Worker Time Limit</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={60}
                        value={workerTimeLimitMin}
                        onChange={e => setWorkerTimeLimitMin(Math.max(1, Math.min(60, parseInt(e.target.value) || 10)))}
                        className="w-20 h-8 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/20 focus:outline-none"
                      />
                      <span className="text-xs text-muted-foreground">minutes per worker</span>
                    </div>
                  </div>

                  {/* Dataset scout */}
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <label htmlFor="dataset-scout" className="text-xs font-medium text-foreground">Dataset Scout</label>
                      <div className="text-[10px] text-muted-foreground">Explore data and write a guide before starting</div>
                    </div>
                    <Switch id="dataset-scout" checked={datasetScout} onCheckedChange={setDatasetScout} />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {resumeCard}

            {/* Start button */}
            <Button
              onClick={startResearch}
              disabled={!canStart}
              title={workspaceDir ? writeBlockTitle : "Open a slide first"}
              className="w-full h-10 bg-primary hover:bg-primary/90 text-primary-foreground font-medium shadow-sm"
            >
              <Play className="h-4 w-4 mr-2" />
              Start Research
            </Button>
          </div>
        )}

        {/* ─── PHASE 2: Live Dashboard ────────────────────────────────── */}
        {(phase === "running" || phase === "cancelling" || phase === "complete") && (
          <div className="p-4 space-y-3">
            {/* Error */}
            {error && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                {error}
              </div>
            )}

            {/* Coordinator card */}
            {currentRound?.focus && (
              <div className="rounded-lg border border-border/60 overflow-hidden">
                <div className="px-3 py-2 bg-primary/5 border-b border-border/40 flex items-center gap-2">
                  <FlaskConical className="h-3.5 w-3.5 text-primary" />
                  <span className="text-[10px] font-semibold text-primary uppercase tracking-wider">Hypothesis</span>
                </div>
                <div className="px-3 py-2.5 text-xs text-foreground leading-relaxed">
                  {currentRound.focus}
                </div>
              </div>
            )}

            {/* Workers card */}
            {currentRound && currentRound.workers.length > 0 && (
              <div className="rounded-lg border border-border/60 overflow-hidden">
                <div className="px-3 py-2 bg-muted/30 border-b border-border/40 flex items-center gap-2">
                  <Users className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Proposer &amp; {currentRound.workers.length > 2 ? "Workers" : "Worker"}
                  </span>
                  <span className="text-[10px] text-muted-foreground ml-auto">
                    {currentRound.workers.filter(w => w.status === "completed").length}/{currentRound.workers.length}
                  </span>
                </div>
                <div className="divide-y divide-border/30">
                  {currentRound.workers.map(w => {
                    const isSelected = selectedWorker === w.name
                    return (
                      <div key={w.name}>
                        <button
                          className={cn(
                            "w-full text-left px-3 py-2 flex items-start gap-2.5 transition-colors",
                            isSelected ? "bg-primary/5" : "hover:bg-muted/30",
                          )}
                          onClick={() => setSelectedWorker(isSelected ? null : w.name)}
                        >
                          <div className="mt-0.5 shrink-0">
                            {w.status === "running" ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                            ) : w.status === "completed" ? (
                              <div className="h-3.5 w-3.5 rounded-full bg-primary flex items-center justify-center">
                                <svg className="h-2 w-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                              </div>
                            ) : w.status === "failed" ? (
                              <div className="h-3.5 w-3.5 rounded-full bg-red-500 flex items-center justify-center">
                                <svg className="h-2 w-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </div>
                            ) : (
                              <div className="h-3.5 w-3.5 rounded-full border-2 border-border" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-medium text-foreground">{w.name}</span>
                              {!isSelected && w.toolCalls.length > 0 && (
                                <span className="text-[10px] text-muted-foreground/60 ml-auto">{w.toolCalls.length} tool calls</span>
                              )}
                              {isSelected ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                            </div>
                            {w.question && (
                              <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug truncate">{w.question}</div>
                            )}
                            {w.summary && w.status !== "running" && (
                              <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{w.summary}</div>
                            )}
                          </div>
                        </button>
                        {isSelected && (
                          <div className="border-t border-border/20 bg-muted/10 px-3 py-2">
                            {w.toolCalls.length === 0 ? (
                              <div className="text-[11px] text-muted-foreground italic">
                                {w.status === "running" ? "Waiting for first tool call..." : "No tool calls recorded."}
                              </div>
                            ) : (
                              <div className="space-y-1">
                                {w.toolCalls.map((tc, i) => (
                                  <div key={i} className="flex items-start gap-2 text-[11px]">
                                    <div className="mt-0.5 shrink-0">
                                      {tc.status === "running" ? (
                                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                                      ) : tc.status === "done" ? (
                                        <div className="h-3 w-3 rounded-full bg-green-500/80 flex items-center justify-center">
                                          <svg className="h-1.5 w-1.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                          </svg>
                                        </div>
                                      ) : tc.status === "stopped" ? (
                                        <div className="h-3 w-3 rounded-full border-2 border-border" />
                                      ) : (
                                        <div className="h-3 w-3 rounded-full bg-red-500/80 flex items-center justify-center">
                                          <svg className="h-1.5 w-1.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                          </svg>
                                        </div>
                                      )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <span className="text-foreground block">{tc.thought || tc.command || `Turn ${tc.turnId}`}</span>
                                      {tc.exitCode !== undefined && tc.status !== "running" && tc.exitCode !== 0 && (
                                        <span className="text-[10px] text-red-500">exit {tc.exitCode}</span>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Phase status indicator */}
            {isRunning && stage && stage !== "done" && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border/40">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                <span className="text-xs text-muted-foreground">
                  {stage === "proposing" && "Proposer is choosing a hypothesis..."}
                  {stage === "workers" && ((currentRound?.workers.length ?? 0) > 2
                    ? "Workers are implementing their plans side by side..."
                    : "Worker is implementing the plan as result.py...")}
                  {stage === "materializing" && "Running result.py on every donor and checking it..."}
                  {stage === "evaluating" && "Judge is scoring the variations with nested cross-validation..."}
                </span>
              </div>
            )}

            {/* Journal timeline */}
            {journal.length > 0 && (
              <div className="rounded-lg border border-border/60 overflow-hidden">
                <div className="px-3 py-2 bg-muted/30 border-b border-border/40">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Research Journal</span>
                </div>
                <div className="divide-y divide-border/30">
                  {journal.map((entry, idx) => {
                    const isExpanded = expandedJournalIdx === idx
                    return (
                      <div key={idx}>
                        <button
                          className={cn(
                            "w-full text-left px-3 py-2 transition-colors",
                            isExpanded ? "bg-primary/5" : "hover:bg-muted/30"
                          )}
                          onClick={() => setExpandedJournalIdx(isExpanded ? null : idx)}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-semibold text-primary">Round {entry.roundId}</span>
                            {entry.focus && (
                              <span className="text-[10px] text-muted-foreground truncate flex-1">{entry.focus}</span>
                            )}
                            {isExpanded ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                          </div>
                          {!isExpanded && entry.summary && (
                            <div className="text-[11px] text-muted-foreground leading-snug mt-0.5 line-clamp-2">
                              {entry.summary.slice(0, 150)}{entry.summary.length > 150 ? "..." : ""}
                            </div>
                          )}
                        </button>
                        {isExpanded && entry.summary && (
                          <div className="px-3 py-2 bg-muted/10 border-t border-border/20 text-xs text-foreground leading-relaxed max-h-[250px] overflow-y-auto scrollbar-hide">
                            {renderMarkdown(entry.summary)}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Research Findings */}
            {finalSummary && (
              <div className="rounded-lg border border-primary/30 overflow-hidden">
                <div className="px-3 py-2 bg-primary/5 border-b border-primary/20 flex items-center gap-2">
                  <FileText className="h-3.5 w-3.5 text-primary" />
                  <span className="text-[10px] font-semibold text-primary uppercase tracking-wider">Research Findings</span>
                </div>
                <div className="px-3 py-3 text-xs text-foreground leading-relaxed max-h-[400px] overflow-y-auto scrollbar-hide">
                  {renderMarkdown(finalSummary)}
                </div>
              </div>
            )}

            {phase === "complete" && resumeCard}

            {/* Back to input button when complete */}
            {phase === "complete" && (
              <Button
                variant="outline"
                className="w-full h-9 text-xs border-primary/30 text-primary hover:bg-primary/5"
                onClick={() => { beginRun(); setPhase("input"); setCurrentRound(null); setActiveRunId(null); setScout(SCOUT_IDLE); setFinalSummary(null); }}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                New Research Task
              </Button>
            )}

            {/* Dataset scout card: once per run, before round 1 */}
            {scout.status !== "idle" && !currentRound && (
              <div className="px-3 py-2 rounded-lg bg-muted/30 border border-border/40 space-y-1.5" data-testid="scout-card">
                <div className="flex items-center gap-2">
                  {scout.status === "running" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                  ) : (
                    <FileText className={cn("h-3.5 w-3.5 shrink-0", scout.status === "failed" ? "text-amber-600" : "text-primary")} />
                  )}
                  <span className="text-xs text-muted-foreground">
                    {scout.status === "running" && "Dataset scout: exploring the data folder..."}
                    {scout.status === "done" && (scout.reusedFrom
                      ? `Reusing the dataset guide from ${scout.reusedFrom}.`
                      : `Dataset guide written (${scout.calls.length} commands).`)}
                    {scout.status === "failed" && `Dataset scout: no guide (${scout.note}).${isRunning ? " Continuing without it." : ""}`}
                  </span>
                </div>
                {scout.calls.length > 0 && (
                  <div className="space-y-0.5 pl-5">
                    {scout.calls.slice(-5).map((c, i) => (
                      <div key={i} className="font-mono text-[10px] text-muted-foreground truncate" title={c.command}>
                        <span className={cn(c.status === "error" ? "text-amber-600" : c.status === "running" ? "text-primary" : "")}>$</span> {c.command}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Running indicator — only when not scouting and no round yet */}
            {isRunning && !currentRound && scout.status === "idle" && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border/40">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                <span className="text-xs text-muted-foreground">Initializing research...</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
