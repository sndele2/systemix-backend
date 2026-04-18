import type { Context } from 'hono';
import { createLogger } from '../core/logging.ts';
import { createTwilioRestClient } from '../core/sms.ts';
import { checkTwilioSignature, formDataToParams } from '../core/twilioSignature.ts';
import {
  normalizeCallStatus,
  onboardNewLead,
  shouldFireMissedCallVoiceHook,
} from '../services/twilioLaunch.ts';

type Bindings = {
  SYSTEMIX: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER?: string;
  TWILIO_SIGNATURE_MODE?: string;
  ENVIRONMENT?: string;
  WORKER_URL?: string;
};

const CALL_PROVIDER = 'twilio';
const twilioLog = createLogger('[TWILIO]', 'twilioStatusHandler');

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
    const callSid = (formData.get('CallSid') as string) || '';
    const fromPhone = (formData.get('From') as string) || '';
    const toPhone = (formData.get('To') as string) || '';
    const rawStatus = ((formData.get('CallStatus') as string) || (formData.get('DialCallStatus') as string) || '');
    const status = normalizeCallStatus(rawStatus);
    const parentCallSid = (formData.get('ParentCallSid') as string) || '';
    const providerCallId = (callSid || parentCallSid || '').trim();

    const sig = await checkTwilioSignature(
      env,
      c.req.url,
      params,
      c.req.header('X-Twilio-Signature') || undefined
    );
    if (!sig.ok) {
      twilioLog.error('Twilio status signature rejected and request processing continued', {
        context: {
          callSid: providerCallId || callSid,
          fromNumber: fromPhone,
          toNumber: toPhone,
        },
        data: {
          mode: sig.mode,
          reason: sig.reason,
        },
      });
    }

    if (!providerCallId) {
      twilioLog.error('Customer welcome SMS skipped because no call identifier was provided', {
        context: {
          fromNumber: fromPhone,
          toNumber: toPhone,
        },
        data: {
          status,
        },
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

    const backgroundTask = (async () => {
      try {
        const twilioClient = createTwilioRestClient(env);
        if (!twilioClient) {
          await releaseCustomerWelcomeLock(env, providerCallId);
          throw new Error('missing_twilio_credentials');
        }

        const result = await onboardNewLead({
          db: env.SYSTEMIX,
          twilioClient,
          smsFrom: (env.TWILIO_PHONE_NUMBER || '').trim(),
          businessNumber: toPhone,
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

        twilioLog.log('Voice hook background task completed', {
          context: {
            callSid: providerCallId,
            messageSid: result.messageSid || null,
            fromNumber: result.businessNumber,
            toNumber: result.callerNumber,
          },
          data: {
            status,
          },
        });
      } catch (error) {
        twilioLog.error('Voice hook background task failed', {
          error,
          context: {
            callSid: providerCallId,
            fromNumber: fromPhone,
            toNumber: toPhone,
          },
        });
      }
    })();

    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(backgroundTask);
    } else {
      void backgroundTask;
    }

    return c.json({ ok: true, queued: true, status }, 200);
  } catch (error) {
    twilioLog.error('Twilio status handler failed', {
      error,
    });
    return c.json({ ok: false, error: 'processing_failed' }, 200);
  }
}
