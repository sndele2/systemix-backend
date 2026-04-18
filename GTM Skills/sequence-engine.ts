/**
 * sequence-engine.ts
 *
 * Step scheduling and stop logic for the outbound email sequence.
 *
 * The engine owns:
 *   - The definition of each stage (delay, template key)
 *   - The decision of whether to advance or stop
 *   - Enforcement of the 3-touch ceiling (see AGENTS.md)
 *
 * The engine does NOT send emails itself — that is EmailClient's job.
 * The engine does NOT persist state — that is LeadStore's job.
 *
 * Scheduling strategy: the engine returns the next action and the delay
 * before it should fire. The caller (service.ts) is responsible for
 * arranging actual execution (e.g. a job queue, delayed function call, or
 * cron). This keeps the engine pure and testable.
 */

import { TEMPLATE_KEYS } from './prompts';
import type { EmailStage, GTMConfig, LeadStatus } from './types';

// ---------------------------------------------------------------------------
// Sequence definition
// Hard-coded to 3 touches per AGENTS.md. Adjust delays as needed.
// ---------------------------------------------------------------------------

const DEFAULT_SEQUENCE: EmailStage[] = [
  { stageIndex: 0, delayHours: 1,  templateKey: TEMPLATE_KEYS.MISSED_CALL_TOUCH_1 },
  { stageIndex: 1, delayHours: 24, templateKey: TEMPLATE_KEYS.MISSED_CALL_TOUCH_2 },
  { stageIndex: 2, delayHours: 72, templateKey: TEMPLATE_KEYS.MISSED_CALL_TOUCH_3 },
];

// ---------------------------------------------------------------------------
// Engine output types
// ---------------------------------------------------------------------------

/** The engine's recommendation for what to do next. */
export type EngineDecision =
  | { action: 'send'; stage: EmailStage; delayHours: number }
  | { action: 'stop'; reason: LeadStatus };

// ---------------------------------------------------------------------------
// SequenceEngine
// ---------------------------------------------------------------------------

export class SequenceEngine {
  private config: GTMConfig;
  private sequence: EmailStage[];

  constructor(config: GTMConfig, sequence: EmailStage[] = DEFAULT_SEQUENCE) {
    this.config = config;
    // Enforce the maxTouches ceiling from config
    this.sequence = sequence.slice(0, config.maxTouches);
  }

  /**
   * Given the current state of a lead, decide what happens next.
   *
   * @param touchesSent - number of emails already sent to this lead
   * @param status - current lead status
   * @returns an EngineDecision indicating whether to send or stop
   */
  next(touchesSent: number, status: LeadStatus): EngineDecision {
    // Stop conditions (checked before attempting to advance)
    const stopStatuses: LeadStatus[] = ['replied', 'converted', 'opted_out', 'error'];
    if (stopStatuses.includes(status)) {
      return { action: 'stop', reason: status };
    }

    if (touchesSent >= this.sequence.length) {
      return { action: 'stop', reason: 'exhausted' };
    }

    const stage = this.sequence[touchesSent];
    return {
      action: 'send',
      stage,
      delayHours: stage.delayHours,
    };
  }

  /**
   * Return the full sequence definition (useful for inspection/testing).
   */
  getSequence(): ReadonlyArray<EmailStage> {
    return this.sequence;
  }
}
