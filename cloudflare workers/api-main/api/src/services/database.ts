import { sendTwilioSms } from '../core/sms.ts';
import { createLogger } from '../core/logging.ts';
import { ensureBillingSchema, type BillingMode } from './billing.ts';
import { ensureCustomerMissedCallSchema } from './missedCallRecovery.ts';

type UpsertBusinessInput = {
  business_number: string;
  owner_phone_number: string;
  display_name: string;
  intake_question?: string | null;
  billing_mode?: BillingMode | null;
  is_internal?: boolean | null;
};

type DatabaseEnv = {
  SYSTEMIX: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER?: string;
  SYSTEMIX_NUMBER: string;
};

const d1Log = createLogger('[D1]', 'database');

export async function sendBusinessWelcomeSms(
  env: DatabaseEnv,
  owner_phone_number: string,
  business_number: string
): Promise<void> {
  await sendTwilioSms(
    env,
    owner_phone_number,
    `Systemix is now active on your line (${business_number}). Any missed calls will now be captured and sent here. Text SYSTEMIX HELP for commands.`,
    {
      businessNumber: business_number,
    }
  );
  d1Log.log('Welcome SMS sent', {
    context: {
      handler: 'sendBusinessWelcomeSms',
      fromNumber: env.SYSTEMIX_NUMBER,
      toNumber: owner_phone_number,
    },
    data: {
      businessNumber: business_number,
    },
  });
}

export async function upsertBusiness(
  { business_number, owner_phone_number, display_name, intake_question, billing_mode, is_internal }: UpsertBusinessInput,
  env: DatabaseEnv
): Promise<void> {
  await ensureCustomerMissedCallSchema(env.SYSTEMIX);
  await ensureBillingSchema(env.SYSTEMIX);

  const sql = `
    INSERT INTO businesses (
      id,
      business_number,
      owner_phone_number,
      display_name,
      intake_question,
      billing_mode,
      is_internal,
      created_at,
      updated_at
    )
    VALUES (
      lower(hex(randomblob(16))),
      ?1,
      ?2,
      ?3,
      ?4,
      CASE
        WHEN ?5 IS NULL OR ?5 = ''
        THEN 'pilot'
        ELSE ?5
      END,
      CASE
        WHEN ?6 IS NULL OR ?6 < 0
        THEN 0
        ELSE ?6
      END,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now')
    )
    ON CONFLICT(business_number)
    DO UPDATE SET
      owner_phone_number = excluded.owner_phone_number,
      display_name = excluded.display_name,
      intake_question = CASE
        WHEN excluded.intake_question IS NULL OR excluded.intake_question = ''
        THEN businesses.intake_question
        ELSE excluded.intake_question
      END,
      billing_mode = CASE
        WHEN ?5 IS NULL OR ?5 = ''
        THEN businesses.billing_mode
        ELSE excluded.billing_mode
      END,
      is_internal = CASE
        WHEN ?6 IS NULL OR ?6 < 0
        THEN businesses.is_internal
        ELSE excluded.is_internal
      END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `;

  await env.SYSTEMIX.prepare(sql).bind(
    business_number,
    owner_phone_number,
    display_name,
    (intake_question || '').trim() || null,
    billing_mode ?? null,
    typeof is_internal === 'boolean' ? Number(is_internal) : null
  ).run();
  d1Log.log('Business upserted', {
    context: {
      handler: 'upsertBusiness',
      fromNumber: business_number,
      toNumber: owner_phone_number,
    },
    data: {
      displayName: display_name,
      intakeQuestion: (intake_question || '').trim() || null,
      billingMode: billing_mode ?? null,
      isInternal: typeof is_internal === 'boolean' ? is_internal : null,
    },
  });

  await sendBusinessWelcomeSms(env, owner_phone_number, business_number);
}
