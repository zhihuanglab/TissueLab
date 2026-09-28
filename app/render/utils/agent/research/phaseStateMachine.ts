/**
 * Research (Coscientist) panel phase state machine.
 */

export const ResearchPhaseStatus = {
  Input: "input",
  Running: "running",
  Cancelling: "cancelling",
  Complete: "complete",
} as const

export type ResearchPhase = (typeof ResearchPhaseStatus)[keyof typeof ResearchPhaseStatus]

export type ResearchPhaseEvent = "START" | "STOP" | "CANCEL_ACK" | "COMPLETE" | "ERROR" | "RESET"

const RESEARCH_TRANSITIONS: Partial<Record<`${ResearchPhase}:${ResearchPhaseEvent}`, ResearchPhase>> = {
  [`${ResearchPhaseStatus.Input}:START`]: ResearchPhaseStatus.Running,
  [`${ResearchPhaseStatus.Running}:STOP`]: ResearchPhaseStatus.Cancelling,
  [`${ResearchPhaseStatus.Cancelling}:CANCEL_ACK`]: ResearchPhaseStatus.Complete,
  [`${ResearchPhaseStatus.Running}:COMPLETE`]: ResearchPhaseStatus.Complete,
  [`${ResearchPhaseStatus.Running}:ERROR`]: ResearchPhaseStatus.Complete,
  [`${ResearchPhaseStatus.Complete}:RESET`]: ResearchPhaseStatus.Input,
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
