import { sendTwilioSms } from '../core/sms';

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

export async function sendBusinessWelcomeSms(
  env: DatabaseEnv,
  owner_phone_number: string,
  business_number: string
): Promise<void> {
  await sendTwilioSms(
    env,
    owner_phone_number,
    `Systemix is now active on your line (${business_number}). Any missed calls will now be captured and sent here. Text SYSTEMIX HELP for commands.`
  );
  console.log(`[D1] Welcome SMS sent to ${owner_phone_number}`);
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
  console.log(`[D1] Business upserted: ${business_number}`);

  await sendBusinessWelcomeSms(env, owner_phone_number, business_number);
}
