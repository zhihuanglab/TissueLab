import { describe, expect, it } from 'vitest';
import {
  isResearchCancelling,
  isResearchRunning,
  ResearchPhaseStatus,
  transitionResearchPhase,
} from '@/utils/agent/research/phaseStateMachine';

describe('research phase state machine', () => {
  it('stops a running run through cancelling to complete', () => {
    expect(isResearchRunning(ResearchPhaseStatus.Running)).toBe(true);
    const cancelling = transitionResearchPhase(ResearchPhaseStatus.Running, 'STOP');
    expect(isResearchCancelling(cancelling)).toBe(true);
    expect(transitionResearchPhase(cancelling, 'CANCEL_ACK')).toBe(ResearchPhaseStatus.Complete);
  });

  it('ignores events that do not apply to the current phase', () => {
    expect(transitionResearchPhase(ResearchPhaseStatus.Input, 'STOP')).toBe(ResearchPhaseStatus.Input);
    expect(transitionResearchPhase(ResearchPhaseStatus.Running, 'CANCEL_ACK')).toBe(ResearchPhaseStatus.Running);
  });
});
