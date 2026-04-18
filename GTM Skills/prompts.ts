/**
 * prompts.ts
 *
 * Email copy and prompt templates for outbound GTM sequences.
 *
 * All email content lives here. Templates are plain text only (no HTML).
 * Each template receives a TemplateContext and returns a subject + body string.
 *
 * Positioning: missed-call recovery / lost job re-engagement.
 * Tone: warm, conversational, human — not salesy or automated-sounding.
 *
 * To add a new template:
 *   1. Add a key to TEMPLATE_KEYS
 *   2. Implement the template function below
 *   3. Register it in TEMPLATES map
 */

import type { Lead } from './types';

// ---------------------------------------------------------------------------
// Template keys (must match EmailStage.templateKey values)
// ---------------------------------------------------------------------------

export const TEMPLATE_KEYS = {
  MISSED_CALL_TOUCH_1: 'missed-call-touch-1',
  MISSED_CALL_TOUCH_2: 'missed-call-touch-2',
  MISSED_CALL_TOUCH_3: 'missed-call-touch-3',
} as const;

export type TemplateKey = typeof TEMPLATE_KEYS[keyof typeof TEMPLATE_KEYS];

// ---------------------------------------------------------------------------
// Context passed to every template
// ---------------------------------------------------------------------------

export interface TemplateContext {
  lead: Lead;
  /** Business name of the sender (populated from GTMConfig or env). */
  businessName: string;
  /** Direct reply-to or booking link. */
  replyContact: string;
}

// ---------------------------------------------------------------------------
// Rendered output
// ---------------------------------------------------------------------------

export interface RenderedEmail {
  subject: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Template implementations
// ---------------------------------------------------------------------------

function touch1(ctx: TemplateContext): RenderedEmail {
  // TODO: refine copy with product/marketing input
  return {
    subject: `Did I miss you, ${ctx.lead.name}?`,
    body: [
      `Hi ${ctx.lead.name},`,
      '',
      `I tried to reach you earlier but missed you. No worries at all — I know life gets busy.`,
      '',
      `If you're still looking for help, I'd love to chat. You can reply here or reach me at ${ctx.replyContact}.`,
      '',
      `Talk soon,`,
      ctx.businessName,
    ].join('\n'),
  };
}

function touch2(ctx: TemplateContext): RenderedEmail {
  // TODO: refine copy — second touch should acknowledge the first
  return {
    subject: `Still thinking it over?`,
    body: [
      `Hi ${ctx.lead.name},`,
      '',
      `Just wanted to follow up in case my last message got buried.`,
      '',
      `Happy to answer any questions or work around your schedule. Just reply here and I'll get back to you quickly.`,
      '',
      ctx.businessName,
    ].join('\n'),
  };
}

function touch3(ctx: TemplateContext): RenderedEmail {
  // TODO: refine copy — final touch, close the loop gracefully
  return {
    subject: `Closing the loop`,
    body: [
      `Hi ${ctx.lead.name},`,
      '',
      `I don't want to crowd your inbox, so this will be my last message.`,
      '',
      `If things change and you ever need help, feel free to reach out at ${ctx.replyContact}. I'm always happy to help.`,
      '',
      `Take care,`,
      ctx.businessName,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------

const TEMPLATES: Record<TemplateKey, (ctx: TemplateContext) => RenderedEmail> = {
  [TEMPLATE_KEYS.MISSED_CALL_TOUCH_1]: touch1,
  [TEMPLATE_KEYS.MISSED_CALL_TOUCH_2]: touch2,
  [TEMPLATE_KEYS.MISSED_CALL_TOUCH_3]: touch3,
};

/**
 * Render an email from a template key and context.
 * @throws if the key is not registered.
 */
export function renderTemplate(key: TemplateKey, ctx: TemplateContext): RenderedEmail {
  const fn = TEMPLATES[key];
  if (!fn) {
    throw new Error(`GTM: unknown template key "${key}"`);
  }
  return fn(ctx);
}
