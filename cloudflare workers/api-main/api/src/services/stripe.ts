import Stripe from 'stripe';
import { upsertBusiness } from './database';
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

  console.log(`[STRIPE] Checkout completed for ${display_name}`);
  await upsertBusiness({ business_number, owner_phone_number, display_name }, env);

  const businessRow = await env.SYSTEMIX.prepare(
    `
      SELECT id, business_number, display_name
      FROM businesses
      WHERE business_number = ?
      LIMIT 1
    `
  ).bind(business_number).first<{ id?: string; business_number?: string; display_name?: string | null }>();

  if (!businessRow?.id) {
    console.log('[STRIPE] ONBOARD SKIPPED: business not found after upsert', {
      business_number,
    });
    return;
  }

  try {
    const hubspotCompanyId = await createHubSpotCompany({
      companyName: asString(businessRow.display_name) || business_number,
      phone: asString(businessRow.business_number),
      accessToken: env.HUBSPOT_ACCESS_TOKEN,
      stripeCustomerId: asString(session.customer),
      stripeSubscriptionId: asString(session.subscription),
    });

    await env.SYSTEMIX.prepare(
      `
        UPDATE businesses
        SET hubspot_company_id = ?1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?2
      `
    ).bind(hubspotCompanyId, businessRow.id).run();

    console.log('[HUBSPOT] SUCCESS');
  } catch (error) {
    console.log('[HUBSPOT] FAILED: ', error);
    throw error;
  }
}
