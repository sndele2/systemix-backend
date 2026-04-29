import { normalizePhone } from './smsCompliance.ts';

const DEFAULT_INTAKE_QUESTION = 'what vehicle and service were you looking for?';

let schemaReadyPromise: Promise<void> | null = null;

export type MissedCallBusinessConfig = {
  businessNumber: string;
  displayName: string | null;
  intakeQuestion: string | null;
};

export type MissedCallRecoveryStats = {
  totalMissedCalls: number;
  totalCustomerReplies: number;
  totalRecoveredOpportunities: number;
};

export const RECOVERED_OPPORTUNITY_DEFINITION =
  'missed call + customer replied after the first auto-text';

function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('duplicate column name');
}

async function maybeAddColumn(db: D1Database, statement: string): Promise<void> {
  try {
    await db.prepare(statement).run();
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }
}

export async function ensureCustomerMissedCallSchema(db: D1Database): Promise<void> {
  if (!schemaReadyPromise) {
    const statements = [
      `CREATE TABLE IF NOT EXISTS businesses (
        id TEXT PRIMARY KEY,
        business_number TEXT NOT NULL UNIQUE,
        owner_phone_number TEXT,
        display_name TEXT,
        intake_question TEXT,
        last_stripe_session_id TEXT,
        billing_mode TEXT NOT NULL DEFAULT 'pilot',
        is_internal INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`,
      'CREATE INDEX IF NOT EXISTS idx_businesses_business_number ON businesses(business_number)',
      `CREATE TABLE IF NOT EXISTS missed_call_conversations (
        id TEXT PRIMARY KEY,
        business_number TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        missed_call_timestamp TEXT NOT NULL,
        sms_sent INTEGER NOT NULL DEFAULT 0,
        sms_content TEXT,
        first_auto_text_at TEXT,
        reply_received INTEGER NOT NULL DEFAULT 0,
        reply_text TEXT,
        reply_timestamp TEXT,
        first_customer_reply_at TEXT,
        recovered_opportunity_at TEXT,
        time_to_reply_seconds INTEGER,
        is_ignored INTEGER NOT NULL DEFAULT 0,
        notes TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_missed_call_conversations_business_phone
       ON missed_call_conversations(business_number, phone_number, missed_call_timestamp DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_missed_call_conversations_business_reply
       ON missed_call_conversations(business_number, reply_received, missed_call_timestamp DESC)`,
      `CREATE TABLE IF NOT EXISTS missed_call_ignored_numbers (
        id TEXT PRIMARY KEY,
        business_number TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_missed_call_ignored_numbers_business_phone
       ON missed_call_ignored_numbers(business_number, phone_number)`,
    ];

    schemaReadyPromise = (async () => {
      for (const statement of statements) {
        await db.prepare(statement).run();
      }
      await maybeAddColumn(db, 'ALTER TABLE businesses ADD COLUMN intake_question TEXT');
      await maybeAddColumn(db, "ALTER TABLE businesses ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'pilot'");
      await maybeAddColumn(db, 'ALTER TABLE businesses ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0');
      await maybeAddColumn(db, 'ALTER TABLE missed_call_conversations ADD COLUMN first_auto_text_at TEXT');
      await maybeAddColumn(db, 'ALTER TABLE missed_call_conversations ADD COLUMN first_customer_reply_at TEXT');
      await maybeAddColumn(db, 'ALTER TABLE missed_call_conversations ADD COLUMN recovered_opportunity_at TEXT');
    })()
      .then(() => undefined)
      .catch((error) => {
        schemaReadyPromise = null;
        throw error;
      });
  }

  return schemaReadyPromise;
}

export function buildMissedCallFollowUpMessage(intakeQuestion?: string | null): string {
  const resolvedQuestion = (intakeQuestion || '').trim() || DEFAULT_INTAKE_QUESTION;
  return `Hey — saw you tried calling. Was this about a car detail? If so, ${resolvedQuestion}`;
}

export async function getMissedCallBusinessConfig(
  db: D1Database,
  businessNumber: string
): Promise<MissedCallBusinessConfig | null> {
  await ensureCustomerMissedCallSchema(db);

  const normalizedBusinessNumber = normalizePhone(businessNumber);
  if (!normalizedBusinessNumber) {
    return null;
  }

  const row = await db
    .prepare(
      `
      SELECT business_number, display_name, intake_question
      FROM businesses
      WHERE business_number = ?
        AND is_active = 1
      LIMIT 1
    `
    )
    .bind(normalizedBusinessNumber)
    .first<{
      business_number?: string;
      display_name?: string | null;
      intake_question?: string | null;
    }>();

  if (!row?.business_number) {
    return null;
  }

  return {
    businessNumber: normalizePhone(row.business_number) || normalizedBusinessNumber,
    displayName: typeof row.display_name === 'string' ? row.display_name.trim() || null : null,
    intakeQuestion: typeof row.intake_question === 'string' ? row.intake_question.trim() || null : null,
  };
}

export async function isMissedCallNumberIgnored(
  db: D1Database,
  businessNumber: string,
  phoneNumber: string
): Promise<boolean> {
  await ensureCustomerMissedCallSchema(db);

  const normalizedBusinessNumber = normalizePhone(businessNumber);
  const normalizedPhoneNumber = normalizePhone(phoneNumber);
  if (!normalizedBusinessNumber || !normalizedPhoneNumber) {
    return false;
  }

  const row = await db
    .prepare(
      `
      SELECT 1 AS is_ignored
      FROM missed_call_ignored_numbers
      WHERE business_number = ?
        AND phone_number = ?
      LIMIT 1
    `
    )
    .bind(normalizedBusinessNumber, normalizedPhoneNumber)
    .first<{ is_ignored?: number }>();

  return Number(row?.is_ignored || 0) === 1;
}

export async function createMissedCallConversation(
  db: D1Database,
  input: {
    businessNumber: string;
    phoneNumber: string;
    missedCallTimestamp?: string;
  }
): Promise<{ isIgnored: boolean }> {
  await ensureCustomerMissedCallSchema(db);

  const businessNumber = normalizePhone(input.businessNumber);
  const phoneNumber = normalizePhone(input.phoneNumber);
  if (!businessNumber || !phoneNumber) {
    return { isIgnored: false };
  }

  const isIgnored = await isMissedCallNumberIgnored(db, businessNumber, phoneNumber);

  await db
    .prepare(
      `
      INSERT INTO missed_call_conversations (
        id,
        business_number,
        phone_number,
        missed_call_timestamp,
        is_ignored
      ) VALUES (?, ?, ?, ?, ?)
    `
    )
    .bind(
      crypto.randomUUID(),
      businessNumber,
      phoneNumber,
      (input.missedCallTimestamp || '').trim() || new Date().toISOString(),
      isIgnored ? 1 : 0
    )
    .run();

  return { isIgnored };
}

export async function markMissedCallSmsSent(
  db: D1Database,
  input: {
    businessNumber: string;
    phoneNumber: string;
    smsContent: string;
    firstAutoTextAt?: string;
  }
): Promise<void> {
  await ensureCustomerMissedCallSchema(db);

  const businessNumber = normalizePhone(input.businessNumber);
  const phoneNumber = normalizePhone(input.phoneNumber);
  const smsContent = (input.smsContent || '').trim();
  const firstAutoTextAt = (input.firstAutoTextAt || '').trim() || new Date().toISOString();
  if (!businessNumber || !phoneNumber || !smsContent) {
    return;
  }

  await db
    .prepare(
      `
      UPDATE missed_call_conversations
      SET sms_sent = 1,
          sms_content = ?,
          first_auto_text_at = COALESCE(first_auto_text_at, ?)
      WHERE id = (
        SELECT id
        FROM missed_call_conversations
        WHERE business_number = ?
          AND phone_number = ?
          AND sms_sent = 0
        ORDER BY missed_call_timestamp DESC
        LIMIT 1
      )
    `
    )
    .bind(smsContent, firstAutoTextAt, businessNumber, phoneNumber)
    .run();
}

export async function recordMissedCallReply(
  db: D1Database,
  input: {
    businessNumber: string;
    phoneNumber: string;
    replyText: string;
    replyTimestamp?: string;
  }
): Promise<void> {
  await ensureCustomerMissedCallSchema(db);

  const businessNumber = normalizePhone(input.businessNumber);
  const phoneNumber = normalizePhone(input.phoneNumber);
  const replyText = (input.replyText || '').trim();
  const replyTimestamp = (input.replyTimestamp || '').trim() || new Date().toISOString();
  if (!businessNumber || !phoneNumber || !replyText) {
    return;
  }

  await db
    .prepare(
      `
      UPDATE missed_call_conversations
      SET reply_received = 1,
          reply_text = ?,
          reply_timestamp = ?,
          first_customer_reply_at = COALESCE(first_customer_reply_at, ?),
          recovered_opportunity_at = CASE
            WHEN recovered_opportunity_at IS NOT NULL THEN recovered_opportunity_at
            WHEN first_auto_text_at IS NULL THEN NULL
            WHEN CAST(strftime('%s', ?) AS INTEGER) < CAST(strftime('%s', first_auto_text_at) AS INTEGER) THEN NULL
            ELSE COALESCE(first_customer_reply_at, ?)
          END,
          time_to_reply_seconds = CASE
            WHEN missed_call_timestamp IS NULL THEN NULL
            ELSE MAX(0, CAST(strftime('%s', ?) AS INTEGER) - CAST(strftime('%s', missed_call_timestamp) AS INTEGER))
          END
      WHERE id = (
        SELECT id
        FROM missed_call_conversations
        WHERE business_number = ?
          AND phone_number = ?
          AND reply_received = 0
        ORDER BY missed_call_timestamp DESC
        LIMIT 1
      )
    `
    )
    .bind(
      replyText,
      replyTimestamp,
      replyTimestamp,
      replyTimestamp,
      replyTimestamp,
      replyTimestamp,
      businessNumber,
      phoneNumber
    )
    .run();
}

export async function getMissedCallRecoveryStats(
  db: D1Database,
  businessNumber?: string
): Promise<MissedCallRecoveryStats> {
  await ensureCustomerMissedCallSchema(db);

  const scopedBusinessNumber = normalizePhone(businessNumber || '') || null;
  const row = await db
    .prepare(
      `
      SELECT
        COUNT(*) AS total_missed_calls,
        SUM(CASE WHEN first_customer_reply_at IS NOT NULL THEN 1 ELSE 0 END) AS total_customer_replies,
        SUM(CASE WHEN recovered_opportunity_at IS NOT NULL THEN 1 ELSE 0 END) AS total_recovered_opportunities
      FROM missed_call_conversations
      WHERE (? IS NULL OR business_number = ?)
    `
    )
    .bind(scopedBusinessNumber, scopedBusinessNumber)
    .first<{
      total_missed_calls?: number | string | null;
      total_customer_replies?: number | string | null;
      total_recovered_opportunities?: number | string | null;
    }>();

  return {
    totalMissedCalls: Number(row?.total_missed_calls || 0),
    totalCustomerReplies: Number(row?.total_customer_replies || 0),
    totalRecoveredOpportunities: Number(row?.total_recovered_opportunities || 0),
  };
}

export async function ignoreMissedCallNumber(
  db: D1Database,
  input: {
    businessNumber: string;
    phoneNumber: string;
  }
): Promise<void> {
  await ensureCustomerMissedCallSchema(db);

  const businessNumber = normalizePhone(input.businessNumber);
  const phoneNumber = normalizePhone(input.phoneNumber);
  if (!businessNumber || !phoneNumber) {
    return;
  }

  const now = new Date().toISOString();

  await db
    .prepare(
      `
      INSERT INTO missed_call_ignored_numbers (
        id,
        business_number,
        phone_number,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(business_number, phone_number) DO UPDATE SET
        updated_at = excluded.updated_at
    `
    )
    .bind(crypto.randomUUID(), businessNumber, phoneNumber, now, now)
    .run();

  await db
    .prepare(
      `
      UPDATE missed_call_conversations
      SET is_ignored = 1
      WHERE business_number = ?
        AND phone_number = ?
    `
    )
    .bind(businessNumber, phoneNumber)
    .run();
}
