/**
 * reply-classifier.ts
 *
 * Classifies inbound email replies from leads.
 *
 * WHY THIS FILE EXISTS: Knowing whether a reply means "yes please" vs
 * "leave me alone" is essential for routing — the sequence must stop on
 * any reply, but the downstream action differs. A misclassified opt-out
 * could cause a compliance issue; a misclassified "interested" could
 * lose a conversion. Explicit classification is safer than guessing.
 *
 * This is a thin scaffold. Classification logic (rule-based or LLM-assisted)
 * is deferred — implement inside classifyReply() when ready.
 *
 * Caller responsibility: after classification, call GTMService.stopSequence()
 * regardless of intent. The classification only affects downstream routing,
 * not the stop decision.
 */

import type { ReplyClassification } from './types';

/**
 * Classify the intent of an inbound reply from a lead.
 *
 * @param rawText - the raw body of the inbound email reply
 * @returns a ReplyClassification with intent, confidence, and optional reason
 */
export async function classifyReply(rawText: string): Promise<ReplyClassification> {
  // TODO: implement classification strategy. Options in order of complexity:
  //   1. Simple keyword matching (opted_out: "unsubscribe", "stop", "remove me")
  //   2. Heuristic scoring per intent bucket
  //   3. LLM call with structured output (avoid for latency-sensitive paths)

  // Stub: always returns 'unknown' until implemented
  return {
    rawText,
    intent: 'unknown',
    confidence: 0,
    reason: 'Classification not yet implemented',
  };
}
