/**
 * Owns all plain-text GTM email copy and template rendering for missed-call recovery.
 */
import type { Lead, RenderedEmailTemplate, TemplateKey } from './types.ts';

type TemplateRenderer = (lead: Lead) => RenderedEmailTemplate;

const TEMPLATE_RENDERERS: Record<TemplateKey, TemplateRenderer> = {
  'missed-call-touch-1': (lead) => ({
    subject: 'Missed calls?',
    body: [
      `Hi ${resolveLeadName(lead)},`,
      '',
      `Do you ever miss calls while you're ${resolveDailyReality(lead)}?`,
      '',
      'That is usually where new jobs get lost, because the next shop is one tap away.',
      '',
      'I built something that texts missed callers back instantly so they do not move on.',
      '',
      'Want me to send a quick demo?',
    ].join('\n'),
  }),
  'missed-call-touch-2': (lead) => ({
    subject: resolveNicheSubject(lead),
    body: [
      `Hi ${resolveLeadName(lead)},`,
      '',
      `Are calls easy to miss when you're ${resolveDailyReality(lead)}?`,
      '',
      'A missed call can turn into a lost booking before you get a quiet minute.',
      '',
      'I built something that replies by text right away and captures what the caller needs.',
      '',
      'Want me to send the short version?',
    ].join('\n'),
  }),
  'missed-call-touch-3': (lead) => ({
    subject: 'Quick question',
    body: [
      `Hi ${resolveLeadName(lead)},`,
      '',
      `Last note from me: do calls ever slip by while you're ${resolveDailyReality(lead)}?`,
      '',
      'That is the moment a new job can go to whoever answers first.',
      '',
      'I built a simple text-back flow for missed callers so they do not disappear.',
      '',
      'Worth sending over?',
    ].join('\n'),
  }),
};

function resolveLeadName(lead: Lead): string {
  const trimmedName = lead.name.trim();
  return trimmedName.length > 0 ? trimmedName : 'there';
}

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
