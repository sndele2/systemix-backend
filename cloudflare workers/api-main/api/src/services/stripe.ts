import Stripe from 'stripe';
import { sendBusinessWelcomeSms } from './database';
import {
  associateContactToCompany,
  createHubSpotCompany,
  deleteHubSpotCompany,
  upsertHubSpotContactByPhone,
} from './hubspot';

type StripeEnv = {
  SYSTEMIX: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  HUBSPOT_ACCESS_TOKEN?: string;
  ENVIRONMENT?: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER?: string;
  SYSTEMIX_NUMBER: string;
};

export type CheckoutCompletedMetadata = {
  business_number: string;
  owner_phone_number: string;
  display_name: string;
};

function createStripeClient(env: StripeEnv): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

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

function isProductionEnvironment(env: Pick<StripeEnv, 'ENVIRONMENT'>): boolean {
  return env.ENVIRONMENT === 'production';
}

type CheckoutCompletedPreparation =
  | { shouldProcess: false }
  | {
      shouldProcess: true;
      business_number: string;
      owner_phone_number: string;
      display_name: string;
    };

type CheckoutCompletedResult = {
  hubspotSynced: boolean;
  welcomeSmsSent: boolean;
};

type ExistingBusinessRow = {
  business_number?: string;
  last_stripe_session_id?: string | null;
};

type ExistingSessionOwnerRow = {
  business_number?: string;
};

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('unique') && normalized.includes('constraint');
}

async function findBusinessByNumber(
  env: StripeEnv,
  businessNumber: string
): Promise<ExistingBusinessRow | null> {
  return (await env.SYSTEMIX.prepare(
    `
      SELECT business_number, last_stripe_session_id
      FROM businesses
      WHERE business_number = ?
      LIMIT 1
    `
  ).bind(businessNumber).first<ExistingBusinessRow>()) ?? null;
}

async function findSessionOwner(
  env: StripeEnv,
  stripeSessionId: string
): Promise<ExistingSessionOwnerRow | null> {
  return (await env.SYSTEMIX.prepare(
    `
      SELECT business_number
      FROM businesses
      WHERE last_stripe_session_id = ?
      LIMIT 1
    `
  ).bind(stripeSessionId).first<ExistingSessionOwnerRow>()) ?? null;
}

function logDuplicateStripeSession(
  businessNumber: string,
  stripeSessionId: string,
  source: string
): void {
  console.log('[STRIPE] Duplicate checkout session ignored', {
    business_number: businessNumber,
    stripeSessionId,
    source,
  });
}

function logStripeSessionConflict(
  businessNumber: string,
  stripeSessionId: string,
  existingBusinessNumber: string,
  source: string
): void {
  console.log('[STRIPE] Checkout session already claimed by different business', {
    business_number: businessNumber,
    stripeSessionId,
    existing_business_number: existingBusinessNumber,
    source,
  });
}

function hasRequiredCheckoutMetadata(metadata: CheckoutCompletedMetadata): boolean {
  return Boolean(
    metadata.business_number && metadata.owner_phone_number && metadata.display_name
  );
}

async function syncCheckoutCompletedHubSpot(
  session: Stripe.Checkout.Session,
  metadata: CheckoutCompletedMetadata,
  env: StripeEnv
): Promise<void> {
  const hubspotContactId = await upsertHubSpotContactByPhone({
    phone: metadata.owner_phone_number,
    accessToken: env.HUBSPOT_ACCESS_TOKEN,
  });

  const hubspotCompanyId = await createHubSpotCompany({
    companyName: metadata.display_name || metadata.business_number,
    phone: metadata.business_number,
    accessToken: env.HUBSPOT_ACCESS_TOKEN,
    stripeCustomerId: asString(session.customer),
    stripeSubscriptionId: asString(session.subscription),
  });

  try {
    await associateContactToCompany(hubspotContactId, hubspotCompanyId, env.HUBSPOT_ACCESS_TOKEN);
  } catch (error) {
    await deleteHubSpotCompany(hubspotCompanyId, env.HUBSPOT_ACCESS_TOKEN).catch(
      (rollbackError) => {
        console.log('[STRIPE] HubSpot rollback failed', {
          business_number: metadata.business_number,
          error: describeError(rollbackError),
        });
      }
    );
    throw error;
  }

  await env.SYSTEMIX.prepare(
    `
      UPDATE businesses
      SET hubspot_company_id = ?1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE business_number = ?2
    `
  ).bind(hubspotCompanyId, metadata.business_number).run();
}

export async function verifyStripeWebhook(
  body: string,
  signature: string,
  env: StripeEnv
): Promise<Stripe.Event> {
  if (!isProductionEnvironment(env)) {
    console.log('[STRIPE] Webhook verification rejected outside production', {
      environment: env.ENVIRONMENT ?? 'unset',
    });
    throw new Error('stripe_webhook_disabled_outside_production');
  }

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
  metadata: CheckoutCompletedMetadata,
  env: StripeEnv
): Promise<CheckoutCompletedResult> {
  if (!isProductionEnvironment(env)) {
    console.log('[STRIPE] Checkout completion skipped outside production', {
      environment: env.ENVIRONMENT ?? 'unset',
    });
    return { hubspotSynced: false, welcomeSmsSent: false };
  }

  const stripeSessionId = asString(session.id);
  if (!hasRequiredCheckoutMetadata(metadata)) {
    console.log('[STRIPE] Onboard skipped in async handler: missing required fields', {
      stripeSessionId,
      business_number: metadata.business_number,
      owner_phone_number: metadata.owner_phone_number,
      display_name: metadata.display_name,
    });
    return { hubspotSynced: false, welcomeSmsSent: false };
  }

  console.log('[STRIPE] Processing checkout completion', {
    stripeSessionId,
    display_name: metadata.display_name,
  });

  const [welcomeSmsResult, hubspotResult] = await Promise.allSettled([
    sendBusinessWelcomeSms(env, metadata.owner_phone_number, metadata.business_number),
    syncCheckoutCompletedHubSpot(session, metadata, env),
  ]);

  const welcomeSmsSent = welcomeSmsResult.status === 'fulfilled';
  if (welcomeSmsSent) {
    console.log('[STRIPE] Twilio welcome SMS sent', {
      stripeSessionId,
      owner_phone_number: metadata.owner_phone_number,
    });
  } else {
    console.log('[STRIPE] Twilio welcome SMS failed', {
      stripeSessionId,
      owner_phone_number: metadata.owner_phone_number,
      error: describeError(welcomeSmsResult.reason),
    });
  }

  const hubspotSynced = hubspotResult.status === 'fulfilled';
  if (hubspotSynced) {
    console.log('[STRIPE] HubSpot sync complete', {
      stripeSessionId,
      business_number: metadata.business_number,
    });
  } else {
    console.log('[STRIPE] HubSpot sync failed', {
      stripeSessionId,
      business_number: metadata.business_number,
      error: describeError(hubspotResult.reason),
    });
  }

  return {
    hubspotSynced,
    welcomeSmsSent,
  };
}

export async function prepareCheckoutCompleted(
  session: Stripe.Checkout.Session,
  metadata: CheckoutCompletedMetadata,
  env: StripeEnv
): Promise<CheckoutCompletedPreparation> {
  if (!isProductionEnvironment(env)) {
    console.log('[STRIPE] Checkout preparation skipped outside production', {
      environment: env.ENVIRONMENT ?? 'unset',
    });
    return { shouldProcess: false };
  }

  const business_number = metadata.business_number;
  const owner_phone_number = metadata.owner_phone_number;
  const display_name = metadata.display_name;
  const stripeSessionId = asString(session.id);

  if (!hasRequiredCheckoutMetadata(metadata) || !stripeSessionId) {
    console.log('[STRIPE] Onboard skipped during claim: missing required fields', {
      business_number,
      owner_phone_number,
      display_name,
      stripeSessionId,
    });
    return { shouldProcess: false };
  }

  const existingBusiness = await findBusinessByNumber(env, business_number);
  const existingSessionOwner = await findSessionOwner(env, stripeSessionId);
  const existingSessionBusinessNumber = asString(existingSessionOwner?.business_number);

  if (existingSessionBusinessNumber) {
    if (existingSessionBusinessNumber === business_number) {
      logDuplicateStripeSession(business_number, stripeSessionId, 'precheck');
    } else {
      logStripeSessionConflict(
        business_number,
        stripeSessionId,
        existingSessionBusinessNumber,
        'precheck'
      );
    }
    return { shouldProcess: false };
  }

  let claim: D1Result;

  try {
    claim = await env.SYSTEMIX.prepare(
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
           OR businesses.last_stripe_session_id = ''
           OR businesses.last_stripe_session_id != excluded.last_stripe_session_id
      `
    )
      .bind(business_number, owner_phone_number, display_name, stripeSessionId)
      .run();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const claimedSessionOwner = await findSessionOwner(env, stripeSessionId);
    const claimedBusinessNumber = asString(claimedSessionOwner?.business_number);
    if (claimedBusinessNumber === business_number) {
      logDuplicateStripeSession(business_number, stripeSessionId, 'unique_constraint_race');
      return { shouldProcess: false };
    }

    if (claimedBusinessNumber) {
      logStripeSessionConflict(
        business_number,
        stripeSessionId,
        claimedBusinessNumber,
        'unique_constraint_race'
      );
      return { shouldProcess: false };
    }

    throw error;
  }

  if (Number(claim.meta?.changes || 0) === 0) {
    const claimedSessionOwner = await findSessionOwner(env, stripeSessionId);
    const claimedBusinessNumber = asString(claimedSessionOwner?.business_number);

    if (claimedBusinessNumber === business_number) {
      logDuplicateStripeSession(business_number, stripeSessionId, 'post_claim_check');
      return { shouldProcess: false };
    }

    if (claimedBusinessNumber) {
      logStripeSessionConflict(
        business_number,
        stripeSessionId,
        claimedBusinessNumber,
        'post_claim_check'
      );
      return { shouldProcess: false };
    }

    if (asString(existingBusiness?.business_number)) {
      console.log('[STRIPE] Checkout claim skipped with no database changes', {
        business_number,
        stripeSessionId,
        previous_last_stripe_session_id: asString(existingBusiness?.last_stripe_session_id),
      });
    }
    return { shouldProcess: false };
  }

  return {
    shouldProcess: true,
    business_number,
    owner_phone_number,
    display_name,
  };
}
