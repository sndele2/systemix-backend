import { fetchRecordingAudio, transcribeWhisper } from '../core/audio.ts';
import { createLogger } from '../core/logging.ts';
import { sendTwilioSms } from '../core/sms.ts';

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

const voiceLog = createLogger('[VOICE]', 'processCall');

export async function processCall(params: ProcessCallParams, deps: ProcessCallDeps): Promise<void> {
  const { callSid, fromPhone, toPhone, recordingUrl } = params;
  const env = deps.env;

  let tenantName = 'the office';
  try {
    const tenantQuery = await env.SYSTEMIX
      .prepare('SELECT company_name FROM tenants WHERE business_number = ?')
      .bind(toPhone || '')
      .first();

    if (tenantQuery?.company_name) {
      tenantName = String(tenantQuery.company_name);
    }
  } catch (e) {
    voiceLog.error('Tenant lookup failed', {
      error: e,
      context: {
        callSid,
        fromNumber: fromPhone,
        toNumber: toPhone,
      },
    });
  }

  try {
    const statusRow = await env.SYSTEMIX
      .prepare('SELECT status FROM calls WHERE provider_call_id = ?')
      .bind(callSid)
      .first();

    if (statusRow?.status && String(statusRow.status) === 'completed') {
      voiceLog.log('Phase 2 skipped because the call is already completed', {
        context: {
          callSid,
          fromNumber: fromPhone,
          toNumber: toPhone,
        },
      });
      return;
    }

    await env.SYSTEMIX
      .prepare('UPDATE calls SET status = ?, recording_url = ? WHERE provider_call_id = ?')
      .bind('recorded', recordingUrl, callSid)
      .run();

    voiceLog.log('Phase 2 processing started', {
      context: {
        callSid,
        fromNumber: fromPhone,
        toNumber: toPhone,
      },
      data: {
        recordingUrl,
      },
    });

    let transcript = 'Voice message received';
    const audioResult = await fetchRecordingAudio(recordingUrl, env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    if (audioResult.blob && audioResult.status === 200) {
      try {
        transcript = await transcribeWhisper(env.OPENAI_API_KEY, audioResult.blob);
      } catch (e) {
        voiceLog.error('Whisper transcription failed', {
          error: e,
          context: {
            callSid,
            fromNumber: fromPhone,
            toNumber: toPhone,
          },
        });
        transcript = 'Voice message received';
      }
    } else {
      voiceLog.warn('Audio unavailable; continuing without Whisper', {
        context: {
          callSid,
          fromNumber: fromPhone,
          toNumber: toPhone,
        },
      });
    }

    try {
      await env.SYSTEMIX
        .prepare('UPDATE calls SET transcription = ? WHERE provider_call_id = ?')
        .bind(transcript, callSid)
        .run();
      voiceLog.log('Transcription persisted', {
        context: {
          callSid,
          fromNumber: fromPhone,
          toNumber: toPhone,
        },
        data: {
          chars: transcript.length,
        },
      });
    } catch (e) {
      voiceLog.error('Transcription persistence failed', {
        error: e,
        context: {
          callSid,
          fromNumber: fromPhone,
          toNumber: toPhone,
        },
      });
    }

    const smsMessage = `Hi, this is the team at ${tenantName || 'the office'}. We missed your call regarding: "${transcript}". We will follow up shortly!`;
    await sendTwilioSms(env, fromPhone, smsMessage, {
      businessNumber: toPhone || env.TWILIO_PHONE_NUMBER || env.SYSTEMIX_NUMBER,
      appendComplianceFooter: true,
    });
    voiceLog.log('Customer SMS sent', {
      context: {
        callSid,
        fromNumber: env.TWILIO_PHONE_NUMBER || env.SYSTEMIX_NUMBER,
        toNumber: fromPhone,
      },
    });

    await sendTwilioSms(env, env.CLIENT_PHONE, smsMessage, {
      businessNumber: toPhone || env.TWILIO_PHONE_NUMBER || env.SYSTEMIX_NUMBER,
    });
    voiceLog.log('Client notification SMS sent', {
      context: {
        callSid,
        fromNumber: env.TWILIO_PHONE_NUMBER || env.SYSTEMIX_NUMBER,
        toNumber: env.CLIENT_PHONE,
      },
    });

    await env.SYSTEMIX
      .prepare('UPDATE calls SET status = ? WHERE provider_call_id = ?')
      .bind('completed', callSid)
      .run();
  } catch (error) {
    voiceLog.error('Phase 2 processing failed', {
      error,
      context: {
        callSid,
        fromNumber: fromPhone,
        toNumber: toPhone,
      },
    });
  }
}
