import Stripe from 'stripe';
import { createLogger } from '../core/logging.ts';
import { logConsentEvent } from './smsCompliance.ts';
import { sendBusinessWelcomeSms } from './database.ts';
import { getBusinessBillingState } from './billing.ts';
import {
  associateContactToCompany,
  createHubSpotCompany,
  deleteHubSpotCompany,
  upsertHubSpotContactByPhone,
} from './hubspot.ts';

type StripeEnv = {
  SYSTEMIX: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  BILLING_ENABLED?: string;
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
  consent_given?: boolean;
  consent_source?: string;
  consent_text?: string;
  consent_timestamp?: string;
};

const stripeLog = createLogger('[STRIPE]', 'stripeService');

function createStripeClient(env: StripeEnv): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
  stripeLog.log('Duplicate checkout session ignored', {
    context: {
      handler: 'prepareCheckoutCompleted',
    },
    data: {
      businessNumber,
      stripeSessionId,
      source,
    },
  });
}

function logStripeSessionConflict(
  businessNumber: string,
  stripeSessionId: string,
  existingBusinessNumber: string,
  source: string
): void {
  stripeLog.warn('Checkout session already claimed by a different business', {
    context: {
      handler: 'prepareCheckoutCompleted',
    },
    data: {
      businessNumber,
      stripeSessionId,
      existingBusinessNumber,
      source,
    },
  });
}

function hasRequiredCheckoutMetadata(metadata: CheckoutCompletedMetadata): boolean {
  return Boolean(
    metadata.business_number && metadata.owner_phone_number && metadata.display_name
  );
}

function hasConsentMetadata(metadata: CheckoutCompletedMetadata): boolean {
  return Boolean(
    typeof metadata.consent_given === 'boolean' ||
      (metadata.consent_source || '').trim() ||
      (metadata.consent_text || '').trim() ||
      (metadata.consent_timestamp || '').trim()
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
        stripeLog.error('HubSpot rollback failed after association error', {
          error: rollbackError,
          context: {
            handler: 'syncCheckoutCompletedHubSpot',
          },
          data: {
            businessNumber: metadata.business_number,
          },
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
    stripeLog.warn('Webhook verification rejected outside production', {
      context: {
        handler: 'verifyStripeWebhook',
      },
      data: {
        environment: env.ENVIRONMENT ?? 'unset',
      },
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
    stripeLog.log('Webhook received', {
      context: {
        handler: 'verifyStripeWebhook',
      },
      data: {
        eventType: event.type,
      },
    });
    return event;
  } catch (error) {
    stripeLog.error('Webhook verification failed', {
      error,
      context: {
        handler: 'verifyStripeWebhook',
      },
    });
    throw error;
  }
}

export async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  metadata: CheckoutCompletedMetadata,
  env: StripeEnv
): Promise<CheckoutCompletedResult> {
  if (!isProductionEnvironment(env)) {
    stripeLog.warn('Checkout completion skipped outside production', {
      context: {
        handler: 'handleCheckoutCompleted',
      },
      data: {
        environment: env.ENVIRONMENT ?? 'unset',
      },
    });
    return { hubspotSynced: false, welcomeSmsSent: false };
  }

  const stripeSessionId = asString(session.id);
  if (!hasRequiredCheckoutMetadata(metadata)) {
    stripeLog.warn('Checkout completion skipped because required metadata is missing', {
      context: {
        handler: 'handleCheckoutCompleted',
      },
      data: {
        stripeSessionId,
        businessNumber: metadata.business_number,
        ownerPhoneNumber: metadata.owner_phone_number,
        displayName: metadata.display_name,
      },
    });
    return { hubspotSynced: false, welcomeSmsSent: false };
  }

  const billingState = await getBusinessBillingState(env.SYSTEMIX, env, metadata.business_number);
  if (!billingState.liveBillingAllowed) {
    stripeLog.warn('Checkout completion blocked by billing safeguards', {
      context: {
        handler: 'handleCheckoutCompleted',
      },
      data: {
        stripeSessionId,
        businessNumber: metadata.business_number,
        reasonCode: billingState.reasonCode,
      },
    });
    return { hubspotSynced: false, welcomeSmsSent: false };
  }

  stripeLog.log('Processing checkout completion', {
    context: {
      handler: 'handleCheckoutCompleted',
    },
    data: {
      stripeSessionId,
      displayName: metadata.display_name,
    },
  });

  const consentTask = hasConsentMetadata(metadata)
    ? logConsentEvent(env.SYSTEMIX, {
        businessNumber: metadata.business_number,
        phoneNumber: metadata.owner_phone_number,
        source: (metadata.consent_source || '').trim() || 'trial_signup',
        consentGiven: metadata.consent_given === true,
        consentText: metadata.consent_text,
        createdAt: metadata.consent_timestamp,
        metadata: {
          stripeSessionId,
          eventType: 'checkout.session.completed',
        },
      })
    : Promise.resolve();

  const [welcomeSmsResult, hubspotResult, consentResult] = await Promise.allSettled([
    sendBusinessWelcomeSms(env, metadata.owner_phone_number, metadata.business_number),
    syncCheckoutCompletedHubSpot(session, metadata, env),
    consentTask,
  ]);

  const welcomeSmsSent = welcomeSmsResult.status === 'fulfilled';
  if (welcomeSmsSent) {
    stripeLog.log('Twilio welcome SMS sent', {
      context: {
        handler: 'handleCheckoutCompleted',
        toNumber: metadata.owner_phone_number,
      },
      data: {
        stripeSessionId,
      },
    });
  } else {
    stripeLog.error('Twilio welcome SMS failed', {
      error: welcomeSmsResult.status === 'rejected' ? welcomeSmsResult.reason : null,
      context: {
        handler: 'handleCheckoutCompleted',
        toNumber: metadata.owner_phone_number,
      },
      data: {
        stripeSessionId,
      },
    });
  }

  const hubspotSynced = hubspotResult.status === 'fulfilled';
  if (hubspotSynced) {
    stripeLog.log('HubSpot sync completed', {
      context: {
        handler: 'handleCheckoutCompleted',
      },
      data: {
        stripeSessionId,
        businessNumber: metadata.business_number,
      },
    });
  } else {
    stripeLog.error('HubSpot sync failed', {
      error: hubspotResult.status === 'rejected' ? hubspotResult.reason : null,
      context: {
        handler: 'handleCheckoutCompleted',
      },
      data: {
        stripeSessionId,
        businessNumber: metadata.business_number,
      },
    });
  }

  if (hasConsentMetadata(metadata)) {
    if (consentResult.status === 'fulfilled') {
      stripeLog.log('Consent event logged', {
        context: {
          handler: 'handleCheckoutCompleted',
          toNumber: metadata.owner_phone_number,
        },
        data: {
          stripeSessionId,
          source: (metadata.consent_source || '').trim() || 'trial_signup',
        },
      });
    } else {
      stripeLog.error('Consent event logging failed', {
        error: consentResult.reason,
        context: {
          handler: 'handleCheckoutCompleted',
          toNumber: metadata.owner_phone_number,
        },
        data: {
          stripeSessionId,
        },
      });
    }
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
    stripeLog.warn('Checkout preparation skipped outside production', {
      context: {
        handler: 'prepareCheckoutCompleted',
      },
      data: {
        environment: env.ENVIRONMENT ?? 'unset',
      },
    });
    return { shouldProcess: false };
  }

  const business_number = metadata.business_number;
  const owner_phone_number = metadata.owner_phone_number;
  const display_name = metadata.display_name;
  const stripeSessionId = asString(session.id);

  if (!hasRequiredCheckoutMetadata(metadata) || !stripeSessionId) {
    stripeLog.warn('Checkout claim skipped because required metadata is missing', {
      context: {
        handler: 'prepareCheckoutCompleted',
      },
      data: {
        businessNumber: business_number,
        ownerPhoneNumber: owner_phone_number,
        displayName: display_name,
        stripeSessionId,
      },
    });
    return { shouldProcess: false };
  }

  const billingState = await getBusinessBillingState(env.SYSTEMIX, env, business_number);
  if (!billingState.liveBillingAllowed) {
    stripeLog.warn('Checkout claim blocked by billing safeguards', {
      context: {
        handler: 'prepareCheckoutCompleted',
      },
      data: {
        businessNumber: business_number,
        stripeSessionId,
        reasonCode: billingState.reasonCode,
      },
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
      stripeLog.warn('Checkout claim skipped with no database changes', {
        context: {
          handler: 'prepareCheckoutCompleted',
        },
        data: {
          businessNumber: business_number,
          stripeSessionId,
          previousLastStripeSessionId: asString(existingBusiness?.last_stripe_session_id),
        },
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
