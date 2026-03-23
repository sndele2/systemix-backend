import { Context } from 'hono';
import { checkTwilioSignature, formDataToParams } from '../core/twilioSignature';
import {
  buildMissedCallVoiceHookMessage,
  findBusinessByNumber,
  normalizeCallStatus,
  normalizePhone,
  shouldFireMissedCallVoiceHook,
} from '../services/twilioLaunch';

type Bindings = {
  SYSTEMIX: D1Database;
  OPENAI_API_KEY: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER?: string;
  OWNER_PHONE_NUMBER?: string;
  TWILIO_SIGNATURE_MODE?: string;
  ENVIRONMENT?: string;
  WORKER_URL?: string;
  SYSTEMIX_NUMBER?: string;
  VOICE_CONSENT_SCRIPT?: string;
};

const CALL_PROVIDER = 'twilio';
const CUSTOMER_MISSED_STATUSES = new Set(['busy', 'no-answer']);

function getDb(env: Bindings) {
  return env.SYSTEMIX;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function maskPhone(phone: string): string {
  if (!phone) return 'unknown';
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '***';
  return `***${digits.slice(-4)}`;
}

async function lookupBusinessNameByDialedNumber(env: Bindings, toPhone: string): Promise<string> {
  const fallback = 'the office';
  const dialedNumber = (toPhone || '').trim();
  if (!dialedNumber) return fallback;

  try {
    const companyRow = await getDb(env)
      .prepare('SELECT company_name FROM tenants WHERE business_number = ? LIMIT 1')
      .bind(dialedNumber)
      .first<{ company_name?: string }>();

    if (companyRow?.company_name) {
      return String(companyRow.company_name);
    }
  } catch (error) {
    console.warn('Tenant lookup via company_name failed', {
      to: maskPhone(dialedNumber),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const nameRow = await getDb(env)
      .prepare('SELECT name FROM tenants WHERE business_number = ? LIMIT 1')
      .bind(dialedNumber)
      .first<{ name?: string }>();

    if (nameRow?.name) {
      return String(nameRow.name);
    }
  } catch (error) {
    console.warn('Tenant lookup via name failed', {
      to: maskPhone(dialedNumber),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return fallback;
}

function isTrustedTwilioHost(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'twilio.com' || host.endsWith('.twilio.com'));
  } catch {
    return false;
  }
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

async function sendOwnerTranscriptSms(
  client: TwilioRestClient,
  toPhone: string,
  fromPhone: string,
  body: string
): Promise<{ ok: boolean; sid?: string; detail?: string }> {
  if (!fromPhone) {
    return { ok: false, detail: 'missing_twilio_phone_number' };
  }

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

async function sendCustomerWelcomeSms(
  client: TwilioRestClient,
  toPhone: string,
  fromPhone: string,
  body: string
): Promise<{ ok: boolean; sid?: string; detail?: string }> {
  if (!fromPhone) {
    return { ok: false, detail: 'missing_twilio_phone_number' };
  }

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
  await getDb(env)
    .prepare(
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

async function releaseOwnerTranscriptLock(env: Bindings, providerCallId: string): Promise<void> {
  await getDb(env)
    .prepare(
      `
      UPDATE calls
      SET owner_transcript_sent_at = NULL
      WHERE provider = ?
        AND provider_call_id = ?
        AND owner_transcript_message_id IS NULL
    `
    )
    .bind(CALL_PROVIDER, providerCallId)
    .run();
}

// ==========================================
// /voice ENDPOINT (Instant response)
// ==========================================
export async function twilioVoiceHandler(c: Context<{ Bindings: Bindings }>) {
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
      console.error('Twilio voice signature rejected (continuing)', { mode: sig.mode, reason: sig.reason });
    }

    const from = (formData.get('From') as string) || '';
    const to = (formData.get('To') as string) || '';
    const rawStatus = ((formData.get('CallStatus') as string) || (formData.get('DialCallStatus') as string) || '')
      .trim();
    const callStatus = normalizeCallStatus(rawStatus);
    const callSid = ((formData.get('CallSid') as string) || '').trim();
    const parentCallSid = ((formData.get('ParentCallSid') as string) || '').trim();

    if (shouldFireMissedCallVoiceHook(callStatus, to)) {
      const providerCallId = callSid || parentCallSid;
      if (!providerCallId) {
        console.error('Customer SMS skipped in voice handler: missing call identifier', {
          status: callStatus,
          from: maskPhone(from),
          to: maskPhone(to),
        });
        return c.json({ ok: false, error: 'missing_call_sid' }, 200);
      }

      await getDb(env)
        .prepare(
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
          from || 'unknown',
          to || 'unknown',
          callStatus,
          JSON.stringify({
            source: 'twilio_voice_status_callback',
            callSid,
            parentCallSid,
            from,
            to,
            callStatus: rawStatus,
          })
        )
        .run();

      const lock = await getDb(env)
        .prepare(
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
        return c.json({ ok: true, deduped: true, status: callStatus }, 200);
      }

      const normalizedBusinessNumber = normalizePhone(to);
      const business = await findBusinessByNumber(getDb(env), normalizedBusinessNumber);
      if (!business) {
        await releaseCustomerWelcomeLock(env, providerCallId);
        console.warn('[TWILIO] VOICE HOOK SKIPPED: business not found', {
          business_number: normalizedBusinessNumber,
        });
        return c.json({ ok: true, skipped: true, reason: 'business_not_found' }, 200);
      }

      const callerNumber = from.trim();
      const smsFrom = (env.TWILIO_PHONE_NUMBER || '').trim();

      if (!callerNumber) {
        await releaseCustomerWelcomeLock(env, providerCallId);
        return c.json({ ok: false, error: 'missing_sms_to' }, 200);
      }

      if (!smsFrom) {
        await releaseCustomerWelcomeLock(env, providerCallId);
        return c.json({ ok: false, error: 'missing_twilio_phone_number' }, 200);
      }

      const twilioClient = createTwilioRestClient(env);
      if (!twilioClient) {
        await releaseCustomerWelcomeLock(env, providerCallId);
        return c.json({ ok: false, error: 'missing_twilio_credentials' }, 200);
      }

      const sms = await sendCustomerWelcomeSms(
        twilioClient,
        callerNumber,
        smsFrom,
        buildMissedCallVoiceHookMessage(business.display_name)
      );
      if (!sms.ok) {
        await releaseCustomerWelcomeLock(env, providerCallId);
        return c.json({ ok: false, error: 'sms_failed', detail: sms.detail || 'unknown' }, 200);
      }

      await getDb(env)
        .prepare(
          `
          UPDATE calls
          SET missed_at = CASE WHEN ? = 1 THEN COALESCE(missed_at, datetime('now')) ELSE missed_at END,
              customer_welcome_message_id = COALESCE(customer_welcome_message_id, ?)
          WHERE provider = ? AND provider_call_id = ?
        `
        )
        .bind(CUSTOMER_MISSED_STATUSES.has(callStatus) ? 1 : 0, sms.sid || null, CALL_PROVIDER, providerCallId)
        .run();

      console.log('[TWILIO] VOICE HOOK FIRED', {
        caller_number: callerNumber,
        business_number: business.business_number,
        status: callStatus,
        sid: sms.sid || null,
      });

      return c.json({ ok: true, status: callStatus, messageSid: sms.sid || null }, 200);
    }

    if (rawStatus) {
      return c.json({ ok: true, ignored: true, status: callStatus }, 200);
    }

    const baseUrl = new URL(c.req.url).origin;
    const workerUrl = env.WORKER_URL || baseUrl;
    const defaultConsentScript =
      "Thanks for calling. We're with a customer right now, but we want to help. Leave your name and request after the beep, and look out for a text from us shortly. By staying on the line, you consent to receive texts.";
    const consentText = (env.VOICE_CONSENT_SCRIPT || '').trim() || defaultConsentScript;
    const consentScript = escapeXml(consentText);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${consentScript}</Say>
  <Record
    maxLength="120"
    timeout="10"
    playBeep="true"
    transcribe="false"
    recordingStatusCallback="${workerUrl}/v1/webhooks/twilio/recording?from=${encodeURIComponent(from)}&amp;to=${encodeURIComponent(to)}"
    recordingStatusCallbackEvent="completed"
  />
</Response>`;

    console.log('Voice webhook accepted', {
      from: maskPhone(from),
      to: maskPhone(to),
      mode: sig.mode,
    });

    return c.body(twiml, 200, { 'Content-Type': 'text/xml' });
  } catch (error) {
    console.error('Voice handler error');
    console.error(error);
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, we are unable to process your call right now.</Say><Hangup/></Response>`,
      200,
      { 'Content-Type': 'text/xml' }
    );
  }
}

// ==========================================
// /recording CALLBACK ENDPOINT
// ==========================================
export async function twilioRecordingHandler(c: Context<{ Bindings: Bindings }>) {
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
      console.error('Twilio recording signature rejected (continuing)', { mode: sig.mode, reason: sig.reason });
    }

    const url = new URL(c.req.url);
    const from = url.searchParams.get('from') || (formData.get('From') as string) || 'unknown';
    const to = url.searchParams.get('to') || (formData.get('To') as string) || 'unknown';

    const recordingUrl = formData.get('RecordingUrl') as string;
    const recordingSid = formData.get('RecordingSid') as string;
    const callSid = formData.get('CallSid') as string;
    const recordingDuration = formData.get('RecordingDuration') as string;

    if (!recordingUrl) {
      console.error('Recording callback missing recording URL', { callSid: callSid || 'unknown' });
      return c.json({ success: false, error: 'missing_recording' }, 200);
    }

    console.log('Processing recording callback', {
      callSid: callSid || 'unknown',
      from: maskPhone(from),
      to: maskPhone(to),
      duration: recordingDuration || 'unknown',
      mode: sig.mode,
    });

    const companyName = await lookupBusinessNameByDialedNumber(env, to);

    let audioBlob: Blob | null = null;
    try {
      const audioUrl = recordingUrl.endsWith('.wav') ? recordingUrl : `${recordingUrl}.wav`;
      const headers: Record<string, string> = {};

      if (isTrustedTwilioHost(audioUrl)) {
        headers.Authorization = `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`;
      } else if (env.ENVIRONMENT === 'production') {
        console.error('Untrusted recording host blocked in production', { host: new URL(audioUrl).hostname });
        return c.json({ success: false, error: 'invalid_recording_host' }, 200);
      }

      const audioController = new AbortController();
      const audioTimeout = setTimeout(() => audioController.abort(), 10000);

      const audioResponse = await fetch(audioUrl, {
        headers,
        signal: audioController.signal,
      });

      clearTimeout(audioTimeout);

      if (audioResponse.ok) {
        audioBlob = await audioResponse.blob();
        console.log('Recording audio fetched', { sizeBytes: audioBlob.size });
      } else {
        console.error('Audio fetch failed', { status: audioResponse.status });
      }
    } catch (audioError) {
      console.error('Audio fetch error');
      console.error(audioError);
    }

    let transcription = 'Voice message received';
    if (audioBlob && audioBlob.size > 0) {
      try {
        const whisperController = new AbortController();
        const whisperTimeout = setTimeout(() => whisperController.abort(), 30000);

        const fd = new FormData();
        fd.append('file', audioBlob, 'recording.wav');
        fd.append('model', 'whisper-1');
        fd.append('language', 'en');

        const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: fd,
          signal: whisperController.signal,
        });

        clearTimeout(whisperTimeout);

        if (whisperResponse.ok) {
          const result = (await whisperResponse.json()) as { text?: string };
          transcription = result.text?.trim() || transcription;
          console.log('Transcription complete', { chars: transcription.length });
        } else {
          const errorText = await whisperResponse.text();
          console.error('Whisper API failed', { status: whisperResponse.status, detail: errorText });
        }
      } catch (whisperError) {
        console.error('Whisper transcription error');
        console.error(whisperError);
      }
    }

    const providerCallId = (callSid || recordingSid || '').trim() || crypto.randomUUID();
    const rawJson = JSON.stringify({
      recordingSid,
      callSid,
      from,
      to,
      recordingUrl,
      recordingDuration,
      transcription,
    });

    await getDb(env)
      .prepare(
        `
        INSERT INTO calls (
          id,
          provider,
          provider_call_id,
          call_sid,
          from_phone,
          to_phone,
          status,
          recording_url,
          transcription,
          raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, provider_call_id) DO UPDATE SET
          call_sid = excluded.call_sid,
          from_phone = excluded.from_phone,
          to_phone = excluded.to_phone,
          status = excluded.status,
          recording_url = excluded.recording_url,
          transcription = excluded.transcription,
          raw_json = excluded.raw_json
      `
      )
      .bind(
        crypto.randomUUID(),
        CALL_PROVIDER,
        providerCallId,
        callSid || null,
        from,
        to,
        'completed',
        recordingUrl,
        transcription,
        rawJson
      )
      .run();

    const lock = await getDb(env)
      .prepare(
        `
        UPDATE calls
        SET owner_transcript_sent_at = datetime('now')
        WHERE provider = ?
          AND provider_call_id = ?
          AND owner_transcript_sent_at IS NULL
      `
      )
      .bind(CALL_PROVIDER, providerCallId)
      .run();

    if (Number(lock.meta?.changes || 0) === 0) {
      return c.json({ success: true, deduped: true }, 200);
    }

    const ownerPhone = (env.OWNER_PHONE_NUMBER || '').trim();
    if (!ownerPhone) {
      await releaseOwnerTranscriptLock(env, providerCallId);
      console.error('Owner transcript SMS skipped: OWNER_PHONE_NUMBER is not configured', {
        callSid: callSid || 'unknown',
      });
      return c.json({ success: false, error: 'missing_owner_phone_number' }, 200);
    }

    const twilioClient = createTwilioRestClient(env);
    if (!twilioClient) {
      await releaseOwnerTranscriptLock(env, providerCallId);
      return c.json({ success: false, error: 'missing_twilio_credentials' }, 200);
    }

    const smsMessage = `New voicemail for ${companyName} from ${from}: "${transcription}"`;
    const sms = await sendOwnerTranscriptSms(twilioClient, ownerPhone, (env.TWILIO_PHONE_NUMBER || '').trim(), smsMessage);

    if (!sms.ok) {
      await releaseOwnerTranscriptLock(env, providerCallId);
      console.error('Owner transcript SMS failed', {
        callSid: callSid || 'unknown',
        detail: sms.detail || 'unknown',
      });
      return c.json({ success: false, error: 'sms_failed' }, 200);
    }

    await getDb(env)
      .prepare(
        `
        UPDATE calls
        SET owner_transcript_message_id = COALESCE(owner_transcript_message_id, ?)
        WHERE provider = ?
          AND provider_call_id = ?
      `
      )
      .bind(sms.sid || null, CALL_PROVIDER, providerCallId)
      .run();

    console.log('Owner transcript SMS sent', {
      callSid: callSid || 'unknown',
      owner: maskPhone(ownerPhone),
      sid: sms.sid || 'unknown',
    });

    return c.json({ success: true, messageSid: sms.sid || null }, 200);
  } catch (error) {
    console.error('Recording handler error');
    console.error(error);
    return c.json({ success: false, error: 'processing_failed' }, 200);
  }
}
