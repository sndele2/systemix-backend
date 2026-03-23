import Stripe from 'stripe';
import { Context } from 'hono';
import {
  handleCheckoutCompleted,
  prepareCheckoutCompleted,
  type CheckoutCompletedMetadata,
  verifyStripeWebhook,
} from '../services/stripe';

type Bindings = {
  SYSTEMIX: D1Database;
  OPENAI_API_KEY: string;
  CLIENT_PHONE: string;
  OWNER_PHONE_NUMBER?: string;
  TWILIO_SIGNATURE_MODE?: string;
  WORKER_URL?: string;
  SIMULATOR_API_KEY?: string;
  VOICE_CONSENT_SCRIPT?: string;
  MISSED_CALL_SMS_SCRIPT?: string;
  INTERNAL_AUTH_KEY?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  HUBSPOT_ACCESS_TOKEN?: string;
  ENVIRONMENT?: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER: string;
  SYSTEMIX_NUMBER: string;
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function scheduleStripeBackgroundTask(
  c: Context<{ Bindings: Bindings }>,
  stripeSessionId: string,
  task: Promise<void>
): void {
  c.executionCtx.waitUntil(
    task.catch((error) =>
      console.log('[STRIPE] Async checkout processing failed', {
        stripeSessionId,
        error: describeError(error),
      })
    )
  );
}

function resolveCheckoutMetadata(session: Stripe.Checkout.Session): CheckoutCompletedMetadata {
  const stripeSessionId = asString(session.id);
  const business_number = asString(session.metadata?.business_number);
  const owner_phone_number = asString(session.metadata?.owner_phone_number);

  const primaryDisplayName = asString(session.metadata?.display_name);
  if (primaryDisplayName) {
    console.log('[STRIPE] Primary metadata path used', {
      stripeSessionId,
      display_name: primaryDisplayName,
    });

    return {
      business_number,
      owner_phone_number,
      display_name: primaryDisplayName,
    };
  }

  const customFieldDisplayName = asString(
    session.custom_fields?.find((field) => {
      const key = asString(field.key).toLowerCase();
      return key === 'display_name' || key === 'business_name';
    })?.text?.value
  );

  if (customFieldDisplayName) {
    console.log('[STRIPE] Fallback 1 used', {
      stripeSessionId,
      display_name: customFieldDisplayName,
    });

    return {
      business_number,
      owner_phone_number,
      display_name: customFieldDisplayName,
    };
  }

  const customerDetailsDisplayName = asString(session.customer_details?.name);
  if (customerDetailsDisplayName) {
    console.log('[STRIPE] Fallback 2 used', {
      stripeSessionId,
      display_name: customerDetailsDisplayName,
    });
  }

  return {
    business_number,
    owner_phone_number,
    display_name: customerDetailsDisplayName,
  };
}

function hasRequiredCheckoutMetadata(metadata: CheckoutCompletedMetadata): boolean {
  return Boolean(
    metadata.business_number && metadata.owner_phone_number && metadata.display_name
  );
}

export async function stripeWebhookHandler(c: Context<{ Bindings: Bindings }>) {
  const signature = c.req.header('stripe-signature') || '';
  const body = await c.req.text();

  let event: Stripe.Event;
  try {
    event = await verifyStripeWebhook(body, signature, c.env);
  } catch {
    console.log('[STRIPE] Signature verification failed');
    return c.text('Webhook verification failed', 400);
  }

  if (event.type !== 'checkout.session.completed') {
    console.log('[STRIPE] Ignoring non-checkout completion event', {
      eventType: event.type,
    });
    return c.text('ok', 200);
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const stripeSessionId = asString(session.id);
  const metadata = resolveCheckoutMetadata(session);

  if (!hasRequiredCheckoutMetadata(metadata)) {
    console.log('[STRIPE] Onboard skipped: missing required fields', {
      stripeSessionId,
      business_number: metadata.business_number,
      owner_phone_number: metadata.owner_phone_number,
      display_name: metadata.display_name,
    });
    return c.text('ok', 200);
  }

  console.log('[STRIPE] Scheduling async onboarding', {
    stripeSessionId,
    display_name: metadata.display_name,
  });

  scheduleStripeBackgroundTask(
    c,
    stripeSessionId,
    (async () => {
      const preparation = await prepareCheckoutCompleted(session, metadata, c.env);
      if (!preparation.shouldProcess) {
        return;
      }

      console.log('[STRIPE] Checkout claim accepted', {
        stripeSessionId,
        display_name: metadata.display_name,
      });

      const result = await handleCheckoutCompleted(session, metadata, c.env);
      if (result.hubspotSynced && result.welcomeSmsSent) {
        console.log('[STRIPE] Onboard success', {
          stripeSessionId,
          display_name: metadata.display_name,
        });
        return;
      }

      console.log('[STRIPE] Onboard completed with errors', {
        stripeSessionId,
        display_name: metadata.display_name,
        hubspotSynced: result.hubspotSynced,
        welcomeSmsSent: result.welcomeSmsSent,
      });
    })()
  );

  return c.text('ok', 200);
}
