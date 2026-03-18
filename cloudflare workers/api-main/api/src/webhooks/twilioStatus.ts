import { Context } from 'hono';
import { checkTwilioSignature, formDataToParams } from '../core/twilioSignature';

type Bindings = {
  SYSTEMIX: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER?: string;
  TWILIO_SIGNATURE_MODE?: string;
  ENVIRONMENT?: string;
};

const CUSTOMER_WELCOME_STATUSES = new Set(['completed', 'busy', 'no-answer']);
const MISSED_STATUSES = new Set(['busy', 'no-answer']);
const CALL_PROVIDER = 'twilio';

function normalizeStatus(value: string | null): string {
  return (value || '').trim().toLowerCase();
}

function maskPhone(phone: string): string {
  if (!phone) return 'unknown';
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '***';
  return `***${digits.slice(-4)}`;
}

type TwilioRestClient = {
  sendSms: (
    input: { toPhone: string; fromPhone: string; body: string }
  ) => Promise<{ ok: boolean; sid?: string; detail?: string }>;
};

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

async function getBusinessName(env: Bindings, toPhone: string): Promise<string> {
  const fallback = 'the office';
  if (!toPhone) return fallback;

  try {
    const companyRow = await env.SYSTEMIX.prepare(
      `
      SELECT company_name
      FROM tenants
      WHERE business_number = ?
      LIMIT 1
      `
    )
      .bind(toPhone)
      .first<{ company_name?: string }>();

    if (companyRow?.company_name) {
      return String(companyRow.company_name);
    }
  } catch (error) {
    console.warn('Business name lookup via company_name failed', {
      to: maskPhone(toPhone),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const nameRow = await env.SYSTEMIX.prepare(
      `
      SELECT name
      FROM tenants
      WHERE business_number = ?
      LIMIT 1
      `
    )
      .bind(toPhone)
      .first<{ name?: string }>();

    if (nameRow?.name) {
      return String(nameRow.name);
    }
  } catch (error) {
    console.warn('Business name lookup via name failed', {
      to: maskPhone(toPhone),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return fallback;
}

async function sendMissedCallSms(
  client: TwilioRestClient,
  toPhone: string,
  fromPhone: string,
  body: string
): Promise<{ ok: boolean; sid?: string; detail?: string }> {
  try {
    return await client.sendSms({
      toPhone,
      fromPhone,
      body,
    });
  } catch (error) {
    return {
      ok: false,
      detail: `twilio_sms_error:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function releaseCustomerWelcomeLock(env: Bindings, providerCallId: string): Promise<void> {
  await env.SYSTEMIX.prepare(
    `
    UPDATE calls
    SET customer_welcome_sent_at = NULL
    WHERE provider = ?
      AND provider_call_id = ?
      AND customer_welcome_message_id IS NULL
  `
  )
    .bind(CALL_PROVIDER, providerCallId)
    .run();
}

export async function twilioStatusHandler(c: Context<{ Bindings: Bindings }>) {
  try {
    const env = c.env;
    const formData = await c.req.formData();
    const params = formDataToParams(formData);

    const sig = await checkTwilioSignature(
      env,
      c.req.url,
      params,
      c.req.header('X-Twilio-Signature') || undefined
    );
    if (!sig.ok) {
      console.error('Twilio status signature rejected (continuing)', { mode: sig.mode, reason: sig.reason });
    }

    const callSid = (formData.get('CallSid') as string) || '';
    const fromPhone = (formData.get('From') as string) || '';
    const toPhone = (formData.get('To') as string) || '';
    const rawStatus = ((formData.get('CallStatus') as string) || (formData.get('DialCallStatus') as string) || '');
    const status = normalizeStatus(rawStatus);
    const parentCallSid = (formData.get('ParentCallSid') as string) || '';
    const providerCallId = (callSid || parentCallSid || '').trim();

    if (!providerCallId) {
      console.error('Customer welcome SMS skipped: missing call identifier', {
        from: maskPhone(fromPhone),
        to: maskPhone(toPhone),
        status,
      });
      return c.json({ ok: false, error: 'missing_call_sid' }, 200);
    }

    await env.SYSTEMIX.prepare(
      `
      INSERT INTO calls (
        id,
        provider,
        provider_call_id,
        call_sid,
        from_phone,
        to_phone,
        status,
        raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, provider_call_id) DO UPDATE SET
        call_sid = excluded.call_sid,
        from_phone = excluded.from_phone,
        to_phone = excluded.to_phone,
        status = excluded.status,
        raw_json = excluded.raw_json
    `
    )
      .bind(
        crypto.randomUUID(),
        CALL_PROVIDER,
        providerCallId,
        callSid || null,
        fromPhone || 'unknown',
        toPhone || 'unknown',
        status || 'unknown',
        JSON.stringify({
          source: 'twilio_status_webhook',
          callSid,
          fromPhone,
          toPhone,
          callStatus: rawStatus,
        })
      )
      .run();

    if (!CUSTOMER_WELCOME_STATUSES.has(status)) {
      return c.json({ ok: true, ignored: true, status }, 200);
    }

    const lock = await env.SYSTEMIX.prepare(
      `
      UPDATE calls
      SET customer_welcome_sent_at = datetime('now')
      WHERE provider = ?
        AND provider_call_id = ?
        AND customer_welcome_sent_at IS NULL
    `
    )
      .bind(CALL_PROVIDER, providerCallId)
      .run();

    if (Number(lock.meta?.changes || 0) === 0) {
      return c.json({ ok: true, deduped: true, status }, 200);
    }

    const smsTo = (fromPhone || '').trim();
    const smsFrom = (env.TWILIO_PHONE_NUMBER || '').trim();

    if (!smsTo) {
      console.error('Missed call SMS skipped: caller number is missing', {
        callSid: callSid || 'unknown',
        to: maskPhone(toPhone),
      });
      await releaseCustomerWelcomeLock(env, providerCallId);
      return c.json({ ok: false, error: 'missing_sms_to' }, 200);
    }

    if (!smsFrom) {
      console.error('Missed call SMS skipped: TWILIO_PHONE_NUMBER is not configured', {
        callSid: callSid || 'unknown',
        to: maskPhone(toPhone),
      });
      await releaseCustomerWelcomeLock(env, providerCallId);
      return c.json({ ok: false, error: 'missing_twilio_phone_number' }, 200);
    }

    const twilioClient = createTwilioRestClient(env);
    if (!twilioClient) {
      await releaseCustomerWelcomeLock(env, providerCallId);
      return c.json({ ok: false, error: 'missing_twilio_credentials' }, 200);
    }

    const businessName = await getBusinessName(env, toPhone);
    const message =
      status === 'completed'
        ? `Hi, this is ${businessName}. We received your voicemail and will get back to you as soon as possible!`
        : `Hi, this is ${businessName}. We're sorry we missed your call! Please leave a reply here and we'll get back to you shortly.`;
    const sms = await sendMissedCallSms(twilioClient, smsTo, smsFrom, message);
    if (!sms.ok) {
      await releaseCustomerWelcomeLock(env, providerCallId);
      console.error('Missed call SMS failed', {
        callSid: callSid || 'unknown',
        status,
        detail: sms.detail || 'unknown',
      });
      return c.json({ ok: false, error: 'sms_failed' }, 200);
    }

    await env.SYSTEMIX.prepare(
      `
      UPDATE calls
      SET missed_at = CASE WHEN ? = 1 THEN COALESCE(missed_at, datetime('now')) ELSE missed_at END,
          customer_welcome_message_id = COALESCE(customer_welcome_message_id, ?)
      WHERE provider = ? AND provider_call_id = ?
    `
    )
      .bind(MISSED_STATUSES.has(status) ? 1 : 0, sms.sid || null, CALL_PROVIDER, providerCallId)
      .run();

    console.log('Customer welcome SMS sent', {
      callSid: callSid || 'unknown',
      status,
      reason: status === 'completed' ? 'completed' : 'missed_call',
      to: maskPhone(fromPhone),
      sid: sms.sid || 'unknown',
    });

    return c.json(
      {
        ok: true,
        status,
        messageSid: sms.sid || null,
      },
      200
    );
  } catch (error) {
    console.error('Twilio status handler error');
    console.error(error);
    return c.json({ ok: false, error: 'processing_failed' }, 200);
  }
}
