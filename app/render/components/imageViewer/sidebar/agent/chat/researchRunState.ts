/**
 * Research panel run state: the shapes the live dashboard shows, and the pure
 * updates that settle them when a round or the run ends.
 */

export type ToolCallEntry = {
  turnId: number
  thought: string
  command: string
  exitCode?: number
  stdout?: string
  stderr?: string
  status: "running" | "done" | "error" | "stopped"
}

// The dataset scout: explores the folder once, before round 1, and writes a guide.
export type ScoutState = {
  status: "idle" | "running" | "done" | "failed"
  calls: ToolCallEntry[]
  note?: string
  reusedFrom?: string
}

export type WorkerStatus = {
  name: string
  question: string
  status: "running" | "completed" | "failed" | "stopped"
  summary?: string
  toolCalls: ToolCallEntry[]
  // when the panel saw it start (unknown for a row first seen mid-way)
  startedAt?: number
}

export type RoundState = {
  roundId: number
  totalRounds: number
  focus: string
  workers: WorkerStatus[]
  startedAt?: number
  // the round's write-up (round_summary), journaled on round_completed
  summary?: string
}

/** How a run in view ended: shown as "Finished", "Stopped" or "Incomplete". */
export type EndState = "finished" | "stopped" | "incomplete"

export type JournalEntry = {
  roundId: number
  focus: string
  summary: string
  toolCalls?: ToolCallEntry[]
}

const stopCalls = (calls: ToolCallEntry[]): ToolCallEntry[] =>
  calls.some(c => c.status === "running") ? calls.map(c => c.status === "running" ? { ...c, status: "stopped" } : c) : calls

/** The round is over: a proposer still "running" never got a worker going, i.e. every proposal failed. */
export function failPendingProposer(round: RoundState | null): RoundState | null {
  if (!round?.workers.some(w => w.name === "proposer" && w.status === "running")) return round
  return {
    ...round,
    workers: round.workers.map(w => w.name === "proposer" && w.status === "running" ? { ...w, status: "failed" } : w),
  }
}

/** The run is over (finished, failed or stopped): nothing in it is still running. */
export function stopRunningRows(round: RoundState | null): RoundState | null {
  if (!round?.workers.some(w => w.status === "running" || w.toolCalls.some(c => c.status === "running"))) return round
  return {
    ...round,
    workers: round.workers.map(w => ({
      ...w,
      status: w.status === "running" ? "stopped" : w.status,
      toolCalls: stopCalls(w.toolCalls),
    })),
  }
}

export function stopRunningScout(scout: ScoutState): ScoutState {
  if (scout.status !== "running") return scout
  return { ...scout, status: "failed", note: "stopped", calls: stopCalls(scout.calls) }
}

/** One journal entry per round: a round already there (loaded from the run folder) is not added again. */
export function appendJournalEntry(journal: JournalEntry[], entry: JournalEntry): JournalEntry[] {
  return journal.some(j => j.roundId === entry.roundId) ? journal : [...journal, entry]
}

/** The round an event belongs to: its round_id, else the round in its worker's name (round_0002_worker_1). */
export function roundIdOf(event: { round_id?: unknown; worker_name?: unknown }): number | null {
  const id = Number(event.round_id)
  if (Number.isInteger(id) && id > 0) return id
  const m = typeof event.worker_name === "string" ? event.worker_name.match(/^round_(\d+)/) : null
  return m ? Number(m[1]) : null
}

/**
 * The round an event updates. A stream reattached mid-round may never see its
 * round_started: then a stub round is made from the event's round number, rather
 * than dropping the event (and showing "getting ready" for the rest of the round).
 */
export function ensureRound(round: RoundState | null, roundId: number | null, totalRounds: number): RoundState | null {
  if (round || roundId === null) return round
  return { roundId, totalRounds: Math.max(roundId, totalRounds), focus: "", workers: [] }
}

/** Update one worker's row; a worker first seen mid-way (its worker_started was missed) gets a row. */
export function withWorker(round: RoundState, name: string, update: (w: WorkerStatus) => WorkerStatus): RoundState {
  const workers = round.workers.some(w => w.name === name)
    ? round.workers
    : [...round.workers, { name, question: "", status: "running" as const, toolCalls: [] }]
  return { ...round, workers: workers.map(w => w.name === name ? update(w) : w) }
}

/** A refused request's reason: the service's message, or FastAPI's validation detail ({detail: [{loc, msg}]}). */
export function requestErrorMessage(data: any, fallback: string): string {
  if (typeof data?.message === "string" && data.message.trim()) return data.message
  const detail = data?.detail
  if (typeof detail === "string" && detail.trim()) return detail
  if (Array.isArray(detail) && detail.length) {
    return detail.map((d: any) => {
      const field = Array.isArray(d?.loc) ? d.loc.filter((p: unknown) => p !== "body").join(".") : ""
      const msg = String(d?.msg ?? "invalid value")
      return field ? `${field}: ${msg}` : msg
    }).join("; ")
  }
  return fallback
}

/** run_detached's status (a run on disk, no longer running here) as the panel shows it. */
export function detachedEndState(status: unknown): EndState {
  return status === "completed" ? "finished" : status === "cancelled" ? "stopped" : "incomplete"
}
