/**
 * handler.ts
 *
 * HTTP request handler for GTM-related endpoints.
 *
 * WHY THIS FILE EXISTS: External triggers (webhooks from a CRM, a missed-call
 * event from the telephony layer, or a manual admin action) need an HTTP
 * surface to start or stop sequences. Centralising that here keeps routing
 * logic out of service.ts and keeps the module boundary clean.
 *
 * IMPORTANT: This handler must NOT be wired into the Twilio webhook router
 * or any core SMS path. Register it on a separate route prefix (e.g. /gtm/).
 *
 * Authentication/authorisation must be handled by middleware before requests
 * reach these handlers — do not add auth logic inline here.
 *
 * Implement handlers only when a concrete endpoint is needed.
 * Do not add routes speculatively.
 */

import type { GTMConfig } from './types';
import { GTMService } from './service';

// Type stubs for request/response — replace with your framework's actual types
// e.g. import type { Request, Response } from 'express';
type Request  = { body: Record<string, unknown> };
type Response = { status(code: number): Response; json(body: unknown): void };

export class GTMHandler {
  private service: GTMService;

  constructor(config: GTMConfig) {
    this.service = new GTMService(config);
  }

  /**
   * POST /gtm/sequences/start
   *
   * Body: { lead: Lead }
   * Starts a new outbound sequence for the given lead.
   */
  async startSequence(req: Request, res: Response): Promise<void> {
    // TODO: validate request body shape (lead.id, lead.email required)
    // TODO: call this.service.startSequence(req.body.lead)
    // TODO: return 202 Accepted (sequence is async, not instant)
    res.status(501).json({ error: 'Not implemented' });
  }

  /**
   * POST /gtm/sequences/:leadId/stop
   *
   * Stops an active sequence for the given lead.
   * Used by admin tooling or webhook from CRM on job booking.
   */
  async stopSequence(req: Request, res: Response): Promise<void> {
    // TODO: extract leadId from route params
    // TODO: call this.service.stopSequence(leadId, 'converted') or reason from body
    // TODO: return 200 with updated status
    res.status(501).json({ error: 'Not implemented' });
  }

  /**
   * POST /gtm/replies/inbound
   *
   * Webhook endpoint for inbound email replies (e.g. from Postmark inbound).
   * Classifies the reply and stops the sequence.
   */
  async handleInboundReply(req: Request, res: Response): Promise<void> {
    // TODO: parse inbound email payload
    // TODO: identify lead by From address (match against store)
    // TODO: call classifyReply() from reply-classifier.ts
    // TODO: call this.service.stopSequence(leadId, 'replied')
    // TODO: route based on classification (notify owner if 'interested')
    res.status(501).json({ error: 'Not implemented' });
  }
}
