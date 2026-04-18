/**
 * email-client.ts
 *
 * Outbound email sending adapter.
 *
 * This is the ONLY place in the GTM module that talks to an email provider.
 * It is intentionally thin — it takes a composed message and dispatches it,
 * or logs it if dryRun is enabled.
 *
 * Email format: plain text only. No HTML. No attachments.
 *
 * To swap email providers, update only this file.
 * All callers (service.ts) remain unchanged.
 *
 * The dryRun flag (from GTMConfig) must be false before any real send occurs.
 * Default is true — explicit opt-in to live sending required.
 */

import type { GTMConfig } from './types';

// ---------------------------------------------------------------------------
// Message shape accepted by the client
// ---------------------------------------------------------------------------

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string; // plain text
}

// ---------------------------------------------------------------------------
// Result of a send attempt
// ---------------------------------------------------------------------------

export interface SendResult {
  success: boolean;
  /** Provider message ID if available. */
  messageId?: string;
  /** Error message if success is false. */
  error?: string;
  /** True if this was a dry-run (no real send occurred). */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// EmailClient
// ---------------------------------------------------------------------------

export class EmailClient {
  private config: GTMConfig;

  constructor(config: GTMConfig) {
    this.config = config;
    // TODO: initialize email provider SDK (e.g. Resend, Postmark, Nodemailer)
    //       using credentials from environment variables — never hardcode keys
  }

  /**
   * Send a plain-text email.
   *
   * If config.dryRun is true, the message is logged to stdout and not sent.
   * The returned SendResult will have dryRun: true in that case.
   */
  async send(message: OutboundEmail): Promise<SendResult> {
    if (this.config.dryRun) {
      console.log('[GTM DRY RUN] Would send email:', {
        from: `${this.config.fromName} <${this.config.fromEmail}>`,
        to: message.to,
        subject: message.subject,
        bodyLength: message.body.length,
      });
      return { success: true, dryRun: true };
    }

    // TODO: call email provider SDK here
    // TODO: capture and return messageId from provider response
    // TODO: handle provider-level errors (rate limits, invalid address, etc.)
    throw new Error('EmailClient.send: live sending not yet implemented');
  }
}
