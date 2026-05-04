/**
 * Owns all plain-text GTM email copy and template rendering for missed-call recovery.
 */
import type { Lead, RenderedEmailTemplate, TemplateKey } from './types.ts';

type TemplateRenderer = (lead: Lead) => RenderedEmailTemplate;

const TEMPLATE_RENDERERS: Record<TemplateKey, TemplateRenderer> = {
  'missed-call-touch-1': (lead) => ({
    subject: 'Missed calls?',
    body: [
      `Do calls slip by while you're ${resolveDailyReality(lead)}?`,
      'Missed calls turn into lost bookings because the next shop is one tap away.',
      'I built Systemix to text missed callers back instantly, ask what they need, and keep the job from disappearing.',
      'Want me to send a quick demo?',
    ].join('\n'),
  }),
  'missed-call-touch-2': (lead) => ({
    subject: resolveNicheSubject(lead),
    body: [
      `Are calls hard to catch while you're ${resolveDailyReality(lead)}?`,
      'Missed calls become lost jobs before you get a quiet minute to call back.',
      'I built Systemix to reply by text right away, capture what the caller needs, and keep the booking alive.',
      'Want me to send the short version?',
    ].join('\n'),
  }),
  'missed-call-touch-3': (lead) => ({
    subject: 'Quick question',
    body: [
      `Do calls still slip by while you're ${resolveDailyReality(lead)}?`,
      'Missed calls send ready buyers to whoever answers first, even when the job is a good fit.',
      'I built Systemix to text missed callers back instantly, collect the job details, and keep the conversation moving.',
      'Worth sending over?',
    ].join('\n'),
  }),
};

function readLeadMetadataString(lead: Lead, key: string): string | undefined {
  const value = lead.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveNiche(lead: Lead): string | undefined {
  return readLeadMetadataString(lead, 'niche') ?? readLeadMetadataString(lead, 'industry');
}

function resolveDailyReality(lead: Lead): string {
  const niche = resolveNiche(lead)?.toLowerCase();

  if (niche?.includes('detail')) return 'detailing or working with a customer';
  if (niche?.includes('roof')) return 'on a roof or checking a job';
  if (niche?.includes('plumb')) return 'on a plumbing job';
  if (niche?.includes('hvac')) return 'on an HVAC job';
  if (niche?.includes('clean')) return 'cleaning or walking a customer through a quote';

  return 'with a customer or in the middle of a job';
}

function resolveNicheSubject(lead: Lead): string {
  const niche = resolveNiche(lead)?.toLowerCase();

  if (niche?.includes('detail')) return 'Calls while detailing?';
  if (niche?.includes('roof')) return 'Calls on jobs?';
  if (niche?.includes('plumb')) return 'Missed plumbing calls?';
  if (niche?.includes('hvac')) return 'Missed HVAC calls?';

  return 'New jobs';
}

export function renderTemplate(templateKey: string, lead: Lead): RenderedEmailTemplate {
  const renderer = TEMPLATE_RENDERERS[templateKey as TemplateKey];

  if (!renderer) {
    throw new Error(`Unknown template key: ${templateKey}`);
  }

  return renderer(lead);
}
