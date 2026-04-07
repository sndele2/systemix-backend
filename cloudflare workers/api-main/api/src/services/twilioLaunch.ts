import type { AiLeadClassification } from './openai.ts';
import { createLogger } from '../core/logging.ts';
import type { TwilioRestClient } from '../core/sms.ts';
import { prepareCustomerFacingSmsBody } from './smsCompliance.ts';

export const MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER = '+18443217137';
export const MISSED_CALL_VOICE_HOOK_MESSAGE =
  "Sorry we missed your call! What's going on? We can get a tech out faster if we have the details here.";

const MISSED_CALL_VOICE_HOOK_STATUSES = new Set(['busy', 'no-answer']);
const OWNER_ALERT_MAX_SMS_BODY = 1500;
const DEFAULT_OWNER_ISSUE_LABEL = 'General Inquiry';
const UNKNOWN_PHONE_LABEL = 'Unknown';
const OWNER_ALERT_SUMMARY_PREFIXES = [
  'Customer reports an emergency home-service issue:',
  'Customer is requesting home-service help or information:',
  'Message appears unrelated to a legitimate home-service lead:',
  'Customer needs follow-up:',
] as const;

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

export type BusinessOwnerAlertInput = {
  classification?: AiLeadClassification | null;
  summary?: string | null;
  customerNumber?: string | null;
  customerMessage: string;
};

const twilioLog = createLogger('[TWILIO]', 'scheduleTwilioBackgroundTask');

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

export function formatDisplayPhoneNumber(value: string | null | undefined): string {
  const normalizedPhone = normalizePhone(value);
  if (!normalizedPhone) {
    return UNKNOWN_PHONE_LABEL;
  }

  const digits = normalizedPhone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }

  return normalizedPhone;
}

function cleanBusinessOwnerIssueLabel(summary: string | null | undefined): string {
  let cleaned = (summary || '').trim();

  for (const prefix of OWNER_ALERT_SUMMARY_PREFIXES) {
    if (cleaned.startsWith(prefix)) {
      cleaned = cleaned.slice(prefix.length).trim();
      break;
    }
  }

  cleaned = cleaned.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/g, '').trim();
  return cleaned || DEFAULT_OWNER_ISSUE_LABEL;
}

function truncateOwnerAlertMessage(message: string, maxLength: number): string {
  if (maxLength <= 0) {
    return '';
  }

  if (message.length <= maxLength) {
    return message;
  }

  if (maxLength <= 3) {
    return '.'.repeat(maxLength);
  }

  return `${message.slice(0, maxLength - 3).replace(/\s+$/u, '')}...`;
}

export function buildBusinessOwnerAlertMessage(input: BusinessOwnerAlertInput): string {
  const isEmergency = input.classification === 'emergency';
  const heading = isEmergency ? '🚨 EMERGENCY LEAD' : '📩 NEW LEAD';
  const issueLabel = cleanBusinessOwnerIssueLabel(input.summary);
  const customerPhone = formatDisplayPhoneNumber(input.customerNumber);
  const actionLine = isEmergency ? 'Call now' : 'Reply or call';
  const prefix = `${heading}\n\nIssue: ${issueLabel}\nCustomer: ${customerPhone}\n\nMessage:\n"`;
  const suffix = `"\n\n${actionLine}: ${customerPhone}`;
  const truncatedMessage = truncateOwnerAlertMessage(
    input.customerMessage,
    Math.max(0, OWNER_ALERT_MAX_SMS_BODY - prefix.length - suffix.length)
  );

  return `${prefix}${truncatedMessage}${suffix}`;
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
  return "🚨 Got it - we're on this. A local service provider has been notified and will call shortly. If not, reply here and we'll follow up.";
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
    .then(() =>
      twilioLog.log('Background task complete', {
        data: {
          label,
        },
      })
    )
    .catch((error) =>
      twilioLog.error('Background task failed', {
        error,
        data: {
          label,
        },
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
    businessNumber: business.business_number,
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
