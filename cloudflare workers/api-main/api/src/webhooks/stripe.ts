import Stripe from 'stripe';
import { Context } from 'hono';
import { handleCheckoutCompleted, verifyStripeWebhook } from '../services/stripe';

type Bindings = {
  SYSTEMIX: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  HUBSPOT_ACCESS_TOKEN?: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER?: string;
  SYSTEMIX_NUMBER: string;
};

export async function stripeWebhookHandler(c: Context<{ Bindings: Bindings }>) {
  const signature = c.req.header('stripe-signature') || '';
  const body = await c.req.text();

  let event: Stripe.Event;
  try {
    event = await verifyStripeWebhook(body, signature, c.env);
  } catch {
    console.log('[ROUTER] Stripe signature verification failed');
    return c.text('Webhook verification failed', 400);
  }

  if (event.type !== 'checkout.session.completed') {
    return c.text('ok', 200);
  }

  c.executionCtx.waitUntil(
    handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session, c.env)
      .then(() => console.log('[STRIPE] Onboard complete'))
      .catch((error) => console.log('[STRIPE] Onboard failed: ', error))
  );

  return c.text('ok', 200);
}
