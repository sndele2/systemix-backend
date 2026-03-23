import { Hono, type Context } from 'hono';
import { twilioVoiceHandler, twilioRecordingHandler } from './webhooks/twilioVoice';
import { checkEmergencyTimeouts, twilioSmsHandler } from './webhooks/twilioSms';
import { twilioStatusHandler } from './webhooks/twilioStatus';
import { stripeWebhookHandler } from './webhooks/stripe';
import { simulateCallbackHandler } from './testing/simulator';
import { upsertBusiness } from './services/database';
import { scheduleTwilioBackgroundTask } from './services/twilioLaunch';

type Bindings = {
  SYSTEMIX: D1Database;
  OPENAI_API_KEY: string;
  CLIENT_PHONE: string;
  OWNER_PHONE_NUMBER?: string;
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
  HUBSPOT_ACCESS_TOKEN?: string;
  INTERNAL_AUTH_KEY?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const productionOnlyStripeWebhookHandler = async (c: Context<{ Bindings: Bindings }>) => {
  if (c.env.ENVIRONMENT !== 'production') {
    console.log('[STRIPE] Webhook route disabled outside production', {
      environment: c.env.ENVIRONMENT ?? 'unset',
    });
    return c.text('Not found', 404);
  }

  return stripeWebhookHandler(c);
};

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/v1/internal/onboard', async (c) => {
  const authKey = c.req.header('x-internal-key');
  if (!c.env.INTERNAL_AUTH_KEY || authKey !== c.env.INTERNAL_AUTH_KEY) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let payload: {
    business_number?: string;
    owner_phone_number?: string;
    display_name?: string;
  };

  try {
    payload = (await c.req.json()) as {
      business_number?: string;
      owner_phone_number?: string;
      display_name?: string;
    };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const business_number = typeof payload.business_number === 'string' ? payload.business_number.trim() : '';
  const owner_phone_number =
    typeof payload.owner_phone_number === 'string' ? payload.owner_phone_number.trim() : '';
  const display_name = typeof payload.display_name === 'string' ? payload.display_name.trim() : '';

  if (!business_number || !owner_phone_number || !display_name) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  scheduleTwilioBackgroundTask(
    c.executionCtx,
    'Manual onboard',
    upsertBusiness({ business_number, owner_phone_number, display_name }, c.env).then(() =>
      console.log('[D1] Manual onboard complete')
    )
  );

  return c.json({ success: true }, 200);
});

// PHASE 1: Answer the phone quickly.
app.post('/v1/webhooks/twilio/voice', twilioVoiceHandler);
app.post('/voice', twilioVoiceHandler);

// PHASE 2: Recording callback persists transcript and notifies owner.
app.post('/v1/webhooks/twilio/recording', twilioRecordingHandler);
app.post('/recording', twilioRecordingHandler);

// Call status callback: sends customer welcome SMS for completed/no-answer/busy calls.
app.post('/v1/webhooks/twilio/status', twilioStatusHandler);
app.post('/status', twilioStatusHandler);

// Inbound SMS: forward lead response to owner.
app.post('/v1/webhooks/twilio/sms', twilioSmsHandler);

// Stripe webhook: create HubSpot company on completed checkout.
app.post('/v1/webhooks/stripe', productionOnlyStripeWebhookHandler);
app.post('/webhooks/stripe', productionOnlyStripeWebhookHandler);

// Testing endpoint (disabled in production in handler).
app.post('/test/simulate-callback', simulateCallbackHandler);

const worker: ExportedHandler<Bindings> = {
  fetch: app.fetch,
  scheduled(_controller, env, ctx) {
    scheduleTwilioBackgroundTask(
      ctx,
      'Emergency timeout check',
      checkEmergencyTimeouts(env).catch((error) => {
        console.error('Emergency timeout scheduled check failed');
        console.error(error);
        throw error;
      })
    );
  },
};

export default worker;
