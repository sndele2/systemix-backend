/**
 * types.ts
 *
 * Shared domain types for the GTM module.
 * All other files in this module import from here — keep this file
 * free of side-effects and business logic.
 */

// ---------------------------------------------------------------------------
// Lead
// ---------------------------------------------------------------------------

/** A prospective customer captured from a missed-call or similar trigger. */
export interface Lead {
  /** Stable unique identifier (e.g. UUID). */
  id: string;

  /** Lead's name as captured from the call or CRM. */
  name: string;

  /** Email address to send the outbound sequence to. */
  email: string;

  /** Optional phone number (source of the missed call). */
  phone?: string;

  /** ISO-8601 timestamp when the lead was first created in this system. */
  createdAt: string;

  /** Arbitrary metadata (e.g. job type, source campaign). */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// LeadStatus
// ---------------------------------------------------------------------------

/** Lifecycle state of a lead within the GTM sequence. */
export type LeadStatus =
  | 'pending'      // Created, sequence not yet started
  | 'active'       // Sequence in progress
  | 'replied'      // Lead replied — sequence must stop
  | 'converted'    // Lead booked a job (happy path)
  | 'exhausted'    // All touches sent, no reply
  | 'opted_out'    // Lead explicitly unsubscribed
  | 'error';       // Unrecoverable error during send

// ---------------------------------------------------------------------------
// EmailStage
// ---------------------------------------------------------------------------

/**
 * A single step in the outbound email sequence.
 * Sequences are capped at 3 stages (see AGENTS.md).
 */
export interface EmailStage {
  /** Zero-based index (0 = first touch, 2 = final touch). */
  stageIndex: 0 | 1 | 2;

  /** Delay in hours from the previous stage (or from sequence start for stage 0). */
  delayHours: number;

  /** Identifies which prompt template to use (see prompts.ts). */
  templateKey: string;
}

// ---------------------------------------------------------------------------
// ReplyClassification
// ---------------------------------------------------------------------------

/**
 * Result of classifying an inbound reply from a lead.
 * Used by reply-classifier.ts (optional module).
 */
export interface ReplyClassification {
  /** The raw reply text received. */
  rawText: string;

  /** Coarse intent bucket. */
  intent: 'interested' | 'not_interested' | 'opted_out' | 'question' | 'unknown';

  /** Confidence score between 0 and 1. */
  confidence: number;

  /** Human-readable explanation of the classification. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// GTMConfig
// ---------------------------------------------------------------------------

/**
 * Runtime configuration for the GTM module.
 * Populated from environment variables via a config loader — never hardcoded.
 */
export interface GTMConfig {
  /** From-address used for all outbound emails. */
  fromEmail: string;

  /** Display name paired with fromEmail. */
  fromName: string;

  /** Maximum number of email touches per lead. Must not exceed 3. */
  maxTouches: 1 | 2 | 3;

  /**
   * When true, emails are composed and logged but NOT dispatched.
   * Default: true (safe mode). Must be explicitly set to false to send.
   */
  dryRun: boolean;

  /** Connection string or identifier for the lead persistence store. */
  storeConnectionString: string;
}
