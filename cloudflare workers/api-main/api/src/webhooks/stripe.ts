import Stripe from 'stripe';
import type { Context } from 'hono';
import { createLogger } from '../core/logging.ts';
import { getBusinessBillingState } from '../services/billing.ts';
import {
  handleCheckoutCompleted,
  prepareCheckoutCompleted,
  type CheckoutCompletedMetadata,
  verifyStripeWebhook,
} from '../services/stripe.ts';

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
  BILLING_ENABLED?: string;
  HUBSPOT_ACCESS_TOKEN?: string;
  ENVIRONMENT?: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER: string;
  SYSTEMIX_NUMBER: string;
};

const stripeLog = createLogger('[STRIPE]', 'stripeWebhookHandler');

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function scheduleStripeBackgroundTask(
  c: Context<{ Bindings: Bindings }>,
  stripeSessionId: string,
  task: Promise<void>
): void {
  c.executionCtx.waitUntil(
    task.catch((error) =>
      stripeLog.error('Async checkout processing failed', {
        error,
        data: {
          stripeSessionId,
        },
      })
    )
  );
}

function resolveCheckoutMetadata(session: Stripe.Checkout.Session): CheckoutCompletedMetadata {
  const stripeSessionId = asString(session.id);
  const business_number = asString(session.metadata?.business_number);
  const owner_phone_number = asString(session.metadata?.owner_phone_number);
  const consent_given = asOptionalBoolean(session.metadata?.consent_given);
  const consent_source = asString(session.metadata?.consent_source);
  const consent_text = asString(session.metadata?.consent_text);
  const consent_timestamp = asString(session.metadata?.consent_timestamp);

  const primaryDisplayName = asString(session.metadata?.display_name);
  if (primaryDisplayName) {
    stripeLog.log('Primary metadata path used', {
      data: {
        stripeSessionId,
        displayName: primaryDisplayName,
      },
    });

    return {
      business_number,
      owner_phone_number,
      display_name: primaryDisplayName,
      consent_given,
      consent_source,
      consent_text,
      consent_timestamp,
    };
  }

  const customFieldDisplayName = asString(
    session.custom_fields?.find((field) => {
      const key = asString(field.key).toLowerCase();
      return key === 'display_name' || key === 'business_name';
    })?.text?.value
  );

  if (customFieldDisplayName) {
    stripeLog.log('Custom field metadata fallback used', {
      data: {
        stripeSessionId,
        displayName: customFieldDisplayName,
      },
    });

    return {
      business_number,
      owner_phone_number,
      display_name: customFieldDisplayName,
      consent_given,
      consent_source,
      consent_text,
      consent_timestamp,
    };
  }

  const customerDetailsDisplayName = asString(session.customer_details?.name);
  if (customerDetailsDisplayName) {
    stripeLog.log('Customer details metadata fallback used', {
      data: {
        stripeSessionId,
        displayName: customerDetailsDisplayName,
      },
    });
  }

  return {
    business_number,
    owner_phone_number,
    display_name: customerDetailsDisplayName,
    consent_given,
    consent_source,
    consent_text,
    consent_timestamp,
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
    stripeLog.error('Signature verification failed');
    return c.text('Webhook verification failed', 400);
  }

  if (event.type !== 'checkout.session.completed') {
    stripeLog.log('Ignoring non-checkout completion event', {
      data: {
        eventType: event.type,
      },
    });
    return c.text('ok', 200);
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const stripeSessionId = asString(session.id);
  const metadata = resolveCheckoutMetadata(session);

  if (!hasRequiredCheckoutMetadata(metadata)) {
    stripeLog.warn('Onboarding skipped because required fields are missing', {
      data: {
        stripeSessionId,
        businessNumber: metadata.business_number,
        ownerPhoneNumber: metadata.owner_phone_number,
        displayName: metadata.display_name,
      },
    });
    return c.text('ok', 200);
  }

  const billingState = await getBusinessBillingState(c.env.SYSTEMIX, c.env, metadata.business_number);
  if (!billingState.liveBillingAllowed) {
    stripeLog.warn('Stripe checkout onboarding blocked by billing safeguards', {
      data: {
        stripeSessionId,
        businessNumber: metadata.business_number,
        reasonCode: billingState.reasonCode,
      },
    });
    return c.json(
      {
        ok: true,
        blocked: true,
        error: 'billing_blocked',
        reasonCode: billingState.reasonCode,
        reason: billingState.reason,
        billing: billingState,
      },
      200
    );
  }

  stripeLog.log('Scheduling async onboarding', {
    data: {
      stripeSessionId,
      displayName: metadata.display_name,
    },
  });

  scheduleStripeBackgroundTask(
    c,
    stripeSessionId,
    (async () => {
      const preparation = await prepareCheckoutCompleted(session, metadata, c.env);
      if (!preparation.shouldProcess) {
        return;
      }

      stripeLog.log('Checkout claim accepted', {
        data: {
          stripeSessionId,
          displayName: metadata.display_name,
        },
      });

      const result = await handleCheckoutCompleted(session, metadata, c.env);
      if (result.hubspotSynced && result.welcomeSmsSent) {
        stripeLog.log('Onboarding completed successfully', {
          data: {
            stripeSessionId,
            displayName: metadata.display_name,
          },
        });
        return;
      }

      stripeLog.warn('Onboarding completed with partial failures', {
        data: {
          stripeSessionId,
          displayName: metadata.display_name,
          hubspotSynced: result.hubspotSynced,
          welcomeSmsSent: result.welcomeSmsSent,
        },
      });
    })()
  );

  return c.json({ ok: true }, 200);
}
