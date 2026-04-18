/**
 * Implements the pure GTM sequence decision engine with no I/O or side effects.
 */
import type { EmailStage, GTMConfig, LeadStatus, SequenceDecision, SequenceStopReason } from './types.ts';

export const DEFAULT_SEQUENCE: readonly [EmailStage, EmailStage, EmailStage] = [
  {
    stageIndex: 0,
    delayHours: 1,
    templateKey: 'missed-call-touch-1',
  },
  {
    stageIndex: 1,
    delayHours: 24,
    templateKey: 'missed-call-touch-2',
  },
  {
    stageIndex: 2,
    delayHours: 72,
    templateKey: 'missed-call-touch-3',
  },
];

function resolveTerminalReason(status: LeadStatus): SequenceStopReason | null {
  switch (status) {
    case 'replied':
      return 'replied';
    case 'converted':
      return 'converted';
    case 'opted_out':
      return 'opted_out';
    case 'error':
      return 'error';
    case 'exhausted':
      return 'exhausted';
    case 'pending':
    case 'active':
    default:
      return null;
  }
}

export class SequenceEngine {
  private readonly sequence: readonly EmailStage[];

  constructor(config: Pick<GTMConfig, 'maxTouches'>) {
    this.sequence = DEFAULT_SEQUENCE.slice(0, config.maxTouches);
  }

  getSequence(): readonly EmailStage[] {
    return this.sequence;
  }

  next(touchesSent: number, status: LeadStatus): SequenceDecision {
    const terminalReason = resolveTerminalReason(status);
    if (terminalReason) {
      return {
        action: 'stop',
        reason: terminalReason,
      };
    }

    if (touchesSent >= this.sequence.length) {
      return {
        action: 'stop',
        reason: 'exhausted',
      };
    }

    const stage = this.sequence[touchesSent];

    return {
      action: 'send',
      stage,
      delayHours: stage.delayHours,
    };
  }
}
