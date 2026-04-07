import { createLogger } from './logging.ts';
import {
  appendSmsOptOutFooter,
  ensureSmsComplianceSchema,
  isSmsOptedOut,
  normalizePhone,
  prepareCustomerFacingSmsBody,
  SMS_OPT_OUT_FOOTER,
} from '../services/smsCompliance.ts';

export { appendSmsOptOutFooter, SMS_OPT_OUT_FOOTER };

export type TwilioSendInput = {
  toPhone: string;
  fromPhone: string;
  body: string;
  businessNumber?: string;
  skipOptOutCheck?: boolean;
};

export type TwilioSendResult = {
  ok: boolean;
  sid?: string;
  detail?: string;
  suppressed?: boolean;
};

export type TwilioRestClient = {
  sendSms: (input: TwilioSendInput) => Promise<TwilioSendResult>;
};

type TwilioSmsEnv = {
  SYSTEMIX: D1Database;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER?: string;
  SYSTEMIX_NUMBER?: string;
};

type SendTwilioSmsOptions = {
  fromPhone?: string;
  businessNumber?: string;
  appendComplianceFooter?: boolean;
  skipOptOutCheck?: boolean;
};

const twilioLog = createLogger('[TWILIO]', 'sendTwilioSms');

async function dispatchTwilioSms(
  env: TwilioSmsEnv,
  input: TwilioSendInput
): Promise<TwilioSendResult> {
  await ensureSmsComplianceSchema(env.SYSTEMIX);

  const fromPhone = normalizePhone(input.fromPhone) || input.fromPhone.trim();
  const toPhone = normalizePhone(input.toPhone) || input.toPhone.trim();
  const businessNumber = normalizePhone(input.businessNumber || fromPhone) || fromPhone;

  if (!fromPhone) {
    return { ok: false, detail: 'missing_twilio_phone_number' };
  }

  if (!toPhone) {
    return { ok: false, detail: 'missing_sms_to' };
  }

  if (!input.skipOptOutCheck && businessNumber && (await isSmsOptedOut(env.SYSTEMIX, businessNumber, toPhone))) {
    twilioLog.log('Outbound SMS suppressed because recipient is opted out', {
      context: {
        handler: 'dispatchTwilioSms',
        fromNumber: businessNumber,
        toNumber: toPhone,
      },
    });
    return {
      ok: true,
      suppressed: true,
      detail: 'suppressed_opted_out',
    };
  }

  try {
    const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: toPhone,
          From: fromPhone,
          Body: input.body,
        }).toString(),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, detail: `twilio_sms_failed_${response.status}:${errorText}` };
    }

    const payload = (await response.json()) as { sid?: string };
    return {
      ok: true,
      sid: payload.sid,
    };
  } catch (error) {
    twilioLog.error('Outbound SMS request failed', {
      error,
      context: {
        handler: 'dispatchTwilioSms',
        fromNumber: businessNumber,
        toNumber: toPhone,
      },
    });
    return {
      ok: false,
      detail: `twilio_sms_error:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function createTwilioRestClient(env: TwilioSmsEnv): TwilioRestClient | null {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    return null;
  }

  return {
    async sendSms(input: TwilioSendInput): Promise<TwilioSendResult> {
      return dispatchTwilioSms(env, input);
    },
  };
}

export async function sendTwilioSms(
  env: TwilioSmsEnv,
  to: string,
  message: string,
  options: SendTwilioSmsOptions = {}
): Promise<void> {
  const client = createTwilioRestClient(env);
  if (!client) {
    twilioLog.error('Outbound SMS skipped because Twilio credentials are missing', {
      context: {
        handler: 'sendTwilioSms',
        toNumber: to,
      },
    });
    return;
  }

  const fromPhone =
    normalizePhone(options.fromPhone || env.TWILIO_PHONE_NUMBER || env.SYSTEMIX_NUMBER || '') ||
    (options.fromPhone || env.TWILIO_PHONE_NUMBER || env.SYSTEMIX_NUMBER || '').trim();
  const businessNumber =
    normalizePhone(options.businessNumber || fromPhone) ||
    (options.businessNumber || fromPhone || '').trim();
  const body = options.appendComplianceFooter
    ? await prepareCustomerFacingSmsBody(env.SYSTEMIX, businessNumber, to, message)
    : message.trim();

  const result = await client.sendSms({
    toPhone: to,
    fromPhone,
    body,
    businessNumber,
    skipOptOutCheck: options.skipOptOutCheck,
  });

  if (!result.ok) {
    twilioLog.error('Outbound SMS request failed', {
      context: {
        handler: 'sendTwilioSms',
        fromNumber: businessNumber,
        toNumber: to,
      },
      data: {
        detail: result.detail || 'unknown',
      },
    });
  }
}
