/**
 * service.ts
 *
 * Orchestration layer for the GTM module.
 *
 * GTMService is the single entry point for triggering, advancing, and
 * stopping outbound sequences. It coordinates between:
 *   - LeadStore   (persistence)
 *   - SequenceEngine (step scheduling / stop logic)
 *   - EmailClient (sending)
 *
 * It does NOT own business logic for email content (see prompts.ts) or
 * reply classification (see reply-classifier.ts).
 *
 * IMPORTANT: This service must never import from Twilio or core SMS paths.
 */

import type { Lead, GTMConfig, LeadStatus } from './types';
import { LeadStore } from './lead-store';
import { SequenceEngine } from './sequence-engine';
import { EmailClient } from './email-client';

export class GTMService {
  private store: LeadStore;
  private engine: SequenceEngine;
  private emailClient: EmailClient;
  private config: GTMConfig;

  constructor(config: GTMConfig) {
    this.config = config;
    this.store = new LeadStore(config.storeConnectionString);
    this.engine = new SequenceEngine(config);
    this.emailClient = new EmailClient(config);
  }

  /**
   * Begin a new outbound sequence for a lead.
   *
   * Preconditions:
   *   - Lead must not already be in an active sequence.
   *   - Lead email must be present and valid.
   *
   * The sequence will NOT send immediately; stage 0 is handed to
   * SequenceEngine which respects the configured delayHours.
   *
   * @throws if the lead is already active or opted out.
   */
  async startSequence(lead: Lead): Promise<void> {
    // TODO: validate lead.email format before proceeding
    // TODO: check store for existing active record to prevent duplicates
    // TODO: persist lead with status 'pending'
    // TODO: hand off to engine to schedule stage 0
    throw new Error('Not implemented');
  }

  /**
   * Advance the sequence to the next stage for a given lead.
   *
   * Called by the sequence engine when a scheduled delay has elapsed.
   * Will no-op if the lead has replied, opted out, or exhausted touches.
   */
  async advanceSequence(leadId: string): Promise<void> {
    // TODO: load lead from store
    // TODO: guard: return early if status is not 'active'
    // TODO: resolve next stage from engine
    // TODO: compose email via prompts.ts
    // TODO: send via emailClient (respects dryRun flag)
    // TODO: persist updated stage index and status
    throw new Error('Not implemented');
  }

  /**
   * Immediately halt the sequence for a lead.
   *
   * Must be called when any inbound reply is received (see reply-classifier.ts)
   * or when the lead converts (books a job).
   */
  async stopSequence(leadId: string, reason: LeadStatus): Promise<void> {
    // TODO: load lead from store
    // TODO: update status to the provided reason
    // TODO: persist updated record
    // TODO: cancel any pending scheduled steps in engine
    throw new Error('Not implemented');
  }

  /**
   * Returns the current status of a lead's sequence.
   */
  async getStatus(leadId: string): Promise<LeadStatus> {
    // TODO: load from store and return status
    throw new Error('Not implemented');
  }
}
