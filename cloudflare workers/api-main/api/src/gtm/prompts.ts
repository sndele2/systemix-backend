/**
 * Owns all plain-text GTM email copy and template rendering for missed-call recovery.
 */
import type { Lead, RenderedEmailTemplate, TemplateKey } from './types.ts';

type TemplateRenderer = (lead: Lead) => RenderedEmailTemplate;

const TEMPLATE_RENDERERS: Record<TemplateKey, TemplateRenderer> = {
  'missed-call-touch-1': (lead) => ({
    subject: `${resolveLeadName(lead)}, quick call-handling idea`,
    body: [
      `Hi ${resolveLeadName(lead)},`,
      '',
      'When calls come in while your team is busy, Systemix can answer, capture the request, and route the next step back to you.',
      'If that would help, I can send a quick breakdown.',
      '',
      'Worth a look?',
    ].join('\n'),
  }),
  'missed-call-touch-2': (lead) => ({
    subject: `${resolveLeadName(lead)}, quick idea for missed calls`,
    body: [
      `Hi ${resolveLeadName(lead)},`,
      '',
      'I had a short idea for keeping new inquiries from sitting unanswered during busy parts of the day.',
      'Systemix can collect the details and hand them back to your team quickly.',
      '',
      'Open to a short overview?',
    ].join('\n'),
  }),
  'missed-call-touch-3': (lead) => ({
    subject: `${resolveLeadName(lead)}, closing the loop`,
    body: [
      `Hi ${resolveLeadName(lead)},`,
      '',
      'Last note from me so I do not keep emailing you unnecessarily.',
      'If inbound calls are hard to catch during the day, Systemix can help make sure each request gets captured.',
      '',
      'If not, you can ignore this and I will close it out.',
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
