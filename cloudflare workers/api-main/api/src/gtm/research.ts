import type { GtmReviewedLeadInput, Result } from './types.ts';

export interface GtmResearchRequest {
  objective: string;
  searchHints?: string[];
  marketNotes?: string;
  maxCandidates?: number;
}

export interface GtmResearchProvider {
  research(input: GtmResearchRequest): Promise<Result<GtmReviewedLeadInput[]>>;
}

export class ManualGtmResearchProvider implements GtmResearchProvider {
  async research(_input: GtmResearchRequest): Promise<Result<GtmReviewedLeadInput[]>> {
    return {
      ok: false,
      error:
        'No GTM browser/search research provider is configured. Use scripts/gtm-research-csv.ts with manually researched JSON, or plug in a provider that returns sourceUrl-backed leads.',
    };
  }
}

export function validateResearchedLead(input: GtmReviewedLeadInput): Result<GtmReviewedLeadInput> {
  const businessName = input.businessName.trim();
  const email = input.email.trim().toLowerCase();
  const sourceUrl = input.sourceUrl.trim();
  const evidence = input.evidence.trim();

  if (!businessName) {
    return { ok: false, error: 'businessName is required' };
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'valid email is required' };
  }

  try {
    new URL(sourceUrl);
  } catch {
    return { ok: false, error: 'sourceUrl must be a valid URL' };
  }

  if (!evidence) {
    return { ok: false, error: 'evidence is required' };
  }

  return {
    ok: true,
    value: {
      ...input,
      businessName,
      email,
      sourceUrl,
      evidence,
    },
  };
}
