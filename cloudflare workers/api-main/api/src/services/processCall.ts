import { fetchRecordingAudio, transcribeWhisper } from '../core/audio';
import { sendTwilioSms } from '../core/sms';

type ProcessCallParams = {
  callSid: string;
  fromPhone: string;
  toPhone?: string;
  recordingUrl: string;
};

type ProcessCallDeps = {
  env: {
    SYSTEMIX: D1Database;
    OPENAI_API_KEY: string;
    CLIENT_PHONE: string;
    TWILIO_ACCOUNT_SID: string;
    TWILIO_AUTH_TOKEN: string;
    TWILIO_PHONE_NUMBER?: string;
    SYSTEMIX_NUMBER: string;
  };
};

export async function processCall(params: ProcessCallParams, deps: ProcessCallDeps): Promise<void> {
  const { callSid, fromPhone, toPhone, recordingUrl } = params;
  const env = deps.env;

  let tenantName = 'the office';
  try {
    const tenantQuery = await env.SYSTEMIX
      .prepare('SELECT company_name FROM tenants WHERE systemix_number = ?')
      .bind(toPhone || '')
      .first();

    if (tenantQuery?.company_name) {
      tenantName = String(tenantQuery.company_name);
    }
  } catch (e) {
    console.error('Tenant lookup failed:', e);
  }

  try {
    const statusRow = await env.SYSTEMIX
      .prepare('SELECT status FROM calls WHERE provider_call_id = ?')
      .bind(callSid)
      .first();

    if (statusRow?.status && String(statusRow.status) === 'completed') {
      console.log('Phase 2 skipped (already completed)', { callSid });
      return;
    }

    await env.SYSTEMIX
      .prepare('UPDATE calls SET status = ?, recording_url = ? WHERE provider_call_id = ?')
      .bind('recorded', recordingUrl, callSid)
      .run();

    console.log('PHASE 2 START:', { recordingUrl });

    let transcript = 'Voice message received';
    const audioResult = await fetchRecordingAudio(recordingUrl, env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    if (audioResult.blob && audioResult.status === 200) {
      try {
        transcript = await transcribeWhisper(env.OPENAI_API_KEY, audioResult.blob);
      } catch (e) {
        console.error('Whisper transcription failed:', e);
        transcript = 'Voice message received';
      }
    } else {
      console.warn('Audio unavailable; continuing without Whisper.');
    }

    try {
      await env.SYSTEMIX
        .prepare('UPDATE calls SET transcription = ? WHERE provider_call_id = ?')
        .bind(transcript, callSid)
        .run();
      console.log('TRANSCRIPTION SUCCESS', { chars: transcript.length });
    } catch (e) {
      console.error('D1 transcription update failed:', e);
    }

    const smsMessage = `Hi, this is the team at ${tenantName || 'the office'}. We missed your call regarding: "${transcript}". We will follow up shortly! Msg&data rates may apply. Reply STOP to opt out.`;
    await sendTwilioSms(env, fromPhone, smsMessage);
    console.log('SUCCESS: SMS SENT');

    await sendTwilioSms(env, env.CLIENT_PHONE, smsMessage);
    console.log('SUCCESS: SMS SENT');

    await env.SYSTEMIX
      .prepare('UPDATE calls SET status = ? WHERE provider_call_id = ?')
      .bind('completed', callSid)
      .run();
  } catch (error) {
    console.error('Phase 2 Error:', error);
  }
}
