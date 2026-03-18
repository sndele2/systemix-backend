import Stripe from 'stripe';
import { sendBusinessWelcomeSms } from './database';
import { createHubSpotCompany } from './hubspot';

type StripeEnv = {
  SYSTEMIX: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  HUBSPOT_ACCESS_TOKEN?: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER?: string;
  SYSTEMIX_NUMBER: string;
};

function createStripeClient(env: StripeEnv): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

type CheckoutCompletedPreparation =
  | { shouldProcess: false }
  | {
      shouldProcess: true;
      business_number: string;
      owner_phone_number: string;
      display_name: string;
    };

export async function verifyStripeWebhook(
  body: string,
  signature: string,
  env: StripeEnv
): Promise<Stripe.Event> {
  const stripe = createStripeClient(env);
  const cryptoProvider = Stripe.createSubtleCryptoProvider();

  try {
    const event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      cryptoProvider
    );
    console.log(`[STRIPE] Webhook received: ${event.type}`);
    return event;
  } catch (error) {
    console.log('[STRIPE] Webhook verification failed: ', error);
    throw error;
  }
}

export async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  env: StripeEnv
): Promise<void> {
  const business_number = asString(session.metadata?.business_number);
  const owner_phone_number = asString(session.metadata?.owner_phone_number);
  const display_name = asString(session.metadata?.display_name);

  if (!business_number || !owner_phone_number || !display_name) {
    console.log('[STRIPE] ONBOARD SKIPPED: missing metadata fields', {
      business_number,
      owner_phone_number,
      display_name,
    });
    return;
  }

  console.log(`[STRIPE] Processing checkout completion for ${display_name}`);
  await sendBusinessWelcomeSms(env, owner_phone_number, business_number);

  try {
    const hubspotCompanyId = await createHubSpotCompany({
      companyName: display_name || business_number,
      phone: business_number,
      accessToken: env.HUBSPOT_ACCESS_TOKEN,
      stripeCustomerId: asString(session.customer),
      stripeSubscriptionId: asString(session.subscription),
    });

    await env.SYSTEMIX.prepare(
      `
        UPDATE businesses
        SET hubspot_company_id = ?1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE business_number = ?2
      `
    ).bind(hubspotCompanyId, business_number).run();

    console.log('[HUBSPOT] SUCCESS');
  } catch (error) {
    console.log('[HUBSPOT] FAILED: ', error);
    throw error;
  }
}

export async function prepareCheckoutCompleted(
  session: Stripe.Checkout.Session,
  env: StripeEnv
): Promise<CheckoutCompletedPreparation> {
  const business_number = asString(session.metadata?.business_number);
  const owner_phone_number = asString(session.metadata?.owner_phone_number);
  const display_name = asString(session.metadata?.display_name);
  const stripeSessionId = asString(session.id);

  if (!business_number || !owner_phone_number || !display_name || !stripeSessionId) {
    console.log('[STRIPE] ONBOARD SKIPPED: missing metadata fields', {
      business_number,
      owner_phone_number,
      display_name,
      stripeSessionId,
    });
    return { shouldProcess: false };
  }

  const businessRow = await env.SYSTEMIX.prepare(
    `
      SELECT business_number, last_stripe_session_id
      FROM businesses
      WHERE business_number = ?
      LIMIT 1
    `
  ).bind(business_number).first<{ business_number?: string; last_stripe_session_id?: string | null }>();

  if (asString(businessRow?.last_stripe_session_id) === stripeSessionId) {
    console.log('[STRIPE] Duplicate checkout session ignored', {
      business_number,
      stripeSessionId,
    });
    return { shouldProcess: false };
  }

  const claim = await env.SYSTEMIX.prepare(
    `
      INSERT INTO businesses (
        id,
        business_number,
        owner_phone_number,
        display_name,
        last_stripe_session_id,
        created_at,
        updated_at
      )
      VALUES (
        lower(hex(randomblob(16))),
        ?1,
        ?2,
        ?3,
        ?4,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now')
      )
      ON CONFLICT(business_number)
      DO UPDATE SET
        owner_phone_number = excluded.owner_phone_number,
        display_name = excluded.display_name,
        last_stripe_session_id = excluded.last_stripe_session_id,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE businesses.last_stripe_session_id IS NULL
         OR businesses.last_stripe_session_id != excluded.last_stripe_session_id
    `
  )
    .bind(business_number, owner_phone_number, display_name, stripeSessionId)
    .run();

  if (Number(claim.meta?.changes || 0) === 0) {
    console.log('[STRIPE] Duplicate checkout session ignored after atomic claim', {
      business_number,
      stripeSessionId,
    });
    return { shouldProcess: false };
  }

  return {
    shouldProcess: true,
    business_number,
    owner_phone_number,
    display_name,
  };
}
