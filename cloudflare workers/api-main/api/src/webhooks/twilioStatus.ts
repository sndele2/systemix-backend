import { Context } from 'hono';
import { checkTwilioSignature, formDataToParams } from '../core/twilioSignature';

type Bindings = {
  SYSTEMIX: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER?: string;
  SYSTEMIX_NUMBER?: string;
  TWILIO_SIGNATURE_MODE?: string;
  ENVIRONMENT?: string;
};

const MISSED_STATUSES = new Set(['no-answer', 'busy', 'canceled']);
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
  const fallback = 'Systemix';
  if (!toPhone) return fallback;

  try {
    const companyRow = await env.SYSTEMIX.prepare(
      `
      SELECT company_name
      FROM tenants
      WHERE systemix_number = ?
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
      WHERE systemix_number = ?
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

function voicemailInPayload(formData: FormData): boolean {
  const recordingSid = ((formData.get('RecordingSid') as string) || '').trim();
  const recordingUrl = ((formData.get('RecordingUrl') as string) || '').trim();
  const recordingDuration = ((formData.get('RecordingDuration') as string) || '').trim();

  if (recordingSid || recordingUrl) {
    return true;
  }

  return recordingDuration !== '' && recordingDuration !== '0';
}

async function voicemailInDatabase(env: Bindings, providerCallId: string, callSid: string): Promise<boolean> {
  try {
    if (providerCallId) {
      const byProviderCallId = await env.SYSTEMIX.prepare(
        `
        SELECT recording_url, transcription
        FROM calls
        WHERE provider = ? AND provider_call_id = ?
        LIMIT 1
      `
      )
        .bind(CALL_PROVIDER, providerCallId)
        .first<{ recording_url?: string | null; transcription?: string | null }>();

      if (byProviderCallId?.recording_url || byProviderCallId?.transcription) {
        return true;
      }
    }

    if (callSid && callSid !== providerCallId) {
      const byCallSid = await env.SYSTEMIX.prepare(
        `
        SELECT recording_url, transcription
        FROM calls
        WHERE provider = ? AND call_sid = ?
        LIMIT 1
      `
      )
        .bind(CALL_PROVIDER, callSid)
        .first<{ recording_url?: string | null; transcription?: string | null }>();

      if (byCallSid?.recording_url || byCallSid?.transcription) {
        return true;
      }
    }
  } catch (error) {
    console.warn('Voicemail lookup failed', {
      callSid: callSid || 'unknown',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return false;
}

async function sendMissedCallSms(
  client: TwilioRestClient,
  toPhone: string,
  fromPhone: string,
  body: string
): Promise<{ ok: boolean; sid?: string; detail?: string }> {
  return client.sendSms({
    toPhone,
    fromPhone,
    body,
  });
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
      console.error('Twilio status signature rejected', { mode: sig.mode, reason: sig.reason });
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const callSid = (formData.get('CallSid') as string) || '';
    const fromPhone = (formData.get('From') as string) || '';
    const toPhone = (formData.get('To') as string) || '';
    const rawStatus = ((formData.get('CallStatus') as string) || (formData.get('DialCallStatus') as string) || '');
    const status = normalizeStatus(rawStatus);
    const parentCallSid = (formData.get('ParentCallSid') as string) || '';
    const providerCallId = callSid || parentCallSid || crypto.randomUUID();

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

    const missedCall = MISSED_STATUSES.has(status);
    const voicemailFound =
      status === 'completed' &&
      (voicemailInPayload(formData) || (await voicemailInDatabase(env, providerCallId, callSid)));
    const shouldSendFollowup = missedCall || voicemailFound;
    if (!shouldSendFollowup) {
      return c.json({ ok: true, ignored: true, status }, 200);
    }

    const existing = await env.SYSTEMIX.prepare(
      `
      SELECT followup_sent_at
      FROM calls
      WHERE provider = ? AND provider_call_id = ?
      LIMIT 1
    `
    )
      .bind(CALL_PROVIDER, providerCallId)
      .first<{ followup_sent_at?: string }>();

    if (existing?.followup_sent_at) {
      return c.json({ ok: true, deduped: true, status }, 200);
    }

    const smsTo = fromPhone;
    const smsFrom = env.TWILIO_PHONE_NUMBER || env.SYSTEMIX_NUMBER || toPhone;
    if (!smsTo || !smsFrom) {
      console.error('Missed call SMS skipped due to missing phone values', {
        callSid: callSid || 'unknown',
        from: maskPhone(fromPhone),
        to: maskPhone(toPhone),
      });
      return c.json({ ok: false, error: 'missing_sms_phone' }, 200);
    }

    const twilioClient = createTwilioRestClient(env);
    if (!twilioClient) {
      return c.json({ ok: false, error: 'missing_twilio_credentials' }, 200);
    }

    const businessName = await getBusinessName(env, toPhone);
    const message = `Hi, this is ${businessName}. Sorry we missed your call! How can we help you today?`;
    const sms = await sendMissedCallSms(twilioClient, smsTo, smsFrom, message);
    if (!sms.ok) {
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
      SET missed_at = COALESCE(missed_at, datetime('now')),
          followup_sent_at = COALESCE(followup_sent_at, datetime('now')),
          followup_message_id = COALESCE(followup_message_id, ?)
      WHERE provider = ? AND provider_call_id = ?
    `
    )
      .bind(sms.sid || null, CALL_PROVIDER, providerCallId)
      .run();

    console.log('Missed call SMS sent', {
      callSid: callSid || 'unknown',
      status,
      reason: missedCall ? 'missed_status' : 'completed_with_voicemail',
      to: maskPhone(fromPhone),
      sid: sms.sid || 'unknown',
    });

    return c.json(
      {
        ok: true,
        missed: true,
        status,
        voicemailFound,
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
