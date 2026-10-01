/**
 * Research panel run state: the shapes the live dashboard shows, and the pure
 * updates that settle them when a round or the run ends.
 */

export type ToolCallEntry = {
  turnId: number
  thought: string
  command: string
  exitCode?: number
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
}

export type RoundState = {
  roundId: number
  totalRounds: number
  focus: string
  workers: WorkerStatus[]
}

export type JournalEntry = {
  roundId: number
  focus: string
  summary: string
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
