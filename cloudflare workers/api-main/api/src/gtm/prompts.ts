/**
 * Owns all plain-text GTM email copy and template rendering for missed-call recovery.
 */
import type { Lead, RenderedEmailTemplate, TemplateKey } from './types.ts';

type TemplateRenderer = (lead: Lead) => RenderedEmailTemplate;

const TEMPLATE_RENDERERS: Record<TemplateKey, TemplateRenderer> = {
  'missed-call-touch-1': (lead) => ({
    subject: `${resolveLeadName(lead)}, missed calls may be costing jobs`,
    body: [
      `Hi ${resolveLeadName(lead)},`,
      '',
      'Systemix helps service businesses respond when calls are missed so fewer jobs slip away.',
      'If missed calls are creating gaps for your team, reply here and I can send a quick breakdown.',
      '',
      'Worth a look?',
    ].join('\n'),
  }),
  'missed-call-touch-2': (lead) => ({
    subject: `${resolveLeadName(lead)}, quick idea for missed calls`,
    body: [
      `Hi ${resolveLeadName(lead)},`,
      '',
      'A lot of local service teams lose booked work when no one can answer every call.',
      'Systemix can capture those opportunities and get them back into the queue quickly.',
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
      'If missed calls are still costing booked jobs, Systemix can help recover more of that demand.',
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
