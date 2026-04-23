import type { Context } from 'hono';
import { createLogger } from '../core/logging.ts';
import { createTwilioRestClient, type TwilioRestClient, type TwilioSendResult } from '../core/sms.ts';
import {
  buildWorkerCallbackUrl,
  checkTwilioSignature,
  formDataToParams,
} from '../core/twilioSignature.ts';
import {
  normalizeCallStatus,
  normalizePhone,
  onboardNewLead,
  scheduleTwilioBackgroundTask,
  shouldFireMissedCallVoiceHook,
} from '../services/twilioLaunch.ts';
import { failWorkflowRun, logWorkflowStep, startWorkflowRun } from '../services/workflow-trace.ts';
import { logConsentEvent } from '../services/smsCompliance.ts';

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
  FALLBACK_NUMBER?: string;
};

const CALL_PROVIDER = 'twilio';
const DEFAULT_VOICE_CONSENT_SCRIPT =
  "Thanks for calling. We're with a customer right now, but we want to help. Leave your name and request after the beep, and look out for a text from us shortly. By staying on the line, you consent to receive texts.";
const DEFAULT_VOICE_FAILURE_MESSAGE =
  'Thank you for calling. We have noted your call and will be in touch shortly.';
const voiceLog = createLogger('[VOICE]', 'twilioVoice');

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
  const dialedNumber = normalizePhone(toPhone);
  if (!dialedNumber) return fallback;

  try {
    const businessRow = await getDb(env)
      .prepare(
        `
        SELECT display_name
        FROM businesses
        WHERE business_number = ?
          AND is_active = 1
        LIMIT 1
      `
      )
      .bind(dialedNumber)
      .first<{ display_name?: string | null }>();

    const displayName = (businessRow?.display_name || '').trim();
    if (displayName) {
      return displayName;
    }
  } catch (error) {
    voiceLog.warn('Business display name lookup failed', {
      error,
      context: {
        handler: 'lookupBusinessNameByDialedNumber',
        toNumber: dialedNumber,
      },
    });
  }

  try {
    const companyRow = await getDb(env)
      .prepare('SELECT company_name FROM tenants WHERE business_number = ? LIMIT 1')
      .bind(dialedNumber)
      .first<{ company_name?: string }>();

    if (companyRow?.company_name) {
      return String(companyRow.company_name);
    }
  } catch (error) {
    voiceLog.warn('Tenant lookup via company name failed', {
      error,
      context: {
        handler: 'lookupBusinessNameByDialedNumber',
        toNumber: dialedNumber,
      },
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
    voiceLog.warn('Tenant lookup via name failed', {
      error,
      context: {
        handler: 'lookupBusinessNameByDialedNumber',
        toNumber: dialedNumber,
      },
    });
  }

  return fallback;
}

function resolveVoiceConsentScript(env: Bindings): string {
  return (env.VOICE_CONSENT_SCRIPT || '').trim() || DEFAULT_VOICE_CONSENT_SCRIPT;
}

function getVoiceConsentScript(env: Bindings): string {
  return escapeXml(resolveVoiceConsentScript(env));
}

function buildFallbackTwiml(message = DEFAULT_VOICE_FAILURE_MESSAGE): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${escapeXml(message)}</Say>
</Response>`;
}

function buildVoicemailTwiml(env: Bindings, requestUrl: string, from: string, to: string): string {
  const consentScript = getVoiceConsentScript(env);
  const recordingStatusCallback = buildWorkerCallbackUrl(
    env,
    requestUrl,
    '/v1/webhooks/twilio/recording',
    new URLSearchParams({
      from,
      to,
    })
  );
  const transcriptionCallback = buildWorkerCallbackUrl(env, requestUrl, '/voicemail-transcription');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${consentScript}</Say>
  <Record
    maxLength="120"
    timeout="10"
    playBeep="true"
    transcribe="true"
    transcribeCallback="${transcriptionCallback}"
    recordingStatusCallback="${recordingStatusCallback.replace(/&/g, '&amp;')}"
    recordingStatusCallbackEvent="completed"
  />
</Response>`;
}

function buildImmediateVoiceResponse(env: Bindings, requestUrl: string, from: string, to: string): string {
  return buildVoicemailTwiml(env, requestUrl, from, to);
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

async function sendOwnerTranscriptSms(
  client: TwilioRestClient,
  toPhone: string,
  fromPhone: string,
  body: string,
  businessNumber?: string
): Promise<TwilioSendResult> {
  if (!fromPhone) {
    return { ok: false, detail: 'missing_twilio_phone_number' };
  }

  try {
    return await client.sendSms({
      toPhone,
      fromPhone,
      body,
      businessNumber,
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
  let twiml = buildFallbackTwiml();

  try {
    const env = c.env;
    const formData = await c.req.formData();
    const params = formDataToParams(formData);
    const from = (formData.get('From') as string) || '';
    const to = (formData.get('To') as string) || '';
    const rawStatus = ((formData.get('CallStatus') as string) || (formData.get('DialCallStatus') as string) || '')
      .trim();
    const callStatus = normalizeCallStatus(rawStatus);
    const callSid = ((formData.get('CallSid') as string) || '').trim();
    const parentCallSid = ((formData.get('ParentCallSid') as string) || '').trim();

    const sig = await checkTwilioSignature(
      env,
      c.req.url,
      params,
      c.req.header('X-Twilio-Signature') || undefined
    );
    if (!sig.ok) {
      voiceLog.error('Twilio voice signature rejected and request processing continued', {
        context: {
          handler: 'twilioVoiceHandler',
          callSid: callSid || parentCallSid,
          fromNumber: from,
          toNumber: to,
        },
        data: {
          mode: sig.mode,
          reason: sig.reason,
        },
      });
    }

    twiml = buildImmediateVoiceResponse(env, c.req.url, from, to);

    scheduleTwilioBackgroundTask(
      c.executionCtx,
      'Voice consent log',
      logConsentEvent(getDb(env), {
        businessNumber: to,
        phoneNumber: from,
        source: 'voice_call',
        consentGiven: true,
        consentText: resolveVoiceConsentScript(env),
        metadata: {
          callSid: callSid || null,
          parentCallSid: parentCallSid || null,
          callStatus,
          rawStatus,
          handler: 'twilioVoiceHandler',
        },
      })
    );

    if (shouldFireMissedCallVoiceHook(callStatus, to)) {
      const backgroundTask = (async () => {
        const requestId = (callSid || parentCallSid || crypto.randomUUID()).trim();
        const runId = await startWorkflowRun(getDb(env), {
          requestId,
          workflowName: 'missed_call_recovery',
          businessNumber: to,
          phoneNumber: from,
          source: 'twilio_voice_webhook',
          summary: 'Twilio voice webhook received',
        });

        try {
          const providerCallId = callSid || parentCallSid;
          await logWorkflowStep(getDb(env), {
            requestId,
            runId,
            stepName: 'inbound_webhook_received',
            input: {
              callSid: callSid || null,
              parentCallSid: parentCallSid || null,
              callStatus,
            },
            output: {
              providerCallId: providerCallId || null,
            },
          });

          if (!providerCallId) {
            throw new Error('missing_call_sid');
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
            voiceLog.log('Voice hook background task deduped', {
              context: {
                handler: 'twilioVoiceHandler',
                callSid: providerCallId,
                fromNumber: from,
                toNumber: to,
              },
              data: {
                status: callStatus,
                deduped: true,
              },
            });
            return;
          }

          const twilioClient = createTwilioRestClient(env);
          if (!twilioClient) {
            await releaseCustomerWelcomeLock(env, providerCallId);
            throw new Error('missing_twilio_credentials');
          }

          const result = await onboardNewLead({
            db: getDb(env),
            twilioClient,
            smsFrom: (env.TWILIO_PHONE_NUMBER || '').trim(),
            businessNumber: to,
            callerNumber: from,
            provider: CALL_PROVIDER,
            providerCallId,
            callStatus,
            rawStatus,
            callSid,
            parentCallSid,
            trace: {
              requestId,
              runId,
            },
          });

          if (!result.ok) {
            await releaseCustomerWelcomeLock(env, providerCallId);
            throw new Error(result.detail);
          }

          voiceLog.log('Voice hook background task completed', {
            context: {
              handler: 'twilioVoiceHandler',
              callSid: providerCallId,
              messageSid: result.messageSid || null,
              fromNumber: result.businessNumber,
              toNumber: result.callerNumber,
            },
            data: {
              status: callStatus,
            },
          });
        } catch (error) {
          await failWorkflowRun(getDb(env), {
            requestId,
            runId,
            errorText: error instanceof Error ? error.message : String(error),
            summary: 'Missed-call recovery workflow failed',
          });
          voiceLog.error('Voice hook background task failed', {
            error,
            context: {
              handler: 'twilioVoiceHandler',
              callSid: callSid || parentCallSid,
              fromNumber: from,
              toNumber: to,
            },
          });
        }
      })();

      if (c.executionCtx?.waitUntil) {
        c.executionCtx.waitUntil(backgroundTask);
      } else {
        void backgroundTask;
      }
    }

    voiceLog.log('Voice webhook accepted', {
      context: {
        handler: 'twilioVoiceHandler',
        callSid: callSid || parentCallSid,
        fromNumber: from,
        toNumber: to,
      },
      data: {
        mode: sig.mode,
      },
    });

    return c.body(twiml, 200, { 'Content-Type': 'application/xml' });
  } catch (error) {
    voiceLog.error('Voice handler failed', {
      error,
      context: {
        handler: 'twilioVoiceHandler',
      },
    });
    return c.body(twiml, 200, { 'Content-Type': 'application/xml' });
  }
}

// ==========================================
// /dial-status CALLBACK ENDPOINT
// ==========================================
export async function twilioDialStatusHandler(c: Context<{ Bindings: Bindings }>) {
  const env = c.env;

  try {
    const formData = await c.req.formData();
    const params = formDataToParams(formData);

    const sig = await checkTwilioSignature(
      env,
      c.req.url,
      params,
      c.req.header('X-Twilio-Signature') || undefined
    );
    const from = (formData.get('From') as string) || '';
    const to = (formData.get('To') as string) || '';
    const dialCallStatus = normalizeCallStatus((formData.get('DialCallStatus') as string) || '');
    if (!sig.ok) {
      voiceLog.error('Twilio dial status signature rejected and request processing continued', {
        context: {
          handler: 'twilioDialStatusHandler',
          fromNumber: from,
          toNumber: to,
        },
        data: {
          mode: sig.mode,
          reason: sig.reason,
        },
      });
    }

    voiceLog.log('Dial status callback received', {
      context: {
        handler: 'twilioDialStatusHandler',
        fromNumber: from,
        toNumber: to,
      },
      data: {
        dialCallStatus: dialCallStatus || 'missing',
        mode: sig.mode,
      },
    });

    if (dialCallStatus === 'completed') {
      return c.body(`<?xml version="1.0" encoding="UTF-8"?><Response/>`, 200, {
        'Content-Type': 'application/xml',
      });
    }

    return c.body(buildVoicemailTwiml(env, c.req.url, from, to), 200, {
      'Content-Type': 'application/xml',
    });
  } catch (error) {
    voiceLog.error('Dial status handler failed', {
      error,
      context: {
        handler: 'twilioDialStatusHandler',
      },
    });
    return c.body(buildFallbackTwiml(), 200, { 'Content-Type': 'application/xml' });
  }
}

// ==========================================
// /voicemail-transcription CALLBACK ENDPOINT
// ==========================================
export async function twilioVoicemailTranscriptionHandler(c: Context<{ Bindings: Bindings }>) {
  const env = c.env;

  try {
    const formData = await c.req.formData();
    const params = formDataToParams(formData);

    const sig = await checkTwilioSignature(
      env,
      c.req.url,
      params,
      c.req.header('X-Twilio-Signature') || undefined
    );
    const callSid = ((formData.get('CallSid') as string) || '').trim();
    const transcriptionText = ((formData.get('TranscriptionText') as string) || '').trim();
    if (!sig.ok) {
      voiceLog.error('Twilio voicemail transcription signature rejected and request processing continued', {
        context: {
          handler: 'twilioVoicemailTranscriptionHandler',
          callSid,
        },
        data: {
          mode: sig.mode,
          reason: sig.reason,
        },
      });
    }

    voiceLog.log('Voicemail transcription callback received', {
      context: {
        handler: 'twilioVoicemailTranscriptionHandler',
        callSid,
      },
      data: {
        chars: transcriptionText.length,
        mode: sig.mode,
      },
    });

    return c.text('', 200);
  } catch (error) {
    voiceLog.error('Voicemail transcription handler failed', {
      error,
      context: {
        handler: 'twilioVoicemailTranscriptionHandler',
      },
    });
    return c.text('', 200);
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
    const url = new URL(c.req.url);
    const from = url.searchParams.get('from') || (formData.get('From') as string) || 'unknown';
    const to = url.searchParams.get('to') || (formData.get('To') as string) || 'unknown';

    const recordingUrl = formData.get('RecordingUrl') as string;
    const recordingSid = formData.get('RecordingSid') as string;
    const callSid = formData.get('CallSid') as string;
    const recordingDuration = formData.get('RecordingDuration') as string;
    if (!sig.ok) {
      voiceLog.error('Twilio recording signature rejected and request processing continued', {
        context: {
          handler: 'twilioRecordingHandler',
          callSid,
          fromNumber: from,
          toNumber: to,
        },
        data: {
          mode: sig.mode,
          reason: sig.reason,
        },
      });
    }

    if (!recordingUrl) {
      voiceLog.error('Recording callback missing recording URL', {
        context: {
          handler: 'twilioRecordingHandler',
          callSid,
          fromNumber: from,
          toNumber: to,
        },
      });
      return c.json({ success: false, error: 'missing_recording' }, 200);
    }

    scheduleTwilioBackgroundTask(
      c.executionCtx,
      'Recording callback',
      (async () => {
        voiceLog.log('Processing recording callback', {
          context: {
            handler: 'twilioRecordingHandler',
            callSid,
            fromNumber: from,
            toNumber: to,
          },
          data: {
            duration: recordingDuration || 'unknown',
            mode: sig.mode,
          },
        });

        const companyName = await lookupBusinessNameByDialedNumber(env, to);

        let audioBlob: Blob | null = null;
        try {
          const audioUrl = recordingUrl.endsWith('.wav') ? recordingUrl : `${recordingUrl}.wav`;
          const headers: Record<string, string> = {};

          if (isTrustedTwilioHost(audioUrl)) {
            headers.Authorization = `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`;
          } else if (env.ENVIRONMENT === 'production') {
            voiceLog.error('Untrusted recording host blocked in production', {
              context: {
                handler: 'twilioRecordingHandler',
                callSid,
                fromNumber: from,
                toNumber: to,
              },
              data: {
                host: new URL(audioUrl).hostname,
              },
            });
            return;
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
            voiceLog.log('Recording audio fetched', {
              context: {
                handler: 'twilioRecordingHandler',
                callSid,
                fromNumber: from,
                toNumber: to,
              },
              data: {
                sizeBytes: audioBlob.size,
              },
            });
          } else {
            voiceLog.error('Recording audio fetch failed', {
              context: {
                handler: 'twilioRecordingHandler',
                callSid,
                fromNumber: from,
                toNumber: to,
              },
              data: {
                status: audioResponse.status,
              },
            });
          }
        } catch (audioError) {
          voiceLog.error('Recording audio fetch threw an exception', {
            error: audioError,
            context: {
              handler: 'twilioRecordingHandler',
              callSid,
              fromNumber: from,
              toNumber: to,
            },
          });
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
              voiceLog.log('Whisper transcription completed', {
                context: {
                  handler: 'twilioRecordingHandler',
                  callSid,
                  fromNumber: from,
                  toNumber: to,
                },
                data: {
                  chars: transcription.length,
                },
              });
            } else {
              const errorText = await whisperResponse.text();
              voiceLog.error('Whisper API failed', {
                context: {
                  handler: 'twilioRecordingHandler',
                  callSid,
                  fromNumber: from,
                  toNumber: to,
                },
                data: {
                  status: whisperResponse.status,
                  detail: errorText,
                },
              });
            }
          } catch (whisperError) {
            voiceLog.error('Whisper transcription threw an exception', {
              error: whisperError,
              context: {
                handler: 'twilioRecordingHandler',
                callSid,
                fromNumber: from,
                toNumber: to,
              },
            });
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

        const customerWelcomeLock = await getDb(env)
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

        if (Number(customerWelcomeLock.meta?.changes || 0) > 0) {
          try {
            const twilioClient = createTwilioRestClient(env);
            if (!twilioClient) {
              await releaseCustomerWelcomeLock(env, providerCallId);
              throw new Error('missing_twilio_credentials');
            }

            const callerFollowUp = await onboardNewLead({
              db: getDb(env),
              twilioClient,
              smsFrom: (env.TWILIO_PHONE_NUMBER || '').trim(),
              businessNumber: to,
              callerNumber: from,
              provider: CALL_PROVIDER,
              providerCallId,
              callStatus: 'completed',
              rawStatus: 'voicemail_recording_completed',
              callSid,
            });

            if (!callerFollowUp.ok) {
              await releaseCustomerWelcomeLock(env, providerCallId);
              throw new Error(callerFollowUp.detail);
            }

            voiceLog.log('Caller follow-up SMS sent from recording callback', {
              context: {
                handler: 'twilioRecordingHandler',
                callSid,
                messageSid: callerFollowUp.messageSid || null,
                fromNumber: callerFollowUp.businessNumber,
                toNumber: callerFollowUp.callerNumber,
              },
            });
          } catch (customerWelcomeError) {
            voiceLog.error('Caller follow-up SMS failed from recording callback', {
              error: customerWelcomeError,
              context: {
                handler: 'twilioRecordingHandler',
                callSid,
                fromNumber: to,
                toNumber: from,
              },
            });
          }
        } else {
          voiceLog.log('Caller follow-up SMS deduped for recording callback', {
            context: {
              handler: 'twilioRecordingHandler',
              callSid,
              fromNumber: to,
              toNumber: from,
            },
          });
        }

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
          return;
        }

        const ownerPhone = (env.OWNER_PHONE_NUMBER || '').trim();
        if (!ownerPhone) {
          await releaseOwnerTranscriptLock(env, providerCallId);
          throw new Error('missing_owner_phone_number');
        }

        const twilioClient = createTwilioRestClient(env);
        if (!twilioClient) {
          await releaseOwnerTranscriptLock(env, providerCallId);
          throw new Error('missing_twilio_credentials');
        }

        const smsMessage = `New voicemail for ${companyName} from ${from}: "${transcription}"`;
        const sms = await sendOwnerTranscriptSms(
          twilioClient,
          ownerPhone,
          (env.TWILIO_PHONE_NUMBER || '').trim(),
          smsMessage,
          to
        );

        if (!sms.ok) {
          await releaseOwnerTranscriptLock(env, providerCallId);
          throw new Error(sms.detail || 'sms_failed');
        }

        if (sms.suppressed) {
          voiceLog.log('Owner transcript SMS suppressed because recipient is opted out', {
            context: {
              handler: 'twilioRecordingHandler',
              callSid,
              fromNumber: to,
              toNumber: ownerPhone,
            },
          });
          return;
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

        voiceLog.log('Owner transcript SMS sent', {
          context: {
            handler: 'twilioRecordingHandler',
            callSid,
            messageSid: sms.sid || null,
            fromNumber: (env.TWILIO_PHONE_NUMBER || '').trim(),
            toNumber: ownerPhone,
          },
        });
      })()
    );

    return c.json({ success: true, queued: true }, 200);
  } catch (error) {
    voiceLog.error('Recording handler failed', {
      error,
      context: {
        handler: 'twilioRecordingHandler',
      },
    });
    return c.json({ success: false, error: 'processing_failed' }, 200);
  }
}
