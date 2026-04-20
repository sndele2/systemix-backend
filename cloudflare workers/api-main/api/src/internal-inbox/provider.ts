import { createLogger } from '../core/logging.ts';
import { createTwilioRestClient, type TwilioRestClient } from '../core/sms.ts';
import { normalizePhone } from '../services/smsCompliance.ts';

import type {
  InboxConversation,
  InboxConversationEventType,
  InboxConversationMessage,
  InboxConversationSource,
  InboxConversationSummary,
  InternalInboxProvider,
  Result,
} from './types.ts';

interface InternalInboxEnv {
  SYSTEMIX: D1Database;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PHONE_NUMBER?: string;
  SYSTEMIX_NUMBER?: string;
}

interface ConversationKey {
  businessNumber: string;
  customerNumber: string;
}

interface ConversationPairRow {
  business_number?: string;
  customer_number?: string;
}

interface MissedCallRow {
  id?: string;
  business_number?: string;
  phone_number?: string;
  missed_call_timestamp?: string | null;
  sms_sent?: number | string | null;
  sms_content?: string | null;
  reply_received?: number | string | null;
  reply_text?: string | null;
  reply_timestamp?: string | null;
}

interface CallRow {
  id?: string;
  provider_call_id?: string | null;
  created_at?: string | null;
  missed_at?: string | null;
  transcription?: string | null;
  recording_url?: string | null;
  customer_welcome_sent_at?: string | null;
  customer_welcome_message_id?: string | null;
}

interface MessageRow {
  id?: string;
  created_at?: string | null;
  direction?: string | null;
  provider_message_id?: string | null;
  body?: string | null;
  raw_json?: string | null;
}

interface ActiveSessionRow {
  status?: string | null;
  last_activity_at?: string | null;
}

interface ComputedConversation {
  id: string;
  businessNumber: string;
  customerNumber: string;
  source: InboxConversationSource;
  preview: string;
  updatedAt: string;
  messages: InboxConversationMessage[];
}

interface ParsedMessageMetadata {
  source: string | null;
  timestamp: string | null;
}

const inboxLog = createLogger('[D1]', 'provider');
const LINE_STATE_SENTINEL = '__line_state__';

function succeed<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T = never>(error: string): Result<T> {
  return { ok: false, error };
}

function isTruthyNumber(value: number | string | null | undefined): boolean {
  return Number(value || 0) === 1;
}

function trimText(value: string | null | undefined): string {
  return (value || '').trim();
}

function normalizeTimestamp(value: string | null | undefined): string {
  const trimmed = trimText(value);
  if (!trimmed) {
    return new Date(0).toISOString();
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return trimmed;
  }

  return new Date(parsed).toISOString();
}

function compareTimestamps(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function buildPreview(body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (compact.length <= 160) {
    return compact;
  }

  return `${compact.slice(0, 157).trimEnd()}...`;
}

function buildMissedCallBody(customerNumber: string): string {
  return `Missed call detected from ${customerNumber}.`;
}

function buildVoicemailBody(transcription: string | null | undefined): string {
  const normalizedTranscription = trimText(transcription);
  if (!normalizedTranscription || normalizedTranscription === 'Voice message received') {
    return 'Voicemail received.';
  }

  return normalizedTranscription;
}

function parseMessageMetadata(rawJson: string | null | undefined): ParsedMessageMetadata {
  const trimmed = trimText(rawJson);
  if (!trimmed) {
    return {
      source: null,
      timestamp: null,
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as { source?: unknown; timestamp?: unknown };
    return {
      source: typeof parsed.source === 'string' ? parsed.source : null,
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : null,
    };
  } catch {
    return {
      source: null,
      timestamp: null,
    };
  }
}

function classifyOutboundMessageType(source: string | null): InboxConversationEventType {
  if (source === 'owner_relay_forward' || source === 'internal_inbox_operator_reply') {
    return 'operator';
  }

  return 'system';
}

function toMessageTimestamp(row: MessageRow): string {
  const metadata = parseMessageMetadata(row.raw_json);
  return normalizeTimestamp(metadata.timestamp || row.created_at);
}

export function createInternalInboxConversationId(businessNumber: string, customerNumber: string): string {
  return `${businessNumber}:${customerNumber}`;
}

function parseConversationId(conversationId: string): Result<ConversationKey> {
  const trimmedId = conversationId.trim();
  if (!trimmedId) {
    return fail('Conversation id is required');
  }

  const separatorIndex = trimmedId.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= trimmedId.length - 1) {
    return fail('Invalid conversation id');
  }

  const businessNumber = normalizePhone(trimmedId.slice(0, separatorIndex));
  const customerNumber = normalizePhone(trimmedId.slice(separatorIndex + 1));
  if (!businessNumber || !customerNumber) {
    return fail('Invalid conversation id');
  }

  return succeed({
    businessNumber,
    customerNumber,
  });
}

async function upsertActiveSession(
  db: D1Database,
  key: ConversationKey,
  conversationId: string,
  timestamp: string
): Promise<void> {
  try {
    await db
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
          thread_id = COALESCE(active_sessions.thread_id, excluded.thread_id),
          status = 'active',
          updated_at = excluded.updated_at,
          last_activity_at = excluded.last_activity_at,
          ended_at = NULL
      `
      )
      .bind(
        crypto.randomUUID(),
        key.businessNumber,
        key.customerNumber,
        conversationId,
        timestamp,
        timestamp,
        timestamp
      )
      .run();
  } catch (error) {
    inboxLog.warn('Failed to update active session for internal inbox reply', {
      error,
      context: {
        handler: 'upsertActiveSession',
        fromNumber: key.businessNumber,
        toNumber: key.customerNumber,
      },
    });
  }
}

export class D1InternalInboxProvider implements InternalInboxProvider {
  private readonly env: InternalInboxEnv;
  private readonly twilioClient: TwilioRestClient | null;

  constructor(env: InternalInboxEnv, twilioClient: TwilioRestClient | null = null) {
    this.env = env;
    this.twilioClient =
      twilioClient ||
      (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
        ? createTwilioRestClient({
            SYSTEMIX: env.SYSTEMIX,
            TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
            TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
            TWILIO_PHONE_NUMBER: env.TWILIO_PHONE_NUMBER,
            SYSTEMIX_NUMBER: env.SYSTEMIX_NUMBER,
          })
        : null);
  }

  async listConversations(
    scopedBusinessNumber: string,
    limit: number
  ): Promise<Result<InboxConversationSummary[]>> {
    try {
      const rows = await this.env.SYSTEMIX.prepare(
        `
        WITH conversation_pairs AS (
          SELECT business_number, phone_number AS customer_number, MAX(COALESCE(reply_timestamp, missed_call_timestamp)) AS activity_at
          FROM missed_call_conversations
          WHERE business_number = ?
          GROUP BY business_number, phone_number
          UNION
          SELECT business_number, customer_number, MAX(last_activity_at) AS activity_at
          FROM active_sessions
          WHERE customer_number != ?
            AND business_number = ?
          GROUP BY business_number, customer_number
        )
        SELECT business_number, customer_number, MAX(activity_at) AS updated_at
        FROM conversation_pairs
        GROUP BY business_number, customer_number
        ORDER BY updated_at DESC
        LIMIT ?
      `
      )
        .bind(scopedBusinessNumber, LINE_STATE_SENTINEL, scopedBusinessNumber, limit)
        .all<ConversationPairRow>();

      const summaries = await Promise.all(
        (rows.results || []).map(async (row) => {
          const businessNumber = normalizePhone(row.business_number || '');
          const customerNumber = normalizePhone(row.customer_number || '');
          if (!businessNumber || !customerNumber) {
            return null;
          }

          const conversation = await this.loadComputedConversation({
            businessNumber,
            customerNumber,
          });

          if (conversation === null) {
            return null;
          }

          return {
            id: conversation.id,
            businessNumber: conversation.businessNumber,
            contact: {
              phoneNumber: conversation.customerNumber,
            },
            source: conversation.source,
            preview: conversation.preview,
            updatedAt: conversation.updatedAt,
          } satisfies InboxConversationSummary;
        })
      );

      return succeed(
        summaries
          .filter((summary): summary is InboxConversationSummary => summary !== null)
          .sort((left, right) => compareTimestamps(right.updatedAt, left.updatedAt))
          .slice(0, limit)
      );
    } catch (error) {
      inboxLog.error('Failed to list internal inbox conversations', {
        error,
        context: {
          handler: 'listConversations',
        },
      });
      return fail('Failed to load inbox conversations');
    }
  }

  async getConversation(
    scopedBusinessNumber: string,
    conversationId: string
  ): Promise<Result<InboxConversation | null>> {
    const keyResult = parseConversationId(conversationId);
    if (!keyResult.ok) {
      return keyResult;
    }

    if (keyResult.value.businessNumber !== normalizePhone(scopedBusinessNumber)) {
      return succeed(null);
    }

    try {
      const conversation = await this.loadComputedConversation(keyResult.value);
      if (conversation === null) {
        return succeed(null);
      }

      return succeed({
        id: conversation.id,
        businessNumber: conversation.businessNumber,
        contact: {
          phoneNumber: conversation.customerNumber,
        },
        source: conversation.source,
        updatedAt: conversation.updatedAt,
        messages: conversation.messages,
      });
    } catch (error) {
      inboxLog.error('Failed to load internal inbox conversation', {
        error,
        context: {
          handler: 'getConversation',
          fromNumber: keyResult.value.businessNumber,
          toNumber: keyResult.value.customerNumber,
        },
      });
      return fail('Failed to load inbox conversation');
    }
  }

  async replyToConversation(
    scopedBusinessNumber: string,
    conversationId: string,
    body: string
  ): Promise<Result<void>> {
    const keyResult = parseConversationId(conversationId);
    if (!keyResult.ok) {
      return keyResult;
    }

    if (keyResult.value.businessNumber !== normalizePhone(scopedBusinessNumber)) {
      return fail('Conversation not found');
    }

    const conversationExists = await this.hasConversation(keyResult.value);
    if (!conversationExists) {
      return fail('Conversation not found');
    }

    if (this.twilioClient === null) {
      return fail('missing_twilio_credentials');
    }

    try {
      const sendResult = await this.twilioClient.sendSms({
        toPhone: keyResult.value.customerNumber,
        fromPhone: keyResult.value.businessNumber,
        businessNumber: keyResult.value.businessNumber,
        body: trimText(body),
      });

      if (!sendResult.ok) {
        return fail(sendResult.detail || 'sms_failed');
      }

      if (sendResult.suppressed) {
        return fail('Reply suppressed because recipient cannot receive SMS');
      }

      const timestamp = new Date().toISOString();
      const rawJson = JSON.stringify({
        source: 'internal_inbox_operator_reply',
        conversationId,
        business_number: keyResult.value.businessNumber,
        customer_number: keyResult.value.customerNumber,
        timestamp,
      });

      await this.env.SYSTEMIX.prepare(
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
      `
      )
        .bind(
          crypto.randomUUID(),
          'twilio',
          sendResult.sid || null,
          keyResult.value.businessNumber,
          keyResult.value.customerNumber,
          trimText(body),
          rawJson
        )
        .run();

      await upsertActiveSession(this.env.SYSTEMIX, keyResult.value, conversationId, timestamp);

      return succeed(undefined);
    } catch (error) {
      inboxLog.error('Failed to send internal inbox reply', {
        error,
        context: {
          handler: 'replyToConversation',
          fromNumber: keyResult.value.businessNumber,
          toNumber: keyResult.value.customerNumber,
        },
      });
      return fail('Failed to send operator reply');
    }
  }

  private async hasConversation(key: ConversationKey): Promise<boolean> {
    const row = await this.env.SYSTEMIX.prepare(
      `
      SELECT 1 AS found
      FROM (
        SELECT business_number, phone_number AS customer_number
        FROM missed_call_conversations
        UNION
        SELECT business_number, customer_number
        FROM active_sessions
        WHERE customer_number != ?
      )
      WHERE business_number = ?
        AND customer_number = ?
      LIMIT 1
    `
    )
      .bind(LINE_STATE_SENTINEL, key.businessNumber, key.customerNumber)
      .first<{ found?: number }>();

    return Number(row?.found || 0) === 1;
  }

  private async loadComputedConversation(key: ConversationKey): Promise<ComputedConversation | null> {
    const [missedCalls, calls, messages, activeSession] = await Promise.all([
      this.loadMissedCalls(key),
      this.loadCalls(key),
      this.loadMessages(key),
      this.loadActiveSession(key),
    ]);

    const timeline: InboxConversationMessage[] = [];
    const inboundBodies = new Set(
      messages
        .filter((row) => trimText(row.direction) === 'inbound')
        .map((row) => trimText(row.body).toLowerCase())
        .filter((body) => body.length > 0)
    );

    const autoTextTimestamps = calls
      .map((row) => normalizeTimestamp(row.customer_welcome_sent_at))
      .filter((timestamp) => timestamp !== new Date(0).toISOString())
      .sort(compareTimestamps);

    let autoTextIndex = 0;
    for (const row of missedCalls) {
      const missedAt = normalizeTimestamp(row.missed_call_timestamp);
      timeline.push({
        id: `missed-call:${trimText(row.id) || crypto.randomUUID()}`,
        type: 'system',
        source: 'missed_call',
        body: buildMissedCallBody(key.customerNumber),
        timestamp: missedAt,
        rawProviderId: trimText(row.id) || null,
      });

      if (isTruthyNumber(row.sms_sent) && trimText(row.sms_content)) {
        timeline.push({
          id: `auto-text:${trimText(row.id) || crypto.randomUUID()}`,
          type: 'system',
          source: 'sms',
          body: trimText(row.sms_content),
          timestamp: autoTextTimestamps[autoTextIndex] || missedAt,
          rawProviderId: null,
        });
        autoTextIndex += 1;
      }

      const replyText = trimText(row.reply_text);
      if (
        isTruthyNumber(row.reply_received) &&
        replyText &&
        !inboundBodies.has(replyText.toLowerCase())
      ) {
        timeline.push({
          id: `reply-fallback:${trimText(row.id) || crypto.randomUUID()}`,
          type: 'customer',
          source: 'sms',
          body: replyText,
          timestamp: normalizeTimestamp(row.reply_timestamp || row.missed_call_timestamp),
          rawProviderId: null,
        });
      }
    }

    for (const row of calls) {
      if (!trimText(row.transcription) && !trimText(row.recording_url)) {
        continue;
      }

      timeline.push({
        id: `voicemail:${trimText(row.id) || trimText(row.provider_call_id) || crypto.randomUUID()}`,
        type: 'system',
        source: 'voicemail',
        body: buildVoicemailBody(row.transcription),
        timestamp: normalizeTimestamp(row.created_at || row.missed_at),
        rawProviderId: trimText(row.provider_call_id) || null,
      });
    }

    for (const row of messages) {
      const metadata = parseMessageMetadata(row.raw_json);
      const direction = trimText(row.direction);
      const isInbound = direction === 'inbound';

      timeline.push({
        id: `message:${trimText(row.id) || crypto.randomUUID()}`,
        type: isInbound ? 'customer' : classifyOutboundMessageType(metadata.source),
        source: 'sms',
        body: trimText(row.body) || '[SMS]',
        timestamp: toMessageTimestamp(row),
        rawProviderId: trimText(row.provider_message_id) || null,
      });
    }

    timeline.sort((left, right) => compareTimestamps(left.timestamp, right.timestamp));

    if (timeline.length === 0) {
      const lastActivityAt = normalizeTimestamp(activeSession?.last_activity_at);
      if (lastActivityAt === new Date(0).toISOString()) {
        return null;
      }

      timeline.push({
        id: `active-session:${key.businessNumber}:${key.customerNumber}`,
        type: 'system',
        source: 'sms',
        body: 'Conversation active.',
        timestamp: lastActivityAt,
        rawProviderId: null,
      });
    }

    const latestMessage = timeline[timeline.length - 1];
    return {
      id: createInternalInboxConversationId(key.businessNumber, key.customerNumber),
      businessNumber: key.businessNumber,
      customerNumber: key.customerNumber,
      source: latestMessage.source,
      preview: buildPreview(latestMessage.body),
      updatedAt: latestMessage.timestamp,
      messages: timeline,
    };
  }

  private async loadMissedCalls(key: ConversationKey): Promise<MissedCallRow[]> {
    const rows = await this.env.SYSTEMIX.prepare(
      `
      SELECT
        id,
        business_number,
        phone_number,
        missed_call_timestamp,
        sms_sent,
        sms_content,
        reply_received,
        reply_text,
        reply_timestamp
      FROM missed_call_conversations
      WHERE business_number = ?
        AND phone_number = ?
      ORDER BY missed_call_timestamp ASC
    `
    )
      .bind(key.businessNumber, key.customerNumber)
      .all<MissedCallRow>();

    return rows.results || [];
  }

  private async loadCalls(key: ConversationKey): Promise<CallRow[]> {
    const rows = await this.env.SYSTEMIX.prepare(
      `
      SELECT
        id,
        provider_call_id,
        created_at,
        missed_at,
        transcription,
        recording_url,
        customer_welcome_sent_at,
        customer_welcome_message_id
      FROM calls
      WHERE from_phone = ?
        AND to_phone = ?
      ORDER BY COALESCE(created_at, missed_at) ASC
    `
    )
      .bind(key.customerNumber, key.businessNumber)
      .all<CallRow>();

    return rows.results || [];
  }

  private async loadMessages(key: ConversationKey): Promise<MessageRow[]> {
    const rows = await this.env.SYSTEMIX.prepare(
      `
      SELECT
        id,
        created_at,
        direction,
        provider_message_id,
        body,
        raw_json
      FROM messages
      WHERE (from_phone = ? AND to_phone = ?)
         OR (from_phone = ? AND to_phone = ?)
      ORDER BY created_at ASC
    `
    )
      .bind(key.customerNumber, key.businessNumber, key.businessNumber, key.customerNumber)
      .all<MessageRow>();

    return rows.results || [];
  }

  private async loadActiveSession(key: ConversationKey): Promise<ActiveSessionRow | null> {
    const row = await this.env.SYSTEMIX.prepare(
      `
      SELECT status, last_activity_at
      FROM active_sessions
      WHERE business_number = ?
        AND customer_number = ?
      LIMIT 1
    `
    )
      .bind(key.businessNumber, key.customerNumber)
      .first<ActiveSessionRow>();

    return row || null;
  }
}
