import { Context } from 'hono';
import { checkTwilioSignature, formDataToParams } from '../core/twilioSignature';
import {
  normalizeCallStatus,
  onboardNewLead,
  scheduleTwilioBackgroundTask,
  shouldFireMissedCallVoiceHook,
} from '../services/twilioLaunch';

type Bindings = {
  SYSTEMIX: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER?: string;
  TWILIO_SIGNATURE_MODE?: string;
  ENVIRONMENT?: string;
};

const CALL_PROVIDER = 'twilio';

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
    const status = normalizeCallStatus(rawStatus);
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

    if (!shouldFireMissedCallVoiceHook(status, toPhone)) {
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

    scheduleTwilioBackgroundTask(
      c.executionCtx,
      'Status hook onboard new lead',
      (async () => {
        const twilioClient = createTwilioRestClient(env);
        if (!twilioClient) {
          await releaseCustomerWelcomeLock(env, providerCallId);
          throw new Error('missing_twilio_credentials');
        }

        const result = await onboardNewLead({
          db: env.SYSTEMIX,
          twilioClient,
          smsFrom: (env.TWILIO_PHONE_NUMBER || '').trim(),
          callerNumber: fromPhone,
          provider: CALL_PROVIDER,
          providerCallId,
          callStatus: status,
          rawStatus,
          callSid,
          parentCallSid,
        });

        if (!result.ok) {
          await releaseCustomerWelcomeLock(env, providerCallId);
          throw new Error(result.detail);
        }

        console.log('[TWILIO] VOICE HOOK FIRED', {
          caller_number: result.callerNumber,
          business_number: result.businessNumber,
          status,
          sid: result.messageSid,
        });
      })()
    );

    return c.json({ ok: true, queued: true, status }, 200);
  } catch (error) {
    console.error('Twilio status handler error');
    console.error(error);
    return c.json({ ok: false, error: 'processing_failed' }, 200);
  }
}
