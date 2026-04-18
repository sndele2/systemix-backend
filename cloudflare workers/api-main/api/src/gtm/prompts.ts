/**
 * Owns all plain-text GTM email copy and template rendering for missed-call recovery.
 */
import type { Lead, RenderedEmailTemplate, TemplateKey } from './types.ts';

type TemplateRenderer = (lead: Lead) => RenderedEmailTemplate;

const TEMPLATE_RENDERERS: Record<TemplateKey, TemplateRenderer> = {
  'missed-call-touch-1': (lead) => ({
    subject: `${resolveLeadName(lead)}, wanted to follow up on your call`,
    body: [
      `Hi ${resolveLeadName(lead)},`,
      '',
      'You called recently and I wanted to make sure you were able to get the help you needed.',
      'If the job is still open, reply to this email with a quick note about what is going on and the best number to reach you.',
      '',
      'Happy to help.',
    ].join('\n'),
  }),
  'missed-call-touch-2': (lead) => ({
    subject: `${resolveLeadName(lead)}, should I keep a spot open for this?`,
    body: [
      `Hi ${resolveLeadName(lead)},`,
      '',
      'Checking back in case your project is still on your list.',
      'If you still want help, reply here and share a good time to reconnect.',
      '',
      'If you already found someone, no problem at all.',
    ].join('\n'),
  }),
  'missed-call-touch-3': (lead) => ({
    subject: `${resolveLeadName(lead)}, last quick follow-up from me`,
    body: [
      `Hi ${resolveLeadName(lead)},`,
      '',
      'Last note from me so I do not keep emailing you unnecessarily.',
      'If you still need help with the missed-call request, just reply and I can pick it back up.',
      '',
      'If not, you can ignore this and I will close the loop.',
    ].join('\n'),
  }),
};

function resolveLeadName(lead: Lead): string {
  const trimmedName = lead.name.trim();
  return trimmedName.length > 0 ? trimmedName : 'there';
}

export function renderTemplate(templateKey: string, lead: Lead): RenderedEmailTemplate {
  const renderer = TEMPLATE_RENDERERS[templateKey as TemplateKey];

  if (!renderer) {
    throw new Error(`Unknown template key: ${templateKey}`);
  }

  return renderer(lead);
}
