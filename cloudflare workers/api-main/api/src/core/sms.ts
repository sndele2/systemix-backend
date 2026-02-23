const FOOTER = 'Msg&data rates may apply. Reply STOP to opt out.';
const MAX_TWILIO_BODY = 1600;

export async function sendTwilioSms(
  env: {
    TWILIO_ACCOUNT_SID: string;
    TWILIO_AUTH_TOKEN: string;
    TWILIO_PHONE_NUMBER?: string;
    SYSTEMIX_NUMBER: string;
  },
  to: string,
  message: string
): Promise<void> {
  try {
    let content = message.includes(FOOTER)
      ? message.replace(FOOTER, '').trimEnd()
      : message.trimEnd();
    const suffix = `\n\n${FOOTER}`;
    const maxContentLen = MAX_TWILIO_BODY - suffix.length - 1;

    if (content.length > maxContentLen) {
      content = `${content.slice(0, Math.max(0, maxContentLen)).trimEnd()}...`;
    }

    const body = `${content}${suffix}`;

    const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    const from = env.TWILIO_PHONE_NUMBER || env.SYSTEMIX_NUMBER;
    const form = new URLSearchParams({
      To: to,
      From: from,
      Body: body,
    });

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Twilio SMS failed (${response.status}): ${errorText}`);
    }
  } catch (e) {
    console.error('Twilio SMS error:', e);
  }
}
