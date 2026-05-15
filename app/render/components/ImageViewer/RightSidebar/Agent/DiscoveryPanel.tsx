import React, { useState, useRef, useEffect, useCallback } from "react"
import {
  Loader2, Play, Square, ChevronDown, ChevronRight,
  FlaskConical, Users, History, Plus, FolderOpen, Search, FileText, RotateCcw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/utils/twMerge"
import { useDispatch, useSelector } from "react-redux"
import { RootState, AppDispatch } from "@/store"
import { setSelectedAgent, type AgentName } from "@/store/slices/chat/agentSlice"
import { formatPath } from "@/utils/pathUtils"
import { AGENT_API_ENDPOINT } from "@/constants/config"
import { getAuthToken } from "@/utils/common/authToken"
import { getOrCreateDeviceId } from "@/utils/deviceUtils"

// ─── Types ───────────────────────────────────────────────────────────────────

type ToolCallEntry = {
  turnId: number
  thought: string
  command: string
  exitCode?: number
  status: "running" | "done" | "error"
}

type WorkerStatus = {
  name: string
  question: string
  status: "pending" | "running" | "completed" | "failed"
  summary?: string
  toolCalls: ToolCallEntry[]
}

type RoundState = {
  roundId: number
  totalRounds: number
  focus: string
  workers: WorkerStatus[]
  winnerName: string
  promotionStatus: string
}

type JournalEntry = {
  roundId: number
  focus: string
  summary: string
}

type WorkspaceRun = {
  run_id: string
  run_root_path: string
  status: string
  updated_at?: string
  resume_info?: {
    next_round_id?: number
    config?: {
      rounds?: number
      workers_per_round?: number
      reasoning_effort?: string
      worker_wall_clock_sec?: number
      guided_mode?: boolean
      guidance_timeout_sec?: number
    }
  }
}

type ResumeInfo = {
  sessionId?: string | null
  runId: string
  runRootPath?: string
  nextRoundId: number
  config: {
    rounds?: number
    workers_per_round?: number
    reasoning_effort?: string
    worker_wall_clock_sec?: number
  }
}

const DEFAULT_SEED_GUIDE_BY_WORKSPACE: Record<string, string> = {
  "/Volumes/SSK SSD/TissueLab Revision/LFB/Training":
    "/Volumes/SSK SSD/TissueLab Revision/LFB/Training/autoresearch_runs/run_20260331_000631_0f06c6/shared",
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

export const DiscoveryPanel: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>()
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath)
  const slideInfo = useSelector((state: RootState) => state.svsPath.slideInfo)
  const selectedAgent = useSelector((state: RootState) => state.agent.selectedAgent)

  // Phase state
  const [phase, setPhase] = useState<"input" | "running" | "complete">("input")

  // Input state
  const [program, setProgram] = useState("")
  const [rounds, setRounds] = useState(3)
  const [workersPerRound, setWorkersPerRound] = useState(1)
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high">("high")
  const [workerTimeLimitMin, setWorkerTimeLimitMin] = useState(15)
  const [datasetScoutEnabled, setDatasetScoutEnabled] = useState(true)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Workspace run state
  const [workspaceRuns, setWorkspaceRuns] = useState<WorkspaceRun[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [runsLoading, setRunsLoading] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [resumeInfo, setResumeInfo] = useState<ResumeInfo | null>(null)
  const [resumeRounds, setResumeRounds] = useState(3)
  const [showResumeFromPath, setShowResumeFromPath] = useState(false)
  const [resumeFromPathValue, setResumeFromPathValue] = useState("")
  const [resumeFromPathRounds, setResumeFromPathRounds] = useState(13)

  // Run state
  const [currentRound, setCurrentRound] = useState<RoundState | null>(null)
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selectedWorker, setSelectedWorker] = useState<string | null>(null)
  const [roundPhase, setRoundPhase] = useState<"coordinator" | "workers" | "evaluating" | "selecting" | "reflecting" | "done" | null>(null)
  const [scoutStatus, setScoutStatus] = useState<"idle" | "running" | "done">("idle")
  const [scoutToolCalls, setScoutToolCalls] = useState<ToolCallEntry[]>([])
  const [finalSummary, setFinalSummary] = useState<string | null>(null)
  const [finalizingResearch, setFinalizingResearch] = useState(false)
  const [expandedJournalIdx, setExpandedJournalIdx] = useState<number | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const roundSummaryRef = useRef<string>("")

  const workspacePath = formatPath(currentPath ?? "")
  const workspaceDir = workspacePath ? workspacePath.replace(/\/[^/]+$/, "") || workspacePath : ""
  const defaultSeedGuidePath = DEFAULT_SEED_GUIDE_BY_WORKSPACE[workspaceDir] || ""

  // ─── API helpers ─────────────────────────────────────────────────────────

  const authedFetch = useCallback(async (url: string, options: RequestInit) => {
    const authToken = await getAuthToken().catch(() => null)
    const headers = new Headers(options.headers || {})
    const deviceId = getOrCreateDeviceId()
    if (deviceId) headers.set("X-Device-Id", deviceId)
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
    if (authToken) headers.set("Authorization", `Bearer ${authToken}`)
    const res = await fetch(url, { ...options, headers })
    let data: any = null
    try { data = await res.json() } catch { data = null }
    return { ok: res.ok, status: res.status, data }
  }, [])

  // ─── Session management ──────────────────────────────────────────────────

  const fetchWorkspaceRuns = useCallback(async () => {
    if (!workspaceDir) {
      setWorkspaceRuns([])
      return
    }
    setRunsLoading(true)
    try {
      const res = await authedFetch(
        `${AGENT_API_ENDPOINT}/agent/v1/discovery/autoresearch_runs?workspace_path=${encodeURIComponent(workspaceDir)}`,
        { method: "GET" }
      )
      if (res.ok && res.data?.code === 0) {
        setWorkspaceRuns((res.data.data?.runs || []) as WorkspaceRun[])
      }
    } catch {}
    setRunsLoading(false)
  }, [authedFetch, workspaceDir])

  const createSession = useCallback(async () => {
    const res = await authedFetch(`${AGENT_API_ENDPOINT}/agent/v1/discovery/sessions`, {
      method: "POST",
      body: JSON.stringify({
        dataset_id: workspaceDir || "default",
        context: { workspace_path: workspacePath, slide_info: slideInfo },
        template_type: "autoresearch",
      }),
    })
    if (!res.ok || res.data?.code !== 0) throw new Error(res.data?.message || "Failed to create session")
    const session = res.data.data
    setActiveSessionId(session.session_id)
    return session.session_id as string
  }, [workspacePath, slideInfo, authedFetch, workspaceDir])

  const ensureSessionId = useCallback(async () => {
    if (activeSessionId) return activeSessionId
    return createSession()
  }, [activeSessionId, createSession])

  const loadWorkspaceRun = useCallback(async (runRootPath: string) => {
    try {
      const res = await authedFetch(
        `${AGENT_API_ENDPOINT}/agent/v1/discovery/autoresearch_runs/load?run_root_path=${encodeURIComponent(runRootPath)}`,
        { method: "GET" }
      )
      if (!res.ok || res.data?.code !== 0) return
      const payload = res.data.data || {}
      if (payload.program_text) setProgram(payload.program_text)
      setJournal((payload.journal || []) as JournalEntry[])
      setFinalSummary(payload.final_summary || null)
      setCurrentRound((payload.current_round as RoundState | null) || null)
      setActiveRunId(payload.run_id || null)
      setRoundPhase(null)
      const info = payload.resume_info || {}
      if (info?.next_round_id) {
        const origRounds = info.config?.rounds ?? 3
        const remaining = Math.max(1, origRounds - info.next_round_id + 1)
        setResumeInfo({
          sessionId: activeSessionId,
          runId: payload.run_id,
          runRootPath: payload.run_root_path,
          nextRoundId: info.next_round_id,
          config: info.config ?? {},
        })
        setResumeRounds(remaining)
      } else {
        setResumeInfo(null)
      }
      if (payload.current_round) {
        setPhase("running")
      } else {
        setPhase("complete")
      }
    } catch {}
  }, [activeSessionId, authedFetch])

  const resumeResearch = async () => {
    if (!resumeInfo) return
    setError(null)
    setPhase("running")
    setJournal([])
    setCurrentRound(null)
    setScoutStatus("idle")
    setScoutToolCalls([])
    setFinalSummary(null)
    setFinalizingResearch(false)
    setActiveRunId(null)

    try {
      const sessionId = resumeInfo.sessionId || await ensureSessionId()
      const res = await authedFetch(
        resumeInfo.runRootPath
          ? `${AGENT_API_ENDPOINT}/agent/v1/discovery/sessions/${sessionId}/runs/resume_from_path`
          : `${AGENT_API_ENDPOINT}/agent/v1/discovery/sessions/${sessionId}/runs/${resumeInfo.runId}/resume`,
        {
          method: "POST",
          body: JSON.stringify(
            resumeInfo.runRootPath
              ? { run_root_path: resumeInfo.runRootPath, additional_rounds: resumeRounds }
              : { additional_rounds: resumeRounds }
          ),
        }
      )
      if (!res.ok || res.data?.code !== 0) throw new Error(res.data?.message || "Failed to resume run")
      const runId = res.data.data?.run_id
      if (!runId) throw new Error("Run ID missing")
      setActiveRunId(runId)
      await consumeStream(sessionId, runId)
    } catch (err: any) {
      setError(err.message)
      setPhase("complete")
    }
  }

  useEffect(() => { fetchWorkspaceRuns() }, [fetchWorkspaceRuns])

  // Auto-populate program.md if it exists in the workspace directory
  useEffect(() => {
    if (!workspaceDir || program) return
    authedFetch(
      `${AGENT_API_ENDPOINT}/agent/v1/discovery/program?data_dir=${encodeURIComponent(workspaceDir)}`,
      { method: "GET" }
    ).then(({ data }) => {
      if (data?.data?.found && data.data.content) {
        setProgram(data.data.content)
      }
    }).catch(() => {})
  }, [workspaceDir]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (defaultSeedGuidePath) {
      setDatasetScoutEnabled(false)
    }
  }, [defaultSeedGuidePath])

  // ─── Start research ──────────────────────────────────────────────────────

  const startResearch = async () => {
    if (!program.trim()) return
    setError(null)
    setPhase("running")
    setJournal([])
    setCurrentRound(null)
    setScoutStatus("idle")
    setScoutToolCalls([])
    setFinalSummary(null)
    setFinalizingResearch(false)
    setActiveRunId(null)

    try {
      const sessionId = activeSessionId || await createSession()

      const res = await authedFetch(
        `${AGENT_API_ENDPOINT}/agent/v1/discovery/sessions/${sessionId}/run`,
        {
          method: "POST",
          body: JSON.stringify({
            task: program,
            max_iterations: rounds * 10,
            reasoning_effort: reasoningEffort,
            template_type: "autoresearch",
            context: {
              workspace_path: workspacePath,
              rounds,
              workers_per_round: workersPerRound,
              dataset_scout_enabled: datasetScoutEnabled,
              ...(defaultSeedGuidePath && !datasetScoutEnabled ? { seed_guide_path: defaultSeedGuidePath } : {}),
              reasoning_effort: reasoningEffort,
              worker_wall_clock_sec: workerTimeLimitMin * 60,
            },
          }),
        },
      )
      if (!res.ok || res.data?.code !== 0) throw new Error(res.data?.message || "Failed to start run")

      const runId = res.data.data?.run_id
      if (!runId) throw new Error("Run ID missing")
      setActiveRunId(runId)

      await consumeStream(sessionId, runId)
    } catch (err: any) {
      setError(err.message)
      setPhase("complete")
    }
  }

  // ─── SSE stream consumer ─────────────────────────────────────────────────

  const consumeStream = async (sessionId: string, runId: string) => {
    const authToken = await getAuthToken().catch(() => null)
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`

    const controller = new AbortController()
    abortRef.current = controller

    const response = await fetch(
      `${AGENT_API_ENDPOINT}/agent/v1/discovery/sessions/${sessionId}/runs/${runId}/stream`,
      { method: "GET", headers, signal: controller.signal },
    )
    if (!response.ok) throw new Error(`Stream failed: ${response.status}`)

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        try {
          const event = JSON.parse(line.substring(6))
          handleEvent(event)
        } catch {}
      }
    }
    setActiveRunId(null)
    setPhase("complete")
    fetchWorkspaceRuns()
  }

  const handleEvent = (event: any) => {
    switch (event.type) {
      case "scouting":
        setScoutStatus("running")
        setScoutToolCalls([])
        break

      case "scout_tool_call":
        setScoutToolCalls(prev => [...prev, {
          turnId: event.turn_id,
          thought: event.thought || "",
          command: event.command_preview || "",
          status: "running",
        }])
        break

      case "scout_tool_result":
        setScoutToolCalls(prev => prev.map((tc, i) =>
          i === prev.length - 1
            ? { ...tc, exitCode: event.exit_code, status: (event.exit_code === 0 ? "done" : "error") as "done" | "error" }
            : tc
        ))
        break

      case "scout_done":
        setScoutStatus("done")
        break

      case "round_started":
        setRoundPhase("coordinator")
        setCurrentRound({
          roundId: event.round_id,
          totalRounds: event.total_rounds || rounds,
          focus: "",
          workers: [],
          winnerName: "",
          promotionStatus: "",
        })
        break

      case "coordinator_done":
        setRoundPhase("workers")
        setCurrentRound(prev => prev ? { ...prev, focus: event.round_focus || "" } : prev)
        break

      case "worker_started":
        setCurrentRound(prev => {
          if (!prev) return prev
          return {
            ...prev,
            workers: [...prev.workers, {
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

      case "literature_start":
        setRoundPhase("evaluating")
        break

      case "literature_done":
        break

      case "synthesizing":
        setRoundPhase("selecting")
        break

      case "reflecting":
        setRoundPhase("reflecting")
        break

      case "reflection_done":
        setRoundPhase("done")
        break

      case "round_summary":
        roundSummaryRef.current = event.summary || ""
        setRoundPhase("done")
        break

      case "round_completed":
        setRoundPhase(null)
        {
          const savedSummary = roundSummaryRef.current
          roundSummaryRef.current = ""
          setCurrentRound(prev => {
            setJournal(jPrev => [
              ...jPrev,
              {
                roundId: prev?.roundId || event.round_id,
                focus: prev?.focus || "",
                summary: savedSummary,
              },
            ])
            return prev
          })
        }
        break

      case "synthesizing_final":
        setFinalizingResearch(true)
        break

      case "final_summary":
        setFinalizingResearch(false)
        setFinalSummary(event.summary || "")
        break

      case "complete":
        setActiveRunId(null)
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
    abortRef.current?.abort()
    setActiveRunId(null)
    setPhase("complete")
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
    ? ((currentRound.roundId - 1 + currentRound.workers.filter(w => w.status !== "running" && w.status !== "pending").length / Math.max(currentRound.workers.length, 1)) / currentRound.totalRounds) * 100
    : 0

  const isRunning = phase === "running"

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
                <SelectItem value="TL Discovery">Research</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1.5">
            {isRunning && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-red-500 hover:text-red-600 hover:bg-red-50" onClick={stopResearch}>
                <Square className="h-3.5 w-3.5 mr-1" />
                <span className="text-xs">Stop</span>
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowHistory(!showHistory)}>
              <History className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setPhase("input"); setProgram(""); setCurrentRound(null); setJournal([]); setError(null); setActiveSessionId(null); setActiveRunId(null); setScoutStatus("idle"); setScoutToolCalls([]); setFinalSummary(null); setFinalizingResearch(false) }}>
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
                    "w-full text-left px-2 py-1 rounded text-xs hover:bg-muted transition-colors",
                    run.run_id === activeRunId ? "bg-primary/10 text-primary" : "text-muted-foreground"
                  )}
                  onClick={() => {
                    setShowHistory(false)
                    setCurrentRound(null)
                    setJournal([])
                    setFinalSummary(null)
                    setFinalizingResearch(false)
                    setError(null)
                    setScoutStatus("idle")
                    setResumeInfo(null)
                    void loadWorkspaceRun(run.run_root_path)
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
                <FolderOpen className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground">Workspace</div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate" title={workspaceDir}>{workspaceDir}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">Workers will have read-only access to all files in this folder.</div>
                </div>
              </div>
            )}

            {/* Program input */}
            <div>
              <label className="text-xs font-semibold text-foreground mb-1.5 block">Research Program</label>
              <Textarea
                value={program}
                onChange={e => setProgram(e.target.value)}
                placeholder={"Describe your research objective...\n\nFor example:\n• Segment nuclei, classify cell types, and compute spatial density per region\n• Analyze survival data against morphological biomarkers\n• Compare staining patterns across cohort subgroups"}
                className="min-h-[180px] font-mono text-[13px] leading-relaxed resize-none border-border/60 focus:border-primary/50 focus:ring-primary/20 bg-background"
              />
              <div className="text-[10px] text-muted-foreground mt-1">
                This will be saved as <span className="font-mono">program.md</span> in your workspace.
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
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 block">Workers</label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={workersPerRound}
                  onChange={e => setWorkersPerRound(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
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

                  {/* Dataset scout toggle */}
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-medium text-foreground">Dataset Scout</div>
                      <div className="text-[10px] text-muted-foreground">
                        {defaultSeedGuidePath && !datasetScoutEnabled
                          ? "Reuse the saved dataset guide for this workspace"
                          : "Explore data and write a guide before starting"}
                      </div>
                    </div>
                    <Switch
                      checked={datasetScoutEnabled}
                      onCheckedChange={setDatasetScoutEnabled}
                    />
                  </div>

                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* Resume card — shown when an incomplete autoresearch run is detected */}
            {resumeInfo && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2.5">
                <div className="flex items-start gap-2">
                  <RotateCcw className="h-3.5 w-3.5 text-primary mt-0.5 flex-shrink-0" />
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
                  className="w-full h-8 bg-primary hover:bg-primary/90 text-primary-foreground font-medium text-xs"
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                  Resume Run
                </Button>
              </div>
            )}

            {/* Start button */}
            <Button
              onClick={startResearch}
              disabled={!program.trim()}
              className="w-full h-10 bg-primary hover:bg-primary/90 text-primary-foreground font-medium shadow-sm"
            >
              <Play className="h-4 w-4 mr-2" />
              Start Research
            </Button>
          </div>
        )}

        {/* ─── PHASE 2: Live Dashboard ────────────────────────────────── */}
        {(phase === "running" || phase === "complete") && (
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
                  <span className="text-[10px] font-semibold text-primary uppercase tracking-wider">Coordinator</span>
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
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Workers</span>
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
                          <div className="mt-0.5 flex-shrink-0">
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
                              {isSelected ? <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />}
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
                                    <div className="mt-0.5 flex-shrink-0">
                                      {tc.status === "running" ? (
                                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                                      ) : tc.status === "done" ? (
                                        <div className="h-3 w-3 rounded-full bg-green-500/80 flex items-center justify-center">
                                          <svg className="h-1.5 w-1.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                          </svg>
                                        </div>
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
            {isRunning && roundPhase && roundPhase !== "done" && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border/40">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary flex-shrink-0" />
                <span className="text-xs text-muted-foreground">
                  {roundPhase === "coordinator" && "Coordinator is planning worker assignments..."}
                  {roundPhase === "workers" && (() => {
                    const total = currentRound?.workers.length || 0;
                    const done = currentRound?.workers.filter(w => w.status === "completed" || w.status === "failed").length || 0;
                    return total > 0 && done === total ? "All workers finished. Evaluating results..." : `Workers running (${done}/${total} complete)...`;
                  })()}
                  {roundPhase === "evaluating" && "Evaluating worker outputs..."}
                  {roundPhase === "selecting" && "Synthesizing findings..."}
                  {roundPhase === "reflecting" && "PI reflecting on results..."}
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
                            {isExpanded ? <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />}
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

            {/* Finalizing indicator */}
            {finalizingResearch && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border/40">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary flex-shrink-0" />
                <span className="text-xs text-muted-foreground">Compiling research findings...</span>
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

            {/* Back to input button when complete */}
            {phase === "complete" && (
              <Button
                variant="outline"
                className="w-full h-9 text-xs border-primary/30 text-primary hover:bg-primary/5"
                onClick={() => { setPhase("input"); setCurrentRound(null); setActiveRunId(null); setScoutStatus("idle"); setScoutToolCalls([]); setFinalSummary(null); setFinalizingResearch(false) }}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                New Research Task
              </Button>
            )}

            {/* Scout card */}
            {scoutStatus !== "idle" && !currentRound && (
              <div className="rounded-lg border border-border/60 overflow-hidden">
                <div className="px-3 py-2 bg-muted/30 border-b border-border/40 flex items-center gap-2">
                  {scoutStatus === "running" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  ) : (
                    <Search className="h-3.5 w-3.5 text-primary" />
                  )}
                  <span className="text-[10px] font-semibold text-primary uppercase tracking-wider">Exploring the Dataset</span>
                  {scoutStatus === "done" && (
                    <span className="text-[10px] text-muted-foreground ml-auto">{scoutToolCalls.length} steps</span>
                  )}
                </div>
                {scoutToolCalls.length === 0 && scoutStatus === "running" && (
                  <div className="px-3 py-2 text-[11px] text-muted-foreground italic">Waiting for first tool call...</div>
                )}
                {scoutToolCalls.length > 0 && (
                  <div className="px-3 py-2 space-y-1">
                    {scoutToolCalls.map((tc, i) => (
                      <div key={i} className="flex items-start gap-2 text-[11px]">
                        <div className="mt-0.5 flex-shrink-0">
                          {tc.status === "running" ? (
                            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                          ) : tc.status === "done" ? (
                            <div className="h-3 w-3 rounded-full bg-green-500/80 flex items-center justify-center">
                              <svg className="h-1.5 w-1.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            </div>
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

            {/* Running indicator — only when not scouting and no round yet */}
            {isRunning && !currentRound && scoutStatus === "idle" && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border/40">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary flex-shrink-0" />
                <span className="text-xs text-muted-foreground">Initializing research...</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
