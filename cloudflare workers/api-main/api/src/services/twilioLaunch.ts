import type { AiLeadClassification } from './openai.ts';
import { createLogger } from '../core/logging.ts';
import type { TwilioRestClient } from '../core/sms.ts';
import { prepareCustomerFacingSmsBody } from './smsCompliance.ts';
import { completeWorkflowRun, failWorkflowRun, logWorkflowStep } from './workflow-trace.ts';
import {
  buildMissedCallFollowUpMessage,
  createMissedCallConversation,
  getMissedCallBusinessConfig,
  markMissedCallSmsSent,
} from './missedCallRecovery.ts';

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

type WorkflowTraceContext = {
  requestId: string;
  runId: string;
};

type OnboardNewLeadInput = {
  db: D1Database;
  twilioClient: TwilioRestClient;
  smsFrom: string;
  businessNumber: string;
  callerNumber: string;
  provider: string;
  providerCallId: string;
  callStatus: string;
  rawStatus: string;
  callSid?: string;
  parentCallSid?: string;
  trace?: WorkflowTraceContext | null;
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

function resolveMissedCallVoiceHookMessage(
  businessNumber: string | null | undefined,
  intakeQuestion: string | null | undefined
): string {
  if (normalizePhone(businessNumber) === MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER) {
    return buildMissedCallFollowUpMessage(intakeQuestion);
  }

  return MISSED_CALL_VOICE_HOOK_MESSAGE;
}

export function buildMissedCallVoiceHookMessage(displayName: string | null | undefined): string {
  void displayName;
  return MISSED_CALL_VOICE_HOOK_MESSAGE;
}

export async function findBusinessByNumber(
  db: D1Database,
  businessNumber: string
): Promise<{ business_number: string; display_name: string | null; intake_question: string | null } | null> {
  const businessConfig = await getMissedCallBusinessConfig(db, businessNumber);
  if (!businessConfig) {
    return null;
  }

  return {
    business_number: businessConfig.businessNumber,
    display_name: businessConfig.displayName,
    intake_question: businessConfig.intakeQuestion,
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
  const trace = input.trace || null;
  const normalizedBusinessNumber = normalizePhone(input.businessNumber) || MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER;
  if (trace) {
    await logWorkflowStep(input.db, {
      requestId: trace.requestId,
      runId: trace.runId,
      stepName: 'request_normalized',
      input: {
        businessNumber: input.businessNumber,
        callerNumber: input.callerNumber,
        callStatus: input.callStatus,
      },
      output: {
        businessNumber: normalizedBusinessNumber,
      },
    });
  }

  const business = (await findBusinessByNumber(input.db, normalizedBusinessNumber)) || {
    business_number: normalizedBusinessNumber,
    display_name: null,
    intake_question: null,
  };
  const callerNumber = normalizePhone(input.callerNumber);
  const smsFrom = normalizePhone(input.smsFrom);

  if (!callerNumber) {
    if (trace) {
      await logWorkflowStep(input.db, {
        requestId: trace.requestId,
        runId: trace.runId,
        stepName: 'request_validation',
        status: 'error',
        errorText: 'missing_sms_to',
      });
      await failWorkflowRun(input.db, {
        requestId: trace.requestId,
        runId: trace.runId,
        errorText: 'missing_sms_to',
      });
    }
    return {
      ok: false,
      businessNumber: business.business_number,
      detail: 'missing_sms_to',
    };
  }

  if (!smsFrom) {
    if (trace) {
      await logWorkflowStep(input.db, {
        requestId: trace.requestId,
        runId: trace.runId,
        stepName: 'request_validation',
        status: 'error',
        errorText: 'missing_twilio_phone_number',
      });
      await failWorkflowRun(input.db, {
        requestId: trace.requestId,
        runId: trace.runId,
        errorText: 'missing_twilio_phone_number',
      });
    }
    return {
      ok: false,
      businessNumber: business.business_number,
      detail: 'missing_twilio_phone_number',
    };
  }

  const followUpMessage = resolveMissedCallVoiceHookMessage(
    business.business_number,
    business.intake_question
  );
  if (trace) {
    await logWorkflowStep(input.db, {
      requestId: trace.requestId,
      runId: trace.runId,
      stepName: 'lead_lookup_or_create',
      output: {
        businessNumber: business.business_number,
        hasDisplayName: Boolean(business.display_name),
      },
    });
  }
  await createMissedCallConversation(input.db, {
    businessNumber: business.business_number,
    phoneNumber: callerNumber,
  });
  if (trace) {
    await logWorkflowStep(input.db, {
      requestId: trace.requestId,
      runId: trace.runId,
      stepName: 'conversation_created',
      output: {
        businessNumber: business.business_number,
        phoneNumber: callerNumber,
      },
    });
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
      followUpMessage,
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

  const preparedBody = await prepareCustomerFacingSmsBody(
    input.db,
    business.business_number,
    callerNumber,
    followUpMessage
  );
  if (trace) {
    await logWorkflowStep(input.db, {
      requestId: trace.requestId,
      runId: trace.runId,
      stepName: 'outbound_sms_attempt',
      input: {
        to: callerNumber,
        from: smsFrom,
      },
      output: {
        preview: preparedBody,
      },
    });
  }
  const sms = await input.twilioClient.sendSms({
    toPhone: callerNumber,
    fromPhone: smsFrom,
    businessNumber: business.business_number,
    body: preparedBody,
  });

  if (!sms.ok) {
    if (trace) {
      await logWorkflowStep(input.db, {
        requestId: trace.requestId,
        runId: trace.runId,
        stepName: 'outbound_sms_result',
        status: 'error',
        output: {
          detail: sms.detail || 'sms_failed',
        },
        errorText: sms.detail || 'sms_failed',
      });
      await failWorkflowRun(input.db, {
        requestId: trace.requestId,
        runId: trace.runId,
        errorText: sms.detail || 'sms_failed',
      });
    }
    return {
      ok: false,
      businessNumber: business.business_number,
      detail: sms.detail || 'sms_failed',
    };
  }

  if (!sms.suppressed) {
    await markMissedCallSmsSent(input.db, {
      businessNumber: business.business_number,
      phoneNumber: callerNumber,
      smsContent: preparedBody,
    });
  }

  if (trace) {
    await logWorkflowStep(input.db, {
      requestId: trace.requestId,
      runId: trace.runId,
      stepName: 'outbound_sms_result',
      output: {
        sid: sms.sid || null,
        suppressed: Boolean(sms.suppressed),
      },
    });
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

  if (trace) {
    await completeWorkflowRun(input.db, {
      requestId: trace.requestId,
      runId: trace.runId,
      status: 'completed',
      summary: 'missed-call follow-up SMS completed',
    });
  }

  return {
    ok: true,
    businessNumber: business.business_number,
    messageSid: sms.sid || null,
    callerNumber,
  };
}
