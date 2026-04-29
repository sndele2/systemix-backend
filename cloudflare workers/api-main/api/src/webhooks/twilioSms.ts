import type { Context } from 'hono';
import {
  createTwilioRestClient,
  type TwilioRestClient,
  type TwilioSendResult,
} from '../core/sms.ts';
import { createLogger, type StructuredLogContext } from '../core/logging.ts';
import { checkTwilioSignature, formDataToParams } from '../core/twilioSignature.ts';
import { syncToHubspot as syncHubspotContact } from '../services/hubspot.ts';
import {
  buildLeadSummary,
  classifyLeadIntent,
  type AiLeadClassification,
} from '../services/openai.ts';
import {
  ensureCustomerMissedCallSchema,
  recordMissedCallReply,
} from '../services/missedCallRecovery.ts';
import {
  buildBusinessOwnerAlertMessage,
  buildEmergencyPriorityMessage,
  buildOwnerAlertMessage,
  scheduleTwilioBackgroundTask,
} from '../services/twilioLaunch.ts';
import {
  buildSmsHelpMessage,
  buildSmsOptInConfirmationMessage,
  buildSmsOptOutConfirmationMessage,
  prepareCustomerFacingSmsBody,
  resolveInboundSmsComplianceAction,
  type InboundSmsComplianceAction,
  upsertSmsOptOut,
} from '../services/smsCompliance.ts';
import { DurableLeadStore } from '../gtm/lead-store.ts';

type Bindings = {
  SYSTEMIX: D1Database;
  GTM_DB?: D1Database;
  TWILIO_PHONE_NUMBER?: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  OWNER_PHONE_NUMBER?: string;
  OPENAI_API_KEY?: string;
  HUBSPOT_ACCESS_TOKEN?: string;
  TWILIO_SIGNATURE_MODE?: string;
  ENVIRONMENT?: string;
};

type Confidence = 'high' | 'low' | null;
type MessageDirection = 'inbound' | 'outbound';
type TriageLabel =
  | 'emergency'
  | 'possible_emergency'
  | 'emergency_suppressed'
  | 'standard'
  | 'owner_relay'
  | 'owner_command'
  | 'unresolved_business_line';

type TriageResult = {
  classification: 'emergency' | 'standard';
  aiClassification: AiLeadClassification;
  summary: string;
  confidence: Exclude<Confidence, null>;
  source: 'keyword_emergency' | 'keyword_standard' | 'gpt' | 'gpt_fallback' | 'disabled';
  gptUsed: boolean;
  keywordMatcherMs: number;
  gptClassifierMs: number;
};

type TriageCoreResult = Omit<TriageResult, 'keywordMatcherMs' | 'gptClassifierMs'>;

type BusinessContext = {
  businessNumber: string;
  ownerPhone: string;
  displayName: string;
};

const PROVIDER = 'twilio';
const ENABLE_CLASSIFICATION = false;
const ALERT_DEDUP_WINDOW_MS = 10 * 60 * 1000;
const ACTIVE_THREAD_WINDOW_MS = 5 * 60 * 1000;
const INBOUND_SMS_DEDUP_WINDOW_SECONDS = 10;
const MAX_SMS_BODY = 1500;
const GTM_INTERNAL_OPERATOR_PHONE = '+12179912895';
const OWNER_THREAD_PREFIX = 'owner:';
const LINE_STATE_SENTINEL = '__line_state__';
const FORCED_HUBSPOT_SYNC_CUSTOMER = '+18443217137';
const FORCED_HUBSPOT_SYNC_BUSINESS = '+18443217137';
const ACTIVE_THREAD_NOTICE = 'NOTICE: You have multiple active threads. Use SWITCH {number} to switch.';
const EMERGENCY_TIMEOUT_MESSAGE =
  'The team is currently on a job but has been notified of your emergency. They will contact you as soon as they are off the ladder.';

const EMERGENCY_KEYWORDS = [
  'leak',
  'burst',
  'flood',
  'gas',
  'no heat',
  'smoke',
  'broken',
  'urgent',
  'emergency',
  'safety',
  'flooding',
  'broken pipe',
  'no power',
  'safety hazard',
] as const;

const CLEAR_STANDARD_KEYWORDS = [
  'thank you',
  'thanks',
  'ok',
  'okay',
  'yes',
  'no',
  'quote',
  'estimate',
  'price',
  'pricing',
  'schedule',
  'scheduled',
  'reschedule',
  'available',
  'availability',
  'tomorrow',
  'today',
  'appointment',
  'call me',
  'follow up',
  'follow-up',
] as const;

let schemaReadyPromise: Promise<void> | null = null;
const d1Log = createLogger('[D1]', 'twilioSms');
const twilioLog = createLogger('[TWILIO]', 'twilioSms');
const hubspotLog = createLogger('[HUBSPOT]', 'twilioSms');
const classifyLog = createLogger('[CLASSIFY]', 'twilioSms');

type SmsLogPrefix = '[D1]' | '[TWILIO]' | '[HUBSPOT]' | '[CLASSIFY]';

function getLogger(prefix: SmsLogPrefix) {
  const loggers: Record<SmsLogPrefix, ReturnType<typeof createLogger>> = {
    '[D1]': d1Log,
    '[TWILIO]': twilioLog,
    '[HUBSPOT]': hubspotLog,
    '[CLASSIFY]': classifyLog,
  };
  return loggers[prefix];
}

function getDb(env: Bindings): D1Database {
  return env.SYSTEMIX;
}

function sanitizeForSms(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_SMS_BODY) return trimmed;
  return `${trimmed.slice(0, Math.max(0, MAX_SMS_BODY - 3)).trimEnd()}...`;
}

function normalizePhone(phone: string | null | undefined): string {
  const raw = (phone || '').trim();
  if (!raw) return '';

  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (hasPlus) return `+${digits}`;
  return `+${digits}`;
}

function phonesEqual(a: string, b: string): boolean {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  return !!left && left === right;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '***';
  return `***${digits.slice(-4)}`;
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function isMissingColumnError(error: unknown, columnName: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(`no such column: ${columnName.toLowerCase()}`);
}

function toEpochMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }

    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return null;
}

function formatTimeFromEpochMs(value: number): string {
  try {
    return new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date(value).toISOString();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsKeyword(text: string, keyword: string): boolean {
  const normalizedKeyword = keyword.toLowerCase();
  if (normalizedKeyword.includes(' ')) {
    return text.includes(normalizedKeyword);
  }

  const pattern = new RegExp(`\\b${escapeRegExp(normalizedKeyword)}\\b`, 'i');
  return pattern.test(text);
}

function isClearStandardMessage(messageBody: string): boolean {
  const normalized = messageBody.toLowerCase();
  if (CLEAR_STANDARD_KEYWORDS.some((keyword) => containsKeyword(normalized, keyword))) {
    return true;
  }

  if (/^(ok|okay|yes|no|thanks|thank you|got it|sounds good|perfect)[.!\s]*$/i.test(messageBody.trim())) {
    return true;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 0 && words.length <= 3) {
    return words.every((word) => ['ok', 'okay', 'yes', 'no', 'thanks', 'thank', 'got', 'it'].includes(word));
  }

  return false;
}

async function classifyAmbiguousWithGpt(messageBody: string, apiKey?: string): Promise<TriageCoreResult> {
  const aiResult = await classifyLeadIntent(messageBody, apiKey);

  return {
    classification: aiResult.classification === 'emergency' ? 'emergency' : 'standard',
    aiClassification: aiResult.classification,
    summary: aiResult.summary,
    confidence: aiResult.confidence,
    source: aiResult.source,
    gptUsed: aiResult.gptUsed,
  };
}

function buildClassificationDisabledTriage(messageBody: string): TriageResult {
  return {
    classification: 'standard',
    aiClassification: 'inquiry',
    summary: buildLeadSummary('inquiry', messageBody),
    confidence: 'low',
    source: 'disabled',
    gptUsed: false,
    keywordMatcherMs: 0,
    gptClassifierMs: 0,
  };
}

async function classifyCustomerMessage(messageBody: string, apiKey?: string): Promise<TriageResult> {
  if (!ENABLE_CLASSIFICATION) {
    return buildClassificationDisabledTriage(messageBody);
  }

  const keywordStartMs = nowMs();
  const normalized = messageBody.toLowerCase();
  const emergencyHit = EMERGENCY_KEYWORDS.some((keyword) => containsKeyword(normalized, keyword));
  const clearStandardHit = !emergencyHit && isClearStandardMessage(messageBody);
  const keywordMatcherMs = roundMs(nowMs() - keywordStartMs);

  if (emergencyHit) {
    const gptStartMs = nowMs();
    const emergencySummary = await classifyLeadIntent(messageBody, apiKey);
    const gptClassifierMs = roundMs(nowMs() - gptStartMs);
    return {
      classification: 'emergency',
      aiClassification: 'emergency',
      summary: emergencySummary.summary,
      confidence: 'high',
      source: emergencySummary.source === 'gpt_fallback' ? 'gpt_fallback' : 'keyword_emergency',
      gptUsed: emergencySummary.gptUsed,
      keywordMatcherMs,
      gptClassifierMs,
    };
  }

  if (clearStandardHit) {
    return {
      classification: 'standard',
      aiClassification: 'inquiry',
      summary: buildLeadSummary('inquiry', messageBody),
      confidence: 'high',
      source: 'keyword_standard',
      gptUsed: false,
      keywordMatcherMs,
      gptClassifierMs: 0,
    };
  }

  const gptStartMs = nowMs();
  const gptResult = await classifyAmbiguousWithGpt(messageBody, apiKey);
  const gptClassifierMs = roundMs(nowMs() - gptStartMs);
  return {
    ...gptResult,
    keywordMatcherMs,
    gptClassifierMs,
  };
}

async function saveInboundSms(
  env: Bindings,
  fromPhone: string,
  toPhone: string,
  body: string,
  providerMessageId: string,
  rawJson: string
): Promise<{ saved: boolean; deduplicated: boolean; reason: string | null }> {
  if (
    await hasRecentInboundMessageDuplicate(
      env,
      fromPhone,
      toPhone,
      body,
      INBOUND_SMS_DEDUP_WINDOW_SECONDS
    )
  ) {
    return {
      saved: false,
      deduplicated: true,
      reason: 'phone_body_time_window',
    };
  }

  if (!providerMessageId) {
    await env.SYSTEMIX.prepare(
      `
      INSERT INTO messages (
        id,
        direction,
        provider,
        provider_message_id,
        from_phone,
        to_phone,
        body,
        raw_json
      ) VALUES (?, 'inbound', ?, NULL, ?, ?, ?, ?)
    `
    )
      .bind(crypto.randomUUID(), PROVIDER, fromPhone, toPhone, body, rawJson)
      .run();

    return {
      saved: true,
      deduplicated: false,
      reason: null,
    };
  }

  const insert = await env.SYSTEMIX.prepare(
    `
    INSERT INTO messages (
      id,
      direction,
      provider,
      provider_message_id,
      from_phone,
      to_phone,
      body,
      raw_json
    ) VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, provider_message_id) DO NOTHING
  `
  )
    .bind(crypto.randomUUID(), PROVIDER, providerMessageId, fromPhone, toPhone, body, rawJson)
    .run();

  const saved = Number(insert.meta?.changes || 0) > 0;
  return {
    saved,
    deduplicated: !saved,
    reason: saved ? null : 'provider_message_id',
  };
}

async function saveOutboundSms(
  env: Bindings,
  messageSid: string,
  fromPhone: string,
  toPhone: string,
  body: string,
  rawJson: string
): Promise<void> {
  if (!messageSid) return;

  await env.SYSTEMIX.prepare(
    `
    INSERT INTO messages (
      id,
      direction,
      provider,
      provider_message_id,
      from_phone,
      to_phone,
      body,
      raw_json
    ) VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, provider_message_id) DO NOTHING
  `
  )
    .bind(crypto.randomUUID(), PROVIDER, messageSid, fromPhone, toPhone, body, rawJson)
    .run();
}

function emptyTwimlResponseBody(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response/>';
}

function respondWithEmptyTwiml(c: Context<{ Bindings: Bindings }>) {
  return c.body(emptyTwimlResponseBody(), 200, { 'Content-Type': 'text/xml' });
}

export function normalizeInboundMessageBodyForDedup(body: string): string {
  return body.trim().replace(/\s+/g, ' ').toLowerCase();
}

export async function hasRecentInboundMessageDuplicate(
  env: Pick<Bindings, 'SYSTEMIX'>,
  fromPhone: string,
  toPhone: string,
  body: string,
  windowSeconds = INBOUND_SMS_DEDUP_WINDOW_SECONDS
): Promise<boolean> {
  const normalizedFrom = normalizePhone(fromPhone) || fromPhone.trim();
  const normalizedTo = normalizePhone(toPhone) || toPhone.trim();
  const normalizedBody = normalizeInboundMessageBodyForDedup(body);

  if (!normalizedFrom || !normalizedTo || !normalizedBody || windowSeconds <= 0) {
    return false;
  }

  const recentMessages = await env.SYSTEMIX.prepare(
    `
    SELECT body
    FROM messages
    WHERE direction = 'inbound'
      AND provider = ?
      AND from_phone = ?
      AND to_phone = ?
      AND unixepoch(created_at) >= unixepoch('now') - ?
    ORDER BY created_at DESC
    LIMIT 25
  `
  )
    .bind(PROVIDER, normalizedFrom, normalizedTo, windowSeconds)
    .all<{ body?: string | null }>();

  return (recentMessages.results || []).some(
    (row) => normalizeInboundMessageBodyForDedup(row.body || '') === normalizedBody
  );
}

async function countInboundCustomerMessages(
  env: Pick<Bindings, 'SYSTEMIX'>,
  businessNumber: string,
  customerNumber: string
): Promise<number> {
  const row = await env.SYSTEMIX.prepare(
    `
    SELECT COUNT(*) AS inbound_count
    FROM messages
    WHERE direction = 'inbound'
      AND provider = ?
      AND from_phone = ?
      AND to_phone = ?
  `
  )
    .bind(PROVIDER, customerNumber, businessNumber)
    .first<{ inbound_count?: number | string | null }>();

  return Number(row?.inbound_count || 0);
}

export async function shouldSendOwnerLeadNotification(
  env: Pick<Bindings, 'SYSTEMIX'>,
  businessNumber: string,
  customerNumber: string
): Promise<boolean> {
  return (await countInboundCustomerMessages(env, businessNumber, customerNumber)) === 1;
}

function withLoggedBackgroundCatch<T>(
  prefix: SmsLogPrefix,
  label: string,
  task: Promise<T>,
  options: {
    context?: StructuredLogContext;
    data?: Record<string, unknown>;
  } = {}
): Promise<T | null> {
  return task.catch((error) => {
    getLogger(prefix).error(`${label} failed`, {
      error,
      context: options.context,
      data: {
        label,
        ...(options.data ?? {}),
      },
    });
    return null;
  });
}

function scheduleSettledBackgroundTasks(
  executionCtx: Pick<ExecutionContext, 'waitUntil'> | undefined,
  tasks: Promise<unknown>[]
): void {
  const backgroundWork = Promise.allSettled(tasks).then(() => undefined);

  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(backgroundWork);
    return;
  }

  void backgroundWork;
}

function buildMissedCallReplyTrackingTask(input: {
  env: Bindings;
  businessNumber: string;
  customerNumber: string;
  body: string;
  providerMessageId: string;
}): Promise<unknown> {
  return withLoggedBackgroundCatch(
    '[D1]',
    'Track missed-call reply',
    recordMissedCallReply(input.env.SYSTEMIX, {
      businessNumber: input.businessNumber,
      phoneNumber: input.customerNumber,
      replyText: input.body,
    }).then(() => {
      d1Log.log('Missed-call reply tracked', {
        context: {
          handler: 'buildMissedCallReplyTrackingTask',
          messageSid: input.providerMessageId || null,
          fromNumber: input.customerNumber,
          toNumber: input.businessNumber,
        },
      });
      return true;
    }),
    {
      context: {
        handler: 'buildMissedCallReplyTrackingTask',
        messageSid: input.providerMessageId || null,
        fromNumber: input.customerNumber,
        toNumber: input.businessNumber,
      },
    }
  );
}

async function hasExistingMessageSid(env: Bindings, providerMessageId: string): Promise<boolean> {
  if (!providerMessageId) return false;

  try {
    const existing = await getDb(env)
      .prepare(
        `
        SELECT 1 AS seen
        FROM messages
        WHERE provider = ?
          AND provider_message_id = ?
        LIMIT 1
      `
      )
      .bind(PROVIDER, providerMessageId)
      .first<{ seen?: number }>();

    return Boolean(existing);
  } catch (error) {
    d1Log.error('MessageSid precheck failed', {
      error,
      context: {
        handler: 'hasExistingMessageSid',
        messageSid: providerMessageId,
      },
    });
    return false;
  }
}

async function ensureSwitchboardSchema(env: Bindings): Promise<void> {
  if (!schemaReadyPromise) {
    const maybeAddColumn = async (statement: string): Promise<void> => {
      try {
        await getDb(env).prepare(statement).run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes('duplicate column name')) {
          throw error;
        }
      }
    };

    const statements = [
      `CREATE TABLE IF NOT EXISTS businesses (
        id TEXT PRIMARY KEY,
        business_number TEXT NOT NULL UNIQUE,
        owner_phone_number TEXT,
        display_name TEXT,
        last_stripe_session_id TEXT,
        billing_mode TEXT NOT NULL DEFAULT 'pilot',
        is_internal INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`,
      'CREATE INDEX IF NOT EXISTS idx_businesses_business_number ON businesses(business_number)',
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_last_stripe_session_id_unique
       ON businesses(last_stripe_session_id)
       WHERE last_stripe_session_id IS NOT NULL
         AND last_stripe_session_id != ''`,
      `CREATE TABLE IF NOT EXISTS active_sessions (
        id TEXT PRIMARY KEY,
        business_number TEXT NOT NULL,
        customer_number TEXT NOT NULL,
        thread_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_activity_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        expires_at TEXT,
        ended_at TEXT,
        last_emergency_alert_at TEXT,
        last_emergency_classification TEXT
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_active_sessions_business_customer ON active_sessions(business_number, customer_number)',
      'CREATE INDEX IF NOT EXISTS idx_active_sessions_business_status ON active_sessions(business_number, status, last_activity_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_active_sessions_thread ON active_sessions(thread_id)',
    ];

    schemaReadyPromise = (async () => {
      for (const statement of statements) {
        await getDb(env).prepare(statement).run();
      }
      await maybeAddColumn('ALTER TABLE businesses ADD COLUMN last_stripe_session_id TEXT');
      await maybeAddColumn("ALTER TABLE businesses ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'pilot'");
      await maybeAddColumn('ALTER TABLE businesses ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0');
      await maybeAddColumn('ALTER TABLE active_sessions ADD COLUMN last_emergency_alert_at TEXT');
      await maybeAddColumn('ALTER TABLE active_sessions ADD COLUMN last_emergency_classification TEXT');
    })()
      .then(() => undefined)
      .catch((error) => {
        schemaReadyPromise = null;
        throw error;
      });
  }

  return schemaReadyPromise;
}

type SwitchboardLogInput = {
  providerMessageId?: string | null;
  threadId: string;
  businessNumber: string;
  direction: MessageDirection;
  fromNumber: string;
  toNumber: string;
  messageBody: string;
  classification: TriageLabel;
  confidence: Confidence;
  metadata?: Record<string, unknown>;
  timestamp?: string;
};

async function logSwitchboardMessage(env: Bindings, input: SwitchboardLogInput): Promise<void> {
  const timestamp = input.timestamp || new Date().toISOString();

  await getDb(env)
    .prepare(
      `
      INSERT INTO messages (
        id,
        direction,
        provider,
        provider_message_id,
        from_phone,
        to_phone,
        body,
        raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, provider_message_id) DO NOTHING
    `
    )
    .bind(
      crypto.randomUUID(),
      input.direction,
      PROVIDER,
      null,
      input.fromNumber,
      input.toNumber,
      input.messageBody,
      JSON.stringify({
        source: 'command_center_message_log',
        thread_id: input.threadId,
        business_number: input.businessNumber,
        classification: input.classification,
        confidence: input.confidence,
        timestamp,
        metadata: input.metadata || {},
      })
    )
    .run();
}

async function logSwitchboardEvent(
  env: Bindings,
  status: string,
  payload: {
    businessNumber?: string;
    fromNumber?: string;
    toNumber?: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  await getDb(env)
    .prepare(
      `
      INSERT INTO messages (
        id,
        direction,
        provider,
        provider_message_id,
        from_phone,
        to_phone,
        body,
        raw_json
      ) VALUES (?, 'inbound', ?, NULL, ?, ?, ?, ?)
    `
    )
    .bind(
      crypto.randomUUID(),
      PROVIDER,
      payload.fromNumber || payload.businessNumber || 'system',
      payload.toNumber || payload.businessNumber || 'unknown',
      `[EVENT] ${status}`,
      JSON.stringify({
        source: 'command_center_event_log',
        status,
        business_number: payload.businessNumber || null,
        from_number: payload.fromNumber || null,
        to_number: payload.toNumber || null,
        timestamp: new Date().toISOString(),
        metadata: payload.metadata,
      })
    )
    .run();
}

async function resolveBusinessContext(env: Bindings, toPhone: string): Promise<BusinessContext | null> {
  const normalizedTo = normalizePhone(toPhone);
  if (!normalizedTo) return null;

  const businessRow = await getDb(env)
    .prepare(
      `
      SELECT business_number, owner_phone_number, display_name
      FROM businesses
      WHERE business_number = ?
        AND is_active = 1
      LIMIT 1
    `
    )
    .bind(normalizedTo)
    .first<{ business_number?: string; owner_phone_number?: string | null; display_name?: string | null }>();

  if (!businessRow?.business_number) {
    return null;
  }

  return {
    businessNumber: normalizePhone(businessRow.business_number) || normalizedTo,
    ownerPhone: normalizePhone(businessRow.owner_phone_number || ''),
    displayName: (businessRow.display_name || '').trim(),
  };
}

function getInboundComplianceResponseSource(action: InboundSmsComplianceAction): string {
  if (action === 'opt_out') return 'sms_compliance_opt_out_confirmation';
  if (action === 'opt_in') return 'sms_compliance_opt_in_confirmation';
  return 'sms_compliance_help_response';
}

function buildInboundComplianceResponseBody(input: {
  action: InboundSmsComplianceAction;
  displayName: string;
  businessNumber: string;
}): string {
  if (input.action === 'opt_out') {
    return buildSmsOptOutConfirmationMessage(input.displayName, input.businessNumber);
  }

  if (input.action === 'opt_in') {
    return buildSmsOptInConfirmationMessage();
  }

  return buildSmsHelpMessage(input.displayName, input.businessNumber);
}

function isSmsSuppressed(result: { suppressed?: boolean } | null | undefined): boolean {
  return result?.suppressed === true;
}

function buildComplianceCommandBackgroundTasks(input: {
  env: Bindings;
  twilioClient: TwilioRestClient;
  action: InboundSmsComplianceAction;
  businessNumber: string;
  displayName: string;
  inboundFrom: string;
  inboundTo: string;
  body: string;
  providerMessageId: string;
  rawJson: string;
}): Promise<unknown>[] {
  const responseBody = buildInboundComplianceResponseBody({
    action: input.action,
    displayName: input.displayName,
    businessNumber: input.businessNumber,
  });

  const saveInboundTask = withLoggedBackgroundCatch(
    '[D1]',
    'Persist inbound MessageSid',
    saveInboundSms(
      input.env,
      input.inboundFrom,
      input.inboundTo,
      input.body,
      input.providerMessageId,
      input.rawJson
    ).then((saved) => {
      d1Log.log('Inbound MessageSid stored', {
        context: {
          handler: 'buildComplianceCommandBackgroundTasks',
          messageSid: input.providerMessageId || null,
          fromNumber: input.inboundFrom,
          toNumber: input.inboundTo,
        },
        data: {
          action: input.action,
          saved: saved.saved,
        },
      });
      return saved;
    }),
    {
      context: {
        handler: 'buildComplianceCommandBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.inboundFrom,
        toNumber: input.inboundTo,
      },
    }
  );

  const optOutUpdateTask =
    input.action === 'help'
      ? null
      : withLoggedBackgroundCatch(
          '[D1]',
          'Persist SMS opt-out state',
          upsertSmsOptOut(
            input.env.SYSTEMIX,
            input.businessNumber,
            input.inboundFrom,
            input.action === 'opt_out'
          ).then(() => {
            d1Log.log('SMS opt-out state updated', {
              context: {
                handler: 'buildComplianceCommandBackgroundTasks',
                messageSid: input.providerMessageId || null,
                fromNumber: input.inboundFrom,
                toNumber: input.businessNumber,
              },
              data: {
                action: input.action,
                isOptedOut: input.action === 'opt_out',
              },
            });
            return true;
          }),
          {
            context: {
              handler: 'buildComplianceCommandBackgroundTasks',
              messageSid: input.providerMessageId || null,
              fromNumber: input.inboundFrom,
              toNumber: input.businessNumber,
            },
          }
        );

  const sendResponseTask = withLoggedBackgroundCatch(
    '[TWILIO]',
    'Send compliance response',
    (optOutUpdateTask ? optOutUpdateTask.then(() => undefined) : Promise.resolve()).then(async () => {
      const sms = await input.twilioClient.sendSms({
        toPhone: input.inboundFrom,
        fromPhone: input.businessNumber,
        businessNumber: input.businessNumber,
        body: responseBody,
        skipOptOutCheck: true,
      });

      if (!sms.ok) {
        throw new Error(sms.detail || 'sms_failed');
      }

      if (sms.suppressed) {
        twilioLog.log('Compliance response bypassed suppression and no outbound send was required', {
          context: {
            handler: 'buildComplianceCommandBackgroundTasks',
            fromNumber: input.businessNumber,
            toNumber: input.inboundFrom,
          },
          data: {
            action: input.action,
          },
        });
      } else {
        twilioLog.log('Compliance response sent', {
          context: {
            handler: 'buildComplianceCommandBackgroundTasks',
            messageSid: sms.sid || null,
            fromNumber: input.businessNumber,
            toNumber: input.inboundFrom,
          },
          data: {
            action: input.action,
          },
        });
      }

      return {
        sid: sms.sid || '',
        body: responseBody,
      };
    }),
    {
      context: {
        handler: 'buildComplianceCommandBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.businessNumber,
        toNumber: input.inboundFrom,
      },
      data: {
        action: input.action,
      },
    }
  );

  const persistOutboundTask = withLoggedBackgroundCatch(
    '[D1]',
    'Persist compliance response',
    sendResponseTask.then(async (responseSms) => {
      if (!responseSms?.sid) return null;

      await saveOutboundSms(
        input.env,
        responseSms.sid,
        input.businessNumber,
        input.inboundFrom,
        responseSms.body,
        JSON.stringify({
          source: getInboundComplianceResponseSource(input.action),
          providerMessageId: input.providerMessageId || null,
        })
      );

      d1Log.log('Compliance response persisted', {
        context: {
          handler: 'buildComplianceCommandBackgroundTasks',
          messageSid: responseSms.sid || null,
          fromNumber: input.businessNumber,
          toNumber: input.inboundFrom,
        },
        data: {
          action: input.action,
        },
      });
      return true;
    }),
    {
      context: {
        handler: 'buildComplianceCommandBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.businessNumber,
        toNumber: input.inboundFrom,
      },
    }
  );

  return [
    saveInboundTask,
    ...(optOutUpdateTask ? [optOutUpdateTask] : []),
    sendResponseTask,
    persistOutboundTask,
  ];
}

function getOwnerThreadId(businessNumber: string): string {
  return `${OWNER_THREAD_PREFIX}${businessNumber}`;
}

async function getOrCreateCustomerThread(
  env: Bindings,
  businessNumber: string,
  customerNumber: string
): Promise<string> {
  const normalizedCustomer = normalizePhone(customerNumber);
  if (!normalizedCustomer) {
    return `${businessNumber}:unknown`;
  }
  const now = new Date().toISOString();

  const existing = await getDb(env)
    .prepare(
      `
      SELECT thread_id
      FROM active_sessions
      WHERE business_number = ? AND customer_number = ?
      LIMIT 1
    `
    )
    .bind(businessNumber, normalizedCustomer)
    .first<{ thread_id?: string }>();

  if (existing?.thread_id) {
    await getDb(env)
      .prepare(
        `
        UPDATE active_sessions
        SET status = 'active',
            updated_at = ?,
            last_activity_at = ?,
            ended_at = NULL
        WHERE business_number = ? AND customer_number = ?
      `
      )
      .bind(now, now, businessNumber, normalizedCustomer)
      .run();
    return String(existing.thread_id);
  }

  const newThreadId = crypto.randomUUID();
  await getDb(env)
    .prepare(
      `
      INSERT INTO active_sessions (
        id,
        business_number,
        customer_number,
        thread_id,
        status,
        created_at,
        updated_at,
        last_activity_at,
        ended_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL)
      ON CONFLICT(business_number, customer_number) DO NOTHING
    `
    )
    .bind(crypto.randomUUID(), businessNumber, normalizedCustomer, newThreadId, now, now, now)
    .run();

  const resolved = await getDb(env)
    .prepare(
      `
      SELECT thread_id
      FROM active_sessions
      WHERE business_number = ? AND customer_number = ?
      LIMIT 1
    `
    )
    .bind(businessNumber, normalizedCustomer)
    .first<{ thread_id?: string }>();

  return resolved?.thread_id ? String(resolved.thread_id) : newThreadId;
}

async function setLastCustomerForLine(env: Bindings, businessNumber: string, customerNumber: string): Promise<void> {
  const now = new Date().toISOString();
  const normalizedCustomer = normalizePhone(customerNumber);
  if (!normalizedCustomer) return;

  await getDb(env)
    .prepare(
      `
      INSERT INTO active_sessions (
        id,
        business_number,
        customer_number,
        thread_id,
        status,
        created_at,
        updated_at,
        last_activity_at,
        ended_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL)
      ON CONFLICT(business_number, customer_number) DO UPDATE SET
        thread_id = excluded.thread_id,
        status = 'active',
        updated_at = excluded.updated_at,
        last_activity_at = excluded.last_activity_at,
        ended_at = NULL
    `
    )
    .bind(
      crypto.randomUUID(),
      businessNumber,
      LINE_STATE_SENTINEL,
      normalizedCustomer,
      now,
      now,
      now
    )
    .run();

  await getDb(env)
    .prepare(
      `
      UPDATE active_sessions
      SET status = 'active',
          updated_at = ?,
          last_activity_at = ?,
          ended_at = NULL
      WHERE business_number = ? AND customer_number = ?
    `
    )
    .bind(now, now, businessNumber, normalizedCustomer)
    .run();
}

async function clearLastCustomerForLine(env: Bindings, businessNumber: string): Promise<void> {
  const now = new Date().toISOString();

  await getDb(env)
    .prepare(
      `
      INSERT INTO active_sessions (
        id,
        business_number,
        customer_number,
        thread_id,
        status,
        created_at,
        updated_at,
        last_activity_at,
        ended_at
      ) VALUES (?, ?, ?, NULL, 'cleared', ?, ?, ?, ?)
      ON CONFLICT(business_number, customer_number) DO UPDATE SET
        thread_id = NULL,
        status = 'cleared',
        updated_at = excluded.updated_at,
        last_activity_at = excluded.last_activity_at,
        ended_at = excluded.ended_at
    `
    )
    .bind(crypto.randomUUID(), businessNumber, LINE_STATE_SENTINEL, now, now, now, now)
    .run();
}

async function resolveLastCustomerForLine(
  env: Bindings,
  businessNumber: string,
  ownerPhone: string
): Promise<string | null> {
  const state = await getDb(env)
    .prepare(
      `
      SELECT thread_id AS last_customer_number, status, ended_at, updated_at
      FROM active_sessions
      WHERE business_number = ?
        AND customer_number = ?
      LIMIT 1
    `
    )
    .bind(businessNumber, LINE_STATE_SENTINEL)
    .first<{ last_customer_number?: string; status?: string; ended_at?: string; updated_at?: string }>();

  if (state?.status !== 'cleared' && state?.last_customer_number) {
    return normalizePhone(state.last_customer_number);
  }

  const clearedAt = state?.status === 'cleared' ? state.ended_at || state.updated_at || null : null;
  let recentMessage: { customer_number?: string } | null = null;

  if (clearedAt) {
    recentMessage = await getDb(env)
      .prepare(
        `
        SELECT from_phone AS customer_number
        FROM messages
        WHERE direction = 'inbound'
          AND to_phone = ?
          AND from_phone != ?
          AND from_phone != ?
          AND unixepoch(created_at) > unixepoch(?)
        ORDER BY created_at DESC
        LIMIT 1
      `
      )
      .bind(businessNumber, ownerPhone, businessNumber, clearedAt)
      .first<{ customer_number?: string }>();
  } else {
    recentMessage = await getDb(env)
      .prepare(
        `
        SELECT from_phone AS customer_number
        FROM messages
        WHERE direction = 'inbound'
          AND to_phone = ?
          AND from_phone != ?
          AND from_phone != ?
        ORDER BY created_at DESC
        LIMIT 1
      `
      )
      .bind(businessNumber, ownerPhone, businessNumber)
      .first<{ customer_number?: string }>();
  }

  if (!recentMessage?.customer_number) {
    return null;
  }

  const customerNumber = normalizePhone(recentMessage.customer_number);
  if (!customerNumber) {
    return null;
  }

  await setLastCustomerForLine(env, businessNumber, customerNumber);
  return customerNumber;
}

async function hasRecentEmergencyAlert(env: Bindings, businessNumber: string, callerNumber: string): Promise<boolean> {
  const normalizedCaller = normalizePhone(callerNumber);
  if (!normalizedCaller) return false;

  const latest = await getDb(env)
    .prepare(
      `
      SELECT last_emergency_alert_at
      FROM active_sessions
      WHERE business_number = ?
        AND customer_number = ?
      LIMIT 1
    `
    )
    .bind(businessNumber, normalizedCaller)
    .first<{ last_emergency_alert_at?: string }>();

  if (!latest?.last_emergency_alert_at) {
    return false;
  }

  const latestMillis = Date.parse(latest.last_emergency_alert_at);
  if (Number.isNaN(latestMillis)) {
    return false;
  }

  return Date.now() - latestMillis < ALERT_DEDUP_WINDOW_MS;
}

async function hasConcurrentActiveEmergencyThread(
  env: Bindings,
  businessNumber: string,
  callerNumber: string
): Promise<boolean> {
  const normalizedCaller = normalizePhone(callerNumber);

  const rows = await getDb(env)
    .prepare(
      `
      SELECT customer_number, last_emergency_alert_at
      FROM active_sessions
      WHERE business_number = ?
        AND customer_number != ?
        AND customer_number != ?
        AND status = 'active'
        AND last_emergency_alert_at IS NOT NULL
      ORDER BY last_emergency_alert_at DESC
      LIMIT 50
    `
    )
    .bind(businessNumber, normalizedCaller, LINE_STATE_SENTINEL)
    .all<{ customer_number?: string; last_emergency_alert_at?: string }>();

  const now = Date.now();
  for (const row of rows.results || []) {
    const rowCaller = normalizePhone(row.customer_number || '');
    if (!rowCaller || rowCaller === normalizedCaller) continue;

    const createdAtMs = Date.parse(row.last_emergency_alert_at || '');
    if (Number.isNaN(createdAtMs)) continue;
    if (now - createdAtMs <= ACTIVE_THREAD_WINDOW_MS) {
      return true;
    }
  }

  return false;
}

async function recordEmergencyAlert(
  env: Bindings,
  businessNumber: string,
  callerNumber: string,
  classification: 'emergency' | 'possible_emergency'
): Promise<void> {
  const normalizedCaller = normalizePhone(callerNumber);
  if (!normalizedCaller) return;
  const now = new Date().toISOString();

  await getDb(env)
    .prepare(
      `
      INSERT INTO active_sessions (
        id,
        business_number,
        customer_number,
        thread_id,
        status,
        created_at,
        updated_at,
        last_activity_at,
        ended_at,
        last_emergency_alert_at,
        last_emergency_classification
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(business_number, customer_number) DO UPDATE SET
        thread_id = COALESCE(active_sessions.thread_id, excluded.thread_id),
        status = 'active',
        updated_at = excluded.updated_at,
        last_activity_at = excluded.last_activity_at,
        ended_at = NULL,
        last_emergency_alert_at = excluded.last_emergency_alert_at,
        last_emergency_classification = excluded.last_emergency_classification
    `
    )
    .bind(
      crypto.randomUUID(),
      businessNumber,
      normalizedCaller,
      crypto.randomUUID(),
      now,
      now,
      now,
      now,
      classification
    )
    .run();
}

type OwnerAlertPauseState = {
  isPaused: boolean;
  alertsPausedUntil: number | null;
  pauseColumnAvailable: boolean;
};

type ActiveOwnerThread = {
  customerNumber: string;
  lastActivityAt: string;
  lastMessage: string;
};

async function getOwnerAlertPauseState(
  env: Bindings,
  businessNumber: string,
  ownerPhone: string
): Promise<OwnerAlertPauseState> {
  try {
    const businessRow = await getDb(env)
      .prepare(
        `
        SELECT alerts_paused_until
        FROM businesses
        WHERE owner_phone_number = ?
          AND business_number = ?
        LIMIT 1
      `
      )
      .bind(ownerPhone, businessNumber)
      .first<{ alerts_paused_until?: number | string | null }>();

    const alertsPausedUntil = toEpochMs(businessRow?.alerts_paused_until);
    const isPaused = alertsPausedUntil !== null && alertsPausedUntil > Date.now();
    return {
      isPaused,
      alertsPausedUntil,
      pauseColumnAvailable: true,
    };
  } catch (error) {
    if (isMissingColumnError(error, 'alerts_paused_until')) {
      d1Log.warn('alerts_paused_until column missing on businesses table', {
        context: {
          handler: 'getOwnerAlertPauseState',
        },
      });
      return {
        isPaused: false,
        alertsPausedUntil: null,
        pauseColumnAvailable: false,
      };
    }

    throw error;
  }
}

async function getActiveThreadsForOwner(
  env: Bindings,
  businessNumber: string,
  ownerPhone: string,
  limit = 50
): Promise<ActiveOwnerThread[]> {
  const rows = await getDb(env)
    .prepare(
      `
      SELECT
        s.customer_number,
        s.last_activity_at,
        COALESCE((
          SELECT m.body
          FROM messages m
          WHERE (
              (m.from_phone = s.customer_number AND m.to_phone = s.business_number)
              OR
              (m.from_phone = s.business_number AND m.to_phone = s.customer_number)
            )
          ORDER BY m.created_at DESC
          LIMIT 1
        ), '') AS last_message
      FROM active_sessions s
      INNER JOIN businesses b ON b.business_number = s.business_number
      WHERE s.business_number = ?
        AND b.owner_phone_number = ?
        AND s.status = 'active'
        AND s.customer_number != ?
      ORDER BY s.last_activity_at DESC
      LIMIT ?
    `
    )
    .bind(businessNumber, ownerPhone, LINE_STATE_SENTINEL, limit)
    .all<{
      customer_number?: string;
      last_activity_at?: string;
      last_message?: string | null;
    }>();

  const normalized = (rows.results || [])
    .map((row) => ({
      customerNumber: normalizePhone(row.customer_number || ''),
      lastActivityAt: row.last_activity_at || '',
      lastMessage: (row.last_message || '').trim(),
    }))
    .filter((row) => !!row.customerNumber && !!row.lastActivityAt);

  return normalized;
}

async function resolveMostRecentActiveThreadForOwner(
  env: Bindings,
  businessNumber: string,
  ownerPhone: string
): Promise<string | null> {
  const activeThreads = await getActiveThreadsForOwner(env, businessNumber, ownerPhone, 50);

  if (activeThreads.length > 1) {
    d1Log.warn('Owner has multiple active threads', {
      context: {
        handler: 'resolveMostRecentActiveThreadForOwner',
        fromNumber: businessNumber,
        toNumber: ownerPhone,
      },
      data: {
        activeThreadCount: activeThreads.length,
      },
    });
  }

  const activeThread = activeThreads[0];
  if (!activeThread?.customerNumber) {
    return null;
  }

  await setLastCustomerForLine(env, businessNumber, activeThread.customerNumber);
  return activeThread.customerNumber;
}

type OwnerCommand =
  | { type: 'SYSTEMIX_HELP' }
  | { type: 'HISTORY' }
  | { type: 'SWITCH'; phoneNumber: string }
  | { type: 'PAUSE' }
  | { type: 'STATUS' }
  | { type: 'GTM_APPROVE'; approvalCode: string }
  | { type: 'GTM_REJECT'; approvalCode: string };

export function parseOwnerCommand(messageBody: string): OwnerCommand | null {
  const trimmed = messageBody.trim();
  const upper = trimmed.toUpperCase();

  if (upper === 'SYSTEMIX HELP') {
    return { type: 'SYSTEMIX_HELP' };
  }

  if (upper === 'HISTORY') {
    return { type: 'HISTORY' };
  }

  const switchMatch = trimmed.match(/^SWITCH\s+(\+?\d{8,15})$/i);
  if (switchMatch) {
    const targetNumber = normalizePhone(switchMatch[1]);
    if (!targetNumber) {
      return null;
    }

    return { type: 'SWITCH', phoneNumber: targetNumber };
  }

  if (upper === 'PAUSE') {
    return { type: 'PAUSE' };
  }

  if (upper === 'STATUS') {
    return { type: 'STATUS' };
  }

  const approveMatch = trimmed.match(/^YES\s+([A-Z0-9]{6,12})$/i);
  if (approveMatch) {
    return { type: 'GTM_APPROVE', approvalCode: approveMatch[1].toUpperCase() };
  }

  const rejectMatch = trimmed.match(/^NO\s+([A-Z0-9]{6,12})$/i);
  if (rejectMatch) {
    return { type: 'GTM_REJECT', approvalCode: rejectMatch[1].toUpperCase() };
  }

  return null;
}

export function isGtmApprovalOwnerCommand(
  command: OwnerCommand
): command is Extract<OwnerCommand, { type: 'GTM_APPROVE' | 'GTM_REJECT' }> {
  return command.type === 'GTM_APPROVE' || command.type === 'GTM_REJECT';
}

function isDirectGtmOperatorPhone(phoneNumber: string): boolean {
  return normalizePhone(phoneNumber) === GTM_INTERNAL_OPERATOR_PHONE;
}

export function resolveOwnerCommandSendOutcome(input: {
  command: OwnerCommand;
  sendResult: TwilioSendResult;
}): {
  ok: boolean;
  responseDelivery: 'sent' | 'suppressed' | 'failed';
  responseSid: string | null;
} {
  if (!input.sendResult.ok) {
    return {
      ok: isGtmApprovalOwnerCommand(input.command),
      responseDelivery: 'failed',
      responseSid: null,
    };
  }

  if (isSmsSuppressed(input.sendResult)) {
    return {
      ok: true,
      responseDelivery: 'suppressed',
      responseSid: null,
    };
  }

  return {
    ok: true,
    responseDelivery: 'sent',
    responseSid: input.sendResult.sid || null,
  };
}

export async function resolveGtmApprovalOwnerCommand(input: {
  env: Pick<Bindings, 'GTM_DB'>;
  command: Extract<OwnerCommand, { type: 'GTM_APPROVE' | 'GTM_REJECT' }>;
  ownerPhone: string;
}): Promise<string> {
  if (!input.env.GTM_DB) {
    return 'GTM approval commands are unavailable because GTM_DB is not configured.';
  }

  const store = new DurableLeadStore(input.env.GTM_DB);
  const decision = input.command.type === 'GTM_APPROVE' ? 'approved' : 'rejected';
  const resolveResult = await store.resolveApprovalByCode(
    input.command.approvalCode,
    decision,
    new Date().toISOString(),
    input.ownerPhone
  );

  if (!resolveResult.ok) {
    if (resolveResult.error === 'Approval not found') {
      return `No pending GTM approval found for code ${input.command.approvalCode}.`;
    }

    if (resolveResult.error.startsWith('Approval is already ')) {
      return `${resolveResult.error}.`;
    }

    throw new Error(resolveResult.error);
  }

  twilioLog.log(decision === 'approved' ? 'GTM approval accepted' : 'GTM approval rejected', {
    context: {
      handler: 'resolveGtmApprovalOwnerCommand',
    },
    data: {
      system: 'gtm',
      leadId: resolveResult.value.lead_id,
      stageIndex: resolveResult.value.stage_index,
      proposalHash: resolveResult.value.proposal_hash,
      approvalCode: resolveResult.value.approval_code,
      approvalStatus: resolveResult.value.status,
      decidedByPhone: input.ownerPhone,
    },
  });

  if (decision === 'approved') {
    return (
      `Approved GTM action ${resolveResult.value.approval_code}. ` +
      `It will proceed on the next internal GTM run.`
    );
  }

  return (
    `Rejected GTM action ${resolveResult.value.approval_code}. ` +
    `It will stay blocked unless a new proposal is created.`
  );
}

function parsePrefixedRecipient(messageBody: string): { recipient: string; body: string } | null {
  const match = messageBody.match(/^\s*(\+\d{8,15})(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  return {
    recipient: normalizePhone(match[1]),
    body: (match[2] || '').trim(),
  };
}

async function handleUnknownBusinessLine(input: {
  env: Bindings;
  inboundFrom: string;
  inboundTo: string;
  body: string;
  providerMessageId: string;
  route: 'owner_proxy' | 'customer_analysis';
  rawParams: Record<string, string>;
}): Promise<void> {
  const threadId = `unknown:${input.inboundTo || 'unknown'}:${input.inboundFrom || 'unknown'}`;

  await logSwitchboardMessage(input.env, {
    providerMessageId: input.providerMessageId || null,
    threadId,
    businessNumber: input.inboundTo || 'unknown',
    direction: 'inbound',
    fromNumber: input.inboundFrom || 'unknown',
    toNumber: input.inboundTo || 'unknown',
    messageBody: input.body,
    classification: 'unresolved_business_line',
    confidence: null,
    metadata: {
      route: input.route,
      reason: 'unresolved_business_line',
      rawParams: input.rawParams,
    },
  });

  await logSwitchboardEvent(input.env, 'unresolved_business_line', {
    businessNumber: input.inboundTo || undefined,
    fromNumber: input.inboundFrom || undefined,
    toNumber: input.inboundTo || undefined,
    metadata: {
      messageBody: input.body,
      providerMessageId: input.providerMessageId || null,
      rawParams: input.rawParams,
    },
  });
}

async function handleOwnerCommand(input: {
  env: Bindings;
  command: OwnerCommand;
  businessNumber: string;
  ownerPhone: string;
  inboundBody: string;
  providerMessageId: string;
  twilioClient: TwilioRestClient;
}): Promise<{
  ok: boolean;
  command: string;
  responseDelivery: 'sent' | 'suppressed' | 'failed';
  responseSid: string | null;
}> {
  const ownerThreadId = getOwnerThreadId(input.businessNumber);

  await logSwitchboardMessage(input.env, {
    providerMessageId: input.providerMessageId || null,
    threadId: ownerThreadId,
    businessNumber: input.businessNumber,
    direction: 'inbound',
    fromNumber: input.ownerPhone,
    toNumber: input.businessNumber,
    messageBody: input.inboundBody,
    classification: 'owner_command',
    confidence: null,
    metadata: {
      command: input.command.type,
    },
  });

  let responseBody = '';

  if (input.command.type === 'SYSTEMIX_HELP') {
    responseBody =
      `Systemix Command Cheat Sheet:\n\n` +
      `HISTORY - Show your last 3 leads\n` +
      `SWITCH {number} - Switch to a different customer thread\n` +
      `PAUSE - Stop alerts for 2 hours\n` +
      `STATUS - Check if your line is active\n\n` +
      `Example: SWITCH +13125550199`;
  }

  if (input.command.type === 'HISTORY') {
    const leads = await getActiveThreadsForOwner(input.env, input.businessNumber, input.ownerPhone, 3);
    if (leads.length === 0) {
      responseBody = `Last 3 leads:\nNone found.\n\nReply SWITCH {number} to change threads.`;
    } else {
      const summary = leads
        .map((lead, index) => {
          const condensedMessage = lead.lastMessage.replace(/\s+/g, ' ').trim().slice(0, 120);
          const lastMessage = condensedMessage || 'No messages yet';
          return `${index + 1}. ${lead.customerNumber} - "${lastMessage}" (${lead.lastActivityAt})`;
        })
        .join('\n');
      responseBody = `Last 3 leads:\n${summary}\n\nReply SWITCH {number} to change threads.`;
    }
  }

  if (input.command.type === 'SWITCH') {
    const now = new Date().toISOString();
    const updateResult = await getDb(input.env)
      .prepare(
        `
        UPDATE active_sessions
        SET status = 'active',
            updated_at = ?,
            last_activity_at = ?,
            ended_at = NULL
        WHERE business_number = ?
          AND customer_number = ?
      `
      )
      .bind(now, now, input.businessNumber, input.command.phoneNumber)
      .run();

    if (Number(updateResult.meta?.changes || 0) > 0) {
      await setLastCustomerForLine(input.env, input.businessNumber, input.command.phoneNumber);
      responseBody = `Switched to thread with ${input.command.phoneNumber}. Reply normally to continue.`;
    } else {
      responseBody = `No thread found for ${input.command.phoneNumber}. Reply HISTORY to view recent leads.`;
    }
  }

  if (input.command.type === 'PAUSE') {
    const resumeAt = Date.now() + 2 * 60 * 60 * 1000;
    try {
      await getDb(input.env)
        .prepare(
          `
          UPDATE businesses
          SET alerts_paused_until = ?
          WHERE owner_phone_number = ?
            AND business_number = ?
        `
        )
        .bind(resumeAt, input.ownerPhone, input.businessNumber)
        .run();

      responseBody =
        'Alerts paused for 2 hours. They will resume automatically. Text STATUS to check.';
    } catch (error) {
      if (isMissingColumnError(error, 'alerts_paused_until')) {
        responseBody =
          'PAUSE is unavailable until alerts_paused_until exists on businesses. Please have Agent 1 apply that schema change.';
      } else {
        throw error;
      }
    }
  }

  if (input.command.type === 'STATUS') {
    const pauseState = await getOwnerAlertPauseState(input.env, input.businessNumber, input.ownerPhone);
    if (!pauseState.pauseColumnAvailable) {
      responseBody =
        'STATUS is unavailable until alerts_paused_until exists on businesses. Please have Agent 1 apply that schema change.';
    } else if (pauseState.isPaused && pauseState.alertsPausedUntil !== null) {
      responseBody = `Line is PAUSED. Alerts resume at ${formatTimeFromEpochMs(pauseState.alertsPausedUntil)}.`;
    } else {
      responseBody = 'Line is ACTIVE. All alerts are flowing normally.';
    }
  }

  if (input.command.type === 'GTM_APPROVE' || input.command.type === 'GTM_REJECT') {
    responseBody = await resolveGtmApprovalOwnerCommand({
      env: input.env,
      command: input.command,
      ownerPhone: input.ownerPhone,
    });
  }

  const sendResult = await input.twilioClient.sendSms({
    toPhone: input.ownerPhone,
    fromPhone: input.businessNumber,
    body: sanitizeForSms(responseBody),
  });
  const sendOutcome = resolveOwnerCommandSendOutcome({
    command: input.command,
    sendResult,
  });

  if (!sendResult.ok) {
    twilioLog.error('Owner command response failed', {
      context: {
        handler: 'handleOwnerCommand',
        fromNumber: input.businessNumber,
        toNumber: input.ownerPhone,
      },
      data: {
        command: input.command.type,
        detail: sendResult.detail || 'unknown',
      },
    });
    return {
      ok: sendOutcome.ok,
      command: input.command.type,
      responseDelivery: sendOutcome.responseDelivery,
      responseSid: sendOutcome.responseSid,
    };
  }

  if (isSmsSuppressed(sendResult)) {
    twilioLog.log('Owner command response suppressed because recipient is opted out', {
      context: {
        handler: 'handleOwnerCommand',
        fromNumber: input.businessNumber,
        toNumber: input.ownerPhone,
      },
      data: {
        command: input.command.type,
      },
    });
    return {
      ok: true,
      command: input.command.type,
      responseDelivery: sendOutcome.responseDelivery,
      responseSid: sendOutcome.responseSid,
    };
  }

  await saveOutboundSms(
    input.env,
    sendResult.sid || '',
    input.businessNumber,
    input.ownerPhone,
    responseBody,
    JSON.stringify({
      source: 'owner_command_response',
      command: input.command.type,
    })
  );

  await logSwitchboardMessage(input.env, {
    providerMessageId: sendResult.sid || null,
    threadId: ownerThreadId,
    businessNumber: input.businessNumber,
    direction: 'outbound',
    fromNumber: input.businessNumber,
    toNumber: input.ownerPhone,
    messageBody: responseBody,
    classification: 'owner_command',
    confidence: null,
    metadata: {
      command: input.command.type,
    },
  });

  return {
    ok: true,
    command: input.command.type,
    responseDelivery: sendOutcome.responseDelivery,
    responseSid: sendOutcome.responseSid,
  };
}

async function handleOwnerRelay(input: {
  env: Bindings;
  businessNumber: string;
  ownerPhone: string;
  inboundBody: string;
  providerMessageId: string;
  twilioClient: TwilioRestClient;
}): Promise<{ ok: boolean; mode: 'owner_relay'; forwardedSid?: string | null; confirmationSid?: string | null }> {
  const parsedRecipient = parsePrefixedRecipient(input.inboundBody);
  let recipient = parsedRecipient?.recipient || '';
  let forwardBody = parsedRecipient ? parsedRecipient.body : input.inboundBody.trim();
  let recipientResolution = parsedRecipient ? 'prefixed_number' : 'unresolved';

  if (!recipient) {
    recipient = (await resolveMostRecentActiveThreadForOwner(input.env, input.businessNumber, input.ownerPhone)) || '';
    if (recipient) {
      recipientResolution = 'most_recent_active_thread';
    }
  }

  if (!recipient) {
    recipient = (await resolveLastCustomerForLine(input.env, input.businessNumber, input.ownerPhone)) || '';
    if (recipient) {
      recipientResolution = 'last_contact_fallback';
    }
  }

  if (!recipient) {
    const ownerThreadId = getOwnerThreadId(input.businessNumber);

    await logSwitchboardMessage(input.env, {
      providerMessageId: input.providerMessageId || null,
      threadId: ownerThreadId,
      businessNumber: input.businessNumber,
      direction: 'inbound',
      fromNumber: input.ownerPhone,
      toNumber: input.businessNumber,
      messageBody: input.inboundBody,
      classification: 'owner_relay',
      confidence: null,
      metadata: {
        reason: 'no_resolved_recipient',
      },
    });

    const noRecipientBody = 'No recent customer contact found for this line.';
    const ownerReply = await input.twilioClient.sendSms({
      toPhone: input.ownerPhone,
      fromPhone: input.businessNumber,
      body: noRecipientBody,
    });

    if (ownerReply.ok && !isSmsSuppressed(ownerReply)) {
      await saveOutboundSms(
        input.env,
        ownerReply.sid || '',
        input.businessNumber,
        input.ownerPhone,
        noRecipientBody,
        JSON.stringify({ source: 'owner_relay_no_recipient' })
      );

      await logSwitchboardMessage(input.env, {
        providerMessageId: ownerReply.sid || null,
        threadId: ownerThreadId,
        businessNumber: input.businessNumber,
        direction: 'outbound',
        fromNumber: input.businessNumber,
        toNumber: input.ownerPhone,
        messageBody: noRecipientBody,
        classification: 'owner_relay',
        confidence: null,
        metadata: {
          reason: 'no_resolved_recipient',
        },
      });
    }

    return {
      ok: true,
      mode: 'owner_relay',
      confirmationSid: isSmsSuppressed(ownerReply) ? null : ownerReply.sid || null,
    };
  }

  if (!forwardBody) {
    const threadId = await getOrCreateCustomerThread(input.env, input.businessNumber, recipient);

    await logSwitchboardMessage(input.env, {
      providerMessageId: input.providerMessageId || null,
      threadId,
      businessNumber: input.businessNumber,
      direction: 'inbound',
      fromNumber: input.ownerPhone,
      toNumber: input.businessNumber,
      messageBody: input.inboundBody,
      classification: 'owner_relay',
      confidence: null,
      metadata: {
        reason: 'empty_message_body',
        recipient,
      },
    });

    const emptyBodyMessage = 'No message body to send. Add text after the phone number.';
    const ownerReply = await input.twilioClient.sendSms({
      toPhone: input.ownerPhone,
      fromPhone: input.businessNumber,
      body: emptyBodyMessage,
    });

    if (ownerReply.ok && !isSmsSuppressed(ownerReply)) {
      await saveOutboundSms(
        input.env,
        ownerReply.sid || '',
        input.businessNumber,
        input.ownerPhone,
        emptyBodyMessage,
        JSON.stringify({ source: 'owner_relay_empty_body', recipient })
      );

      await logSwitchboardMessage(input.env, {
        providerMessageId: ownerReply.sid || null,
        threadId,
        businessNumber: input.businessNumber,
        direction: 'outbound',
        fromNumber: input.businessNumber,
        toNumber: input.ownerPhone,
        messageBody: emptyBodyMessage,
        classification: 'owner_relay',
        confidence: null,
        metadata: {
          reason: 'empty_message_body',
          recipient,
        },
      });
    }

    return {
      ok: true,
      mode: 'owner_relay',
      confirmationSid: isSmsSuppressed(ownerReply) ? null : ownerReply.sid || null,
    };
  }

  const threadId = await getOrCreateCustomerThread(input.env, input.businessNumber, recipient);

  await logSwitchboardMessage(input.env, {
    providerMessageId: input.providerMessageId || null,
    threadId,
    businessNumber: input.businessNumber,
    direction: 'inbound',
    fromNumber: input.ownerPhone,
    toNumber: input.businessNumber,
    messageBody: input.inboundBody,
    classification: 'owner_relay',
    confidence: null,
    metadata: {
      recipient,
      resolution: recipientResolution,
    },
  });

  const forwarded = await input.twilioClient.sendSms({
    toPhone: recipient,
    fromPhone: input.businessNumber,
    body: await prepareCustomerFacingSmsBody(
      input.env.SYSTEMIX,
      input.businessNumber,
      recipient,
      sanitizeForSms(forwardBody)
    ),
  });

  if (!forwarded.ok) {
    twilioLog.error('Owner relay forwarding failed', {
      context: {
        handler: 'handleOwnerRelay',
        fromNumber: input.businessNumber,
        toNumber: recipient,
      },
      data: {
        detail: forwarded.detail || 'unknown',
      },
    });
    return {
      ok: false,
      mode: 'owner_relay',
    };
  }

  if (isSmsSuppressed(forwarded)) {
    twilioLog.log('Owner relay suppressed because customer is opted out', {
      context: {
        handler: 'handleOwnerRelay',
        fromNumber: input.businessNumber,
        toNumber: recipient,
      },
    });

    const suppressedBody = `Message not sent to ${recipient} because that number has opted out.`;
    const ownerSuppressedReply = await input.twilioClient.sendSms({
      toPhone: input.ownerPhone,
      fromPhone: input.businessNumber,
      body: sanitizeForSms(suppressedBody),
    });

    if (ownerSuppressedReply.ok && !isSmsSuppressed(ownerSuppressedReply)) {
      await saveOutboundSms(
        input.env,
        ownerSuppressedReply.sid || '',
        input.businessNumber,
        input.ownerPhone,
        suppressedBody,
        JSON.stringify({
          source: 'owner_relay_suppressed_confirmation',
          recipient,
        })
      );

      await logSwitchboardMessage(input.env, {
        providerMessageId: ownerSuppressedReply.sid || null,
        threadId,
        businessNumber: input.businessNumber,
        direction: 'outbound',
        fromNumber: input.businessNumber,
        toNumber: input.ownerPhone,
        messageBody: suppressedBody,
        classification: 'owner_relay',
        confidence: null,
        metadata: {
          recipient,
          target: 'owner_suppressed_confirmation',
        },
      });
    }

    return {
      ok: true,
      mode: 'owner_relay',
      forwardedSid: null,
      confirmationSid: isSmsSuppressed(ownerSuppressedReply) ? null : ownerSuppressedReply.sid || null,
    };
  }

  await saveOutboundSms(
    input.env,
    forwarded.sid || '',
    input.businessNumber,
    recipient,
    forwardBody,
    JSON.stringify({
      source: 'owner_relay_forward',
      ownerPhone: input.ownerPhone,
    })
  );

  await logSwitchboardMessage(input.env, {
    providerMessageId: forwarded.sid || null,
    threadId,
    businessNumber: input.businessNumber,
    direction: 'outbound',
    fromNumber: input.businessNumber,
    toNumber: recipient,
    messageBody: forwardBody,
    classification: 'owner_relay',
    confidence: null,
    metadata: {
      recipient,
      target: 'customer',
    },
  });

  await setLastCustomerForLine(input.env, input.businessNumber, recipient);

  const confirmationBody = `✓ Sent to ${recipient}: "${forwardBody}"`;
  const ownerConfirmation = await input.twilioClient.sendSms({
    toPhone: input.ownerPhone,
    fromPhone: input.businessNumber,
    body: sanitizeForSms(confirmationBody),
  });

  if (!ownerConfirmation.ok) {
    twilioLog.error('Owner relay confirmation failed', {
      context: {
        handler: 'handleOwnerRelay',
        fromNumber: input.businessNumber,
        toNumber: input.ownerPhone,
      },
      data: {
        detail: ownerConfirmation.detail || 'unknown',
      },
    });

    return {
      ok: true,
      mode: 'owner_relay',
      forwardedSid: forwarded.sid || null,
      confirmationSid: null,
    };
  }

  if (isSmsSuppressed(ownerConfirmation)) {
    twilioLog.log('Owner relay confirmation suppressed because recipient is opted out', {
      context: {
        handler: 'handleOwnerRelay',
        fromNumber: input.businessNumber,
        toNumber: input.ownerPhone,
      },
    });

    return {
      ok: true,
      mode: 'owner_relay',
      forwardedSid: forwarded.sid || null,
      confirmationSid: null,
    };
  }

  await saveOutboundSms(
    input.env,
    ownerConfirmation.sid || '',
    input.businessNumber,
    input.ownerPhone,
    confirmationBody,
    JSON.stringify({
      source: 'owner_relay_confirmation',
      recipient,
      forwardedSid: forwarded.sid || null,
    })
  );

  await logSwitchboardMessage(input.env, {
    providerMessageId: ownerConfirmation.sid || null,
    threadId,
    businessNumber: input.businessNumber,
    direction: 'outbound',
    fromNumber: input.businessNumber,
    toNumber: input.ownerPhone,
    messageBody: confirmationBody,
    classification: 'owner_relay',
    confidence: null,
    metadata: {
      recipient,
      forwardedSid: forwarded.sid || null,
      target: 'owner_confirmation',
    },
  });

  return {
    ok: true,
    mode: 'owner_relay',
    forwardedSid: forwarded.sid || null,
    confirmationSid: ownerConfirmation.sid || null,
  };
}

async function syncLeadToHubspot(input: {
  env: Bindings;
  businessNumber: string;
  customerNumber: string;
  summary: string;
  classification: AiLeadClassification;
}): Promise<{ synced: boolean; reason?: string }> {
  try {
    await syncHubspotContact(input.customerNumber, input.classification, input.summary, input.env);

    return { synced: true };
  } catch (error) {
    hubspotLog.error('HubSpot lead sync failed', {
      error,
      context: {
        handler: 'syncLeadToHubspot',
        fromNumber: input.businessNumber,
        toNumber: input.customerNumber,
      },
    });
    return { synced: false, reason: 'sync_failed' };
  }
}

function buildUnknownBusinessBackgroundTasks(input: {
  env: Bindings;
  inboundFrom: string;
  inboundTo: string;
  body: string;
  providerMessageId: string;
  route: 'owner_proxy' | 'customer_analysis';
  rawParams: Record<string, string>;
  rawJson: string;
}): Promise<unknown>[] {
  const saveInboundTask = withLoggedBackgroundCatch(
    '[D1]',
    'Persist inbound MessageSid',
    saveInboundSms(
      input.env,
      input.inboundFrom,
      input.inboundTo,
      input.body,
      input.providerMessageId,
      input.rawJson
    ).then((saved) => {
      d1Log.log('Inbound MessageSid stored', {
        context: {
          handler: 'buildUnknownBusinessBackgroundTasks',
          messageSid: input.providerMessageId || null,
          fromNumber: input.inboundFrom,
          toNumber: input.inboundTo,
        },
        data: {
          saved: saved.saved,
        },
      });
      return saved;
    }),
    {
      context: {
        handler: 'buildUnknownBusinessBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.inboundFrom,
        toNumber: input.inboundTo,
      },
    }
  );

  const unresolvedLineTask = withLoggedBackgroundCatch(
    '[D1]',
    'Log unresolved business line',
    saveInboundTask.then(async (savedInbound) => {
      if (!savedInbound?.saved) return null;

      await handleUnknownBusinessLine({
        env: input.env,
        inboundFrom: input.inboundFrom,
        inboundTo: input.inboundTo,
        body: input.body,
        providerMessageId: input.providerMessageId,
        route: input.route,
        rawParams: input.rawParams,
      });

      d1Log.log('Unresolved business line logged', {
        context: {
          handler: 'buildUnknownBusinessBackgroundTasks',
          messageSid: input.providerMessageId || null,
          fromNumber: input.inboundFrom,
          toNumber: input.inboundTo,
        },
      });

      return true;
    }),
    {
      context: {
        handler: 'buildUnknownBusinessBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.inboundFrom,
        toNumber: input.inboundTo,
      },
    }
  );

  return [saveInboundTask, unresolvedLineTask];
}

function buildMissingOwnerMappingBackgroundTasks(input: {
  env: Bindings;
  inboundFrom: string;
  inboundTo: string;
  body: string;
  providerMessageId: string;
  rawJson: string;
  businessNumber: string;
}): Promise<unknown>[] {
  const saveInboundTask = withLoggedBackgroundCatch(
    '[D1]',
    'Persist inbound MessageSid',
    saveInboundSms(
      input.env,
      input.inboundFrom,
      input.inboundTo,
      input.body,
      input.providerMessageId,
      input.rawJson
    ).then((saved) => {
      d1Log.log('Inbound MessageSid stored', {
        context: {
          handler: 'buildMissingOwnerMappingBackgroundTasks',
          messageSid: input.providerMessageId || null,
          fromNumber: input.inboundFrom,
          toNumber: input.inboundTo,
        },
        data: {
          saved: saved.saved,
        },
      });
      return saved;
    }),
    {
      context: {
        handler: 'buildMissingOwnerMappingBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.inboundFrom,
        toNumber: input.inboundTo,
      },
    }
  );

  const missingOwnerTask = withLoggedBackgroundCatch(
    '[D1]',
    'Log missing owner mapping',
    saveInboundTask.then(async (savedInbound) => {
      if (!savedInbound?.saved) return null;

      await logSwitchboardEvent(input.env, 'missing_owner_mapping', {
        businessNumber: input.businessNumber,
        fromNumber: input.inboundFrom,
        toNumber: input.inboundTo,
        metadata: {
          reason: 'missing_owner_phone_number_for_business',
          providerMessageId: input.providerMessageId || null,
        },
      });

      d1Log.log('Missing owner mapping logged', {
        context: {
          handler: 'buildMissingOwnerMappingBackgroundTasks',
          messageSid: input.providerMessageId || null,
          fromNumber: input.inboundFrom,
          toNumber: input.inboundTo,
        },
        data: {
          businessNumber: input.businessNumber,
        },
      });

      return true;
    }),
    {
      context: {
        handler: 'buildMissingOwnerMappingBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.inboundFrom,
        toNumber: input.inboundTo,
      },
    }
  );

  return [saveInboundTask, missingOwnerTask];
}

function buildForcedLeadBackgroundTasks(input: {
  env: Bindings;
  businessNumber: string;
  customerNumber: string;
  body: string;
  inboundTo: string;
  providerMessageId: string;
  rawJson: string;
}): Promise<unknown>[] {
  const saveInboundTask = withLoggedBackgroundCatch(
    '[D1]',
    'Persist inbound MessageSid',
    saveInboundSms(
      input.env,
      input.customerNumber,
      input.inboundTo,
      input.body,
      input.providerMessageId,
      input.rawJson
    ).then((saved) => {
      d1Log.log('Inbound MessageSid stored', {
        context: {
          handler: 'buildForcedLeadBackgroundTasks',
          messageSid: input.providerMessageId || null,
          fromNumber: input.customerNumber,
          toNumber: input.inboundTo,
        },
        data: {
          saved: saved.saved,
        },
      });
      return saved;
    }),
    {
      context: {
        handler: 'buildForcedLeadBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.customerNumber,
        toNumber: input.inboundTo,
      },
    }
  );

  const hubspotTask = withLoggedBackgroundCatch(
    '[HUBSPOT]',
    'Forced lead sync',
    saveInboundTask.then(async (savedInbound) => {
      if (!savedInbound?.saved) return null;

      const result = await syncLeadToHubspot({
        env: input.env,
        businessNumber: input.businessNumber,
        customerNumber: input.customerNumber,
        summary: buildLeadSummary('inquiry', input.body),
        classification: 'inquiry',
      });

      if (!result.synced) {
        throw new Error(result.reason || 'sync_failed');
      }

      hubspotLog.log('Forced lead sync completed', {
        context: {
          handler: 'buildForcedLeadBackgroundTasks',
          messageSid: input.providerMessageId || null,
          fromNumber: input.businessNumber,
          toNumber: input.customerNumber,
        },
      });
      return true;
    }),
    {
      context: {
        handler: 'buildForcedLeadBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.businessNumber,
        toNumber: input.customerNumber,
      },
    }
  );

  return [saveInboundTask, hubspotTask];
}

function buildCustomerAnalysisBackgroundTasks(input: {
  env: Bindings;
  twilioClient: TwilioRestClient;
  businessNumber: string;
  ownerPhone: string;
  displayName: string;
  customerNumber: string;
  inboundTo: string;
  body: string;
  providerMessageId: string;
  rawJson: string;
  ownerAlertEligible: boolean;
}): Promise<unknown>[] {
  const saveInboundTask = withLoggedBackgroundCatch(
    '[D1]',
    'Persist inbound message',
    saveInboundSms(
      input.env,
      input.customerNumber,
      input.inboundTo,
      input.body,
      input.providerMessageId,
      input.rawJson
    ).then((saved) => {
      d1Log.log('Inbound MessageSid stored', {
        context: {
          handler: 'buildCustomerAnalysisBackgroundTasks',
          messageSid: input.providerMessageId || null,
          fromNumber: input.customerNumber,
          toNumber: input.inboundTo,
        },
        data: {
          saved: saved.saved,
          deduplicated: saved.deduplicated,
          reason: saved.reason,
        },
      });
      return saved;
    }),
    {
      context: {
        handler: 'buildCustomerAnalysisBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.customerNumber,
        toNumber: input.inboundTo,
      },
    }
  );

  const notificationEligibilityTask = withLoggedBackgroundCatch(
    '[D1]',
    'Evaluate owner notification eligibility',
    saveInboundTask.then(async (savedInbound) => {
      if (!savedInbound?.saved) {
        return {
          send: false,
          reason: savedInbound?.reason || 'not_saved',
          inboundCount: 0,
        };
      }

      const inboundCount = await countInboundCustomerMessages(
        input.env,
        input.businessNumber,
        input.customerNumber
      );

      return {
        send: inboundCount === 1,
        reason: inboundCount === 1 ? 'new_lead' : 'existing_thread',
        inboundCount,
      };
    }),
    {
      context: {
        handler: 'buildCustomerAnalysisBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.customerNumber,
        toNumber: input.ownerPhone || input.businessNumber,
      },
    }
  );

  const classifyTask = withLoggedBackgroundCatch(
    '[CLASSIFY]',
    'Lead classification',
    saveInboundTask.then(async (savedInbound) => {
      if (!savedInbound?.saved) return null;

      const triage = await classifyCustomerMessage(input.body, input.env.OPENAI_API_KEY);
      classifyLog.log('Lead classification completed', {
        context: {
          handler: 'buildCustomerAnalysisBackgroundTasks',
          messageSid: input.providerMessageId || null,
          fromNumber: input.customerNumber,
          toNumber: input.businessNumber,
        },
        data: {
          classification: triage.aiClassification,
          routingClassification: triage.classification,
          confidence: triage.confidence,
        },
      });
      return triage;
    }),
    {
      context: {
        handler: 'buildCustomerAnalysisBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.customerNumber,
        toNumber: input.businessNumber,
      },
    }
  );

  const threadIdTask = withLoggedBackgroundCatch(
    '[D1]',
    'Prepare customer thread',
    saveInboundTask.then(async (savedInbound) => {
      if (!savedInbound?.saved) return null;

      const threadId = await getOrCreateCustomerThread(input.env, input.businessNumber, input.customerNumber);
      d1Log.log('Customer thread ready', {
        context: {
          handler: 'buildCustomerAnalysisBackgroundTasks',
          messageSid: input.providerMessageId || null,
          fromNumber: input.customerNumber,
          toNumber: input.businessNumber,
        },
        data: {
          threadId,
        },
      });
      return threadId;
    }),
    {
      context: {
        handler: 'buildCustomerAnalysisBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.customerNumber,
        toNumber: input.businessNumber,
      },
    }
  );

  const setLastCustomerTask = withLoggedBackgroundCatch(
    '[D1]',
    'Update last customer pointer',
    Promise.all([threadIdTask, classifyTask]).then(async ([threadId, triage]) => {
      if (!threadId || !triage) return null;

      await setLastCustomerForLine(input.env, input.businessNumber, input.customerNumber);
      d1Log.log('Last customer pointer updated', {
        context: {
          handler: 'buildCustomerAnalysisBackgroundTasks',
          messageSid: input.providerMessageId || null,
          fromNumber: input.customerNumber,
          toNumber: input.businessNumber,
        },
      });
      return true;
    }),
    {
      context: {
        handler: 'buildCustomerAnalysisBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.customerNumber,
        toNumber: input.businessNumber,
      },
    }
  );

  const emergencyDedupTask = withLoggedBackgroundCatch(
    '[D1]',
    'Check emergency dedupe window',
    classifyTask.then(async (triage) => {
      if (!triage || triage.classification !== 'emergency') return false;

      const isDeduped = await hasRecentEmergencyAlert(input.env, input.businessNumber, input.customerNumber);
      d1Log.log('Emergency dedupe evaluated', {
        context: {
          handler: 'buildCustomerAnalysisBackgroundTasks',
          messageSid: input.providerMessageId || null,
          fromNumber: input.customerNumber,
          toNumber: input.businessNumber,
        },
        data: {
          deduped: isDeduped,
        },
      });
      return isDeduped;
    }),
    {
      context: {
        handler: 'buildCustomerAnalysisBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.customerNumber,
        toNumber: input.businessNumber,
      },
    }
  );

  const inboundClassificationTask = Promise.all([classifyTask, emergencyDedupTask]).then(
    ([triage, isDeduped]): TriageLabel | null => {
      if (!triage) return null;
      if (triage.classification === 'standard') return 'standard';
      return isDeduped ? 'emergency_suppressed' : 'emergency';
    }
  );

  const logInboundTask = withLoggedBackgroundCatch(
    '[D1]',
    'Log inbound message',
    Promise.all([threadIdTask, classifyTask, inboundClassificationTask]).then(
      async ([threadId, triage, inboundClassification]) => {
        if (!threadId || !triage || !inboundClassification) return null;

        await logSwitchboardMessage(input.env, {
          providerMessageId: input.providerMessageId || null,
          threadId,
          businessNumber: input.businessNumber,
          direction: 'inbound',
          fromNumber: input.customerNumber,
          toNumber: input.businessNumber,
          messageBody: input.body,
          classification: inboundClassification,
          confidence: triage.confidence,
          metadata: {
            source: triage.source,
            aiClassification: triage.aiClassification,
            summary: triage.summary,
            gptUsed: triage.gptUsed,
            keywordMatcherMs: triage.keywordMatcherMs,
            gptClassifierMs: triage.gptClassifierMs,
          },
        });

        d1Log.log('Inbound message logged', {
          context: {
            handler: 'buildCustomerAnalysisBackgroundTasks',
            messageSid: input.providerMessageId || null,
            fromNumber: input.customerNumber,
            toNumber: input.businessNumber,
          },
          data: {
            classification: inboundClassification,
          },
        });
        return true;
      }
    ),
    {
      context: {
        handler: 'buildCustomerAnalysisBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.customerNumber,
        toNumber: input.businessNumber,
      },
    }
  );

  const ownerAlertTask = input.ownerAlertEligible
    ? withLoggedBackgroundCatch(
        '[TWILIO]',
        'Send owner lead notification',
        Promise.all([saveInboundTask, classifyTask, inboundClassificationTask, notificationEligibilityTask]).then(
          async ([savedInbound, triage, inboundClassification, notificationEligibility]) => {
            if (!savedInbound?.saved || !notificationEligibility?.send) return null;

            const ownerAlertBody = buildBusinessOwnerAlertMessage({
              classification: triage?.aiClassification ?? null,
              summary: triage?.summary ?? null,
              customerNumber: input.customerNumber,
              customerMessage: input.body,
            });
            const ownerSms = await input.twilioClient.sendSms({
              toPhone: input.ownerPhone,
              fromPhone: input.businessNumber,
              body: sanitizeForSms(ownerAlertBody),
            });

            if (!ownerSms.ok) {
              throw new Error(ownerSms.detail || 'unknown');
            }

            const ownerAlertClassification: TriageLabel = inboundClassification || 'standard';
            if (isSmsSuppressed(ownerSms)) {
              twilioLog.log('Owner alert suppressed because recipient is opted out', {
                context: {
                  handler: 'buildCustomerAnalysisBackgroundTasks',
                  fromNumber: input.businessNumber,
                  toNumber: input.ownerPhone,
                },
                data: {
                  classification: triage?.aiClassification || null,
                  routingClassification: ownerAlertClassification,
                  summary: triage?.summary || null,
                },
              });
            } else {
              twilioLog.log('Owner alert sent', {
                context: {
                  handler: 'buildCustomerAnalysisBackgroundTasks',
                  messageSid: ownerSms.sid || null,
                  fromNumber: input.businessNumber,
                  toNumber: input.ownerPhone,
                },
                data: {
                  classification: triage?.aiClassification || null,
                  routingClassification: ownerAlertClassification,
                  summary: triage?.summary || null,
                },
              });
            }

            return {
              sid: ownerSms.sid || '',
              suppressed: isSmsSuppressed(ownerSms),
              body: ownerAlertBody,
              classification: ownerAlertClassification,
              trigger: notificationEligibility.reason,
              confidence: triage?.confidence ?? 'low',
              aiClassification: triage?.aiClassification ?? null,
              summary: triage?.summary ?? null,
              gptUsed: triage?.gptUsed ?? false,
              keywordMatcherMs: triage?.keywordMatcherMs ?? null,
              gptClassifierMs: triage?.gptClassifierMs ?? null,
            };
          }
        ),
        {
          context: {
            handler: 'buildCustomerAnalysisBackgroundTasks',
            messageSid: input.providerMessageId || null,
            fromNumber: input.businessNumber,
            toNumber: input.ownerPhone,
          },
        }
      )
    : null;

  const persistOwnerAlertTask = ownerAlertTask
    ? withLoggedBackgroundCatch(
        '[D1]',
        'Persist owner lead notification',
        Promise.all([ownerAlertTask, threadIdTask]).then(async ([ownerAlert, threadId]) => {
          if (!ownerAlert || !threadId || ownerAlert.suppressed) return null;

          await saveOutboundSms(
            input.env,
            ownerAlert.sid,
            input.businessNumber,
            input.ownerPhone,
            ownerAlert.body,
            JSON.stringify({
              source: 'owner_new_lead_notification',
              trigger: ownerAlert.trigger,
              providerMessageId: input.providerMessageId || null,
            })
          );

          await logSwitchboardMessage(input.env, {
            providerMessageId: ownerAlert.sid || null,
            threadId,
            businessNumber: input.businessNumber,
            direction: 'outbound',
            fromNumber: input.businessNumber,
            toNumber: input.ownerPhone,
            messageBody: ownerAlert.body,
            classification: ownerAlert.classification,
            confidence: ownerAlert.confidence,
            metadata: {
              source: 'owner_new_lead_notification',
              trigger: ownerAlert.trigger,
              aiClassification: ownerAlert.aiClassification,
              summary: ownerAlert.summary,
              gptUsed: ownerAlert.gptUsed,
              keywordMatcherMs: ownerAlert.keywordMatcherMs,
              gptClassifierMs: ownerAlert.gptClassifierMs,
            },
          });

          d1Log.log('Owner alert persisted', {
            context: {
              handler: 'buildCustomerAnalysisBackgroundTasks',
              messageSid: ownerAlert.sid || null,
              fromNumber: input.businessNumber,
              toNumber: input.ownerPhone,
            },
          });
          return true;
        }),
        {
          context: {
            handler: 'buildCustomerAnalysisBackgroundTasks',
            messageSid: input.providerMessageId || null,
            fromNumber: input.businessNumber,
            toNumber: input.ownerPhone,
          },
        }
      )
    : null;

  const customerReplyTask = withLoggedBackgroundCatch(
    '[TWILIO]',
    'Send emergency customer reply',
    Promise.all([classifyTask, inboundClassificationTask]).then(async ([triage, inboundClassification]) => {
      if (!triage || triage.classification !== 'emergency' || !inboundClassification) return null;

      const emergencyCustomerMessage = buildEmergencyPriorityMessage(triage.summary, input.displayName);
      const preparedBody = await prepareCustomerFacingSmsBody(
        input.env.SYSTEMIX,
        input.businessNumber,
        input.customerNumber,
        emergencyCustomerMessage
      );
      const customerReply = await input.twilioClient.sendSms({
        toPhone: input.customerNumber,
        fromPhone: input.businessNumber,
        body: preparedBody,
      });

      if (!customerReply.ok) {
        throw new Error(customerReply.detail || 'unknown');
      }

      if (isSmsSuppressed(customerReply)) {
        twilioLog.log('Emergency customer reply suppressed because recipient is opted out', {
          context: {
            handler: 'buildCustomerAnalysisBackgroundTasks',
            fromNumber: input.businessNumber,
            toNumber: input.customerNumber,
          },
          data: {
            summary: triage.summary,
          },
        });
      } else {
        twilioLog.log('Emergency customer reply sent', {
          context: {
            handler: 'buildCustomerAnalysisBackgroundTasks',
            messageSid: customerReply.sid || null,
            fromNumber: input.businessNumber,
            toNumber: input.customerNumber,
          },
          data: {
            summary: triage.summary,
          },
        });
      }

      return {
        body: emergencyCustomerMessage,
        sid: customerReply.sid || '',
        suppressed: isSmsSuppressed(customerReply),
        inboundClassification,
        confidence: triage.confidence,
        summary: triage.summary,
      };
    }),
    {
      context: {
        handler: 'buildCustomerAnalysisBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.businessNumber,
        toNumber: input.customerNumber,
      },
    }
  );

  const persistCustomerReplyTask = withLoggedBackgroundCatch(
    '[D1]',
    'Persist emergency customer reply',
    Promise.all([customerReplyTask, threadIdTask]).then(async ([customerReply, threadId]) => {
      if (!customerReply || !threadId || customerReply.suppressed) return null;

      await saveOutboundSms(
        input.env,
        customerReply.sid,
        input.businessNumber,
        input.customerNumber,
        customerReply.body,
        JSON.stringify({
          source: 'customer_emergency_confirmation',
          inboundClassification: customerReply.inboundClassification,
          providerMessageId: input.providerMessageId || null,
        })
      );

      await logSwitchboardMessage(input.env, {
        providerMessageId: customerReply.sid || null,
        threadId,
        businessNumber: input.businessNumber,
        direction: 'outbound',
        fromNumber: input.businessNumber,
        toNumber: input.customerNumber,
        messageBody: customerReply.body,
        classification: customerReply.inboundClassification,
        confidence: customerReply.confidence,
        metadata: {
          target: 'customer_confirmation',
          summary: customerReply.summary,
          displayName: input.displayName || null,
        },
      });

      d1Log.log('Emergency customer reply persisted', {
        context: {
          handler: 'buildCustomerAnalysisBackgroundTasks',
          messageSid: customerReply.sid || null,
          fromNumber: input.businessNumber,
          toNumber: input.customerNumber,
        },
      });
      return true;
    }),
    {
      context: {
        handler: 'buildCustomerAnalysisBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.businessNumber,
        toNumber: input.customerNumber,
      },
    }
  );

  const hubspotTask = withLoggedBackgroundCatch(
    '[HUBSPOT]',
    'Lead sync',
    Promise.all([classifyTask, emergencyDedupTask]).then(async ([triage, isDeduped]) => {
      if (!triage || !input.ownerAlertEligible) return null;
      if (triage.classification === 'emergency' && isDeduped) return null;

      const result = await syncLeadToHubspot({
        env: input.env,
        businessNumber: input.businessNumber,
        customerNumber: input.customerNumber,
        summary: triage.summary,
        classification: triage.aiClassification,
      });

      if (!result.synced) {
        throw new Error(result.reason || 'sync_failed');
      }

      hubspotLog.log('Lead sync completed', {
        context: {
          handler: 'buildCustomerAnalysisBackgroundTasks',
          messageSid: input.providerMessageId || null,
          fromNumber: input.businessNumber,
          toNumber: input.customerNumber,
        },
      });
      return true;
    }),
    {
      context: {
        handler: 'buildCustomerAnalysisBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.businessNumber,
        toNumber: input.customerNumber,
      },
    }
  );

  const recordEmergencyTask = withLoggedBackgroundCatch(
    '[D1]',
    'Record emergency alert',
    Promise.all([classifyTask, emergencyDedupTask, ownerAlertTask ?? Promise.resolve(null)]).then(
      async ([triage, isDeduped, ownerAlert]) => {
      if (!triage || triage.classification !== 'emergency' || isDeduped || !input.ownerAlertEligible) return null;
      if (ownerAlertTask && (!ownerAlert || ownerAlert.suppressed)) return null;

      await recordEmergencyAlert(input.env, input.businessNumber, input.customerNumber, 'emergency');
      d1Log.log('Emergency alert recorded', {
        context: {
          handler: 'buildCustomerAnalysisBackgroundTasks',
          messageSid: input.providerMessageId || null,
          fromNumber: input.businessNumber,
          toNumber: input.customerNumber,
        },
      });
      return true;
      }
    ),
    {
      context: {
        handler: 'buildCustomerAnalysisBackgroundTasks',
        messageSid: input.providerMessageId || null,
        fromNumber: input.businessNumber,
        toNumber: input.customerNumber,
      },
    }
  );

  return [
    saveInboundTask,
    notificationEligibilityTask,
    classifyTask,
    threadIdTask,
    setLastCustomerTask,
    emergencyDedupTask,
    logInboundTask,
    ...(ownerAlertTask ? [ownerAlertTask] : []),
    customerReplyTask,
    persistCustomerReplyTask,
    hubspotTask,
    recordEmergencyTask,
    ...(persistOwnerAlertTask ? [persistOwnerAlertTask] : []),
  ];
}

async function handleCustomerInbound(input: {
  env: Bindings;
  twilioClient: TwilioRestClient;
  businessNumber: string;
  ownerPhone: string;
  displayName: string;
  customerNumber: string;
  body: string;
  providerMessageId: string;
  executionCtx?: ExecutionContext;
}): Promise<{
  ok: boolean;
  mode: 'customer_analysis';
  routingClassification: TriageLabel;
  aiClassification: AiLeadClassification;
  summary: string;
  confidence: Confidence;
  gptUsed: boolean;
  customerReplySid?: string | null;
  ownerAlertSid?: string | null;
}> {
  const threadId = await getOrCreateCustomerThread(input.env, input.businessNumber, input.customerNumber);
  const triage = await classifyCustomerMessage(input.body, input.env.OPENAI_API_KEY);

  classifyLog.log('Classification timing trace recorded', {
    context: {
      handler: 'handleCustomerInbound',
      messageSid: input.providerMessageId || null,
      fromNumber: input.customerNumber,
      toNumber: input.businessNumber,
    },
    data: {
      keywordMatcherMs: triage.keywordMatcherMs,
      gptClassifierMs: triage.gptClassifierMs,
      gptUsed: triage.gptUsed,
      classification: triage.aiClassification,
      routingClassification: triage.classification,
      summary: triage.summary,
      confidence: triage.confidence,
    },
  });

  await setLastCustomerForLine(input.env, input.businessNumber, input.customerNumber);

  const pauseState = input.ownerPhone
    ? await getOwnerAlertPauseState(input.env, input.businessNumber, input.ownerPhone)
    : {
        isPaused: false,
        alertsPausedUntil: null,
        pauseColumnAvailable: true,
      };

  const syncToHubspot = async (
    customerPhone: string,
    classification: AiLeadClassification,
    summary: string
  ): Promise<void> => {
    const result = await syncLeadToHubspot({
      env: input.env,
      businessNumber: input.businessNumber,
      customerNumber: customerPhone,
      summary,
      classification,
    });
    if (!result.synced) {
      throw new Error(result.reason || 'sync_failed');
    }
  };

  const queueHubspotSync = (classification: AiLeadClassification, summary: string) => {
    const customerPhone = input.customerNumber;

    scheduleTwilioBackgroundTask(
      input.executionCtx,
      'HubSpot sync',
      syncToHubspot(customerPhone, classification, summary).then(() => {
        hubspotLog.log('Lead sync completed', {
          context: {
            handler: 'handleCustomerInbound',
            messageSid: input.providerMessageId || null,
            fromNumber: input.businessNumber,
            toNumber: customerPhone,
          },
        });
      })
    );
  };

  if (triage.classification === 'standard') {
    await logSwitchboardMessage(input.env, {
      providerMessageId: input.providerMessageId || null,
      threadId,
      businessNumber: input.businessNumber,
      direction: 'inbound',
      fromNumber: input.customerNumber,
      toNumber: input.businessNumber,
      messageBody: input.body,
      classification: 'standard',
      confidence: triage.confidence,
      metadata: {
        source: triage.source,
        aiClassification: triage.aiClassification,
        summary: triage.summary,
        gptUsed: triage.gptUsed,
        keywordMatcherMs: triage.keywordMatcherMs,
        gptClassifierMs: triage.gptClassifierMs,
      },
    });

    if (!input.ownerPhone) {
      return {
        ok: false,
        mode: 'customer_analysis',
        routingClassification: 'standard',
        aiClassification: triage.aiClassification,
        summary: triage.summary,
        confidence: triage.confidence,
        gptUsed: triage.gptUsed,
      };
    }

    if (pauseState.isPaused) {
      twilioLog.log('Owner alert skipped because alerts are paused', {
        context: {
          handler: 'handleCustomerInbound',
          messageSid: input.providerMessageId || null,
          fromNumber: input.businessNumber,
          toNumber: input.ownerPhone,
        },
        data: {
          alertsPausedUntil: pauseState.alertsPausedUntil || 'unknown',
        },
      });

      return {
        ok: true,
        mode: 'customer_analysis',
        routingClassification: 'standard',
        aiClassification: triage.aiClassification,
        summary: triage.summary,
        confidence: triage.confidence,
        gptUsed: triage.gptUsed,
        ownerAlertSid: null,
      };
    }

    const ownerAlertBody = buildOwnerAlertMessage(
      triage.aiClassification === 'spam' ? 'inquiry' : triage.aiClassification,
      triage.summary,
      input.customerNumber
    );
    const ownerSms = await input.twilioClient.sendSms({
      toPhone: input.ownerPhone,
      fromPhone: input.businessNumber,
      body: sanitizeForSms(ownerAlertBody),
    });

    if (!ownerSms.ok) {
      twilioLog.error('Standard owner alert failed', {
        context: {
          handler: 'handleCustomerInbound',
          fromNumber: input.businessNumber,
          toNumber: input.ownerPhone,
        },
        data: {
          customerNumber: input.customerNumber,
          detail: ownerSms.detail || 'unknown',
        },
      });

      return {
        ok: false,
        mode: 'customer_analysis',
        routingClassification: 'standard',
        aiClassification: triage.aiClassification,
        summary: triage.summary,
        confidence: triage.confidence,
        gptUsed: triage.gptUsed,
      };
    }

    if (isSmsSuppressed(ownerSms)) {
      twilioLog.log('Standard owner alert suppressed because recipient is opted out', {
        context: {
          handler: 'handleCustomerInbound',
          fromNumber: input.businessNumber,
          toNumber: input.ownerPhone,
        },
        data: {
          classification: triage.aiClassification,
          summary: triage.summary,
        },
      });
    } else {
      twilioLog.log('Owner alert sent', {
        context: {
          handler: 'handleCustomerInbound',
          messageSid: ownerSms.sid || null,
          fromNumber: input.businessNumber,
          toNumber: input.ownerPhone,
        },
        data: {
          classification: triage.aiClassification,
          summary: triage.summary,
        },
      });
    }

    queueHubspotSync(triage.aiClassification, triage.summary);

    if (!isSmsSuppressed(ownerSms)) {
      await saveOutboundSms(
        input.env,
        ownerSms.sid || '',
        input.businessNumber,
        input.ownerPhone,
        ownerAlertBody,
        JSON.stringify({
          source: 'standard_owner_alert',
          providerMessageId: input.providerMessageId || null,
        })
      );

      await logSwitchboardMessage(input.env, {
        providerMessageId: ownerSms.sid || null,
        threadId,
        businessNumber: input.businessNumber,
        direction: 'outbound',
        fromNumber: input.businessNumber,
        toNumber: input.ownerPhone,
        messageBody: ownerAlertBody,
        classification: 'standard',
        confidence: triage.confidence,
        metadata: {
          source: 'existing_standard_auto_reply_logic',
          aiClassification: triage.aiClassification,
          summary: triage.summary,
          keywordMatcherMs: triage.keywordMatcherMs,
          gptClassifierMs: triage.gptClassifierMs,
        },
      });
    }

    return {
      ok: true,
      mode: 'customer_analysis',
      routingClassification: 'standard',
      aiClassification: triage.aiClassification,
      summary: triage.summary,
      confidence: triage.confidence,
      gptUsed: triage.gptUsed,
      ownerAlertSid: isSmsSuppressed(ownerSms) ? null : ownerSms.sid || null,
    };
  }

  const isDeduped = await hasRecentEmergencyAlert(input.env, input.businessNumber, input.customerNumber);
  const inboundClassification: TriageLabel = isDeduped ? 'emergency_suppressed' : 'emergency';

  await logSwitchboardMessage(input.env, {
    providerMessageId: input.providerMessageId || null,
    threadId,
    businessNumber: input.businessNumber,
    direction: 'inbound',
    fromNumber: input.customerNumber,
    toNumber: input.businessNumber,
    messageBody: input.body,
    classification: inboundClassification,
    confidence: triage.confidence,
    metadata: {
      source: triage.source,
      aiClassification: triage.aiClassification,
      summary: triage.summary,
      gptUsed: triage.gptUsed,
      deduped: isDeduped,
      keywordMatcherMs: triage.keywordMatcherMs,
      gptClassifierMs: triage.gptClassifierMs,
    },
  });

  const emergencyCustomerMessage = buildEmergencyPriorityMessage(triage.summary, input.displayName);
  const customerReply = await input.twilioClient.sendSms({
    toPhone: input.customerNumber,
    fromPhone: input.businessNumber,
    body: await prepareCustomerFacingSmsBody(
      input.env.SYSTEMIX,
      input.businessNumber,
      input.customerNumber,
      emergencyCustomerMessage
    ),
  });

  if (!customerReply.ok) {
    twilioLog.error('Customer emergency confirmation failed', {
      context: {
        handler: 'handleCustomerInbound',
        fromNumber: input.businessNumber,
        toNumber: input.customerNumber,
      },
      data: {
        detail: customerReply.detail || 'unknown',
      },
    });

    return {
      ok: false,
      mode: 'customer_analysis',
      routingClassification: inboundClassification,
      aiClassification: triage.aiClassification,
      summary: triage.summary,
      confidence: triage.confidence,
      gptUsed: triage.gptUsed,
    };
  }

  if (isSmsSuppressed(customerReply)) {
    twilioLog.log('Emergency customer reply suppressed because recipient is opted out', {
      context: {
        handler: 'handleCustomerInbound',
        fromNumber: input.businessNumber,
        toNumber: input.customerNumber,
      },
      data: {
        summary: triage.summary,
      },
    });
  } else {
    twilioLog.log('Emergency customer reply sent', {
      context: {
        handler: 'handleCustomerInbound',
        messageSid: customerReply.sid || null,
        fromNumber: input.businessNumber,
        toNumber: input.customerNumber,
      },
      data: {
        summary: triage.summary,
      },
    });

    await saveOutboundSms(
      input.env,
      customerReply.sid || '',
      input.businessNumber,
      input.customerNumber,
      emergencyCustomerMessage,
      JSON.stringify({
        source: 'customer_emergency_confirmation',
        inboundClassification,
        providerMessageId: input.providerMessageId || null,
      })
    );

    await logSwitchboardMessage(input.env, {
      providerMessageId: customerReply.sid || null,
      threadId,
      businessNumber: input.businessNumber,
      direction: 'outbound',
      fromNumber: input.businessNumber,
      toNumber: input.customerNumber,
      messageBody: emergencyCustomerMessage,
      classification: inboundClassification,
      confidence: triage.confidence,
      metadata: {
        target: 'customer_confirmation',
        deduped: isDeduped,
        summary: triage.summary,
        displayName: input.displayName || null,
      },
    });
  }

  if (isDeduped) {
    return {
      ok: true,
      mode: 'customer_analysis',
      routingClassification: inboundClassification,
      aiClassification: triage.aiClassification,
      summary: triage.summary,
      confidence: triage.confidence,
      gptUsed: triage.gptUsed,
      customerReplySid: isSmsSuppressed(customerReply) ? null : customerReply.sid || null,
    };
  }

  if (!input.ownerPhone) {
    return {
      ok: false,
      mode: 'customer_analysis',
      routingClassification: inboundClassification,
      aiClassification: triage.aiClassification,
      summary: triage.summary,
      confidence: triage.confidence,
      gptUsed: triage.gptUsed,
      customerReplySid: isSmsSuppressed(customerReply) ? null : customerReply.sid || null,
    };
  }

  const hasMultipleActiveThreads = await hasConcurrentActiveEmergencyThread(
    input.env,
    input.businessNumber,
    input.customerNumber
  );

  const baseOwnerAlertBody = buildOwnerAlertMessage(
    'emergency',
    triage.summary,
    input.customerNumber
  );
  const ownerAlertBody = hasMultipleActiveThreads
    ? `${ACTIVE_THREAD_NOTICE} ${baseOwnerAlertBody}`
    : baseOwnerAlertBody;

  if (pauseState.isPaused) {
    twilioLog.log('Owner alert skipped because alerts are paused', {
      context: {
        handler: 'handleCustomerInbound',
        messageSid: input.providerMessageId || null,
        fromNumber: input.businessNumber,
        toNumber: input.ownerPhone,
      },
      data: {
        alertsPausedUntil: pauseState.alertsPausedUntil || 'unknown',
      },
    });

    return {
      ok: true,
      mode: 'customer_analysis',
      routingClassification: inboundClassification,
      aiClassification: triage.aiClassification,
      summary: triage.summary,
      confidence: triage.confidence,
      gptUsed: triage.gptUsed,
      customerReplySid: isSmsSuppressed(customerReply) ? null : customerReply.sid || null,
      ownerAlertSid: null,
    };
  }

  const ownerAlert = await input.twilioClient.sendSms({
    toPhone: input.ownerPhone,
    fromPhone: input.businessNumber,
    body: sanitizeForSms(ownerAlertBody),
  });

  if (!ownerAlert.ok) {
    twilioLog.error('Emergency owner alert failed', {
      context: {
        handler: 'handleCustomerInbound',
        fromNumber: input.businessNumber,
        toNumber: input.ownerPhone,
      },
      data: {
        customerNumber: input.customerNumber,
        detail: ownerAlert.detail || 'unknown',
      },
    });

    return {
      ok: false,
      mode: 'customer_analysis',
      routingClassification: inboundClassification,
      aiClassification: triage.aiClassification,
      summary: triage.summary,
      confidence: triage.confidence,
      gptUsed: triage.gptUsed,
      customerReplySid: isSmsSuppressed(customerReply) ? null : customerReply.sid || null,
    };
  }

  if (isSmsSuppressed(ownerAlert)) {
    twilioLog.log('Emergency owner alert suppressed because recipient is opted out', {
      context: {
        handler: 'handleCustomerInbound',
        fromNumber: input.businessNumber,
        toNumber: input.ownerPhone,
      },
      data: {
        classification: triage.aiClassification,
        summary: triage.summary,
      },
    });
  } else {
    twilioLog.log('Owner alert sent', {
      context: {
        handler: 'handleCustomerInbound',
        messageSid: ownerAlert.sid || null,
        fromNumber: input.businessNumber,
        toNumber: input.ownerPhone,
      },
      data: {
        classification: triage.aiClassification,
        summary: triage.summary,
      },
    });
  }

  queueHubspotSync(triage.aiClassification, triage.summary);

  const ownerAlertClassification: TriageLabel = 'emergency';

  if (!isSmsSuppressed(ownerAlert)) {
    await saveOutboundSms(
      input.env,
      ownerAlert.sid || '',
      input.businessNumber,
      input.ownerPhone,
      ownerAlertBody,
      JSON.stringify({
        source: 'owner_emergency_alert',
        triageConfidence: triage.confidence,
        providerMessageId: input.providerMessageId || null,
        hasMultipleActiveThreads,
      })
    );

    await logSwitchboardMessage(input.env, {
      providerMessageId: ownerAlert.sid || null,
      threadId,
      businessNumber: input.businessNumber,
      direction: 'outbound',
      fromNumber: input.businessNumber,
      toNumber: input.ownerPhone,
      messageBody: ownerAlertBody,
      classification: ownerAlertClassification,
      confidence: triage.confidence,
      metadata: {
        source: 'owner_emergency_alert',
        hasMultipleActiveThreads,
        aiClassification: triage.aiClassification,
        summary: triage.summary,
        keywordMatcherMs: triage.keywordMatcherMs,
        gptClassifierMs: triage.gptClassifierMs,
      },
    });

    await recordEmergencyAlert(input.env, input.businessNumber, input.customerNumber, ownerAlertClassification);
  }

  return {
    ok: true,
    mode: 'customer_analysis',
    routingClassification: inboundClassification,
    aiClassification: triage.aiClassification,
    summary: triage.summary,
    confidence: triage.confidence,
    gptUsed: triage.gptUsed,
    customerReplySid: isSmsSuppressed(customerReply) ? null : customerReply.sid || null,
    ownerAlertSid: isSmsSuppressed(ownerAlert) ? null : ownerAlert.sid || null,
  };
}

export async function checkEmergencyTimeouts(env: Bindings): Promise<void> {
  await ensureSwitchboardSchema(env);

  const twilioClient = createTwilioRestClient(env);
  if (!twilioClient) {
    twilioLog.error('Emergency timeout check skipped because Twilio credentials are missing', {
      context: {
        handler: 'checkEmergencyTimeouts',
      },
    });
    return;
  }

  const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;
  const timedOut = await getDb(env)
    .prepare(
      `
      SELECT
        id,
        business_number,
        customer_number,
        thread_id,
        last_emergency_alert_at
      FROM active_sessions
      WHERE status = 'active'
        AND customer_number != ?
        AND last_emergency_classification = 'emergency'
        AND last_emergency_alert_at IS NOT NULL
        AND unixepoch(last_emergency_alert_at) < ?
        AND NOT EXISTS (
          SELECT 1
          FROM messages owner_msg
          WHERE owner_msg.direction = 'outbound'
            AND owner_msg.from_phone = active_sessions.business_number
            AND owner_msg.to_phone = active_sessions.customer_number
            AND CASE
                  WHEN json_valid(COALESCE(owner_msg.raw_json, '{}')) = 1
                  THEN json_extract(COALESCE(owner_msg.raw_json, '{}'), '$.source')
                  ELSE NULL
                END = 'owner_relay_forward'
            AND unixepoch(owner_msg.created_at) >= unixepoch(active_sessions.last_emergency_alert_at)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM messages timeout_msg
          WHERE timeout_msg.direction = 'outbound'
            AND timeout_msg.from_phone = active_sessions.business_number
            AND timeout_msg.to_phone = active_sessions.customer_number
            AND CASE
                  WHEN json_valid(COALESCE(timeout_msg.raw_json, '{}')) = 1
                  THEN json_extract(COALESCE(timeout_msg.raw_json, '{}'), '$.source')
                  ELSE NULL
                END = 'emergency_timeout_auto_reply'
            AND unixepoch(timeout_msg.created_at) >= unixepoch(active_sessions.last_emergency_alert_at)
        )
      ORDER BY last_emergency_alert_at ASC
      LIMIT 200
    `
    )
    .bind(LINE_STATE_SENTINEL, Math.floor(fifteenMinutesAgo / 1000))
    .all<{
      id?: string;
      business_number?: string;
      customer_number?: string;
      thread_id?: string | null;
      last_emergency_alert_at?: string | null;
    }>();

  for (const thread of timedOut.results || []) {
    const businessNumber = normalizePhone(thread.business_number || '');
    const customerNumber = normalizePhone(thread.customer_number || '');
    if (!businessNumber || !customerNumber) {
      continue;
    }

    const timeoutReply = await twilioClient.sendSms({
      toPhone: customerNumber,
      fromPhone: businessNumber,
      body: await prepareCustomerFacingSmsBody(
        env.SYSTEMIX,
        businessNumber,
        customerNumber,
        EMERGENCY_TIMEOUT_MESSAGE
      ),
    });

    if (!timeoutReply.ok) {
      twilioLog.error('Emergency timeout auto-reply failed', {
        context: {
          handler: 'checkEmergencyTimeouts',
          fromNumber: businessNumber,
          toNumber: customerNumber,
        },
        data: {
          detail: timeoutReply.detail || 'unknown',
        },
      });
      continue;
    }

    if (isSmsSuppressed(timeoutReply)) {
      twilioLog.log('Emergency timeout auto-reply suppressed because recipient is opted out', {
        context: {
          handler: 'checkEmergencyTimeouts',
          fromNumber: businessNumber,
          toNumber: customerNumber,
        },
      });
      continue;
    }

    await saveOutboundSms(
      env,
      timeoutReply.sid || '',
      businessNumber,
      customerNumber,
      EMERGENCY_TIMEOUT_MESSAGE,
      JSON.stringify({
        source: 'emergency_timeout_auto_reply',
        activeSessionId: thread.id || null,
        lastEmergencyAlertAt: thread.last_emergency_alert_at || null,
      })
    );

    await logSwitchboardMessage(env, {
      providerMessageId: timeoutReply.sid || null,
      threadId: thread.thread_id || `${businessNumber}:${customerNumber}`,
      businessNumber,
      direction: 'outbound',
      fromNumber: businessNumber,
      toNumber: customerNumber,
      messageBody: EMERGENCY_TIMEOUT_MESSAGE,
      classification: 'emergency',
      confidence: null,
      metadata: {
        source: 'emergency_timeout_auto_reply',
        activeSessionId: thread.id || null,
        lastEmergencyAlertAt: thread.last_emergency_alert_at || null,
      },
    });
  }
}

export async function twilioSmsHandler(c: Context<{ Bindings: Bindings }>) {
  try {
    const formData = await c.req.formData();
    const providerMessageId =
      ((formData.get('MessageSid') as string) || (formData.get('SmsSid') as string) || '').trim();

    if (await hasExistingMessageSid(c.env, providerMessageId)) {
      d1Log.log('Duplicate MessageSid ignored', {
        context: {
          handler: 'twilioSmsHandler',
          messageSid: providerMessageId,
        },
      });
      return respondWithEmptyTwiml(c);
    }

    await ensureSwitchboardSchema(c.env);
    await ensureCustomerMissedCallSchema(c.env.SYSTEMIX);

    const params = formDataToParams(formData);
    const from = ((formData.get('From') as string) || '').trim();
    const to = ((formData.get('To') as string) || '').trim();
    const body = ((formData.get('Body') as string) || '').trim();
    const inboundFrom = normalizePhone(from) || from || 'unknown';
    const inboundTo = normalizePhone(to) || to || 'unknown';

    if (
      await hasRecentInboundMessageDuplicate(
        c.env,
        inboundFrom,
        inboundTo,
        body,
        INBOUND_SMS_DEDUP_WINDOW_SECONDS
      )
    ) {
      d1Log.log('Duplicate inbound SMS ignored', {
        context: {
          handler: 'twilioSmsHandler',
          messageSid: providerMessageId || null,
          fromNumber: inboundFrom,
          toNumber: inboundTo,
        },
        data: {
          reason: 'phone_body_time_window',
          windowSeconds: INBOUND_SMS_DEDUP_WINDOW_SECONDS,
        },
      });
      return respondWithEmptyTwiml(c);
    }

    const sig = await checkTwilioSignature(
      c.env,
      c.req.url,
      params,
      c.req.header('X-Twilio-Signature') || undefined
    );
    if (!sig.ok) {
      twilioLog.error('Twilio SMS signature rejected and request processing continued', {
        context: {
          handler: 'twilioSmsHandler',
          messageSid: providerMessageId,
          fromNumber: inboundFrom,
          toNumber: inboundTo,
        },
        data: {
          mode: sig.mode,
          reason: sig.reason,
        },
      });
    }

    const businessContext = await resolveBusinessContext(c.env, inboundTo);
    const resolvedBusinessNumber = businessContext?.businessNumber || inboundTo;
    const ownerPhone = businessContext?.ownerPhone || '';
    const isForcedTestLead = body.toUpperCase().includes('TEST LEAD');
    const shouldTrackMissedCallReply =
      !!businessContext && (!ownerPhone || !phonesEqual(inboundFrom, ownerPhone) || isForcedTestLead);
    const replyTrackingTasks = shouldTrackMissedCallReply
      ? [
          buildMissedCallReplyTrackingTask({
            env: c.env,
            businessNumber: resolvedBusinessNumber,
            customerNumber: inboundFrom,
            body,
            providerMessageId,
          }),
        ]
      : [];
    const complianceAction = resolveInboundSmsComplianceAction(body);

    const rawJson = JSON.stringify({
      source: 'twilio_sms_webhook',
      from: inboundFrom,
      to: inboundTo,
      body,
      providerMessageId,
      form: params,
      route: complianceAction ? 'compliance_gate' : 'sms_router',
      complianceAction,
    });

    const twilioClient = createTwilioRestClient(c.env);
    if (!twilioClient) {
      return c.json({ ok: false, error: 'missing_twilio_credentials' }, 200);
    }

    if (complianceAction) {
      scheduleSettledBackgroundTasks(
        c.executionCtx,
        [
          ...buildComplianceCommandBackgroundTasks({
            env: c.env,
            twilioClient,
            action: complianceAction,
            businessNumber: resolvedBusinessNumber,
            displayName: businessContext?.displayName || '',
            inboundFrom,
            inboundTo,
            body,
            providerMessageId,
            rawJson,
          }),
          ...replyTrackingTasks,
        ]
      );

      return respondWithEmptyTwiml(c);
    }

    const directGtmCommand = parseOwnerCommand(body);
    if (
      directGtmCommand &&
      isGtmApprovalOwnerCommand(directGtmCommand) &&
      isDirectGtmOperatorPhone(inboundFrom)
    ) {
      const savedInbound = await saveInboundSms(c.env, inboundFrom, inboundTo, body, providerMessageId, rawJson);
      if (!savedInbound.saved) {
        return respondWithEmptyTwiml(c);
      }

      const commandResult = await handleOwnerCommand({
        env: c.env,
        command: directGtmCommand,
        businessNumber: inboundTo,
        ownerPhone: inboundFrom,
        inboundBody: body,
        providerMessageId,
        twilioClient,
      });

      if (!commandResult.ok) {
        return c.json({ ok: false, error: 'owner_command_failed', command: directGtmCommand.type }, 200);
      }

      return c.json(
        {
          ok: true,
          mode: 'owner_proxy',
          handledAs: 'owner_command',
          command: commandResult.command,
          responseDelivery: commandResult.responseDelivery,
          responseSid: commandResult.responseSid,
        },
        200
      );
    }

    const route: 'owner_proxy' | 'customer_analysis' =
      ownerPhone && phonesEqual(inboundFrom, ownerPhone) && !isForcedTestLead
        ? 'owner_proxy'
        : 'customer_analysis';

    if (!businessContext) {
      scheduleSettledBackgroundTasks(
        c.executionCtx,
        buildUnknownBusinessBackgroundTasks({
          env: c.env,
          inboundFrom,
          inboundTo,
          body,
          providerMessageId,
          route,
          rawParams: params,
          rawJson,
        })
      );

      return respondWithEmptyTwiml(c);
    }

    if (!ownerPhone) {
      scheduleSettledBackgroundTasks(
        c.executionCtx,
        [
          ...buildMissingOwnerMappingBackgroundTasks({
            env: c.env,
            inboundFrom,
            inboundTo,
            body,
            providerMessageId,
            rawJson,
            businessNumber: businessContext.businessNumber,
          }),
          ...replyTrackingTasks,
        ]
      );
      return respondWithEmptyTwiml(c);
    }

    const activeBusinessNumber = businessContext.businessNumber;

    if (isForcedTestLead) {
      scheduleSettledBackgroundTasks(
        c.executionCtx,
        [
          ...buildForcedLeadBackgroundTasks({
            env: c.env,
            businessNumber: activeBusinessNumber,
            customerNumber: inboundFrom,
            body,
            inboundTo,
            providerMessageId,
            rawJson,
          }),
          ...replyTrackingTasks,
        ]
      );

      return respondWithEmptyTwiml(c);
    }

    if (route === 'owner_proxy') {
      if (!ownerPhone) {
        return c.json({ ok: false, error: 'missing_owner_phone_number' }, 200);
      }

      const savedInbound = await saveInboundSms(c.env, inboundFrom, inboundTo, body, providerMessageId, rawJson);
      if (!savedInbound.saved) {
        return respondWithEmptyTwiml(c);
      }

      const command = parseOwnerCommand(body);
      if (command) {
        const commandResult = await handleOwnerCommand({
          env: c.env,
          command,
          businessNumber: activeBusinessNumber,
          ownerPhone,
          inboundBody: body,
          providerMessageId,
          twilioClient,
        });

        if (!commandResult.ok) {
          return c.json({ ok: false, error: 'owner_command_failed', command: command.type }, 200);
        }

        return c.json(
          {
            ok: true,
            mode: 'owner_proxy',
            handledAs: 'owner_command',
            command: commandResult.command,
            responseDelivery: commandResult.responseDelivery,
            responseSid: commandResult.responseSid,
          },
          200
        );
      }

      const relayResult = await handleOwnerRelay({
        env: c.env,
        businessNumber: activeBusinessNumber,
        ownerPhone,
        inboundBody: body,
        providerMessageId,
        twilioClient,
      });

      if (!relayResult.ok) {
        return c.json({ ok: false, error: 'owner_relay_failed' }, 200);
      }

      return c.json(
        {
          ok: true,
          mode: 'owner_proxy',
          handledAs: 'owner_relay',
          forwardedSid: relayResult.forwardedSid || null,
          confirmationSid: relayResult.confirmationSid || null,
        },
        200
      );
    }

    const pauseState = ownerPhone
      ? await getOwnerAlertPauseState(c.env, activeBusinessNumber, ownerPhone)
      : {
          isPaused: false,
          alertsPausedUntil: null,
          pauseColumnAvailable: true,
        };

    const ownerAlertEligible = !pauseState.isPaused;

    if (!ownerAlertEligible) {
      twilioLog.log('Owner alert skipped because alerts are paused', {
        context: {
          handler: 'twilioSmsHandler',
          messageSid: providerMessageId,
          fromNumber: resolvedBusinessNumber,
          toNumber: ownerPhone,
        },
        data: {
          alertsPausedUntil: pauseState.alertsPausedUntil || 'unknown',
        },
      });
    }

    scheduleSettledBackgroundTasks(
      c.executionCtx,
      [
        ...buildCustomerAnalysisBackgroundTasks({
          env: c.env,
          twilioClient,
          businessNumber: activeBusinessNumber,
          ownerPhone,
          displayName: businessContext.displayName,
          customerNumber: inboundFrom,
          inboundTo,
          body,
          providerMessageId,
          rawJson,
          ownerAlertEligible,
        }),
        ...replyTrackingTasks,
      ]
    );

    twilioLog.log('Returning empty SMS TwiML', {
      context: {
        handler: 'twilioSmsHandler',
        messageSid: providerMessageId || null,
        fromNumber: resolvedBusinessNumber,
        toNumber: inboundFrom,
      },
    });

    return respondWithEmptyTwiml(c);
  } catch (error) {
    twilioLog.error('Twilio SMS handler failed', {
      error,
      context: {
        handler: 'twilioSmsHandler',
      },
    });
    return c.json({ ok: false, error: 'processing_failed' }, 200);
  }
}
