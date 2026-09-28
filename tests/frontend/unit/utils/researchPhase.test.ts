import { describe, expect, it } from 'vitest';
import {
  isResearchCancelling,
  isResearchRunning,
  ResearchPhaseStatus,
  transitionResearchPhase,
} from '@/utils/agent/research/phaseStateMachine';

describe('research phase state machine', () => {
  it('walks a run from input through cancel back to input', () => {
    let phase = transitionResearchPhase(ResearchPhaseStatus.Input, 'START');
    expect(isResearchRunning(phase)).toBe(true);
    phase = transitionResearchPhase(phase, 'STOP');
    expect(isResearchCancelling(phase)).toBe(true);
    phase = transitionResearchPhase(phase, 'CANCEL_ACK');
    expect(phase).toBe(ResearchPhaseStatus.Complete);
    expect(transitionResearchPhase(phase, 'RESET')).toBe(ResearchPhaseStatus.Input);
  });

  it('ends a running run on completion or error', () => {
    expect(transitionResearchPhase(ResearchPhaseStatus.Running, 'COMPLETE')).toBe(ResearchPhaseStatus.Complete);
    expect(transitionResearchPhase(ResearchPhaseStatus.Running, 'ERROR')).toBe(ResearchPhaseStatus.Complete);
  });

  it('ignores events that do not apply to the current phase', () => {
    expect(transitionResearchPhase(ResearchPhaseStatus.Input, 'STOP')).toBe(ResearchPhaseStatus.Input);
    expect(transitionResearchPhase(ResearchPhaseStatus.Cancelling, 'START')).toBe(ResearchPhaseStatus.Cancelling);
  });
});
