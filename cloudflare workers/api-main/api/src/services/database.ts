import { sendTwilioSms } from '../core/sms.ts';
import { createLogger } from '../core/logging.ts';

type UpsertBusinessInput = {
  business_number: string;
  owner_phone_number: string;
  display_name: string;
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
  { business_number, owner_phone_number, display_name }: UpsertBusinessInput,
  env: DatabaseEnv
): Promise<void> {
  const sql = `
    INSERT INTO businesses (
      id,
      business_number,
      owner_phone_number,
      display_name,
      created_at,
      updated_at
    )
    VALUES (
      lower(hex(randomblob(16))),
      ?1,
      ?2,
      ?3,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now')
    )
    ON CONFLICT(business_number)
    DO UPDATE SET
      owner_phone_number = excluded.owner_phone_number,
      display_name = excluded.display_name,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `;

  await env.SYSTEMIX.prepare(sql).bind(business_number, owner_phone_number, display_name).run();
  d1Log.log('Business upserted', {
    context: {
      handler: 'upsertBusiness',
      fromNumber: business_number,
      toNumber: owner_phone_number,
    },
    data: {
      displayName: display_name,
    },
  });

  await sendBusinessWelcomeSms(env, owner_phone_number, business_number);
}
