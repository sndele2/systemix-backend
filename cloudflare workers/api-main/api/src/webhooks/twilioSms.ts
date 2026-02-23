import { Context } from 'hono';
import { checkTwilioSignature, formDataToParams } from '../core/twilioSignature';

type Bindings = {
  SYSTEMIX_NUMBER: string;
  TWILIO_PHONE_NUMBER: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_SIGNATURE_MODE?: string;
  ENVIRONMENT?: string;
};

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '***';
  return `***${digits.slice(-4)}`;
}

export async function twilioSmsHandler(c: Context<{ Bindings: Bindings }>) {
  try {
    const formData = await c.req.formData();
    const params = formDataToParams(formData);

    const sig = await checkTwilioSignature(
      c.env,
      c.req.url,
      params,
      c.req.header('X-Twilio-Signature') || undefined
    );
    if (!sig.ok) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const customerPhone = (formData.get('From') as string) || 'unknown';
    const incomingBody = (formData.get('Body') as string) || '';

    const ownerNotificationBody = `💰 Lead Captured!\nFrom: ${customerPhone}\nSays: ${incomingBody}\n\nCall them back!`;

    const auth = btoa(`${c.env.TWILIO_ACCOUNT_SID}:${c.env.TWILIO_AUTH_TOKEN}`);
    const payload = new URLSearchParams({
      To: c.env.SYSTEMIX_NUMBER,
      From: c.env.TWILIO_PHONE_NUMBER,
      Body: ownerNotificationBody,
    });

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${c.env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: payload.toString(),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Owner notification failed', { status: response.status, detail: errorBody });
    } else {
      console.log('🔔 Notification sent to owner', { from: maskPhone(customerPhone), mode: sig.mode });
    }
  } catch (error) {
    console.error('Owner notification error');
    console.error(error);
  }

  return c.text('', 200);
}
