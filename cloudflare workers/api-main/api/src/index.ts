import { Hono } from 'hono';
import { twilioVoiceHandler, twilioRecordingHandler } from './webhooks/twilioVoice';
import { twilioSmsHandler } from './webhooks/twilioSms';
import { twilioStatusHandler } from './webhooks/twilioStatus';
import { simulateCallbackHandler } from './testing/simulator';

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
  SIMULATOR_API_KEY?: string;
  VOICE_CONSENT_SCRIPT?: string;
  MISSED_CALL_SMS_SCRIPT?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ status: 'ok' }));

// PHASE 1: Answer the phone quickly.
app.post('/v1/webhooks/twilio/voice', twilioVoiceHandler);
app.post('/voice', twilioVoiceHandler);

// PHASE 2: Process recording callback.
app.post('/v1/webhooks/twilio/recording', twilioRecordingHandler);
app.post('/recording', twilioRecordingHandler);

// Call status callback: sends missed-call follow-up SMS for no-answer/busy/canceled.
app.post('/v1/webhooks/twilio/status', twilioStatusHandler);
app.post('/status', twilioStatusHandler);

// Inbound SMS: forward lead response to owner.
app.post('/v1/webhooks/twilio/sms', twilioSmsHandler);

// Testing endpoint (disabled in production in handler).
app.post('/test/simulate-callback', simulateCallbackHandler);

export default app;
