import type { GtmReviewedLeadInput, Result } from './types.ts';
import { validateResearchedLead } from './research.ts';

export const GTM_RESEARCH_CSV_HEADERS = [
  'businessName',
  'contactName',
  'niche',
  'city',
  'state',
  'website',
  'email',
  'phone',
  'sourceUrl',
  'sourceType',
  'evidence',
  'confidence',
  'researchNotes',
  'outreachAngle',
  'approvalStatus',
  'importStatus',
] as const;

type CsvHeader = (typeof GTM_RESEARCH_CSV_HEADERS)[number];

function csvEscape(value: unknown): string {
  const raw = value === undefined || value === null ? '' : String(value);
  if (!/[",\r\n]/.test(raw)) {
    return raw;
  }

  return `"${raw.replace(/"/g, '""')}"`;
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
        continue;
      }

      if (char === '"') {
        inQuotes = false;
        continue;
      }

      field += char;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    if (char !== '\r') {
      field += char;
    }
  }

  row.push(field);
  if (row.some((value) => value.length > 0)) {
    rows.push(row);
  }

  return rows;
}

export function exportGtmResearchLeadsToCsv(leads: GtmReviewedLeadInput[]): Result<string> {
  const normalizedLeads: GtmReviewedLeadInput[] = [];
  for (const lead of leads) {
    const validation = validateResearchedLead(lead);
    if (!validation.ok) {
      return validation;
    }
    normalizedLeads.push(validation.value);
  }

  const lines = [
    GTM_RESEARCH_CSV_HEADERS.join(','),
    ...normalizedLeads.map((lead) =>
      GTM_RESEARCH_CSV_HEADERS.map((header) => csvEscape(lead[header])).join(',')
    ),
  ];

  return { ok: true, value: lines.join('\n') + '\n' };
}

export function parseGtmResearchCsv(csv: string): Result<GtmReviewedLeadInput[]> {
  const rows = parseCsvRows(csv);
  if (rows.length === 0) {
    return { ok: false, error: 'CSV is empty' };
  }

  const headers = rows[0].map((header) => header.trim());
  const missingHeaders = GTM_RESEARCH_CSV_HEADERS.filter((header) => !headers.includes(header));
  if (missingHeaders.length > 0) {
    return { ok: false, error: 'CSV missing required headers: ' + missingHeaders.join(', ') };
  }

  const leads: GtmReviewedLeadInput[] = [];
  for (const row of rows.slice(1)) {
    const raw: Record<string, string> = {};
    headers.forEach((header, index) => {
      raw[header] = row[index]?.trim() ?? '';
    });

    const confidence = raw.confidence ? Number(raw.confidence) : undefined;
    if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      return { ok: false, error: `Invalid confidence for ${raw.businessName || raw.email}` };
    }

    const candidate: GtmReviewedLeadInput = {
      businessName: raw.businessName,
      contactName: raw.contactName || undefined,
      niche: raw.niche || undefined,
      city: raw.city || undefined,
      state: raw.state || undefined,
      website: raw.website || undefined,
      email: raw.email,
      phone: raw.phone || undefined,
      sourceUrl: raw.sourceUrl,
      sourceType: raw.sourceType || undefined,
      evidence: raw.evidence,
      confidence,
      researchNotes: raw.researchNotes || undefined,
      outreachAngle: raw.outreachAngle || undefined,
      approvalStatus: raw.approvalStatus || undefined,
      importStatus: raw.importStatus || undefined,
    };

    const validation = validateResearchedLead(candidate);
    if (!validation.ok) {
      return { ok: false, error: `${validation.error} for ${candidate.businessName || candidate.email}` };
    }

    leads.push(validation.value);
  }

  return { ok: true, value: leads };
}

export function isReviewedForImport(lead: Pick<GtmReviewedLeadInput, 'approvalStatus' | 'importStatus'>): boolean {
  const approvalStatus = lead.approvalStatus?.trim().toLowerCase();
  const importStatus = lead.importStatus?.trim().toLowerCase();
  return approvalStatus === 'approved' || importStatus === 'approved';
}

export function dedupeGtmResearchLeads(leads: GtmReviewedLeadInput[]): GtmReviewedLeadInput[] {
  const seen = new Set<string>();
  const deduped: GtmReviewedLeadInput[] = [];

  for (const lead of leads) {
    const keys = [
      lead.email.toLowerCase(),
      lead.phone?.replace(/\D/g, ''),
      lead.website?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, ''),
      lead.businessName.trim().toLowerCase(),
    ].filter(Boolean) as string[];

    if (keys.some((key) => seen.has(key))) {
      continue;
    }

    keys.forEach((key) => seen.add(key));
    deduped.push(lead);
  }

  return deduped;
}
