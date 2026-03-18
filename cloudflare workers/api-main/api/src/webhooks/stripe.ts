import Stripe from 'stripe';
import { Context } from 'hono';
import { handleCheckoutCompleted, prepareCheckoutCompleted, verifyStripeWebhook } from '../services/stripe';

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

  const session = event.data.object as Stripe.Checkout.Session;
  c.executionCtx.waitUntil(
    (async () => {
      const preparation = await prepareCheckoutCompleted(session, c.env);
      if (!preparation.shouldProcess) {
        return;
      }

      await handleCheckoutCompleted(session, c.env);
      console.log('[STRIPE] Onboard complete');
    })().catch((error) => console.log('[STRIPE] Onboard failed: ', error))
  );

  return c.text('ok', 200);
}
