/**
 * Research panel phases. The panel sets input / running / complete directly;
 * stopping goes through a cancelling phase until the backend acknowledges.
 */

export const ResearchPhaseStatus = {
  Input: "input",
  Running: "running",
  Cancelling: "cancelling",
  Complete: "complete",
} as const

export type ResearchPhase = (typeof ResearchPhaseStatus)[keyof typeof ResearchPhaseStatus]

export type ResearchPhaseEvent = "STOP" | "CANCEL_ACK"

const RESEARCH_TRANSITIONS: Partial<Record<`${ResearchPhase}:${ResearchPhaseEvent}`, ResearchPhase>> = {
  [`${ResearchPhaseStatus.Running}:STOP`]: ResearchPhaseStatus.Cancelling,
  [`${ResearchPhaseStatus.Cancelling}:CANCEL_ACK`]: ResearchPhaseStatus.Complete,
}

export function transitionResearchPhase(phase: ResearchPhase, event: ResearchPhaseEvent): ResearchPhase {
  return RESEARCH_TRANSITIONS[`${phase}:${event}`] ?? phase
}

export function isResearchRunning(phase: ResearchPhase): boolean {
  return phase === ResearchPhaseStatus.Running
}

export function isResearchCancelling(phase: ResearchPhase): boolean {
  return phase === ResearchPhaseStatus.Cancelling
}
