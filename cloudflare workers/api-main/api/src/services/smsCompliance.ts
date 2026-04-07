export const SMS_OPT_OUT_FOOTER = 'Msg & Data Rates May Apply. Reply STOP to opt out.';

const LEGACY_SMS_OPT_OUT_FOOTERS = [
  'Msg&data rates may apply. Reply STOP to opt out.',
  SMS_OPT_OUT_FOOTER,
] as const;
const MAX_TWILIO_BODY = 1600;
const STOP_COMMANDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'END', 'CANCEL', 'QUIT']);
const OPT_IN_COMMANDS = new Set(['START', 'YES', 'UNSTOP']);
const HELP_COMMANDS = new Set(['HELP', 'INFO']);

let schemaReadyPromise: Promise<void> | null = null;

export type InboundSmsComplianceAction = 'opt_out' | 'opt_in' | 'help';

export type ConsentLogInput = {
  businessNumber: string;
  phoneNumber: string;
  source: 'contact_form' | 'trial_signup' | 'voice_call' | string;
  consentGiven: boolean;
  consentText?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | null;
};

function stripKnownSmsFooter(message: string): string {
  let content = message.trimEnd();

  for (const footer of LEGACY_SMS_OPT_OUT_FOOTERS) {
    while (content.includes(footer)) {
      content = content.replace(footer, '').trimEnd();
    }
  }

  return content;
}

export function appendSmsOptOutFooter(message: string): string {
  let content = stripKnownSmsFooter(message);
  const suffix = `\n\n${SMS_OPT_OUT_FOOTER}`;
  const maxContentLen = MAX_TWILIO_BODY - suffix.length - 1;

  if (content.length > maxContentLen) {
    content = `${content.slice(0, Math.max(0, maxContentLen)).trimEnd()}...`;
  }

  return `${content}${suffix}`;
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

export function normalizeInboundSmsCommand(body: string | null | undefined): string {
  return (body || '').trim().toUpperCase();
}

export function resolveInboundSmsComplianceAction(
  body: string | null | undefined
): InboundSmsComplianceAction | null {
  const normalizedBody = normalizeInboundSmsCommand(body);
  if (!normalizedBody) return null;
  if (STOP_COMMANDS.has(normalizedBody)) return 'opt_out';
  if (OPT_IN_COMMANDS.has(normalizedBody)) return 'opt_in';
  if (HELP_COMMANDS.has(normalizedBody)) return 'help';
  return null;
}

function resolveBusinessLabel(displayName: string | null | undefined, businessNumber?: string): string {
  const trimmedDisplayName = (displayName || '').trim();
  if (trimmedDisplayName) {
    return trimmedDisplayName;
  }

  const normalizedBusinessNumber = normalizePhone(businessNumber);
  if (normalizedBusinessNumber) {
    return normalizedBusinessNumber;
  }

  return 'this business';
}

export function buildSmsOptOutConfirmationMessage(
  displayName: string | null | undefined,
  businessNumber?: string
): string {
  return `You have successfully opted out and will no longer receive text messages from ${resolveBusinessLabel(displayName, businessNumber)}.`;
}

export function buildSmsOptInConfirmationMessage(): string {
  return 'You have opted back in. Msg & Data Rates May Apply. Reply STOP to opt out.';
}

export function buildSmsHelpMessage(
  displayName: string | null | undefined,
  businessNumber?: string
): string {
  return `Systemix Support: You may receive transactional text messages related to missed calls or follow-up service communication from ${resolveBusinessLabel(displayName, businessNumber)}. Message frequency may vary. Msg & Data Rates May Apply. Reply STOP to opt out. Email support@systemixai.co for help.`;
}

export async function ensureSmsComplianceSchema(db: D1Database): Promise<void> {
  if (!schemaReadyPromise) {
    const statements = [
      `CREATE TABLE IF NOT EXISTS sms_opt_outs (
        id TEXT PRIMARY KEY,
        business_number TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        is_opted_out INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_opt_outs_business_phone
       ON sms_opt_outs(business_number, phone_number)`,
      `CREATE INDEX IF NOT EXISTS idx_sms_opt_outs_business_status
       ON sms_opt_outs(business_number, is_opted_out, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS consents (
        id TEXT PRIMARY KEY,
        business_number TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        source TEXT NOT NULL,
        consent_given INTEGER NOT NULL,
        consent_text TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_consents_business_phone_created
       ON consents(business_number, phone_number, created_at DESC)`,
    ];

    schemaReadyPromise = (async () => {
      for (const statement of statements) {
        await db.prepare(statement).run();
      }
    })()
      .then(() => undefined)
      .catch((error) => {
        schemaReadyPromise = null;
        throw error;
      });
  }

  return schemaReadyPromise;
}

async function hasPriorOutboundCustomerMessage(
  db: D1Database,
  businessNumber: string,
  customerNumber: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `
      SELECT provider_message_id
      FROM messages
      WHERE direction = 'outbound'
        AND provider = 'twilio'
        AND from_phone = ?
        AND to_phone = ?
      LIMIT 1
    `
    )
    .bind(businessNumber, customerNumber)
    .first<{ provider_message_id?: string | null }>();

  return Boolean(row);
}

export async function prepareCustomerFacingSmsBody(
  db: D1Database,
  businessNumber: string,
  customerNumber: string,
  message: string,
  options: {
    appendFooter?: boolean;
  } = {}
): Promise<string> {
  await ensureSmsComplianceSchema(db);

  const normalizedBusinessNumber = normalizePhone(businessNumber);
  const normalizedCustomerNumber = normalizePhone(customerNumber);
  const normalizedMessage = stripKnownSmsFooter(message).trim();

  if (!normalizedMessage) {
    return normalizedMessage;
  }

  if (options.appendFooter === false || !normalizedBusinessNumber || !normalizedCustomerNumber) {
    return normalizedMessage;
  }

  if (await hasPriorOutboundCustomerMessage(db, normalizedBusinessNumber, normalizedCustomerNumber)) {
    return normalizedMessage;
  }

  return appendSmsOptOutFooter(normalizedMessage);
}

export async function upsertSmsOptOut(
  db: D1Database,
  businessNumber: string,
  phoneNumber: string,
  isOptedOut: boolean
): Promise<void> {
  await ensureSmsComplianceSchema(db);

  const normalizedBusinessNumber = normalizePhone(businessNumber);
  const normalizedPhoneNumber = normalizePhone(phoneNumber);
  if (!normalizedBusinessNumber || !normalizedPhoneNumber) {
    return;
  }

  const now = new Date().toISOString();

  await db
    .prepare(
      `
      INSERT INTO sms_opt_outs (
        id,
        business_number,
        phone_number,
        is_opted_out,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(business_number, phone_number) DO UPDATE SET
        is_opted_out = excluded.is_opted_out,
        updated_at = excluded.updated_at
    `
    )
    .bind(
      crypto.randomUUID(),
      normalizedBusinessNumber,
      normalizedPhoneNumber,
      isOptedOut ? 1 : 0,
      now,
      now
    )
    .run();
}

export async function isSmsOptedOut(
  db: D1Database,
  businessNumber: string,
  phoneNumber: string
): Promise<boolean> {
  await ensureSmsComplianceSchema(db);

  const normalizedBusinessNumber = normalizePhone(businessNumber);
  const normalizedPhoneNumber = normalizePhone(phoneNumber);
  if (!normalizedBusinessNumber || !normalizedPhoneNumber) {
    return false;
  }

  const row = await db
    .prepare(
      `
      SELECT is_opted_out
      FROM sms_opt_outs
      WHERE business_number = ?
        AND phone_number = ?
      LIMIT 1
    `
    )
    .bind(normalizedBusinessNumber, normalizedPhoneNumber)
    .first<{ is_opted_out?: number | string | null }>();

  return Number(row?.is_opted_out || 0) === 1;
}

export async function logConsentEvent(db: D1Database, input: ConsentLogInput): Promise<void> {
  await ensureSmsComplianceSchema(db);

  const normalizedBusinessNumber = normalizePhone(input.businessNumber);
  const normalizedPhoneNumber = normalizePhone(input.phoneNumber);
  const source = (input.source || '').trim();
  if (!normalizedBusinessNumber || !normalizedPhoneNumber || !source) {
    return;
  }

  const createdAt = (input.createdAt || '').trim() || new Date().toISOString();

  await db
    .prepare(
      `
      INSERT INTO consents (
        id,
        business_number,
        phone_number,
        source,
        consent_given,
        consent_text,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .bind(
      crypto.randomUUID(),
      normalizedBusinessNumber,
      normalizedPhoneNumber,
      source,
      input.consentGiven ? 1 : 0,
      (input.consentText || '').trim() || null,
      JSON.stringify(input.metadata || {}),
      createdAt
    )
    .run();
}
