/**
 * Provides the inbound GTM reply classification seam with a coarse v1 default rationale.
 */
import type { ReplyClassification } from './types.ts';

export class ReplyClassifier {
  classify(rawText: string): ReplyClassification {
    return {
      rawText,
      intent: 'reply_detected',
      confidence: 1,
      reason:
        'V1 stops the sequence on any inbound reply, so classification stays intentionally coarse until reply handling expands.',
    };
  }
}
