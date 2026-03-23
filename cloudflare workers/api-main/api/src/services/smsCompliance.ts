const SMS_OPT_OUT_FOOTER = 'Msg&data rates may apply. Reply STOP to opt out.';
const MAX_TWILIO_BODY = 1600;

function appendSmsOptOutFooter(message: string): string {
  let content = message.includes(SMS_OPT_OUT_FOOTER)
    ? message.replace(SMS_OPT_OUT_FOOTER, '').trimEnd()
    : message.trimEnd();
  const suffix = `\n\n${SMS_OPT_OUT_FOOTER}`;
  const maxContentLen = MAX_TWILIO_BODY - suffix.length - 1;

  if (content.length > maxContentLen) {
    content = `${content.slice(0, Math.max(0, maxContentLen)).trimEnd()}...`;
  }

  return `${content}${suffix}`;
}

function normalizePhone(value: string | null | undefined): string {
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
  message: string
): Promise<string> {
  const normalizedBusinessNumber = normalizePhone(businessNumber);
  const normalizedCustomerNumber = normalizePhone(customerNumber);
  const normalizedMessage = message.trim();

  if (!normalizedBusinessNumber || !normalizedCustomerNumber || !normalizedMessage) {
    return normalizedMessage;
  }

  if (await hasPriorOutboundCustomerMessage(db, normalizedBusinessNumber, normalizedCustomerNumber)) {
    return normalizedMessage;
  }

  return appendSmsOptOutFooter(normalizedMessage);
}
