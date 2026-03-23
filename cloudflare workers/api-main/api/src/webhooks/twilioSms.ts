import { Context } from 'hono';
import { checkTwilioSignature, formDataToParams } from '../core/twilioSignature';
import { syncToHubspot as syncHubspotContact } from '../services/hubspot';
import {
  buildLeadSummary,
  classifyLeadIntent,
  type AiLeadClassification,
} from '../services/openai';

type Bindings = {
  SYSTEMIX: D1Database;
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
  source: 'keyword_emergency' | 'keyword_standard' | 'gpt' | 'gpt_fallback';
  gptUsed: boolean;
  keywordMatcherMs: number;
  gptClassifierMs: number;
};

type TriageCoreResult = Omit<TriageResult, 'keywordMatcherMs' | 'gptClassifierMs'>;

type BusinessContext = {
  businessNumber: string;
  ownerPhone: string;
};

type TwilioRestClient = {
  sendSms: (
    input: { toPhone: string; fromPhone: string; body: string }
  ) => Promise<{ ok: boolean; sid?: string; detail?: string }>;
};

const PROVIDER = 'twilio';
const ALERT_DEDUP_WINDOW_MS = 10 * 60 * 1000;
const ACTIVE_THREAD_WINDOW_MS = 5 * 60 * 1000;
const MAX_SMS_BODY = 1500;
const OWNER_THREAD_PREFIX = 'owner:';
const LINE_STATE_SENTINEL = '__line_state__';
const FORCED_HUBSPOT_SYNC_CUSTOMER = '+18443217137';
const FORCED_HUBSPOT_SYNC_BUSINESS = '+18443217137';
const CUSTOMER_EMERGENCY_CONFIRMATION =
  'We have flagged this as an emergency and the team has been notified. Someone will be in contact with you shortly.';
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

async function classifyCustomerMessage(messageBody: string, apiKey?: string): Promise<TriageResult> {
  const keywordStartMs = nowMs();
  const normalized = messageBody.toLowerCase();
  const emergencyHit = EMERGENCY_KEYWORDS.some((keyword) => containsKeyword(normalized, keyword));
  const clearStandardHit = !emergencyHit && isClearStandardMessage(messageBody);
  const keywordMatcherMs = roundMs(nowMs() - keywordStartMs);

  if (emergencyHit) {
    return {
      classification: 'emergency',
      aiClassification: 'emergency',
      summary: buildLeadSummary('emergency', messageBody),
      confidence: 'high',
      source: 'keyword_emergency',
      gptUsed: false,
      keywordMatcherMs,
      gptClassifierMs: 0,
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

function createTwilioRestClient(env: Bindings): TwilioRestClient | null {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    return null;
  }

  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authHeader = `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`;

  return {
    async sendSms(input: {
      toPhone: string;
      fromPhone: string;
      body: string;
    }): Promise<{ ok: boolean; sid?: string; detail?: string }> {
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: input.toPhone,
          From: input.fromPhone,
          Body: input.body,
        }).toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { ok: false, detail: `twilio_sms_failed_${response.status}:${errorText}` };
      }

      const payload = (await response.json()) as { sid?: string };
      return { ok: true, sid: payload.sid };
    },
  };
}

async function saveInboundSms(
  env: Bindings,
  fromPhone: string,
  toPhone: string,
  body: string,
  providerMessageId: string,
  rawJson: string
): Promise<{ saved: boolean }> {
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

    return { saved: true };
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

  return { saved: Number(insert.meta?.changes || 0) > 0 };
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
      SELECT business_number, owner_phone_number
      FROM businesses
      WHERE business_number = ?
        AND is_active = 1
      LIMIT 1
    `
    )
    .bind(normalizedTo)
    .first<{ business_number?: string; owner_phone_number?: string | null }>();

  if (!businessRow?.business_number) {
    return null;
  }

  return {
    businessNumber: normalizePhone(businessRow.business_number) || normalizedTo,
    ownerPhone: normalizePhone(businessRow.owner_phone_number || ''),
  };
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
      console.warn('[PAUSE CHECK] alerts_paused_until column missing on businesses table');
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
    console.warn(`[COLLISION WARNING] Owner ${ownerPhone} has ${activeThreads.length} active threads`);
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
  | { type: 'STATUS' };

function parseOwnerCommand(messageBody: string): OwnerCommand | null {
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

  return null;
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
}): Promise<{ ok: boolean; command: string; responseSid: string | null }> {
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

  const sendResult = await input.twilioClient.sendSms({
    toPhone: input.ownerPhone,
    fromPhone: input.businessNumber,
    body: sanitizeForSms(responseBody),
  });

  if (!sendResult.ok) {
    console.error('Owner command response failed', {
      command: input.command.type,
      detail: sendResult.detail || 'unknown',
      owner: maskPhone(input.ownerPhone),
    });
    return { ok: false, command: input.command.type, responseSid: null };
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

  return { ok: true, command: input.command.type, responseSid: sendResult.sid || null };
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

    if (ownerReply.ok) {
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

    return { ok: true, mode: 'owner_relay', confirmationSid: ownerReply.sid || null };
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

    if (ownerReply.ok) {
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

    return { ok: true, mode: 'owner_relay', confirmationSid: ownerReply.sid || null };
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
    body: sanitizeForSms(forwardBody),
  });

  if (!forwarded.ok) {
    console.error('Owner relay forwarding failed', {
      to: maskPhone(recipient),
      detail: forwarded.detail || 'unknown',
    });
    return {
      ok: false,
      mode: 'owner_relay',
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
    console.error('Owner relay confirmation failed', {
      owner: maskPhone(input.ownerPhone),
      detail: ownerConfirmation.detail || 'unknown',
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
    console.error('HubSpot lead sync failed', {
      business: maskPhone(input.businessNumber),
      customer: maskPhone(input.customerNumber),
      error: error instanceof Error ? error.message : String(error),
    });
    return { synced: false, reason: 'sync_failed' };
  }
}

async function handleCustomerInbound(input: {
  env: Bindings;
  twilioClient: TwilioRestClient;
  businessNumber: string;
  ownerPhone: string;
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

  console.log('Switchboard Trace: classification timing', {
    messageId: input.providerMessageId || null,
    business: maskPhone(input.businessNumber),
    customer: maskPhone(input.customerNumber),
    keywordMatcherMs: triage.keywordMatcherMs,
    gptClassifierMs: triage.gptClassifierMs,
    gptUsed: triage.gptUsed,
    classification: triage.aiClassification,
    routingClassification: triage.classification,
    summary: triage.summary,
    confidence: triage.confidence,
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

    if (input.executionCtx?.waitUntil) {
      input.executionCtx.waitUntil(
        syncToHubspot(customerPhone, classification, summary)
          .then(() => console.log('[HUBSPOT] SUCCESS'))
          .catch((error) => console.log('[HUBSPOT] FAILED: ', error))
      );
    } else {
      void syncToHubspot(customerPhone, classification, summary)
        .then(() => console.log('[HUBSPOT] SUCCESS'))
        .catch((error) => console.log('[HUBSPOT] FAILED: ', error));
    }
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
      console.log(
        `[PAUSED] Skipping alert for ${input.ownerPhone} - paused until ${pauseState.alertsPausedUntil || 'unknown'}`
      );

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

    const ownerAlertBody = `New text reply from ${input.customerNumber}: ${input.body}`;
    const ownerSms = await input.twilioClient.sendSms({
      toPhone: input.ownerPhone,
      fromPhone: input.businessNumber,
      body: sanitizeForSms(ownerAlertBody),
    });

    if (!ownerSms.ok) {
      console.error('Standard owner alert failed', {
        customer: maskPhone(input.customerNumber),
        detail: ownerSms.detail || 'unknown',
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

    console.log('[TWILIO] OWNER ALERT', {
      sid: ownerSms.sid || null,
      to: maskPhone(input.ownerPhone),
      from: maskPhone(input.businessNumber),
      classification: triage.aiClassification,
      summary: triage.summary,
    });

    queueHubspotSync(triage.aiClassification, triage.summary);

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

    return {
      ok: true,
      mode: 'customer_analysis',
      routingClassification: 'standard',
      aiClassification: triage.aiClassification,
      summary: triage.summary,
      confidence: triage.confidence,
      gptUsed: triage.gptUsed,
      ownerAlertSid: ownerSms.sid || null,
    };
  }

  const isDeduped = await hasRecentEmergencyAlert(input.env, input.businessNumber, input.customerNumber);
  const inboundClassification: TriageLabel = isDeduped
    ? 'emergency_suppressed'
    : triage.confidence === 'high'
      ? 'emergency'
      : 'possible_emergency';

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

  const customerReply = await input.twilioClient.sendSms({
    toPhone: input.customerNumber,
    fromPhone: input.businessNumber,
    body: CUSTOMER_EMERGENCY_CONFIRMATION,
  });

  if (!customerReply.ok) {
    console.error('Customer emergency confirmation failed', {
      customer: maskPhone(input.customerNumber),
      detail: customerReply.detail || 'unknown',
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

  console.log('[TWILIO] CUSTOMER CONFIRMATION', {
    sid: customerReply.sid || null,
    to: maskPhone(input.customerNumber),
    from: maskPhone(input.businessNumber),
    classification: triage.aiClassification,
    summary: triage.summary,
  });

  await saveOutboundSms(
    input.env,
    customerReply.sid || '',
    input.businessNumber,
    input.customerNumber,
    CUSTOMER_EMERGENCY_CONFIRMATION,
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
    messageBody: CUSTOMER_EMERGENCY_CONFIRMATION,
    classification: inboundClassification,
    confidence: triage.confidence,
    metadata: {
      target: 'customer_confirmation',
      deduped: isDeduped,
    },
  });

  if (isDeduped) {
    return {
      ok: true,
      mode: 'customer_analysis',
      routingClassification: inboundClassification,
      aiClassification: triage.aiClassification,
      summary: triage.summary,
      confidence: triage.confidence,
      gptUsed: triage.gptUsed,
      customerReplySid: customerReply.sid || null,
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
      customerReplySid: customerReply.sid || null,
    };
  }

  const hasMultipleActiveThreads = await hasConcurrentActiveEmergencyThread(
    input.env,
    input.businessNumber,
    input.customerNumber
  );

  const baseOwnerAlertBody =
    triage.confidence === 'high'
      ? `EMERGENCY ALERT from ${input.customerNumber}: "${input.body}"`
      : `POSSIBLE EMERGENCY from ${input.customerNumber}: "${input.body}" - please verify`;
  const ownerAlertBody = hasMultipleActiveThreads
    ? `${ACTIVE_THREAD_NOTICE} ${baseOwnerAlertBody}`
    : baseOwnerAlertBody;

  if (pauseState.isPaused) {
    console.log(
      `[PAUSED] Skipping alert for ${input.ownerPhone} - paused until ${pauseState.alertsPausedUntil || 'unknown'}`
    );

    return {
      ok: true,
      mode: 'customer_analysis',
      routingClassification: inboundClassification,
      aiClassification: triage.aiClassification,
      summary: triage.summary,
      confidence: triage.confidence,
      gptUsed: triage.gptUsed,
      customerReplySid: customerReply.sid || null,
      ownerAlertSid: null,
    };
  }

  const ownerAlert = await input.twilioClient.sendSms({
    toPhone: input.ownerPhone,
    fromPhone: input.businessNumber,
    body: sanitizeForSms(ownerAlertBody),
  });

  if (!ownerAlert.ok) {
    console.error('Emergency owner alert failed', {
      customer: maskPhone(input.customerNumber),
      detail: ownerAlert.detail || 'unknown',
    });

    return {
      ok: false,
      mode: 'customer_analysis',
      routingClassification: inboundClassification,
      aiClassification: triage.aiClassification,
      summary: triage.summary,
      confidence: triage.confidence,
      gptUsed: triage.gptUsed,
      customerReplySid: customerReply.sid || null,
    };
  }

  console.log('[TWILIO] OWNER ALERT', {
    sid: ownerAlert.sid || null,
    to: maskPhone(input.ownerPhone),
    from: maskPhone(input.businessNumber),
    classification: triage.aiClassification,
    summary: triage.summary,
  });

  queueHubspotSync(triage.aiClassification, triage.summary);

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

  const ownerAlertClassification: TriageLabel = triage.confidence === 'high' ? 'emergency' : 'possible_emergency';

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

  return {
    ok: true,
    mode: 'customer_analysis',
    routingClassification: inboundClassification,
    aiClassification: triage.aiClassification,
    summary: triage.summary,
    confidence: triage.confidence,
    gptUsed: triage.gptUsed,
    customerReplySid: customerReply.sid || null,
    ownerAlertSid: ownerAlert.sid || null,
  };
}

export async function checkEmergencyTimeouts(env: Bindings): Promise<void> {
  await ensureSwitchboardSchema(env);

  const twilioClient = createTwilioRestClient(env);
  if (!twilioClient) {
    console.error('Emergency timeout check skipped: missing Twilio credentials');
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
      body: EMERGENCY_TIMEOUT_MESSAGE,
    });

    if (!timeoutReply.ok) {
      console.error('Emergency timeout auto-reply failed', {
        business: maskPhone(businessNumber),
        customer: maskPhone(customerNumber),
        detail: timeoutReply.detail || 'unknown',
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
    await ensureSwitchboardSchema(c.env);

    const formData = await c.req.formData();
    const params = formDataToParams(formData);

    const sig = await checkTwilioSignature(
      c.env,
      c.req.url,
      params,
      c.req.header('X-Twilio-Signature') || undefined
    );
    if (!sig.ok) {
      console.error('Twilio SMS signature rejected (continuing)', { mode: sig.mode, reason: sig.reason });
    }

    const from = ((formData.get('From') as string) || '').trim();
    const to = ((formData.get('To') as string) || '').trim();
    const body = ((formData.get('Body') as string) || '').trim();
    const providerMessageId =
      ((formData.get('MessageSid') as string) || (formData.get('SmsSid') as string) || '').trim();

    const inboundFrom = normalizePhone(from) || from || 'unknown';
    const inboundTo = normalizePhone(to) || to || 'unknown';
    const businessContext = await resolveBusinessContext(c.env, inboundTo);
    const ownerPhone = businessContext?.ownerPhone || '';
    const isForcedTestLead = body.toUpperCase().includes('TEST LEAD');
    const route: 'owner_proxy' | 'customer_analysis' = ownerPhone && phonesEqual(inboundFrom, ownerPhone) && !isForcedTestLead
      ? 'owner_proxy'
      : 'customer_analysis';

    const rawJson = JSON.stringify({
      source: 'twilio_sms_webhook',
      route,
      from: inboundFrom,
      to: inboundTo,
      body,
      providerMessageId,
      isForcedTestLead,
      form: params,
    });

    const savedInbound = await saveInboundSms(c.env, inboundFrom, inboundTo, body, providerMessageId, rawJson);
    if (!savedInbound.saved) {
      return c.json({ ok: true, deduped: true }, 200);
    }

    if (!businessContext) {
      await handleUnknownBusinessLine({
        env: c.env,
        inboundFrom,
        inboundTo,
        body,
        providerMessageId,
        route,
        rawParams: params,
      });

      return c.json({ ok: false, error: 'unresolved_business_line' }, 200);
    }

    if (!ownerPhone) {
      await logSwitchboardEvent(c.env, 'missing_owner_mapping', {
        businessNumber: businessContext.businessNumber,
        fromNumber: inboundFrom,
        toNumber: inboundTo,
        metadata: {
          reason: 'missing_owner_phone_number_for_business',
          providerMessageId: providerMessageId || null,
        },
      });
      return c.json({ ok: false, error: 'missing_owner_phone_number_for_business' }, 200);
    }

    const resolvedBusinessNumber = businessContext.businessNumber;

    if (isForcedTestLead) {
      c.executionCtx.waitUntil(
        syncLeadToHubspot({
          env: c.env,
          businessNumber: resolvedBusinessNumber,
          customerNumber: inboundFrom,
          summary: buildLeadSummary('inquiry', body),
          classification: 'inquiry',
        })
          .then((result) => {
            if (!result.synced) {
              throw new Error(result.reason || 'sync_failed');
            }
            console.log('[HUBSPOT] SUCCESS');
          })
          .catch((error) => console.log('[HUBSPOT] FAILED: ', error))
      );

      return c.json(
        {
          ok: true,
          mode: 'customer_analysis',
          handledAs: 'forced_test_lead',
          hubspotQueued: true,
        },
        200
      );
    }

    const twilioClient = createTwilioRestClient(c.env);
    if (!twilioClient) {
      return c.json({ ok: false, error: 'missing_twilio_credentials' }, 200);
    }

    if (route === 'owner_proxy') {
      if (!ownerPhone) {
        return c.json({ ok: false, error: 'missing_owner_phone_number' }, 200);
      }

      const command = parseOwnerCommand(body);
      if (command) {
        const commandResult = await handleOwnerCommand({
          env: c.env,
          command,
          businessNumber: resolvedBusinessNumber,
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
            responseSid: commandResult.responseSid,
          },
          200
        );
      }

      const relayResult = await handleOwnerRelay({
        env: c.env,
        businessNumber: resolvedBusinessNumber,
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

    const customerResult = await handleCustomerInbound({
      env: c.env,
      twilioClient,
      businessNumber: resolvedBusinessNumber,
      ownerPhone,
      customerNumber: inboundFrom,
      body,
      providerMessageId,
      executionCtx: c.executionCtx,
    });

    if (!customerResult.ok) {
      return c.json({ ok: false, error: 'customer_analysis_failed' }, 200);
    }

    return c.json(
      {
        ok: true,
        mode: customerResult.mode,
        classification: customerResult.aiClassification,
        routingClassification: customerResult.routingClassification,
        summary: customerResult.summary,
        confidence: customerResult.confidence,
        gptUsed: customerResult.gptUsed,
        customerReplySid: customerResult.customerReplySid || null,
        ownerAlertSid: customerResult.ownerAlertSid || null,
      },
      200
    );
  } catch (error) {
    console.error('Twilio SMS handler error');
    console.error(error);
    return c.json({ ok: false, error: 'processing_failed' }, 200);
  }
}
