export const MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER = '+18443217137';

const MISSED_CALL_VOICE_HOOK_STATUSES = new Set(['busy', 'no-answer']);

export function buildMissedCallVoiceHookMessage(displayName: string | null | undefined): string {
  const resolvedBusinessName = (displayName || '').trim() || 'the office';

  return `Hey! This is ${resolvedBusinessName}. Sorry we missed your call. What's going on? We can usually get someone out faster if we have the details here. Reply STOP to opt-out. Msg/data rates may apply.`;
}

export function normalizePhone(value: string | null | undefined): string {
  const raw = (value || '').trim();
  if (!raw) return '';

  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (hasPlus) return `+${digits}`;
  return `+${digits}`;
}

export function normalizeCallStatus(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase();
}

export function shouldFireMissedCallVoiceHook(status: string, toPhone: string): boolean {
  return (
    MISSED_CALL_VOICE_HOOK_STATUSES.has(normalizeCallStatus(status)) &&
    normalizePhone(toPhone) === MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER
  );
}

export async function findBusinessByNumber(
  db: D1Database,
  businessNumber: string
): Promise<{ business_number: string; display_name: string | null } | null> {
  const normalizedBusinessNumber = normalizePhone(businessNumber);
  if (!normalizedBusinessNumber) {
    return null;
  }

  const row = await db
    .prepare(
      `
      SELECT business_number, display_name
      FROM businesses
      WHERE business_number = ?
      LIMIT 1
    `
    )
    .bind(normalizedBusinessNumber)
    .first<{ business_number?: string; display_name?: string | null }>();

  if (!row?.business_number) {
    return null;
  }

  return {
    business_number: normalizePhone(row.business_number) || normalizedBusinessNumber,
    display_name: typeof row.display_name === 'string' ? row.display_name.trim() || null : null,
  };
}

export function buildEmergencyPriorityMessage(summary: string | null | undefined, displayName: string | null | undefined): string {
  const resolvedSummary = (summary || '').trim() || 'your request';
  void displayName;
  return `🚨 Priority Alert: I’ve escalated your "${resolvedSummary}" to our team. They are reviewing the schedule now. Stay near your phone for a callback.`;
}
