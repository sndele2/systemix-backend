import type { AiLeadClassification } from './openai';
import { prepareCustomerFacingSmsBody } from './smsCompliance.ts';

export const MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER = '+18443217137';
export const MISSED_CALL_VOICE_HOOK_MESSAGE =
  "Sorry we missed your call! What's going on? We can get a tech out faster if we have the details here.";

const MISSED_CALL_VOICE_HOOK_STATUSES = new Set(['busy', 'no-answer']);

type TwilioRestClient = {
  sendSms: (
    input: { toPhone: string; fromPhone: string; body: string }
  ) => Promise<{ ok: boolean; sid?: string; detail?: string }>;
};

type OnboardNewLeadInput = {
  db: D1Database;
  twilioClient: TwilioRestClient;
  smsFrom: string;
  callerNumber: string;
  provider: string;
  providerCallId: string;
  callStatus: string;
  rawStatus: string;
  callSid?: string;
  parentCallSid?: string;
};

type OnboardNewLeadResult =
  | {
      ok: true;
      businessNumber: string;
      messageSid: string | null;
      callerNumber: string;
    }
  | {
      ok: false;
      businessNumber: string;
      detail: string;
    };

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
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

export function buildMissedCallVoiceHookMessage(displayName: string | null | undefined): string {
  void displayName;
  return MISSED_CALL_VOICE_HOOK_MESSAGE;
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

export function buildEmergencyPriorityMessage(
  summary: string | null | undefined,
  displayName: string | null | undefined
): string {
  const resolvedSummary = (summary || '').trim() || 'your request';
  const resolvedTeamName = (displayName || '').trim()
    ? `the ${(displayName || '').trim()} team`
    : 'the team';

  return `Emergency Priority: I've escalated your '${resolvedSummary}' to ${resolvedTeamName}. Expect a call in the next few minutes.`;
}

export function buildOwnerAlertMessage(
  classification: AiLeadClassification,
  summary: string | null | undefined,
  customerNumber: string | null | undefined
): string {
  const classificationLabel =
    classification === 'emergency'
      ? 'Emergency'
      : classification === 'spam'
        ? 'Spam'
        : 'Inquiry';
  const resolvedSummary = (summary || '').trim() || 'Customer needs follow-up.';
  const normalizedCustomerNumber = normalizePhone(customerNumber);
  const phoneLink = normalizedCustomerNumber ? `tel:${normalizedCustomerNumber}` : 'tel:';

  return `AI thinks this is an [${classificationLabel}]. Summary: ${resolvedSummary} Click here to call them back immediately: ${phoneLink}`;
}

export function scheduleTwilioBackgroundTask(
  executionCtx: Pick<ExecutionContext, 'waitUntil'> | undefined,
  label: string,
  task: Promise<void>
): void {
  const wrappedTask = task
    .then(() => console.log(`[TWILIO] ${label} complete`))
    .catch((error) =>
      console.log(`[TWILIO] ${label} failed`, {
        error: describeError(error),
      })
    );

  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(wrappedTask);
    return;
  }

  void wrappedTask;
}

export async function onboardNewLead(input: OnboardNewLeadInput): Promise<OnboardNewLeadResult> {
  const business =
    (await findBusinessByNumber(input.db, MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER)) || {
      business_number: MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER,
      display_name: null,
    };
  const callerNumber = normalizePhone(input.callerNumber);
  const smsFrom = normalizePhone(input.smsFrom);

  if (!callerNumber) {
    return {
      ok: false,
      businessNumber: business.business_number,
      detail: 'missing_sms_to',
    };
  }

  if (!smsFrom) {
    return {
      ok: false,
      businessNumber: business.business_number,
      detail: 'missing_twilio_phone_number',
    };
  }

  await input.db
    .prepare(
      `
      INSERT INTO leads (
        id,
        created_at,
        source,
        phone,
        details,
        raw_json
      ) VALUES (?, datetime('now'), ?, ?, ?, ?)
    `
    )
    .bind(
      crypto.randomUUID(),
      'voice_to_sms_hook',
      callerNumber,
      MISSED_CALL_VOICE_HOOK_MESSAGE,
      JSON.stringify({
        business_number: business.business_number,
        caller_number: callerNumber,
        provider: input.provider,
        provider_call_id: input.providerCallId,
        call_sid: input.callSid || null,
        parent_call_sid: input.parentCallSid || null,
        call_status: input.rawStatus || input.callStatus,
        source: 'twilio_voice_hook',
      })
    )
    .run();

  const sms = await input.twilioClient.sendSms({
    toPhone: callerNumber,
    fromPhone: smsFrom,
    body: await prepareCustomerFacingSmsBody(
      input.db,
      business.business_number,
      callerNumber,
      MISSED_CALL_VOICE_HOOK_MESSAGE
    ),
  });

  if (!sms.ok) {
    return {
      ok: false,
      businessNumber: business.business_number,
      detail: sms.detail || 'sms_failed',
    };
  }

  await input.db
    .prepare(
      `
      UPDATE calls
      SET missed_at = CASE WHEN ? = 1 THEN COALESCE(missed_at, datetime('now')) ELSE missed_at END,
          customer_welcome_message_id = COALESCE(customer_welcome_message_id, ?)
      WHERE provider = ? AND provider_call_id = ?
    `
    )
    .bind(
      MISSED_CALL_VOICE_HOOK_STATUSES.has(normalizeCallStatus(input.callStatus)) ? 1 : 0,
      sms.sid || null,
      input.provider,
      input.providerCallId
    )
    .run();

  return {
    ok: true,
    businessNumber: business.business_number,
    messageSid: sms.sid || null,
    callerNumber,
  };
}
