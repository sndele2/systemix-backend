import { Context } from 'hono';
import { sendTwilioSms } from '../core/sms';
import { checkTwilioSignature, formDataToParams } from '../core/twilioSignature';

type Bindings = {
  SYSTEMIX: D1Database;
  OPENAI_API_KEY: string;
  CLIENT_PHONE: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER: string;
  TWILIO_SIGNATURE_MODE?: string;
  ENVIRONMENT?: string;
  WORKER_URL?: string;
  SYSTEMIX_NUMBER: string;
  VOICE_CONSENT_SCRIPT?: string;
};

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

function isTrustedTwilioHost(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'twilio.com' || host.endsWith('.twilio.com'));
  } catch {
    return false;
  }
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
      console.error('Twilio voice signature rejected', { mode: sig.mode, reason: sig.reason });
      return c.body(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, we are unable to process your call right now.</Say><Hangup/></Response>`,
        200,
        { 'Content-Type': 'text/xml' }
      );
    }

    const from = (formData.get('From') as string) || '';
    const to = (formData.get('To') as string) || '';
    const baseUrl = new URL(c.req.url).origin;
    const workerUrl = env.WORKER_URL || baseUrl;
    const defaultConsentScript =
      'Thanks for calling Systemix. We are currently on a job site or helping another customer right now. Please leave a brief message with your name and what you need help with. To get you scheduled quickly, we will send a follow-up text to this number. By leaving a message, you consent to receive text messages from us regarding your inquiry. Please leave your message after the tone.';
    const consentText = (env.VOICE_CONSENT_SCRIPT || '').trim() || defaultConsentScript;
    const consentScript = escapeXml(consentText);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew-Neural">${consentScript}</Say>
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
      return c.json({ success: false, error: 'unauthorized' }, 401);
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

    let companyName = 'the office';
    try {
      const tenantQuery = await getDb(env)
        .prepare('SELECT company_name FROM tenants WHERE systemix_number = ?')
        .bind(to)
        .first();

      if (tenantQuery?.company_name) {
        companyName = tenantQuery.company_name as string;
      }
    } catch (dbError) {
      console.error('Tenant lookup failed');
      console.error(dbError);
    }

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

    try {
      const providerCallId = callSid || recordingSid || crypto.randomUUID();
      const rawJson = JSON.stringify({
        recordingSid,
        callSid,
        from,
        to,
        recordingUrl,
        recordingDuration,
      });

      await getDb(env)
        .prepare(`
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
        `)
        .bind(
          crypto.randomUUID(),
          'twilio',
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

      console.log('Recording saved to database', { callSid: callSid || 'unknown' });
    } catch (dbError) {
      console.error('Database save failed');
      console.error(dbError);
    }

    try {
      const smsMessage = `New voicemail at ${companyName} from ${from}:\n\n"${transcription}"\n\nMsg&data rates may apply. Reply STOP to opt out.`;
      await sendTwilioSms(env, env.CLIENT_PHONE, smsMessage);
      console.log('Owner notification SMS sent');
    } catch (smsError) {
      console.error('Owner notification SMS failed');
      console.error(smsError);
    }

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error('Recording handler error');
    console.error(error);
    return c.json({ success: false, error: 'processing_failed' }, 200);
  }
}
