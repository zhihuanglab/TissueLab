import { usePathWriteAccess } from "@/hooks/usePathWriteAccess"
import React, { useState, useRef, useEffect, useCallback } from "react"
import {
  Loader2, Play, Square, ChevronDown, ChevronRight,
  FlaskConical, Users, History, Plus, FolderOpen, FileText, RotateCcw, Copy, Check,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/utils/common/twMerge"
import { useDispatch, useSelector } from "react-redux"
import { useActiveSlidePath } from "@/utils/viewer/slidePath";
import { RootState, AppDispatch } from "@/store"
import { setSelectedAgent, type AgentName } from "@/store/slices/chat/agentSlice"
import { formatPath } from "@/utils/common/path.utils"
import { CTRL_SERVICE_API_ENDPOINT } from "@/config/api.config"
import { getAuthToken } from "@/utils/common/authToken"
import {
  appendJournalEntry,
  detachedEndState,
  ensureRound,
  failPendingProposer,
  requestErrorMessage,
  roundIdOf,
  stopRunningRows,
  stopRunningScout,
  withWorker,
  type EndState,
  type JournalEntry,
  type RoundState,
  type ScoutState,
} from "./researchRunState"
import { ResearchToolStep, ErrorBox, StatusDot, formatClock, renderMarkdown, workerLabel } from "./researchView"

// ─── Types ───────────────────────────────────────────────────────────────────

const SCOUT_IDLE: ScoutState = { status: "idle", calls: [] }
// A cancel request that hangs is given up on (the stream still tells when the run stops).
const CANCEL_TIMEOUT_MS = 15_000
// Stopping waits for the step in progress; after this long the panel says so.
const STOP_SLOW_MS = 15_000
// Auto-scroll only when the view is already this close to the bottom.
const NEAR_BOTTOM_PX = 80
const DEFAULT_TIME_LIMIT_MIN = 30
const RESEARCH_SETTINGS_KEY = "tissuelab.research.settings"

function readResearchSettings() {
  try {
    const value = JSON.parse(localStorage.getItem(RESEARCH_SETTINGS_KEY) || "{}")
    return value && typeof value === "object" ? value : {}
  } catch { return {} }
}

function savedInteger(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}
const BUSY_TITLE = "Stop the running research first"

// input → running → (cancelling →) complete
type Phase = "input" | "running" | "cancelling" | "complete"

type WorkspaceRun = {
  run_id: string
  run_root_path: string
  status: "running" | "completed" | "incomplete"
  updated_at?: string
  rounds: number
  next_round_id: number
  // the user stopped it (status stays "incomplete": it can be resumed)
  stopped?: boolean
  // the run's research question, when the service lists it
  question?: string
}

type ResumeInfo = {
  runId: string
  runRootPath: string
  nextRoundId: number
}

const END_LABEL: Record<EndState, { text: string; className: string }> = {
  finished: { text: "Finished", className: "bg-primary/10 text-primary border-primary/30" },
  stopped: { text: "Stopped", className: "bg-muted text-muted-foreground border-border" },
  incomplete: { text: "Incomplete", className: "bg-amber-50 text-amber-700 border-amber-200" },
}
const RUN_STATUS_LABEL: Record<WorkspaceRun["status"], string> = {
  running: "Running", completed: "Finished", incomplete: "Incomplete",
}

// ─── Component ───────────────────────────────────────────────────────────────

export const CoscientistPanel: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>()
  const currentPath = useActiveSlidePath();
  const { allowed: pathWritable, tooltip: writeBlockTitle } = usePathWriteAccess(currentPath);
  const selectedAgent = useSelector((state: RootState) => state.agent.selectedAgent)

  const [phase, setPhase] = useState<Phase>("input")
  // For the auto-reattach, which decides after its request returns.
  const phaseRef = useRef(phase)
  useEffect(() => { phaseRef.current = phase }, [phase])

  // Input state
  // The research program in plain words (or program.md with its header); the service works out the rest.
  const [program, setProgram] = useState("")
  const [programSaveStatus, setProgramSaveStatus] = useState<"pending" | "saving" | "saved" | "error" | null>(null)
  const [programSaveError, setProgramSaveError] = useState("")
  const programSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const programMaxSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedProgramTextRef = useRef(new Map<string, string>())
  const pendingProgramRef = useRef<{ text: string; workspace: string; seq: number } | null>(null)
  const programSaveChainRef = useRef<Promise<void>>(Promise.resolve())
  const [formResetKey, setFormResetKey] = useState(0)
  const [savedSettings] = useState(readResearchSettings)
  const [rounds, setRounds] = useState(() => savedInteger(savedSettings.rounds, 3, 1, 20))
  // Hypotheses (and parallel workers) per round; at most one is admitted.
  const [workersPerRound, setWorkersPerRound] = useState(() => savedInteger(savedSettings.workersPerRound, 1, 1, 5))
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high">(() =>
    ["low", "medium", "high"].includes(savedSettings.reasoningEffort) ? savedSettings.reasoningEffort : "high")
  const [workerTimeLimitMin, setWorkerTimeLimitMin] = useState(() => savedInteger(savedSettings.workerTimeLimitMin, DEFAULT_TIME_LIMIT_MIN, 2, 60))
  const [showAdvanced, setShowAdvanced] = useState(() => savedSettings.showAdvanced === true)
  const [datasetScout, setDatasetScout] = useState(() => typeof savedSettings.datasetScout === "boolean" ? savedSettings.datasetScout : true)

  useEffect(() => {
    try {
      localStorage.setItem(RESEARCH_SETTINGS_KEY, JSON.stringify({
        rounds, workersPerRound, reasoningEffort, workerTimeLimitMin, datasetScout, showAdvanced,
      }))
    } catch { /* Storage can be unavailable; keep the form usable. */ }
  }, [rounds, workersPerRound, reasoningEffort, workerTimeLimitMin, datasetScout, showAdvanced])

  // Workspace run state
  const [workspaceRuns, setWorkspaceRuns] = useState<WorkspaceRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [historySearch, setHistorySearch] = useState("")
  const [resumeInfo, setResumeInfo] = useState<ResumeInfo | null>(null)
  const [resumeRounds, setResumeRounds] = useState(3)

  // Run state
  const [currentRound, setCurrentRound] = useState<RoundState | null>(null)
  // The round as of the last event (events update it in order; the journal reads it).
  const roundRef = useRef<RoundState | null>(null)
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selectedWorker, setSelectedWorker] = useState<string | null>(null)
  const [roundPhase, setRoundPhase] = useState<"proposing" | "workers" | "materializing" | "evaluating" | "done" | null>(null)
  const [scout, setScout] = useState<ScoutState>(SCOUT_IDLE)
  const [imageStatus, setImageStatus] = useState<"checking" | "building" | "ready" | "failed" | "stopped" | null>(null)
  const [finalSummary, setFinalSummary] = useState<string | null>(null)
  const [findingsCopyStatus, setFindingsCopyStatus] = useState<"copied" | "error" | null>(null)
  useEffect(() => { setFindingsCopyStatus(null) }, [finalSummary])
  useEffect(() => {
    if (!findingsCopyStatus) return
    const timer = setTimeout(() => setFindingsCopyStatus(null), 2000)
    return () => clearTimeout(timer)
  }, [findingsCopyStatus])
  const [expandedJournalIdx, setExpandedJournalIdx] = useState<number | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [endState, setEndState] = useState<EndState | null>(null)
  // Stop pressed a while ago and the run has not confirmed yet.
  const [stopSlow, setStopSlow] = useState(false)
  const [confirmKind, setConfirmKind] = useState<"stop" | "discard" | null>(null)
  // The column the run in view predicts (the service picks it at start).
  const [outcome, setOutcome] = useState<string | null>(null)
  const [cohort, setCohort] = useState<{ file: string; reason: string } | null>(null)
  // The run's planned rounds and per-worker time limit (seconds; unknown for a reopened run).
  const plannedRoundsRef = useRef(rounds)
  const [runLimitSec, setRunLimitSec] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollPendingRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  // Bumped whenever the view changes run (start, resume, history, new task, unmount):
  // a stream or request begun under an older token must not write state.
  const runTokenRef = useRef(0)
  // The token Stop was pressed under, and the last token whose run ended in view.
  const stoppedTokenRef = useRef(-1)
  const endedTokenRef = useRef(-1)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runsSeqRef = useRef(0)
  // The program box: typed into since the last reset or save (a slow pre-fill must not
  // overwrite it, and "+" asks first), and the newest pre-fill request (only it may write).
  const programTypedRef = useRef(false)
  const programSeqRef = useRef(0)

  const workspacePath = formatPath(currentPath ?? "")
  // The open slide's folder; formatPath yields "\\" separators on Windows.
  const workspaceDir = workspacePath ? workspacePath.replace(/[\\/][^\\/]+$/, "") || workspacePath : ""

  const updateRound = (next: RoundState | null | ((prev: RoundState | null) => RoundState | null)) => {
    roundRef.current = typeof next === "function" ? next(roundRef.current) : next
    setCurrentRound(roundRef.current)
  }

  const clearStopTimer = () => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    stopTimerRef.current = null
  }

  // A new run in view (or none): drop the old stream, clear what it showed, and hand
  // out a fresh token. The one reset for "+", the history, "New Research Task", start and resume.
  const resetView = () => {
    abortRef.current?.abort()
    abortRef.current = null
    clearStopTimer()
    updateRound(null)
    setJournal([])
    setError(null)
    setSelectedWorker(null)
    setExpandedJournalIdx(null)
    setRoundPhase(null)
    setScout(SCOUT_IDLE)
    setImageStatus(null)
    setFinalSummary(null)
    setActiveRunId(null)
    setResumeInfo(null)
    setOutcome(null)
    setCohort(null)
    setEndState(null)
    setStopSlow(false)
    setConfirmKind(null)
    return ++runTokenRef.current
  }

  // Unmounted (e.g. the header switched to Agent): stop listening; the run itself
  // goes on and is reopened when the panel comes back.
  useEffect(() => () => {
    runTokenRef.current++
    abortRef.current?.abort()
    clearStopTimer()
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

  const flushProgramSave = useCallback(() => {
    if (programSaveTimerRef.current) clearTimeout(programSaveTimerRef.current)
    programSaveTimerRef.current = null
    if (programMaxSaveTimerRef.current) clearTimeout(programMaxSaveTimerRef.current)
    programMaxSaveTimerRef.current = null
    const draft = pendingProgramRef.current
    pendingProgramRef.current = null
    if (!draft) return programSaveChainRef.current
    const saving = programSaveChainRef.current.catch(() => {}).then(async () => {
      if (draft.seq === programSeqRef.current) setProgramSaveStatus("saving")
      try {
        // Compare when this queued save runs: an earlier request may have just
        // saved this text, or changed it while the user reverted their edit.
        if (savedProgramTextRef.current.get(draft.workspace) !== draft.text) {
          const res = await authedFetch(`${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery/program`, {
            method: "PUT", body: JSON.stringify({ workspace_path: draft.workspace, text: draft.text }),
          })
          if (!res.ok || res.data?.code !== 0) throw new Error(requestErrorMessage(res.data, "Could not save program"))
          savedProgramTextRef.current.set(draft.workspace, draft.text)
        }
        if (draft.seq === programSeqRef.current) {
          programTypedRef.current = false
          setProgramSaveStatus("saved")
        }
      } catch (err: any) {
        if (draft.seq === programSeqRef.current) {
          setProgramSaveStatus("error")
          setProgramSaveError(err.message)
          pendingProgramRef.current = draft
        }
        throw err
      }
    })
    programSaveChainRef.current = saving
    return saving
  }, [authedFetch])

  const editProgram = (text: string) => {
    setProgram(text)
    programTypedRef.current = true
    const seq = ++programSeqRef.current
    if (!workspaceDir || !pathWritable) return
    pendingProgramRef.current = { text, workspace: workspaceDir, seq }
    setProgramSaveStatus("pending")
    if (programSaveTimerRef.current) clearTimeout(programSaveTimerRef.current)
    programSaveTimerRef.current = setTimeout(() => { void flushProgramSave().catch(() => {}) }, 3000)
    // This timer is not reset by typing, so a long editing session still saves.
    if (!programMaxSaveTimerRef.current) {
      programMaxSaveTimerRef.current = setTimeout(() => { void flushProgramSave().catch(() => {}) }, 15000)
    }
  }

  // ─── Runs ────────────────────────────────────────────────────────────────

  /** This folder's runs; null when a newer request (or another folder) took over. */
  const fetchWorkspaceRuns = useCallback(async (): Promise<WorkspaceRun[] | null> => {
    // Only the newest request (this folder) may write the list.
    const seq = ++runsSeqRef.current
    if (!workspaceDir) {
      setWorkspaceRuns([])
      setRunsLoading(false)
      return []
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
    if (seq !== runsSeqRef.current) return null
    setWorkspaceRuns(runs)
    setRunsLoading(false)
    return runs
  }, [authedFetch, workspaceDir])
  // For callbacks that outlive a render (a run's stream, Stop): always this folder's.
  const fetchRunsRef = useRef(fetchWorkspaceRuns)
  fetchRunsRef.current = fetchWorkspaceRuns

  // The run in view ended (once per token): settle what still spins and say how it ended.
  const endRun = (token: number, end: EndState | null) => {
    if (token !== runTokenRef.current || endedTokenRef.current === token) return
    endedTokenRef.current = token
    clearStopTimer()
    setStopSlow(false)
    setActiveRunId(null)
    updateRound(stopRunningRows)
    setScout(stopRunningScout)
    setImageStatus(prev => prev === "checking" || prev === "building" ? "stopped" : prev)
    setPhase("complete")
    setEndState(end)
    void fetchRunsRef.current()
  }

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
    if (token !== runTokenRef.current) return
    setJournal((payload.journal || []) as JournalEntry[])
    setFinalSummary(payload.final_summary || null)
    setOutcome(payload.outcome || null)
    setCohort(payload.cohort_file ? { file: payload.cohort_file, reason: payload.cohort_selection_reason || "" } : null)
    plannedRoundsRef.current = payload.rounds || 1
    setRunLimitSec(null)
    setResumeInfo(payload.status === "incomplete"
      ? { runId: payload.run_id, runRootPath: payload.run_root_path, nextRoundId: payload.next_round_id }
      : null)
    // offer the rounds the run still had planned
    setResumeRounds(Math.max(1, (payload.rounds || 1) - (payload.next_round_id || 1) + 1))
    if (payload.status !== "running" || !payload.run_id) {
      setEndState(payload.status === "completed" ? "finished" : payload.stopped ? "stopped" : "incomplete")
      setPhase("complete")
      return
    }
    // Still running (e.g. the panel was closed meanwhile): watch it again, so it can be stopped.
    setActiveRunId(payload.run_id)
    setPhase("running")
    try {
      await consumeStream(payload.run_id, token, true, payload.run_root_path)
    } catch {
      // Gone after all: what was loaded stays.
      endRun(token, stoppedTokenRef.current === token ? "stopped" : null)
    }
  }

  const openRun = (runRootPath: string) => {
    const token = resetView()
    setShowHistory(false)
    void loadWorkspaceRun(runRootPath, token)
  }

  const resumeResearch = async () => {
    if (!resumeInfo) return
    if (!pathWritable) {
      setError(writeBlockTitle || 'Not allowed here.')
      return
    }
    const info = resumeInfo
    const keptJournal = journal.filter(j => j.roundId < info.nextRoundId)
    const keptOutcome = outcome
    const token = resetView()
    setPhase("running")
    // The rounds done so far stay in the journal; the resumed run adds to them.
    setJournal(keptJournal)
    setOutcome(keptOutcome)
    plannedRoundsRef.current = info.nextRoundId - 1 + resumeRounds
    setRunLimitSec(null)

    try {
      const res = await authedFetch(`${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery/runs/resume`, {
        method: "POST",
        body: JSON.stringify({ run_root_path: info.runRootPath, additional_rounds: resumeRounds }),
      })
      if (!res.ok || res.data?.code !== 0) throw new Error(requestErrorMessage(res.data, "Couldn't resume the run"))
      const runId = res.data.data?.run_id
      if (!runId) throw new Error("Run ID missing")
      if (cancelIfStopped(runId, token)) return
      setOutcome(res.data.data?.outcome || keptOutcome)
      setCohort(res.data.data?.cohort_file ? { file: res.data.data.cohort_file, reason: res.data.data.cohort_selection_reason || "" } : null)
      setActiveRunId(runId)
      await consumeStream(runId, token)
    } catch (err: any) {
      if (token !== runTokenRef.current || endedTokenRef.current === token) return
      if (stoppedTokenRef.current === token) return endRun(token, "stopped")
      setError(err.message)
      // still resumable
      setResumeInfo(info)
      endRun(token, null)
    }
  }

  // On a new workspace (and when the panel comes back): list its runs, and watch the
  // one still running there, as if it were picked from the history.
  useEffect(() => {
    let live = true
    void fetchWorkspaceRuns().then(runs => {
      const running = runs?.find(r => r.status === "running")
      if (!live || !running || phaseRef.current !== "input" || programTypedRef.current) return
      openRun(running.run_root_path)
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchWorkspaceRuns])

  // Pre-fill the program from the workspace's program.md, on a new
  // workspace and on "+".
  useEffect(() => {
    programTypedRef.current = false
    setProgramSaveStatus(null)
    const seq = ++programSeqRef.current
    if (!workspaceDir) return
    void (async () => {
      let text = ""
      try {
        const res = await authedFetch(
          `${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery/program?data_dir=${encodeURIComponent(workspaceDir)}`,
          { method: "GET" }
        )
        if (res.ok && res.data?.code === 0) {
          text = String(res.data.data?.text ?? "")
          if (seq === programSeqRef.current && !programTypedRef.current) savedProgramTextRef.current.set(workspaceDir, text)
        }
      } catch {}
      if (seq !== programSeqRef.current || programTypedRef.current) return
      setProgram(text)
    })()
    return () => {
      programSeqRef.current++
      void flushProgramSave().catch(() => {})
    }
  }, [authedFetch, workspaceDir, formResetKey, flushProgramSave])

  const canStart = Boolean(workspaceDir && program.trim() && pathWritable)

  // ─── Start research ──────────────────────────────────────────────────────

  const startResearch = async () => {
    if (!workspaceDir || !program.trim()) return
    if (!pathWritable) {
      setError(writeBlockTitle || 'Not allowed here.')
      return
    }
    const savedResume = resumeInfo
    const token = resetView()
    setPhase("running")
    plannedRoundsRef.current = rounds
    setRunLimitSec(workerTimeLimitMin * 60)
    let started = false

    try {
      await flushProgramSave()
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
      if (!res.ok || res.data?.code !== 0) throw new Error(requestErrorMessage(res.data, "Failed to start run"))

      const runId = res.data.data?.run_id
      if (!runId) throw new Error("Run ID missing")
      if (cancelIfStopped(runId, token)) return
      started = true
      // saved as program.md now: nothing unsaved in the box
      programTypedRef.current = false
      setProgramSaveStatus("saved")
      setOutcome(res.data.data?.outcome || null)
      setCohort(res.data.data?.cohort_file ? { file: res.data.data.cohort_file, reason: res.data.data.cohort_selection_reason || "" } : null)
      setActiveRunId(runId)
      await consumeStream(runId, token)
    } catch (err: any) {
      if (token !== runTokenRef.current || endedTokenRef.current === token) return
      if (stoppedTokenRef.current === token) return endRun(token, "stopped")
      setError(err.message)
      if (started) return endRun(token, null)
      // Not started (e.g. no column to predict): back to the form, the program as typed.
      setResumeInfo(savedResume)
      setPhase("input")
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

  // ─── Auto-scroll ─────────────────────────────────────────────────────────

  // Follow new events only when the view is already at the bottom (reading further up
  // is not interrupted); at most one scroll per frame.
  const scheduleScroll = (behavior: ScrollBehavior) => {
    const el = scrollRef.current
    if (!el || scrollPendingRef.current) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight > NEAR_BOTTOM_PX) return
    scrollPendingRef.current = true
    const raf = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (cb: () => void) => setTimeout(cb, 16)
    raf(() => {
      scrollPendingRef.current = false
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior })
    })
  }

  // ─── SSE stream consumer ─────────────────────────────────────────────────

  // reattach: a run listed as running may have just ended; then its "not found" is no error.
  // runRootPath lets the service report a run it no longer holds (e.g. after a restart).
  const consumeStream = async (runId: string, token: number, reattach = false, runRootPath?: string) => {
    const authToken = await getAuthToken().catch(() => null)
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`
    if (token !== runTokenRef.current) return

    const controller = new AbortController()
    abortRef.current = controller

    const response = await fetch(
      `${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery/runs/${runId}/stream${runRootPath ? `?run_root_path=${encodeURIComponent(runRootPath)}` : ""}`,
      { method: "GET", headers, signal: controller.signal },
    )
    if (!response.ok) throw new Error(`Stream failed: ${response.status}`)

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let seen = false
    // How the run ended, as its events tell (none: the stream just closed).
    let ending: EndState | null | undefined

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

      const events: any[] = []
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        try { events.push(JSON.parse(line.substring(6))) } catch {}
      }
      for (const event of events) {
        // the run is gone (finished and forgotten): stay on the loaded snapshot
        if (reattach && !seen && event.type === "error" && event.message === "Run not found") {
          ending = null
          controller.abort()
          break read
        }
        seen = true
        if (event.type === "run_cancelled" || event.type === "run_detached") {
          // The run is over here: stopped, or (reattaching) only on disk now.
          ending = event.type === "run_cancelled" ? "stopped" : detachedEndState(event.status)
          controller.abort()
          break read
        }
        if (event.type === "complete") ending = "finished"
        if (event.type === "error") {
          // the old service's word for a stop, or any error after Stop: not an error to show
          if (event.message === "Run cancelled" || stoppedTokenRef.current === token) {
            ending = "stopped"
            continue
          }
          ending = "incomplete"
        }
        handleEvent(event)
      }
      // A burst (e.g. a reattach replaying the backlog) jumps; single events glide.
      if (events.length) scheduleScroll(events.length > 1 ? "auto" : "smooth")
    }
    if (token !== runTokenRef.current) return
    endRun(token, ending !== undefined ? ending : stoppedTokenRef.current === token ? "stopped" : "incomplete")
  }

  const handleEvent = (event: any) => {
    // A round's event: make a stub round when its round_started was missed (reattached mid-round).
    const inRound = (update: (round: RoundState) => RoundState) =>
      updateRound(prev => {
        const round = ensureRound(prev, roundIdOf(event), plannedRoundsRef.current)
        return round ? update(round) : round
      })

    switch (event.type) {
      case "sandbox_image":
        if (["checking", "building", "ready", "failed"].includes(event.status)) setImageStatus(event.status)
        break

      case "scout_started":
        setScout({ status: "running", calls: [] })
        break

      case "scout_tool_call":
        setScout(prev => ({ ...prev, calls: [...prev.calls, { turnId: event.turn_id, thought: "", command: event.command || event.command_preview || "", status: "running" }] }))
        break

      case "scout_tool_result":
        setScout(prev => ({
          ...prev,
          calls: prev.calls.map((c, i) => i === prev.calls.length - 1
            ? { ...c, status: event.exit_code === 0 ? "done" : "error", exitCode: event.exit_code, stdout: event.stdout, stderr: event.stderr } : c),
        }))
        break

      case "scout_done":
        if (event.status === "reused") {
          setScout({ status: "done", calls: [], reusedFrom: event.from })
          break
        }
        setScout(prev => event.status === "completed"
          ? { ...prev, status: "done" }
          : { ...prev, status: "failed", note: event.error || "it finished without writing them" })
        break

      case "round_started":
        setRoundPhase("proposing")
        updateRound({
          roundId: event.round_id,
          totalRounds: event.total_rounds || plannedRoundsRef.current,
          focus: "",
          startedAt: Date.now(),
          // The proposer inspects the data first; it is listed with the worker.
          workers: [{
            name: "proposer",
            question: event.workers > 1 ? `Choosing ${event.workers} different ideas to test` : "Choosing an idea to test",
            status: "running",
            toolCalls: [],
            startedAt: Date.now(),
          }],
        })
        break

      case "candidate_proposed":
        // One per worker; the proposer is done once the workers start.
        inRound(r => ({
          ...r,
          focus: r.focus || event.scientific_question || event.candidate_id || "",
          workers: r.workers.map(w => w.name === "proposer"
            ? { ...w, summary: [w.summary, event.candidate_id].filter(Boolean).join(", ") } : w),
        }))
        break

      case "proposer_failed":
        inRound(r => ({
          ...r,
          workers: r.workers.map(w => w.name === "proposer" ? { ...w, summary: [w.summary, event.error].filter(Boolean).join("; ") } : w),
        }))
        break

      case "worker_materialize":
        setRoundPhase("materializing")
        break

      case "judging":
        setRoundPhase("evaluating")
        break

      case "worker_started":
        setRoundPhase("workers")
        inRound(r => withWorker(
          { ...r, workers: r.workers.map(w => w.name === "proposer" && w.status === "running" ? { ...w, status: "completed" as const } : w) },
          event.worker_name,
          w => ({ ...w, question: event.scientific_question || w.question, startedAt: w.startedAt ?? Date.now() }),
        ))
        break

      case "worker_completed":
      case "worker_failed":
        inRound(r => withWorker(r, event.worker_name, w => ({
          ...w, status: event.type === "worker_completed" ? "completed" : "failed", summary: event.summary,
        })))
        break

      case "worker_tool_call":
        inRound(r => withWorker(r, event.worker_name, w => ({
          ...w,
          toolCalls: [...w.toolCalls, { turnId: event.turn_id, thought: event.thought || "", command: event.command || event.command_preview || "", status: "running" }],
        })))
        break

      case "worker_tool_result":
        inRound(r => withWorker(r, event.worker_name, w => ({
          ...w,
          toolCalls: w.toolCalls.map((tc, i) =>
            i === w.toolCalls.length - 1
              ? { ...tc, exitCode: event.exit_code, stdout: event.stdout, stderr: event.stderr, status: event.exit_code === 0 ? "done" : "error" }
              : tc
          ),
        })))
        break

      case "round_summary":
        setRoundPhase("done")
        inRound(r => ({ ...failPendingProposer(r)!, summary: event.summary || "" }))
        break

      case "round_completed": {
        setRoundPhase(null)
        const round = roundRef.current
        setJournal(prev => appendJournalEntry(prev, {
          roundId: round?.roundId || event.round_id,
          focus: round?.focus || "",
          summary: round?.summary || "",
          toolCalls: round?.workers.flatMap(worker => worker.toolCalls) || [],
        }))
        break
      }

      case "complete":
        setActiveRunId(null)
        if (event.result?.answer) setFinalSummary(event.result.answer)
        break

      case "error":
        setActiveRunId(null)
        setError(event.message)
        break
    }
  }

  // ─── Stop ────────────────────────────────────────────────────────────────

  // Stop waits for the run to say it stopped (run_cancelled, or its stream closing):
  // until then the panel shows "Stopping" and keeps listening.
  const stopResearch = () => {
    if (phase !== "running") return
    const runId = activeRunId
    const token = runTokenRef.current
    stoppedTokenRef.current = token
    setPhase("cancelling")
    // No run id yet: the start / resume request cancels the run when it returns.
    if (!runId) return endRun(token, "stopped")
    clearStopTimer()
    stopTimerRef.current = setTimeout(() => {
      if (token === runTokenRef.current) setStopSlow(true)
    }, STOP_SLOW_MS)
    void authedFetch(
      `${CTRL_SERVICE_API_ENDPOINT}/agent/v1/discovery/runs/${runId}/cancel`,
      { method: "POST", signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS) },
    )
      .then(res => {
        // Not active any more: it had already stopped (or finished); nothing more will come.
        const notActive = res.ok && res.data?.code === 0
          ? res.data.data?.cancelled === false
          : /not active/i.test(String(res.data?.message ?? ""))
        if (!notActive || token !== runTokenRef.current) return
        abortRef.current?.abort()
        endRun(token, "stopped")
      })
      .catch(() => { /* best effort: the stream still tells when it stops */ })
  }

  // ─── New task ────────────────────────────────────────────────────────────

  // "+": a fresh form, pre-filled again from the workspace's program.md.
  const startOver = async () => {
    if (programSaveTimerRef.current) clearTimeout(programSaveTimerRef.current)
    if (programMaxSaveTimerRef.current) clearTimeout(programMaxSaveTimerRef.current)
    programMaxSaveTimerRef.current = null
    pendingProgramRef.current = null
    // An in-flight autosave may already be writing; read the fresh draft after it.
    await programSaveChainRef.current.catch(() => {})
    resetView()
    setPhase("input")
    setFormResetKey(k => k + 1)
  }
  const requestNewTask = () => {
    if (phase === "input" && programTypedRef.current && program.trim()) setConfirmKind("discard")
    else startOver()
  }

  // ─── Elapsed time ────────────────────────────────────────────────────────

  const isRunning = phase === "running"
  const isCancelling = phase === "cancelling"
  // A run is live: switching the view away is disabled until it ends or is stopped.
  const busy = isRunning || isCancelling

  useEffect(() => {
    if (!isRunning) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isRunning])

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

  // A history entry's title: its question's first line, else when it last ran.
  const runTitle = (run: WorkspaceRun) => {
    const question = run.question?.trim().split("\n")[0]
    if (question) return question
    const t = run.updated_at ? Date.parse(run.updated_at) : NaN
    return Number.isNaN(t)
      ? "Research run"
      : `Run of ${new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
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
                    <div className="text-xs font-semibold text-primary">A previous run in this folder didn&apos;t finish. Resume it?</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      It continues from round {resumeInfo.nextRoundId}.
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label="Dismiss"
                    title="Hide this for now"
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

  // Each worker's own end does not end the stage: the judge starts once none is left running.
  const stage = (roundPhase === "workers" || roundPhase === "materializing") && currentRound && !currentRound.workers.some(w => w.status === "running")
    ? "evaluating" : roundPhase
  const analyses = currentRound?.workers.filter(w => w.name !== "proposer").length ?? 0

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      {/* Same height and layout as the Agent chat's toolbar: switching between them must not jump */}
      <div className="@container sticky top-0 z-10 bg-background border-b border-border px-3 py-2">
        <div className="min-h-8 flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 shrink-0 rounded-full bg-primary/15 flex items-center justify-center">
              <FlaskConical className="h-3.5 w-3.5 text-primary" />
            </div>
            {/* Locked while a run is live: leaving would unmount this panel mid-run. */}
            {/* gives way before the buttons do in a narrow sidebar */}
            <span className="flex w-[170px] min-w-[96px] shrink" title={busy ? BUSY_TITLE : undefined}>
              <Select disabled={busy} value={selectedAgent} onValueChange={(value: AgentName) => { if (value !== selectedAgent) dispatch(setSelectedAgent(value)) }}>
                <SelectTrigger className="h-7 w-full border border-border/50 shadow-sm bg-background text-sm font-medium text-foreground hover:bg-muted/50 focus:ring-1 focus:ring-primary/30">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="TLAgent">Agent</SelectItem>
                  <SelectItem value="TL Coscientist">Research</SelectItem>
                </SelectContent>
              </Select>
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {busy && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-red-500 hover:text-red-600 hover:bg-red-50"
                onClick={() => setConfirmKind("stop")}
                disabled={isCancelling}
              >
                <Square className="h-3.5 w-3.5 mr-1" />
                <span className="text-xs">{isCancelling ? "Stopping…" : "Stop"}</span>
              </Button>
            )}
            <Popover open={showHistory} onOpenChange={open => {
              setShowHistory(open)
              if (open) { setHistorySearch(""); void fetchWorkspaceRuns() }
            }}>
              <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2" aria-label="Run history" title="History">
              {/* labelled when there is room; icon only next to Stop */}
              <History className={cn("h-4 w-4", !busy && "@[22rem]:mr-1")} />
              {!busy && <span className="hidden @[22rem]:inline text-xs">History</span>}
            </Button>
              </PopoverTrigger>
              <PopoverContent align="end" side="bottom" className="w-[min(22rem,calc(100vw-2rem))] p-2" aria-label="Research history">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Runs in this folder</div>
            <input aria-label="Search research history" placeholder="Search runs..." value={historySearch}
              onChange={e => setHistorySearch(e.target.value)} className="mb-2 h-8 w-full rounded border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary/30" />
            {!runsLoading && workspaceRuns.length > 0 && !workspaceRuns.some(run => `${runTitle(run)} ${run.run_id}`.toLowerCase().includes(historySearch.trim().toLowerCase())) && <div className="py-2 text-xs text-muted-foreground">No matching runs</div>}
            {runsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            {!runsLoading && workspaceRuns.length === 0 && (
              <div className="text-xs text-muted-foreground py-1">No research runs in this folder yet</div>
            )}
            <div className="space-y-0.5 max-h-80 overflow-y-auto overscroll-contain" data-testid="history-run-list">
              {workspaceRuns.filter(run => `${runTitle(run)} ${run.run_id}`.toLowerCase().includes(historySearch.trim().toLowerCase())).map(run => (
                <button
                  key={run.run_root_path}
                  type="button"
                  data-run-id={run.run_id}
                  className={cn(
                    "w-full text-left px-2 py-1 rounded text-xs hover:bg-muted transition-colors disabled:opacity-50 disabled:hover:bg-transparent",
                    run.run_id === activeRunId ? "bg-primary/10 text-primary" : "text-muted-foreground"
                  )}
                  disabled={busy}
                  title={busy ? BUSY_TITLE : undefined}
                  onClick={() => { setShowHistory(false); openRun(run.run_root_path) }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{runTitle(run)}</span>
                    <span className="text-[10px] uppercase tracking-wider shrink-0">{run.stopped ? "Stopped" : RUN_STATUS_LABEL[run.status] ?? run.status}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {formatRelativeTime(run.updated_at)}
                  </div>
                </button>
              ))}
            </div>
              </PopoverContent>
            </Popover>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="New research task" disabled={busy} title={busy ? BUSY_TITLE : "New research task"} onClick={requestNewTask}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Progress bar during run */}
        {isRunning && currentRound && (
          <div className="mt-2 space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Round {currentRound.roundId}/{currentRound.totalRounds}</span>
              {currentRound.startedAt !== undefined && (
                <span title="Time spent on this round">{formatClock(now - currentRound.startedAt)}</span>
              )}
            </div>
            <Progress value={progressPercent} className="h-1.5 bg-primary/10 [&>div]:bg-primary" />
          </div>
        )}
      </div>

      {/* Main content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-hide">
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
                  <div className="text-[10px] text-muted-foreground mt-0.5">The research can read every file in this folder; it does not change them.</div>
                </div>
              </div>
            )}

            {/* Research program */}
            <div>
              <label htmlFor="research-program" className="text-xs font-semibold text-foreground mb-1.5 block">Research Program</label>
              <Textarea
                id="research-program"
                value={program}
                onChange={e => editProgram(e.target.value)}
                onBlur={() => { void flushProgramSave().catch(() => {}) }}
                onKeyDown={e => {
                  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
                    e.preventDefault()
                    e.stopPropagation()
                    void flushProgramSave().catch(() => {})
                  }
                }}
                readOnly={!pathWritable}
                placeholder="Describe the research program: what to look for in these slides."
                className="min-h-[150px] text-[13px] leading-relaxed resize-none border-border/60 focus:border-primary/50 focus:ring-primary/20 bg-background"
              />
              <div className="text-[10px] text-muted-foreground mt-1">
                <span role="status">
                  {!pathWritable ? "Read-only workspace" : programSaveStatus === "error" ? `Save failed: ${programSaveError}`
                    : programSaveStatus === "saving" ? "Saving..." : programSaveStatus === "pending" ? "Unsaved changes..."
                    : programSaveStatus === "saved" ? "Saved to program.md" : "Changes are saved automatically to program.md"}
                </span>
                {programSaveStatus === "error" && <button type="button" className="ml-2 underline" onClick={() => { void flushProgramSave().catch(() => {}) }}>Retry save</button>}
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
                  title="Ideas tested side by side each round; the best one is kept"
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
                          type="button"
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

                  {/* Worker time limit: the service needs at least 2 minutes */}
                  <div>
                    <label htmlFor="worker-time-limit" className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 block">Worker Time Limit</label>
                    <div className="flex items-center gap-2">
                      <input
                        id="worker-time-limit"
                        type="number"
                        min={2}
                        max={60}
                        value={workerTimeLimitMin}
                        onChange={e => setWorkerTimeLimitMin(Math.max(2, Math.min(60, parseInt(e.target.value) || DEFAULT_TIME_LIMIT_MIN)))}
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

            {error && <ErrorBox>{error}</ErrorBox>}

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
        {phase !== "input" && (
          <div className="p-4 space-y-3">
            {cohort && <div data-testid="cohort-selection" className="text-xs text-muted-foreground">
              <div>Cohort: <span className="font-mono text-foreground">{cohort.file}</span></div>
              {cohort.reason && <div className="mt-1">{cohort.reason}</div>}
            </div>}
            {(outcome || (phase === "complete" && endState)) && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {outcome && <span>Predicting <b className="font-mono text-foreground">{outcome}</b></span>}
                {phase === "complete" && endState && (
                  <span
                    data-testid="run-end-state"
                    className={cn("ml-auto px-2 py-0.5 rounded-full border text-[10px] font-semibold", END_LABEL[endState].className)}
                  >
                    {END_LABEL[endState].text}
                  </span>
                )}
              </div>
            )}

            {error && <ErrorBox>{error}</ErrorBox>}

            {imageStatus && (
              <div data-testid="sandbox-image-status" role="status" className="flex items-start gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border/40">
                <div className="mt-0.5 shrink-0">
                  <StatusDot status={imageStatus === "ready" ? "ok" : imageStatus === "failed" ? "failed" : imageStatus === "stopped" ? "none" : "running"} />
                </div>
                <div className="text-xs">
                  <div className="text-foreground">{imageStatus === "building" ? "Building research environment..." : imageStatus === "ready" ? "Research environment ready" : imageStatus === "failed" ? "Research environment preparation failed" : imageStatus === "stopped" ? "Research environment preparation stopped" : "Checking research environment..."}</div>
                  {imageStatus === "building" && <div className="mt-1 text-muted-foreground">First-time setup downloads and installs analysis tools. This may take several minutes; later runs reuse the image.</div>}
                </div>
              </div>
            )}

            {/* Stopping: the run finishes its current step first */}
            {isCancelling && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border/40">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-red-500 shrink-0" />
                <span className="text-xs text-muted-foreground">
                  {stopSlow ? "Still stopping — the current step is finishing" : "Stopping…"}
                </span>
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
                    Planning &amp; {analyses > 1 ? "analyses" : "analysis"}
                  </span>
                  <span className="text-[10px] text-muted-foreground ml-auto">
                    {currentRound.workers.filter(w => w.status === "completed").length}/{currentRound.workers.length}
                  </span>
                </div>
                <div className="divide-y divide-border/30">
                  {currentRound.workers.map(w => {
                    const isSelected = selectedWorker === w.name
                    const showClock = isRunning && w.status === "running" && w.startedAt !== undefined
                    return (
                      <div key={w.name}>
                        <button
                          type="button"
                          className={cn(
                            "w-full text-left px-3 py-2 flex items-start gap-2.5 transition-colors",
                            isSelected ? "bg-primary/5" : "hover:bg-muted/30",
                          )}
                          onClick={() => setSelectedWorker(isSelected ? null : w.name)}
                        >
                          <div className="mt-0.5 shrink-0">
                            <StatusDot status={w.status === "running" ? "running" : w.status === "completed" ? "ok" : w.status === "failed" ? "failed" : "none"} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-medium text-foreground">{workerLabel(w.name)}</span>
                              <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
                                {showClock && (
                                  <span title={runLimitSec && w.name !== "proposer" ? "Time spent / time limit" : "Time spent"}>
                                    {formatClock(now - w.startedAt!)}
                                    {runLimitSec && w.name !== "proposer" ? ` / ${formatClock(runLimitSec * 1000)}` : ""}
                                  </span>
                                )}
                                {!isSelected && !showClock && w.toolCalls.length > 0 && <span>{w.toolCalls.length} steps</span>}
                              </span>
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
                                {w.status === "running" ? "Getting started…" : "No steps recorded."}
                              </div>
                            ) : (
                              <div className="space-y-1">
                                {w.toolCalls.map((tc, i) => <ResearchToolStep key={i} entry={tc} />)}
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
                  {stage === "proposing" && "Planning which idea to test next..."}
                  {stage === "workers" && (analyses > 1
                    ? "Carrying out the analyses side by side..."
                    : "Carrying out the analysis...")}
                  {stage === "materializing" && "Computing the new feature for every case..."}
                  {stage === "evaluating" && "Checking whether the new feature improves prediction..."}
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
                          type="button"
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
                        {isExpanded && (
                          <div className="px-3 py-2 bg-muted/10 border-t border-border/20 text-xs text-foreground leading-relaxed max-h-[250px] overflow-y-auto scrollbar-hide">
                            {renderMarkdown(entry.summary)}
                            <div className="mt-2 space-y-1">
                              {entry.toolCalls?.map((call, index) => <ResearchToolStep key={index} entry={call} />)}
                            </div>
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
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-6 w-6 text-primary"
                    aria-label="Copy research findings"
                    title={findingsCopyStatus === "copied" ? "Copied" : "Copy research findings"}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(finalSummary)
                        setFindingsCopyStatus("copied")
                      } catch { setFindingsCopyStatus("error") }
                    }}
                  >
                    {findingsCopyStatus === "copied" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                  <span role="status" className={findingsCopyStatus === "error" ? "text-xs text-destructive" : "sr-only"}>
                    {findingsCopyStatus === "copied" ? "Research findings copied" : findingsCopyStatus === "error" ? "Copy failed. Please try again." : ""}
                  </span>
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
                onClick={() => { resetView(); setPhase("input") }}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                New Research Task
              </Button>
            )}

            {/* Dataset scout card: once per run, before round 1 */}
            {scout.status !== "idle" && !currentRound && imageStatus !== "checking" && imageStatus !== "building" && (
              <div className="px-3 py-2 rounded-lg bg-muted/30 border border-border/40 space-y-1.5" data-testid="scout-card">
                <div className="flex items-center gap-2">
                  {scout.status === "running" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                  ) : (
                    <FileText className={cn("h-3.5 w-3.5 shrink-0", scout.status === "failed" ? "text-amber-600" : "text-primary")} />
                  )}
                  <span className="text-xs text-muted-foreground">
                    {scout.status === "running" && "Looking through the data folder first..."}
                    {scout.status === "done" && (scout.reusedFrom
                      ? `Reusing the notes on the data from ${scout.reusedFrom}.`
                      : "Notes on the data are ready.")}
                    {scout.status === "failed" && `No notes on the data (${scout.note}).${isRunning ? " Continuing without them." : ""}`}
                  </span>
                </div>
                {scout.calls.length > 0 && (
                  <div className="space-y-0.5 pl-5">
                    {scout.calls.map((c, i) => <ResearchToolStep key={i} entry={c} />)}
                  </div>
                )}
              </div>
            )}

            {/* Running indicator — only when not scouting and no round yet */}
            {isRunning && !currentRound && scout.status === "idle" && imageStatus !== "checking" && imageStatus !== "building" && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border/40">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                <span className="text-xs text-muted-foreground">Getting ready...</span>
              </div>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={confirmKind !== null} onOpenChange={open => { if (!open) setConfirmKind(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmKind === "stop" ? "Stop this research run?" : "Discard your research program?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmKind === "stop"
                ? "Work in the current round will be lost."
                : "The text you typed has not been saved. A new task starts from the program saved in this folder."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{confirmKind === "stop" ? "Keep running" : "Keep editing"}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const kind = confirmKind
                setConfirmKind(null)
                if (kind === "stop") stopResearch()
                else if (kind === "discard") startOver()
              }}
            >
              {confirmKind === "stop" ? "Stop run" : "Discard"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
